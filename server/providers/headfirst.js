import { fetchText } from '../lib/fetchv4.js'
import { get, run } from '../lib/db.js'

/**
 * What is on in Bristol, read from Headfirst's public listings.
 *
 * Ticketmaster knows about the O2 Academy and the Beacon and nothing else;
 * the gigs worth going to in this city are at the Louisiana, the Exchange,
 * the Thunderbolt and the Croft, and they are sold by the venues themselves
 * through Headfirst. No key exists for any of it, so this reads the pages a
 * person would read.
 *
 * Which means it is scraping, with the two duties that brings. It stays off
 * everything their robots.txt disallows — their /api/v2 and /apps/frontend
 * endpoints are explicitly out, so only the human-facing listing pages are
 * fetched. And it is deliberately noisy about failing: a layout change would
 * otherwise turn into "no gigs this month", which looks exactly like a quiet
 * month and would go unnoticed until someone asked why.
 */

const BASE = process.env.SHELVED_HEADFIRST_BASE || 'https://www.headfirstbristol.co.uk'

/* Long, because a venue's calendar is published weeks ahead and changes slowly. */
const TTL_HOURS = 12
const VENUE_INDEX_TTL_HOURS = 24 * 7

/*
 * The rooms that put bands on, as Headfirst slugs. Their index lists a
 * hundred and thirty venues including every pub with a quiz, and fetching
 * all of them for one tab would be both slow and rude — so this is a chosen
 * list, checked against the live index each time so that a venue which
 * closes or is renamed drops out rather than 404ing forever.
 *
 * To add one: find it at /venues on their site and put its slug here.
 */
const MUSIC_VENUES = [
  'thekla', 'exchange', 'the-louisiana', 'the-fleece', 'strange-brew',
  'the-trinity-centre', 'bristol-beacon', 'bristol-beacon-foyer', 'the-marble-factory',
  'motion', 'lakota', 'o2-academy', 'the-croft', 'the-thunderbolt', 'the-moon-club',
  'the-canteen', 'the-folk-house', 'the-island', 'rough-trade-bristol', 'jam-jar',
  'electric-bristol', 'mr-wolfs', 'the-mount-without', 'the-old-duke', 'the-be-bop-club',
]

/* Pages that are not a venue but carry a lot of what is on. */
const ROUNDUPS = ['gigs-and-live-music', 'whats-on/this-weekend']

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * Their listings give a day and a month and no year — "fri-27-nov".
 *
 * The year is therefore inferred: the next time that date comes round,
 * counting today as still to come. A gig on 27 November read on 23 November
 * is this year's; read on 1 December it is next year's, which is right,
 * because by then the page would not be offering it.
 */
