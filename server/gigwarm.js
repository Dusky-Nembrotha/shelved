import * as headfirst from './providers/headfirst.js'
import * as venuesites from './providers/venuesites.js'
import * as mb from './providers/musicbrainz.js'
import { setting } from './lib/settings.js'
import { BILL_SPLIT, isProbablyAGig } from './lib/gigs.js'

/**
 * Keeping the gig listings warm, so the tab is never the thing that waits.
 *
 * Three jobs, none of which can happen while somebody is looking at a page:
 * two dozen listing pages to read, a hundred venue pages behind them, and a
 * MusicBrainz lookup for every act so that a band you have never heard of
 * can be placed against your taste. All of it is cached for twelve hours,
 * which is as often as a gig listing changes.
 *
 * It runs a few minutes after boot and twice a day after that, and it is
 * bounded: a fixed number of artist lookups per run, so a cold start fills
 * in over a few runs rather than spending an hour on the network at once.
 * Everything it fetches is skipped if the cache already has it, which makes
 * a routine run nearly free.
 */

const FIRST_RUN_DELAY_MS = 3 * 60 * 1000
const EVERY_MS = 12 * 60 * 60 * 1000
const LOOKUPS_PER_RUN = 250


let running = false

export async function warmGigs({ lookups = LOOKUPS_PER_RUN } = {}) {
  if (running) return { skipped: 'already running' }
  running = true
  const began = Date.now()
  try {
    // Only Bristol has a listings source; elsewhere there is nothing to warm.
    if (!/^bristol$/i.test(String(setting('gigs_city') || 'Bristol').trim())) {
      return { skipped: 'not Bristol' }
    }
    const days = Number(setting('gigs_days')) || 365

    const listings = await headfirst.gigs({ days })
    const direct = await venuesites.events({ days, cacheOnly: false })
    const events = [...listings.events, ...direct.events]

    const acts = new Set()
    for (const ev of events) {
      // Club nights and exhibitions are not bands; not worth a lookup each.
      if (!isProbablyAGig(ev.name).gig) continue
      for (const part of [ev.name, ...String(ev.name).split(BILL_SPLIT)]) {
        const name = part.trim()
        if (name.length > 2 && name.length < 60) acts.add(name)
      }
    }

    let asked = 0
    let tagged = 0
    for (const name of acts) {
      if (asked >= lookups) break
      if (await mb.artistTags(name, { cacheOnly: true })) continue
      const res = await mb.artistTags(name)
      asked++
      if (res?.genres?.length) tagged++
    }

    const warnings = [...listings.warnings, ...direct.warnings]
    for (const w of warnings) console.log(`  gigs: ${w}`)
    console.log(
      `  gigs: ${events.length} listed, ${acts.size} acts, ${asked} looked up (${tagged} with genres)`
      + ` in ${Math.round((Date.now() - began) / 1000)}s`,
    )
    return { events: events.length, acts: acts.size, asked, tagged, warnings }
  } catch (err) {
    console.log(`  gigs: warm-up failed — ${err.message}`)
    return { error: err.message }
  } finally {
    running = false
  }
}

export function startGigWarmer() {
  const tick = () => { void warmGigs() }
  // Unref'd so this never holds the process open on its own.
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref()
  setInterval(tick, EVERY_MS).unref()
}
