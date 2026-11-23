/*
 * What the bands playing in town actually play.
 *
 * The listings sites publish a billing, a venue and a date, and no genre at
 * all — so the Gigs tab can tell you when somebody you already listen to is
 * on, and nothing about the four hundred acts you have never heard of. This
 * looks each of them up in MusicBrainz, whose community tags are free and
 * keyless, and leaves the answers in the HTTP cache for a month. The tab
 * reads that cache and never waits on the network.
 *
 * MusicBrainz asks for one request a second and lib/http.js keeps to it, so
 * several hundred acts take ten or fifteen minutes. Run it whenever; it
 * skips anything already cached, so a second run costs almost nothing.
 *
 *   node scripts/fetch-gig-genres.js            # say how many need looking up
 *   node scripts/fetch-gig-genres.js --apply
 */
import * as headfirst from '../server/providers/headfirst.js'
import * as venuesites from '../server/providers/venuesites.js'
import * as mb from '../server/providers/musicbrainz.js'
import { setting } from '../server/lib/settings.js'
import { BILL_SPLIT, isProbablyAGig } from '../server/lib/gigs.js'

const apply = process.argv.includes('--apply')
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0


const days = Number(setting('gigs_days')) || 120
const listings = await headfirst.gigs({ days })
/* Fetching as well as reading: this is the pass that fills their cache. */
const direct = await venuesites.events({ days, cacheOnly: false })
const events = [...listings.events, ...direct.events]
for (const w of [...listings.warnings, ...direct.warnings]) console.log(`  warning: ${w}`)

/*
 * One job per act name, not per gig: a residency is the same band twelve
 * times, and the whole billing is kept as a candidate too because plenty of
 * bands have an ampersand in their name.
 */
const acts = new Set()
for (const ev of events) {
  // Club nights and exhibitions are not bands; not worth a lookup each.
  if (!isProbablyAGig(ev.name).gig) continue
  for (const part of [ev.name, ...ev.name.split(BILL_SPLIT)]) {
    const name = part.trim()
    if (name.length > 2 && name.length < 60) acts.add(name)
  }
}

const todo = []
for (const name of acts) {
  // Already answered? Then it is already in the cache and costs nothing.
  if (await mb.artistTags(name, { cacheOnly: true })) continue
  todo.push(name)
}

console.log(`${events.length} gigs, ${acts.size} distinct acts, ${todo.length} not looked up yet.`)
if (!apply) {
  console.log('Pass --apply to look them up (about a second each).')
  process.exit(0)
}

const work = limit ? todo.slice(0, limit) : todo
let found = 0
let tagged = 0
for (const [i, name] of work.entries()) {
  const res = await mb.artistTags(name)
  if (res?.found) {
    found++
    if (res.genres.length) tagged++
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${work.length} — ${found} known, ${tagged} with genres`)
}
console.log(`Done: ${work.length} looked up, ${found} are in MusicBrainz, ${tagged} of those have genres.`)
