/*
 * Cover art for tracks imported from a playlist.
 *
 * A playlist export carries no artwork, so six thousand tracks arrive as six
 * thousand identical placeholders — a shelf that looks like a spreadsheet.
 * Apple's catalogue is keyless and has the sleeves, and the lookup is per
 * ALBUM rather than per track: two thousand requests instead of six, and
 * every track of a record ends up under the sleeve it was released on, which
 * is what a music shelf is supposed to look like.
 *
 * Only exact-ish matches are accepted — a near miss hangs the wrong sleeve on
 * a song, which is worse than no sleeve at all.
 *
 * Apple's search endpoint rate-limits hard — about twenty requests a minute,
 * and over that it answers 403 with an empty body rather than saying so. The
 * pace below is deliberately slower than that, and it backs right off when a
 * run of lookups comes back empty, which is what being throttled looks like
 * from here. Two thousand albums therefore take an hour or two; it is a
 * background job, not something to wait on.
 *
 *   node scripts/fetch-playlist-art.js            # say what it would do
 *   node scripts/fetch-playlist-art.js --apply    # actually do it
 *   node scripts/fetch-playlist-art.js --apply --limit 50 --gap 2500
 */
import { all, run, json } from '../server/lib/db.js'
import * as itunes from '../server/providers/itunes.js'
import { normaliseTitle } from '../server/lib/util.js'

const apply = process.argv.includes('--apply')
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0
const gapArg = process.argv.indexOf('--gap')
const gapArg2 = gapArg > -1 ? Number(process.argv[gapArg + 1]) : NaN
// A missing or junk --gap used to mean sleep(NaN), which is no pacing at all.
const gap = Number.isFinite(gapArg2) && gapArg2 >= 0 ? gapArg2 : 3200
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rows = all(`
  SELECT w.id, w.title, w.creators, w.metadata, w.poster_url
    FROM works w
   WHERE w.type = 'track'
     AND json_extract(w.metadata, '$.album') IS NOT NULL`)

/* One job per album, carrying every track that belongs to it. */
const albums = new Map()
for (const row of rows) {
  if (row.poster_url) continue
  const meta = json(row.metadata, {})
  const artist = json(row.creators, [])[0]?.name
  if (!meta.album || !artist) continue
  const key = `${normaliseTitle(artist)}|${normaliseTitle(meta.album)}`
  const slot = albums.get(key) || { artist, album: meta.album, ids: [] }
  slot.ids.push(row.id)
  albums.set(key, slot)
}

const jobs = [...albums.values()]
const work = limit ? jobs.slice(0, limit) : jobs
const waiting = jobs.reduce((n, j) => n + j.ids.length, 0)
console.log(`${waiting} tracks without a cover, in ${jobs.length} albums.`)
console.log(apply ? `Looking up ${work.length}…` : `Would look up ${work.length}. Pass --apply to do it.`)
if (!apply) process.exit(0)

let found = 0
let covered = 0
let missed = 0

let dry = 0
let backoffs = 0

/*
 * A queue rather than a for-loop, because a throttled lookup has to go back
 * on it. The first version slept and then carried on through the same
 * iteration, so the album that hit the throttle — and the four behind it —
 * were recorded as "no cover exists" and never asked about again. Over a
 * long run that quietly lost a few hundred records.
 */
const queue = [...work]
let done = 0

while (queue.length) {
  const job = queue.shift()
  if (done) await sleep(gap)
  const hits = await itunes.search('album', `${job.artist} ${job.album}`, 5).catch(() => [])

  /*
   * Nothing back at all, repeatedly, is the throttle rather than an obscure
   * record: a search for "Metallica Master of Puppets" always has an answer.
   * Apple answers 403 or 429 with an empty body, so an empty result is the
   * only symptom there is.
   */
  if (!hits.length) {
    queue.unshift(job)
    if (++dry >= 5) {
      /*
       * Back off further every time, up to half an hour. Apple's throttle
       * lasts as long as it lasts, and asking every two minutes whether it
       * has forgiven us yet is both rude and a way to stay throttled.
       */
      const wait = Math.min(30 * 60000, 60000 * 2 ** backoffs++)
      console.log(`  nothing coming back — waiting ${Math.round(wait / 60000)} min (${done} of ${work.length} done, ${found} sleeves)`)
      await sleep(wait)
      dry = 0
    }
    // Give up on an album only after the throttle has been ruled out twice.
    if (backoffs >= 6) {
      queue.shift()
      missed++
      done++
      backoffs = 0
    }
    continue
  }
  dry = 0
  backoffs = 0
  done++

  const wantAlbum = normaliseTitle(job.album)
  const wantArtist = normaliseTitle(job.artist)
  const hit = hits.find((h) => {
    const title = normaliseTitle(h.title)
    const byline = (h.creators || []).map((c) => normaliseTitle(c.name)).join(' ')
    const titleOk = title === wantAlbum || title.startsWith(wantAlbum) || wantAlbum.startsWith(title)
    return titleOk && (byline.includes(wantArtist) || wantArtist.includes(byline))
  })

  if (!hit?.poster_url) { missed++; continue }
  found++
  for (const id of job.ids) {
    // Count what the database actually changed, not what was attempted: the
    // guard means another run may have covered this one already.
    const { changes } = run(
      "UPDATE works SET poster_url = ?, updated_at = datetime('now') WHERE id = ? AND poster_url IS NULL",
      hit.poster_url, id,
    )
    covered += changes || 0
  }
  if (done % 100 === 0) console.log(`  ${done}/${work.length} — ${found} sleeves, ${covered} tracks`)
}

console.log(`Done: ${found} albums found, ${missed} not, ${covered} tracks given a cover.`)
