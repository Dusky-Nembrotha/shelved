import { all, get, run, json } from './db.js'
import { normaliseTitle, sortTitle, uniqueBy, canonicalGenres } from './util.js'

const ID_FIELDS = ['tmdb_id', 'imdb_id', 'isbn', 'olid', 'asin', 'spotify_id', 'mbid', 'itunes_id']

export function hydrate(work) {
  if (!work) return work
  return {
    ...work,
    creators: json(work.creators, []),
    genres: json(work.genres, []),
    metadata: json(work.metadata, {}),
    liked: Boolean(work.liked),
  }
}

/** Audiobooks and books of the same title are the same work, found alike. */
export function findWork({ type: rawType, title, year, ...ids }) {
  const type = rawType === 'audiobook' ? 'book' : rawType
  for (const field of ID_FIELDS) {
    if (ids[field]) {
      const row = get(`SELECT * FROM works WHERE type = ? AND ${field} = ?`, type, String(ids[field]))
      if (row) return hydrate(row)
    }
  }
  if (!title) return undefined

  const norm = normaliseTitle(title)
  const candidates = all(
    `SELECT * FROM works WHERE type = ? AND (lower(title) = ? OR sort_title = ?)`,
    type,
    String(title).toLowerCase(),
    sortTitle(title),
  )
  let pool = candidates
  /*
   * A title of nothing but punctuation or a non-Latin script normalises to
   * the empty string — "봄날", "∞", "(-_-)" all do. Matching on that would
   * make every such title the same title, so the normalised fallback is
   * skipped rather than allowed to merge them.
   */
  if (!pool.length && norm) {
    /*
     * Fall back to the normalised title — "Mr. Brightside" and "Mr Brightside"
     * are one song. It reads the stored norm_title through its index rather
     * than normalising every title in the type, which was a full scan per
     * lookup: fine for a thousand films, a quarter of an hour for a
     * six-thousand-track playlist. See the works.norm_title migration.
     */
    pool = all('SELECT * FROM works WHERE type = ? AND norm_title = ?', type, norm)
  }
  if (!pool.length) return undefined

  /*
   * Two bands with a song called "Intro" in the same year become one work
   * here, credited to both, because matching ignores the artist. Filtering
   * the pool by artist is the obvious fix and does not work: works_match_idx
   * is UNIQUE on (type, lower(title), year), so refusing the match only
   * turns a quiet merge into an insert that fails. Doing it properly means
   * putting the artist into that index, which is a schema change for every
   * media type and wants its own go. Eighteen of six thousand playlist
   * tracks landed this way.
   */

  if (year) {
    const exact = pool.find((w) => w.year === Number(year))
    if (exact) return hydrate(exact)
    const near = pool.find((w) => w.year && Math.abs(w.year - Number(year)) <= 1)
    if (near) return hydrate(near)
    const undated = pool.find((w) => !w.year)
    if (undated) return hydrate(undated)
    return undefined
  }
  return hydrate(pool[0])
}

function mergeCreators(existing, incoming) {
  return uniqueBy([...(existing || []), ...(incoming || [])], (c) => `${c.role || ''}|${(c.name || '').toLowerCase()}`)
    .filter((c) => c.name)
    .slice(0, 40)
}

/**
 * Insert or enrich a work. Existing non-empty fields win over blank incoming
 * ones, so a thin CSV import never erases good API metadata.
 */
