import express from 'express'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { get, DB_PATH } from './lib/db.js'
import { scheduleBackups } from './lib/backup.js'
import { pruneCache } from './lib/http.js'
import { join } from 'node:path'
import { router as library } from './routes/library.js'
import { router as recs } from './routes/recs.js'
import { router as stats } from './routes/stats.js'
import { router as imports } from './routes/imports.js'
import { router as misc } from './routes/misc.js'
import { router as connections } from './routes/connections.js'
import { router as gigs } from './routes/gigs.js'
import { startGigWarmer } from './gigwarm.js'
import { router as auth } from './routes/auth.js'
import { requireAuth, applyEnvPassword } from './lib/auth.js'
import { queueAll, queueAllRecArtwork } from './enrich.js'
import { ARTWORK_DIR } from './lib/artwork.js'

const app = express()
const PORT = Number(process.env.PORT || 4123)
// Must match the SHELVED_BASE_PATH the client was built with.
const BASE = (process.env.SHELVED_BASE_PATH || process.env.MYMEDIA_BASE_PATH || '').replace(/\/$/, '')
const root = join(import.meta.dirname, '..')
const dist = join(root, 'dist')

app.use(express.json({ limit: '5mb' }))
app.disable('x-powered-by')
// Fly (and any reverse proxy) terminates TLS for us; trust it so that client
// IPs and the https flag are read from the forwarding headers.
app.set('trust proxy', true)

// A deployment given SHELVED_PASSWORD is never open, even on first boot.
if (applyEnvPassword()) console.log('  password set from SHELVED_PASSWORD')

// Cached cover art, served locally: the upstream CDNs are slow, and
// same-origin images let the client sample their colours.
app.use(`${BASE}/artwork`, express.static(ARTWORK_DIR, { maxAge: '30d', immutable: true }))

app.use(`${BASE}/api`, auth)
app.use(`${BASE}/api`, requireAuth)
app.use(`${BASE}/api`, library)
app.use(`${BASE}/api`, recs)
app.use(`${BASE}/api`, stats)
app.use(`${BASE}/api`, imports)
app.use(`${BASE}/api`, misc)
app.use(`${BASE}/api`, connections)
app.use(`${BASE}/api`, gigs)

app.use(`${BASE}/api`, (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` }))
app.use((err, req, res, next) => {
  console.error('[api error]', err)
  if (res.headersSent) return next(err)
  res.status(500).json({ error: err.message || 'Something went wrong' })
})

if (existsSync(dist)) {
  // A build made without SHELVED_BASE_PATH emits absolute /assets/… URLs that
  // 404 under a sub-path, leaving a blank page. Say so rather than serve it.
  try {
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    const built = (html.match(/src="([^"]*)\/assets\//) || [])[1] ?? ''
    if (built !== BASE) {
      console.warn(
        `[shelved] the built client expects base "${built || '/'}" but the server serves "${BASE || '/'}".`
        + ` Rebuild with SHELVED_BASE_PATH=${BASE || ''} npm run build`,
      )
    }
  } catch { /* a missing index.html is handled below */ }

  /*
   * The worker and the manifest are how a new version announces itself, so
   * they must never inherit the year-long cache below — a stale copy of
   * either would pin the installed app to an old build with no way back.
   */
  for (const file of ['sw.js', 'manifest.webmanifest']) {
    app.get(`${BASE}/${file}`, (req, res) => {
      res.set('Cache-Control', 'no-cache, must-revalidate')
      res.sendFile(join(dist, file))
    })
  }

  // Asset filenames carry a content hash, so they can be cached hard.
  app.use(BASE || '/', express.static(dist, { maxAge: '1y', immutable: true, index: false }))

  // index.html must never be cached: it is what points at the current bundle,
  // and a stale copy leaves the browser running yesterday's app.
  const shell = (req, res) => {
    res.set('Cache-Control', 'no-cache, must-revalidate')
    res.sendFile(join(dist, 'index.html'))
  }
  // Anything else under the base path is a client-side route.
  app.get(`${BASE}/*`, shell)
  if (BASE) app.get(BASE, shell)
} else {
  app.get('/', (req, res) => res.status(503).type('html').send(
    '<pre style="font:14px ui-monospace;padding:2rem;color:#eee;background:#111">'
    + 'Shelved: the client is not built yet.\n\nRun  npm run build  then reload,\n'
    + 'or  npm run dev  for the hot-reloading dev server on :5173.</pre>',
  ))
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Shelved — http://localhost:${PORT}${BASE}`)
  console.log(`  On your network: http://<this-machine>:${PORT}${BASE}`)
  // Say which library is open and how big it is: an empty count here is the
  // fastest way to spot a server that has latched onto the wrong file.
  const logged = get('SELECT count(*) c FROM entries WHERE backfill = 0')?.c ?? 0
  console.log(`  Library: ${DB_PATH} — ${logged} entries\n`)

  // A daily snapshot, taken by the app rather than left to anyone remembering.
  scheduleBackups()

  // Expired provider responses, swept out hourly so they cannot pile up.
  const sweep = () => {
    const gone = pruneCache()
    if (gone > 500) console.log(`  swept ${gone} expired cache entries`)
  }
  sweep()
  setInterval(sweep, 60 * 60 * 1000).unref?.()

  // The queue lives in memory, so pick up anything a restart interrupted.
  const pending = queueAll({ onlyMissing: true })
  queueAllRecArtwork()
  if (pending) console.log(`  resuming metadata for ${pending} titles\n`)

  /*
   * And keep the gig listings warm in the background, so that opening the
   * Gigs tab is a database read rather than two dozen fetches. See gigwarm.js.
   */
  startGigWarmer()
})
