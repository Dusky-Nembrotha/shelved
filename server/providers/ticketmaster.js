import { fetchJson } from '../lib/http.js'
import { setting } from '../lib/settings.js'

/**
 * Live music near you, from Ticketmaster's Discovery API.
 *
 * Chosen over the alternatives because the key is free and instant and the
 * British coverage is real: the O2 Academy, the Beacon, the Marble Factory,
 * SWX and every arena within a drive of Bristol sell through it. What it does
 * not have is the small independents — Thekla, the Exchange, the Louisiana —
 * so a gig missing from here is not a gig that is not happening, and the tab
 * says as much rather than implying the listing is complete.
 */

/*
 * Overridable so the parsing can be exercised against a recorded response.
 * There is no sandbox for this API and no key until one is issued, which
 * otherwise leaves the whole of this file unrun until the day it matters.
 */
const BASE = process.env.SHELVED_TICKETMASTER_BASE || 'https://app.ticketmaster.com/discovery/v2'

export function hasKey() {
  return Boolean(setting('ticketmaster_api_key'))
}

function imageOf(images) {
  const usable = (images || []).filter((i) => i.url && i.width >= 300)
  // Prefer something close to square-ish and not enormous.
  usable.sort((a, b) => Math.abs((a.ratio === '1_1' ? 0 : 1)) - Math.abs((b.ratio === '1_1' ? 0 : 1)) || a.width - b.width)
  return usable[0]?.url || (images || [])[0]?.url || null
}

/** One event, in this app's words rather than Ticketmaster's. */
function normalise(ev) {
  const venue = ev._embedded?.venues?.[0]
  const attractions = ev._embedded?.attractions || []
  const classifications = (ev.classifications || []).concat(
    attractions.flatMap((a) => a.classifications || []),
  )
  const genres = [...new Set(classifications.flatMap((c) => [
    c.genre?.name, c.subGenre?.name,
  ]).filter((g) => g && g !== 'Undefined' && g !== 'Other'))]

  const start = ev.dates?.start || {}
  return {
    id: ev.id,
    name: ev.name,
    /*
     * The acts, which is what a gig actually is. Ticketmaster's event name is
     * often a promoter's sentence — "An Evening With…", "X + special guests" —
     * so the attraction names are what get matched against your library.
     */
    artists: attractions.map((a) => a.name).filter(Boolean),
    date: start.localDate || null,
    time: start.localTime || null,
    dateTbd: Boolean(start.dateTBD || start.dateTBA || start.timeTBA),
    onsale: ev.dates?.status?.code || null,
    venue: venue?.name || null,
    city: venue?.city?.name || null,
    distance: typeof ev.distance === 'number' ? ev.distance : null,
    unit: ev.units || null,
    url: ev.url || null,
    image: imageOf(ev.images),
    genres,
    price: (ev.priceRanges || [])[0]
      ? { min: ev.priceRanges[0].min, max: ev.priceRanges[0].max, currency: ev.priceRanges[0].currency }
      : null,
  }
}

/**
 * Every music event within `radius` of `city` between now and `days` ahead.
 *
 * Paged through rather than taking the first 200: a city the size of Bristol
 * runs to several hundred events in four months, and the ones that matter to
 * you are no more likely to be in the first page than the last. Ticketmaster
 * refuses to page deeper than a thousand results, which at 200 a page is
 * page four — hence five pages and no more, whatever it says it has.
 */
export async function musicNear({ city, radiusKm = 40, days = 120, countryCode = 'GB', maxPages = 5 }) {
  const key = setting('ticketmaster_api_key')
  if (!key || !city) return []

  /*
   * The window is rounded to the hour, and that is the whole of why the
   * cache works. The response is cached under its URL, and a URL carrying
   * the time to the second is a different URL every second — so every visit
   * to the tab was a fresh five requests against a 5,000-a-day quota, while
   * the six-hour cache it had just written was never read again.
   */
  const now = new Date()
  now.setMinutes(0, 0, 0)
  const until = new Date(now.getTime() + days * 86400000)
  const stamp = (d) => `${d.toISOString().slice(0, 19)}Z`

  const out = []
  for (let page = 0; page < maxPages; page++) {
    const url = `${BASE}/events.json?apikey=${encodeURIComponent(key)}`
      + `&classificationName=${encodeURIComponent('Music')}`
      + `&city=${encodeURIComponent(city)}&radius=${Math.round(radiusKm)}&unit=km`
      + `&countryCode=${encodeURIComponent(countryCode)}`
      + `&startDateTime=${stamp(now)}&endDateTime=${stamp(until)}`
      + `&size=200&page=${page}&sort=date,asc`
    let data
    try {
      // Six hours: new gigs are announced daily, not hourly, and this is a
      // whole city's listings rather than one lookup.
      data = await fetchJson(url, { ttlSeconds: 60 * 60 * 6 })
    } catch (err) {
      // A bad key is worth saying out loud; an empty page is not.
      if (!out.length) throw err
      break
    }
    const events = data?._embedded?.events || []
    out.push(...events.map(normalise))
    const total = data?.page?.totalPages ?? 1
    // Ticketmaster reports every page it has, then 400s past the thousandth
    // result; believe the cap, not the count.
    if (page + 1 >= Math.min(total, maxPages)) break
  }
  return out
}
