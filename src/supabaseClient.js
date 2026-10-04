import { createClient } from '@supabase/supabase-js'

// flowType: 'pkce' matters here specifically because the router below is
// hash-based (#dashboard, #scan, ...). Supabase's default auth flow
// delivers session tokens back to the app via a URL hash fragment too
// (#access_token=...) — which would collide with the router reading
// window.location.hash for navigation. PKCE instead uses a ?code=...
// query parameter, which doesn't interfere with the hash at all. This
// only matters once real emails are involved (Part 15) — without it, an
// email confirmation link would land the participant on a page whose
// hash the router doesn't recognize, not on their dashboard.
let client
// Dev-only preview (TESTING.md): needs BOTH `npm run dev` and ?preview=1. import.meta.env.DEV is replaced
// by `false` at build time, so in a production build this branch and src/preview.js are removed entirely.
if (import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === '1') {
  client = (await import('./preview.js')).previewClient()
} else {
  client = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
    { auth: { flowType: 'pkce' } }
  )
}
export const supabase = client
