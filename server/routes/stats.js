import { Router } from 'express'
import { all, get } from '../lib/db.js'
import { SECTIONS } from '../lib/util.js'

export const router = Router()

/** Everything the Stats page draws. */
router.get('/stats', (req, res) => {
  const type = req.query.type && req.query.type !== 'all' ? req.query.type : null
  /*
   * Every figure here is about the log you kept, so backfilled entries — a
   * playlist imported wholesale to describe your taste, carrying the record's
   * release date rather than a day you listened — are left out of all of it.
   * They would otherwise draw a listening history you never had. See
   * entries.backfill.
   */
  const typeClause = `${type ? 'AND w.type = ?' : ''} AND e.backfill = 0`
  const p = type ? [type] : []

  const totals = get(
    `SELECT count(DISTINCT w.id) works, count(e.id) entries,
            round(avg(e.rating), 2) avg_rating,
            sum(CASE WHEN e.rating IS NOT NULL THEN 1 ELSE 0 END) rated,
            sum(ifnull(w.runtime, 0)) minutes,
            sum(ifnull(w.pages, 0)) pages,
            min(e.consumed_on) first_on, max(e.consumed_on) last_on
       FROM entries e JOIN works w ON w.id = e.work_id WHERE 1=1 ${typeClause}`,
    ...p,
  )

  const histogram = all(
    `SELECT e.rating, count(*) c FROM entries e JOIN works w ON w.id = e.work_id
      WHERE e.rating IS NOT NULL ${typeClause} GROUP BY e.rating ORDER BY e.rating`,
    ...p,
  )

  const byMonth = all(
    `SELECT substr(e.consumed_on, 1, 7) month, count(*) c, round(avg(e.rating), 2) avg_rating
       FROM entries e JOIN works w ON w.id = e.work_id
      WHERE e.consumed_on IS NOT NULL ${typeClause}
      GROUP BY month ORDER BY month`,
    ...p,
  )

  const byYear = all(
    `SELECT substr(e.consumed_on, 1, 4) year, count(*) c, round(avg(e.rating), 2) avg_rating
       FROM entries e JOIN works w ON w.id = e.work_id
      WHERE e.consumed_on IS NOT NULL ${typeClause}
      GROUP BY year ORDER BY year`,
    ...p,
  )

  const byType = all(
    `SELECT w.type, count(e.id) entries, count(DISTINCT w.id) works, round(avg(e.rating), 2) avg_rating
       FROM entries e JOIN works w ON w.id = e.work_id
      WHERE e.backfill = 0 GROUP BY w.type ORDER BY entries DESC`,
  ).map((r) => ({ ...r, label: SECTIONS[r.type]?.label || r.type }))

  const releaseYears = all(
    `SELECT (w.year / 10) * 10 decade, count(DISTINCT w.id) c, round(avg(e.rating), 2) avg_rating
       FROM entries e JOIN works w ON w.id = e.work_id
      WHERE w.year IS NOT NULL ${typeClause}
      GROUP BY decade ORDER BY decade`,
    ...p,
  )

  const genreRows = all(
    `SELECT w.genres, e.rating FROM entries e JOIN works w ON w.id = e.work_id WHERE 1=1 ${typeClause}`,
    ...p,
  )
  const genreMap = new Map()
  for (const row of genreRows) {
    let list = []
    try { list = JSON.parse(row.genres) } catch { list = [] }
    for (const g of list.slice(0, 6)) {
      const slot = genreMap.get(g) || { name: g, count: 0, sum: 0, rated: 0 }
      slot.count++
      if (row.rating != null) { slot.sum += row.rating; slot.rated++ }
      genreMap.set(g, slot)
    }
  }
  const genres = [...genreMap.values()]
    .filter((g) => g.count >= 2)
    .map((g) => ({ name: g.name, count: g.count, avg_rating: g.rated ? Math.round((g.sum / g.rated) * 100) / 100 : null }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 14)

  const creatorRows = all(
    `SELECT w.creators, e.rating FROM entries e JOIN works w ON w.id = e.work_id WHERE 1=1 ${typeClause}`,
    ...p,
  )
  const creatorMap = new Map()
  for (const row of creatorRows) {
    let list = []
    try { list = JSON.parse(row.creators) } catch { list = [] }
    for (const c of list) {
      if (!c?.name || c.role === 'Cast' || c.role === 'Contributor' || c.role === 'Network') continue
      const slot = creatorMap.get(c.name) || { name: c.name, role: c.role, count: 0, sum: 0, rated: 0 }
      slot.count++
      if (row.rating != null) { slot.sum += row.rating; slot.rated++ }
      creatorMap.set(c.name, slot)
    }
  }
  const creators = [...creatorMap.values()]
    .filter((c) => c.count >= 2)
    .map((c) => ({ ...c, avg_rating: c.rated ? Math.round((c.sum / c.rated) * 100) / 100 : null }))
    .sort((a, b) => b.count - a.count || (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
    .slice(0, 12)

  // Day-by-day activity grid. The window ends today, unless the library stops
  // earlier (an old export), in which case it ends at the most recent entry.
  const heatmapEnd = get(
    `SELECT min(date('now'), ifnull(max(e.consumed_on), date('now'))) AS day
       FROM entries e JOIN works w ON w.id = e.work_id WHERE 1=1 ${typeClause}`,
    ...p,
  ).day
  const heatmap = all(
    `SELECT e.consumed_on day, count(*) c FROM entries e JOIN works w ON w.id = e.work_id
      WHERE e.consumed_on BETWEEN date(?, '-371 days') AND ? ${typeClause}
      GROUP BY day`,
    heatmapEnd, heatmapEnd, ...p,
  )

  res.json({
    totals: {
      ...totals,
      hours: totals.minutes ? Math.round(totals.minutes / 60) : 0,
      days: totals.minutes ? Math.round((totals.minutes / 1440) * 10) / 10 : 0,
    },
    histogram,
    byMonth,
    byYear,
    byType,
    releaseYears,
    genres,
    creators,
    heatmap,
    heatmapEnd,
    sources: all('SELECT source, count(*) c FROM entries WHERE backfill = 0 GROUP BY source ORDER BY c DESC'),
  })
})
