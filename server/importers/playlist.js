import { parseCsvObjects, columnIndex } from '../lib/csv.js'
import { normaliseTitle, parseYear, canonicalGenres } from '../lib/util.js'
import { record, keyFor } from './shared.js'

/**
 * A Spotify playlist exported as a spreadsheet — Exportify's columns, and the
 * same shape anything else that walks the Spotify API produces.
 *
 * This is not a listening history, which is what the Spotify importer handles.
 * A playlist is a statement of taste: you chose every one of these, which is
 * worth far more to the engine than a thousand half-played radio tracks, and
 * worth nothing at all to a diary. So every entry it writes is marked as a
 * backfill — liked, never dated by a day you sat down, and kept out of the
 * counts, the activity feed and the charts. See entries.backfill.
 */

export const id = 'playlist'
export const label = 'Spotify playlist (CSV)'
export const accepts = ['.csv']
export const help = 'A playlist exported to CSV — Exportify (exportify.net) or anything with the same '
  + 'columns. Every track is logged as liked, and dated by the record rather than by a day you listened, '
  + 'so it teaches the taste engine without filling your diary with songs.'

export const options = [
  {
    key: 'floorYears',
    label: 'Date anything older than this many years as exactly that long ago',
    type: 'number',
    default: 30,
  },
  { key: 'maxTrackArtists', label: 'Credit this many artists per track at most', type: 'number', default: 3 },
]

/* The columns that make a playlist export what it is. */
const SIGNATURE = ['track name', 'artist name(s)', 'album name']

export function detect({ headers }) {
  const have = (headers || []).map((h) => String(h).trim().toLowerCase())
  if (!have.length) return { confidence: 0 }
  const hits = SIGNATURE.filter((c) => have.includes(c)).length
  if (hits === SIGNATURE.length && have.includes('track uri')) {
    return { confidence: 0.97, reason: 'Spotify playlist export columns' }
  }
  if (hits === SIGNATURE.length) return { confidence: 0.9, reason: 'Track, artist and album columns' }
  return { confidence: 0 }
}

/**
 * The date rule.
 *
 * A playlist carries no listening dates, so each entry is dated by the
 * record's release — which puts every track somewhere truthful on the
 * timeline. Anything older than the floor is dated at the floor exactly,
 * rather than scattered across the 1960s and 70s: those are records you came
 * to long after they came out, and dating them by pressing date would tell
 * the engine your taste was formed before you were born.
 */
export function entryDate(release, floorISO) {
  const raw = String(release || '').trim()
  const m = raw.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/)
  if (!m) return floorISO
  const iso = `${m[1]}-${m[2] || '01'}-${m[3] || '01'}`
  return iso < floorISO ? floorISO : iso
}

/**
 * YYYY-MM-DD, n years before today, in the calendar you live in.
 *
 * Local rather than UTC, because "thirty years ago" read off a British
 * clock at half past midnight in June is yesterday's date in UTC. And the
 * 29th of February has no anniversary in most years — setFullYear rolls it
 * forward to the 1st of March, which is a day in the wrong direction for a
 * floor, so it is clamped back to the 28th.
 */
export function floorDate(years, now = new Date()) {
  const back = Math.max(0, Number(years) || 0)
  const year = now.getFullYear() - back
  const month = now.getMonth()
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate()
  const day = Math.min(now.getDate(), lastDayOfMonth)
  const pad = (n) => String(n).padStart(2, '0')
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

export function parse(files, opts = {}) {
  const floorISO = floorDate(opts.floorYears ?? 30)
  const maxArtists = Math.max(1, Number(opts.maxTrackArtists ?? opts.minTrackArtists ?? 3))
  const out = []
  const seen = new Set()

  for (const file of files) {
    let rows = []
    let headers = []
    try {
      const parsed = parseCsvObjects(file.text)
      rows = parsed.rows
      headers = parsed.headers
    } catch {
      continue
    }

    /*
     * Columns are found the way detect() recognises them: by their
     * punctuation-free lower-case name. Reading row['Track Name'] exactly
     * meant a file whose header row had been lower-cased still matched at
     * 0.9 confidence and then imported nothing at all, silently.
     */
    const idx = columnIndex(headers)
    const column = (name) => idx.get(name.replace(/[^a-z0-9]/g, '')) || name
    const COL = {
      title: column('track name'),
      artists: column('artist names'),
      album: column('album name'),
      release: column('release date'),
      uri: column('track uri'),
      isrc: column('isrc'),
      genres: column('genres'),
      label: column('record label'),
      added: column('added at'),
      duration: column('duration ms'),
      popularity: column('popularity'),
    }

    for (const row of rows) {
      const title = String(row[COL.title] || '').trim()
      const names = String(row[COL.artists] || '')
        .split(';').map((n) => n.trim()).filter(Boolean)
      if (!title || !names.length) continue

      /*
       * One row per track, not per track per playlist: the same song on three
       * playlists is one thing you like, and logging it three times would
       * treble its weight in the profile.
       */
      /*
       * Keyed on the normalised form where there is one, and on the raw
       * lower-cased text where there is not. "봄날", "소우주" and "∞" all
       * normalise to nothing, so the normalised key alone made every
       * non-Latin title by one artist the same track: two of the three were
       * silently dropped and the third was filed under a key that collided
       * with everything else of its kind.
       */
      const ident = (value) => normaliseTitle(value) || String(value).trim().toLowerCase()
      const key = `${ident(names[0])}|${ident(title)}`
      if (seen.has(key)) continue
      seen.add(key)

      const release = row[COL.release] || ''
      const popularity = Number(row[COL.popularity])
      const album = String(row[COL.album] || '').trim()

      out.push(record({
        type: 'track',
        title,
        year: parseYear(release),
        creators: names.slice(0, maxArtists).map((name) => ({ role: 'Artist', name })),
        genres: canonicalGenres(String(row[COL.genres] || '').split(',').map((g) => g.trim()).filter(Boolean)),
        spotify_id: String(row[COL.uri] || '').split(':').pop() || null,
        popularity: Number.isFinite(popularity) ? popularity : null,
        runtime: row[COL.duration] ? Math.round(Number(row[COL.duration]) / 60000) || null : null,
        metadata: {
          source: 'playlist',
          album: album || null,
          isrc: String(row[COL.isrc] || '') || null,
          label: String(row[COL.label] || '') || null,
          added_at: String(row[COL.added] || '').slice(0, 10) || null,
          release_date: String(release) || null,
        },
        /*
         * Putting a song on a playlist is the whole of the opinion you have
         * expressed about it, and `liked` is where the engine already looks
         * for exactly that — it reads an unrated, liked track as a quiet
         * four stars rather than ignoring it.
         */
        liked: true,
        rating: null,
        consumed_on: entryDate(release, floorISO),
        backfill: true,
        status: 'completed',
        // keyFor drops empty parts, so the same fallback is needed here or
        // every non-Latin title by one artist shares one key.
        external_key: keyFor('playlist', 'track', [ident(names[0]), ident(title)]),
      }))
    }
  }

  return out
}