export function upsertWork(input) {
  /*
   * Audiobooks are books. An audiobook is the same work as the printed
   * edition; the difference is how you took it in, which is recorded on the
   * entry. Without this an Audible or Goodreads import would quietly create
   * titles of a type that has no library to appear in.
   */
  const type = input.type === 'audiobook' ? 'book' : input.type
  if (!type) throw new Error('work.type is required')
  const title = String(input.title || '').trim()
  if (!title) throw new Error('work.title is required')

  const existing = findWork({ type, title, year: input.year, ...input })
  const creators = Array.isArray(input.creators) ? input.creators.filter((c) => c && c.name) : []
  const genres = canonicalGenres(Array.isArray(input.genres) ? input.genres : [])

  if (!existing) {
    const stmt = run(
      `INSERT INTO works (type, title, sort_title, norm_title, original_title, year, release_date, creators, genres,
         overview, runtime, pages, seasons, episodes, language, poster_url, backdrop_url,
         tmdb_id, imdb_id, isbn, olid, asin, spotify_id, mbid, itunes_id,
         external_rating, popularity, metadata, enriched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      type, title, sortTitle(title), normaliseTitle(title), input.original_title || null, input.year ?? null, input.release_date || null,
      JSON.stringify(creators), JSON.stringify(genres), input.overview || null,
      input.runtime ?? null, input.pages ?? null, input.seasons ?? null, input.episodes ?? null,
      input.language || null, input.poster_url || null, input.backdrop_url || null,
      input.tmdb_id ? String(input.tmdb_id) : null, input.imdb_id || null, input.isbn || null, input.olid || null,
      input.asin || null, input.spotify_id || null, input.mbid || null, input.itunes_id ? String(input.itunes_id) : null,
      input.external_rating ?? null, input.popularity ?? null, JSON.stringify(input.metadata || {}),
      input.enriched_at || null,
    )
    return { work: hydrate(get('SELECT * FROM works WHERE id = ?', Number(stmt.lastInsertRowid))), created: true }
  }

  const patch = {}
  const scalars = ['original_title', 'release_date', 'overview', 'runtime', 'pages', 'seasons', 'episodes',
    'language', 'poster_url', 'backdrop_url', 'external_rating', 'popularity', 'year', ...ID_FIELDS]
  for (const field of scalars) {
    const incoming = input[field]
    if (incoming == null || incoming === '') continue
    if (existing[field] == null || existing[field] === '') patch[field] = typeof incoming === 'number' ? incoming : String(incoming)
  }
  if (input.enriched_at) patch.enriched_at = input.enriched_at
  if (input.title && input.title.length > title.length) patch.title = input.title

  /*
   * sort_title and norm_title are derived, and a derived column that is
   * allowed to drift is worse than no column: norm_title is what duplicate
   * detection reads, so a stale one silently splits a work in two. Recompute
   * from whatever the title ends up being, and repair anything written by a
   * path that did not know to.
   */
  const finalTitle = patch.title || existing.title
  if (sortTitle(finalTitle) !== existing.sort_title) patch.sort_title = sortTitle(finalTitle)
  if (normaliseTitle(finalTitle) !== existing.norm_title) patch.norm_title = normaliseTitle(finalTitle)

  const mergedCreators = mergeCreators(existing.creators, creators)
  if (mergedCreators.length !== existing.creators.length) patch.creators = JSON.stringify(mergedCreators)
  const mergedGenres = canonicalGenres([...existing.genres, ...genres])
  if (mergedGenres.length !== existing.genres.length) patch.genres = JSON.stringify(mergedGenres)
  if (input.metadata && Object.keys(input.metadata).length) {
    patch.metadata = JSON.stringify({ ...existing.metadata, ...input.metadata })
  }

  const keys = Object.keys(patch)
  if (keys.length) {
    run(
      `UPDATE works SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => patch[k]),
      existing.id,
    )
  }
  return { work: hydrate(get('SELECT * FROM works WHERE id = ?', existing.id)), created: false }
}

/** A work plus the user's relationship to it. */
export function workWithStats(id) {
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', id))
  if (!work) return undefined
  const entries = all('SELECT * FROM entries WHERE work_id = ? ORDER BY ifnull(consumed_on, created_at) DESC', id)
    .map((e) => ({ ...e, tags: json(e.tags, []), liked: Boolean(e.liked), is_repeat: Boolean(e.is_repeat) }))
  const rated = entries.filter((e) => e.rating != null)
  return {
    ...work,
    entries,
    stats: {
      count: entries.length,
      rating: rated.length ? rated[0].rating : null,
      best: rated.length ? Math.max(...rated.map((e) => e.rating)) : null,
      liked: entries.some((e) => e.liked),
      last: entries.find((e) => e.consumed_on)?.consumed_on || null,
      status: entries[0]?.status || null,
    },
    lists: all(
      'SELECT l.id, l.name, l.slug FROM lists l JOIN list_items li ON li.list_id = l.id WHERE li.work_id = ?',
      id,
    ),
  }
}

export const WORK_CARD_SQL = `
  SELECT w.*,
         (SELECT count(*) FROM entries e WHERE e.work_id = w.id) AS entry_count,
         /*
          * Watching a show is not the same as watching it twice. An import
          * writes one entry per season, so counting entries called a single
          * run through four series of The Durrells "4×". A repeat is the
          * thing you ticked as a repeat, and nothing else.
          */
         (SELECT count(*) FROM entries e WHERE e.work_id = w.id AND e.is_repeat = 1) AS repeat_count,
         (SELECT count(DISTINCT e.season) FROM entries e
            WHERE e.work_id = w.id AND e.season IS NOT NULL) AS season_count,
         (SELECT max(e.rating) FROM entries e WHERE e.work_id = w.id) AS rating,
         (SELECT max(e.liked) FROM entries e WHERE e.work_id = w.id) AS liked,
         (SELECT max(e.consumed_on) FROM entries e WHERE e.work_id = w.id) AS last_on,
         /*
          * The same two figures over the diary alone, so that a view about
          * what you have been up to can ask for what you have been up to.
          * See entries.backfill.
          */
         (SELECT count(*) FROM entries e WHERE e.work_id = w.id AND e.backfill = 0) AS live_count,
         (SELECT max(e.consumed_on) FROM entries e
            WHERE e.work_id = w.id AND e.backfill = 0) AS live_on,
         (SELECT e.status FROM entries e WHERE e.work_id = w.id
            ORDER BY ifnull(e.consumed_on, e.created_at) DESC LIMIT 1) AS status
  FROM works w`
