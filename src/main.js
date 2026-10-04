import '@fontsource/playfair-display/cyrillic-600.css'
import '@fontsource/playfair-display/latin-600.css'
import { supabase } from './supabaseClient.js'
import { Html5Qrcode } from 'html5-qrcode'
import { CONSENT_TEXT } from './consent.js'
import { DIFFUSION_COPY, DIFFUSION_TASK_QUESTIONS, IDEAS_COPY, POLYMER, RESOURCE_NAMES, RESOURCES_COPY, STATION_COPY, STATION_DEFAULT } from './content.js'
// Icons: one set (Phosphor, regular weight), imported file by file so only these end up in the bundle.
import shareNetwork from '@phosphor-icons/core/assets/regular/share-network.svg?raw'
import videoCamera from '@phosphor-icons/core/assets/regular/video-camera.svg?raw'
import wrench from '@phosphor-icons/core/assets/regular/wrench.svg?raw'
import puzzlePiece from '@phosphor-icons/core/assets/regular/puzzle-piece.svg?raw'
import compassTool from '@phosphor-icons/core/assets/regular/compass-tool.svg?raw'
import usersThree from '@phosphor-icons/core/assets/regular/users-three.svg?raw'
import flask from '@phosphor-icons/core/assets/regular/flask.svg?raw'

const app = document.getElementById('app')
let activeScanner = null
let knownConnections = null // diffusion count as last seen, to tell "already connected" from "new"

const BRAND = 'Формула <span>Будущего</span>'
const SCAN_ROUTES = ['#scan', '#diffusion-scan']
const DIFFUSION_GOAL = 3
const IDEA_GOAL = 5 // ideas beyond this are accepted but not scored (get_leaderboard() / get_my_progress())

// Supabase/RPC error strings are English; map the ones users can hit here
// rather than leaking them into the Russian UI. Unmapped messages fall
// through unchanged so unexpected errors stay visible.
const ERROR_MESSAGES = {
  'Invalid login credentials': 'Неверный никнейм или пароль.',
  'User already registered': 'Пользователь с таким email уже зарегистрирован.',
  'Password should be at least 6 characters': 'Пароль должен содержать не менее 6 символов.',
  'Email not confirmed': 'Email не подтверждён. Проверьте почту и перейдите по ссылке из письма.',
  'invalid station token': 'Этот QR-код не относится ни к одной станции. Попробуйте ещё раз.',
  'station is not active': 'Эта станция сейчас неактивна.',
  'event is not active': 'Мероприятие сейчас не проходит.',
  'not authenticated': 'Войдите в аккаунт и повторите попытку.',
  'Unable to validate email address: invalid format': 'Введите корректный адрес электронной почты.',
  'invalid participant token': 'Это не QR-код участника. Попросите собеседника нажать «Показать мой QR».',
  'cannot connect with yourself': 'Нельзя создать связь с самим собой.',
  'participant is from the same city and company': 'Нужен участник из другого города или с другого предприятия.',
}
const translateError = (message) => ERROR_MESSAGES[message] || message

// Participant names and station names are user/organizer-supplied and end up in
// innerHTML (the leaderboard shows them to everyone) — escape them so a name
// like "<img src=x onerror=...>" can't run as a stored XSS.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

// The public name everywhere is "Имя Фамилия". Accounts from before those fields existed fall back to
// their nickname (get_leaderboard() applies the same rule in SQL).
const fullName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.nickname || 'Участник'

