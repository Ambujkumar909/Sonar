/* =============================================================
   Sonar — dashboard client
   Clean, calm UI. All reconnect/error noise stays on the Health
   page; the main dashboard shows only what matters.
   ============================================================= */
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const api = async (path, opts) => (await fetch('/api' + path, opts)).json()
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
const del = (path) => api(path, { method: 'DELETE' })

const state = { sessions: [], stats: {}, view: 'dashboard', chatSession: null, chatJid: null, feed: [] }
const fmtTime = (ts) => new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
const fmtClock = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
const initials = (s) => (s || '?').replace(/[^a-zA-Z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '#'
const esc = (s) => (s ?? '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/* ---------- theme ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t
  localStorage.setItem('sonar-theme', t)
}
$('#themeToggle').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
const urlTheme = new URLSearchParams(location.search).get('theme')
applyTheme(urlTheme || localStorage.getItem('sonar-theme') || 'light')

/* ---------- navigation ---------- */
const TITLES = { dashboard: 'Dashboard', sessions: 'Sessions', chats: 'Recent Chats', watchlist: 'Watchlist', keywords: 'Keyword Alerts', health: 'Health', audit: 'Audit Trail', license: 'License', users: 'Users', files: 'Log Files', about: 'About' }
function go(view) {
  if (!TITLES[view]) view = 'dashboard'
  // route guards (defence in depth — API enforces too)
  if (view === 'audit' && state.me && state.me.role !== 'super_admin') view = 'dashboard'
  if ((view === 'users' || view === 'license') && !(state.me && (state.me.role === 'admin' || state.me.role === 'super_admin'))) view = 'dashboard'
  state.view = view
  $$('.view').forEach(v => v.classList.add('hide'))
  $('#view-' + view).classList.remove('hide')
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view))
  $('#pageTitle').textContent = TITLES[view]
  if (location.hash.slice(1) !== view) location.hash = view
  render(view)
}
$$('#nav button').forEach(b => b.onclick = () => go(b.dataset.view))
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== state.view) go(v) })

