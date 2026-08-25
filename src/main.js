import { supabase } from './supabaseClient.js'
import { Html5Qrcode } from 'html5-qrcode'

const app = document.getElementById('app')
let activeScanner = null

// Supabase's built-in auth error messages are English by default and
// aren't controlled by the dashboard's language — map the common ones
// here rather than showing English text in an otherwise Russian UI.
// Anything not in this map falls back to the original message rather
// than hiding it, so unexpected errors are still visible while testing.
const AUTH_ERROR_MESSAGES = {
  'Invalid login credentials': 'Неверный никнейм или пароль.',
  'User already registered': 'Пользователь с таким email уже зарегистрирован.',
  'Password should be at least 6 characters': 'Пароль должен содержать не менее 6 символов.',
  'Email not confirmed': 'Email не подтверждён. Проверьте почту и перейдите по ссылке из письма.',
}

function translateError(message) {
  return AUTH_ERROR_MESSAGES[message] || message
}

async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

async function render() {
  const session = await getSession()
  const hash = window.location.hash.replace('#', '') || (session ? 'dashboard' : 'landing')

  if (!session && !['landing', 'login', 'register'].includes(hash)) {
    window.location.hash = 'landing'
    return
  }

  if (hash === 'landing') return renderLanding()
  if (hash === 'login') return renderLogin()
  if (hash === 'register') return renderRegister()
  if (hash === 'dashboard') return renderDashboard(session)
  if (hash === 'scan') return renderScan()
  if (hash === 'leaderboard') return renderLeaderboard()
}

function renderLanding() {
  app.innerHTML = `
    <div class="landing">
      <section class="hero">
        <span class="hero-badge">Без установки приложений — прямо в браузере</span>
        <h1>Трекер станций мероприятия</h1>
        <p class="hero-subtitle">Посетите станции, отсканируйте QR-код на каждой и поднимитесь в таблице лидеров — всё с телефона.</p>
        <div class="hero-actions">
          <button class="btn-primary" onclick="location.hash='register'">Зарегистрироваться</button>
          <button class="btn-secondary" onclick="location.hash='login'">Войти</button>
        </div>
      </section>
      <section class="steps">
        <div class="step">
          <div class="step-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          </div>
          <h3>1. Регистрация</h3>
          <p>Придумайте никнейм и зарегистрируйтесь за минуту — только email и пароль.</p>
        </div>
        <div class="step">
          <div class="step-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          </div>
          <h3>2. Сканирование</h3>
          <p>Находите станции на площадке и сканируйте их QR-коды камерой телефона.</p>
        </div>
        <div class="step">
          <div class="step-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v4a4 4 0 0 1-8 0V4z"/><path d="M8 5H5a3 3 0 0 0 3 5"/><path d="M16 5h3a3 3 0 0 1-3 5"/><path d="M12 13v3"/><path d="M9 20h6"/><path d="M10 17h4v3h-4z"/></svg>
          </div>
          <h3>3. Таблица лидеров</h3>
          <p>Получайте очки за каждую станцию и следите за своим местом в рейтинге.</p>
        </div>
      </section>
    </div>
  `
}

