import { fetchJson } from '../lib/http.js'
import { fetchText } from '../lib/fetchv4.js'
import { get, run } from '../lib/db.js'

/**
 * Venues that do not put everything on the listings site.
 *
 * Headfirst is the city's aggregator and covers most of it, but not all: it
 * lists seven Electric Bristol nights when Electric Bristol has a hundred,
 * and the one that prompted this — Green Lung, sold out, 17 December — was
 * not among them. That venue is also the one most worth having, being where
 * most of the heavy bills in Bristol end up.
 *
 * So this reads the venue's own site. One entry per venue, deliberately
 * small, and written so that adding another is a few lines rather than a
 * project: give it a name, a WordPress events endpoint and a way to find the
 * date on an event page.
 *
 * Their robots.txt allows everything (Yoast's default "Disallow:" with no
 * path), the listing endpoint is one request, and event pages are fetched a
 * few at a time and kept for twelve hours.
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

export const VENUES = [
  {
    id: 'electric-bristol',
    name: 'Electric Bristol',
    site: 'https://electricbristol.com',
    /* WordPress exposes the events post type; titles and links come free. */
    list: 'https://electricbristol.com/wp-json/wp/v2/events?per_page=100&_fields=slug,title,link',
  },
]

const TTL_HOURS = 12

/** "17th December 2026" → 2026-12-17. */
export function dateInText(text) {
  const m = String(text || '').match(
    /(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i,
  )
  if (!m) return null
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1
  const pad = (n) => String(n).padStart(2, '0')
  return `${m[3]}-${pad(month)}-${pad(Number(m[1]))}`
}

const strip = (html) => String(html)
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&apos;|&rsquo;/g, "'")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/** One page of theirs, cached in the table every provider shares. */
async function page(url, { cacheOnly = false, space = false } = {}) {
  const key = `GET ${url}`
  const cached = get("SELECT body FROM http_cache WHERE key = ? AND expires_at > datetime('now')", key)
  if (cached) return cached.body
  if (cacheOnly) return null

  if (space) await new Promise((r) => setTimeout(r, 400))
  const res = await fetchText(url, {
    headers: {
      'User-Agent': 'Shelved/0.1 (self-hosted personal media log; one reader, cached 12h)',
      Accept: 'text/html',
    },
    timeout: 20000,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  run(
    `INSERT INTO http_cache (key, body, fetched_at, expires_at)
     VALUES (?, ?, datetime('now'), datetime('now', ?))
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    key, res.text, `+${Math.round(TTL_HOURS * 3600)} seconds`,
  )
  return res.text
}

/**
 * Everything these venues have announced.
 *
 * `cacheOnly` is what the gigs page uses: event pages are read from the
 * cache and never fetched in the request path, because a hundred pages is a
 * minute of somebody's time. The warm-up script fetches them.
 */
export async function events({ days = 365, today = new Date(), cacheOnly = false, max = 120 } = {}) {
  const warnings = []
  const out = []
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const from = start.toISOString().slice(0, 10)
  const until = new Date(start.getTime() + days * 86400000).toISOString().slice(0, 10)

  for (const venue of VENUES) {
    let listing
    try {
      listing = await fetchJson(venue.list, { ttlSeconds: TTL_HOURS * 3600 })
    } catch (err) {
      warnings.push(`${venue.name}: could not read its event list (${String(err.message).slice(0, 80)}).`)
      continue
    }
    if (!Array.isArray(listing) || !listing.length) {
      warnings.push(`${venue.name}: its event list came back empty, which it never is.`)
      continue
    }

    let read = 0
    let dated = 0
    for (const item of listing.slice(0, max)) {
      const link = item?.link
      if (!link) continue
      let html
      try {
        html = await page(link, { cacheOnly, space: read > 0 })
      } catch {
        continue
      }
      if (!html) continue
      read++

      const text = strip(html)
      const date = dateInText(text)
      if (!date) continue
      dated++
      if (date < from || date > until) continue

      /*
       * Their page title carries the billing and the sales state — "GREEN
       * LUNG – SOLD OUT" — and the body carries the support. The title is
       * what gets matched, with the sales state taken off it.
       */
      const raw = strip(item.title?.rendered || '')
      const soldOut = /sold\s*out/i.test(raw) || /sold\s*out/i.test(text.slice(0, 400))
      const name = raw.replace(/\s*[–—-]\s*sold\s*out\s*$/i, '').trim()
      if (!name) continue

      out.push({
        id: `vs-${venue.id}-${item.slug}`,
        name,
        venue: venue.name,
        venueSlug: venue.id,
        date,
        url: link,
        image: (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null,
        soldOut,
        cancelled: /cancelled/i.test(raw),
        source: venue.id,
      })
    }

    if (read && !dated) {
      warnings.push(`${venue.name}: read ${read} of its pages and found no dates — its layout has probably changed.`)
    }
  }

  return { events: out.filter((e) => !e.cancelled).sort((a, b) => a.date.localeCompare(b.date)), warnings }
}
