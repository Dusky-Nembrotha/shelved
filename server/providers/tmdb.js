import { fetchJson } from '../lib/http.js'
import { setting } from '../lib/settings.js'
import { parseYear } from '../lib/util.js'

// Optional: needs a free API key pasted into Settings. Far richer than the
// keyless sources for film and TV (genres, cast, keywords, similar titles).
const BASE = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p'

export function hasKey() {
  return Boolean(setting('tmdb_api_key'))
}

function url(path, params = {}) {
  const key = setting('tmdb_api_key')
  const qs = new URLSearchParams({ api_key: key, language: 'en-GB', ...params })
  return `${BASE}${path}?${qs}`
}

const poster = (p, size = 'w500') => (p ? `${IMG}/${size}${p}` : null)

/*
 * Search, discover and recommendation results carry `genre_ids`, not genre
 * names — only a full detail fetch has the names. Without this map every
 * candidate arrived genre-less, which left the taste profile with nothing to
 * match on but the decade, and made every suggestion a coin toss.
 */
const genreMaps = new Map()

async function genreMap(type) {
  const key = type === 'tv' ? 'tv' : 'movie'
  if (genreMaps.has(key)) return genreMaps.get(key)
  try {
    const data = await fetchJson(url(`/genre/${key}/list`), { ttlSeconds: 60 * 60 * 24 * 30 })
    const map = new Map((data.genres || []).map((g) => [g.id, g.name]))
    genreMaps.set(key, map)
    return map
  } catch {
    return new Map()
  }
}

/** Fill in genre names on results that only came with ids. */
function withGenreNames(items, map) {
  for (const item of items) {
    if (item.genres?.length || !item.metadata?.genre_ids?.length) continue
    item.genres = item.metadata.genre_ids.map((id) => map.get(id)).filter(Boolean)
  }
  return items
}

function normalise(item, type) {
  const isTv = type === 'tv'
  const title = isTv ? item.name : item.title
  if (!title) return null
  const date = isTv ? item.first_air_date : item.release_date
  const creators = []
  for (const c of item.credits?.crew || []) {
    if ((isTv ? ['Creator', 'Executive Producer'] : ['Director']).includes(c.job)) {
      creators.push({ role: c.job, name: c.name })
    }
  }
  for (const c of item.created_by || []) creators.push({ role: 'Creator', name: c.name })
  for (const c of (item.credits?.cast || []).slice(0, 6)) creators.push({ role: 'Cast', name: c.name })

  return {
    provider: 'tmdb',
    type,
    title,
    original_title: isTv ? item.original_name : item.original_title,
    year: parseYear(date),
    release_date: date || null,
    creators,
    genres: (item.genres || []).map((g) => g.name).filter(Boolean),
    overview: item.overview || null,
    runtime: item.runtime || (item.episode_run_time || [])[0] || null,
    seasons: item.number_of_seasons || null,
    episodes: item.number_of_episodes || null,
    language: item.original_language || null,
    poster_url: poster(item.poster_path, 'w500'),
    backdrop_url: poster(item.backdrop_path, 'w1280'),
    tmdb_id: String(item.id),
    imdb_id: item.imdb_id || item.external_ids?.imdb_id || null,
    external_rating: item.vote_average || null,
    popularity: item.popularity || null,
    metadata: {
      genre_ids: (item.genres || []).map((g) => g.id).concat(item.genre_ids || []),
      keywords: ((item.keywords?.keywords || item.keywords?.results || []).map((k) => k.name)).slice(0, 15),
      vote_count: item.vote_count,
      /*
       * origin_country first: it is the only one the list endpoints return,
       * and it is ordered with the country that actually made the thing at
       * the front. production_countries exists only on detail responses.
       */
      countries: [...new Set([
        ...(item.origin_country || []),
        ...(item.production_countries || []).map((c) => c.iso_3166_1),
      ])].filter(Boolean),
      companies: (item.production_companies || []).map((c) => c.name).slice(0, 4),
      status: item.status,
      tagline: item.tagline,
      // The franchise a film belongs to, which is what "more in this series"
      // is built from.
      collection: item.belongs_to_collection
        ? { id: item.belongs_to_collection.id, name: item.belongs_to_collection.name }
        : null,
    },
  }
}

