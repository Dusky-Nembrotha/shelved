/**
 * Cached artwork is stored as "/artwork/<file>", which is relative to wherever
 * the app is mounted — so it needs the base path putting back on.
 *
 * Anything remote goes through the server instead of straight to the source.
 * A grid asks for eighteen covers at once and Open Library answers a burst
 * like that by refusing most of it, which is why a page of suggestions could
 * arrive with no pictures at all. Fetched from the Pi they come one at a
 * time, politely, and are kept.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

export function artworkUrl(src: string | null | undefined): string | undefined {
  if (!src) return undefined
  if (src.startsWith('/artwork/')) return BASE + src
  if (src.startsWith('https://')) return `${BASE}/api/artwork/fetch?url=${encodeURIComponent(src)}`
  return src
}