const svg = (body, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">${body}</svg>`
const ICON = {
  qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M17 17v4M21 14v3h-4"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>', 2.5),
  mail: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 7 10-7"/>', 1.75),
  pin: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  // modal variants
  success: svg('<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/>'),
  warning: svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/>'),
  error: svg('<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>'),
}

// Station icons are matched by station name; a station the organizers add later falls back to the pin.
const STATION_ICON = {
  'Точка соединения': shareNetwork,
  'Люди формулы будущего': videoCamera,
  'Воркшоп 1': wrench,
  'Воркшоп 2': puzzlePiece,
  'Воркшоп 3': compassTool,
}
const ACTIVITY_ICON = { diffusion: usersThree, ideas: flask }
const glyph = (raw) => raw.replace('<svg ', '<svg aria-hidden="true" ')

// Connected dots in miniature: the same node-and-line language as HERO_NET, used on the «Полимер решений» link.
const POLY_CHAIN = `<svg class="poly-chain" viewBox="0 0 72 24" aria-hidden="true"><path d="M6 17L22 7L40 16L58 6L67 12" fill="none" stroke="currentColor" stroke-width="1.4"/><g fill="currentColor"><circle cx="6" cy="17" r="3"/><circle cx="22" cy="7" r="4"/><circle cx="40" cy="16" r="3.5"/><circle cx="58" cy="6" r="4"/><circle cx="67" cy="12" r="2.5"/></g></svg>`

async function render() {
  // Any re-render (route change, auth event) must release the camera first —
  // browser-back from a scan screen would otherwise leave it running.
  await stopActiveScanner()
  const { data: { session } } = await supabase.auth.getSession()
  const hash = window.location.hash.replace('#', '') || (session ? 'dashboard' : 'landing')

  if (!session && !['landing', 'login', 'register'].includes(hash)) {
    window.location.hash = 'landing'
    return
  }

  if (hash === 'landing') return renderLanding()
  if (hash === 'login') return renderLogin()
  if (hash === 'register') return renderRegister()
  if (hash === 'dashboard') return renderDashboard(session)
  if (hash === 'scan') return renderScanner({ title: 'Сканировать QR маршрута', back: 'dashboard', onDecoded: handleScan })
  if (hash === 'diffusion') return renderDiffusion(session)
  if (hash === 'diffusion-scan') return renderScanner({ title: 'Сканировать QR участника', back: 'diffusion', onDecoded: handleDiffusionScan })
  if (hash === 'ideas') return renderIdeas(session)
  if (hash === 'profile') return renderProfile(session)
  if (hash === 'polymer') return renderPolymer(session)
  if (hash.startsWith('station/')) return renderStation(session, hash.slice('station/'.length))
  window.location.hash = session ? 'dashboard' : 'landing' // unknown hash
}

// Connected dots: the doc describes the main screen as points joining into a molecule / polymer chain.
const HERO_NET = `<svg class="hero-net" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <path d="M30 70L110 120L200 55L290 125L370 75M110 120L150 215L255 195L290 125M150 215L55 260M255 195L345 250M200 55L235 15" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <g fill="currentColor"><circle cx="30" cy="70" r="4"/><circle cx="110" cy="120" r="6"/><circle cx="200" cy="55" r="5"/><circle cx="290" cy="125" r="7"/><circle cx="370" cy="75" r="4"/><circle cx="150" cy="215" r="5"/><circle cx="255" cy="195" r="6"/><circle cx="55" cy="260" r="4"/><circle cx="345" cy="250" r="5"/><circle cx="235" cy="15" r="3"/></g>
</svg>`

function renderLanding() {
  app.innerHTML = `
    <div class="landing">
      <section class="hero">
        ${HERO_NET}
        <h1 class="brand">${BRAND}</h1>
        <p class="hero-subtitle">Знакомьтесь с коллегами, предлагайте идеи и проходите интерактивы — ваш вклад складывается в «Индекс влияния».</p>
        <div class="hero-actions">
          <button class="btn-secondary" onclick="location.hash='login'">Войти</button>
          <button class="btn-primary" onclick="location.hash='register'">Зарегистрироваться</button>
        </div>
      </section>
      <p class="landing-motto brand">Сила — в соединении.</p>
    </div>
  `
}

const authShell = (tab, form) => `
  <div class="auth">
    <div class="auth-intro">
      <span class="brand">${BRAND}</span>
      <p>Сила — в соединении.</p>
    </div>
    <div class="panel">
      <nav class="tabs">
        <a href="#login" class="${tab === 'login' ? 'on' : ''}">Войти</a>
        <a href="#register" class="${tab === 'register' ? 'on' : ''}">Регистрация</a>
      </nav>
      ${form}
    </div>
  </div>
`

// label/id/autocomplete/placeholder tuple -> one labelled input
const field = (id, label, extra = '') =>
  `<div class="field"><label for="${id}">${label}</label><input id="${id}" required ${extra} /></div>`

function renderLogin() {
  app.innerHTML = authShell('login', `
    <form class="form" id="loginForm">
      ${field('nickname', 'Никнейм', 'name="username" autocomplete="username" placeholder="ваш_никнейм" autocapitalize="off" autocorrect="off" spellcheck="false"')}
      ${field('password', 'Пароль', 'name="password" type="password" autocomplete="current-password" enterkeyhint="go" placeholder="••••••••"')}
      <button type="submit" id="loginBtn">Войти</button>
      <p id="authError" class="error"></p>
    </form>
  `)
  const loginBtn = document.getElementById('loginBtn')
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault()
    const nickname = document.getElementById('nickname').value.trim()
    const password = document.getElementById('password').value
    const errorEl = document.getElementById('authError')
    errorEl.textContent = ''
    // Guards against a double-tap firing two overlapping login attempts,
    // which otherwise briefly shows an error even when the second succeeds.
    loginBtn.disabled = true
    loginBtn.textContent = 'Выполняется вход…'

    try {
      // Supabase Auth only knows email+password — nickname login means
      // resolving nickname -> email first via get_email_by_nickname, then
      // signing in with the resolved email underneath.
      const { data: email, error: lookupError } = await supabase.rpc('get_email_by_nickname', { p_nickname: nickname })
      if (lookupError || !email) {
        // Same generic message as a wrong password below, so the error text
        // doesn't confirm which nicknames exist.
        errorEl.textContent = 'Неверный никнейм или пароль.'
        return
      }

      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        errorEl.textContent = translateError(error.message)
        return
      }
      window.location.hash = 'dashboard'
      render()
    } finally {
      loginBtn.disabled = false
      loginBtn.textContent = 'Войти'
    }
  }
}

const MSG_REQUIRED = 'Не все обязательные поля заполнены'
const MSG_CONSENT = 'Не получено соглашение на обработку персональных данных'