export async function search(type, term, limit = 12) {
  if (!hasKey() || !term) return []
  const path = type === 'tv' ? '/search/tv' : '/search/movie'
  try {
    const data = await fetchJson(url(path, { query: term, include_adult: 'false' }), { ttlSeconds: 60 * 60 * 24 * 7 })
    const hits = (data.results || []).slice(0, limit).map((r) => normalise(r, type)).filter(Boolean)
    return withGenreNames(hits, await genreMap(type))
  } catch {
    return []
  }
}

export async function detail(type, id) {
  if (!hasKey() || !id) return null
  const path = type === 'tv' ? `/tv/${id}` : `/movie/${id}`
  try {
    const data = await fetchJson(url(path, { append_to_response: 'credits,keywords,external_ids' }), {
      ttlSeconds: 60 * 60 * 24 * 30,
    })
    return normalise(data, type)
  } catch {
    return null
  }
}

export async function recommendations(type, id, limit = 20) {
  if (!hasKey() || !id) return []
  const path = type === 'tv' ? `/tv/${id}/recommendations` : `/movie/${id}/recommendations`
  try {
    const data = await fetchJson(url(path), { ttlSeconds: 60 * 60 * 24 * 7 })
    const hits = (data.results || []).slice(0, limit).map((r) => normalise(r, type)).filter(Boolean)
    return withGenreNames(hits, await genreMap(type))
  } catch {
    return []
  }
}

/**
 * TMDB's content-based neighbours, as opposed to /recommendations which is
 * built from what people actually watched together. Keeping both widens the
 * pool and, more usefully, a title that appears in several seeds' lists is
 * far stronger evidence than one that appears in a single list.
 */
export async function similar(type, id, limit = 20) {
  if (!hasKey() || !id) return []
  const path = type === 'tv' ? `/tv/${id}/similar` : `/movie/${id}/similar`
  try {
    const data = await fetchJson(url(path), { ttlSeconds: 60 * 60 * 24 * 7 })
    const hits = (data.results || []).slice(0, limit).map((r) => normalise(r, type)).filter(Boolean)
    return withGenreNames(hits, await genreMap(type))
  } catch {
    return []
  }
}

