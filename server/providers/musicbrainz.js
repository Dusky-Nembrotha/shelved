import { fetchJson } from '../lib/http.js'
import { get } from '../lib/db.js'
import { parseYear } from '../lib/util.js'

// Keyless (rate-limited to ~1 req/sec, which lib/http.js enforces).
const BASE = 'https://musicbrainz.org/ws/2'

export function coverUrl(mbid, size = 500) {
  return mbid ? `https://coverartarchive.org/release-group/${mbid}/front-${size}` : null
}

function normalise(rg) {
  if (!rg || !rg.title) return null
  const artists = (rg['artist-credit'] || []).map((a) => a.name || a.artist?.name).filter(Boolean)
  return {
    provider: 'musicbrainz',
    type: 'album',
    title: rg.title,
    year: parseYear(rg['first-release-date']),
    release_date: rg['first-release-date'] || null,
    creators: artists.map((name) => ({ role: 'Artist', name })),
    genres: (rg.tags || []).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 8).map((t) => t.name),
    poster_url: coverUrl(rg.id, 500),
    backdrop_url: coverUrl(rg.id, 1200),
    mbid: rg.id,
    popularity: rg.score || null,
    metadata: {
      primary_type: rg['primary-type'],
      artist_ids: (rg['artist-credit'] || []).map((a) => a.artist?.id).filter(Boolean),
    },
  }
}

export async function searchAlbums(term, limit = 10) {
  if (!term) return []
  try {
    const data = await fetchJson(
      `${BASE}/release-group?query=${encodeURIComponent(term)}&fmt=json&limit=${limit}&inc=tags`,
      { ttlSeconds: 60 * 60 * 24 * 30 },
    )
    return (data['release-groups'] || [])
      .filter((rg) => ['Album', 'EP', undefined].includes(rg['primary-type']))
      .map(normalise)
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * What an artist plays, in MusicBrainz's own words.
 *
 * The listings sites publish no genres at all — Headfirst gives a billing, a
 * venue and a date — so without this there is no way to tell that Green Lung
 * is stoner doom and therefore squarely your sort of thing. MusicBrainz's
 * community tags are uneven but free, keyless and cached for a month.
 *
 * `cacheOnly` is how the gigs page stays instant: it reads whatever has
 * already been looked up and asks for nothing. A background pass fills the
 * cache in; until it has, an act simply has no genres and falls through to
 * the plain listing, which is the honest answer rather than a slow page.
 */
export async function artistTags(name, { cacheOnly = false } = {}) {
  const raw = String(name || '').trim()
  if (raw.length < 2) return null
  /*
   * Lower-cased before it becomes a URL, because the URL is the cache key.
   * The page asks for "green lung" and the warm-up asked for "GREEN LUNG" —
   * the same question to MusicBrainz, which is case-insensitive, and two
   * different rows in the cache, so the page never found what the warm-up
   * had just fetched. Everything asks the same way now.
   */
  const term = raw.toLowerCase()
  const url = `${BASE}/artist?query=${encodeURIComponent(`artist:"${term}"`)}&fmt=json&limit=3`

  if (cacheOnly) {
    const row = get("SELECT body FROM http_cache WHERE key = ? AND expires_at > datetime('now')", `GET ${url}`)
    if (!row) return null
    try { return tagsFrom(JSON.parse(row.body), term) } catch { return null }
  }

  try {
    const data = await fetchJson(url, { ttlSeconds: 60 * 60 * 24 * 30 })
    return tagsFrom(data, term)
  } catch {
    return null
  }
}

/*
 * Only an exact name match counts. A fuzzy one is how "Love" becomes a
 * Californian psych band and every club night with love in its name starts
 * recommending itself.
 */
function tagsFrom(data, term) {
  const want = String(term).toLowerCase()
  const artist = (data?.artists || []).find((a) => {
    if (String(a.name || '').toLowerCase() === want) return true
    return (a.aliases || []).some((al) => String(al.name || '').toLowerCase() === want)
  })
  if (!artist) return { found: false, genres: [] }
  const tags = [...(artist.genres || []), ...(artist.tags || [])]
    .filter((t) => t?.name && (t.count ?? 1) > 0)
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .map((t) => t.name)
  return {
    found: true,
    name: artist.name,
    mbid: artist.id,
    country: artist.country || null,
    genres: [...new Set(tags)].slice(0, 10),
  }
}

export async function byArtistMbid(artistMbid, limit = 25) {
  if (!artistMbid) return []
  try {
    const data = await fetchJson(
      `${BASE}/release-group?artist=${artistMbid}&type=album|ep&fmt=json&limit=${limit}`,
      { ttlSeconds: 60 * 60 * 24 * 14 },
    )
    return (data['release-groups'] || []).map(normalise).filter(Boolean)
  } catch {
    return []
  }
}

/** Albums tagged with a genre — keyless music candidate generation. */
export async function byTag(tag, limit = 25) {
  if (!tag) return []
  try {
    const data = await fetchJson(
      `${BASE}/release-group?query=tag:"${encodeURIComponent(tag)}"%20AND%20primarytype:album&fmt=json&limit=${limit}`,
      { ttlSeconds: 60 * 60 * 24 * 14 },
    )
    return (data['release-groups'] || []).map(normalise).filter(Boolean)
  } catch {
    return []
  }
}