function renderLogin() {
  app.innerHTML = `
    <div class="card">
      <h2>Вход</h2>
      <input id="nickname" placeholder="Никнейм" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <input id="password" type="password" placeholder="Пароль" />
      <button id="loginBtn">Войти</button>
      <p id="authError" class="error"></p>
      <p class="switch-link">Нет аккаунта? <a href="#register">Зарегистрироваться</a></p>
    </div>
  `
  document.getElementById('loginBtn').onclick = async () => {
    const nickname = document.getElementById('nickname').value.trim()
    const password = document.getElementById('password').value
    const errorEl = document.getElementById('authError')

    // Supabase Auth only knows email+password — nickname login means
    // resolving nickname -> email first via get_email_by_nickname (see
    // Part 3), then signing in with the resolved email underneath.
    const { data: email, error: lookupError } = await supabase.rpc('get_email_by_nickname', { p_nickname: nickname })
    if (lookupError || !email) {
      // Deliberately the same generic message as a wrong password below,
      // rather than "nickname not found" — no need to confirm which
      // nicknames exist via the error text on top of what the lookup
      // function itself already reveals.
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
  }
}

function renderRegister() {
  app.innerHTML = `
    <div class="card">
      <h2>Регистрация</h2>
      <input id="nickname" placeholder="Никнейм (для входа)" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <input id="password" type="password" placeholder="Пароль" />
      <input id="labelName" placeholder="Имя для таблицы лидеров" />
      <input id="email" type="email" placeholder="Email" />
      <button id="registerBtn">Зарегистрироваться</button>
      <p id="authError" class="error"></p>
      <p class="switch-link">Уже есть аккаунт? <a href="#login">Войти</a></p>
    </div>
  `
  document.getElementById('registerBtn').onclick = async () => {
    const nickname = document.getElementById('nickname').value.trim()
    const password = document.getElementById('password').value
    const labelName = document.getElementById('labelName').value.trim()
    const email = document.getElementById('email').value.trim()
    const errorEl = document.getElementById('authError')

    if (!nickname || !password || !labelName || !email) {
      errorEl.textContent = 'Заполните все поля.'
      return
    }

    const { error } = await supabase.auth.signUp({
      email, password,
      options: {
        data: { nickname, display_name: labelName },
        // BASE_URL is Vite's built-in env var matching vite.config.js's
        // `base` — this keeps the confirmation link pointed at wherever
        // the app is actually deployed without hardcoding the repo name
        // a second time.
        emailRedirectTo: window.location.origin + import.meta.env.BASE_URL,
      },
    })
    if (error) {
      errorEl.textContent = translateError(error.message)
      return
    }
    app.innerHTML = `
      <div class="card">
        <h2>Проверьте почту</h2>
        <p>Мы отправили письмо на ${email}. Перейдите по ссылке из письма, чтобы подтвердить регистрацию — после этого вы автоматически попадёте на главную страницу со списком станций.</p>
      </div>
    `
  }
}

async function renderDashboard(session) {
  const { data: stations } = await supabase.from('stations').select('*').eq('is_active', true)
  const { data: visits } = await supabase
    .from('station_visits')
    .select('*')
    .eq('participant_id', session.user.id)

  const totalPoints = (visits || []).reduce((sum, v) => sum + v.points_awarded, 0)
  const completedIds = new Set((visits || []).map((v) => v.station_id))

  app.innerHTML = `
    <div class="card">
      <h2>Ваш прогресс</h2>
      <p>Очки: <strong>${totalPoints}</strong> — станций пройдено: ${completedIds.size}/${(stations || []).length}</p>
      <button onclick="location.hash='scan'">Сканировать станцию</button>
      <button onclick="location.hash='leaderboard'">Таблица лидеров</button>
      <button id="logoutBtn">Выйти</button>
      <h3>Станции</h3>
      <ul>
        ${(stations || [])
          .map((s) => `<li>${completedIds.has(s.id) ? '✅' : '⬜️'} ${s.name} — ${s.points} очков</li>`)
          .join('')}
      </ul>
    </div>
  `
  document.getElementById('logoutBtn').onclick = async () => {
    await supabase.auth.signOut()
    window.location.hash = 'landing'
    render()
  }
}

function showModal({ title, message, variant = 'success', onClose }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-box ${variant}">
      <h3>${title}</h3>
      <p>${message}</p>
      <button id="modalCloseBtn">ОК</button>
    </div>
  `
  document.body.appendChild(overlay)
  document.getElementById('modalCloseBtn').onclick = () => {
    overlay.remove()
    if (onClose) onClose()
  }
}

async function stopActiveScanner() {
  if (activeScanner) {
    try { await activeScanner.stop() } catch { /* already stopped */ }
    activeScanner = null
  }
}

function renderScan() {
  app.innerHTML = `
    <div class="card">
      <h2>Сканировать QR-код станции</h2>
      <div id="reader"></div>
      <p class="upload-divider">— или —</p>
      <label for="qrFileInput">Загрузить изображение QR-кода</label>
      <input type="file" id="qrFileInput" accept="image/*" />
      <button id="backBtn">Назад</button>
    </div>
  `

  document.getElementById('backBtn').onclick = async () => {
    await stopActiveScanner()
    window.location.hash = 'dashboard'
  }

  // Html5Qrcode (not Html5QrcodeScanner) is used directly here specifically
  // to skip the built-in camera-picker UI, which lists every camera on the
  // device (front, back, ultrawide, ...) and makes the participant choose.
  // facingMode: 'environment' asks the browser directly for whichever rear
  // camera it has — no dropdown, no choice needed.
  activeScanner = new Html5Qrcode('reader')
  activeScanner
    .start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 250 },
      async (decodedText) => {
        await stopActiveScanner()
        await handleScan(decodedText)
      },
      () => {} // called every frame with no result found yet — intentionally silent
    )
    .catch(() => {
      // Camera unavailable or permission denied — the file upload below
      // still works, so there's no need to surface an error here too.
    })

  document.getElementById('qrFileInput').onchange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    await stopActiveScanner()
    try {
      const fileScanner = new Html5Qrcode('reader')
      const decodedText = await fileScanner.scanFile(file, false)
      await handleScan(decodedText)
    } catch (err) {
      showModal({
        title: 'Не удалось распознать QR-код',
        message: 'Изображение не удалось прочитать как QR-код. Проверьте, что вокруг кода есть белое поле без обрезки, размер не меньше нескольких сотен пикселей, и фон не прозрачный.',
        variant: 'error',
      })
    }
  }
}

async function handleScan(decodedText) {
  let token
  try {
    token = new URL(decodedText).pathname.split('/').filter(Boolean).pop()
  } catch {
    token = decodedText // QR just encodes the raw token — also fine
  }
  const { data, error } = await supabase.rpc('scan_station', { p_token: token })
  if (error) {
    // The image decoded fine, but the token it contained doesn't match any
    // station — a different failure than the file not decoding at all.
    showModal({ title: 'Ошибка сканирования', message: error.message, variant: 'error' })
    return
  }
  const [{ points_awarded, total_points, already_completed }] = data
  if (already_completed) {
    // The database already guaranteed no duplicate row and no double
    // points (see scan_station's unique_violation handling in Part 3) —
    // this pop-up is purely the user-facing confirmation of that.
    showModal({
      title: 'Уже отсканировано',
      message: `Вы уже получили очки за эту станцию. Ваш текущий счёт: ${total_points}.`,
      variant: 'warning',
      onClose: () => { window.location.hash = 'dashboard'; render() },
    })
  } else {
    showModal({
      title: 'Очки начислены!',
      message: `+${points_awarded} очков — ваш счёт теперь ${total_points}.`,
      variant: 'success',
      onClose: () => { window.location.hash = 'dashboard'; render() },
    })
  }
}

async function renderLeaderboard() {
  const { data: leaderboard } = await supabase.rpc('get_leaderboard').limit(20)
  // get_leaderboard is a `stable` function, so PostgREST treats it like a
  // read endpoint and .limit()/.order() chain onto it the same as a table.
  app.innerHTML = `
    <div class="card">
      <h2>Таблица лидеров</h2>
      <ol>
        ${(leaderboard || []).map((row) => `<li>${row.display_name} — ${row.total_points} очков</li>`).join('')}
      </ol>
      <button onclick="location.hash='dashboard'">Назад</button>
    </div>
  `
}

// Registering listens for the email-confirmation redirect to complete its
// (async) PKCE code exchange — onAuthStateChange re-renders once that
// session actually lands, rather than only checking once at page load.
supabase.auth.onAuthStateChange(() => render())
window.addEventListener('hashchange', render)
render()