export async function discover(type, { genreIds = [], people = [], yearFrom, yearTo, limit = 24 } = {}) {
  if (!hasKey()) return []
  const path = type === 'tv' ? '/discover/tv' : '/discover/movie'
  const params = {
    sort_by: 'vote_average.desc',
    'vote_count.gte': type === 'tv' ? '200' : '400',
    include_adult: 'false',
  }
  if (genreIds.length) params.with_genres = genreIds.join('|')
  if (people.length) params.with_people = people.join('|')
  if (yearFrom) params[type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = `${yearFrom}-01-01`
  if (yearTo) params[type === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte'] = `${yearTo}-12-31`
  try {
    const data = await fetchJson(url(path, params), { ttlSeconds: 60 * 60 * 24 * 3 })
    const hits = (data.results || []).slice(0, limit).map((r) => normalise(r, type)).filter(Boolean)
    return withGenreNames(hits, await genreMap(type))
  } catch {
    return []
  }
}

export async function findByExternalId(externalId, type) {
  if (!hasKey() || !externalId) return null
  try {
    const data = await fetchJson(url(`/find/${externalId}`, { external_source: 'imdb_id' }), {
      ttlSeconds: 60 * 60 * 24 * 30,
    })
    const hit = type === 'tv' ? (data.tv_results || [])[0] : (data.movie_results || [])[0]
    if (!hit) return null
    return detail(type, hit.id)
  } catch {
    return null
  }
}

/**
 * What is being watched this week.
 *
 * Paged, because the Hot list loads a screenful at a time and then keeps
 * going as you scroll; TMDB returns twenty per page, so several are fetched
 * and stitched together when more than that is asked for.
 */
export async function trending(type, limit = 20, { offset = 0 } = {}) {
  if (!hasKey()) return []
  const path = `/trending/${type === 'tv' ? 'tv' : 'movie'}/week`
  const need = offset + limit
  const out = []

  for (let page = 1; page <= Math.ceil(need / 20) && page <= 10; page++) {
    try {
      const data = await fetchJson(url(path, { page: String(page) }), { ttlSeconds: 60 * 60 * 12 })
      const hits = (data.results || []).map((r) => normalise(r, type)).filter(Boolean)
      out.push(...hits)
      if (!hits.length || page >= (data.total_pages || 1)) break
    } catch {
      break
    }
  }

  return withGenreNames(out.slice(offset, offset + limit), await genreMap(type))
}

/**
 * Where you can actually watch something.
 *
 * TMDB licenses this from JustWatch, which is why the response carries a
 * JustWatch deep link — and why their terms require JustWatch to be credited
 * wherever it is shown.
 */
export async function watchProviders(type, id, region = 'GB') {
  if (!hasKey() || !id) return null
  const path = type === 'tv' ? `/tv/${id}/watch/providers` : `/movie/${id}/watch/providers`
  try {
    const data = await fetchJson(url(path), { ttlSeconds: 60 * 60 * 24 })
    const here = data?.results?.[region]
    if (!here) return { region, link: null, stream: [], rent: [], buy: [], free: [] }

    const shape = (list) => (list || []).map((p) => ({
      // The id is what "my services" is matched on; names differ by region
      // and by whether an ad tier counts as the same service.
      id: p.provider_id,
      name: p.provider_name,
      logo: p.logo_path ? `${IMG}/w92${p.logo_path}` : null,
      priority: p.display_priority ?? 99,
    })).sort((a, b) => a.priority - b.priority)

    return {
      region,
      link: here.link || null,          // the JustWatch page for this title
      stream: shape(here.flatrate),
      free: shape([...(here.free || []), ...(here.ads || [])]),
      rent: shape(here.rent),
      buy: shape(here.buy),
    }
  } catch {
    return null
  }
}

/** Every poster TMDB holds for a title, best first. */
export async function images(type, id) {
  if (!hasKey() || !id) return []
  const path = type === 'tv' ? `/tv/${id}/images` : `/movie/${id}/images`
  try {
    const data = await fetchJson(url(path, { include_image_language: 'en,null' }), { ttlSeconds: 60 * 60 * 24 * 7 })
    return (data?.posters || [])
      .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
      .slice(0, 12)
      .map((p) => ({
        url: poster(p.file_path, 'w500'),
        full: poster(p.file_path, 'original'),
        width: p.width,
        height: p.height,
        language: p.iso_639_1,
        source: 'TMDB',
      }))
      .filter((p) => p.url)
  } catch {
    return []
  }
}

/**
 * Everything a person is credited on, for "more by this director".
 * `department` filters to the job they are known for, so a search for a
 * director doesn't return the one film they had a cameo in.
 */
export async function personWorks(name, type, { limit = 40 } = {}) {
  if (!hasKey() || !name) return []
  let personId = null
  try {
    const found = await fetchJson(url('/search/person', { query: name }), { ttlSeconds: 60 * 60 * 24 * 30 })
    const hit = (found.results || [])[0]
    if (!hit) return []
    personId = hit.id
  } catch {
    return []
  }

  try {
    const data = await fetchJson(
      url(`/person/${personId}/combined_credits`, {}),
      { ttlSeconds: 60 * 60 * 24 * 7 },
    )
    const wanted = type === 'tv' ? 'tv' : 'movie'
    const crew = (data.crew || []).filter((c) => ['Director', 'Writer', 'Screenplay', 'Novel'].includes(c.job))
    const cast = (data.cast || []).filter((c) => (c.order ?? 99) <= 6)
    const pool = crew.length >= 3 ? crew : [...crew, ...cast]
    return pool
      .filter((c) => c.media_type === wanted)
      .map((c) => normalise(c, type))
      .filter(Boolean)
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      .slice(0, limit)
  } catch {
    return []
  }
}


/** Every film in a franchise, oldest first — the Dune films, the Potter films. */
export async function collection(id, limit = 24) {
  if (!hasKey() || !id) return null
  try {
    const data = await fetchJson(url(`/collection/${id}`), { ttlSeconds: 60 * 60 * 24 * 14 })
    const parts = (data.parts || [])
      .map((p) => normalise(p, 'film'))
      .filter(Boolean)
      .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
      .slice(0, limit)
    return {
      id: data.id,
      name: data.name,
      overview: data.overview || null,
      parts: withGenreNames(parts, await genreMap('film')),
    }
  } catch {
    return null
  }
}

/** A director or actor: portrait and biography, for the person card. */
export async function person(name) {
  if (!hasKey() || !name) return null
  try {
    const found = await fetchJson(url('/search/person', { query: name }), { ttlSeconds: 60 * 60 * 24 * 30 })
    const hit = (found.results || [])[0]
    if (!hit) return null
    const full = await fetchJson(url(`/person/${hit.id}`), { ttlSeconds: 60 * 60 * 24 * 30 })
    return {
      id: hit.id,
      name: full.name || name,
      bio: full.biography || null,
      image: full.profile_path ? `${IMG}/w400${full.profile_path}` : null,
      url: full.homepage || null,
      known_for: full.known_for_department || null,
    }
  } catch {
    return null
  }
}

/** A show's seasons, for ticking off the ones you have watched. */
export async function seasons(id) {
  if (!hasKey() || !id) return []
  try {
    const data = await fetchJson(url(`/tv/${id}`), { ttlSeconds: 60 * 60 * 24 * 7 })
    return (data.seasons || [])
      // Season zero is specials and extras, which nobody tracks as a season.
      .filter((s) => (s.season_number ?? 0) > 0)
      .map((s) => ({
        number: s.season_number,
        name: s.name || `Season ${s.season_number}`,
        episodes: s.episode_count || null,
        air_date: s.air_date || null,
        year: parseYear(s.air_date),
        poster_url: poster(s.poster_path, 'w342'),
      }))
      .sort((a, b) => a.number - b.number)
  } catch {
    return []
  }
}

/**
 * The trailer, if there is one.
 *
 * TMDB returns everything anyone uploaded — clips, featurettes, opening
 * credits, a director talking about a shootout — so this picks the one thing
 * people mean by "trailer": an official one in English, then any trailer,
 * then a teaser. Nothing else is worth a button.
 */
export async function trailer(type, id) {
  if (!hasKey() || !id) return null
  try {
    const data = await fetchJson(
      url(`/${type === 'tv' ? 'tv' : 'movie'}/${id}/videos`, {}),
      { ttlSeconds: 60 * 60 * 24 * 7 },
    )
    const videos = (data?.results || []).filter((v) => v.site === 'YouTube' && v.key)
    const pick = videos.find((v) => v.type === 'Trailer' && v.official)
      || videos.find((v) => v.type === 'Trailer')
      || videos.find((v) => v.type === 'Teaser' && v.official)
      || videos.find((v) => v.type === 'Teaser')
    if (!pick) return null
    return {
      name: pick.name || 'Trailer',
      url: `https://www.youtube.com/watch?v=${pick.key}`,
      thumbnail: `https://i.ytimg.com/vi/${pick.key}/hqdefault.jpg`,
    }
  } catch {
    return null
  }
}

/**
 * Everything you could subscribe to where you live.
 *
 * Films and television have slightly different line-ups, so both are asked
 * and merged — Sky Sports carries no films, BFI Player carries few shows.
 * Ordered the way TMDB orders them, which is roughly by how many people use
 * them, so the list opens with the ones most people mean.
 */
export async function availableProviders(region = 'GB') {
  if (!hasKey()) return []
  const seen = new Map()
  for (const kind of ['movie', 'tv']) {
    try {
      const data = await fetchJson(
        url(`/watch/providers/${kind}`, { watch_region: region }),
        { ttlSeconds: 60 * 60 * 24 * 7 },
      )
      for (const p of data?.results || []) {
        if (!p?.provider_id || seen.has(p.provider_id)) continue
        seen.set(p.provider_id, {
          id: p.provider_id,
          name: p.provider_name,
          logo: p.logo_path ? `${IMG}/w92${p.logo_path}` : null,
          priority: p.display_priority ?? 99,
        })
      }
    } catch { /* one of the two is enough */ }
  }
  return [...seen.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
}
