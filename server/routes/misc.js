import { Router } from 'express'
import { all, get, run, json, DATA_DIR } from '../lib/db.js'
import { getSettings, saveSettings, publicSettings } from '../lib/settings.js'
import { clearCache } from '../lib/http.js'
import { slugify } from '../lib/util.js'
import { currentUserId } from '../lib/user.js'
import { WORK_CARD_SQL, hydrate } from '../lib/works.js'
import { toCsv } from '../lib/csv.js'
import { queueAll } from '../enrich.js'

export const router = Router()

router.get('/settings', (req, res) => {
  res.json(publicSettings())
})

router.put('/settings', (req, res) => {
  const before = getSettings()
  const patch = { ...req.body }
  // Blank or masked values mean "leave the stored key alone".
  for (const key of ['tmdb_api_key', 'omdb_api_key', 'google_books_api_key', 'anthropic_api_key']) {
    if (patch[key] === undefined) continue
    if (patch[key] === '' || String(patch[key]).startsWith('•')) delete patch[key]
  }
  const after = saveSettings(patch)
  // A newly added TMDB key makes much better film/TV metadata available.
  if (after.tmdb_api_key && after.tmdb_api_key !== before.tmdb_api_key) {
    clearCache()
    queueAll({ onlyMissing: false, type: 'film' })
    queueAll({ onlyMissing: false, type: 'tv' })
  }
  res.json(publicSettings())
})

/* ----------------------------------------------------------------- lists */

router.get('/lists', (req, res) => {
  res.json({
    lists: all(`
      SELECT l.*, count(li.work_id) items,
             (SELECT w.poster_url FROM list_items li2 JOIN works w ON w.id = li2.work_id
               WHERE li2.list_id = l.id AND w.poster_url IS NOT NULL
               ORDER BY li2.position LIMIT 1) cover
        FROM lists l LEFT JOIN list_items li ON li.list_id = l.id
       GROUP BY l.id ORDER BY l.created_at DESC`),
  })
})

