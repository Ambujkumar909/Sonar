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

const state = { sessions: [], stats: {}, view: 'dashboard', chatSession: null, chatJid: null, feed: [], newGroups: [] }
// Pending new-group alerts are persisted server-side (admin-visible across machines),
// so any admin sees a group joined while their dashboard was closed.
async function loadPendingGroups() {
  if (!isAdminish()) { state.newGroups = []; return }
  try {
    const r = await api('/pending-groups')
    if (r && r.ok) state.newGroups = r.groups.map(g => ({ sessionId: g.session_id, jid: g.jid, subject: g.subject, participants: g.participants, ts: g.ts }))
  } catch {}
}
const fmtTime = (ts) => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
const fmtClock = (ts) => new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
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
const TITLES = { dashboard: 'Dashboard', reports: 'Reports', emails: 'Email Reports', scheduler: 'Scheduler', sessions: 'Sessions', chats: 'Recent Chats', watchlist: 'Watchlist', keywords: 'Keyword Alerts', health: 'Health', audit: 'Audit Trail', license: 'License', users: 'Users', files: 'Log Files', about: 'About' }
function go(view) {
  if (!TITLES[view]) view = 'dashboard'
  // route guards (defence in depth — API enforces too)
  if (view === 'audit' && state.me && state.me.role !== 'super_admin') view = 'dashboard'
  if ((view === 'users' || view === 'license' || view === 'emails' || view === 'scheduler') && !(state.me && (state.me.role === 'admin' || state.me.role === 'super_admin'))) view = 'dashboard'
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
  socket.on('newgroup', (g) => {
    if (!isAdminish()) return // pending-group alerts are an admin concern
    if (state.newGroups.some(x => x.jid === g.jid && x.sessionId === g.sessionId)) return
    state.newGroups.unshift(g)
    const sname = (state.sessions.find(s => s.id === g.sessionId) || {}).name || 'a session'
    toast(`👥 New group joined on ${esc(sname)}: <b>${esc(g.subject)}</b><br><span style="font-weight:500;color:var(--ink-soft)">Open the Dashboard to add it to your watchlist.</span>`, 'alert')
    renderNewGroupBanner(); updateNewGroupBadge()
  })
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
  ({ dashboard: renderDashboard, reports: renderReports, emails: renderEmails, scheduler: renderScheduler, sessions: renderSessions, chats: renderChats,
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
  const fmtHr = (h) => { let hh = h % 12; if (hh === 0) hh = 12; return hh + (h < 12 ? 'am' : 'pm') } // 12am · 6am · 12pm · 6pm
  let bars = '', axis = ''
  for (let i = 23; i >= 0; i--) {
    const b = nowB - i, n = byBucket[b] || 0
    const hour = new Date(b * 3600000).getHours()
    bars += `<div class="bar" style="height:${(n / max) * 100}%" title="${fmtHr(hour)} · ${n} msg${n === 1 ? '' : 's'}"></div>`
    axis += `<span>${hour % 6 === 0 ? fmtHr(hour) : ''}</span>` // label every 6h
  }
  $('#hourlyBars').innerHTML = bars
  $('#hourlyAxis').innerHTML = axis

  $('#topChats').innerHTML = a.topChats.length ? a.topChats.map(c => `
    <div class="topchat" data-act="opentop" data-sid="${esc(c.session_id)}" data-jid="${esc(c.chat_jid)}" title="Open in Recent Chats">
      <span class="tc-name">${esc(c.chat_name || '—')}</span><span class="tc-n">${c.n} msgs</span></div>
  `).join('') : '<div class="empty">No messages yet.</div>'
  renderFeed()
  await loadPendingGroups()
  renderNewGroupBanner(); updateNewGroupBadge()
}
function updateNewGroupBadge() {
  const b = $('#navNewGroups'); if (!b) return
  const n = state.newGroups.length
  b.textContent = n
  b.classList.toggle('hide', n === 0)
}
function renderNewGroupBanner() {
  const el = $('#newGroupBanner'); if (!el) return
  const nameById = Object.fromEntries(state.sessions.map(s => [s.id, s.name]))
  if (!state.newGroups.length) { el.classList.add('hide'); el.innerHTML = ''; return }
  el.classList.remove('hide')
  el.innerHTML = `<h3 style="margin-bottom:12px">👥 New group${state.newGroups.length > 1 ? 's' : ''} joined <span class="pill" style="font-size:11.5px"><span class="dot warn"></span>${state.newGroups.length}</span></h3>
    <div style="display:flex;flex-direction:column;gap:10px">${
    state.newGroups.map(g => `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--line);border-radius:12px">
      <div style="flex:1;min-width:180px"><b>${esc(g.subject)}</b> <span style="color:var(--ink-faint);font-size:12.5px">· ${g.participants || 0} members · ${esc(nameById[g.sessionId] || g.sessionId)}</span></div>
      <button class="btn primary" data-act="addgroupwatch" data-jid="${esc(g.jid)}" data-sid="${esc(g.sessionId)}">＋ Add to watchlist</button>
      <button class="btn" data-act="dismissgroup" data-jid="${esc(g.jid)}" data-sid="${esc(g.sessionId)}">Dismiss</button>
    </div>`).join('')}</div>`
}
function renderFeed() {
  const el = $('#liveFeed'); if (!el) return
  if (!state.feed.length) { el.innerHTML = '<div class="empty">Waiting for incoming messages…</div>'; return }
  el.innerHTML = state.feed.map(m => `
    <div class="f"><div class="top"><span class="ch">${esc(m.chat_name)} ${m.is_group ? '<span class="gtag">group</span>' : ''}</span><span class="tm" style="font-size:11px;color:var(--ink-faint)">${fmtClock(m.ts)}</span></div>
    <div class="tx"><span class="sn">${esc(m.sender_name)}:</span> ${esc(m.text)}</div></div>`).join('')
}

/* ---------- REPORTS ---------- */
async function renderReports() {
  const frame = $('#reportFrame'); if (!frame) return
  const daysSel = $('#reportDays'), dl = $('#reportDownload'), aiBtn = $('#reportAi'), metricsBtn = $('#reportMetrics'), status = $('#reportStatus')
  const admin = isAdminish()
  const win = () => { const d = daysSel && daysSel.value; return d && d !== 'all' ? '&days=' + encodeURIComponent(d) : '' }
  const syncDownload = () => { if (dl) dl.href = '/api/report/chats?download=1' + win() } // top download = raw chat data (no API)
  const viewMetrics = () => { if (status) status.textContent = ''; frame.src = '/api/report?t=' + Date.now() + win(); syncDownload() }

  // On phones a fixed-height iframe letterboxes the report into a nested
  // scroll area. Grow the frame to its content instead so the page scrolls.
  const DESK_H = 'calc(100vh - 280px)'
  const fitFrame = () => {
    if ((window.innerWidth || 0) > 760) { frame.style.height = DESK_H; return }
    try {
      const doc = frame.contentDocument
      const h = doc && (doc.documentElement.scrollHeight || (doc.body && doc.body.scrollHeight))
      frame.style.height = h ? Math.max(420, h) + 'px' : DESK_H
    } catch { frame.style.height = DESK_H }
  }
  frame.onload = () => {
    if (status && status.dataset.busy !== '1') status.textContent = ''
    fitFrame(); setTimeout(fitFrame, 300) // again after charts lay out
  }
  if (!frame.dataset.fitBound) { frame.dataset.fitBound = '1'; window.addEventListener('resize', fitFrame) }
  if (metricsBtn) metricsBtn.onclick = viewMetrics
  if (daysSel) daysSel.onchange = viewMetrics

  const savedCard = $('#savedReportsCard'); if (savedCard) savedCard.style.display = admin ? '' : 'none'
  if (aiBtn) {
    aiBtn.style.display = admin ? '' : 'none'
    aiBtn.onclick = async () => {
      if (!confirm('Generate an AI report now?\n\nThis calls the Claude API and incurs cost. The result is saved under "Saved AI reports" below, where you can open or download it anytime without regenerating.')) return
      status.dataset.busy = '1'; status.textContent = '⏳ Generating AI report… this can take up to a minute.'; aiBtn.disabled = true
      try {
        const r = await post('/reports?days=' + encodeURIComponent(daysSel.value || 'all'), {})
        status.dataset.busy = ''
        if (r && r.ok && r.id) { status.textContent = ''; await loadSavedReports(); frame.src = '/api/reports/' + r.id + '?t=' + Date.now(); toast('AI report generated & saved') }
        else { status.textContent = ''; toast((r && r.error) || 'Generation failed', 'err') }
      } catch { status.dataset.busy = ''; status.textContent = ''; toast('Generation failed', 'err') }
      finally { aiBtn.disabled = false }
    }
  }
  if (admin) await loadSavedReports()
  viewMetrics() // default view
}
async function loadSavedReports() {
  const el = $('#savedReportsTable'); if (!el) return
  const r = await api('/reports'); if (!r || !r.ok) return
  const rows = r.reports || []
  el.innerHTML = `<thead><tr><th>Generated</th><th>Window</th><th>Msgs</th><th>By</th><th></th></tr></thead><tbody>${
    rows.length ? rows.map(x => `<tr>
      <td style="white-space:nowrap">${fmtTime(x.created_at)}</td>
      <td>${x.window_days ? 'Last ' + x.window_days + 'd' : 'All'}</td>
      <td>${x.msg_count}</td>
      <td>${esc(x.created_by || '')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn" data-act="viewreport" data-id="${x.id}">View</button>
        <a class="btn" href="/api/reports/${x.id}?download=1">⬇</a>
        <button class="btn danger" data-act="delreport" data-id="${x.id}">🗑</button>
      </td></tr>`).join('') : '<tr><td colspan="5"><div class="empty">No AI reports yet — click "Generate AI report".</div></td></tr>'}</tbody>`
}
window.viewReport = (id) => { const f = $('#reportFrame'); if (f) f.src = '/api/reports/' + id + '?t=' + Date.now() }
window.delReport = async (id) => {
  if (!confirm('Delete this saved report?')) return
  const r = await del('/reports/' + id)
  if (r && r.ok === false) return toast(r.error || 'Could not delete', 'err')
  toast('Report deleted'); loadSavedReports()
}

/* ---------- EMAIL REPORTS ---------- */
async function renderEmails() {
  const r = await api('/report-emails')
  if (!r || !r.ok) return
  const s = r.schedule || {}
  const smtp = s.smtpConfigured
    ? `<span class="pill" style="font-size:11.5px"><span class="dot ok"></span>SMTP ready${s.from ? ' · ' + esc(s.from) : ''}</span>`
    : `<span class="pill" style="font-size:11.5px"><span class="dot bad"></span>Email not configured — contact your administrator</span>`
  $('#scheduleCard').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div><h3 style="margin:0">Daily report schedule</h3>
        <div style="font-size:13px;color:var(--ink-soft);margin-top:4px">
          ${s.enabled ? `Runs daily at <b>${esc(s.timesLabel || '')}</b> (${esc(s.tz)}) · each run covers the last 24 hours · next: <b>${esc(s.nextRunLabel || '—')}</b>` : 'Scheduler is <b>disabled</b>.'}
        </div>
        <div style="margin-top:8px">${smtp}</div>
      </div>
      <div style="margin-left:auto"><button class="btn" id="runNowBtn">▶ Generate &amp; send now</button></div>
    </div>
    <div class="inline-form" style="margin-top:14px;align-items:flex-end">
      <div class="field" style="flex:1"><label>Send a SAMPLE report to (optional — blank = all enabled recipients)</label><input class="in" id="testEmail" placeholder="you@company.com" /></div>
      <button class="btn primary" id="sendTestBtn">✉ Send sample report</button>
    </div>
    <p style="margin-top:10px;font-size:12.5px;color:var(--ink-faint)"><b>Send sample report</b> emails a fully-populated demo report (charts + tables) — best for testing delivery &amp; format. <b>Generate &amp; send now</b> runs the real daily job on live data (saves under Reports).</p>`
  $('#runNowBtn').onclick = runReportNow
  $('#sendTestBtn').onclick = sendTestReport

  const rows = r.emails || []
  $('#emailTable').innerHTML = `<thead><tr><th>Email</th><th>Label</th><th>Status</th><th></th></tr></thead><tbody>${
    rows.length ? rows.map(e => `<tr>
      <td><b>${esc(e.email)}</b></td>
      <td>${esc(e.label || '')}</td>
      <td>${e.enabled ? '<span class="pill" style="font-size:11px;background:var(--ok,#1c8f52);color:#fff">Enabled</span>' : '<span class="pill" style="font-size:11px;background:#9aa6b2;color:#fff">Disabled</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn" data-act="toggleemail" data-id="${e.id}" data-on="${e.enabled ? 0 : 1}">${e.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn danger" data-act="delemail" data-id="${e.id}">Remove</button>
      </td></tr>`).join('')
    : '<tr><td colspan="4"><div class="empty">No recipients yet — add an email above. The daily report is saved regardless, but only emailed to enabled recipients.</div></td></tr>'}</tbody>`
}
$('#addEmailBtn').onclick = async () => {
  const email = $('#emailAddr').value.trim(), label = $('#emailLabel').value.trim()
  if (!email) return toast('Enter an email')
  const r = await post('/report-emails', { email, label })
  if (r && r.ok === false) return toast(r.error || 'Could not add', 'err')
  $('#emailAddr').value = ''; $('#emailLabel').value = ''; toast('Recipient added'); renderEmails()
}
window.toggleEmail = async (id, on) => { await post(`/report-emails/${id}/toggle`, { enabled: !!on }); toast(on ? 'Enabled' : 'Disabled'); renderEmails() }
window.delEmail = async (id) => { if (!confirm('Remove this recipient?')) return; await del('/report-emails/' + id); toast('Removed'); renderEmails() }
async function runReportNow() {
  const btn = $('#runNowBtn'); if (btn) { btn.disabled = true; btn.textContent = '… running' }
  try {
    const r = await post('/report-emails/run-now', {})
    if (r && r.ok) {
      if (!r.smtp) toast(`Report #${r.id} saved (${r.stats.messages} msgs). SMTP not configured — not emailed.`, 'alert')
      else if (r.emailError) toast(`Report #${r.id} saved, but email failed: ${esc(r.emailError)}`, 'err')
      else toast(`Report #${r.id} saved & emailed to ${r.emailed}/${r.recipients} recipient(s).`)
    } else toast((r && r.error) || 'Run failed', 'err')
  } catch { toast('Run failed', 'err') }
  finally { if (btn) { btn.disabled = false; btn.textContent = '▶ Generate & send now' }; renderEmails() }
}
async function sendTestReport() {
  const to = $('#testEmail').value.trim()
  const btn = $('#sendTestBtn'); if (btn) { btn.disabled = true; btn.textContent = '… sending' }
  try {
    const r = await post('/report-emails/send-test', to ? { to } : {})
    if (r && r.ok) toast(`Sample report emailed to ${esc((r.to || []).join(', '))} ✓`)
    else toast((r && r.error) || 'Send failed', 'err')
  } catch { toast('Send failed', 'err') }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✉ Send sample report' } }
}

