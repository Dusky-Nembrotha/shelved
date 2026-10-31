import { Router } from 'express'
import { all, get, run, json } from '../lib/db.js'
import { WORK_CARD_SQL, workWithStats, upsertWork, hydrate } from '../lib/works.js'
import { TYPES, SECTIONS, normaliseTitle, today, clamp } from '../lib/util.js'
import { searchProviders, searchAllTypes, bookNoise, enrich, screenRatings, tmdb, ol, itunes, mb, wiki, wikidata, omdb, gbooks, imdbdata, steam, boardgame } from '../providers/index.js'
import { foldGenres, genreFacets, matchesGenre } from '../lib/genres.js'
import * as bgg from '../providers/bgg.js'
import { cacheArtwork, cachedPathFor } from '../lib/artwork.js'
import { join } from 'node:path'
import { DATA_DIR } from '../lib/db.js'
import { qualityOf } from '../lib/imagesize.js'
import { queueEnrichment, prioritise } from '../enrich.js'
import { setting } from '../lib/settings.js'
import { currentUserId } from '../lib/user.js'

export const router = Router()

/*
 * Each sort has both directions written out rather than flipped by string
 * substitution: the NULL handling differs between them. Nulls stay at the
 * bottom either way, because "no rating" is not the lowest rating.
 */
const SORTS = {
  // Ties are common after an import, where everything shares one date:
  // fall back to release date so the order means something.
  recent: 'last_on IS NULL, last_on DESC, year IS NULL, year DESC, sort_title ASC',
  added: 'created_at DESC',
  rating: 'rating IS NULL, rating DESC, last_on DESC',
  title: 'sort_title ASC',
  year: 'year IS NULL, year DESC',
  runtime: 'runtime IS NULL, runtime DESC',
}

const SORTS_ASC = {
  recent: 'last_on IS NULL, last_on ASC, year IS NULL, year ASC, sort_title ASC',
  added: 'created_at ASC',
  rating: 'rating IS NULL, rating ASC, last_on DESC',
  title: 'sort_title DESC',
  year: 'year IS NULL, year ASC',
  runtime: 'runtime IS NULL, runtime ASC',
}

/*
 * A card, seen from whichever shelf asked for it.
 *
 * The same book on the audiobook shelf is a different object: it wears the
 * cover the recording was sold under rather than the one the hardback was,
 * and the person who matters most about it is the one who read it aloud.
 * Falls back to the book's own cover and author, because a recording without
 * its own artwork is still an audiobook.
 */
function cardOf(row, shelf) {
  const w = hydrate(row)
  const heard = shelf === 'audiobook'
  const narrators = (w.metadata?.narrators || []).filter(Boolean)
  const spoken = heard
    ? [
        ...narrators.slice(0, 1).map((name) => ({ role: 'Narrator', name })),
        ...w.creators.filter((c) => c.role === 'Author').slice(0, 1),
      ]
    : null

  return {
    id: w.id,
    type: heard ? 'audiobook' : w.type,
    title: w.title,
    year: w.year,
    release_date: w.release_date,
    poster_url: (heard && w.metadata?.audiobook_poster_url) || w.poster_url,
    backdrop_url: w.backdrop_url,
    creators: spoken?.length ? spoken : w.creators.filter((c) => c.role !== 'Cast').slice(0, 2),
    genres: w.genres.slice(0, 3),
    rating: row.rating ?? null,
    liked: Boolean(row.liked),
    entry_count: row.entry_count ?? 0,
    last_on: row.last_on ?? null,
    status: row.status ?? null,
    // An audiobook is measured in hours, a book in pages.
    runtime: heard ? (w.metadata?.audio_minutes ?? w.runtime) : w.runtime,
    pages: heard ? null : w.pages,
    narrators: heard ? narrators.slice(0, 2) : undefined,
    external_rating: w.external_rating,
  }
}

/*
 * Books and audiobooks: one shelf of works, two libraries.
 *
 * A book is one thing whether you read it or were read it, so there is still
 * only one work — but which library it belongs to is a question about how you
 * took it in, and a book you did both with belongs in both. That makes
 * membership a question about a work's entries rather than about its type.
 *
 * An entry with no format recorded is a book that was read: that is what every
 * entry predating the column meant. A work with no entries at all is something
 * you own and have not started, and it sits with the books.
 */
const SHELF = {
  audiobook: `w.type = 'book' AND EXISTS (
    SELECT 1 FROM entries e2 WHERE e2.work_id = w.id AND e2.format IN ('audiobook', 'both'))`,
  book: `w.type = 'book' AND (
    EXISTS (SELECT 1 FROM entries e2 WHERE e2.work_id = w.id
              AND (e2.format IN ('book', 'both') OR e2.format IS NULL))
    OR NOT EXISTS (SELECT 1 FROM entries e3 WHERE e3.work_id = w.id))`,
}

/*
 * Do you already have this?
 *
 * Title alone is not enough. There are four films called Resident Evil, and
 * owning the 2002 one had the 2026 one badged as yours in the chart and its
 * preview opening the wrong film. A remake is not the thing it remade.
 *
 * A year within one of the asked-for year is the same release: sources
 * disagree about festival and general release by a few months. A title match
 * with no year recorded is accepted only when nothing better is found, since
 * entries made before the field existed have none.
 */
function ownedIndex() {
  const exact = new Map()
  const byTitle = new Map()
  for (const w of all('SELECT id, type, title, year FROM works')) {
    const base = `${w.type}|${normaliseTitle(w.title)}`
    if (w.year != null) {
      for (const y of [w.year - 1, w.year, w.year + 1]) {
        if (!exact.has(`${base}|${y}`)) exact.set(`${base}|${y}`, w.id)
      }
    }
    if (!byTitle.has(base)) byTitle.set(base, { id: w.id, year: w.year })
  }
  return {
    get: (key, year) => {
      if (year == null) return byTitle.get(key)?.id ?? null
      const hit = exact.get(`${key}|${year}`)
      if (hit) return hit
      /*
       * No year on the entry means it predates the field, so a title match is
       * the best anyone can do. A year that simply differs is a different
       * film, and saying otherwise is how the 2026 Resident Evil came to be
       * badged as the 2002 one.
       */
      const loose = byTitle.get(key)
      return loose && loose.year == null ? loose.id : null
    },
  }
}

function ownedId(type, title, year) {
  return ownedIndex().get(`${type}|${normaliseTitle(title)}`, year ?? null)
}