function renderRegister() {
  // Required fields get a visible *; the form is novalidate so OUR popups (not browser bubbles) report problems.
  const req = (id, label, extra) => field(id, `${label} <span class="req" aria-hidden="true">*</span>`, extra)
  app.innerHTML = authShell('register', `
    <form class="form" id="registerForm" novalidate>
      ${req('nickname', 'Никнейм (для входа)', 'name="username" autocomplete="username" placeholder="ваш_ник" autocapitalize="off" autocorrect="off" spellcheck="false"')}
      ${req('firstName', 'Имя', 'autocomplete="given-name"')}
      ${req('lastName', 'Фамилия', 'autocomplete="family-name"')}
      ${req('company', 'Предприятие / подразделение', 'autocomplete="organization"')}
      ${req('city', 'Город', 'autocomplete="address-level2"')}
      ${req('email', 'Email', 'name="email" type="email" autocomplete="email" placeholder="вы@email.com"')}
      ${req('password', 'Пароль', 'name="new-password" type="password" autocomplete="new-password" placeholder="••••••••"')}
      <div class="consent">
        <label class="tick-hit"><input type="checkbox" id="consent" aria-label="Я принимаю условия обработки персональных данных" /></label>
        <button type="button" class="link-btn" id="consentLink">Я принимаю условия обработки персональных данных</button>
      </div>
      <button type="submit" id="registerBtn">Присоединиться</button>
      <p id="authError" class="error"></p>
    </form>
  `)
  const form = document.getElementById('registerForm')
  const consent = document.getElementById('consent')
  const registerBtn = document.getElementById('registerBtn')
  const val = (id) => document.getElementById(id).value.trim()
  const textInputs = [...form.querySelectorAll('input[required]:not([type="checkbox"])')]
  textInputs.forEach((i) => i.addEventListener('input', () => i.removeAttribute('aria-invalid')))
  document.getElementById('consentLink').onclick = (e) => openConsentModal(consent, e.currentTarget)

  form.onsubmit = async (e) => {
    e.preventDefault()
    // «Присоединиться» is never disabled; it validates in this order and stops at the first failure.
    const empty = textInputs.filter((i) => !i.value.trim())
    if (empty.length) {
      empty.forEach((i) => i.setAttribute('aria-invalid', 'true'))
      showModal({ message: MSG_REQUIRED, variant: 'warning', onOk: () => empty[0].focus() })
      return
    }
    if (!consent.checked) {
      showModal({ message: MSG_CONSENT, variant: 'warning', onOk: () => consent.focus() })
      return
    }

    const errorEl = document.getElementById('authError')
    errorEl.textContent = ''
    registerBtn.disabled = true
    registerBtn.textContent = 'Регистрация…'
    try {
      const email = val('email')
      const { error } = await supabase.auth.signUp({
        email,
        password: document.getElementById('password').value,
        options: {
          // handle_new_user() copies these into profiles; consent=true makes it stamp profiles.consented_at (server time).
          data: {
            nickname: val('nickname'),
            first_name: val('firstName'),
            last_name: val('lastName'),
            company: val('company'),
            city: val('city'),
            consent: true,
          },
          // BASE_URL is Vite's built-in env var matching vite.config.js's
          // `base` — keeps the confirmation link pointed at wherever the app
          // is deployed without hardcoding the repo name a second time.
          emailRedirectTo: window.location.origin + import.meta.env.BASE_URL,
        },
      })
      if (error) {
        errorEl.textContent = translateError(error.message)
        return
      }
      renderEmailSent(email)
    } finally {
      registerBtn.disabled = false
      registerBtn.textContent = 'Присоединиться'
    }
  }
}