/* ---------- SCHEDULER ---------- */
const SCHED_PRESETS = ['1', '3', '7', '30', '365']
function setSelectCustom(selId, wrapId, customId, val) {
  const sel = $(selId), v = String(val)
  if (SCHED_PRESETS.includes(v)) { sel.value = v; $(wrapId).style.display = 'none' }
  else { sel.value = 'custom'; $(wrapId).style.display = ''; $(customId).value = v }
}
function readSelectCustom(selId, customId) {
  const v = $(selId).value
  const n = v === 'custom' ? Number($(customId).value) : Number(v)
  return Math.min(3650, Math.max(1, Math.floor(n || 1)))
}
async function renderScheduler() {
  const r = await api('/schedule'); if (!r || !r.ok) return
  const c = r.config, s = r.status
  $('#schedEnabled').checked = !!c.enabled
  $('#schedTimes').value = (c.times || []).join(', ')
  setSelectCustom('#schedFreq', '#schedFreqCustomWrap', '#schedFreqCustom', c.intervalDays)
  setSelectCustom('#schedWindow', '#schedWindowCustomWrap', '#schedWindowCustom', c.windowDays)
  $('#schedTz').value = c.tz || 'Asia/Kolkata'
  $('#schedFreq').onchange = () => { $('#schedFreqCustomWrap').style.display = $('#schedFreq').value === 'custom' ? '' : 'none' }
  $('#schedWindow').onchange = () => { $('#schedWindowCustomWrap').style.display = $('#schedWindow').value === 'custom' ? '' : 'none' }
  const freqLabel = { 1: 'every day', 3: 'every 3 days', 7: 'weekly', 30: 'monthly', 365: 'yearly' }[c.intervalDays] || `every ${c.intervalDays} days`
  $('#schedNextCard').innerHTML = `<h3 style="margin:0">Next run</h3>
    <div style="font-size:13px;color:var(--ink-soft);margin-top:6px">
      ${s.enabled ? `<b>${esc(s.nextRunLabel || '—')}</b> (${esc(s.tz)}) · runs <b>${esc(freqLabel)}</b> at <b>${esc((c.times || []).join(', '))}</b> · each report covers the last <b>${c.windowDays}</b> day(s)` : 'Scheduler is <b>disabled</b>.'}
      <span style="margin-left:10px">${s.smtpConfigured ? '<span class="pill" style="font-size:11px"><span class="dot ok"></span>SMTP ready</span>' : '<span class="pill" style="font-size:11px"><span class="dot bad"></span>SMTP off</span>'}</span>
    </div>`
  $('#saveSchedBtn').onclick = saveSchedule
}
async function saveSchedule() {
  const times = $('#schedTimes').value.split(',').map(t => t.trim()).filter(Boolean)
  if (!times.length) return toast('Add at least one run time (HH:MM)', 'err')
  if (!times.every(t => /^\d{1,2}:\d{2}$/.test(t))) return toast('Times must be HH:MM (e.g. 14:00)', 'err')
  const payload = {
    enabled: $('#schedEnabled').checked,
    times,
    intervalDays: readSelectCustom('#schedFreq', '#schedFreqCustom'),
    windowDays: readSelectCustom('#schedWindow', '#schedWindowCustom'),
    tz: $('#schedTz').value.trim() || 'Asia/Kolkata',
  }
  const btn = $('#saveSchedBtn'); btn.disabled = true; btn.textContent = 'Saving…'
  try {
    const r = await post('/schedule', payload)
    if (r && r.ok) { toast('Schedule saved · next: ' + (r.status.nextRunLabel || '—')); renderScheduler() }
    else toast((r && r.error) || 'Save failed', 'err')
  } catch { toast('Save failed', 'err') }
  finally { btn.disabled = false; btn.textContent = 'Save schedule' }
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
const dayKey = (ts) => new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
const dayLabel = (ts) => {
  const now = Date.now() // compare IST calendar days (dayKey is Asia/Kolkata)
  if (dayKey(ts) === dayKey(now)) return 'Today'
  if (dayKey(ts) === dayKey(now - 86400000)) return 'Yesterday'
  return dayKey(ts)
}

async function renderChats() {
  // A dashboard "most active chats" click asks us to jump straight into a chat.
  const pending = state.pendingOpenChat; state.pendingOpenChat = null
  const sel = $('#chatSession')
  fillSessionSelect(sel, pending ? pending.sid : state.chatSession)
  // pending.sid is authoritative — don't let the dropdown reset clobber it
  state.chatSession = (pending && pending.sid) || sel.value || (state.sessions[0] && state.sessions[0].id)
  sel.value = state.chatSession || ''
  if (pending) state.chatJid = pending.jid
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
  if (pending && state.chatJid) await loadMessages() // open the conversation the dashboard asked for
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
      <div class="ch-id">
        <div class="hav">${initials(name)}</div>
        <div style="min-width:0">
          <div class="hname">${esc(name)}</div>
          <div class="hmeta">${isGroup ? 'Group' : 'Direct'} · ${messages.length} messages · read-only</div>
        </div>
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
const normGroup = (s) => (s || '').trim().toLowerCase()
// Looser key (drops case, spacing AND punctuation) — used only to self-heal a
// hand-typed entry against the authoritative name picked from the dropdown.
const looseGroup = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
function drawWatchTable(watch, nameById, sizeMap) {
  state.watchRender = { watch, nameById, sizeMap } // cache so header clicks re-sort without refetching
  const memVal = (w) => {
    if (w.kind !== 'group') return null
    const live = sizeMap[w.session_id] && sizeMap[w.session_id][normGroup(w.value)]
    if (live != null) return live                 // freshest: live group size
    return (w.members != null ? w.members : null) // stored fallback
  }
  const memCell = (w) => { const v = memVal(w); return v != null ? v : '—' }
  const s = state.watchSort
  const rows = watch.slice()
  if (s && s.key === 'value') {
    rows.sort((a, b) => s.dir * String(a.value || '').localeCompare(String(b.value || ''), undefined, { sensitivity: 'base' }))
  } else if (s && s.key === 'members') {
    rows.sort((a, b) => {
      const av = memVal(a), bv = memVal(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1   // unknown / non-group rows always sink to the bottom
      if (bv == null) return -1
      return s.dir * (av - bv)
    })
  }
  const ind = (key) => (s && s.key === key) ? (s.dir > 0 ? ' ▲' : ' ▼') : ''
  $('#watchTable').innerHTML =
    `<thead><tr><th>Session</th><th>Type</th>`
    + `<th class="th-sort" data-act="sortwatch" data-key="value">Value${ind('value')}</th>`
    + `<th class="th-sort" data-act="sortwatch" data-key="members">Members${ind('members')}</th>`
    + `<th></th></tr></thead><tbody>${
    rows.length ? rows.map(w => `<tr><td>${esc(nameById[w.session_id] || w.session_id)}</td><td>${w.kind}</td><td><b>${esc(w.value)}</b></td><td>${memCell(w)}</td><td><button class="btn danger" data-act="delwatch" data-id="${w.id}">Remove</button></td></tr>`).join('')
    : '<tr><td colspan="5"><div class="empty">Watchlist empty — nothing is logged until you add a group name or number.</div></td></tr>'}</tbody>`
}
async function renderWatchlist() {
  fillSessionSelect($('#watchSession'))
  const { watch } = await api('/watch')
  const nameById = Object.fromEntries(state.sessions.map(s => [s.id, s.name]))
  drawWatchTable(watch, nameById, {}) // render now with stored counts
  // Then enrich (best-effort) with live group sizes — also refreshes the stored
  // `groups` table server-side, so the count appears even if it was never synced.
  const sids = [...new Set(watch.filter(w => w.kind === 'group' && w.session_id && w.session_id !== '*').map(w => w.session_id))]
  if (!sids.length) return
  const sizeMap = {}
  await Promise.all(sids.map(async sid => {
    try {
      const r = await api(`/sessions/${sid}/groups/live`)
      if (r && r.ok) { const m = {}; r.groups.forEach(g => { m[normGroup(g.subject)] = g.participants }); sizeMap[sid] = m }
    } catch {}
  }))
  if (state.view === 'watchlist' && Object.keys(sizeMap).length) drawWatchTable(watch, nameById, sizeMap)
}
window.delWatch = async (id) => { await del('/watch/' + id); toast('Removed'); renderWatchlist() }
$('#addWatchBtn').onclick = async () => {
  const sid = $('#watchSession').value, kind = $('#watchKind').value, value = $('#watchValue').value.trim()
  if (!sid || !value) return toast('Enter a value')
  if (kind === 'group') {
    const wr = await api('/watch?sid=' + encodeURIComponent(sid))
    const existing = (wr.ok ? wr.watch : []).filter(w => w.kind === 'group' && w.session_id === sid)
    // Only self-heal when the value is the authoritative one picked from the dropdown.
    if (state.watchPicked === value) {
      const dupes = existing.filter(w => w.value !== value && looseGroup(w.value) === looseGroup(value))
      for (const d of dupes) { try { await del('/watch/' + d.id) } catch {} }
      if (dupes.length) toast(`Corrected ${dupes.length} typed entr${dupes.length > 1 ? 'ies' : 'y'} to the exact group name`)
    }
    if (existing.some(w => w.value === value)) {
      state.watchPicked = null; $('#watchValue').value = ''; renderWatchlist()
      return toast('Already on the watchlist')
    }
  }
  const r = await post('/watch', { sid, kind, value })
  if (r && r.ok === false) return toast(r.error || 'Could not add', 'err')
  state.watchPicked = null; $('#watchValue').value = ''; toast('Added to watchlist'); renderWatchlist()
}
$('#watchValue').oninput = () => { state.watchPicked = null } // manual edit drops the authoritative pick
$('#fetchGroupsBtn').onclick = async () => {
  const sid = $('#watchSession').value
  if (!sid) return toast('Pick a session first')
  const sel = $('#watchGroupSelect'); const btn = $('#fetchGroupsBtn')
  btn.disabled = true; const label = btn.textContent; btn.textContent = '… fetching'
  try {
    const r = await api(`/sessions/${sid}/groups/live`)
    if (!r.ok) return toast(r.error || 'Could not fetch groups', 'err')
    if (!r.groups.length) { sel.innerHTML = '<option value="">No groups found</option>'; return toast('No groups on this session') }
    // Mark which groups are already on the watchlist. Match tolerantly (ignore
    // case/spacing/punctuation) so a hand-typed entry like "D Decor…" still
    // registers against the real "D'Decor…" group instead of misreading ⚠.
    const wr = await api('/watch?sid=' + encodeURIComponent(sid))
    const watchedKeys = new Set((wr.ok ? wr.watch : []).filter(w => w.kind === 'group').map(w => looseGroup(w.value)))
    const rows = r.groups.map(g => ({ ...g, watched: watchedKeys.has(looseGroup(g.subject)) }))
    // Unmonitored groups first (what you act on), then monitored; alphabetical within each.
    rows.sort((a, b) => (a.watched - b.watched) || a.subject.localeCompare(b.subject))
    const pending = rows.filter(g => !g.watched).length
    sel.innerHTML = '<option value="">— choose a group —</option>' +
      rows.map(g => {
        const mark = g.watched ? '✓' : '⚠'
        const tail = g.watched ? '' : ' — not monitored'
        return `<option value="${esc(g.subject)}">${mark} ${esc(g.subject)} (${g.participants})${tail}</option>`
      }).join('')
    toast(pending ? `Loaded ${r.groups.length} group${r.groups.length > 1 ? 's' : ''} · ⚠ ${pending} not monitored` : `Loaded ${r.groups.length} group${r.groups.length > 1 ? 's' : ''} · all monitored`)
  } finally { btn.disabled = false; btn.textContent = label }
}
$('#watchGroupSelect').onchange = (e) => {
  if (!e.target.value) return
  $('#watchKind').value = 'group'; $('#watchValue').value = e.target.value
  state.watchPicked = e.target.value // authoritative name → enables self-heal on Add
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
  const ok = l.status === 'active' || l.status === 'disabled'
  const line = l.expiresAt ? (l.status === 'expired' ? 'Expired on ' : 'Valid till ') + dayKey(l.expiresAt) : (LIC_LABEL[l.status] || l.status)
  $('#licenseStatusCard').innerHTML = `
    <h3>License</h3>
    <div class="lic-valid ${ok ? '' : 'bad'}">${esc(line)}</div>`
  // activation is available to admin + super_admin
  $('#licenseActivateCard').style.display = isAdminish() ? '' : 'none'
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
    case 'opentop': state.pendingOpenChat = { sid: a.sid, jid: a.jid }; go('chats'); break
    case 'dellog': delLog(a.jid); break
    case 'delwatch': delWatch(a.id); break
    case 'delkw': delKeyword(a.id); break
    case 'deluser': delUser(a.id); break
    case 'resetpw': resetPw(a.id, a.name); break
    case 'delgrant': delGrant(a.id); break
    case 'addgroupwatch': addGroupWatch(a.sid, a.jid); break
    case 'dismissgroup': dismissNewGroup(a.sid, a.jid); break
    case 'viewreport': viewReport(a.id); break
    case 'delreport': delReport(a.id); break
    case 'toggleemail': toggleEmail(a.id, Number(a.on)); break
    case 'delemail': delEmail(a.id); break
    case 'sortwatch': {
      const s = state.watchSort
      state.watchSort = (s && s.key === a.key) ? { key: a.key, dir: -s.dir } : { key: a.key, dir: 1 }
      const r = state.watchRender
      if (r) drawWatchTable(r.watch, r.nameById, r.sizeMap)
      break
    }
  }
})
async function dropNewGroup(sid, jid) {
  state.newGroups = state.newGroups.filter(g => !(g.jid === jid && g.sessionId === sid))
  renderNewGroupBanner(); updateNewGroupBadge()
  // Clear it from the server queue so it stays dismissed for every admin.
  try { await del(`/pending-groups?sid=${encodeURIComponent(sid)}&jid=${encodeURIComponent(jid)}`) } catch {}
}
window.dismissNewGroup = (sid, jid) => dropNewGroup(sid, jid)
window.addGroupWatch = async (sid, jid) => {
  const g = state.newGroups.find(x => x.jid === jid && x.sessionId === sid)
  if (!g) return
  const r = await post('/watch', { sid, kind: 'group', value: g.subject })
  if (r && r.ok === false) return toast(r.error || 'Could not add', 'err')
  dropNewGroup(sid, jid); toast(`Added <b>${esc(g.subject)}</b> to watchlist`)
  if (state.view === 'watchlist') renderWatchlist()
}

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
    if (b.dataset.view === 'license') b.style.display = isAdminish() ? '' : 'none' // admin + super only
    if (b.dataset.view === 'emails') b.style.display = isAdminish() ? '' : 'none' // report recipients → admin only
    if (b.dataset.view === 'scheduler') b.style.display = isAdminish() ? '' : 'none' // schedule config → admin only
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
  go(location.hash.slice(1) || 'dashboard')
  // Surface pending new-group alerts from any landing view (admins only).
  loadPendingGroups().then(updateNewGroupBadge)
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
