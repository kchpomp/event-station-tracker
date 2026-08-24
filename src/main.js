import { supabase } from './supabaseClient.js'
import { Html5QrcodeScanner } from 'html5-qrcode'

const app = document.getElementById('app')

async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

async function render() {
  const session = await getSession()
  const hash = window.location.hash.replace('#', '') || (session ? 'dashboard' : 'landing')

  if (!session && hash !== 'landing' && hash !== 'auth') {
    window.location.hash = 'landing'
    return
  }

  if (hash === 'landing') return renderLanding()
  if (hash === 'auth') return renderAuth()
  if (hash === 'dashboard') return renderDashboard(session)
  if (hash === 'scan') return renderScan()
  if (hash === 'leaderboard') return renderLeaderboard()
}

function renderLanding() {
  app.innerHTML = `
    <div class="card">
      <h1>Event Station Tracker</h1>
      <p>Visit every station, scan the QR code, climb the leaderboard.</p>
      <button onclick="location.hash='auth'">Get started</button>
    </div>
  `
}

function renderAuth() {
  app.innerHTML = `
    <div class="card">
      <h2>Log in or register</h2>
      <input id="email" placeholder="Email" />
      <input id="password" type="password" placeholder="Password" />
      <input id="displayName" placeholder="Display name (for registration)" />
      <button id="loginBtn">Log in</button>
      <button id="registerBtn">Register</button>
      <p id="authError" class="error"></p>
    </div>
  `
  document.getElementById('loginBtn').onclick = async () => {
    const email = document.getElementById('email').value
    const password = document.getElementById('password').value
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return (document.getElementById('authError').textContent = error.message)
    window.location.hash = 'dashboard'
    render()
  }
  document.getElementById('registerBtn').onclick = async () => {
    const email = document.getElementById('email').value
    const password = document.getElementById('password').value
    const displayName = document.getElementById('displayName').value
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { display_name: displayName } },
    })
    if (error) return (document.getElementById('authError').textContent = error.message)
    window.location.hash = 'dashboard'
    render()
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
      <h2>Your progress</h2>
      <p>Score: <strong>${totalPoints}</strong> — ${completedIds.size}/${(stations || []).length} stations</p>
      <button onclick="location.hash='scan'">Scan a station</button>
      <button onclick="location.hash='leaderboard'">Leaderboard</button>
      <button id="logoutBtn">Log out</button>
      <h3>Stations</h3>
      <ul>
        ${(stations || [])
          .map((s) => `<li>${completedIds.has(s.id) ? '✅' : '⬜️'} ${s.name} — ${s.points} pts</li>`)
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
      <button id="modalCloseBtn">OK</button>
    </div>
  `
  document.body.appendChild(overlay)
  document.getElementById('modalCloseBtn').onclick = () => {
    overlay.remove()
    if (onClose) onClose()
  }
}

function renderScan() {
  app.innerHTML = `
    <div class="card">
      <h2>Scan a station QR code</h2>
      <div id="reader"></div>
      <button onclick="location.hash='dashboard'">Back</button>
    </div>
  `
  const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: 250 })
  scanner.render(async (decodedText) => {
    scanner.clear()
    let token
    try {
      token = new URL(decodedText).pathname.split('/').filter(Boolean).pop()
    } catch {
      token = decodedText // QR just encodes the raw token — also fine
    }
    const { data, error } = await supabase.rpc('scan_station', { p_token: token })
    if (error) {
      showModal({ title: 'Scan failed', message: error.message, variant: 'error' })
      return
    }
    const [{ points_awarded, total_points, already_completed }] = data
    if (already_completed) {
      // The database already guaranteed no duplicate row and no double
      // points (see scan_station's unique_violation handling in Part 3) —
      // this pop-up is purely the user-facing confirmation of that.
      showModal({
        title: 'Already scanned',
        message: `You've already collected points from this station. Your total is still ${total_points}.`,
        variant: 'warning',
        onClose: () => { window.location.hash = 'dashboard'; render() },
      })
    } else {
      showModal({
        title: 'Points earned!',
        message: `+${points_awarded} points — your total is now ${total_points}.`,
        variant: 'success',
        onClose: () => { window.location.hash = 'dashboard'; render() },
      })
    }
  })
}

async function renderLeaderboard() {
  const { data: leaderboard } = await supabase.rpc('get_leaderboard').limit(20)
  // get_leaderboard is a `stable` function, so PostgREST treats it like a
  // read endpoint and .limit()/.order() chain onto it the same as a table.
  app.innerHTML = `
    <div class="card">
      <h2>Leaderboard</h2>
      <ol>
        ${(leaderboard || []).map((row) => `<li>${row.display_name} — ${row.total_points} pts</li>`).join('')}
      </ol>
      <button onclick="location.hash='dashboard'">Back</button>
    </div>
  `
}

window.addEventListener('hashchange', render)
render()