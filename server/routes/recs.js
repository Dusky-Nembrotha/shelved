import { Router } from 'express'
import { all, get, run, json } from '../lib/db.js'
import { recommend, blockRecommendation, profileSummary } from '../recommend.js'
import { genreFacets, matchesGenre } from '../lib/genres.js'
import { canFilterByService, haveServices, filterToServices } from '../lib/streaming.js'
import { setting } from '../lib/settings.js'
import { enrich } from '../providers/index.js'
import { upsertWork } from '../lib/works.js'
import { queueEnrichment } from '../enrich.js'
import { normaliseTitle, today, TYPES } from '../lib/util.js'
import { currentUserId } from '../lib/user.js'

export const router = Router()

/* ------------------------------------------------ the "check this out" inbox */

function recOf(r) {
  return {
    id: r.id,
    work_id: r.work_id,
    type: r.type,
    title: r.title,
    year: r.year,
    creators: json(r.creators, []),
    poster_url: r.poster_url,
    recommender: r.recommender,
    source_url: r.source_url,
    note: r.note,
    priority: r.priority,
    status: r.status,
    origin: r.origin,
    engine_reason: r.engine_reason,
    added_at: r.added_at,
    acted_at: r.acted_at,
  }
}

router.get('/recs', (req, res) => {
  const status = req.query.status || 'open'
  const type = req.query.type && req.query.type !== 'all' ? req.query.type : null
  const rows = all(
    `SELECT * FROM recs
      WHERE (? = 'all' OR status = ?) AND (? IS NULL OR type = ?)
      ORDER BY priority DESC, added_at DESC`,
    status, status, type, type,
  )
  res.json({
    recs: rows.map(recOf),
    counts: Object.fromEntries(
      all('SELECT status, count(*) c FROM recs GROUP BY status').map((r) => [r.status, r.c]),
    ),
  })
})

/** POST /api/recs — jot down something someone told you to watch/read. */
router.post('/recs', async (req, res) => {
  const { title, type, year, recommender, note, source_url, priority, creators, enrichNow = true } = req.body
  if (!title) return res.status(400).json({ error: 'A title is required' })

  let poster_url = req.body.poster_url || null
  let resolved = { year: year ?? null, creators: creators || [] }
  if (enrichNow && type) {
    try {
      const hit = await enrich({ type, title, year, creators })
      if (hit) {
        poster_url = poster_url || hit.poster_url
        resolved = { year: year ?? hit.year, creators: creators?.length ? creators : (hit.creators || []).slice(0, 3) }
      }
    } catch { /* a recommendation without artwork is still a recommendation */ }
  }

  const existingWork = type
    ? all('SELECT id, title FROM works WHERE type = ?', type)
      .find((w) => normaliseTitle(w.title) === normaliseTitle(title))
    : null

  const stmt = run(
    `INSERT INTO recs (user_id, work_id, type, title, year, creators, poster_url, recommender, source_url, note, priority, status, origin, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'open','manual',?)`,
    currentUserId(req), existingWork?.id ?? null, type || null, title, resolved.year ?? null,
    JSON.stringify(resolved.creators || []), poster_url, recommender || null, source_url || null,
    note || null, priority ?? 1, today(),
  )
  res.json(recOf(get('SELECT * FROM recs WHERE id = ?', Number(stmt.lastInsertRowid))))
})

