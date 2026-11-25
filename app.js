// bin.harsath.com: encrypted pastebin with burn after read and expiring links.
// Text is encrypted in the browser (crypto.js); Supabase only stores ciphertext.
// See supabase/migrations/ for the server side.

import * as C from './crypto.js'

const SUPABASE_URL = 'https://vakzpjtoqvzxmilqnbwr.supabase.co'
const SUPABASE_KEY = 'sb_publishable_gQ7JlF6hbkTQjoRsAIL8rQ_32rs1xdC' // publishable: safe in the client
const MAX_BYTES = 512 * 1024 // the database's ciphertext limit (700000 chars) fits this
const ERRORS = {
  rate_limited: 'Too many pastes are being created right now. Try again in a few minutes.',
  storage_full: 'Storage is full right now. Try again later.',
}

const $ = sel => document.querySelector(sel)
const te = new TextEncoder()

function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id
}

async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.message || `${name} failed (${res.status})`)
  return body
}

// --- formatting ---

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
const fmtBytes = n => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`

// "in 3 days · Nov 27, 9:42 PM"
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' })
const UNITS = [['month', 28 * 86400, 30 * 86400], ['day', 86400, 86400], ['hour', 3600, 3600], ['minute', 0, 60]]
function fmtExpiry(date) {
  const d = new Date(date)
  const s = (d - Date.now()) / 1000
  const [unit, , size] = UNITS.find(([, min]) => s >= min)
  const abs = d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  })
  return `${rtf.format(Math.max(1, Math.round(s / size)), unit)} · ${abs}`
}

// --- line-numbered text box (compose and view) ---

let wrap = true // wrap long lines in both boxes; the Wrap switches change it

function codeBox(box) {
  const ta = box.querySelector('textarea')
  const nums = box.querySelector('.gutter pre')
  const mirror = box.appendChild(document.createElement('div'))
  mirror.className = 'mirror'
  mirror.setAttribute('aria-hidden', 'true')
  const sync = () => { nums.style.transform = `translateY(${-ta.scrollTop}px)` }
  ta.addEventListener('scroll', sync)

  // Drag the bar under the box to make it taller or shorter.
  const grip = box.nextElementSibling
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('dragging')
    document.body.classList.add('resizing')
    const y = e.clientY, h = box.getBoundingClientRect().height
    const move = ev => {
      box.style.maxHeight = 'none'
      box.style.height = `${Math.max(120, h + ev.clientY - y)}px`
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('lostpointercapture', () => {
      grip.removeEventListener('pointermove', move)
      grip.classList.remove('dragging')
      document.body.classList.remove('resizing')
    }, { once: true })
  })

  function update() {
    const lines = ta.value.split('\n')
    // With wrapping, a line can take several rows. Lay the lines out in the
    // hidden mirror (same width and font as the textarea) to count them, so
    // each number lines up with the start of its line.
    let rows = null
    if (wrap && ta.clientWidth) {
      const cs = getComputedStyle(ta)
      mirror.style.width = `${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`
      const frag = document.createDocumentFragment()
      for (const line of lines) frag.appendChild(document.createElement('div')).textContent = line || '\u200b'
      mirror.replaceChildren(frag)
      const lh = parseFloat(cs.lineHeight)
      rows = Array.from(mirror.children, d => Math.max(1, Math.round(d.getBoundingClientRect().height / lh)))
      mirror.replaceChildren()
    }
    nums.textContent = lines.map((_, i) => rows ? i + 1 + '\n'.repeat(rows[i] - 1) : i + 1).join('\n')
    box.style.setProperty('--lines', rows ? rows.reduce((a, b) => a + b, 0) : lines.length)
    sync()
    return lines.length
  }

  // Re-wrap when the width changes: window resize, scrollbar, box first shown.
  let width = 0
  new ResizeObserver(() => {
    if (ta.clientWidth === width) return
    width = ta.clientWidth
    if (wrap) requestAnimationFrame(update)
  }).observe(ta)

  return update
}

// --- compose ---

const text = $('#text')
const updateCompose = codeBox($('#composeBox'))
const ttl = () => document.querySelector('input[name=ttl]:checked')

function updateStats() {
  updateCompose()
  const bytes = te.encode(text.value).length
  $('#stats').textContent = `${fmtBytes(bytes)} / 512 KB`
  $('#stats').classList.toggle('over', bytes > MAX_BYTES)
}

function setError(msg) {
  $('#composeErr').textContent = msg
  $('#composeErr').hidden = !msg
  $('#stats').hidden = !!msg
}

async function create() {
  const btn = $('#create')
  const bytes = te.encode(text.value).length
  if (!text.value.trim()) { text.focus(); return setError('Write or paste something first.') }
  if (bytes > MAX_BYTES) return setError(`This paste is ${fmtBytes(bytes)}; the limit is 512 KB.`)
  const burn = $('#burn').checked
  btn.disabled = true
  btn.querySelector('span').textContent = 'Encrypting…'
  setError('')
  try {
    const secret = C.newSecret()
    const { id, key } = await C.derivePaste(secret)
    const expires = await rpc('create_paste', {
      p_id: id, p_data: await C.encryptText(key, text.value), p_hours: Number(ttl().value), p_burn: burn,
    })
    $('#link').value = `${location.origin}${location.pathname}#${secret}`
    history.replaceState(null, '', `${location.pathname}#${secret}`) // the address bar shows the paste; the editor stays
    $('#linkExpiry').textContent = `Expires ${fmtExpiry(expires)}`
    $('#linkBurn').hidden = !burn
    $('#linkBar').hidden = false
    $('#link').select() // also scrolls it into view
  } catch (e) {
    setError(ERRORS[e.message] ?? `Couldn't create the link: ${e.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('span').textContent = 'Paste!'
  }
}

text.addEventListener('input', () => { updateStats(); setError('') })
$('#create').addEventListener('click', create)
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)
addEventListener('keydown', e => {
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey) && !$('#compose').hidden) { e.preventDefault(); create() }
})

// --- copy buttons ---

async function copy(btn, value) {
  await navigator.clipboard.writeText(value)
  const label = btn.querySelector('span')
  const old = label.textContent
  btn.classList.add('copied')
  label.textContent = 'Copied'
  setTimeout(() => { btn.classList.remove('copied'); label.textContent = old }, 1600)
}
$('#copyLink').addEventListener('click', e => copy(e.currentTarget, $('#link').value))
$('#copyText').addEventListener('click', e => copy(e.currentTarget, $('#viewText').value))

// Raw: the decrypted text alone, as a plain-text page in a new tab. The server
// only has ciphertext, so the page is made here.
$('#raw').addEventListener('click', () => {
  const blob = new Blob([$('#viewText').value], { type: 'text/plain;charset=utf-8' })
  window.open(URL.createObjectURL(blob), '_blank')
})

// Fork: the paste becomes a new, unsaved paste in the editor. Nothing is
// uploaded until Paste, and the original link is untouched.
$('#fork').addEventListener('click', () => {
  text.value = $('#viewText').value
  history.replaceState(null, '', location.pathname) // drop the secret from the URL
  updateStats()
  show('compose')
  text.focus()
  text.setSelectionRange(0, 0)
  text.scrollTop = 0
})

// --- reading ---

const updateView = codeBox($('#viewBox'))

function reveal(content, expiresAt, burned) {
  $('#viewText').value = content
  $('#viewStats').textContent = `${plural(updateView(), 'line')} · ${fmtBytes(te.encode(content).length)}`
  $('#viewExpiry').hidden = burned
  if (!burned) $('#viewExpiry').title = $('#viewExpiry span').textContent = `Expires ${fmtExpiry(expiresAt)}`
  $('#burnedBanner').hidden = !burned
  // Reloading or leaving would lose a burned paste for good, so ask first.
  if (burned) addEventListener('beforeunload', e => e.preventDefault())
  show('view')
}

function missing(title, msg) {
  $('#missingTitle').textContent = title
  $('#missingText').textContent = msg
  show('missing')
}
const gone = () => missing('Nothing here', 'Expired, already burned, or never existed.')
const offline = e => missing("Couldn't load this paste", `Check your connection and reload. (${e.message})`)

async function decrypt(key, data) {
  try { return await C.decryptText(key, data) } catch { throw new Error('damaged') }
}

async function open(secret) {
  show('loading')
  try {
    const { id, key } = await C.derivePaste(secret)
    const [row] = await rpc('get_paste', { p_id: id })
    if (!row) return gone()
    if (!row.burn) return reveal(await decrypt(key, row.data), row.expires_at, false)

    show('gate')
    $('#reveal').addEventListener('click', async () => {
      const btn = $('#reveal')
      btn.disabled = true
      $('#gateErr').hidden = true
      try {
        const data = await rpc('claim_paste', { p_id: id })
        if (!data) return gone() // someone else opened it first, or it just expired
        reveal(await decrypt(key, data), null, true)
      } catch (e) {
        if (e.message === 'damaged') return missing('This paste is damaged', "It couldn't be decrypted.")
        $('#gateErr').textContent = `Couldn't open it: ${e.message}. Try again.`
        $('#gateErr').hidden = false
        btn.disabled = false
      }
    })
  } catch (e) {
    if (e.message === 'damaged') return missing('This paste is damaged', "It couldn't be decrypted.")
    offline(e)
  }
}

// --- wrap lines (one setting for both boxes) ---

function setWrap(on) {
  wrap = on
  for (const t of document.querySelectorAll('.wrapToggle')) t.checked = on
  for (const box of [$('#composeBox'), $('#viewBox')]) {
    box.classList.toggle('wrapped', on)
    box.querySelector('textarea').wrap = on ? 'soft' : 'off'
  }
  updateCompose()
  updateView()
}
for (const t of document.querySelectorAll('.wrapToggle')) t.addEventListener('change', () => setWrap(t.checked))

// --- start ---

// #<secret> opens a paste; anything else after # is a mangled link.
addEventListener('hashchange', () => location.reload())
const hash = location.hash.slice(1)
if (/^[A-Za-z0-9_-]{22}$/.test(hash)) {
  open(hash)
} else if (hash) {
  missing('This link is incomplete', 'Copy the whole link, including everything after the #.')
} else {
  updateStats()
  show('compose')
  if (matchMedia('(pointer: fine)').matches) text.focus()
}
