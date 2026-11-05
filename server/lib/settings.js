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
    has_tmdb: Boolean(s.tmdb_api_key),
    has_omdb: Boolean(s.omdb_api_key),
    has_google_books: Boolean(s.google_books_api_key),
    has_bgg: Boolean(s.bgg_api_key),
    has_anthropic: Boolean(s.anthropic_api_key),
  }
}