// Dialog shell shared by the consent text and the discussion questions: × in the top-right corner, a scrolling body,
// Escape or × closes it, the page behind is locked and inert, and focus returns to the element that opened it.
// (The consent* ids and classes are kept for both dialogs: only one is ever open.)
function openSheet(opener, { labelId, foot = '' }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-box consent-box" role="dialog" aria-modal="true" aria-labelledby="${labelId}">
      <div class="consent-head">
        <button type="button" id="consentClose" class="icon-btn" aria-label="Закрыть">${ICON.close}</button>
      </div>
      <div class="consent-scroll" tabindex="0"></div>
      ${foot}
    </div>
  `
  const scroller = overlay.querySelector('.consent-scroll')
  const prevOverflow = document.body.style.overflow
  const close = () => {
    overlay.remove()
    document.body.style.overflow = prevOverflow
    document.removeEventListener('keydown', onKey)
    app.inert = false
    opener.focus()
  }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.querySelector('#consentClose').onclick = close

  document.querySelector('.modal-overlay')?.remove()
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden' // the page behind must not scroll
  app.inert = true // keeps Tab and screen readers inside the dialog
  scroller.focus({ preventScroll: true })
  return { overlay, scroller, close }
}

// Consent text in a scroll-gated dialog. "Согласен" stays disabled until the text has been scrolled to the end,
// then ticks the checkbox. The text is static and goes in via textContent only (never innerHTML).
function openConsentModal(checkbox, opener) {
  const { overlay, scroller, close } = openSheet(opener, {
    labelId: 'consentTitle',
    foot: `<div class="consent-foot">
        <p class="consent-hint" id="consentHint">Прокрутите текст до конца, чтобы согласиться.</p>
        <button type="button" id="consentAgree" disabled>Согласен</button>
      </div>`,
  })
  CONSENT_TEXT.trim().split(/\n\s*\n/).forEach((block, i) => {
    const p = document.createElement('p')
    p.textContent = block.replace(/\s*\n\s*/g, ' ') // hard-wrapped source lines become one paragraph
    if (i === 0) { p.id = 'consentTitle'; p.className = 'consent-title' }
    scroller.appendChild(p)
  })

  const agree = overlay.querySelector('#consentAgree')
  const hint = overlay.querySelector('#consentHint')
  const sync = () => {
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) { // reached the end
      agree.disabled = false
      hint.hidden = true
    }
  }
  scroller.addEventListener('scroll', sync)
  agree.onclick = () => { checkbox.checked = true; close() }
  sync() // a short text that needs no scrolling can be agreed to at once
}

// The three discussion questions of one Диффузия task (see content.js: nine questions, three per task, none repeated).
function openQuestions(i, opener) {
  const { scroller } = openSheet(opener, { labelId: 'questionsTitle' })
  scroller.innerHTML = `
    <h3 id="questionsTitle" class="brand">${escapeHtml(DIFFUSION_TASKS[i])}</h3>
    <p class="eyebrow">Вопросы для обсуждения</p>
    <ul class="questions">${DIFFUSION_TASK_QUESTIONS[i].map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>
  `
}

function renderEmailSent(email) {
  app.innerHTML = `
    <div class="sent">
      <div class="round">${ICON.mail}</div>
      <h2 class="brand">Проверьте почту</h2>
      <p>Мы отправили ссылку для подтверждения на</p>
      <p class="addr">${escapeHtml(email)}</p>
      <p>Перейдите по ссылке в письме, чтобы завершить регистрацию — после этого вы автоматически попадёте в приложение.</p>
      <button class="btn-ghost" onclick="location.hash='login'">Вернуться ко входу</button>
    </div>
  `
}

const pageHead = (title, back) => `
  <header class="topbar"><div class="topbar-in">
    <button class="icon-btn" onclick="location.hash='${back}'" aria-label="Назад">${ICON.back}</button>
    <h2>${title}</h2>
  </div></header>
`

function renderLoadError() {
  app.innerHTML = `
    <div class="sent">
      <h2 class="brand">Не удалось загрузить данные</h2>
      <p class="error">Попробуйте обновить страницу.</p>
      <button class="btn-ghost" onclick="location.hash='dashboard'">На главную</button>
    </div>
  `
}

// One card of the activities list. The whole card is a link to that activity's own page: this list is the only way in.
// Stations show their points, Диффузия and Колба идей show their own progress.
const activityCard = ({ icon, name, right, done, doneLabel, href, kind = '' }) =>
  `<li class="station${done ? ' done' : ''}"${kind ? ` data-activity="${kind}"` : ''}>
    <a class="station-link" href="${href}">
      <div class="ico">${icon}</div>
      <div class="name">${escapeHtml(name)}${done ? `<small>${doneLabel}</small>` : ''}</div>
      <span class="pts">${right}</span>
    </a>
  </li>`

// The progress stat shared by Диффузия, Колба идей and the station page: a label, a big value and, optionally,
// something on the right (a chain of nodes filled per step done, or a badge).
const statCard = (label, value, side = '') =>
  `<section class="box stat"><div><p class="stat-label">${label}</p><p class="stat-value">${value}</p></div>${side}</section>`
const miniChain = (n, goal) =>
  `<div class="mini-chain" aria-hidden="true">${Array.from({ length: goal }, (_, i) => `<i class="node${i < n ? ' on' : ''}"></i>`).join('<b class="link"></b>')}</div>`

async function renderDashboard(session) {
  const uid = session.user.id
  const [profile, stations, visits, progress, board] = await Promise.all([
    supabase.from('profiles').select('first_name, last_name, nickname').eq('id', uid).single(),
    // Columns listed explicitly: qr_token has no business reaching the UI.
    supabase.from('stations').select('id, name, points, display_group').eq('is_active', true).order('created_at'),
    supabase.from('station_visits').select('station_id').eq('participant_id', uid),
    supabase.rpc('get_my_progress').single(),
    // get_leaderboard is `stable`, so PostgREST lets .limit() chain onto it like a table.
    supabase.rpc('get_leaderboard').limit(15),
  ])

  // The leaderboard failing is non-fatal: the section shows its own message.
  if (profile.error || stations.error || visits.error || progress.error) {
    app.innerHTML = `
      <div class="sent">
        <h2 class="brand">Не удалось загрузить данные</h2>
        <p class="error">Попробуйте обновить страницу.</p>
        <button id="logoutBtn" class="btn-ghost">Выйти</button>
      </div>
    `
    document.getElementById('logoutBtn').onclick = logout
    return
  }

  const name = fullName(profile.data)
  const visited = new Set(visits.data.map((v) => v.station_id))
  const { total_points, ideas_count, connections_count } = progress.data
  knownConnections = connections_count
  // Both counters stop at their goal: ideas beyond 5 are accepted but neither scored nor counted (see get_leaderboard()).
  const ideas = Math.min(ideas_count, IDEA_GOAL)
  const links = Math.min(connections_count, DIFFUSION_GOAL)

  // Stations sharing a display_group render as one card; done if any of them was scanned.
  const cards = new Map()
  for (const s of stations.data) {
    const key = s.display_group || s.id
    const card = cards.get(key) || { id: s.id, name: s.name, group: s.display_group, points: [], done: false }
    card.points.push(s.points)
    card.done ||= visited.has(s.id)
    cards.set(key, card)
  }
  const list = [...cards.values()]

  // Activities = station cards + Диффузия (3 of 3) + Колба идей (5 of 5).
  const doneActs = list.filter((c) => c.done).length + (links >= DIFFUSION_GOAL) + (ideas >= IDEA_GOAL)
  const totalActs = list.length + 2
  const pct = Math.round((doneActs / totalActs) * 100)
  const step = Math.min(4, Math.floor(pct / 20)) // a new colour every 20%, soft yellow (0) to soft green (4)

  // Every card links to its own page. The Полимер card (its tiers share a display_group) opens the game page,
  // every other station opens its station page; its icon is the molecule chain that is also the game's visual mark.
  const stationCard = (c) => {
    const max = Math.max(...c.points)
    const polymer = c.group === 'polymer_solutions'
    return activityCard({
      icon: polymer ? POLY_CHAIN : STATION_ICON[c.name] ? glyph(STATION_ICON[c.name]) : ICON.pin, name: c.name, done: c.done, doneLabel: 'Посещено',
      right: Math.min(...c.points) === max ? `+${max}` : `до +${max}`,
      href: polymer ? '#polymer' : `#station/${c.id}`,
    })
  }
  const infoCards = [
    { icon: ACTIVITY_ICON.diffusion, name: 'Диффузия', n: links, goal: DIFFUSION_GOAL, kind: 'diffusion', href: '#diffusion' },
    { icon: ACTIVITY_ICON.ideas, name: 'Колба идей', n: ideas, goal: IDEA_GOAL, kind: 'ideas', href: '#ideas' },
  ].map((a) => activityCard({ icon: glyph(a.icon), name: a.name, kind: a.kind, href: a.href, done: a.n >= a.goal, doneLabel: 'Пройдено', right: `${a.n} из ${a.goal}` })).join('')
  // Order: Точка соединения, then Диффузия and Колба идей, then the other stations as the database lists them.
  const isStart = (c) => c.name === 'Точка соединения'
  const stationHtml = list.filter(isStart).map(stationCard).join('') + infoCards + list.filter((c) => !isStart(c)).map(stationCard).join('')

  const rows = board.error ? [] : board.data
  const maxPts = rows[0]?.total_points || 1
  const medals = ['🥇', '🥈', '🥉']
  const rowHtml = rows.map((r, i) => {
    const me = r.participant_id === uid
    return `<li class="row${me ? ' me' : i < 3 ? ' top' : ''}">
      <span class="rk${medals[i] ? ' medal' : ''}">${medals[i] || i + 1}</span>
      <div class="who2">
        <span class="nm">${escapeHtml(r.full_name)}${me ? ' (вы)' : ''}</span>
        <div class="bar"><i style="width:${Math.round((r.total_points / maxPts) * 100)}%"></i></div>
      </div>
      <span class="sc">${r.total_points}<small>оч</small></span>
    </li>`
  }).join('')
  // Outside the top 15 the user still sees their own score.
  const meOutside = !board.error && total_points > 0 && !rows.some((r) => r.participant_id === uid)
    ? `<li class="row me gap"><span class="rk">…</span>
        <div class="who2"><span class="nm">${escapeHtml(name)} (вы)</span></div>
        <span class="sc">${total_points}<small>оч</small></span></li>`
    : ''

  app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      <span class="brand">${BRAND}</span>
      <div class="who">
        <a class="btn-ghost" href="#profile">Профиль</a>
        <button id="logoutBtn" class="btn-ghost">Выйти</button>
      </div>
    </div></header>
    <main class="page">
      <section class="box score">
        <p class="eyebrow">Ваш текущий прогресс,</p>
        <h2 class="brand">${escapeHtml(name)}:</h2>
        <p class="eyebrow idx">Индекс влияния</p>
        <div class="score-row">
          <strong>${total_points}</strong>
          <span class="pct step-${step}">${pct}%</span>
        </div>
        <div class="bar steps"><i style="clip-path:inset(0 ${100 - Math.max(pct, doneActs > 0 ? 1 : 0)}% 0 0)"></i></div>
        <span class="acts">Пройдено активностей: ${doneActs} из ${totalActs}</span>
      </section>
      <button class="btn-cta" onclick="location.hash='scan'">${ICON.qr}Сканировать QR‑код</button>
      <section>
        <div class="sec-head"><h3>Активности</h3></div>
        <ul class="stations">${stationHtml}</ul>
      </section>
      <section>
        <div class="sec-head"><h3>Рейтинг участников</h3><span>Топ 15</span></div>
        ${board.error
          ? '<p class="error">Не удалось загрузить рейтинг участников. Попробуйте обновить страницу.</p>'
          : `<ul class="box board">${rowHtml}${meOutside}</ul>`}
      </section>
    </main>
  `
  document.getElementById('logoutBtn').onclick = logout
}

// ---- Профиль ----

// The email comes from the signed-in session (it is not stored in profiles); the participant id is profiles.id as-is.
async function renderProfile(session) {
  const { data, error } = await supabase.from('profiles').select('id, first_name, last_name, company, city').eq('id', session.user.id).single()
  if (error) return renderLoadError()
  const rows = [
    ['ID участника', data.id, 'mono'], ['Имя', data.first_name], ['Фамилия', data.last_name],
    ['Предприятие / подразделение', data.company], ['Город', data.city], ['Email', session.user.email],
  ]
  app.innerHTML = `
    ${pageHead('Профиль', 'dashboard')}
    <main class="page">
      <dl class="box profile">
        ${rows.map(([k, v, cls = '']) => `<div><dt>${k}</dt><dd class="${cls}">${v ? escapeHtml(v) : '—'}</dd></div>`).join('')}
      </dl>
    </main>
  `
}

// ---- Полимер решений: описание игры (тексты из документа, см. content.js) ----

async function renderPolymer(session) {
  const p = POLYMER
  const bare = (s) => escapeHtml(s.replace(/[;.]$/, ''))
  // The participant's own resources (random 0..5 each, assigned at registration by migration 5). If that migration is
  // not applied yet the query fails and the page simply shows the game info without this block.
  const mine = await supabase.from('profiles').select('resource_1, resource_2, resource_3, resource_4').eq('id', session.user.id).single()
  const resources = mine.error ? '' : `
      <section class="box pad">
        <h3>${escapeHtml(RESOURCES_COPY.title)}</h3>
        <ul class="resources">${RESOURCE_NAMES.map((name, i) => `<li><strong>${Number(mine.data[`resource_${i + 1}`])}</strong><span>${escapeHtml(name)}</span></li>`).join('')}</ul>
        <p class="note">${escapeHtml(RESOURCES_COPY.note)}</p>
      </section>`
  app.innerHTML = `
    ${pageHead('Полимер решений', 'dashboard')}
    <main class="page">
      <section class="poly-hero">${HERO_NET}<h3 class="brand">${escapeHtml(p.lead)}</h3></section>
      <p class="note poly-intro">${escapeHtml(p.intro)}</p>${resources}
      <section>
        <div class="sec-head"><h3>${escapeHtml(p.stepsTitle)}</h3></div>
        <ol class="chain">
          ${p.steps.map(([title, time, text]) => `<li><strong>${escapeHtml(title)}</strong><span class="time">${escapeHtml(time)}</span><p>${escapeHtml(text)}</p></li>`).join('')}
        </ol>
      </section>
      <section class="box pad">
        <h3>${escapeHtml(p.seeTitle)}</h3>
        ${p.see.map((t) => `<p class="note">${escapeHtml(t)}</p>`).join('')}
        <p class="note">${escapeHtml(p.metricsLead)}</p>
        <ul class="nodes">${p.metrics.map((m) => `<li>${bare(m)}</li>`).join('')}</ul>
        <p class="note poly-winner">${escapeHtml(p.winner)}</p>
      </section>
      <section class="poly-flow">
        <p class="eyebrow">${escapeHtml(p.flowLead)}</p>
        <p>${escapeHtml(p.flow)}</p>
      </section>
      <button class="btn-cta" onclick="location.hash='scan'">${ICON.qr}Сканировать QR-код</button>
    </main>
  `
}

// ---- Станции: страница обычной станции (баллы за сканирование QR) ----

// #station/<id>. The id comes from the URL, so it is checked before it reaches a query; an unknown, inactive or
// malformed id just goes back to the list. Only non-secret columns are read (never qr_token).
async function renderStation(session, id) {
  if (!/^[\w-]{1,64}$/.test(id)) { window.location.hash = 'dashboard'; return } // letters, digits, - and _ only (ids are UUIDs)
  const [station, visit] = await Promise.all([
    supabase.from('stations').select('id, name, points').eq('id', id).eq('is_active', true).maybeSingle(),
    supabase.from('station_visits').select('station_id').eq('participant_id', session.user.id).eq('station_id', id).maybeSingle(),
  ])
  if (station.error || visit.error) return renderLoadError()
  if (!station.data) { window.location.hash = 'dashboard'; return }
  const s = station.data
  const copy = STATION_COPY[s.name] ?? STATION_DEFAULT
  app.innerHTML = `
    ${pageHead(escapeHtml(s.name), 'dashboard')}
    <main class="page">
      ${statCard('Баллы за станцию', `+${Number(s.points)}`, visit.data ? '<span class="badge">Посещено</span>' : '')}
      <section class="box pad desc">
        <h3 class="brand">${escapeHtml(copy.headline)}</h3>
        ${copy.paragraphs.map((t) => `<p class="note">${escapeHtml(t)}</p>`).join('')}
      </section>
      <button class="btn-cta" onclick="location.hash='scan'">${ICON.qr}Сканировать QR-код</button>
    </main>
  `
}

async function logout() {
  await supabase.auth.signOut()
  window.location.hash = 'landing'
  render()
}

// ---- Диффузия ----

const DIFFUSION_TASKS = [
  'Найдите участника из другого города',
  'Найдите человека из другого функционального направления',
  'Найдите участника, с которым у вас нет общих рабочих задач',
]

async function renderDiffusion(session) {
  const [progress, profile] = await Promise.all([
    supabase.rpc('get_my_progress').single(),
    supabase.from('profiles').select('personal_qr_token').eq('id', session.user.id).single(),
  ])
  if (progress.error || profile.error) return renderLoadError()

  const count = Math.min(progress.data.connections_count, DIFFUSION_GOAL)
  knownConnections = progress.data.connections_count
  const complete = count >= DIFFUSION_GOAL

  // The count first, then what the activity is, then the three prompts. Nodes are filled per connection made.
  app.innerHTML = `
    ${pageHead('Диффузия', 'dashboard')}
    <main class="page">
      ${statCard('Связей', `${count} из ${DIFFUSION_GOAL}`, miniChain(count, DIFFUSION_GOAL))}
      <section class="box pad desc">
        <h3 class="brand">${escapeHtml(DIFFUSION_COPY.headline)}</h3>
        ${DIFFUSION_COPY.paragraphs.map((p) => `<p class="note">${escapeHtml(p)}</p>`).join('')}
      </section>
      <section>
        <div class="sec-head"><h3>${escapeHtml(DIFFUSION_COPY.tasksTitle)}</h3></div>
        <ul class="box tasks">
          ${DIFFUSION_TASKS.map((t, i) => `<li class="task${i < count ? ' done' : ''}"><button type="button" class="q" data-i="${i}" aria-haspopup="dialog"><span>${t}</span><span class="tick" aria-hidden="true">${i < count ? ICON.check : ''}</span></button>${i < count ? '<span class="sr-only">Готово</span>' : ''}</li>`).join('')}
        </ul>
      </section>
      ${complete
        ? '<p class="note center ok">Диффузия завершена. Вы создали 3 новых профессиональных связи.</p>'
        : `<button class="btn-cta" onclick="location.hash='diffusion-scan'">${ICON.qr}Сканировать QR участника</button>`}
      <button id="showQrBtn" class="btn-soft">Показать мой QR</button>
      <div id="qrBox"></div>
    </main>
  `

  document.querySelectorAll('.task .q').forEach((b) => { b.onclick = () => openQuestions(Number(b.dataset.i), b) })

  const qrBox = document.getElementById('qrBox')
  document.getElementById('showQrBtn').onclick = async () => {
    if (qrBox.firstChild) { qrBox.innerHTML = ''; return } // second tap hides it
    try {
      // Loaded on demand: the QR generator isn't needed anywhere else.
      const { default: QRCode } = await import('qrcode')
      const src = await QRCode.toDataURL(profile.data.personal_qr_token, { width: 280, margin: 2 })
      qrBox.innerHTML = `<div class="box pad center"><img class="myqr" alt="Мой QR-код" src="${src}" /><p class="note">Покажите этот код участнику, с которым познакомились.</p></div>`
    } catch {
      qrBox.innerHTML = '<p class="error center">Не удалось создать QR-код. Попробуйте ещё раз.</p>'
    }
  }
}

async function handleDiffusionScan(decodedText) {
  knownConnections ??= (await supabase.rpc('get_my_progress').single()).data?.connections_count ?? 0
  const { data: count, error } = await supabase.rpc('confirm_diffusion_connection', { p_token: tokenFrom(decodedText) })
  if (error) {
    showModal({ title: 'Не удалось создать связь', message: translateError(error.message), variant: 'error', autoCloseMs: 3000, onClose: retryScan })
    return
  }
  const before = knownConnections
  knownConnections = count
  const toDiffusion = () => { window.location.hash = 'diffusion'; render() }
  if (count >= DIFFUSION_GOAL) {
    showModal({ message: 'Диффузия завершена. Вы создали 3 новых профессиональных связи.', autoCloseMs: 3000, onClose: toDiffusion })
  } else if (count === before) {
    showModal({ title: 'Уже создано', message: 'Связь с этим участником уже создана.', variant: 'warning', autoCloseMs: 3000, onClose: toDiffusion })
  } else {
    showModal({ title: 'Новое соединение создано', message: `Связей: ${count} из ${DIFFUSION_GOAL}.`, autoCloseMs: 3000, onClose: toDiffusion })
  }
}

// ---- Колба идей ----

// The count first (the same stat as Диффузия), then what it is, then the form to add an idea, all on this page.
async function renderIdeas(session) {
  const progress = await supabase.rpc('get_my_progress').single()
  if (progress.error) return renderLoadError()
  const n = Math.min(progress.data.ideas_count, IDEA_GOAL)
  app.innerHTML = `
    ${pageHead('Колба идей', 'dashboard')}
    <main class="page">
      ${statCard('Идей', `${n} из ${IDEA_GOAL}`, miniChain(n, IDEA_GOAL))}
      <section class="box pad desc">
        <h3 class="brand">${escapeHtml(IDEAS_COPY.headline)}</h3>
        ${IDEAS_COPY.paragraphs.map((p) => `<p class="note">${escapeHtml(p)}</p>`).join('')}
      </section>
      ${IDEA_FORM}
    </main>
  `
  wireIdeaForm(session)
}

const IDEA_FIELDS = [
  ['title', 'Название идеи', 'input'],
  ['direction', 'Направление идеи', 'input'],
  ['problem', 'Какую проблему или задачу она решает', 'textarea'],
  ['description', 'Описание', 'textarea'],
  ['expected_result', 'Ожидаемый результат или эффект от внедрения', 'textarea'],
]

const IDEA_FORM = `
  <form class="box form" id="ideaForm">
    ${IDEA_FIELDS.map(([id, label, tag]) => `<div class="field"><label for="${id}">${label}</label>${
      tag === 'input' ? `<input id="${id}" />` : `<textarea id="${id}" rows="4"></textarea>`}</div>`).join('')}
    <button type="submit" id="ideaBtn" disabled>Отправить идею</button>
    <p id="ideaError" class="error"></p>
  </form>`

function wireIdeaForm(session) {
  const form = document.getElementById('ideaForm')
  const btn = document.getElementById('ideaBtn')
  const values = () => Object.fromEntries(IDEA_FIELDS.map(([id]) => [id, document.getElementById(id).value.trim()]))
  const allFilled = () => Object.values(values()).every(Boolean)
  form.oninput = () => { btn.disabled = !allFilled() }
  form.onsubmit = async (e) => {
    e.preventDefault()
    if (!allFilled()) return
    const errorEl = document.getElementById('ideaError')
    errorEl.textContent = ''
    btn.disabled = true
    const { error } = await supabase.from('ideas').insert({ author_id: session.user.id, ...values() })
    if (error) {
      errorEl.textContent = 'Не удалось отправить идею. Попробуйте ещё раз.'
      btn.disabled = false
      return
    }
    form.reset() // button stays disabled (fields empty) so the idea can't be sent twice
    showModal({
      message: 'Идея принята и добавлена в Банк идей.',
      autoCloseMs: 3000,
      onClose: () => { window.location.hash = 'dashboard'; render() },
    })
  }
}

// ---- shared popup + scanner ----

function showModal({ title, message, variant = 'success', autoCloseMs, onClose, onOk }) {
  document.querySelector('.modal-overlay')?.remove() // one popup at a time, the newest wins
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-box ${variant}" role="dialog" aria-modal="true">
      <div class="modal-bar"></div>
      <div class="modal-body">
        <div class="round">${ICON[variant]}</div>
        ${title ? `<h3 class="brand">${title}</h3>` : ''}
        <p>${message}</p>
        <button id="modalCloseBtn">ОК</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  // Manual OK just hides the popup and leaves the user exactly where they
  // are — it does not run onClose. onClose (the redirect or camera reopen)
  // only fires from the autoCloseMs timer below, whether or not the user
  // dismissed the popup early. onOk is for callers that want a follow-up on
  // dismissal (e.g. focusing the field a validation popup complained about).
  const ok = document.getElementById('modalCloseBtn')
  ok.onclick = () => { overlay.remove(); if (onOk) onOk() }
  ok.focus({ preventScroll: true }) // Enter / Space dismisses at once
  if (autoCloseMs) {
    setTimeout(() => {
      overlay.remove()
      if (onClose) onClose()
    }, autoCloseMs)
  }
}

async function stopActiveScanner() {
  if (activeScanner) {
    const scanner = activeScanner
    activeScanner = null
    try { await scanner.stop() } catch { /* already stopped */ }
  }
}

// Reopens the camera after a failed scan — but only if the user is still on
// a scan screen (they may have pressed Назад during the 3s popup).
const retryScan = () => { if (SCAN_ROUTES.includes(window.location.hash)) render() }

// QR may encode a URL ending in the token, or just the raw token.
function tokenFrom(decodedText) {
  try {
    return new URL(decodedText).pathname.split('/').filter(Boolean).pop()
  } catch {
    return decodedText
  }
}

function renderScanner({ title, back, onDecoded }) {
  app.innerHTML = `
    ${pageHead(title, back)}
    <main class="page scan-page">
      <div class="viewfinder">
        <div id="reader"></div>
        <i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>
      </div>
      <p class="hint"><strong>Наведите камеру на QR‑код</strong><br />Держите устройство неподвижно</p>
    </main>
  `

  // Html5Qrcode (not Html5QrcodeScanner) is used directly to skip the
  // built-in camera-picker UI, which lists every camera on the device.
  // facingMode: 'environment' asks the browser for the rear camera directly.
  activeScanner = new Html5Qrcode('reader')
  activeScanner
    .start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 250 },
      async (decodedText) => {
        await stopActiveScanner()
        await onDecoded(decodedText)
      },
      () => {} // called every frame with no result found yet — intentionally silent
    )
    .catch(() => {
      showModal({
        title: 'Камера недоступна',
        message: 'Не удалось получить доступ к камере. Проверьте разрешения браузера и повторите попытку.',
        variant: 'error',
        autoCloseMs: 3000,
        onClose: retryScan,
      })
    })
}

async function handleScan(decodedText) {
  const token = tokenFrom(decodedText)
  // The station lookup (for its custom success message) doesn't depend on the
  // scan result, so it runs alongside it instead of adding a round trip.
  const [scan, station] = await Promise.all([
    supabase.rpc('scan_station', { p_token: token }),
    supabase.from('stations').select('success_message').eq('qr_token', token).maybeSingle(),
  ])
  if (scan.error) {
    // Decoded fine, but the backend rejected it (invalid token, inactive
    // station/event, ...) — stay on this screen and let them try again.
    showModal({
      title: 'Ошибка сканирования',
      message: translateError(scan.error.message),
      variant: 'error',
      autoCloseMs: 3000,
      onClose: retryScan,
    })
    return
  }
  const [{ points_awarded, total_points, already_completed }] = scan.data
  const toDashboard = () => { window.location.hash = 'dashboard'; render() }
  if (already_completed) {
    // The database already guaranteed no duplicate row and no double
    // points (scan_station's unique_violation handling) — this pop-up is
    // purely the user-facing confirmation of that.
    showModal({
      title: 'Уже отсканировано',
      message: `Вы уже получили очки за эту станцию. Ваш текущий счёт: ${total_points}.`,
      variant: 'warning',
      autoCloseMs: 3000,
      onClose: toDashboard,
    })
  } else {
    showModal({
      title: 'Очки начислены!',
      message: station.data?.success_message
        ? escapeHtml(station.data.success_message)
        : `+${points_awarded} очков — ваш счёт теперь ${total_points}.`,
      variant: 'success',
      autoCloseMs: 3000,
      onClose: toDashboard,
    })
  }
}

// Registering listens for the email-confirmation redirect to complete its
// (async) PKCE code exchange — onAuthStateChange re-renders once that
// session actually lands, rather than only checking once at page load.
supabase.auth.onAuthStateChange(() => render())
window.addEventListener('hashchange', render)
render()