/** GET /api/works — the grid behind every section page. */
router.get('/works', (req, res) => {
  const { type, q, genre, creator, status, sort = 'recent', year, decade } = req.query
  const limit = clamp(Number(req.query.limit) || 60, 1, 500)
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const minRating = req.query.minRating ? Number(req.query.minRating) : null
  const unrated = req.query.unrated === '1'

  const where = []
  const params = []
  if (type && type !== 'all') {
    if (SHELF[type]) where.push(SHELF[type])
    else { where.push('w.type = ?'); params.push(type) }
  }
  if (q) {
    where.push('(lower(w.title) LIKE ? OR lower(w.creators) LIKE ?)')
    params.push(`%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`)
  }
  if (genre) { where.push('lower(w.genres) LIKE ?'); params.push(`%${String(genre).toLowerCase()}%`) }
  if (creator) { where.push('lower(w.creators) LIKE ?'); params.push(`%${String(creator).toLowerCase()}%`) }
  // "Read" and "listened to" are the same library, filtered. 'both' counts as
  // either, because it was both.
  if (['book', 'audiobook'].includes(req.query.format)) {
    where.push(`EXISTS (SELECT 1 FROM entries e2 WHERE e2.work_id = w.id AND e2.format IN (?, 'both'))`)
    params.push(req.query.format)
  }
  if (year) { where.push('w.year = ?'); params.push(Number(year)) }
  if (decade) {
    const d = Number(String(decade).replace('s', ''))
    where.push('w.year BETWEEN ? AND ?'); params.push(d, d + 9)
  }

  // The computed columns (rating, entry_count, status) only exist on the outer
  // query, so filter them there — SQLite will not accept HAVING without GROUP BY.
  const outer = []
  const outerParams = []
  if (minRating) { outer.push('rating >= ?'); outerParams.push(Number(minRating)) }
  if (unrated) outer.push('rating IS NULL')
  if (status === 'logged') outer.push('entry_count > 0')
  else if (status === 'unlogged') outer.push('entry_count = 0')
  else if (status) { outer.push('status = ?'); outerParams.push(String(status)) }

  const inner = `${WORK_CARD_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  const filtered = `SELECT * FROM (${inner}) ${outer.length ? 'WHERE ' + outer.join(' AND ') : ''}`

  const rows = all(
    `${filtered} ORDER BY ${(req.query.dir === 'asc' ? SORTS_ASC : SORTS)[sort] || SORTS.recent} LIMIT ? OFFSET ?`,
    ...params, ...outerParams, limit, offset,
  )
  const total = get(`SELECT count(*) c FROM (${filtered})`, ...params, ...outerParams).c

  const cards = rows.map((r) => cardOf(r, type))
  prioritise(cards)
  res.json({ works: cards, total, limit, offset })
})

/** Facets for the filter bar. */
router.get('/facets', (req, res) => {
  const type = req.query.type && req.query.type !== 'all' ? req.query.type : null
  /*
   * The same shelf rule the grid uses. Audiobooks are stored as books, so a
   * plain type match found none of them and the audiobook library was offered
   * no filters at all.
   */
  const where = type ? (SHELF[type] || 'w.type = ?') : '1 = 1'
  const params = type && !SHELF[type] ? [type] : []
  const rows = all(
    `SELECT w.title, w.genres, w.creators, w.year FROM works w
      WHERE ${where} AND EXISTS (SELECT 1 FROM entries e WHERE e.work_id = w.id)`,
    ...params,
  )
  // What you own, to recognise a series name masquerading as a genre.
  const titles = new Set(rows.map((r) => String(r.title || '').trim().toLowerCase()).filter(Boolean))
  const genres = new Map()
  const creators = new Map()
  const decades = new Map()
  for (const r of rows) {
    for (const g of json(r.genres, [])) genres.set(g, (genres.get(g) || 0) + 1)
    for (const c of json(r.creators, [])) {
      if (c.role === 'Cast' || c.role === 'Contributor') continue
      const key = `${c.role}|${c.name}`
      creators.set(key, (creators.get(key) || 0) + 1)
    }
    if (r.year) {
      const d = `${Math.floor(r.year / 10) * 10}s`
      decades.set(d, (decades.get(d) || 0) + 1)
    }
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  res.json({
    genres: foldGenres(genres, titles).slice(0, 30).map(({ label, count }) => ({ name: label, count })),
    creators: top(creators, 30).map(([key, count]) => ({ role: key.split('|')[0], name: key.split('|')[1], count })),
    decades: [...decades.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([name, count]) => ({ name, count })),
  })
})

router.get('/works/:id', (req, res) => {
  const work = workWithStats(Number(req.params.id))
  if (!work) return res.status(404).json({ error: 'Not found' })

  /*
   * "More like this", from your own library.
   *
   * Two things matter: who made it, and how *unusual* the overlap is. Sharing
   * "Drama" with two hundred other films says nothing; sharing "Western" with
   * ten says a lot. So genres are weighted by how rare they are, and cast is
   * left out — two films sharing an actor are rarely alike.
   */
  const pool = all(`${WORK_CARD_SQL} WHERE w.type = ? AND w.id != ?`, work.type, work.id)
  const hydrated = pool.map(hydrate)

  const genreFreq = new Map()
  for (const w of hydrated) {
    for (const g of new Set(w.genres.map((x) => String(x).toLowerCase()))) {
      genreFreq.set(g, (genreFreq.get(g) || 0) + 1)
    }
  }
  const total = Math.max(1, hydrated.length)
  // Classic inverse document frequency, capped so one oddity cannot run away.
  const rarity = (g) => Math.min(4, Math.log(total / (1 + (genreFreq.get(g) || 0))))

  const makers = new Set(
    work.creators.filter((c) => c.role && c.role !== 'Cast').map((c) => String(c.name).toLowerCase()),
  )
  const wantGenres = new Set(work.genres.map((g) => String(g).toLowerCase()))
  const wantKeywords = new Set((work.metadata?.keywords || []).map((k) => String(k).toLowerCase()))

  const related = hydrated
    .map((w) => {
      let score = 0
      const why = []
      for (const c of w.creators) {
        if (!c.role || c.role === 'Cast') continue
        if (makers.has(String(c.name).toLowerCase())) { score += 5; why.push(c.name) }
      }
      for (const g of new Set(w.genres.map((x) => String(x).toLowerCase()))) {
        if (wantGenres.has(g)) score += rarity(g)
      }
      for (const k of (w.metadata?.keywords || [])) {
        if (wantKeywords.has(String(k).toLowerCase())) score += 1.5
      }
      // A shared decade is a tiebreaker, never a reason.
      if (w.year && work.year && Math.abs(w.year - work.year) <= 5) score += 0.3
      return { w, score, why }
    })
    // One common genre in common is not a resemblance.
    .filter((x) => x.score >= 2.5)
    .sort((a, b) => b.score - a.score || (b.w.rating ?? 0) - (a.w.rating ?? 0))
    .slice(0, 8)
    .map((x) => cardOf(pool.find((p) => p.id === x.w.id)))

  prioritise([work, ...related])
  res.json({ work, related })
})

router.patch('/works/:id', (req, res) => {
  const id = Number(req.params.id)
  const allowed = ['title', 'year', 'overview', 'poster_url', 'backdrop_url', 'runtime', 'pages', 'type']
  const patch = {}
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
  if ('genres' in req.body) patch.genres = JSON.stringify(req.body.genres || [])
  if ('creators' in req.body) patch.creators = JSON.stringify(req.body.creators || [])
  const keys = Object.keys(patch)
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' })
  run(
    `UPDATE works SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => patch[k]), id,
  )
  res.json(workWithStats(id))
})

/** Alternative covers for a title, so a poor one can be replaced. */
/**
 * Cover candidates for something — in the library or not.
 *
 * The picker is wanted at the moment of adding a book as much as afterwards,
 * when the cover the provider chose is plainly wrong, so this works from a
 * title and a name alone and does not need a saved work.
 */
async function coverCandidates({ type, title, creator, tmdbId, mbid }) {
  const jobs = []
  if ((type === 'film' || type === 'tv') && tmdbId) jobs.push(tmdb.images(type, tmdbId))
  if (type === 'book' || type === 'audiobook') jobs.push(ol.editionCovers(title, creator))
  if (['album', 'track', 'audiobook', 'podcast', 'book'].includes(type)) {
    jobs.push(itunes.search(type, [title, creator].filter(Boolean).join(' '), 6)
      .then((hits) => hits.filter((h) => h.poster_url).map((h) => ({ url: h.poster_url, source: 'Apple', label: h.title }))))
  }
  if (type === 'album' && mbid) {
    jobs.push(Promise.resolve([{ url: mb.coverUrl(mbid, 1200), source: 'Cover Art Archive' }]))
  }
  if (type === 'boardgame') {
    // The box, from the infobox — the same place the shelf gets it, so a
    // game with a bad cover can at least be offered the right one.
    jobs.push(boardgame.search(title, 6)
      .then((hits) => hits.filter((h) => h.poster_url).map((h) => ({ url: h.poster_url, source: 'Wikipedia', label: h.title }))))
    // And every picture the game's own article uses. Searching Commons by
    // name offered a conference centre as a cover for Wingspan; what an
    // article illustrates itself with is about the thing it is about.
    jobs.push(boardgame.articleFor(title)
      .then((article) => boardgame.articlePictures(article, 12))
      .then((hits) => hits.map((h) => ({ url: h.url, source: 'Wikipedia', label: h.label }))))
  }
  jobs.push(wiki.search(type, title, 4)
    .then((hits) => hits.filter((h) => h.poster_url).map((h) => ({ url: h.poster_url, source: 'Wikipedia', label: h.title }))))

  /*
   * One file, one choice.
   *
   * The same picture reaches here under several addresses — a thumbnail and
   * the original, or two thumbnails at different widths — and the chooser was
   * offering it twice as though they were alternatives. Wikimedia's filename
   * is the same in every one of them once the size prefix is off.
   */
  const fileKey = (url) => {
    const last = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '')
    return last.replace(/^\d+px-/, '').toLowerCase()
  }

  /*
   * And it has to be the right game. Searching Wikipedia for "Codenames board
   * game" also turns up an article about Monopoly, which was then offered as
   * a cover for Codenames. A candidate has to name the thing it claims to be.
   */
  const words = String(title).toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 3)
  const relevant = (c) => {
    if (type !== 'boardgame' || !words.length) return true
    const haystack = `${c.label || ''} ${fileKey(c.url)}`.toLowerCase()
    return words.some((w) => haystack.includes(w))
  }

  const settled = await Promise.allSettled(jobs)
  const seen = new Set()
  const candidates = []
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    for (const c of r.value || []) {
      if (!c?.url) continue
      const key = fileKey(c.url)
      if (seen.has(key) || !relevant(c)) continue
      seen.add(key)
      candidates.push(c)
    }
  }

  // Measuring means downloading, so cap it and reuse anything already held.
  return candidates.slice(0, 16).map((c) => {
    const already = cachedPathFor(c.url)
    if (already || c.width) {
      return { ...c, cached: already, quality: c.width ? qualityOf({ ok: true, width: c.width }) : null }
    }
    return c
  })
}