/* ---------- status helpers ---------- */
const STATUS_LABEL = { open: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting', qr: 'Scan QR', reauth: 'Re-pairing', stopped: 'Stopped', idle: 'Idle', starting: 'Starting', offline: 'Offline' }
function statusDot(s) {
  if (s === 'open') return 'ok'
  if (s === 'reconnecting' || s === 'connecting' || s === 'qr' || s === 'reauth' || s === 'starting') return 'warn'
  if (s === 'stopped' || s === 'idle' || s === 'offline') return 'idle'
  return 'bad'
}

/* ---------- toast ---------- */
function toast(msg, kind) {
  const el = document.createElement('div')
  el.className = 'toast' + (kind ? ' ' + kind : '')
  el.innerHTML = msg
  $('#toasts').appendChild(el)
  setTimeout(() => el.remove(), 5000)
}

/* =============================================================
   SOCKET
   ============================================================= */
let socket = null
function initSocket() {
  if (socket) return
  socket = io()
  socket.on('state', (d) => { state.sessions = d.sessions; state.stats = d.stats; refreshChrome(); render(state.view) })
  socket.on('sessions', (list) => { state.sessions = list; refreshChrome(); if (['dashboard', 'sessions'].includes(state.view)) render(state.view) })
  socket.on('status', () => { /* chrome updates via sessions event */ })
  socket.on('qr', ({ id, qr }) => {
    const s = state.sessions.find(x => x.id === id)
    if (s) { s.qr = qr; s.live = 'qr' }
    if (state.view === 'sessions') render('sessions')
  })
  socket.on('event', () => { if (state.view === 'health') render('health') })
  socket.on('message', (m) => {
    state.feed.unshift(m); state.feed = state.feed.slice(0, 60)
    if (state.view === 'dashboard') renderFeed()
    if (state.view === 'chats' && m.sessionId === state.chatSession && m.chat_jid === state.chatJid) loadMessages()
  })
  socket.on('alert', (a) => toast(`⚑ <b>${esc(a.keyword)}</b> in ${esc(a.chatName)}<br><span style="font-weight:500;color:var(--ink-soft)">${esc(a.text.slice(0, 90))}</span>`, 'alert'))
  socket.on('license', () => { refreshLicenseBanner(); if (state.view === 'license') render('license') })
}

/* ---------- top chrome (badge + health pill) — calm & silent ---------- */
function refreshChrome() {
  $('#navSessions').textContent = state.sessions.length
  const any = (st) => state.sessions.some(s => (s.live || s.status) === st)
  const pill = $('#healthPill'), dot = pill.querySelector('.dot'), txt = $('#healthText')
  const open = state.sessions.filter(s => (s.live || s.status) === 'open').length
  if (state.sessions.length === 0) { dot.className = 'dot idle'; txt.textContent = 'No sessions yet' }
  else if (any('reconnecting') || any('connecting')) { dot.className = 'dot warn'; txt.textContent = 'Auto-recovering…' }
  else if (open === state.sessions.length) { dot.className = 'dot ok'; txt.textContent = `${open} connected · silent` }
  else { dot.className = 'dot ok'; txt.textContent = `${open}/${state.sessions.length} connected` }
}

/* =============================================================
   RENDER ROUTER
   ============================================================= */
function render(view) {
  ({ dashboard: renderDashboard, sessions: renderSessions, chats: renderChats,
     watchlist: renderWatchlist, keywords: renderKeywords, health: renderHealth,
     audit: renderAudit, license: renderLicense, users: renderUsers, files: renderFiles, about: renderAbout }[view] || (() => {}))()
  requestAnimationFrame(() => stagger($('#view-' + view)))
}

/* ---------- motion helpers ---------- */
function stagger(root) {
  if (!root) return
  const items = [...root.querySelectorAll('.card, .chat-item, tr')].slice(0, 40)
  items.forEach((el, i) => {
    el.classList.remove('reveal'); void el.offsetWidth
    el.style.setProperty('--d', Math.min(i * 45, 600) + 'ms')
    el.classList.add('reveal')
  })
}
function countUp(el, to) {
  const dur = 700, start = performance.now(), from = 0
  function step(t) {
    const p = Math.min(1, (t - start) / dur)
    const e = 1 - Math.pow(1 - p, 3)
    el.textContent = Math.round(from + (to - from) * e).toLocaleString()
    if (p < 1) requestAnimationFrame(step)
  }
  if (typeof to === 'number') requestAnimationFrame(step); else el.textContent = to
}

/* ---------- DASHBOARD (clean) ---------- */
async function renderDashboard() {
  const a = await api('/analytics')
  const s = a.stats || {}
  const cards = [
    ['Sessions', s.sessions || 0, `${s.sessionsOpen || 0} connected`, true],
    ['Messages today', s.messages24h || 0, `${(s.messages || 0).toLocaleString()} all-time`],
    ['Conversations', s.chats || 0, `${s.groups || 0} groups`],
  ]
  $('#statCards').innerHTML = cards.map(([l, v, m, acc]) => `
    <div class="card stat">
      <div class="label">${l}</div>
      <div class="value">${acc ? `<span class="accent">${v}</span>` : v}</div>
      <div class="meta">${m}</div>
    </div>`).join('')
  $$('#statCards .value').forEach(el => {
    const target = el.querySelector('.accent') || el
    const n = parseInt(target.textContent.replace(/[^0-9]/g, ''))
    if (!isNaN(n)) countUp(target, n)
  })

  const max = Math.max(1, ...a.hourly.map(h => h.n))
  const byBucket = Object.fromEntries(a.hourly.map(h => [h.bucket, h.n]))
  const nowB = Math.floor(Date.now() / 3600000)
  let bars = ''
  for (let i = 23; i >= 0; i--) { const n = byBucket[nowB - i] || 0; bars += `<div class="bar" style="height:${(n / max) * 100}%" title="${n} msgs"></div>` }
  $('#hourlyBars').innerHTML = bars

  $('#topChats').innerHTML = a.topChats.length ? a.topChats.map(c => `
    <div class="topchat"><span class="tc-name">${esc(c.chat_name || '—')}</span><span class="tc-n">${c.n} msgs</span></div>
  `).join('') : '<div class="empty">No messages yet.</div>'
  renderFeed()
}
function renderFeed() {
  const el = $('#liveFeed'); if (!el) return
  if (!state.feed.length) { el.innerHTML = '<div class="empty">Waiting for incoming messages…</div>'; return }
  el.innerHTML = state.feed.map(m => `
    <div class="f"><div class="top"><span class="ch">${esc(m.chat_name)} ${m.is_group ? '<span class="gtag">group</span>' : ''}</span><span class="tm" style="font-size:11px;color:var(--ink-faint)">${fmtClock(m.ts)}</span></div>
    <div class="tx"><span class="sn">${esc(m.sender_name)}:</span> ${esc(m.text)}</div></div>`).join('')
}

/* ---------- SESSIONS ---------- */
async function renderSessions() {
  // Always pull the freshest list (so a pending QR shows immediately).
  const r = await api('/state'); if (r.ok) { state.sessions = r.sessions; refreshChrome() }
  // QR is no longer in /state (kept small) — fetch it only for sessions awaiting a scan.
  await Promise.all(state.sessions
    .filter(s => ['qr', 'reauth'].includes(s.live || s.status) && (s.hasQr || !s.qr))
    .map(async s => { const q = await api('/sessions/' + s.id + '/qr'); if (q.ok && q.qr) s.qr = q.qr }))
  // Only admins/super_admins may link new devices.
  const createCard = $('#view-sessions .card')
  if (createCard) createCard.style.display = isAdminish() ? '' : 'none'
  const el = $('#sessionCards')
  if (!state.sessions.length) { el.innerHTML = `<div class="empty">${isAdminish() ? 'No sessions yet. Create one above to scan a QR.' : 'No sessions have been granted to you yet.'}</div>`; return }
  el.innerHTML = state.sessions.map(s => {
    const st = s.live || s.status
    const stopped = st === 'stopped'
    const showQR = (st === 'qr' || st === 'reauth') && s.qr
    return `<div class="card session-card">
      <div class="head">
        <div class="avatar">${initials(s.name)}</div>
        <div style="flex:1">
          <div class="title">${esc(s.name)}</div>
          <div class="phone">${s.phone ? '+' + esc(s.phone) : 'not linked'}</div>
        </div>
        <span class="pill"><span class="dot ${statusDot(st)}"></span>${STATUS_LABEL[st] || st}</span>
      </div>
      ${showQR ? `<div class="qr-box"><img src="${s.qr}" alt="QR" /></div><div class="qr-hint">WhatsApp ▸ Linked Devices ▸ Link a device</div>` : ''}
      <div class="kv">
        <div class="k">Reconnects</div><div class="v">${s.reconnects || 0}</div>
        <div class="k">Retry attempt</div><div class="v">${s.attempt || 0}</div>
        <div class="k">Watch all groups</div><div class="v">${s.watch_all ? 'Yes' : 'No'}</div>
        <div class="k">Last connected</div><div class="v">${s.last_open ? fmtTime(s.last_open) : '—'}</div>
      </div>
      <div class="btn-row">
        ${canWrite() ? (stopped
          ? `<button class="btn primary" data-act="sess" data-id="${s.id}" data-op="resume">▶ Resume</button>`
          : `<button class="btn" data-act="sess" data-id="${s.id}" data-op="restart">↻ Restart</button>
             <button class="btn gold" data-act="sess" data-id="${s.id}" data-op="stop">■ Stop</button>`) : ''}
        ${isSuper() ? `<button class="btn" data-act="watchall" data-id="${s.id}" data-val="${s.watch_all ? 0 : 1}">${s.watch_all ? 'Watch listed only' : 'Watch all'}</button>` : ''}
        ${!isSuper() ? `<span class="pill" style="font-size:11.5px"><span class="dot ${s.watch_all ? 'warn' : 'idle'}"></span>${s.watch_all ? 'Watching ALL' : 'Listed only'}</span>` : ''}
        ${isAdminish() ? `<button class="btn ghost" data-act="sess" data-id="${s.id}" data-op="logout">⎋ New QR</button>
        <button class="btn danger" data-act="delsess" data-id="${s.id}" data-name="${esc(s.name)}">🗑 Delete</button>` : ''}
        ${!canWrite() ? '<span style="font-size:13px;color:var(--ink-faint)">🔒 Read-only access</span>' : ''}
      </div>
    </div>`
  }).join('')
}
window.act = async (id, action) => { await post(`/sessions/${id}/${action}`); toast(`Session ${action}`); }
window.toggleWatchAll = async (id, val) => { await post(`/sessions/${id}/watchall`, { value: !!val }); toast('Updated watch scope'); }
window.removeSession = async (id, name) => { if (confirm(`Delete session "${name}"? This wipes its credentials and you'd need to scan again.`)) { await del(`/sessions/${id}`); toast('Session deleted'); } }
$('#addSessionBtn').onclick = async () => {
  const name = $('#newSessionName').value.trim() || 'Device ' + (state.sessions.length + 1)
  $('#newSessionName').value = ''
  await post('/sessions', { name }); toast('Session created — scan the QR'); go('sessions')
}

/* ---------- session dropdown helper ---------- */
function fillSessionSelect(sel, keep) {
  const cur = keep || sel.value
  sel.innerHTML = state.sessions.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
  if (cur) sel.value = cur
}

/* ---------- CHATS (premium reader) ---------- */
const SENDER_HUES = [8, 28, 145, 168, 200, 262, 322, 96]
const senderColor = (name) => {
  let h = 0; for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `hsl(${SENDER_HUES[h % SENDER_HUES.length]} 55% var(--name-l, 42%))`
}
const dayKey = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
const dayLabel = (ts) => {
  const d = new Date(ts), now = new Date()
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, now)) return 'Today'
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (same(d, y)) return 'Yesterday'
  return dayKey(ts)
}

