import { parseCsvObjects, columnIndex, pick } from '../lib/csv.js'
import { parseDate, parseRating, parseYear, splitPeople, normaliseTitle } from '../lib/util.js'
import { record, keyFor, looksLikeTv } from './shared.js'

export const id = 'generic'
export const label = 'Any CSV (you choose the columns)'
export const accepts = ['.csv', '.tsv', '.json']
export const help = 'Bring a spreadsheet from anywhere. Columns are guessed, and you can correct '
  + 'the mapping before importing.'

/** Column guesses used to pre-fill the mapping UI. */
export const FIELD_ALIASES = {
  title: ['title', 'name', 'film', 'movie', 'book', 'album', 'show', 'work', 'item'],
  year: ['year', 'release year', 'published', 'publication year', 'first published', 'released'],
  type: ['type', 'media', 'media type', 'category', 'format', 'kind'],
  creators: ['director', 'directors', 'author', 'authors', 'artist', 'artists', 'creator', 'by', 'writer'],
  rating: ['rating', 'my rating', 'score', 'stars', 'rating10', 'star rating'],
  consumed_on: ['date', 'watched date', 'date read', 'date watched', 'date listened', 'finished', 'completed', 'date rated', 'last date read'],
  review: ['review', 'my review', 'thoughts', 'comment', 'comments'],
  notes: ['notes', 'private notes', 'note'],
  tags: ['tags', 'shelves', 'bookshelves', 'labels', 'genres'],
  status: ['status', 'shelf', 'exclusive shelf', 'read status', 'state'],
  kind: ['list', 'kind', 'watchlist'],
  isbn: ['isbn', 'isbn13'],
  imdb_id: ['imdb id', 'imdb', 'const', 'tconst'],
  tmdb_id: ['tmdb id', 'tmdb'],
  runtime: ['runtime', 'length', 'duration', 'minutes'],
  pages: ['pages', 'number of pages', 'page count'],
  /* Our own export's column, so a restore puts taste back as taste. */
  backfill: ['backfill'],
}

export function guessMapping(headers) {
  const idx = columnIndex(headers)
  const mapping = {}
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const header = idx.get(alias.replace(/[^a-z0-9]/g, ''))
      if (header) { mapping[field] = header; break }
    }
  }
  return mapping
}

export function detect({ headers }) {
  if (!headers || !headers.length) return { confidence: 0 }
  const mapping = guessMapping(headers)
  return mapping.title
    ? { confidence: 0.2, reason: 'generic table with a title column', mapping }
    : { confidence: 0.05, reason: 'unrecognised table' }
}

const TYPE_WORDS = [
  [/audio\s*book|audible/i, 'audiobook'],
  [/\b(tv|show|series|season|episode)\b/i, 'tv'],
  [/\b(film|movie|cinema)\b/i, 'film'],
  [/\b(album|music|record|lp|ep)\b/i, 'album'],
  [/\b(song|track|single)\b/i, 'track'],
  [/\b(podcast)\b/i, 'podcast'],
  [/\b(game|gaming|videogame)\b/i, 'game'],
  [/\b(book|novel|read|paperback|hardcover|kindle|ebook)\b/i, 'book'],
]

function typeFrom(value, fallback) {
  for (const [re, type] of TYPE_WORDS) if (re.test(String(value))) return type
  return fallback
}

export function parse(files, opts = {}) {
  const mapping = opts.mapping || {}
  const defaultType = opts.defaultType || 'film'
  const scale = Number(opts.ratingScale || 5)
  const sourceName = opts.sourceName || 'import'
  const out = []

  for (const file of files) {
    const { headers, rows } = parseCsvObjects(file.text)
    const map = Object.keys(mapping).length ? mapping : guessMapping(headers)
    const idx = columnIndex(headers)
    const col = (field) => (map[field] ? [map[field]] : FIELD_ALIASES[field] || [])

    for (const row of rows) {
      const title = pick(row, col('title'), idx)
      if (!title) continue
      const typeRaw = pick(row, col('type'), idx)
      let type = typeRaw ? typeFrom(typeRaw, defaultType) : defaultType
      if (type === 'film' && looksLikeTv(title)) type = 'tv'

      const statusRaw = pick(row, col('status'), idx).toLowerCase()
      const kindRaw = pick(row, col('kind'), idx).toLowerCase()
      const wantsRec = /to-?read|to-?watch|watchlist|want|queue|planned|wishlist/.test(statusRaw + ' ' + kindRaw)
      const status = /reading|watching|listening|in progress/.test(statusRaw) ? 'in_progress'
        : /abandon|dnf|did not finish|dropped/.test(statusRaw) ? 'abandoned'
        : 'completed'

      const base = {
        type,
        title,
        year: parseYear(pick(row, col('year'), idx)),
        creators: splitPeople(pick(row, col('creators'), idx)).map((name) => ({
          role: type === 'film' ? 'Director' : type === 'album' || type === 'track' ? 'Artist' : 'Author',
          name,
        })),
        isbn: pick(row, col('isbn'), idx) || null,
        imdb_id: pick(row, col('imdb_id'), idx) || null,
        tmdb_id: pick(row, col('tmdb_id'), idx) || null,
        runtime: Number(pick(row, col('runtime'), idx)) || null,
        pages: Number(pick(row, col('pages'), idx)) || null,
        metadata: { imported_from: sourceName },
      }
      const tags = pick(row, col('tags'), idx).split(/[,;|]/).map((s) => s.trim()).filter(Boolean)

      if (wantsRec) {
        out.push(record({
          ...base,
          kind: 'rec',
          recommender: sourceName,
          note: pick(row, col('notes'), idx) || null,
          external_key: keyFor(sourceName, 'rec', [type, normaliseTitle(title)]),
        }))
        continue
      }

      out.push(record({
        ...base,
        kind: 'entry',
        status,
        rating: parseRating(pick(row, col('rating'), idx), scale),
        // Only our own export has this; anything else is a diary entry.
        backfill: /^(1|true|yes)$/i.test(pick(row, col('backfill'), idx)),
        consumed_on: parseDate(pick(row, col('consumed_on'), idx)),
        review: pick(row, col('review'), idx) || null,
        notes: pick(row, col('notes'), idx) || null,
        tags,
        external_key: keyFor(sourceName, 'row', [type, normaliseTitle(title), pick(row, col('consumed_on'), idx)]),
      }))
    }
  }
  return out
}
