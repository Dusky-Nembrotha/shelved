import { Router } from 'express'
import { all, json } from '../lib/db.js'
import { setting } from '../lib/settings.js'
import { normaliseTitle } from '../lib/util.js'
import * as ticketmaster from '../providers/ticketmaster.js'

export const router = Router()

/**
 * Gigs you would actually go to.
 *
 * The library knows six thousand songs you chose and nothing about what is on
 * at the Marble Factory on Thursday; the listings know what is on and nothing
 * about you. This is the join: every music event within reach of home for the
 * next few months, ranked by how much of it is already on your shelves.
 *
 * Two kinds of answer, kept apart because they deserve different trust. An
 * artist you have fifty tracks by is a fact. A band whose genre matches your
 * genres is a guess, and is labelled as one.
 */

/** Names compare on their normalised form: "Mötley Crüe" is "motley crue". */
function key(name) {
  return normaliseTitle(name)
}

/**
 * Who you listen to, and how much.
 *
 * Weighted by how many of their tracks you kept rather than by entries alone,
 * because that is the number that separates a band you love from one song you
 * liked once. A rating or a like on top of that counts for more again.
 */
function myArtists() {
  const rows = all(`
    SELECT w.creators, w.genres, count(e.id) entries,
           max(ifnull(e.rating, 0)) rating, max(e.liked) liked
      FROM works w JOIN entries e ON e.work_id = w.id
     WHERE w.type IN ('track', 'album')
     GROUP BY w.id`)

  const artists = new Map()
  const genres = new Map()
  for (const row of rows) {
    // Four stars doubles it; a like on its own is worth half of that again.
    // Playlist tracks arrive liked and unrated, which is the whole of the
    // opinion there is about them.
    const weight = 1 + (row.rating >= 4 ? 1 : 0) + (row.liked ? 0.5 : 0)
    for (const c of json(row.creators, [])) {
      if (!c?.name || (c.role && c.role !== 'Artist')) continue
      const k = key(c.name)
      if (!k) continue
      const slot = artists.get(k) || { name: c.name, tracks: 0, score: 0, rating: null }
      slot.tracks += 1
      slot.score += weight
      if (row.rating) slot.rating = Math.max(slot.rating ?? 0, row.rating)
      artists.set(k, slot)
    }
    for (const g of json(row.genres, [])) {
      const gk = String(g).toLowerCase().trim()
      // An empty genre is a substring of every genre, so it would have
      // matched every event on earth and swamped the real ones.
      if (!gk) continue
      genres.set(gk, (genres.get(gk) || 0) + 1)
    }
  }
  return { artists, genres }
}

/**
 * How much a gig's genres look like your genres.
 *
 * Ticketmaster's vocabulary is coarse — "Rock", "Metal", "Alternative" — so
 * this is deliberately a weak signal: enough to sort one unknown band above
 * another, never enough to be presented as a match.
 */
function genreScore(eventGenres, mine, total) {
  if (!total) return 0
  let best = 0
  for (const g of eventGenres) {
    const needle = String(g).toLowerCase()
    let hits = 0
    for (const [mineGenre, count] of mine) {
      if (mineGenre === needle || mineGenre.includes(needle) || needle.includes(mineGenre)) hits += count
    }
    best = Math.max(best, hits / total)
  }
  return best
}

router.get('/gigs', async (req, res) => {
  const city = String(req.query.city || setting('gigs_city') || 'Bristol').slice(0, 60)
  /*
   * Clamped here rather than trusted. The Settings page keeps these sane but
   * the query string is not the Settings page: ?days=abc made a NaN date and
   * ?radius=abc a NaN radius, both of which left Ticketmaster to reject the
   * request and this to report it as the listings being down.
   */
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
  }
  const radiusKm = num(req.query.radius ?? setting('gigs_radius_km'), 40, 1, 300)
  const days = num(req.query.days ?? setting('gigs_days'), 120, 1, 365)
  // The country the rest of the app already believes you are in.
  const countryCode = String(setting('watch_region') || 'GB').toUpperCase()

  if (!ticketmaster.hasKey()) {
    return res.json({
      needsKey: true, city, radiusKm, days, yours: [], similar: [], counted: 0,
    })
  }

  let events = []
  try {
    events = await ticketmaster.musicNear({ city, radiusKm, days, countryCode })
  } catch (err) {
    /*
     * A rejected key is the one failure worth explaining: everything else
     * here degrades to "nothing on", which is indistinguishable from a
     * quiet month and would hide a broken setting for weeks.
     */
    /*
     * The status, not the message. The message contains the request URL and
     * the URL contains the key, so a key with "401" in it turned every
     * failure into "your key is wrong" and sent you off to replace a working
     * one.
     */
    const bad = err.status === 401 || err.status === 403
    /*
     * Never the raw message: the fetch layer puts the whole request URL in
     * it, and the request URL carries the API key. A failing endpoint would
     * otherwise print the key into the browser, and into whatever the
     * browser's console gets copied into.
     */
    const safe = String(err.message).replace(/apikey=[^&\s]+/gi, 'apikey=…').slice(0, 160)
    return res.status(bad ? 400 : 502).json({
      error: bad
        ? 'Ticketmaster rejected that key — check it in Connections.'
        : `Could not reach the listings: ${safe}`,
    })
  }

  const { artists, genres } = myArtists()
  const totalGenre = [...genres.values()].reduce((a, b) => a + b, 0)

  const yours = []
  const similar = []
  const seen = new Set()

  for (const ev of events) {
    // A cancelled gig is not a gig. Postponed and sold-out ones stay: the
    // first may come back with a date, and the second you may still want to
    // know you missed.
    if (ev.onsale === 'cancelled') continue

    // The same tour at the same venue on the same night, listed twice.
    const fingerprint = `${key(ev.artists[0] || ev.name)}|${ev.date}|${key(ev.venue || '')}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)

    const names = ev.artists.length ? ev.artists : [ev.name]
    const hits = names
      .map((n) => artists.get(key(n)))
      .filter(Boolean)
      .sort((a, b) => b.tracks - a.tracks)

    if (hits.length) {
      yours.push({
        ...ev,
        why: hits.slice(0, 2).map((h) => ({
          artist: h.name,
          tracks: h.tracks,
          reason: `${h.tracks} track${h.tracks === 1 ? '' : 's'} of theirs in your library`,
        })),
        score: hits[0].score,
      })
      continue
    }

    /*
     * The bar is deliberately well above zero. Scored against six thousand
     * tracks almost everything matches something — a jazz brunch scored 2%
     * on the strength of a handful of jazz-rap records and was being offered
     * as "your sort of thing", which is exactly the kind of suggestion that
     * teaches you to stop reading the list.
     */
    const score = genreScore(ev.genres, genres, totalGenre)
    if (score >= 0.05) {
      similar.push({
        ...ev,
        why: [{ artist: null, tracks: 0, reason: `${ev.genres.slice(0, 2).join(' · ') || 'Music'} — your sort of thing` }],
        score,
      })
    }
  }

  /* Yours by date: it is a diary, and you need to know what you might miss.
     Guesses by how likely they are, because nobody reads to the bottom. */
  /* A date nobody has announced yet sorts last rather than first. */
  const byDate = (a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(a.date).localeCompare(String(b.date))
  yours.sort(byDate)
  similar.sort((a, b) => b.score - a.score || byDate(a, b))

  res.json({
    city,
    radiusKm,
    days,
    counted: events.length,
    knownArtists: artists.size,
    yours,
    similar: similar.slice(0, 40),
  })
})