async function renderChats() {
  const sel = $('#chatSession'); fillSessionSelect(sel, state.chatSession)
  state.chatSession = sel.value || (state.sessions[0] && state.sessions[0].id)
  sel.value = state.chatSession || ''
  state.chatSeg = state.chatSeg || 'all'
  state.chatScope = state.chatScope || 'active'
  sel.onchange = () => { state.chatSession = sel.value; state.chatJid = null; loadChatList() }
  $('#chatFilter').oninput = () => loadChatList()
  $$('#chatSeg .seg').forEach(b => {
    b.classList.toggle('active', b.dataset.seg === state.chatSeg)
    b.onclick = () => { state.chatSeg = b.dataset.seg; $$('#chatSeg .seg').forEach(x => x.classList.toggle('active', x === b)); loadChatList() }
  })
  $$('#chatScope .seg').forEach(b => {
    b.classList.toggle('active', b.dataset.scope === state.chatScope)
    b.onclick = () => { state.chatScope = b.dataset.scope; $$('#chatScope .seg').forEach(x => x.classList.toggle('active', x === b)); state.chatJid = null; loadChatList() }
  })
  await loadChatList()
}
async function loadChatList() {
  if (!state.chatSession) { $('#chatList').innerHTML = '<div class="empty">No session granted.</div>'; return }
  const endpoint = state.chatScope === 'logs' ? 'logs' : 'chats'
  const { chats } = await api(`/sessions/${state.chatSession}/${endpoint}?limit=600`)
  const f = $('#chatFilter').value.toLowerCase()
  const seg = state.chatSeg || 'all'
  const list = chats.filter(c =>
    (!f || (c.name || '').toLowerCase().includes(f)) &&
    (seg === 'all' || (seg === 'group' ? c.is_group : !c.is_group)))
  $('#chatList').innerHTML = list.length ? list.map(c => `
    <div class="chat-item ${c.jid === state.chatJid ? 'active' : ''}" data-act="openchat" data-jid="${esc(c.jid)}">
      <div class="av">${initials(c.name)}</div>
      <div style="flex:1;min-width:0">
        <div class="row1"><span class="nm">${esc(c.name)} ${c.is_group ? '<span class="gtag">grp</span>' : ''}</span><span class="tm">${c.last_ts ? fmtTime(c.last_ts) : ''}</span></div>
        <div class="lst">${esc(c.last_sender ? c.last_sender + ': ' : '')}${esc(c.last_text || '')}</div>
      </div>
    </div>`).join('') : `<div class="empty">No ${seg === 'group' ? 'groups' : seg === 'direct' ? 'direct chats' : 'chats'} captured yet.</div>`
}
window.openChat = (jid) => { state.chatJid = jid; loadChatList(); loadMessages() }
window.delLog = async (jid) => {
  if (!confirm('Delete this entire log (all stored messages + its .txt file)? This cannot be undone.')) return
  const r = await del(`/sessions/${state.chatSession}/chatlog?jid=${encodeURIComponent(jid)}`)
  if (!r.ok) return toast(r.error)
  state.chatJid = null
  $('#chatHead').innerHTML = '<div class="ch-empty">Select a conversation</div>'
  $('#chatMessages').innerHTML = '<div class="empty">Log deleted.</div>'
  toast('Log deleted'); loadChatList()
}
async function loadMessages() {
  if (!state.chatSession || !state.chatJid) return
  const { messages } = await api(`/sessions/${state.chatSession}/messages?jid=${encodeURIComponent(state.chatJid)}&limit=600`)
  const name = messages[0]?.chat_name || 'Chat'
  const isGroup = messages[0]?.is_group
  const exportBase = `/api/export/${state.chatSession}?jid=${encodeURIComponent(state.chatJid)}`
  $('#chatHead').innerHTML = `
    <div class="chat-hero">
      <div class="hav">${initials(name)}</div>
      <div style="min-width:0">
        <div class="hname">${esc(name)}</div>
        <div class="hmeta">${isGroup ? 'Group' : 'Direct'} · ${messages.length} messages · read-only</div>
      </div>
      <div class="hactions">
        <a class="btn" href="${exportBase}&fmt=txt">⬇ Export .txt</a>
        <a class="btn ghost" href="${exportBase}&fmt=json">{ } JSON</a>
        ${isAdminish() ? `<button class="btn danger" data-act="dellog" data-jid="${esc(state.chatJid)}">🗑 Delete log</button>` : ''}
      </div>
    </div>`
  const box = $('#chatMessages')
  let html = '', lastDay = ''
  for (const m of messages) {
    const dk = dayKey(m.ts)
    if (dk !== lastDay) { html += `<div class="date-sep">${dayLabel(m.ts)}</div>`; lastDay = dk }
    const mine = m.from_me
    html += `<div class="msg ${mine ? 'me' : 'them'}">
      ${!mine && isGroup ? `<div class="who" style="color:${senderColor(m.sender_name)}">${esc(m.sender_name)}</div>` : ''}
      ${m.quoted_text ? `<div class="qt">${esc(m.quoted_text)}</div>` : ''}
      <div class="tx">${esc(m.text)}</div>
      <div class="tm">${fmtClock(m.ts)}${m.has_media ? ' · 📎' : ''}${mine ? ' · you' : ''}</div>
    </div>`
  }
  box.innerHTML = html || '<div class="empty">No messages.</div>'
  box.scrollTop = box.scrollHeight
}