router.patch('/recs/:id', (req, res) => {
  const id = Number(req.params.id)
  const patch = {}
  for (const k of ['title', 'type', 'year', 'recommender', 'note', 'source_url', 'priority', 'status', 'poster_url']) {
    if (k in req.body) patch[k] = req.body[k]
  }
  if (patch.status === 'done' || patch.status === 'dismissed') patch.acted_at = new Date().toISOString()
  const keys = Object.keys(patch)
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' })
  run(`UPDATE recs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), id)
  res.json(recOf(get('SELECT * FROM recs WHERE id = ?', id)))
})

router.delete('/recs/:id', (req, res) => {
  run('DELETE FROM recs WHERE id = ?', Number(req.params.id))
  res.json({ ok: true })
})

/* ------------------------------------------------------- the taste engine */

router.get('/recommendations', async (req, res) => {
  const type = String(req.query.type || 'film')
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'Unknown type' })
  try {
    /*
     * "Show more" asks for a bigger slice, so the ceiling has to be well above
     * the first page — it used to stop at 24, which meant one press worked and
     * the next did nothing at all. Breadth grows with it so the candidate pool
     * keeps up rather than the list simply running dry.
     */
    const limit = Math.min(90, Math.max(1, Number(req.query.limit) || 12))
    const wantGenre = String(req.query.genre || '').trim()

    /*
     * Filtering by genre needs more than a page to filter: a shelf of
     * eighteen might hold two westerns, and showing two is not a page. Ask
     * for the whole ranking and cut it down here — the list is cached either
     * way, so the wider ask costs nothing after the first.
     */
    const result = await recommend(type, {
      limit: (wantGenre || req.query.onServices === '1') ? 90 : limit,
      force: req.query.force === '1',
      breadth: Number(req.query.breadth) || Math.min(2.5, 1 + (limit - 18) / 36),
    })

    const genres = genreFacets(result.picks)
    let picks = wantGenre
      ? result.picks.filter((p) => matchesGenre(p, wantGenre))
      : result.picks

    /*
     * Narrowed to what you subscribe to, if asked. The whole ranking is
     * checked rather than the first page of it, so a suggestion deep in the
     * list that happens to be on Netflix can still surface — stopping once
     * there are enough, since each title is a lookup.
     */
    const onServices = req.query.onServices === '1' && canFilterByService(type) && haveServices()
    if (onServices) {
      picks = await filterToServices(picks, type, {
        region: String(setting('watch_region') || 'GB').toUpperCase(),
        need: limit,
      })
    }

    res.json({
      ...result,
      picks: picks.slice(0, limit),
      genres,
      genre: wantGenre || null,
      onServices,
      canFilterByService: canFilterByService(type) && haveServices(),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/recommendations/dismiss', (req, res) => {
  const { fingerprint, reason, pick } = req.body
  const fp = fingerprint || pick?.fingerprint
  if (!fp) return res.status(400).json({ error: 'fingerprint is required' })
  // The pick travels with the verdict: what you turned down is the part
  // worth learning from, and it is gone the moment the card is.
  blockRecommendation(fp, reason, pick)
  res.json({ ok: true })
})

/** Move an engine suggestion into the inbox so it is not forgotten. */
router.post('/recommendations/save', (req, res) => {
  const p = req.body.pick
  if (!p?.title) return res.status(400).json({ error: 'pick.title is required' })
  const stmt = run(
    `INSERT INTO recs (user_id, type, title, year, creators, poster_url, recommender, note, priority, status, origin, engine_reason, engine_score, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,'open','engine',?,?,?)`,
    currentUserId(req), p.type || null, p.title, p.year ?? null, JSON.stringify(p.creators || []), p.poster_url || null,
    'Shelved taste engine', (p.reasons || []).join(' · ') || null, req.body.priority ?? 1,
    (p.reasons || []).join(' · ') || null, p.score ?? null, today(),
  )
  res.json(recOf(get('SELECT * FROM recs WHERE id = ?', Number(stmt.lastInsertRowid))))
})

/** Log an engine suggestion (or an inbox item) straight away. */
router.post('/recommendations/log', async (req, res) => {
  const p = req.body.pick || req.body
  if (!p?.title || !p?.type) return res.status(400).json({ error: 'title and type are required' })
  let seed = {
    type: p.type, title: p.title, year: p.year, creators: p.creators,
    release_date: p.release_date || null,
    poster_url: p.poster_url, genres: p.genres, overview: p.overview,
    tmdb_id: p.ids?.tmdb_id, imdb_id: p.ids?.imdb_id, isbn: p.ids?.isbn, olid: p.ids?.olid,
  }
  const { work, created } = upsertWork(seed)
  if (created || !work.poster_url) queueEnrichment([work.id])
  /*
   * A series is watched over weeks and nobody sets a date for every show they
   * tick off, so "today" is almost always wrong. Its first air date is at
   * least in the right era, and the sheet that follows can correct it.
   * Anything the caller states explicitly wins, including an explicit null.
   */
  const airDate = work.release_date || p.release_date || (p.year ? `${p.year}-01-01` : null)
  const consumedOn = req.body.consumed_on !== undefined
    ? req.body.consumed_on
    : (work.type === 'tv' && airDate ? airDate : today())
  const stmt = run(
    `INSERT INTO entries (user_id, work_id, status, rating, consumed_on, format, source)
     VALUES (?, ?, 'completed', ?, ?, ?, 'recommendation')`,
    currentUserId(req), work.id, req.body.rating ?? null, consumedOn,
    ['book', 'audiobook', 'both'].includes(req.body.format) ? req.body.format
      : (work.type === 'book' ? 'book' : null),
  )
  if (req.body.rec_id) {
    run("UPDATE recs SET status = 'done', acted_at = datetime('now'), work_id = ? WHERE id = ?", work.id, Number(req.body.rec_id))
  }
  // The entry id too, so whatever added it can offer a rating and a date
  // without having to go and find the entry again.
  res.json({ ok: true, work_id: work.id, entry_id: Number(stmt.lastInsertRowid), title: work.title, type: work.type, consumed_on: consumedOn })
})

router.get('/profile', (req, res) => {
  res.json(profileSummary())
})
