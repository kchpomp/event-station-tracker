// DEV-ONLY mock of the Supabase client, used by `npm run dev` + ?preview=1 (see TESTING.md).
// supabaseClient.js imports this file dynamically behind `import.meta.env.DEV`, which Vite replaces with
// `false` in a production build, so neither this file nor its data ever reaches the deployed site.
// It implements only the calls src/main.js makes: 5 auth methods, 4 tables, 5 RPCs. State lives in memory
// (a reload resets it) and nothing here touches the network.

const ME = {
  id: 'preview-user', first_name: 'Валерий', last_name: 'Леонтьев',
  company: 'СИБУР Тобольск', city: 'Тобольск', personal_qr_token: 'preview-me',
}
const PEOPLE = [ // scan these tokens on the Диффузия screen
  { token: 'preview-person-1', company: 'Полиом', city: 'Омск' },
  { token: 'preview-person-2', company: 'СИБУР Тобольск', city: 'Пермь' },
  { token: 'preview-person-3', company: 'Другое предприятие', city: 'Тобольск' },
  { token: 'preview-same-city-and-company', company: 'сибур тобольск ', city: 'тобольск' },
]
// Twelve others, so the leaderboard shows its top 10 and then your own place below a gap.
const OTHERS = ['Мария Соколова', 'Игорь Волков', 'Елена Орлова', 'Анна Белова', 'Дмитрий Захаров', 'Ольга Крылова', 'Сергей Мартынов', 'Наталья Фомина', 'Павел Дьячков', 'Ирина Власова', 'Алексей Громов', 'Татьяна Лебедева']
  .map((full_name, i) => ({ full_name, total_points: 80 - i * 6 }))

const station = (n, name, points, extra = {}) => ({ id: `s${n}`, name, points, qr_token: `preview-station-${n}`, is_active: true, display_group: null, success_message: null, ...extra })
const POLYMER = 'polymer_solutions'
const db = {
  profiles: [ME],
  stations: [
    station(1, 'Точка соединения', 1),
    // ten placement QR codes, one card: 1st place = 10 points ... 10th = 1 (scan preview-station-2 for 1st place, -11 for 10th)
    ...Array.from({ length: 10 }, (_, i) => station(2 + i, 'Полимер решений', 10 - i, { display_group: POLYMER, success_message: 'Спасибо за участие в «Полимере решений»!' })),
    station(12, 'Люди формулы будущего', 1, { success_message: 'Спасибо! Вы стали частью «Людей Формулы будущего».' }),
    station(13, 'Воркшоп 1', 1),
    station(14, 'Воркшоп 2', 1),
    station(15, 'Воркшоп 3', 1),
  ],
  station_visits: [{ participant_id: ME.id, station_id: 's1' }],
  ideas: [],
}
const connected = new Set(['preview-person-0']) // the one connection already counted at the start
let connections = 1
let signedIn = true

const pointsOf = (id) => db.stations.find((s) => s.id === id).points
const myPoints = () => db.station_visits.reduce((n, v) => n + pointsOf(v.station_id), 0) + Math.min(db.ideas.length, 5) + connections // idea = 1 (first 5 only), connection = 1 (placeholder weight), as in SQL
const progress = () => ({ total_points: myPoints(), ideas_count: db.ideas.length, connections_count: connections })

const done = (data, error = null) => ({ then: (ok, fail) => Promise.resolve({ data, error }).then(ok, fail) })
const fail = (message) => done(null, { message })

// Thenable query builder: awaitable like supabase-js, with the chain methods main.js uses.
function query(rows) {
  let r = rows
  const q = {
    select: () => q,
    order: () => q,
    eq: (col, val) => { r = r.filter((x) => x[col] === val); return q },
    single: () => (r.length === 1 ? done(r[0]) : fail('no single row')),
    maybeSingle: () => done(r[0] ?? null),
    insert: (row) => { rows.push({ id: `i${rows.length + 1}`, ...row }); return done(null) },
    then: (ok, bad) => done(r).then(ok, bad),
  }
  return q
}

const rpcs = {
  get_my_progress: () => query([progress()]),
  // the top 10 plus the caller's own row when outside it, ranked like the database does (equal points share a rank)
  get_leaderboard: () => {
    const all = [...OTHERS, { full_name: `${ME.first_name} ${ME.last_name}`, total_points: myPoints(), is_me: true }].sort((a, b) => b.total_points - a.total_points)
    const rows = all.map((x) => ({ rank: 1 + all.filter((y) => y.total_points > x.total_points).length, full_name: x.full_name, total_points: x.total_points, is_me: !!x.is_me }))
    return query(rows.filter((r, i) => i < 10 || r.is_me))
  },
  station_success_message: ({ p_token }) => done(db.stations.find((x) => x.qr_token === p_token)?.success_message ?? null),
  scan_station: ({ p_token }) => {
    const s = db.stations.find((x) => x.qr_token === p_token)
    if (!s) return fail('invalid station token')
    // the same QR again, or any second «Полимер решений» QR (one award per person), awards nothing
    const already = db.station_visits.some((v) => v.station_id === s.id || (s.display_group === POLYMER && db.stations.find((x) => x.id === v.station_id).display_group === POLYMER))
    if (!already) db.station_visits.push({ participant_id: ME.id, station_id: s.id })
    return query([{ points_awarded: already ? 0 : s.points, total_points: myPoints(), already_completed: already }])
  },
  confirm_diffusion_connection: ({ p_token }) => {
    if (p_token === ME.personal_qr_token) return fail('cannot connect with yourself')
    const p = PEOPLE.find((x) => x.token === p_token)
    if (!p) return fail('invalid participant token')
    const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()
    if (same(p.city, ME.city) && same(p.company, ME.company)) return fail('participant is from the same city and company')
    if (!connected.has(p_token)) { connected.add(p_token); connections = Math.min(connections + 1, 3) }
    return done(connections)
  },
}

export function previewClient() {
  const badge = document.createElement('div')
  badge.id = '__PREVIEW_MOCK__'
  badge.textContent = 'РЕЖИМ ПРЕДПРОСМОТРА · данные не настоящие'
  badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2000;padding:4px 10px;border-radius:999px;background:#1f1f1f;color:#fff;font:600 11px/1.4 system-ui,sans-serif;opacity:.85;pointer-events:none'
  document.body.appendChild(badge)

  const session = () => (signedIn ? { user: { id: ME.id, email: 'preview@example.test' } } : null)
  return {
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => { signedIn = true; return { data: { session: session() }, error: null } },
      signUp: async () => ({ data: {}, error: null }), // like the real flow: no session until the email is confirmed
      signOut: async () => { signedIn = false; return { error: null } },
    },
    from: (table) => query(db[table] ?? []),
    rpc: (name, args = {}) => (rpcs[name] ? rpcs[name](args) : fail(`preview: no mock for rpc ${name}`)),
  }
}
