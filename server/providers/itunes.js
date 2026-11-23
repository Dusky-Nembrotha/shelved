import { fetchJson } from '../lib/http.js'
import { parseYear, splitPeople } from '../lib/util.js'

// Keyless, no sign-up, covers films, TV, music, audiobooks, podcasts and ebooks.
const BASE = 'https://itunes.apple.com'
const COUNTRY = process.env.SHELVED_STORE || 'GB'

const ENTITY = {
  film: 'movie',
  tv: 'tvSeason',
  album: 'album',
  track: 'song',
  audiobook: 'audiobook',
  podcast: 'podcast',
  book: 'ebook',
}

function art(url, size = 600) {
  if (!url) return null
  return url.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, `/${size}x${size}bb.jpg`)
}

function normalise(item, type) {
  const title = item.trackName || item.collectionName || item.artistName || ''
  if (!title) return null
  const creators = []
  if (type === 'film') {
    for (const name of splitPeople(item.artistName)) creators.push({ role: 'Director', name })
  } else if (type === 'tv' || type === 'podcast') {
    if (item.artistName) creators.push({ role: 'Network', name: item.artistName })
  } else if (type === 'audiobook') {
    for (const name of splitPeople(item.artistName)) creators.push({ role: 'Author', name })
  } else if (type === 'book') {
    for (const name of splitPeople(item.artistName)) creators.push({ role: 'Author', name })
  } else {
    if (item.artistName) creators.push({ role: 'Artist', name: item.artistName })
  }

  const runtimeMs = item.trackTimeMillis || item.collectionTimeMillis
  return {
    provider: 'itunes',
    type,
    title: title.replace(/,\s*(Season|Series)\s+(\d+)$/i, ', Season $2'),
    year: parseYear(item.releaseDate),
    release_date: item.releaseDate ? item.releaseDate.slice(0, 10) : null,
    creators,
    genres: [item.primaryGenreName, ...(item.genres || [])].filter(Boolean),
    overview: item.longDescription || item.description || item.shortDescription || null,
    runtime: runtimeMs ? Math.round(runtimeMs / 60000) : null,
    episodes: item.trackCount && type === 'tv' ? item.trackCount : null,
    language: item.country || null,
    poster_url: art(item.artworkUrl100 || item.artworkUrl60, 600),
    backdrop_url: art(item.artworkUrl100 || item.artworkUrl60, 1200),
    itunes_id: String(item.trackId || item.collectionId || item.id || ''),
    metadata: {
      itunes_url: item.trackViewUrl || item.collectionViewUrl,
      content_rating: item.contentAdvisoryRating,
      track_count: item.trackCount,
      artist_id: item.artistId,
      collection_id: item.collectionId,
      price: item.trackPrice ?? item.collectionPrice,
      // Needed to show a price as money rather than a bare number.
      currency: item.currency || null,
    },
  }
}

export async function search(type, term, limit = 12, { field } = {}) {
  const entity = ENTITY[type]
  if (!entity || !term) return []

  /*
   * "Everything by this artist", when that is what you meant.
   *
   * Apple's documented `attribute` parameter is ignored by the search
   * endpoint — asking for artistTerm, albumTerm or nothing at all returns
   * identical results, which I checked before relying on it. What does work
   * is finding the artist first and then listing their catalogue, which is
   * what someone typing a band name into a music search is after anyway.
   */
  if (field === 'artist') {
    const byName = await artistId(term)
    if (byName) {
      const albums = await byArtist(type, byName, limit)
      if (albums.length) return albums
    }
  }

  const url = `${BASE}/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=${limit}&country=${COUNTRY}`
  try {
    const data = await fetchJson(url, { ttlSeconds: 60 * 60 * 24 * 14 })
    return (data.results || []).map((r) => normalise(r, type)).filter(Boolean)
  } catch {
    return []
  }
}

export async function lookup(type, itunesId) {
  try {
    const data = await fetchJson(`${BASE}/lookup?id=${encodeURIComponent(itunesId)}&country=${COUNTRY}`)
    const item = (data.results || [])[0]
    return item ? normalise(item, type) : null
  } catch {
    return null
  }
}

/** Everything else by the same artist/author/director — our keyless candidate source. */
/** Apple's id for a performer, so their catalogue can be listed. */
export async function artistId(name) {
  if (!name) return null
  try {
    const data = await fetchJson(
      `${BASE}/search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=1&country=${COUNTRY}`,
      { ttlSeconds: 60 * 60 * 24 * 30 },
    )
    return (data.results || [])[0]?.artistId ?? null
  } catch {
    return null
  }
}

export async function byArtist(type, artistId, limit = 20) {
  const entity = ENTITY[type]
  if (!entity || !artistId) return []
  try {
    const data = await fetchJson(
      `${BASE}/lookup?id=${artistId}&entity=${entity}&limit=${limit}&country=${COUNTRY}`,
      { ttlSeconds: 60 * 60 * 24 * 7 },
    )
    return (data.results || []).slice(1).map((r) => normalise(r, type)).filter(Boolean)
  } catch {
    return []
  }
}


/*
 * Apple's charts. The modern marketing-tools feed is unreliable from some
 * networks, so this uses the long-standing RSS endpoint, which returns the
 * same ordering in a slightly older shape.
 */
const CHART_KIND = {
  album: 'topalbums',
  track: 'topsongs',
  podcast: 'toppodcasts',
  audiobook: 'topaudiobooks',
}

export async function charts(type, { limit = 24, country = 'gb' } = {}) {
  const kind = CHART_KIND[type]
  if (!kind) return []
  try {
    const data = await fetchJson(
      `https://itunes.apple.com/${country}/rss/${kind}/limit=${Math.min(100, limit)}/json`,
      { ttlSeconds: 60 * 60 * 6 },
    )
    const entries = data?.feed?.entry || []
    return entries.map((e) => {
      const art = (e['im:image'] || []).slice(-1)[0]?.label || null
      const title = e['im:name']?.label
      if (!title) return null
      const artist = e['im:artist']?.label || null
      return {
        provider: 'itunes',
        type,
        title,
        year: parseYear(e['im:releaseDate']?.label),
        release_date: e['im:releaseDate']?.label?.slice(0, 10) || null,
        creators: artist ? [{ role: type === 'podcast' ? 'Creator' : 'Artist', name: artist }] : [],
        genres: e.category?.attributes?.label ? [e.category.attributes.label] : [],
        overview: e.summary?.label || null,
        // The RSS artwork is a thumbnail; ask for a usable size.
        poster_url: art ? art.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1') : null,
        backdrop_url: null,
        itunes_id: e.id?.attributes?.['im:id'] || null,
        metadata: { itunes_url: e.id?.label || null, chart: kind },
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}
