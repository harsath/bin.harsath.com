-- bin.harsath.com database setup.
-- Paste the whole file into Supabase Dashboard -> SQL Editor -> Run.
-- Safe to re-run: every statement is create-if-missing or replace.
--
-- Model
--   pastes  one row per paste: ciphertext, whether it burns after reading, and
--           when it expires. The browser encrypts before upload and derives the
--           id from the secret in the link (crypto.js), so the server can't read
--           a paste or turn an id back into a link. Clients never touch the table;
--           create_paste / get_paste / claim_paste are the only way in.

create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.pastes (
  id          text primary key check (id ~ '^[0-9a-f]{32}$'),
  -- base64url(iv || ciphertext); 700000 chars fits 512 KB of text
  data        text not null check (length(data) <= 700000 and data ~ '^[A-Za-z0-9_-]+$'),
  burn        boolean not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists pastes_expires_idx on public.pastes (expires_at);
create index if not exists pastes_created_idx on public.pastes (created_at);

alter table public.pastes enable row level security;
revoke all on public.pastes from anon, authenticated;

-- Health check for the keep-alive workflow (same definition airdrop and mermaid use).
create or replace function public.ping()
returns text language sql stable as $$ select 'pong' $$;

-- Stores an encrypted paste and returns when it expires. p_hours must be one of
-- the offered lifetimes: 5 hours, 3 days, 1 week, 1 month, 6 months.
-- This project is shared with airdrop and mermaid, so pastes are capped at 500
-- new per hour and 150 MB in total; a script can't fill the database.
create or replace function public.create_paste(p_id text, p_data text, p_hours int, p_burn boolean)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_expires timestamptz := now() + make_interval(hours => p_hours);
begin
  if p_hours not in (5, 72, 168, 720, 4320) then raise exception 'bad_lifetime'; end if;
  if (select count(*) from public.pastes where created_at > now() - interval '1 hour') >= 500 then
    raise exception 'rate_limited';
  end if;
  if (select coalesce(sum(pg_column_size(data)), 0) from public.pastes) > 150000000 then
    raise exception 'storage_full';
  end if;
  insert into public.pastes (id, data, burn, expires_at)  -- checks validate id/data
  values (p_id, p_data, p_burn, v_expires);
  return v_expires;
end $$;

-- Returns whether the paste burns and when it expires, or nothing if it doesn't
-- exist or expired. The ciphertext comes back only for pastes that don't burn;
-- burning ones must be read with claim_paste.
create or replace function public.get_paste(p_id text)
returns table (data text, burn boolean, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select case when p.burn then null else p.data end, p.burn, p.expires_at
  from public.pastes p where p.id = p_id and p.expires_at > now();
$$;

-- Burn after read: deletes the paste and returns its ciphertext in one statement,
-- so only the first reader gets it. Returns null if it's gone (or doesn't burn).
create or replace function public.claim_paste(p_id text)
returns text language sql security definer set search_path = '' as $$
  delete from public.pastes p
  where p.id = p_id and p.burn and p.expires_at > now()
  returning p.data;
$$;

create or replace function public.cleanup_pastes()
returns void language sql security definer set search_path = '' as $$
  delete from public.pastes where expires_at < now();
$$;

revoke execute on function public.create_paste(text, text, int, boolean) from public;
revoke execute on function public.get_paste(text)                        from public;
revoke execute on function public.claim_paste(text)                      from public;
revoke execute on function public.cleanup_pastes()                       from public, anon, authenticated;
grant  execute on function public.create_paste(text, text, int, boolean) to anon, authenticated;
grant  execute on function public.get_paste(text)                        to anon, authenticated;
grant  execute on function public.claim_paste(text)                      to anon, authenticated;
grant  execute on function public.ping()                                 to anon, authenticated;

-- Hourly: delete expired pastes. cron.schedule with the same name replaces the job.
select cron.schedule('bin-cleanup', '37 * * * *', $job$ select public.cleanup_pastes(); $job$);