const CREATOR_ROLES = ['Author', 'Artist', 'Director', 'Creator']

/** Alternative covers for a title, so a poor one can be replaced. */
router.get('/works/:id/artwork', async (req, res) => {
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', Number(req.params.id)))
  if (!work) return res.status(404).json({ error: 'Not found' })

  const measured = await coverCandidates({
    type: work.type,
    title: work.title,
    creator: work.creators.find((c) => CREATOR_ROLES.includes(c.role))?.name,
    tmdbId: work.tmdb_id,
    mbid: work.mbid,
  })

  res.json({
    current: work.poster_url,
    currentMeta: work.metadata?.artwork ?? null,
    candidates: measured,
  })
})

/** Choose one of them. */
router.post('/works/:id/artwork', async (req, res) => {
  const id = Number(req.params.id)
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', id))
  if (!work) return res.status(404).json({ error: 'Not found' })
  const url = String(req.body?.url || '').trim()
  if (!url) return res.status(400).json({ error: 'A url is required' })

  const art = await cacheArtwork(url, { timeout: 40000 })
  if (!art?.path) return res.status(502).json({ error: 'That image could not be fetched' })

  const metadata = { ...work.metadata, artwork: { source: url, width: art.width ?? null, height: art.height ?? null, quality: art.quality ?? null, chosen: true } }
  run(
    "UPDATE works SET poster_url = ?, backdrop_url = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?",
    art.path, art.path, JSON.stringify(metadata), id,
  )
  res.json({ ok: true, poster_url: art.path, width: art.width, height: art.height, quality: art.quality })
})


/** The same, for something not in the library yet. */
router.get('/artwork/candidates', async (req, res) => {
  const type = TYPES.includes(req.query.type) ? req.query.type : 'film'
  const title = String(req.query.title || '').trim()
  if (!title) return res.status(400).json({ error: 'A title is needed' })

  const measured = await coverCandidates({
    type,
    title,
    creator: String(req.query.creator || '').trim() || undefined,
    tmdbId: req.query.tmdb_id || null,
    mbid: req.query.mbid || null,
  })
  res.json({ current: null, currentMeta: null, candidates: measured })
})

/*
 * Fetch a remote cover once, here, and serve it from disk.
 *
 * Suggestions and the chart show eighteen covers at a time and the browser
 * asks for all of them at once. Open Library answers a burst like that with
 * throttling, which is why a page of audiobook suggestions arrived with no
 * pictures at all — not missing covers, refused ones. Asking from here means
 * one polite request per image, kept afterwards.
 *
 * The allowlist is the whole of the security here: a proxy that fetches any
 * URL on request is an open relay into whatever this machine can reach, and
 * this one answers from the public internet.
 */
const ARTWORK_HOSTS = new Set([
  'covers.openlibrary.org',
  'books.google.com', 'books.googleusercontent.com',
  'image.tmdb.org',
  'upload.wikimedia.org', 'commons.wikimedia.org', 'en.wikipedia.org',
  'cf.geekdo-images.com',
  'coverartarchive.org', 'ia801504.us.archive.org',
  'cdn.cloudflare.steamstatic.com', 'shared.akamai.steamstatic.com',
  'm.media-amazon.com',
])

router.get('/artwork/fetch', async (req, res) => {
  const raw = String(req.query.url || '')
  let url
  try { url = new URL(raw) } catch { return res.status(400).json({ error: 'Not a URL' }) }
  if (url.protocol !== 'https:') return res.status(400).json({ error: 'https only' })

  const host = url.hostname.toLowerCase()
  const allowed = ARTWORK_HOSTS.has(host)
    // Apple serve artwork from a numbered fleet of mzstatic hosts.
    || /^is\d-ssl\.mzstatic\.com$/.test(host)
  if (!allowed) return res.status(403).json({ error: 'Not an artwork host' })

  const got = await cacheArtwork(raw).catch(() => null)
  if (!got?.path) return res.status(404).json({ error: 'No image there' })

  // Served straight off disk from here on, and cached hard: the file is named
  // after the URL it came from, so its contents never change.
  res.set('Cache-Control', 'public, max-age=2592000, immutable')
  res.sendFile(join(DATA_DIR, got.path.replace('/artwork/', 'artwork/')))
})

/** Everything whose cover is too small to look right. */
router.get('/artwork/poor', (req, res) => {
  const rows = all(`
    SELECT id, type, title, year, poster_url,
           json_extract(metadata, '$.artwork.width') w,
           json_extract(metadata, '$.artwork.height') h,
           json_extract(metadata, '$.artwork.quality') q
      FROM works
     WHERE q IN ('poor', 'low') OR (poster_url IS NULL AND EXISTS (SELECT 1 FROM entries e WHERE e.work_id = works.id))
     ORDER BY q, title`)
  res.json({ works: rows })
})

/**
 * Replace every soft cover with the largest alternative on offer. Runs in the
 * background because each one means a fetch.
 */
router.post('/artwork/upgrade', async (req, res) => {
  const targets = all(`
    SELECT id FROM works
     WHERE json_extract(metadata, '$.artwork.quality') IN ('poor', 'low')
       AND json_extract(metadata, '$.artwork.chosen') IS NULL`)
  res.json({ ok: true, queued: targets.length })

  for (const { id } of targets) {
    const work = hydrate(get('SELECT * FROM works WHERE id = ?', id))
    if (!work) continue
    const author = work.creators.find((c) => ['Author', 'Artist', 'Director'].includes(c.role))?.name
    let options = []
    try {
      if ((work.type === 'film' || work.type === 'tv') && work.tmdb_id) options = await tmdb.images(work.type, work.tmdb_id)
      else if (work.type === 'book' || work.type === 'audiobook') options = await ol.editionCovers(work.title, author, 6)
      else options = (await itunes.search(work.type, [work.title, author].filter(Boolean).join(' '), 4))
        .filter((h) => h.poster_url).map((h) => ({ url: h.poster_url }))
    } catch { continue }

    let best = null
    for (const option of options.slice(0, 6)) {
      const art = await cacheArtwork(option.url, { timeout: 40000 })
      if (!art?.width) continue
      if (!best || art.width > best.width) best = { ...art, source: option.url }
    }
    const currentWidth = work.metadata?.artwork?.width ?? 0
    if (!best || best.width <= currentWidth) continue

    run(
      "UPDATE works SET poster_url = ?, backdrop_url = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?",
      best.path, best.path,
      JSON.stringify({ ...work.metadata, artwork: { source: best.source, width: best.width, height: best.height, quality: best.quality } }),
      id,
    )
  }
})

/**
 * One person's shelf: what of theirs you already have, and what you don't.
 *
 * Clicking an author, director or artist filters the library to them; this
 * endpoint answers the obvious next question — what else did they make? The
 * `more` list is everything the providers know about, minus what is already
 * logged, so it is purely the gaps.
 */
