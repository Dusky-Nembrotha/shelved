import { all, get, run } from './lib/db.js'
import { enrich, resolveScreenType } from './providers/index.js'
import { hydrate } from './lib/works.js'
import { canonicalGenres, sortTitle, normaliseTitle } from './lib/util.js'
import { cacheArtwork } from './lib/artwork.js'

/**
 * Background metadata enrichment. Imports stage bare titles; this fills in
 * artwork, genres, creators and external ids a couple at a time so a
 * 2,000-film Letterboxd import does not hammer the free APIs.
 */
const queue = []
const queued = new Set()
const forced = new Set()
let running = 0
// The per-host gates in lib/http.js already serialise each provider, so a few
// workers mainly overlap latency between *different* providers (a book waiting
// on Open Library while a film waits on Wikipedia).
const CONCURRENCY = 3

export const state = {
  get pending() { return queue.length + running },
  done: 0,
  failed: 0,
  lastTitle: null,
  running: false,
}

export function queueEnrichment(workIds, { force = false, priority = false } = {}) {
  for (const id of workIds) {
    if (force) forced.add(id)
    if (queued.has(id)) continue
    queued.add(id)
    // What is on screen gets filled in first; a big import works through the
    // rest behind it.
    if (priority) queue.unshift(id)
    else queue.push(id)
  }
  pump()
  return state.pending
}

/**
 * Called by the read endpoints: anything being looked at that still lacks
 * artwork goes to the front of the queue.
 */
export function prioritise(works) {
  const ids = (works || [])
    .filter((w) => w && w.id && !w.poster_url)
    .map((w) => w.id)
    .slice(0, 40)
  if (ids.length) queueEnrichment(ids, { priority: true })
  return ids.length
}

export function queueAll({ onlyMissing = true, type, force = false } = {}) {
  const rows = all(
    `SELECT id FROM works
      WHERE (? IS NULL OR type = ?)
        AND (? = 0 OR poster_url IS NULL OR enriched_at IS NULL)
      ORDER BY id DESC`,
    type || null, type || null, onlyMissing ? 1 : 0,
  )
  return queueEnrichment(rows.map((r) => r.id), { force })
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()
    running++
    state.running = true
    enrichWork(id)
      .then(() => { state.done++ })
      .catch(() => { state.failed++ })
      .finally(() => {
        queued.delete(id)
        running--
        if (!queue.length && !running) state.running = false
        pump()
      })
  }
}

