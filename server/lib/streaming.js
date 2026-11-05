/*
 * "Can I actually watch this tonight?"
 *
 * A chart of what everyone is talking about is less useful than a chart of
 * what everyone is talking about *and* you can press play on. This keeps the
 * list of services you pay for and answers that question per title.
 *
 * Only film and television: nothing else here has a streaming service, and
 * offering the filter on books would be a promise the data cannot keep.
 */
import { setting } from './settings.js'
import { tmdb } from '../providers/index.js'

export function myServiceIds() {
  try {
    const list = JSON.parse(setting('watch_services') || '[]')
    return Array.isArray(list) ? list.map(Number).filter(Boolean) : []
  } catch {
    return []
  }
}

export const canFilterByService = (type) => type === 'film' || type === 'tv'

export function haveServices() {
  return myServiceIds().length > 0
}

/**
 * Keep only what is included with a subscription you already hold.
 *
 * Renting and buying are deliberately not counted: the question is what you
 * can watch without paying again, and "available to buy for £13.99" is not
 * an answer to it. Free-with-ads tiers do count — you can press play.
 *
 * One lookup per title, cached for a day by the provider. Titles TMDB does
 * not know are dropped rather than kept: a chart that promises everything on
 * it is streamable has to mean it.
 */
export async function filterToServices(items, type, { region = 'GB', need = Infinity } = {}) {
  const mine = new Set(myServiceIds())
  if (!mine.size || !canFilterByService(type)) return items

  const kept = []
  const BATCH = 8
  for (let i = 0; i < items.length && kept.length < need; i += BATCH) {
    const slice = items.slice(i, i + BATCH)
    const checked = await Promise.all(slice.map(async (item) => {
      const id = item.tmdb_id ?? item.ids?.tmdb_id ?? null
      if (!id) return null
      const where = await tmdb.watchProviders(type, id, region).catch(() => null)
      if (!where) return null
      const on = [...(where.stream || []), ...(where.free || [])]
        .filter((p) => mine.has(p.id))
      return on.length ? { ...item, on_services: on.slice(0, 3) } : null
    }))
    kept.push(...checked.filter(Boolean))
  }
  return kept
}
