import { parseDate, parseRating, parseYear, splitPeople, normaliseTitle } from '../lib/util.js'
import { pick, columnIndex } from '../lib/csv.js'

/**
 * Every importer emits this one shape; apply.js does the database work.
 *
 * kind: 'entry'  -> something you consumed (may carry a rating/review/date)
 *       'rec'    -> watchlist / to-read / recommended to you
 *       'list'   -> membership of a named list
 */
export function record(partial) {
  return {
    kind: 'entry',
    type: 'film',
    title: '',
    year: null,
    creators: [],
    rating: null,
    liked: false,
    consumed_on: null,
    is_repeat: false,
    status: 'completed',
    /* Imported to describe taste, not to record an occasion. */
    backfill: false,
    review: null,
    notes: null,
    tags: [],
    season: null,
    episode: null,
    progress: null,
    ...partial,
  }
}

export const helpers = { parseDate, parseRating, parseYear, splitPeople, pick, columnIndex }

/** "Severance: Season 1: Good News About Hell" -> show/season/episode */
export function parseEpisodeTitle(raw) {
  const s = String(raw || '').trim()
  let m = s.match(/^(.*?):\s*(?:Season|Series|Staffel)\s*(\d+)\s*:\s*(.*)$/i)
  if (m) return { show: m[1].trim(), season: Number(m[2]), episodeTitle: m[3].trim() }
  m = s.match(/^(.*?):\s*(?:Season|Series)\s*(\d+)$/i)
  if (m) return { show: m[1].trim(), season: Number(m[2]), episodeTitle: null }
  m = s.match(/^(.*?)\s*[-:]\s*S(\d{1,2})\s*E(\d{1,3})\b\s*[-:]?\s*(.*)$/i)
  if (m) return { show: m[1].trim(), season: Number(m[2]), episode: Number(m[3]), episodeTitle: m[4] || null }
  m = s.match(/^(.*?):\s*(?:Limited Series|Miniseries)\s*:\s*(.*)$/i)
  if (m) return { show: m[1].trim(), season: 1, episodeTitle: m[2].trim() }
  return { show: s, season: null, episodeTitle: null }
}

/**
 * Collapse many episode rows into one entry per show+season so the diary
 * stays readable. Keeps the latest date and the episode count.
 */
export function rollUpEpisodes(rows, { source }) {
  const byKey = new Map()
  for (const row of rows) {
    const key = `${normaliseTitle(row.title)}|${row.season ?? ''}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...row, episodeCount: 1 })
      continue
    }
    prev.episodeCount++
    if (!prev.consumed_on || (row.consumed_on && row.consumed_on > prev.consumed_on)) {
      prev.consumed_on = row.consumed_on
    }
    if (row.rating != null && prev.rating == null) prev.rating = row.rating
  }
  return [...byKey.values()].map((r) => {
    const { episodeCount, ...rest } = r
    const seasonLabel = rest.season ? `Season ${rest.season}` : null
    return record({
      ...rest,
      progress: [seasonLabel, episodeCount > 1 ? `${episodeCount} episodes` : null].filter(Boolean).join(' · ') || null,
      external_key: `${source}:tv:${normaliseTitle(rest.title)}:${rest.season ?? 'x'}`,
    })
  })
}

export function keyFor(source, kind, parts) {
  return [source, kind, ...parts.filter((p) => p != null && p !== '')].join(':').slice(0, 200)
}

/** Heuristic: does this title look like a TV show rather than a film? */
export function looksLikeTv(title) {
  return /:\s*(season|series|limited series|miniseries)\s*\d*/i.test(String(title))
    || /\bS\d{1,2}E\d{1,3}\b/i.test(String(title))
}
