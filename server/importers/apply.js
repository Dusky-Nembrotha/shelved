import { all, get, run, tx, json } from '../lib/db.js'
import { upsertWork } from '../lib/works.js'
import { slugify, normaliseTitle, today } from '../lib/util.js'
import { systemUserId } from '../lib/user.js'
import { queueEnrichment, queueAllRecArtwork } from '../enrich.js'

/**
 * Write staged records to the database. Idempotent: re-importing the same
 * export updates rather than duplicates, thanks to external_key.
 */
export function applyRecords(records, { source, filename, dryRun = false, enrich = true } = {}) {
  const summary = {
    source,
    filename: filename || null,
    total: records.length,
    worksAdded: 0,
    entriesAdded: 0,
    entriesUpdated: 0,
    entriesSkipped: 0,
    recsAdded: 0,
    listsTouched: new Set(),
    byType: {},
    samples: [],
    errors: [],
  }

  if (dryRun) {
    for (const r of records.slice(0, 400)) {
      summary.byType[r.type] = (summary.byType[r.type] || 0) + 1
      if (summary.samples.length < 24) {
        summary.samples.push({
          type: r.type, title: r.title, year: r.year, rating: r.rating,
          consumed_on: r.consumed_on, kind: r.kind,
          creators: (r.creators || []).map((c) => c.name).slice(0, 2),
        })
      }
    }
    for (const r of records) summary.byType[r.type] = summary.byType[r.type] || 0
    const counts = {}
    for (const r of records) counts[r.type] = (counts[r.type] || 0) + 1
    summary.byType = counts
    summary.listsTouched = [...new Set(records.filter((r) => r.kind === 'list').map((r) => r.listName))]
    return summary
  }

  const needEnrichment = []

  tx(() => {
    for (const r of records) {
      try {
        summary.byType[r.type] = (summary.byType[r.type] || 0) + 1

        if (r.kind === 'rec') {
          applyRec(r, source, summary)
          continue
        }

        const { work, created } = upsertWork({
          type: r.type,
          title: r.title,
          year: r.year,
          creators: r.creators,
          genres: r.genres,
          runtime: r.runtime,
          pages: r.pages,
          isbn: r.isbn,
          imdb_id: r.imdb_id,
          tmdb_id: r.tmdb_id,
          asin: r.asin,
          spotify_id: r.spotify_id,
          mbid: r.mbid,
          olid: r.olid,
          external_rating: r.external_rating,
          popularity: r.popularity,
          overview: r.overview,
          poster_url: r.poster_url,
          metadata: r.metadata,
        })
        if (created) summary.worksAdded++
        /*
         * Bulk taste imports are not queued for artwork. Six thousand tracks
         * is six thousand provider lookups for covers nobody asked for, which
         * would hold up the enrichment of things you actually logged for days.
         */
        if (!r.backfill && (!work.poster_url || !work.enriched_at)) needEnrichment.push(work.id)

        if (r.kind === 'list') {
          applyList(r, work, summary)
          continue
        }
        applyEntry(r, work, source, summary)
      } catch (err) {
        summary.errors.push(`${r.title}: ${err.message}`)
      }
    }
  })

  summary.listsTouched = [...summary.listsTouched]
  if (enrich && needEnrichment.length) queueEnrichment(needEnrichment)
  if (enrich && summary.recsAdded) queueAllRecArtwork()
  summary.queuedForEnrichment = enrich ? needEnrichment.length : 0
  return summary
}

