import { all, run, get } from './db.js'

const DEFAULTS = {
  tmdb_api_key: '',
  omdb_api_key: '',
  google_books_api_key: '',
  // BoardGameGeek closed their XML API to anonymous requests; board games run
  // on Wikidata until a key is issued, then on BGG itself.
  bgg_api_key: '',
  anthropic_api_key: '',
  theme: 'dark',
  accent: 'amber',
  rating_style: 'stars',
  default_section: 'home',
  enrich_on_import: '1',
  owner_name: '',
  watch_region: 'GB',
  /* Live music. The key is free from developer.ticketmaster.com; without one
     the Gigs tab says so rather than sitting empty. */
  ticketmaster_api_key: '',
  /* Where "near me" is, for gigs. A town, and how far you will travel to it. */
  gigs_city: 'Bristol',
  gigs_radius_km: '40',
  /* How far ahead to look. Eighteen months: a tour by somebody you love is
     announced further out than feels reasonable — King Gizzard at Bristol
     Sounds was 211 days away and Bruce Dickinson's Academy date is 373 —
     and a gig you cannot yet buy a ticket for is still one to know about. */
  gigs_days: '540',
  /* TMDB provider ids you subscribe to, as JSON. Ids rather than names
     because names differ by region and by ad tier. */
  watch_services: '[]',
}

export function getSettings() {
  const rows = all('SELECT key, value FROM settings')
  const out = { ...DEFAULTS }
  for (const r of rows) out[r.key] = r.value
  return out
}

export function setting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key)
  return row ? row.value : DEFAULTS[key] ?? ''
}

export function saveSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value == null ? '' : String(value),
    )
  }
  return getSettings()
}

/** Keys are secrets: never ship them to the browser, just say whether they exist. */
export function publicSettings() {
  const s = getSettings()
  return {
    ...s,
    tmdb_api_key: s.tmdb_api_key ? '••••••••' + s.tmdb_api_key.slice(-4) : '',
    omdb_api_key: s.omdb_api_key ? '••••••••' + s.omdb_api_key.slice(-4) : '',
    google_books_api_key: s.google_books_api_key ? '••••••••' + s.google_books_api_key.slice(-4) : '',
    bgg_api_key: s.bgg_api_key ? '••••••••' + s.bgg_api_key.slice(-4) : '',
    anthropic_api_key: s.anthropic_api_key ? '••••••••' + s.anthropic_api_key.slice(-4) : '',
    ticketmaster_api_key: s.ticketmaster_api_key ? '••••••••' + s.ticketmaster_api_key.slice(-4) : '',
    has_ticketmaster: Boolean(s.ticketmaster_api_key),
    has_tmdb: Boolean(s.tmdb_api_key),
    has_omdb: Boolean(s.omdb_api_key),
    has_google_books: Boolean(s.google_books_api_key),
    has_bgg: Boolean(s.bgg_api_key),
    has_anthropic: Boolean(s.anthropic_api_key),
  }
}