/* ---------- WATCHLIST ---------- */
async function renderWatchlist() {
  fillSessionSelect($('#watchSession'))
  const { watch } = await api('/watch')
  const nameById = Object.fromEntries(state.sessions.map(s => [s.id, s.name]))
  $('#watchTable').innerHTML = `<thead><tr><th>Session</th><th>Type</th><th>Value</th><th></th></tr></thead><tbody>${
    watch.length ? watch.map(w => `<tr><td>${esc(nameById[w.session_id] || w.session_id)}</td><td>${w.kind}</td><td><b>${esc(w.value)}</b></td><td><button class="btn danger" data-act="delwatch" data-id="${w.id}">Remove</button></td></tr>`).join('')
    : '<tr><td colspan="4"><div class="empty">Watchlist empty — nothing is logged until you add a group name or number.</div></td></tr>'}</tbody>`
}
window.delWatch = async (id) => { await del('/watch/' + id); toast('Removed'); renderWatchlist() }
$('#addWatchBtn').onclick = async () => {
  const sid = $('#watchSession').value, kind = $('#watchKind').value, value = $('#watchValue').value.trim()
  if (!sid || !value) return toast('Enter a value')
  await post('/watch', { sid, kind, value }); $('#watchValue').value = ''; toast('Added to watchlist'); renderWatchlist()
}

