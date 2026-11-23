/**
 * Where to buy an audiobook.
 *
 * A suggestion you cannot act on is only half a suggestion: the sheet says
 * what the book is, how long it runs and who narrates it, and then leaves you
 * to go and type the title into Audible yourself. These are the shops that
 * sell it, in the region you have set, with the title and author already in
 * the search box — plus the Apple listing itself when the catalogue could
 * name one, since a direct link beats a search every time.
 *
 * They are plain search URLs built on this machine. Nothing is affiliate
 * tagged, nothing is tracked, and no shop is asked anything until you click.
 */

/*
 * Audible is one shop per country and the wrong one will not sell to you, so
 * the region matters more here than it does for a streaming logo. Anything
 * not listed falls back to .com, which is what Audible's own redirects do.
 */
const AUDIBLE = {
  GB: 'co.uk', IE: 'co.uk', US: 'com', CA: 'ca', AU: 'com.au', NZ: 'com.au',
  IN: 'in', DE: 'de', AT: 'de', CH: 'de', FR: 'fr', BE: 'fr', IT: 'it',
  ES: 'es', JP: 'co.jp', BR: 'com.br',
}

/** Spotify sells audiobooks in these markets only; elsewhere it is a tease. */
const SPOTIFY_AUDIOBOOKS = new Set(['GB', 'US', 'CA', 'AU', 'NZ', 'IE'])

/** Libro.fm pays an independent bookshop of your choosing. English markets. */
const LIBRO = new Set(['GB', 'US', 'CA', 'AU', 'NZ', 'IE'])

/** xigxag is a British shop, and only ships British accounts. */
const XIGXAG = new Set(['GB', 'IE'])

function money(amount, currency) {
  if (typeof amount !== 'number' || !(amount > 0) || !currency) return null
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount)
  } catch {
    return null
  }
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string|null} [opts.author]
 * @param {string} [opts.region]      Two-letter country, as set in Settings.
 * @param {object|null} [opts.apple]  { url, price, currency } when Apple knows it.
 * @returns {{ name: string, url: string, note: string|null, direct: boolean }[]}
 */
export function audiobookStores({ title, author = null, region = 'GB', apple = null }) {
  const name = String(title || '').trim()
  if (!name) return []

  const cc = String(region || 'GB').toUpperCase()
  // The author is part of the search, not decoration: half the audiobooks
  // worth suggesting share a title with a film, a podcast and three others.
  const term = [name, author].filter(Boolean).join(' ')
  const q = encodeURIComponent(term)
  const out = []

  out.push({
    name: 'Audible',
    url: `https://www.audible.${AUDIBLE[cc] || 'com'}/search?keywords=${q}`,
    note: null,
    direct: false,
  })

  if (apple?.url) {
    out.push({
      name: 'Apple Books',
      url: apple.url,
      note: money(apple.price, apple.currency),
      direct: true,
    })
  }

  if (SPOTIFY_AUDIOBOOKS.has(cc)) {
    out.push({
      name: 'Spotify',
      url: `https://open.spotify.com/search/${q}/audiobooks`,
      note: null,
      direct: false,
    })
  }

  if (LIBRO.has(cc)) {
    out.push({
      name: 'Libro.fm',
      url: `https://libro.fm/search?q=${q}`,
      note: 'pays a bookshop',
      direct: false,
    })
  }

  if (XIGXAG.has(cc)) {
    out.push({ name: 'xigxag', url: `https://xigxag.co.uk/search/?q=${q}`, note: null, direct: false })
  }

  return out
}
