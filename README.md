# bin.harsath.com

An end-to-end encrypted pastebin. Pastes expire after 5 hours, 3 days, 1 week, 1 month or 6 months, and can optionally **burn after read**: deleted the moment someone first opens them. No account, no third-party scripts.

## How it works

```
 browser                                          Supabase (free tier)
 ───────                                          ────────────────────
 create: secret ─HKDF─► id + AES key
         encrypt ── rpc create_paste(id, ciphertext, hours, burn) ─► Postgres: pastes(id, data, burn, expires_at)
 open #<secret> ── rpc get_paste(id) ──────────────────────────────► ciphertext (or just "burns", for burn pastes)
         burn pastes: "Open and burn" ── rpc claim_paste(id) ───────► delete … returning ciphertext
         decrypt
                                                  pg_cron hourly ─► delete expired rows
```

- **Encryption:** the link is `/#<22-char secret>`. The secret (16 random bytes) never leaves the browser; the part of a URL after `#` isn't sent to any server. From it the browser derives (HKDF) the paste id, which is sent, and an AES-256-GCM key, which isn't. Supabase stores only `base64url(iv || ciphertext)` (the table rejects anything else), whether it burns, and the expiry. It can't read a paste or turn an id back into a link.
- **Burn after read:** opening a burn link first shows a warning and fetches nothing, so link previews and accidental clicks don't burn it. **Open and burn** calls `claim_paste`, which deletes the row and returns the ciphertext in one statement, so only the first reader ever gets it. The page then asks before you close or reload it, since the paste is gone. Unopened burn pastes still expire at their lifetime.
- **Fork:** a paste opens read-only. **Fork** copies it into the editor as a new paste and drops the secret from the URL; nothing is uploaded until **Create link**, and the original link is untouched.
- **Raw** opens the decrypted text as a plain-text page in a new tab. It's made in the browser (a `blob:` URL), since the server only has ciphertext.
- **Limits:** 512 KB of text per paste. The project is shared with airdrop and mermaid, so creation is capped at 500 pastes per hour and 150 MB of pastes in total.
- **Hosting:** static files on GitHub Pages; no build step. A Content-Security-Policy allows only this site's own scripts and requests to Supabase.

## Files

| Path | Purpose |
|---|---|
| `index.html` | layout and styles |
| `app.js` | editor, create link, open, burn, copy |
| `crypto.js` | key derivation and encryption (WebCrypto) |
| `supabase/migrations/0001_init.sql` | `pastes` table, RPCs, cleanup cron job, `ping` |
| `.github/workflows/keepalive.yml` | daily ping so the free project doesn't pause |

## Setup (one time)

It uses the same Supabase project as airdrop.harsath.com and mermaid.harsath.com (the `pastes` table doesn't touch anything they use).

1. **Database:** paste `supabase/migrations/0001_init.sql` into **SQL Editor** and run it. It's safe to re-run.
2. To use a different project instead, change `SUPABASE_URL` / `SUPABASE_KEY` at the top of `app.js`, the `connect-src` URL in `index.html`'s Content-Security-Policy, and the project URL and key in `.github/workflows/keepalive.yml`.

## Run locally

```
python3 -m http.server 8000
```

## Deploy

Push to the default branch; GitHub Pages serves it. Keep the `CNAME` file for the custom domain, and add a `CNAME` DNS record `bin` → `harsath.github.io`.