router.post('/lists', (req, res) => {
  const { name, description, ranked } = req.body
  if (!name) return res.status(400).json({ error: 'A name is required' })
  let slug = slugify(name)
  if (get('SELECT id FROM lists WHERE slug = ?', slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`
  const stmt = run('INSERT INTO lists (user_id, name, slug, description, ranked) VALUES (?,?,?,?,?)', currentUserId(req), name, slug, description || null, ranked ? 1 : 0)
  res.json(get('SELECT * FROM lists WHERE id = ?', Number(stmt.lastInsertRowid)))
})

router.get('/lists/:slug', (req, res) => {
  const list = get('SELECT * FROM lists WHERE slug = ?', req.params.slug)
  if (!list) return res.status(404).json({ error: 'Not found' })
  const items = all(
    `${WORK_CARD_SQL} JOIN list_items li ON li.work_id = w.id WHERE li.list_id = ? ORDER BY li.position, w.sort_title`,
    list.id,
  ).map((row) => {
    const w = hydrate(row)
    return {
      id: w.id, type: w.type, title: w.title, year: w.year, poster_url: w.poster_url,
      creators: w.creators.filter((c) => c.role !== 'Cast').slice(0, 2), genres: w.genres.slice(0, 3),
      rating: row.rating ?? null, entry_count: row.entry_count ?? 0, last_on: row.last_on ?? null,
    }
  })
  res.json({ list, items })
})

router.post('/lists/:slug/items', (req, res) => {
  const list = get('SELECT * FROM lists WHERE slug = ?', req.params.slug)
  if (!list) return res.status(404).json({ error: 'Not found' })
  const workId = Number(req.body.work_id)
  if (!workId) return res.status(400).json({ error: 'work_id is required' })
  const next = get('SELECT ifnull(max(position), 0) + 1 p FROM list_items WHERE list_id = ?', list.id).p
  run(
    `INSERT INTO list_items (list_id, work_id, position, note) VALUES (?,?,?,?)
     ON CONFLICT(list_id, work_id) DO UPDATE SET note = excluded.note`,
    list.id, workId, req.body.position ?? next, req.body.note || null,
  )
  res.json({ ok: true })
})

router.delete('/lists/:slug/items/:workId', (req, res) => {
  const list = get('SELECT * FROM lists WHERE slug = ?', req.params.slug)
  if (!list) return res.status(404).json({ error: 'Not found' })
  run('DELETE FROM list_items WHERE list_id = ? AND work_id = ?', list.id, Number(req.params.workId))
  res.json({ ok: true })
})

router.delete('/lists/:slug', (req, res) => {
  run('DELETE FROM lists WHERE slug = ?', req.params.slug)
  res.json({ ok: true })
})

/* ------------------------------------------------------------ export / admin */

router.get('/export', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json'
  const rows = all(`
    SELECT w.type, w.title, w.year, w.creators, w.genres, w.runtime, w.pages,
           w.imdb_id, w.tmdb_id, w.isbn, w.asin,
           e.rating, e.liked, e.consumed_on, e.is_repeat, e.status, e.progress, e.review, e.notes, e.tags, e.source,
           -- Carried so that restoring your own export does not turn six
           -- thousand playlist tracks into six thousand diary entries.
           e.backfill
      FROM entries e JOIN works w ON w.id = e.work_id
     ORDER BY e.consumed_on DESC`)

  if (format === 'csv') {
    const headers = ['type', 'title', 'year', 'creators', 'genres', 'rating', 'consumed_on', 'is_repeat',
      'status', 'progress', 'review', 'notes', 'tags', 'runtime', 'pages', 'imdb_id', 'tmdb_id', 'isbn', 'source',
      'backfill']
    const flat = rows.map((r) => ({
      ...r,
      creators: json(r.creators, []).map((c) => c.name).join('; '),
      genres: json(r.genres, []).join('; '),
      tags: json(r.tags, []).join('; '),
      is_repeat: r.is_repeat ? 'yes' : '',
    }))
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="shelved-${new Date().toISOString().slice(0, 10)}.csv"`)
    return res.send(toCsv(headers, flat))
  }

  res.setHeader('Content-Disposition', `attachment; filename="shelved-${new Date().toISOString().slice(0, 10)}.json"`)
  res.json({
    exported_at: new Date().toISOString(),
    entries: rows.map((r) => ({ ...r, creators: json(r.creators, []), genres: json(r.genres, []), tags: json(r.tags, []) })),
    recs: all('SELECT type, title, year, recommender, note, source_url, priority, status, added_at FROM recs'),
    lists: all('SELECT l.name, l.slug, w.type, w.title, w.year FROM lists l JOIN list_items li ON li.list_id = l.id JOIN works w ON w.id = li.work_id ORDER BY l.name, li.position'),
  })
})

router.post('/admin/clear-cache', (req, res) => {
  clearCache()
  res.json({ ok: true })
})

router.post('/admin/reset', (req, res) => {
  if (req.body?.confirm !== 'DELETE EVERYTHING') {
    return res.status(400).json({ error: 'Send {"confirm":"DELETE EVERYTHING"} to wipe the library' })
  }
  for (const table of ['list_items', 'lists', 'entries', 'recs', 'works', 'import_runs', 'rec_cache', 'rec_blocks']) {
    run(`DELETE FROM ${table}`)
  }
  res.json({ ok: true })
})

router.get('/bootstrap', (req, res) => {
  res.json({
    settings: publicSettings(),
    dataDir: DATA_DIR,
    counts: {
      works: get('SELECT count(*) c FROM works').c,
      // The headline is the diary: a bulk-imported playlist is taste, not
      // entries you made. See entries.backfill.
      entries: get('SELECT count(*) c FROM entries WHERE backfill = 0').c,
      backfilled: get('SELECT count(*) c FROM entries WHERE backfill = 1').c,
      recsOpen: get("SELECT count(*) c FROM recs WHERE status = 'open'").c,
      lists: get('SELECT count(*) c FROM lists').c,
    },
    version: '0.1.0',
  })
})
