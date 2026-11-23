import { Router } from 'express'
import { all, json } from '../lib/db.js'
import { setting } from '../lib/settings.js'
import { normaliseTitle } from '../lib/util.js'
import * as ticketmaster from '../providers/ticketmaster.js'
import * as headfirst from '../providers/headfirst.js'

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
 * The same, but keeping the leading article, for matching act names.
 *
 * normaliseTitle drops a leading "the" because "A Thousand Splendid Suns"
 * and "Thousand Splendid Suns" are one book. Band names are not books: with
 * the article gone, a night called HEAVY matched The Heavy, and "Mario Kart
 * With A Band" split to "a band" and matched The Band. Precision matters
 * more than reach here — a wrong gig in "artists you listen to" is worse
 * than a missing one, because the whole point of that list is that it is
 * not a guess.
 */
function actKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/*
 * A bill is rarely one act: "CWFEN / BIRDWITCH / URZAH", "Mildred + Myer U
 * Clark", "Opeth with special guests". Every part is tried, and the whole
 * string too, because plenty of band names contain an "and".
 */
const BILL_SPLIT = /\s*(?:\/|\+|,|•|\u2022|\bwith\b|\bw\/\b|\bpresents?\b|\bfeat\.?\b|\bft\.?\b|\bsupported by\b|\bplus\b|:)\s*/i

function actsIn(billing) {
  const whole = String(billing || '').trim()
  const parts = [whole, ...whole.split(BILL_SPLIT)]
  return [...new Set(parts.map(actKey).filter((p) => p.length > 2))]
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
  const byAct = new Map()
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
      /*
       * The same artist under the stricter, article-keeping key as well.
       * Ticketmaster names an act cleanly and can be matched loosely; a
       * scraped bill is a sentence and has to be matched exactly.
       */
      byAct.set(actKey(c.name), slot)
    }
    for (const g of json(row.genres, [])) {
      const gk = String(g).toLowerCase().trim()
      // An empty genre is a substring of every genre, so it would have
      // matched every event on earth and swamped the real ones.
      if (!gk) continue
      genres.set(gk, (genres.get(gk) || 0) + 1)
    }
  }
  return { artists, byAct, genres }
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

  /*
   * Two sources that answer different questions.
   *
   * Ticketmaster, if a key has been issued, covers the rooms with a box
   * office — the Academy, the Beacon, the arenas — and tells you the genre,
   * which is the only way to guess at a band you have never heard of.
   *
   * Headfirst covers the city: the Louisiana, the Exchange, the Croft, the
   * Thunderbolt, everything that sells its own tickets. It needs no key and
   * knows no genres, so it can say "this is somebody you listen to" and
   * nothing more. It is also Bristol-only, being Bristol's listings site, so
   * it is skipped the moment the town is set to anywhere else.
   */
  const warnings = []
  const sources = []
  const localTown = /^bristol$/i.test(city.trim())

  let events = []
  let keyRefused = false
  if (ticketmaster.hasKey()) {
    try {
      events = await ticketmaster.musicNear({ city, radiusKm, days, countryCode })
      sources.push({ id: 'ticketmaster', label: 'Ticketmaster', events: events.length })
    } catch (err) {
      // The status, not the message: the message contains the request URL,
      // which contains the key, so a key with "401" in it would otherwise
      // turn every failure into "your key is wrong".
      keyRefused = err.status === 401 || err.status === 403
      const safe = String(err.message).replace(/apikey=[^&\s]+/gi, 'apikey=…').slice(0, 160)
      warnings.push(keyRefused
        ? 'Ticketmaster rejected that key — check it in Connections.'
        : `Ticketmaster did not answer: ${safe}`)
    }
  }

  let local = { events: [], warnings: [] }
  if (localTown) {
    try {
      local = await headfirst.gigs({ days })
      sources.push({ id: 'headfirst', label: 'Headfirst Bristol', events: local.events.length })
    } catch (err) {
      warnings.push(`Could not read the Bristol listings: ${String(err.message).slice(0, 160)}`)
    }
    // Anything the scraper noticed about itself — a page that answered but
    // could not be read, a venue that has vanished — is said out loud rather
    // than left to look like a quiet month.
    warnings.push(...local.warnings)
  } else {
    warnings.push(`The Bristol listings are only used for Bristol, so ${city} is Ticketmaster only.`)
  }

  if (!sources.length) {
    return res.status(keyRefused ? 400 : 200).json({
      needsKey: !ticketmaster.hasKey() && !localTown,
      error: warnings[0] || null,
      city, radiusKm, days, warnings, sources: [], yours: [], similar: [], whatsOn: [], counted: 0,
    })
  }

  const { artists, byAct, genres } = myArtists()
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
        source: 'ticketmaster',
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
        source: 'ticketmaster',
        why: [{ artist: null, tracks: 0, reason: `${ev.genres.slice(0, 2).join(' · ') || 'Music'} — your sort of thing` }],
        score,
      })
    }
  }

  /*
   * The scraped half. A bill is a sentence rather than a list of acts, so
   * every part of it is tried against the artists you listen to; anything
   * that matches joins the same list the box office feeds, and the rest
   * becomes the plain what's-on below it.
   */
  const whatsOn = []
  for (const ev of local.events) {
    const fingerprint = `${key(ev.name)}|${ev.date}|${key(ev.venue || '')}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)

    const hits = actsIn(ev.name)
      .map((k) => byAct.get(k))
      .filter(Boolean)
      .sort((a, b) => b.tracks - a.tracks)

    const shaped = {
      id: ev.id,
      name: ev.name,
      artists: hits.length ? [hits[0].name] : [],
      date: ev.date,
      time: null,
      dateTbd: false,
      venue: ev.venue,
      city: 'Bristol',
      url: ev.url,
      image: ev.image,
      genres: [],
      price: null,
      soldOut: ev.soldOut,
      source: 'headfirst',
    }

    if (hits.length) {
      yours.push({
        ...shaped,
        why: hits.slice(0, 2).map((h) => ({
          artist: h.name,
          tracks: h.tracks,
          reason: `${h.tracks} track${h.tracks === 1 ? '' : 's'} of theirs in your library`,
        })),
        score: hits[0].score,
      })
    } else {
      whatsOn.push({ ...shaped, why: [] })
    }
  }

  /* Yours by date: it is a diary, and you need to know what you might miss.
     Guesses by how likely they are, because nobody reads to the bottom. */
  const byDate = (a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(a.date).localeCompare(String(b.date))
  yours.sort(byDate)
  similar.sort((a, b) => b.score - a.score || byDate(a, b))
  whatsOn.sort(byDate)

  res.json({
    city,
    radiusKm,
    days,
    counted: events.length + local.events.length,
    knownArtists: artists.size,
    sources,
    warnings,
    yours,
    similar: similar.slice(0, 40),
    /* The rest of what is on, which is a gig guide rather than a suggestion
       — so it is a month of it, not four. */
    whatsOn: whatsOn.filter((g) => g.date <= new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10)),
  })
})
