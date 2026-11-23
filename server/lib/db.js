import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const dataDir = process.env.SHELVED_DATA || process.env.MYMEDIA_DATA || join(root, 'data')

mkdirSync(dataDir, { recursive: true })

export const DATA_DIR = dataDir
/*
 * The library lives in exactly one file: shelved.db.
 *
 * It used to be mymedia.db, and for a while both names were accepted. That was
 * a trap — anything that created shelved.db first (a stray process, a copy in
 * the wrong place) left the real library sitting unopened next to an empty one,
 * and the app looked freshly installed. So: one name, and a loud error rather
 * than a quiet second database if the old name ever turns up again.
 */
const legacy = join(dataDir, 'mymedia.db')
const dbPath = join(dataDir, 'shelved.db')

if (existsSync(legacy)) {
  if (existsSync(dbPath)) {
    throw new Error(
      `Two databases in ${dataDir}: shelved.db and the older mymedia.db.\n`
      + 'Keep the one you want (check which has your entries), move the other out of the way, and start again.',
    )
  }
  renameSync(legacy, dbPath)
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(legacy + ext)) renameSync(legacy + ext, dbPath + ext)
  }
  console.log(`[shelved] renamed mymedia.db to shelved.db in ${dataDir}`)
}

export const DB_PATH = dbPath
export const db = new DatabaseSync(dbPath)

db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))

/*
 * Migrations for databases created before a column existed. Each is written to
 * be safe to run repeatedly: we look before we leap, and never drop anything.
 */
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
}

function addColumn(table, column, definition) {
  if (hasColumn(table, column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

const migrated = [
  // Ownership, so that supporting more than one person later is a filter
  // change rather than a data migration.
  ['entries', 'user_id'], ['recs', 'user_id'], ['lists', 'user_id'],
  ['import_runs', 'user_id'], ['rec_cache', 'user_id'], ['rec_blocks', 'user_id'],
  ['connections', 'user_id'],
].filter(([table, column]) => addColumn(table, column, 'INTEGER NOT NULL DEFAULT 1'))

if (migrated.length) {
  console.log(`  migrated: added ${migrated.map(([t]) => t).join(', ')}.user_id`)
}

/*
 * Books and audiobooks are one library, because they are one book — the
 * difference is how you took it in, which belongs on the entry rather than on
 * the title. 'book', 'audiobook', or 'both' when you did some of each.
 */
if (addColumn('entries', 'format', 'TEXT')) {
  console.log('  migrated: added entries.format')
}

/*
 * An entry you made, versus one that merely describes your taste.
 *
 * A playlist of six thousand tracks is six thousand true facts about what you
 * like and not one occasion: you did not sit down on 14 March 1995 and listen
 * to that song, the date is only the record's. Such an entry teaches the
 * engine everything and must stay out of the diary — the counts, the recently
 * logged row, the activity feed and the charts — or one import buries a
 * decade of logging under songs.
 */
if (addColumn('entries', 'backfill', 'INTEGER NOT NULL DEFAULT 0')) {
  console.log('  migrated: added entries.backfill')
}

/*
 * A rejection used to record only that you had made one. Keeping what you
 * turned down — its genres, its people, its keywords — is what lets the engine
 * learn the shape of what you do not want, rather than merely crossing off one
 * title at a time.
 *
 * Rejections made before this column existed can often be recovered: the last
 * couple of suggestion lists per type are still cached, and they hold the full
 * pick. Best effort, once.
 */
if (addColumn('rec_blocks', 'attrs', 'TEXT')) {
  let found = 0
  const blocked = db.prepare('SELECT fingerprint FROM rec_blocks').all().map((r) => r.fingerprint)
  if (blocked.length) {
    const want = new Set(blocked)
    const save = db.prepare('UPDATE rec_blocks SET attrs = ? WHERE fingerprint = ? AND attrs IS NULL')
    for (const row of db.prepare('SELECT payload FROM rec_cache').all()) {
      let picks
      try { picks = JSON.parse(row.payload)?.picks } catch { continue }
      for (const p of picks || []) {
        if (!want.has(p.fingerprint)) continue
        save.run(JSON.stringify({
          genres: p.genres || [], creators: p.creators || [],
          year: p.year ?? null, language: p.language ?? null,
        }), p.fingerprint)
        found++
      }
    }
  }
  console.log(`  migrated: added rec_blocks.attrs${found ? ` (recovered ${found} of ${blocked.length})` : ''}`)
}

/*
 * The normalised title, stored rather than recomputed.
 *
 * Finding "is this already in the library?" used to end in a scan of every
 * work of that type, normalising each title in JavaScript to compare it —
 * fine at a thousand films, quadratic at six thousand tracks, where one
 * playlist import spent a quarter of an hour doing nothing else. Written on
 * every insert and whenever a title changes; see upsertWork.
 */
if (addColumn('works', 'norm_title', 'TEXT')) {
  const { normaliseTitle } = await import('./util.js')
  const rows = db.prepare('SELECT id, title FROM works').all()
  const set = db.prepare('UPDATE works SET norm_title = ? WHERE id = ?')
  db.exec('BEGIN')
  for (const r of rows) set.run(normaliseTitle(r.title), r.id)
  db.exec('COMMIT')
  console.log(`  migrated: added works.norm_title (${rows.length} filled in)`)
}

// Indexes that depend on migrated columns, so they come after the ALTERs.
db.exec('CREATE INDEX IF NOT EXISTS entries_user_idx ON entries(user_id, consumed_on DESC)')
db.exec('CREATE INDEX IF NOT EXISTS works_norm_idx ON works(type, norm_title)')
/*
 * The other identifiers findWork looks up before it ever considers a title.
 * Only tmdb_id and imdb_id were indexed, so "have I got this already?" was a
 * full scan of the type for every imported row that carried a Spotify id, an
 * ISBN or an ASIN — the silent half of a slow import.
 */
for (const field of ['spotify_id', 'isbn', 'asin', 'mbid', 'itunes_id', 'olid']) {
  db.exec(`CREATE INDEX IF NOT EXISTS works_${field}_idx ON works(type, ${field}) WHERE ${field} IS NOT NULL`)
}

/** Rows as plain objects (node:sqlite returns null-prototype objects). */
export function all(sql, ...params) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }))
}

export function get(sql, ...params) {
  const row = db.prepare(sql).get(...params)
  return row ? { ...row } : undefined
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...params)
}

export function tx(fn) {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

export function json(value, fallback) {
  if (value == null) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}