router.get('/creator', async (req, res) => {
  const name = String(req.query.name || '').trim()
  const type = TYPES.includes(req.query.type) ? req.query.type : null
  if (!name) return res.status(400).json({ error: 'A name is needed' })

  const userId = currentUserId(req)
  const needle = `%${name.toLowerCase()}%`

  // What you already have by them, and the role they play in your library.
  const owned = all(
    `SELECT w.id, w.type, w.title, w.year, w.creators
       FROM works w
      WHERE lower(w.creators) LIKE ?${type ? ' AND w.type = ?' : ''}`,
    ...[needle, ...(type ? [type] : [])],
  ).map((r) => ({ ...r, creators: json(r.creators, []) }))

  const roles = new Map()
  for (const w of owned) {
    for (const c of w.creators) {
      if (String(c.name).toLowerCase() !== name.toLowerCase()) continue
      roles.set(c.role || 'Credits', (roles.get(c.role || 'Credits') || 0) + 1)
    }
  }
  const role = [...roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  const have = new Set(owned.map((w) => `${w.type}|${normaliseTitle(w.title)}`))

  if (req.query.more !== '1') {
    return res.json({ name, role, type, mine: owned.length, more: [] })
  }

  const wanted = type || owned[0]?.type || 'film'
  let found = []
  try {
    found = await worksByPerson(name, wanted, role)
  } catch {
    found = []
  }

  // Only the gaps, and only once each.
  const seen = new Set()
  const more = []
  for (const c of found) {
    if (!c?.title) continue
    const key = `${wanted}|${normaliseTitle(c.title)}`
    if (have.has(key) || seen.has(key)) continue
    seen.add(key)
    more.push({
      type: wanted,
      title: c.title,
      year: c.year || null,
      poster_url: c.poster_url || null,
      overview: c.overview || null,
      creators: c.creators || [{ role: role || 'Author', name }],
      external_rating: c.external_rating || null,
      source: c.provider || 'wikidata',
    })
  }

  more.sort((a, b) => (b.year || 0) - (a.year || 0))
  res.json({ name, role, type: wanted, mine: owned.length, more: more.slice(0, 40), userId })
})

/** Provider fan-out for "everything this person made", per media type. */
async function worksByPerson(name, type, role) {
  if (type === 'book' || type === 'audiobook') {
    const hits = await ol.search('', { author: name, limit: 40, type })
    if (hits.length) return hits
  }
  if (type === 'film' || type === 'tv') {
    const hits = await tmdb.personWorks(name, type, { limit: 40 })
    if (hits.length) return hits
  }
  if (type === 'album' || type === 'track') {
    const hits = await mb.searchAlbums(`artist:"${name}"`, 30)
    if (hits.length) return hits
  }

  // Keyless catch-all, and the only option for games.
  const entity = await wikidata.findEntity(name, type)
  if (!entity) return []
  return wikidata.worksBy(entity.qid, type, { role: role || 'Director', limit: 40 })
}

/**
 * What everyone else thinks of it.
 *
 * Which sources apply depends on the medium: IMDb, Rotten Tomatoes and
 * Metacritic for screen (all three from one OMDb request), Open Library for
 * books, and whatever the metadata provider itself scored it. Each entry
 * carries its own scale so a percentage is never silently shown as a mark out
 * of ten.
 */
router.get('/works/:id/ratings', async (req, res) => {
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', Number(req.params.id)))
  if (!work) return res.status(404).json({ error: 'Not found' })

  const out = []
  const screen = work.type === 'film' || work.type === 'tv'

  if (screen) {
    const found = await screenRatings({
      imdbId: work.imdb_id, title: work.title, year: work.year, type: work.type,
    }).catch(() => null)
    if (found?.ratings?.length) out.push(...found.ratings)

    // Remember an IMDb id we did not have, so the next lookup is exact.
    if (found?.imdbId && !work.imdb_id) {
      run("UPDATE works SET imdb_id = ?, updated_at = datetime('now') WHERE id = ?", found.imdbId, work.id)
    }

    if (work.tmdb_id && work.external_rating) {
      out.push({
        source: 'TMDB',
        score: work.external_rating,
        scale: 10,
        display: work.external_rating.toFixed(1),
        votes: work.metadata?.vote_count ?? null,
        url: `https://www.themoviedb.org/${work.type === 'tv' ? 'tv' : 'movie'}/${work.tmdb_id}`,
      })
    }
  }

  if (work.type === 'book' || work.type === 'audiobook') {
    if (work.external_rating) {
      out.push({
        source: 'Open Library',
        score: work.external_rating,
        scale: 10,
        display: work.external_rating.toFixed(1),
        votes: work.metadata?.ratings_count ?? null,
        /*
         * The id is stored with its "/works/" prefix stripped, so it has to go
         * back on — otherwise this produced openlibrary.orgOL17373843W, which
         * goes nowhere.
         */
        url: work.olid
          ? `https://openlibrary.org/works/${String(work.olid).replace(/^\/?(works\/)?/, '')}`
          : (work.isbn ? `https://openlibrary.org/isbn/${work.isbn}` : null),
      })
    }
    // Goodreads retired its API in 2020, so the best we can honestly offer is
    // a link straight to the book's page there.
    const author = work.creators.find((c) => c.role === 'Author')?.name
    out.push({
      source: 'Goodreads',
      score: null,
      scale: 5,
      display: null,
      url: work.metadata?.goodreads_url
        || `https://www.goodreads.com/search?q=${encodeURIComponent([work.title, author].filter(Boolean).join(' '))}`,
    })
  }

  if (!screen && work.type !== 'book' && work.type !== 'audiobook' && work.external_rating) {
    out.push({
      source: work.metadata?.provider === 'itunes' ? 'Apple' : 'Public',
      score: work.external_rating,
      scale: 10,
      display: work.external_rating.toFixed(1),
      url: work.metadata?.itunes_url || null,
    })
  }

  res.json({
    ratings: out,
    needsOmdbKey: screen && !omdb.hasKey(),
  })
})

/**
 * Series and position for an author's books.
 *
 * Open Library does not carry series information, so this comes from Wikidata,
 * whose coverage is patchy — plenty of books list a series but no number. It
 * is a bonus on top of the results rather than something they wait for, and an
 * empty answer is a perfectly normal outcome.
 */
router.get('/creator/series', async (req, res) => {
  const name = String(req.query.name || '').trim()
  if (!name) return res.status(400).json({ error: 'A name is needed' })

  try {
    const entity = await wikidata.findEntity(name, 'book')
    if (!entity) return res.json({ name, works: [] })
    const works = await wikidata.seriesByAuthor(entity.qid)
    res.json({ name, qid: entity.qid, works: works.filter((w) => w.series) })
  } catch {
    res.json({ name, works: [] })
  }
})

/**
 * The rest of the series or franchise this belongs to.
 *
 * For film, TMDB keeps proper collections — the Dune films, the Potter films —
 * which is exactly the question being asked. For books there is no equivalent:
 * Open Library has no series data at all, so Wikidata fills in where it can
 * and the answer is simply empty where it cannot.
 *
 * Titles already in the library come back flagged, so the carousel can show
 * what you have alongside what you are missing.
 */
router.get('/works/:id/series', async (req, res) => {
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', Number(req.params.id)))
  if (!work) return res.status(404).json({ error: 'Not found' })

  let name = null
  let parts = []

  if (work.type === 'film' && work.metadata?.collection?.id) {
    const found = await tmdb.collection(work.metadata.collection.id).catch(() => null)
    if (found) {
      name = found.name
      parts = found.parts.map((p) => ({
        type: 'film', title: p.title, year: p.year, poster_url: p.poster_url,
        overview: p.overview, tmdb_id: p.tmdb_id, external_rating: p.external_rating,
        creators: p.creators || [],
      }))
    }
  }

  if (!parts.length && (work.type === 'book' || work.type === 'audiobook')) {
    const author = work.creators.find((c) => c.role === 'Author' || !c.role)?.name
    if (author) {
      const entity = await wikidata.findEntity(author, 'book').catch(() => null)
      const works = entity ? await wikidata.seriesByAuthor(entity.qid).catch(() => []) : []
      const mine = works.find((w) => normaliseTitle(w.title) === normaliseTitle(work.title)
        || normaliseTitle(w.title).endsWith(normaliseTitle(work.title)))
      if (mine?.series) {
        name = mine.series
        parts = works
          .filter((w) => w.series === mine.series)
          .sort((a, b) => (a.ordinal ?? 99) - (b.ordinal ?? 99) || (a.year ?? 9999) - (b.year ?? 9999))
          .map((w) => ({
            type: work.type, title: w.title, year: w.year, ordinal: w.ordinal,
            poster_url: null, creators: author ? [{ role: 'Author', name: author }] : [],
          }))
      }
    }
  }

  if (!parts.length) return res.json({ name: null, parts: [] })

  /*
   * Anything already yours is shown as yours: your cover, your rating, how
   * many times you have been through it. A series row full of blank cards
   * next to the same books with covers elsewhere on the page looks broken.
   */
  const owned = new Map(
    all(`SELECT w.id, w.type, w.title, w.creators, w.poster_url,
                (SELECT max(e.rating) FROM entries e WHERE e.work_id = w.id) rating,
                (SELECT count(*) FROM entries e WHERE e.work_id = w.id) entry_count,
                (SELECT max(e.liked) FROM entries e WHERE e.work_id = w.id) liked
           FROM works w`)
      .map((w) => [`${w.type}|${normaliseTitle(w.title)}`, { ...w, creators: json(w.creators, []) }]),
  )

  /*
   * A title on its own is not an identity. Joe Abercrombie wrote "The
   * Heroes"; Stephen Fry wrote "Heroes" — and matching on title alone put
   * Fry's book into Abercrombie's series. Where both sides name someone, they
   * have to agree before this counts as the same book.
   */
  const sameHand = (mine, part) => {
    const a = (mine.creators || []).map((c) => String(c.name).toLowerCase())
    const b = (part.creators || []).map((c) => String(c.name).toLowerCase())
    if (!a.length || !b.length) return true
    return a.some((x) => b.some((y) => x === y
      || x.split(/\s+/).pop() === y.split(/\s+/).pop()))
  }

  const resolved = parts.map((p) => {
    const candidate = owned.get(`${p.type}|${normaliseTitle(p.title)}`, p.year ?? null)
    const mine = candidate && sameHand(candidate, p) ? candidate : null
    return {
      ...p,
      poster_url: mine?.poster_url || p.poster_url || null,
      rating: mine?.rating ?? null,
      entry_count: mine?.entry_count ?? 0,
      liked: Boolean(mine?.liked),
      work_id: mine?.id ?? null,
      inLibrary: Boolean(mine),
      isThisOne: mine?.id === work.id,
    }
  })

  /*
   * Books coming from Wikidata arrive with no artwork at all. Look up covers
   * for the ones that are not yours, a few at a time — a series is rarely
   * more than a dozen, and the results are cached for a fortnight.
   */
  const needArt = resolved.filter((p) => !p.poster_url && (p.type === 'book' || p.type === 'audiobook'))
  if (needArt.length) {
    const author = work.creators.find((c) => c.role === 'Author' || !c.role)?.name
    for (let i = 0; i < needArt.length; i += 4) {
      const batch = needArt.slice(i, i + 4)
      await Promise.all(batch.map(async (p) => {
        const hit = (await ol.search(p.title, { limit: 3, type: 'book', author }).catch(() => []))
          .find((h) => normaliseTitle(h.title) === normaliseTitle(p.title) && h.poster_url)
        if (hit) {
          p.poster_url = hit.poster_url
          p.year = p.year ?? hit.year
        }
      }))
    }
  }

  res.json({ name, parts: resolved })
})

/**
 * What is being talked about right now, per library.
 *
 * Each medium has its own notion of "hot" and its own source: TMDB's trending
 * list for film and TV, Open Library's trending works for books, and Apple's
 * charts for music and podcasts. Games have no free equivalent, so they get an
 * honest empty answer rather than a fabricated one.
 *
 * Anything already in your library is marked rather than hidden — seeing that
 * you have already watched the film everyone is discussing is useful.
 */
router.get('/hot', async (req, res) => {
  const type = TYPES.includes(req.query.type) ? req.query.type : 'film'
  const limit = clamp(Number(req.query.limit) || 24, 1, 50)
  const offset = clamp(Number(req.query.offset) || 0, 0, 400)

  /*
   * The whole chart is fetched, then weighted, then sorted, then paged — in
   * that order. Doing it the other way round sorts each batch of eighteen on
   * its own, so "by rating" produced eighteen descending, then eighteen more
   * descending underneath, which is not a sorted list.
   */
  const pool = Math.min(100, Math.max(offset + limit, 60))
  let items = []
  try {
    if (type === 'film' || type === 'tv') {
      items = await tmdb.trending(type, pool, { offset: 0 })
    } else if (type === 'book' || type === 'audiobook') {
      items = await ol.trending('weekly', { limit: pool, type })
    } else if (['album', 'track', 'podcast'].includes(type)) {
      items = await itunes.charts(type, { limit: pool, country: (setting('watch_region') || 'GB').toLowerCase() })
    } else if (type === 'boardgame') {
      // BoardGameGeek's own hotness list, which is the thing itself rather
      // than a proxy for it — nobody else keeps one.
      items = await bgg.hotDetailed(Math.min(pool, 50))
    } else if (type === 'game') {
      // Peak concurrent players this week: how many people were actually in
      // the game, rather than how many bought it or how it reviewed.
      items = await steam.charts({ limit: Math.min(pool, 50), region: setting('watch_region') || 'GB' })
    }
  } catch {
    items = []
  }

  if (!items.length) {
    /*
     * Board games are the one shelf with nowhere to ask. BoardGameGeek keep
     * exactly this list and nobody else does, and their API now refuses
     * anonymous requests — so the honest answer is to say so and wait for a
     * key rather than invent a chart out of something that is not one.
     */
    return res.json({
      type, source: null, items: [], offset, hasMore: false,
      // Only without a key: with one, an empty chart is just a quiet week.
      unsupported: type === 'boardgame' && !bgg.hasKey(),
    })
  }

  /*
   * Tilt the chart towards what is being watched here.
   *
   * TMDB's trending list is worldwide, and a global chart is dominated by
   * anime and Korean drama in a way that does not reflect a British evening's
   * viewing. Nothing is dropped — plenty of it is excellent and some of it is
   * already in this library — but English-language titles are pulled up a few
   * places, and ones made here further still.
   *
   * A nudge rather than a filter: the point of this page is to say what is
   * going on, and a chart that only showed what is going on in one country
   * would be a worse answer to that.
   */
  // How many of the chart the pageviews had an opinion on, so the page can
  // name its sources truthfully rather than by assumption.
  let wikiSignal = 0

  const HOME = String(setting('watch_region') || 'GB').toUpperCase()
  const homeLanguages = { GB: 'en', US: 'en', IE: 'en', AU: 'en', CA: 'en', NZ: 'en' }
  const ANGLOPHONE = new Set(['GB', 'US', 'IE', 'AU', 'CA', 'NZ'])
  const spoken = homeLanguages[HOME]

  if (type === 'film' || type === 'tv') {
    /*
     * TMDB's trending order is the rate of change of its own page views,
     * which barely tracks its own popularity figure and reflects a user base
     * far more interested in anime than a British evening is. It had MobLand
     * at eleven on a popularity of 302 and LINK CLICK at five on 41.
     *
     * So the chart is ranked on both: mostly on popularity, which is the
     * honest measure of how much attention something is getting, with the
     * trending rank kept as a minority voice because a thing climbing fast
     * is news even before it is big.
     */
    const byPopularity = [...items].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    const popRank = new Map(byPopularity.map((item, i) => [item, i]))

    /*
     * A third source, from outside TMDB entirely: what the English-speaking
     * world actually looked up yesterday. Two TMDB charts agreeing with each
     * other is one opinion stated twice — both are drawn from the same
     * cataloguing-minded audience. Wikipedia pageviews are everybody.
     *
     * Titles outside Wikipedia's top thousand share the mid-point of the
     * places left over, which is the ordinary way to rank ties: not being
     * looked up is real information, but it should not pretend to be a
     * precise placing.
     */
    const wikiViews = await wiki.topViews({ days: 2 }).catch(() => new Map())
    const seenOnWiki = items
      .map((item) => ({ item, views: wikiViews.get(normaliseTitle(item.title)) ?? 0 }))
      .filter((x) => x.views > 0)
      .sort((a, b) => b.views - a.views)
    const wikiRank = new Map(seenOnWiki.map((x, i) => [x.item, i]))
    wikiSignal = seenOnWiki.length
    const wikiTie = (seenOnWiki.length + items.length - 1) / 2

    items = items
      .map((item, i) => {
        /*
         * Where it is actually from, not what language it is filed under.
         * Cyberpunk: Edgerunners is a Japanese anime that TMDB records as
         * English, so weighting on language alone promoted it to the top of
         * the chart — precisely the thing the weighting exists to avoid.
         * origin_country lists the country that made it first.
         */
        const origins = (item.metadata?.countries || []).map((c) => String(c).toUpperCase())
        const primary = origins[0] || null
        const lang = String(item.language || '').toLowerCase()

        let lift = 0
        if (primary === HOME) lift += 7
        else if (primary && ANGLOPHONE.has(primary)) lift += 4
        // Language only speaks for a title that nothing else contradicts.
        if (spoken && lang === spoken && (!primary || ANGLOPHONE.has(primary))) lift += 2

        /*
         * Popularity measures total attention, and long-runners dominate it:
         * The Simpsons scores 3021 where the biggest new drama scores 302.
         * Always being popular is not the same as being the thing of the
         * moment, so age is charged for — but only against titles the
         * trending list has not itself put near the front, because a new
         * season does genuinely put an old show back in the conversation.
         */
        const age = new Date().getFullYear() - (item.year ?? new Date().getFullYear())
        const evergreen = age > 6 && i > 12 ? Math.min(14, (age - 6) * 0.5) : 0

        /*
         * The three sources, averaged. Popularity and the trending order are
         * both TMDB's and are weighted as the one opinion they are; the
         * pageviews carry as much as the pair of them because they are the
         * only reading here that comes from the public rather than from a
         * film database's own users.
         */
        const rank = 0.34 * (popRank.get(item) ?? i)
          + 0.26 * i
          + 0.40 * (wikiRank.get(item) ?? wikiTie)

        return { item, rank: rank - lift + evergreen }
      })
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.item)

    /*
     * TMDB lists some shows twice under one name — a season and its parent,
     * or two cuts of the same thing. A chart with South Park at three and
     * again at eight is just wrong; keep the higher placing.
     */
    const seen = new Set()
    items = items.filter((item) => {
      const key = normaliseTitle(item.title)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const owned = ownedIndex()
  const onList = new Set(
    all("SELECT ifnull(type,'') type, title FROM recs WHERE status = 'open'")
      .map((r) => `${r.type}|${normaliseTitle(r.title)}`),
  )

  const source = type === 'boardgame' ? 'BoardGameGeek, this week'
    : type === 'game' ? 'Steam, by players right now'
    : (type === 'film' || type === 'tv') ? (wikiSignal ? 'TMDB and Wikipedia' : 'TMDB')
    : (type === 'book' || type === 'audiobook') ? 'Open Library'
      : 'Apple'

  /*
   * Other ways to read the chart. "Hot" is the source's own order, which is
   * what the page is for; the rest are for when you want the best-reviewed or
   * the newest of what is current.
   */
  const sort = String(req.query.sort || 'hot')
  if (sort === 'released') {
    items = [...items].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
  } else if (sort === 'rating') {
    items = [...items].sort((a, b) => (b.external_rating ?? 0) - (a.external_rating ?? 0))
  }

  /*
   * What the chart contains, before any of it is filtered away — so the
   * picker offers the genres that are actually in today's chart rather than
   * a fixed list, and still offers them once one has been chosen.
   */
  const genres = genreFacets(items)

  const wantGenre = String(req.query.genre || '').trim()
  if (wantGenre) items = items.filter((it) => matchesGenre(it, wantGenre))

  // Page only once everything has been ordered.
  const total = items.length
  items = items.slice(offset, offset + limit)

  /*
   * IMDb's score on the card, for screen titles.
   *
   * TMDB has its own rating, but it is not the number people mean when they
   * ask how a film is regarded. IMDb has no free API, so this comes through
   * OMDb — one lookup per title, and strictly for the page being returned.
   * It used to run over the whole hundred-title pool before paging, which is
   * eighty lookups nobody asked for and twenty seconds of waiting for them.
   * Cached for a fortnight; a missing answer just leaves the badge off.
   */
  const imdb = new Map()
  if (type === 'film' || type === 'tv') {
    if (imdbdata.hasDataset()) {
      // Local, instant, and nothing to run out of.
      for (const item of items) {
        const score = imdbdata.score({ imdbId: item.imdb_id, title: item.title, year: item.year, type })
        if (score) imdb.set(item.title, { rating: score.rating, votes: score.votes })
      }
    } else if (omdb.hasKey()) {
      const BATCH = 5
      for (let i = 0; i < items.length; i += BATCH) {
        const slice = items.slice(i, i + BATCH)
        await Promise.all(slice.map(async (item) => {
          const found = await omdb.ratings({ title: item.title, year: item.year, type }).catch(() => null)
          const score = (found?.ratings || []).find((r) => r.source === 'IMDb')
          if (score) imdb.set(item.title, { rating: score.score, votes: score.votes ?? null })
        }))
      }
    }
  }


  res.json({
    type,
    source,
    sort,
    genres,
    genre: wantGenre || null,
    offset,
    hasMore: offset + limit < total,
    items: items.map((item) => {
      const key = `${type}|${normaliseTitle(item.title)}`
      const id = owned.get(key, item.year ?? null)
      return {
        type,
        title: item.title,
        year: item.year ?? null,
        poster_url: item.poster_url ?? null,
        overview: item.overview ?? null,
        creators: (item.creators || []).filter((c) => c.role !== 'Cast').slice(0, 2),
        genres: (item.genres || []).slice(0, 3),
        external_rating: item.external_rating ?? null,
        imdb: imdb.get(item.title) ?? null,
        tmdb_id: item.tmdb_id ?? null,
        isbn: item.isbn ?? null,
        olid: item.olid ?? null,
        itunes_id: item.itunes_id ?? null,
        work_id: id,
        inLibrary: Boolean(id),
        onList: onList.has(key),
      }
    }),
  })
})

/**
 * Look something up without adding it.
 *
 * Everything shown that is *not* in your library — the rest of a series, a
 * chart entry, a suggestion — is otherwise a dead end: a cover and a title
 * and no way to find out what it is. This answers "what is this, then?" from
 * the metadata providers, so the decision to add it is an informed one.
 */
router.get('/preview', async (req, res) => {
  const type = TYPES.includes(req.query.type) ? req.query.type : 'film'
  const title = String(req.query.title || '').trim()
  if (!title) return res.status(400).json({ error: 'A title is needed' })

  const creator = String(req.query.creator || '').trim()
  const year = Number(req.query.year) || null
  const seed = {
    type,
    title,
    year,
    creators: creator ? [{ role: type === 'book' ? 'Author' : 'Director', name: creator }] : [],
  }

  let found = null
  try {
    found = await enrich(seed)
  } catch {
    found = null
  }

  // Already yours? Then say so and point at it rather than showing a stranger.
  // The year decides it: four different films are called Resident Evil.
  const mineId = ownedId(type, found?.title || title, found?.year ?? year)
  const mine = mineId ? { id: mineId } : null

  /*
   * The same things a work page shows, for something you do not own: where it
   * is streaming, what the critics made of it, and what it sits next to. A
   * sheet with only a synopsis is a worse answer to "what is this?" than the
   * page you would get if you owned it, and there is no reason for it to be.
   */
  const tmdbId = found?.tmdb_id ?? null
  const screen = type === 'film' || type === 'tv'

  const [watch, ratings, similar] = await Promise.all([
    screen && tmdbId
      ? tmdb.watchProviders(type, tmdbId, String(setting('watch_region') || 'GB').toUpperCase()).catch(() => null)
      : null,
    screen
      ? screenRatings({ imdbId: found?.imdb_id, title: found?.title || title, year: found?.year ?? year, type })
        .catch(() => null)
      : null,
    screen && tmdbId
      ? tmdb.recommendations(type, tmdbId, 10).catch(() => [])
      : [],
  ])

  const owned = ownedIndex()

  res.json({
    found: Boolean(found),
    work_id: mine?.id ?? null,
    watch: watch || null,
    region: String(setting('watch_region') || 'GB').toUpperCase(),
    ratings: ratings?.ratings || [],
    similar: (similar || []).slice(0, 8).map((x) => ({
      type,
      title: x.title,
      year: x.year ?? null,
      poster_url: x.poster_url ?? null,
      creators: (x.creators || []).filter((c) => c.role !== 'Cast').slice(0, 1),
      work_id: owned.get(`${type}|${normaliseTitle(x.title)}`, x.year ?? null),
    })),
    preview: {
      type,
      title: found?.title || title,
      year: found?.year ?? year,
      creators: (found?.creators || seed.creators).filter((c) => c.role !== 'Cast').slice(0, 4),
      cast: (found?.creators || []).filter((c) => c.role === 'Cast').slice(0, 6).map((c) => c.name),
      genres: (found?.genres || []).slice(0, 6),
      overview: found?.overview || null,
      poster_url: found?.poster_url || null,
      runtime: found?.runtime ?? null,
      pages: found?.pages ?? null,
      language: found?.language ?? null,
      external_rating: found?.external_rating ?? null,
      release_date: found?.release_date ?? null,
      provider: found?.provider ?? null,
      tmdb_id: found?.tmdb_id ?? null,
      isbn: found?.isbn ?? null,
      olid: found?.olid ?? null,
    },
  })
})

/**
 * Everything about one person, for the card their name opens.
 *
 * A portrait and a paragraph so you know who they are, then the whole of
 * their output arranged the way you would actually read or watch it —
 * grouped into series, in order, with the ones you already have marked.
 * Adding six books of a series one at a time from search is miserable; this
 * is the page that makes it a few taps.
 */
router.get('/creator/profile', async (req, res) => {
  const name = String(req.query.name || '').trim()
  if (!name) return res.status(400).json({ error: 'A name is needed' })
  const type = TYPES.includes(req.query.type) ? req.query.type : 'book'
  const screen = type === 'film' || type === 'tv'

  // Who they are: TMDB keeps biographies for screen people, Wikipedia for
  // everyone else.
  const profile = screen
    ? await tmdb.person(name).catch(() => null)
    : await wiki.person(name, { hint: 'author' }).catch(() => null)

  // What they made.
  let works = []
  if (screen) {
    works = await tmdb.personWorks(name, type, { limit: 60 }).catch(() => [])
  } else if (gbooks.hasKey()) {
    works = await gbooks.byAuthor(name, { limit: 40, type }).catch(() => [])
  }
  if (!works.length && !screen) {
    works = await ol.search('', { author: name, limit: 40, type }).catch(() => [])
  }

  // Where each one sits in a series, if anywhere.
  const order = new Map()
  if (!screen) {
    const entity = await wikidata.findEntity(name, 'book').catch(() => null)
    const listed = entity ? await wikidata.seriesByAuthor(entity.qid).catch(() => []) : []
    for (const w of listed) {
      if (w.series) order.set(normaliseTitle(w.title), { series: w.series, ordinal: w.ordinal })
    }
  } else {
    for (const w of works) {
      const collection = w.metadata?.collection
      if (collection?.name) order.set(normaliseTitle(w.title), { series: collection.name, ordinal: null })
    }
  }

  const owned = ownedIndex()
  const onList = new Set(
    all("SELECT ifnull(type,'') type, title FROM recs WHERE status = 'open'")
      .map((r) => `${r.type}|${normaliseTitle(r.title)}`),
  )

  const seen = new Set()
  const clean = []
  for (const w of works) {
    if (!w?.title) continue
    const key = normaliseTitle(w.title)
    if (seen.has(key)) continue
    if ((type === 'book' || type === 'audiobook') && bookNoise(w.title)) continue
    seen.add(key)
    const id = owned.get(`${type}|${key}`, w.year ?? null)
    const place = order.get(key) || {}
    clean.push({
      type,
      title: w.title,
      year: w.year ?? null,
      poster_url: w.poster_url ?? null,
      creators: (w.creators || []).filter((c) => c.role !== 'Cast').slice(0, 2),
      external_rating: w.external_rating ?? null,
      series: place.series ?? null,
      ordinal: place.ordinal ?? null,
      work_id: id,
      inLibrary: Boolean(id),
      onList: onList.has(`${type}|${key}`),
    })
  }

  /*
   * Grouped into series, with the standalones gathered at the end. A series
   * reads in its own order; everything else reads newest first.
   */
  const groups = new Map()
  for (const w of clean) {
    const key = w.series || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(w)
  }

  const series = [...groups.entries()]
    .filter(([key]) => key)
    .map(([key, items]) => ({
      name: key,
      items: items.sort((a, b) => (a.ordinal ?? 99) - (b.ordinal ?? 99) || (a.year ?? 0) - (b.year ?? 0)),
    }))
    .sort((a, b) => b.items.length - a.items.length)

  const standalone = (groups.get('') || []).sort((a, b) => (b.year ?? 0) - (a.year ?? 0))

  res.json({
    name: profile?.name || name,
    bio: profile?.bio || null,
    image: profile?.image || null,
    url: profile?.url || null,
    counts: { total: clean.length, yours: clean.filter((w) => w.inLibrary).length },
    series,
    standalone,
  })
})

/**
 * Which seasons of a show you have watched.
 *
 * A series is not one thing you either saw or did not: people watch three
 * seasons and stop, or come back years later for the new one. Entries have
 * always carried a season number — imports fill it in — but there was no way
 * to say so yourself, which left the information only as accurate as whatever
 * export last touched it.
 */
router.get('/works/:id/seasons', async (req, res) => {
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', Number(req.params.id)))
  if (!work) return res.status(404).json({ error: 'Not found' })
  if (work.type !== 'tv') return res.json({ seasons: [] })

  const listed = work.tmdb_id ? await tmdb.seasons(work.tmdb_id).catch(() => []) : []
  const mine = all(
    `SELECT id, season, consumed_on, rating, progress FROM entries
      WHERE work_id = ? ORDER BY ifnull(season, 0)`,
    work.id,
  )
  const byNumber = new Map(mine.filter((e) => e.season != null).map((e) => [e.season, e]))

  /*
   * Where the provider knows nothing — no TMDB id, or a show it has not
   * heard of — fall back to whatever the entries themselves mention, so the
   * list is never empty for a show you have clearly watched.
   */
  const numbers = listed.length
    ? listed.map((s) => s.number)
    : [...new Set(mine.map((e) => e.season).filter((n) => n != null))].sort((a, b) => a - b)

  res.json({
    known: listed.length > 0,
    // An entry with no season at all means "watched it" without saying which.
    unspecified: mine.filter((e) => e.season == null).length,
    seasons: numbers.map((n) => {
      const info = listed.find((s) => s.number === n)
      const entry = byNumber.get(n)
      return {
        number: n,
        name: info?.name || `Season ${n}`,
        episodes: info?.episodes ?? null,
        year: info?.year ?? null,
        air_date: info?.air_date ?? null,
        poster_url: info?.poster_url ?? null,
        watched: Boolean(entry),
        entry_id: entry?.id ?? null,
        consumed_on: entry?.consumed_on ?? null,
        rating: entry?.rating ?? null,
      }
    }),
  })
})

/**
 * Tick seasons off, or un-tick them.
 *
 * Adding one creates an ordinary entry dated to when that season aired,
 * since a series is usually watched around then and a date in the right year
 * beats no date at all. Removing one deletes the entry it made — but never
 * an entry carrying a rating or a review, because that is someone's own work
 * and a checkbox should not throw it away.
 */
router.post('/works/:id/seasons', async (req, res) => {
  const work = hydrate(get('SELECT * FROM works WHERE id = ?', Number(req.params.id)))
  if (!work) return res.status(404).json({ error: 'Not found' })
  if (work.type !== 'tv') return res.status(400).json({ error: 'Only shows have seasons' })

  const wanted = new Set(
    (Array.isArray(req.body?.seasons) ? req.body.seasons : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  )

  const listed = work.tmdb_id ? await tmdb.seasons(work.tmdb_id).catch(() => []) : []
  const mine = all('SELECT id, season, rating, review FROM entries WHERE work_id = ?', work.id)
  const byNumber = new Map(mine.filter((e) => e.season != null).map((e) => [e.season, e]))

  let added = 0
  let removed = 0
  let kept = 0

  for (const n of wanted) {
    if (byNumber.has(n)) continue
    const info = listed.find((s) => s.number === n)
    run(
      `INSERT INTO entries (user_id, work_id, status, consumed_on, season, progress, source)
       VALUES (?, ?, 'completed', ?, ?, ?, 'manual')`,
      currentUserId(req), work.id, info?.air_date || null, n,
      info?.episodes ? `Season ${n} · ${info.episodes} episodes` : `Season ${n}`,
    )
    added++
  }

  for (const [n, entry] of byNumber) {
    if (wanted.has(n)) continue
    if (entry.rating != null || entry.review) { kept++; continue }
    run('DELETE FROM entries WHERE id = ?', entry.id)
    removed++
  }

  res.json({ ok: true, added, removed, keptBecauseRated: kept, work: workWithStats(work.id) })
})

/** Where to watch it, for film and TV. */
router.get('/works/:id/watch', async (req, res) => {
  const work = get('SELECT id, type, tmdb_id, title FROM works WHERE id = ?', Number(req.params.id))
  if (!work) return res.status(404).json({ error: 'Not found' })
  if (work.type !== 'film' && work.type !== 'tv') return res.json({ available: false })
  if (!work.tmdb_id) return res.json({ available: false, reason: 'no-tmdb-id' })
  const region = String(req.query.region || setting('watch_region') || 'GB').toUpperCase()
  const providers = await tmdb.watchProviders(work.type, work.tmdb_id, region)
  res.json({ available: Boolean(providers), region, ...(providers || {}) })
})

/** "This is the wrong film" — re-match and replace the metadata. */
router.post('/works/:id/refresh', (req, res) => {
  const id = Number(req.params.id)
  const work = get('SELECT id FROM works WHERE id = ?', id)
  if (!work) return res.status(404).json({ error: 'Not found' })
  queueEnrichment([id], { force: true })
  res.json({ ok: true })
})

/**
 * Remove several at once.
 *
 * A bad import leaves dozens of titles you never watched, and clearing those
 * one at a time is miserable — so this takes a list. Each is removed the same
 * way a single delete would be, and the count comes back so the UI can say
 * what happened.
 */
router.post('/works/delete', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  if (!ids.length) return res.status(400).json({ error: 'No titles given' })

  let removed = 0
  const titles = []
  for (const id of ids) {
    const work = get('SELECT id, title FROM works WHERE id = ?', id)
    if (!work) continue
    run('DELETE FROM works WHERE id = ?', id)
    removed++
    if (titles.length < 5) titles.push(work.title)
  }
  res.json({ ok: true, removed, titles })
})

router.delete('/works/:id', (req, res) => {
  run('DELETE FROM works WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

/** POST /api/log — the quick-log action, from a library work or a provider hit. */
router.post('/log', (req, res) => {
  const { work_id, work, rating, consumed_on, review, notes, tags, status, is_repeat, liked, progress, season, format } = req.body
  let id = work_id
  if (!id) {
    if (!work?.title || !work?.type) return res.status(400).json({ error: 'work.title and work.type are required' })
    const { work: saved, created } = upsertWork(work)
    id = saved.id
    if (created || !saved.poster_url) queueEnrichment([saved.id])
  }
  const stmt = run(
    `INSERT INTO entries (user_id, work_id, status, rating, liked, consumed_on, is_repeat, season, progress, review, notes, tags, format, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'manual')`,
    currentUserId(req), id, status || 'completed', rating ?? null, liked ? 1 : 0,
    consumed_on === undefined ? today() : consumed_on || null,
    is_repeat ? 1 : 0, season ?? null, progress || null, review || null, notes || null,
    JSON.stringify(tags || []),
    // Only books have a format; everything else is taken in one way.
    ['book', 'audiobook', 'both'].includes(format) ? format : null,
  )
  // Logging something answers any outstanding recommendation for it.
  const w = get('SELECT type, title FROM works WHERE id = ?', id)
  if (w) {
    for (const rec of all("SELECT id, title, type FROM recs WHERE status = 'open'")) {
      if (rec.type === w.type && normaliseTitle(rec.title) === normaliseTitle(w.title)) {
        run("UPDATE recs SET status = 'done', acted_at = datetime('now'), work_id = ? WHERE id = ?", id, rec.id)
      }
    }
  }
  res.json({ ok: true, entry_id: Number(stmt.lastInsertRowid), work: workWithStats(id) })
})

router.patch('/entries/:id', (req, res) => {
  const id = Number(req.params.id)
  const entry = get('SELECT * FROM entries WHERE id = ?', id)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  const patch = {}
  for (const k of ['rating', 'consumed_on', 'review', 'notes', 'status', 'progress', 'season', 'episode', 'format']) {
    if (k in req.body) patch[k] = req.body[k] === '' ? null : req.body[k]
  }
  if ('liked' in req.body) patch.liked = req.body.liked ? 1 : 0
  if ('is_repeat' in req.body) patch.is_repeat = req.body.is_repeat ? 1 : 0
  if ('tags' in req.body) patch.tags = JSON.stringify(req.body.tags || [])
  const keys = Object.keys(patch)
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' })
  run(
    `UPDATE entries SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => patch[k]), id,
  )
  res.json(workWithStats(entry.work_id))
})

router.delete('/entries/:id', (req, res) => {
  const entry = get('SELECT * FROM entries WHERE id = ?', Number(req.params.id))
  if (!entry) return res.status(404).json({ error: 'Not found' })
  run('DELETE FROM entries WHERE id = ?', entry.id)
  res.json({ ok: true, work: workWithStats(entry.work_id) })
})

/** The diary: everything you logged, newest first. */
router.get('/activity', (req, res) => {
  const limit = clamp(Number(req.query.limit) || 40, 1, 200)
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const type = req.query.type && req.query.type !== 'all' ? req.query.type : null
  const rows = all(
    `SELECT e.*, w.title, w.type, w.year, w.poster_url, w.creators
       FROM entries e JOIN works w ON w.id = e.work_id
      WHERE (? IS NULL OR w.type = ?)
      ORDER BY ifnull(e.consumed_on, date(e.created_at)) DESC,
               w.year IS NULL, w.year DESC, w.sort_title ASC
      LIMIT ? OFFSET ?`,
    type, type, limit, offset,
  )
  prioritise(rows.map((r) => ({ id: r.work_id, poster_url: r.poster_url })))
  res.json({
    activity: rows.map((r) => ({
      entry_id: r.id,
      work_id: r.work_id,
      title: r.title,
      type: r.type,
      year: r.year,
      poster_url: r.poster_url,
      creators: json(r.creators, []).filter((c) => c.role !== 'Cast').slice(0, 1),
      rating: r.rating,
      liked: Boolean(r.liked),
      consumed_on: r.consumed_on,
      is_repeat: Boolean(r.is_repeat),
      progress: r.progress,
      review: r.review,
      status: r.status,
      source: r.source,
      tags: json(r.tags, []),
    })),
    total: get('SELECT count(*) c FROM entries').c,
  })
})

/** Search: your own library first, then the metadata providers. */
/**
 * Order the provider results.
 *
 * Books come back with a lot of hangers-on: summaries, study guides, box sets,
 * companions, comic adaptations. Those are sorted into their place rather than
 * merely penalised, because a weight big enough to sink them reliably is also
 * big enough to distort everything else. Summaries and study guides go
 * entirely; collections and companions follow the real books.
 */
function rankRemote(remote, known, score) {
  const clean = []
  const trailing = []

  remote.forEach((r, i) => {
    if (!r || known.has(`${r.type}|${normaliseTitle(r.title)}`)) return
    const noise = (r.type === 'book' || r.type === 'audiobook') ? bookNoise(r.title) : null
    if (noise === 'derivative') return
    ;(noise ? trailing : clean).push({ r, i })
  })

  const byScore = (a, b) => score(b.r, b.i) - score(a.r, a.i)
  return [...clean.sort(byScore), ...trailing.sort(byScore)].map(({ r }) => r)
}

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json({ local: [], remote: [] })
  const type = req.query.type && req.query.type !== 'all' ? req.query.type : null
  // Searching an author or director should find their work, not just titles.
  const like = `%${q.toLowerCase()}%`
  const local = all(
    `${WORK_CARD_SQL}
      WHERE (lower(w.title) LIKE ? OR lower(w.creators) LIKE ?)
        ${type ? 'AND w.type = ?' : ''}
      ORDER BY (CASE WHEN lower(w.title) LIKE ? THEN 0 ELSE 1 END), entry_count DESC, w.sort_title
      LIMIT 12`,
    like, like, ...(type ? [type] : []), like,
  ).map(cardOf)

  let remote = []
  if (req.query.remote !== '0') {
    try {
      const want = Math.min(60, Number(req.query.limit) || 12)
      // "artist", "title" — for when the obvious search is swamped.
      const field = ['artist', 'title'].includes(req.query.field) ? req.query.field : undefined
      remote = type
        ? await searchProviders(type, q, want, { field })
        : await searchAllTypes(q, ['film', 'tv', 'book', 'audiobook', 'album'], Math.ceil(want / 4))
    } catch { remote = [] }
  }

  /*
   * Across types the best match must float to the top, whatever media it is.
   *
   * The providers already return their results in relevance order and they are
   * good at it, so that position is a signal in its own right — without it,
   * searching "The Wheel of Time" put "The Great Hunt (The Wheel of Time Book
   * 2)" above "The Eye of the World", purely because the query appeared inside
   * its title.
   */
  const want = normaliseTitle(q)
  const score = (r, index) => {
    const t = normaliseTitle(r.title)
    /*
     * A title merely *containing* the query barely counts: "The Great Hunt
     * (The Wheel of Time Book 2)" contains it only because the publisher put
     * the series in brackets, and that is no reason to rank it above book one.
     * Leave those to the provider's own ordering.
     */
    let n = t === want ? 100 : t.startsWith(want) ? 70 : t.includes(want) ? 10 : 0

    // Where the provider itself ranked it, worth up to 36.
    n += Math.max(0, 36 - index * 2.5)

    // A subtitle tacked onto an exact match is still an exact match.
    if (!n && t.split(':')[0].trim() === want) n += 60

    if (r.poster_url) n += 6
    if (r.year) n += 2
    if (r.popularity) n += Math.min(10, Math.log10(1 + r.popularity) * 4)
    if (r.external_rating) n += Math.min(4, r.external_rating / 3)

    return n
  }

  const known = new Set(local.map((l) => `${l.type}|${normaliseTitle(l.title)}`))
  res.json({
    local,
    remote: rankRemote(remote, known, score).slice(0, Math.min(60, Number(req.query.limit) || 14))
      .map((r) => ({
        type: r.type, title: r.title, year: r.year, release_date: r.release_date ?? null,
        poster_url: r.poster_url,
        creators: (r.creators || []).filter((c) => c.role !== 'Cast').slice(0, 2),
        genres: (r.genres || []).slice(0, 3), overview: r.overview, provider: r.provider,
        external_rating: r.external_rating ?? null,
        tmdb_id: r.tmdb_id, imdb_id: r.imdb_id, isbn: r.isbn, olid: r.olid,
        itunes_id: r.itunes_id, mbid: r.mbid, runtime: r.runtime, pages: r.pages,
        metadata: r.metadata,
      })),
  })
})

router.get('/sections', (req, res) => {
  const counts = all(`
    SELECT w.type,
           count(DISTINCT w.id) works,
           count(e.id) entries,
           round(avg(e.rating), 2) avg_rating
      FROM works w LEFT JOIN entries e ON e.work_id = w.id
     GROUP BY w.type`)
  const byType = Object.fromEntries(counts.map((c) => [c.type, c]))

  /*
   * The two book shelves are counted by how things were taken in, not by the
   * type column — which says 'book' for all of them — and a title read and
   * also listened to is counted on both.
   */
  for (const shelf of ['book', 'audiobook']) {
    byType[shelf] = get(`
      SELECT count(DISTINCT w.id) works,
             count(e.id) entries,
             round(avg(e.rating), 2) avg_rating
        FROM works w LEFT JOIN entries e ON e.work_id = w.id
       WHERE ${SHELF[shelf]}`) || { works: 0, entries: 0, avg_rating: null }
  }
  res.json(TYPES.map((type) => ({
    type,
    ...SECTIONS[type],
    works: byType[type]?.works || 0,
    entries: byType[type]?.entries || 0,
    avg_rating: byType[type]?.avg_rating ?? null,
  })))
})