export function dateFromSlug(slug, today = new Date()) {
  const m = String(slug || '').match(/^[a-z]{3}-(\d{1,2})-([a-z]{3})$/i)
  if (!m) return null
  const month = MONTHS[m[2].toLowerCase()]
  if (month == null) return null
  const day = Number(m[1])
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let when = new Date(today.getFullYear(), month, day)
  if (when < base) when = new Date(today.getFullYear() + 1, month, day)
  const pad = (n) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/** Their HTML, cached in the same table every other provider uses. */
async function page(path, ttlHours, space = false) {
  const url = `${BASE}/${path.replace(/^\//, '')}`
  const key = `GET ${url}`
  const cached = get("SELECT body FROM http_cache WHERE key = ? AND expires_at > datetime('now')", key)
  if (cached) return cached.body

  /*
   * Spaced out, because this reads two dozen pages in a row off somebody
   * else's small site twice a day. Cached hits skip the wait, so a warm
   * run costs nothing.
   */
  if (space) await new Promise((r) => setTimeout(r, 400))

  const res = await fetchText(url, {
    headers: {
      // Who we are and why, as their own policy page asks of anything automated.
      'User-Agent': 'Shelved/0.1 (self-hosted personal media log; one reader, cached 12h)',
      Accept: 'text/html',
    },
    timeout: 20000,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  run(
    `INSERT INTO http_cache (key, body, fetched_at, expires_at)
     VALUES (?, ?, datetime('now'), datetime('now', ?))
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    key, res.text, `+${Math.round(ttlHours * 3600)} seconds`,
  )
  return res.text
}

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim()

/**
 * Every event on one of their pages.
 *
 * The event URL is the backbone rather than the surrounding markup, because
 * it is the one thing that is the same on all of their listing layouts and
 * it carries the venue, the date and the id. The display title comes from
 * the link text where there is one, and from the image's alt text where
 * there is not.
 */
export function parseListings(html, { today = new Date() } = {}) {
  const out = []
  const blocks = String(html).split('data-event_id="').slice(1)
  for (const block of blocks) {
    const id = (block.match(/^(\d+)/) || [])[1]
    const link = block.match(
      /href="(?:https?:\/\/[^/]+)?\/whats-on\/([a-z0-9-]+)\/([a-z]{3}-\d{1,2}-[a-z]{3})-([a-z0-9-]*?)-?(\d+)"/i,
    )
    if (!id || !link) continue

    const [, venueSlug, dateSlug] = link
    const href = (block.match(/href="([^"]*\/whats-on\/[^"]+)"/) || [])[1] || ''
    const anchor = block.match(/\/whats-on\/[^"]+"[^>]*>\s*([^<]+?)\s*</)
    const alt = block.match(/alt="([^"]*)"/)
    const image = (block.match(/src="(https?:[^"]*\/images\/events\/[^"]+)"/) || [])[1] || null
    const status = strip((block.match(/c-listing__status[^>]*>([\s\S]{0,160}?)<\/div>\s*<\/div>/) || [])[1] || '')

    /*
     * "Mildred + Myer U Clark in Bristol" and "Mildred + Myer U Clark at The
     * Louisiana" are the same billing with the listing site's own suffix on
     * the end. The acts are what gets matched against your library, so both
     * suffixes come off.
     */
    let title = strip(anchor?.[1] || alt?.[1] || '')
      .replace(/\s+(?:in Bristol|at .+)$/i, '')
      .trim()
    if (!title) continue

    out.push({
      id: `hf${id}`,
      name: title,
      venueSlug,
      date: dateFromSlug(dateSlug, today),
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      image,
      soldOut: /sold\s*out/i.test(status),
      cancelled: /cancell?ed/i.test(status),
      source: 'headfirst',
    })
  }
  return out
}

/** Their venue index: slug → the venue's own name. */
export async function venues() {
  const html = await page('venues', VENUE_INDEX_TTL_HOURS)
  const found = new Map()
  const re = /href="(?:https?:\/\/[^/]+)?\/whats-on\/([a-z0-9-]+)"[^>]*>\s*([^<]{1,80}?)\s*</gi
  let m
  while ((m = re.exec(html))) {
    if (!found.has(m[1])) found.set(m[1], strip(m[2]))
  }
  return found
}

/**
 * Gigs in Bristol between now and `days` ahead.
 *
 * Returns the events and a list of what went wrong getting them, which the
 * caller is expected to show rather than swallow: a page that answers 200
 * and parses to nothing is how a scraper dies quietly.
 */
export async function gigs({ days = 120, today = new Date() } = {}) {
  const warnings = []
  let index = new Map()
  try {
    index = await venues()
    if (index.size < 20) warnings.push(`Their venue index listed only ${index.size} venues — the page may have changed.`)
  } catch (err) {
    warnings.push(`Could not read their venue list: ${err.message}`)
  }

  // Only venues they still list, so a closure or a rename drops out quietly
  // rather than fetching a 404 twice a day forever.
  const live = index.size ? MUSIC_VENUES.filter((slug) => index.has(slug)) : MUSIC_VENUES
  const gone = index.size ? MUSIC_VENUES.filter((slug) => !index.has(slug)) : []
  if (gone.length) warnings.push(`No longer listed: ${gone.join(', ')}.`)

  const paths = [...ROUNDUPS, ...live.map((slug) => `whats-on/${slug}`)]
  const byId = new Map()
  let pagesRead = 0
  let pagesEmpty = 0

  for (const path of paths) {
    let html
    try {
      html = await page(path, TTL_HOURS, pagesRead > 0)
    } catch (err) {
      warnings.push(`${path}: ${err.message}`)
      continue
    }
    pagesRead++
    const found = parseListings(html, { today })
    // A listing page with no listings on it is either a quiet venue or a
    // broken parser, and the two are worth telling apart.
    if (!found.length && /c-listing|data-event_id/.test(html)) {
      pagesEmpty++
      warnings.push(`${path}: the page has listings on it that could not be read.`)
    }
    for (const ev of found) {
      if (!byId.has(ev.id)) byId.set(ev.id, { ...ev, venue: index.get(ev.venueSlug) || ev.venueSlug })
    }
  }

  if (pagesRead && byId.size === 0) {
    warnings.push('Read every page and found no events at all — the listings have probably moved.')
  }

  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const end = new Date(start.getTime() + days * 86400000).toISOString().slice(0, 10)
  const from = start.toISOString().slice(0, 10)

  const events = [...byId.values()]
    .filter((e) => e.date && e.date >= from && e.date <= end && !e.cancelled)
    .sort((a, b) => a.date.localeCompare(b.date))

  return { events, warnings, pagesRead, pagesEmpty, venuesRead: live.length }
}