function applyEntry(r, work, source, summary) {
  let existing = r.external_key
    ? get('SELECT * FROM entries WHERE external_key = ?', r.external_key)
    : undefined

  // Two sources reporting the same work on the same day (Letterboxd and
  // Netflix, say) describe one viewing, not two. Seasons stay separate.
  if (!existing && r.consumed_on) {
    existing = get(
      `SELECT * FROM entries WHERE work_id = ? AND consumed_on = ? AND ifnull(season, -1) = ?`,
      work.id, r.consumed_on, r.season ?? -1,
    )
  }

  // Summary rows (a ratings export, an IMDb rating) describe a viewing that
  // another file may already have logged in more detail: fold them in.
  if (!existing && r.merge) {
    existing = get(
      `SELECT * FROM entries WHERE work_id = ?
        ORDER BY ifnull(consumed_on, created_at) DESC LIMIT 1`,
      work.id,
    )
  }

  if (existing) {
    const patch = {}
    // Anything you typed in here yourself outranks a file. Otherwise a fresh
    // export states your current view, so let it correct an older import —
    // silently keeping stale data was losing real ratings.
    const handEdited = existing.source === 'manual'
    const corrects = (incoming, current) =>
      incoming != null && incoming !== current && (current == null || !handEdited)
    if (corrects(r.rating, existing.rating)) patch.rating = r.rating
    if (r.consumed_on && !existing.consumed_on) patch.consumed_on = r.consumed_on
    if (corrects(r.review, existing.review)) patch.review = r.review
    if (r.notes && !existing.notes) patch.notes = r.notes
    if (r.liked && !existing.liked) patch.liked = 1
    if (r.progress && !existing.progress) patch.progress = r.progress
    /*
     * Never walk a finished entry backwards. A Plex library scan reports
     * films sitting unplayed on the server, and plenty of those were watched
     * years ago somewhere else — folding that in would have marked a hundred
     * and sixty-eight films you have seen as still to watch.
     */
    if (r.status && existing.status !== r.status
      && r.status !== 'completed' && existing.status !== 'completed') patch.status = r.status
    if (!existing.external_key && r.external_key) patch.external_key = r.external_key
    const tags = json(existing.tags, [])
    const merged = [...new Set([...tags, ...(r.tags || [])])]
    if (merged.length !== tags.length) patch.tags = JSON.stringify(merged)

    const keys = Object.keys(patch)
    if (keys.length) {
      run(
        `UPDATE entries SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...keys.map((k) => patch[k]), existing.id,
      )
      summary.entriesUpdated++
    } else {
      summary.entriesSkipped++
    }
    return
  }


  run(
    `INSERT INTO entries (user_id, work_id, status, rating, liked, consumed_on, is_repeat, season, episode,
       progress, review, notes, tags, format, source, external_key, backfill)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    systemUserId(), work.id, r.status || 'completed', r.rating ?? null, r.liked ? 1 : 0, r.consumed_on || null,
    r.is_repeat ? 1 : 0, r.season ?? null, r.episode ?? null, r.progress || null,
    r.review || null, r.notes || null, JSON.stringify(r.tags || []),
    // An import that said "audiobook" was telling us how it was taken in, not
    // what kind of thing it is.
    r.type === 'audiobook' ? 'audiobook' : (work.type === 'book' ? 'book' : null),
    source, r.external_key || null,
    // Taste rather than diary — an importer sets this when the date is the
    // record's rather than a day you were there. See entries.backfill.
    r.backfill ? 1 : 0,
  )
  summary.entriesAdded++
  if (summary.samples.length < 24) {
    summary.samples.push({ type: r.type, title: r.title, year: r.year, rating: r.rating, consumed_on: r.consumed_on, kind: 'entry' })
  }
}

function applyRec(r, source, summary) {
  const existingWork = findExistingWork(r)
  if (r.external_key) {
    const dupe = get('SELECT id FROM recs WHERE external_key = ?', r.external_key)
    if (dupe) { summary.entriesSkipped++; return }
  }
  // Already consumed it? Then the recommendation is moot.
  if (existingWork) {
    const logged = get('SELECT id FROM entries WHERE work_id = ?', existingWork.id)
    if (logged) { summary.entriesSkipped++; return }
  }
  const dupeTitle = get(
    "SELECT id FROM recs WHERE lower(title) = ? AND ifnull(type,'') = ? AND status = 'open'",
    String(r.title).toLowerCase(), r.type || '',
  )
  if (dupeTitle) { summary.entriesSkipped++; return }

  run(
    `INSERT INTO recs (user_id, work_id, type, title, year, creators, poster_url, recommender, source_url,
       note, priority, status, origin, external_key, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    systemUserId(), existingWork?.id ?? null, r.type || null, r.title, r.year ?? null,
    JSON.stringify(r.creators || []), r.poster_url || existingWork?.poster_url || null,
    r.recommender || source, r.source_url || null, r.note || null, r.priority ?? 1,
    'open', 'import', r.external_key || null, r.added_at || today(),
  )
  summary.recsAdded++
}

function applyList(r, work, summary) {
  const name = r.listName || 'Imported list'
  const slug = slugify(name)
  let list = get('SELECT * FROM lists WHERE slug = ?', slug)
  if (!list) {
    run('INSERT INTO lists (user_id, name, slug, description) VALUES (?, ?, ?, ?)', systemUserId(), name, slug, `Imported from ${r.source || 'an export'}`)
    list = get('SELECT * FROM lists WHERE slug = ?', slug)
  }
  run(
    `INSERT INTO list_items (list_id, work_id, position, note) VALUES (?,?,?,?)
     ON CONFLICT(list_id, work_id) DO UPDATE SET position = excluded.position`,
    list.id, work.id, r.position || 0, r.note || null,
  )
  summary.listsTouched.add(name)
}

function findExistingWork(r) {
  if (!r.title) return undefined
  const norm = normaliseTitle(r.title)
  // An audiobook of a book you already have is that same book.
  const type = r.type === 'audiobook' ? 'book' : (r.type || '')
  const rows = all('SELECT id, title, year, poster_url FROM works WHERE type = ?', type)
  return rows.find((w) => normaliseTitle(w.title) === norm && (!r.year || !w.year || Math.abs(w.year - r.year) <= 1))
}