/* ---------- KEYWORDS ---------- */
async function renderKeywords() {
  const { keywords } = await api('/keywords')
  $('#keywordChips').innerHTML = keywords.length ? keywords.map(k => `<span class="chip">${esc(k.word)} <button data-act="delkw" data-id="${k.id}">×</button></span>`).join('') : '<div class="empty">No keywords. Add some to get instant alerts.</div>'
}
window.delKeyword = async (id) => { await del('/keywords/' + id); renderKeywords() }
$('#addKeywordBtn').onclick = async () => {
  const w = $('#keywordValue').value.trim(); if (!w) return
  await post('/keywords', { word: w }); $('#keywordValue').value = ''; toast('Keyword added'); renderKeywords()
}

/* ---------- HEALTH (operational noise lives here) ---------- */
async function renderHealth() {
  const s = state.stats || {}
  $('#healthStats').innerHTML = [
    ['Active sessions', s.sessionsOpen || 0],
    ['Total sessions', s.sessions || 0],
    ['Messages stored', (s.messages || 0).toLocaleString()],
    ['Groups tracked', s.groups || 0],
  ].map(([l, v]) => `<div class="card stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('')
  const { events } = await api('/events?limit=300')
  $('#eventList').innerHTML = events.length ? events.map(e => `
    <div class="evt"><span class="lvl ${e.level}">${e.level}</span><span class="code">${esc(e.code || '')}</span><span class="msg">${esc(e.message)}</span><span class="tm">${fmtClock(e.ts)}</span></div>`).join('')
    : '<div class="empty">No events yet.</div>'
}

/* ---------- FILES ---------- */
async function renderFiles() {
  const { files } = await api('/logs')
  $('#filesTable').innerHTML = `<thead><tr><th>File</th><th>Size</th><th></th></tr></thead><tbody>${
    files.length ? files.map(f => `<tr><td><b>${esc(f.name)}</b></td><td>${(f.size / 1024).toFixed(1)} KB</td><td><a class="btn" href="/logs/${encodeURIComponent(f.name)}" download>⬇ Download</a></td></tr>`).join('')
    : '<tr><td colspan="3"><div class="empty">No .txt logs yet — they appear once group messages arrive.</div></td></tr>'}</tbody>`
}

/* ---------- ABOUT (showcase) ---------- */
function renderAbout() {
  const pillars = [
    ['🔭', 'Read-only by design', 'Never sends a message, receipt, or presence. Purely passive — like sonar that detects without emitting.'],
    ['🔌', 'Multi-session', 'Link unlimited WhatsApp devices, each with its own QR. One dashboard for all of them.'],
    ['🎯', 'Targeted capture', 'Watch only the groups & numbers you choose — captured in both directions, nothing else stored.'],
    ['♻️', 'Self-healing', 'Reconnects through every WhatsApp disconnect code. Recovery is always under three minutes.'],
    ['🔐', 'RBAC + audit', 'Four roles, per-session access grants, and a full audit trail of every login and action.'],
    ['🔑', 'Licensed & hardened', 'Ed25519 machine-bound licensing, server-side enforcement, optional bytecode build.'],
  ]
  $('#aboutCard').innerHTML = `
  <div class="about">
    <div class="about-hero reveal">
      <img class="about-logo theme-light-only" src="/assets/logo-light.png" alt="Sonar" />
      <img class="about-logo theme-dark-only" src="/assets/logo-dark.png" alt="Sonar" />
      <div class="about-title">Sonar</div>
      <div class="about-tag">Read-only WhatsApp intelligence</div>
      <p class="about-lead">Watch every conversation. Send nothing. Miss nothing. Sonar links your WhatsApp devices, captures exactly the groups and numbers you choose, and keeps a permanent, searchable archive — all without ever emitting a single signal.</p>
      <div class="about-badges">
        <span>🔭 Observe-only</span><span>♻️ Self-healing</span><span>🗂️ Permanent archive</span><span>🛡️ Audited</span>
      </div>
    </div>

    <div class="grid cols-3">
      ${pillars.map(([ic, h, p]) => `<div class="card pillar"><div class="pico">${ic}</div><h4>${h}</h4><p>${p}</p></div>`).join('')}
    </div>

    <div class="about-ribbon"><span class="dot"></span> 100% read-only — Sonar never sends messages, read receipts, or presence.</div>

    <div class="about-foot">
      Use only on accounts you own or are authorised to monitor, and respect WhatsApp's Terms of Service.
    </div>
  </div>`
}

/* ---------- AUDIT TRAIL ---------- */
const dur = (a, b) => { if (!a) return '—'; const s = Math.round(((b || Date.now()) - a) / 1000); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm' }
async function renderAudit() {
  const d = await api('/audit?limit=500')
  const s = d.stats || {}
  $('#auditStats').innerHTML = [
    ['Logins · 24h', s.logins24h || 0], ['Active now', s.active || 0],
    ['Actions · 24h', s.actions24h || 0], ['Users', s.users || 0],
  ].map(([l, v]) => `<div class="card stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('')

  $('#activeTable').innerHTML = `<thead><tr><th>User</th><th>IP</th><th>Logged in</th><th>Duration</th><th>Last seen</th></tr></thead><tbody>${
    d.active.length ? d.active.map(a => `<tr><td><b>${esc(a.username)}</b></td><td>${esc(a.ip)}</td><td>${fmtTime(a.login_at)}</td><td><b>${dur(a.login_at)}</b></td><td>${fmtClock(a.last_seen)}</td></tr>`).join('')
    : '<tr><td colspan="5"><div class="empty">No active sessions.</div></td></tr>'}</tbody>`

  $('#loginTable').innerHTML = `<thead><tr><th>User</th><th>IP</th><th>Login</th><th>Logout</th><th>Duration</th><th>Device</th></tr></thead><tbody>${
    d.sessions.length ? d.sessions.map(a => `<tr><td><b>${esc(a.username)}</b></td><td>${esc(a.ip)}</td><td>${fmtTime(a.login_at)}</td><td>${a.logout_at ? fmtTime(a.logout_at) : '<span style="color:var(--ok);font-weight:800">active</span>'}</td><td>${dur(a.login_at, a.logout_at)}</td><td style="font-size:12px;color:var(--ink-faint)">${esc((a.ua || '').slice(0, 40))}</td></tr>`).join('')
    : '<tr><td colspan="6"><div class="empty">No login history.</div></td></tr>'}</tbody>`

  $('#auditTable').innerHTML = `<thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>IP</th></tr></thead><tbody>${
    d.audit.length ? d.audit.map(a => `<tr><td style="white-space:nowrap">${fmtTime(a.ts)}</td><td><b>${esc(a.username)}</b></td><td><span class="chip" style="padding:3px 9px;font-size:12px">${esc(a.action)}</span></td><td>${esc(a.target || '')} ${a.detail ? '<span style="color:var(--ink-faint)">· ' + esc(a.detail) + '</span>' : ''}</td><td style="font-size:12px;color:var(--ink-faint)">${esc(a.ip)}</td></tr>`).join('')
    : '<tr><td colspan="5"><div class="empty">No actions yet.</div></td></tr>'}</tbody>`
}

/* ---------- USERS (role-gated) ---------- */
async function renderUsers() {
  // Management cards only for admin / super_admin; everyone keeps change-password.
  $$('#view-users .admin-only').forEach(el => el.style.display = isAdminish() ? '' : 'none')
  if (!isAdminish()) return
  const { users } = await api('/users')
  $('#usersTable').innerHTML = `<thead><tr><th>User</th><th>Role</th><th>Created</th><th>Last login</th><th></th></tr></thead><tbody>${
    users.length ? users.map(u => `<tr><td><b>${esc(u.username)}</b></td><td><span class="chip" style="padding:3px 9px;font-size:12px">${ROLE_LABEL[u.role] || u.role}</span></td><td>${u.created_at ? fmtTime(u.created_at) : '—'}</td><td>${u.last_login ? fmtTime(u.last_login) : '—'}</td><td style="text-align:right">${u.id === state.me.id ? '<span style="color:var(--ink-faint)">you</span>' : `<button class="btn" data-act="resetpw" data-id="${u.id}" data-name="${esc(u.username)}">🔑 Reset password</button> <button class="btn danger" data-act="deluser" data-id="${u.id}">Remove</button>`}</td></tr>`).join('') : '<tr><td colspan="5"><div class="empty">No users yet — add one above.</div></td></tr>'}</tbody>`

  // grants
  const g = await api('/grants')
  $('#grantUser').innerHTML = g.users.length ? g.users.map(u => `<option value="${u.id}">${esc(u.username)} · ${ROLE_LABEL[u.role]}</option>`).join('') : '<option value="">No manager/viewer users yet</option>'
  $('#grantSession').innerHTML = g.sessions.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')
  $('#grantsTable').innerHTML = `<thead><tr><th>User</th><th>Role</th><th>Session</th><th>Granted by</th><th></th></tr></thead><tbody>${
    g.grants.length ? g.grants.map(x => `<tr><td><b>${esc(x.username || '—')}</b></td><td>${ROLE_LABEL[x.role] || x.role || ''}</td><td>${esc(x.session_name || x.session_id)}</td><td style="color:var(--ink-faint)">${esc(x.granted_by || '')}</td><td><button class="btn danger" data-act="delgrant" data-id="${x.id}">Revoke</button></td></tr>`).join('') : '<tr><td colspan="5"><div class="empty">No grants yet. Managers/viewers see nothing until granted a session.</div></td></tr>'}</tbody>`
}
window.delUser = async (id) => { if (confirm('Remove this user?')) { const r = await del('/users/' + id); if (!r.ok) return toast(r.error); toast('User removed'); renderUsers() } }
window.delGrant = async (id) => { await del('/grants/' + id); toast('Access revoked'); renderUsers() }
window.resetPw = async (id, name) => {
  const next = prompt(`Set a new password for "${name}" (min 6 chars):`)
  if (!next) return
  const r = await post(`/users/${id}/password`, { next })
  if (!r.ok) return toast(r.error)
  toast(`Password reset for ${name}`)
}
function bindUserForms() {
  $('#addUserBtn').onclick = async () => {
    const username = $('#newUser').value.trim(), password = $('#newPass').value, role = $('#newRole').value
    if (!username || !password) return toast('Enter username & password')
    const r = await post('/users', { username, password, role })
    if (!r.ok) return toast(r.error)
    $('#newUser').value = ''; $('#newPass').value = ''; toast('User created'); renderUsers()
  }
  $('#addGrantBtn').onclick = async () => {
    const user_id = $('#grantUser').value, session_id = $('#grantSession').value
    if (!user_id || !session_id) return toast('Pick a user and a session')
    const r = await post('/grants', { user_id, session_id })
    if (!r.ok) return toast(r.error)
    toast('Access granted'); renderUsers()
  }
  $('#changePassBtn').onclick = async () => {
    const current = $('#curPass').value, next = $('#nxtPass').value
    const r = await post('/password', { current, next })
    if (!r.ok) return toast(r.error)
    $('#curPass').value = ''; $('#nxtPass').value = ''; toast('Password updated')
  }
}

/* ---------- LICENSE ---------- */
const LIC_LABEL = { active: 'Active', disabled: 'Not enforced (dev)', unlicensed: 'Not activated', expired: 'Expired', revoked: 'Revoked', grace_over: 'Offline limit reached', invalid: 'Invalid', tampered: 'Tampered', unknown: 'Checking…' }
function licBannerText(l) {
  if (!l || !l.enabled || l.status === 'active' || l.status === 'disabled') return null
  const map = {
    unlicensed: '🔑 No license activated — WhatsApp sessions are stopped. Activate a license to start monitoring.',
    expired: '⛔ License expired — all sessions are stopped. Renew to resume.',
    revoked: '⛔ License revoked — all sessions are stopped.',
    grace_over: '⛔ License server unreachable past the offline limit — sessions stopped. Reconnect to the server.',
    invalid: '⛔ License invalid for this machine — sessions stopped.',
    tampered: '⛔ License state tampered — sessions stopped. Re-activate.',
  }
  return map[l.status] || ('⛔ License ' + l.status + ' — sessions stopped.')
}
async function refreshLicenseBanner() {
  try {
    const { license } = await api('/license/status')
    state.license = license
    const el = $('#licenseBanner'); const txt = licBannerText(license)
    if (txt) { el.textContent = txt; el.classList.toggle('bad', license.status !== 'unlicensed'); el.classList.remove('hide') }
    else el.classList.add('hide')
  } catch {}
}
async function renderLicense() {
  const { license: l } = await api('/license/status')
  state.license = l
  const dotByStatus = { active: 'ok', disabled: 'ok', unlicensed: 'idle', unknown: 'idle' }
  const dot = dotByStatus[l.status] || 'bad'
  const exp = l.expiresAt ? fmtTime(l.expiresAt) : '—'
  $('#licenseStatusCard').innerHTML = `
    <h3>License status</h3>
    <div style="margin-bottom:14px"><span class="pill"><span class="dot ${dot}"></span>${LIC_LABEL[l.status] || l.status}</span></div>
    <div id="licenseCountdown" data-exp="${l.expiresAt || ''}"></div>
    <div class="kv" style="margin-top:14px">
      <div class="k">Plan</div><div class="v">${esc(l.plan || '—')}</div>
      <div class="k">Customer</div><div class="v">${esc(l.customer || '—')}</div>
      <div class="k">Expires on</div><div class="v">${exp}</div>
      <div class="k">Enforcement</div><div class="v">${l.enabled ? 'On' : 'Off (dev)'}</div>
      <div class="k">Offline window</div><div class="v">${l.graceHours}h</div>
    </div>
    ${l.detail ? `<p style="margin-top:10px;color:var(--ink-faint);font-size:13px">${esc(l.detail)}</p>` : ''}`
  tickCountdown()
  $('#licenseMachineCard').innerHTML = `
    <h3>This machine</h3>
    <div class="kv">
      <div class="k">Host</div><div class="v">${esc(l.machine?.host || '—')}</div>
      <div class="k">Platform</div><div class="v">${esc((l.machine?.platform || '') + ' ' + (l.machine?.arch || ''))}</div>
      <div class="k">CPUs</div><div class="v">${l.machine?.cpus || '—'}</div>
    </div>
    <div class="k" style="margin-top:12px;color:var(--ink-faint);font-size:12px">Machine fingerprint</div>
    <div style="font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;color:var(--ink-soft)">${esc(l.fingerprint || '')}</div>`
  // activation is super_admin only
  $('#licenseActivateCard').style.display = isSuper() ? '' : 'none'
}
function tickCountdown() {
  const el = $('#licenseCountdown'); if (!el) return
  const exp = Number(el.dataset.exp)
  if (!exp) { el.innerHTML = '<div class="countdown-num">—</div>'; return }
  let ms = exp - Date.now()
  if (ms <= 0) { el.innerHTML = '<div class="countdown over">Expired</div>'; return }
  const d = Math.floor(ms / 86400000); ms -= d * 86400000
  const h = Math.floor(ms / 3600000); ms -= h * 3600000
  const m = Math.floor(ms / 60000); ms -= m * 60000
  const s = Math.floor(ms / 1000)
  const cls = d > 7 ? 'ok' : d >= 2 ? 'warn' : 'bad'
  el.innerHTML = `<div class="countdown ${cls}">
    <div class="cu"><span class="n">${d}</span><span class="l">days</span></div>
    <div class="cu"><span class="n">${String(h).padStart(2,'0')}</span><span class="l">hrs</span></div>
    <div class="cu"><span class="n">${String(m).padStart(2,'0')}</span><span class="l">min</span></div>
    <div class="cu"><span class="n">${String(s).padStart(2,'0')}</span><span class="l">sec</span></div>
  </div><div class="cu-sub">remaining on this plan</div>`
}
function bindLicense() {
  $('#activateBtn').onclick = async () => {
    const key = $('#licenseKey').value.trim(); if (!key) return toast('Enter a license key')
    const r = await post('/license/activate', { key })
    if (!r.ok) return toast(r.error)
    toast('License ' + r.status); $('#licenseKey').value = ''; renderLicense(); refreshLicenseBanner()
  }
  $('#refreshLicenseBtn').onclick = async () => { await post('/license/refresh'); toast('Re-checked'); renderLicense(); refreshLicenseBanner() }
}

/* ---------- click delegation (CSP-safe: no inline handlers) ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return
  const a = t.dataset
  switch (a.act) {
    case 'sess': act(a.id, a.op); break
    case 'watchall': toggleWatchAll(a.id, a.val); break
    case 'delsess': removeSession(a.id, a.name); break
    case 'openchat': if (a.sid) state.chatSession = a.sid; openChat(a.jid); break
    case 'dellog': delLog(a.jid); break
    case 'delwatch': delWatch(a.id); break
    case 'delkw': delKeyword(a.id); break
    case 'deluser': delUser(a.id); break
    case 'resetpw': resetPw(a.id, a.name); break
    case 'delgrant': delGrant(a.id); break
  }
})

/* ---------- AUTH FLOW ---------- */
const isAdminish = () => state.me && (state.me.role === 'admin' || state.me.role === 'super_admin')
const isSuper = () => state.me && state.me.role === 'super_admin'
const canWrite = () => state.me && state.me.role !== 'viewer'
const ROLE_LABEL = { super_admin: 'Super Admin', admin: 'Admin', manager: 'Manager', viewer: 'Viewer' }
function showUser(me) {
  state.me = me
  $('#popName').textContent = me.username
  $('#popRole').textContent = ROLE_LABEL[me.role] || me.role
  $('#popAv').textContent = initials(me.username)
  const fab = $('#profileFab'); fab.textContent = initials(me.username); fab.style.display = 'grid'
  // Audit Trail → super_admin only. Users page → admin / super_admin only.
  $$('#nav button').forEach(b => {
    if (b.dataset.view === 'audit') b.style.display = isSuper() ? '' : 'none'
    if (b.dataset.view === 'users') b.style.display = isAdminish() ? '' : 'none'
    if (b.dataset.view === 'license') b.style.display = isAdminish() ? '' : 'none' // admin + super see countdown
  })
}
/* profile popover */
function initProfile() {
  const fab = $('#profileFab'), pop = $('#profilePop')
  fab.onclick = (e) => { e.stopPropagation(); pop.classList.toggle('show') }
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && e.target !== fab) pop.classList.remove('show')
  })
}
$('#logoutBtn').onclick = async () => { await post('/logout'); location.reload() }
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault()
  $('#loginError').textContent = ''
  const username = $('#loginUser').value.trim(), password = $('#loginPass').value
  const r = await post('/login', { username, password })
  if (!r.ok) { $('#loginError').textContent = r.error || 'Login failed'; return }
  $('#loginScreen').classList.remove('show')
  startApp(r.user)
}
function startApp(me) {
  showUser(me)
  initProfile()
  initSocket()
  bindUserForms()
  bindLicense()
  refreshLicenseBanner()
  setInterval(() => { if (state.view === 'license') tickCountdown() }, 1000) // live countdown
  go(location.hash.slice(1) || 'dashboard')
}

/* ---------- global search ---------- */
let searchTimer
$('#globalSearch').oninput = (e) => {
  clearTimeout(searchTimer)
  const q = e.target.value.trim()
  searchTimer = setTimeout(async () => {
    if (q.length < 2) return
    const { messages } = await api('/search?q=' + encodeURIComponent(q))
    go('chats')
    $('#chatList').innerHTML = `<div style="padding:10px;font-weight:800">Search: "${esc(q)}" · ${messages.length}</div>` +
      messages.slice(0, 200).map(m => `<div class="chat-item" data-act="openchat" data-sid="${esc(m.session_id)}" data-jid="${esc(m.chat_jid)}">
        <div class="av">${initials(m.chat_name)}</div><div style="flex:1;min-width:0">
        <div class="row1"><span class="nm">${esc(m.chat_name)}</span><span class="tm">${fmtTime(m.ts)}</span></div>
        <div class="lst"><b>${esc(m.sender_name)}:</b> ${esc(m.text)}</div></div></div>`).join('')
  }, 300)
}

/* ---------- boot: auth gate ---------- */
;(async () => {
  const me = await api('/me')
  if (me.ok) startApp(me.user)
  else { $('#loginScreen').classList.add('show'); $('#loginUser').focus() }
})()