async function enrichWork(id) {
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', id))
  if (!work) return
  const force = forced.has(id)
  forced.delete(id)
  if (work.metadata?.enrich_failed && !force) return
  state.lastTitle = work.title

  /*
   * Some imports cannot tell a film from a show — Netflix's export has no type
   * column — so they mark the guess as unconfirmed. This is the one chance to
   * put it in the right library, before anyone sees it in the wrong one.
   */
  let type = work.type
  if (work.metadata?.screen_type_unknown && (type === 'film' || type === 'tv')) {
    const resolved = await resolveScreenType(work.title, work.year, {
      showCandidate: work.metadata.show_candidate || null,
    }).catch(() => null)

    const meta = { ...work.metadata }
    delete meta.screen_type_unknown
    delete meta.show_candidate

    const retype = resolved && resolved.type !== type
    const retitle = resolved && resolved.title !== work.title
    if (retype || retitle) {
      const sets = []
      const args = []
      if (retype) { sets.push('type = ?'); args.push(resolved.type); type = resolved.type }
      if (retitle) {
        // norm_title goes with it: it is what duplicate detection reads, and
        // a stale one means the next import creates a second copy instead.
        sets.push('title = ?', 'sort_title = ?', 'norm_title = ?')
        args.push(resolved.title, sortTitle(resolved.title), normaliseTitle(resolved.title))
        work.title = resolved.title
      }
      run(
        `UPDATE works SET ${sets.join(', ')}, metadata = ?, updated_at = datetime('now') WHERE id = ?`,
        ...args,
        JSON.stringify({ ...meta, ...(retype ? { retyped_from: work.type } : {}) }),
        id,
      )
    } else {
      run('UPDATE works SET metadata = ? WHERE id = ?', JSON.stringify(meta), id)
    }
    work.type = type
    work.metadata = meta
    state.lastTitle = work.title
  }

  /*
   * A forced refresh means "this match is wrong, look again". What is wrong is
   * the record it latched onto, so the provider ids go — but the author stays.
   *
   * Dropping the author too turned a refresh into a search on the title alone,
   * which is how "The Blade Itself" by Joe Abercrombie became "The Blade
   * Itself" by Marcus Sakey. The author is the part we are most sure of.
   */
  const found = await enrich({
    type: work.type,
    title: work.title,
    year: work.year,
    creators: work.creators,
    ...(force ? {} : {
      isbn: work.isbn,
      imdb_id: work.imdb_id,
      tmdb_id: work.tmdb_id,
    }),
  })

  // Only stamp enriched_at on success: a throttled lookup must stay retryable.
  const attempts = (work.metadata?.enrich_attempts || 0) + 1
  const patch = found
    ? { enriched_at: new Date().toISOString() }
    : attempts >= 3
      ? { enriched_at: new Date().toISOString(), metadata: JSON.stringify({ ...work.metadata, enrich_attempts: attempts, enrich_failed: true }) }
      : { metadata: JSON.stringify({ ...work.metadata, enrich_attempts: attempts }) }

  if (found) {
    const fields = ['overview', 'poster_url', 'backdrop_url', 'runtime', 'pages', 'seasons', 'episodes',
      'language', 'release_date', 'external_rating', 'popularity', 'tmdb_id', 'imdb_id', 'isbn', 'olid',
      'mbid', 'itunes_id', 'original_title']
    for (const f of fields) {
      if (found[f] == null || found[f] === '') continue
      // A forced refresh is the user saying "this match is wrong" — replace it.
      if (force || work[f] == null || work[f] === '') patch[f] = found[f]
    }
    if (!work.year && found.year) patch.year = found.year

    // Structured sources (TMDB, Wikidata) know who directed a film; a sentence
    // scraped from an intro paragraph is a guess, so let the structured list lead.
    const structured = force || found.provider === 'tmdb' || found.provider === 'wikidata'
      || found.provider === 'tvmaze' || Boolean(found.metadata?.wikidata_qid)
    const KEEP_ROLES = new Set(['Narrator', 'Publisher'])
    const creators = structured
      ? dedupe(
        [...(found.creators || []), ...work.creators.filter((c) => KEEP_ROLES.has(c.role))],
        (c) => `${c.role}|${c.name.toLowerCase()}`,
      )
      : dedupe([...work.creators, ...(found.creators || [])], (c) => `${c.role}|${c.name.toLowerCase()}`)
    if (JSON.stringify(creators) !== JSON.stringify(work.creators)) patch.creators = JSON.stringify(creators.slice(0, 25))
    const genres = canonicalGenres([...work.genres, ...(found.genres || [])])
    if (genres.length !== work.genres.length) patch.genres = JSON.stringify(genres.slice(0, 14))
    patch.metadata = JSON.stringify({ ...work.metadata, ...(found.metadata || {}), provider: found.provider, enrich_attempts: attempts })
  }

  // Keep a local copy of the artwork, and record how good it is.
  const remote = patch.poster_url || work.poster_url
  if (remote && !String(remote).startsWith('/artwork/')) {
    const art = await cacheArtwork(remote)
    if (art?.path) {
      patch.poster_url = art.path
      const meta = patch.metadata ? JSON.parse(patch.metadata) : { ...work.metadata }
      meta.artwork = {
        source: remote,
        width: art.width ?? null,
        height: art.height ?? null,
        quality: art.quality ?? null,
      }
      patch.metadata = JSON.stringify(meta)
      if (!patch.backdrop_url && !work.backdrop_url) patch.backdrop_url = art.path
    }
  }

  const keys = Object.keys(patch)
  run(
    `UPDATE works SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => patch[k]), id,
  )
}

function dedupe(items, keyFn) {
  const seen = new Set()
  const out = []
  for (const i of items) {
    if (!i) continue
    const k = keyFn(i)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(i)
  }
  return out
}

/* --------------------------------------------------------------- watchlist */

/**
 * Imported watchlists arrive as bare titles. Give them artwork too — the
 * "to check out" page is mostly pictures, so without this it looks broken.
 */
const recQueue = []
const recQueued = new Set()
let recRunning = false

export const recState = {
  get pending() { return recQueue.length + (recRunning ? 1 : 0) },
  done: 0,
}

export function queueRecArtwork(recIds) {
  for (const id of recIds) {
    if (recQueued.has(id)) continue
    recQueued.add(id)
    recQueue.push(id)
  }
  pumpRecs()
  return recState.pending
}

export function queueAllRecArtwork() {
  const rows = all(
    "SELECT id FROM recs WHERE status = 'open' AND (poster_url IS NULL OR poster_url = '') AND type IS NOT NULL",
  )
  return queueRecArtwork(rows.map((r) => r.id))
}

function pumpRecs() {
  if (recRunning || !recQueue.length) return
  const id = recQueue.shift()
  recRunning = true
  enrichRec(id)
    .catch(() => {})
    .finally(() => {
      recQueued.delete(id)
      recRunning = false
      recState.done++
      pumpRecs()
    })
}

async function enrichRec(id) {
  const rec = get('SELECT * FROM recs WHERE id = ?', id)
  if (!rec || !rec.type || rec.poster_url) return
  let creators = []
  try { creators = JSON.parse(rec.creators || '[]') } catch { creators = [] }

  const found = await enrich({ type: rec.type, title: rec.title, year: rec.year, creators })
  if (!found) {
    // Remember the miss so we do not retry it on every page load.
    run("UPDATE recs SET poster_url = '' WHERE id = ? AND poster_url IS NULL", id)
    return
  }
  run(
    `UPDATE recs SET poster_url = ?, year = ifnull(year, ?), creators = ?
      WHERE id = ?`,
    found.poster_url || '',
    found.year ?? null,
    JSON.stringify(creators.length ? creators : (found.creators || []).slice(0, 3)),
    id,
  )
}
