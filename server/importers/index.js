import { unzipSync, strFromU8 } from 'fflate'
import * as letterboxd from './letterboxd.js'
import * as goodreads from './goodreads.js'
import * as storygraph from './storygraph.js'
import * as audible from './audible.js'
import * as imdb from './imdb.js'
import * as trakt from './trakt.js'
import * as spotify from './spotify.js'
import * as lastfm from './lastfm.js'
import * as netflix from './netflix.js'
import * as justwatch from './justwatch.js'
import * as playlist from './playlist.js'
import * as generic from './generic.js'
import { parseCsvObjects } from '../lib/csv.js'

export const IMPORTERS = [letterboxd, goodreads, storygraph, audible, imdb, trakt, spotify, playlist, lastfm, netflix, justwatch, generic]
const BY_ID = new Map(IMPORTERS.map((i) => [i.id, i]))

export function getImporter(id) {
  return BY_ID.get(id)
}

export function catalogue() {
  return IMPORTERS.map((i) => ({
    id: i.id,
    label: i.label,
    accepts: i.accepts,
    help: i.help,
    options: i.options || [],
  }))
}

const TEXT_EXT = /\.(csv|tsv|txt|json)$/i
const SKIP_IN_ZIP = /(^|\/)(__MACOSX|\.)|\.(jpg|jpeg|png|gif|pdf|mp3|html?)$/i

/**
 * Flatten whatever was uploaded into a list of text members.
 * ZIPs are expanded in memory; JSON is pre-parsed so detectors can sniff it.
 */
export function explode({ filename, buffer }) {
  const name = String(filename || 'upload')
  if (/\.zip$/i.test(name)) {
    const files = unzipSync(new Uint8Array(buffer))
    const out = []
    for (const [entry, bytes] of Object.entries(files)) {
      if (!bytes.length || SKIP_IN_ZIP.test(entry) || !TEXT_EXT.test(entry)) continue
      out.push(member(entry, strFromU8(bytes), name))
    }
    return out
  }
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  return [member(name, text, null)]
}

function member(filename, text, archive) {
  const file = { filename, text, archive }
  if (/\.json$/i.test(filename)) {
    try { file.json = JSON.parse(text) } catch { /* leave as text */ }
  } else {
    try {
      const { headers } = parseCsvObjects(text.slice(0, 64 * 1024))
      file.headers = headers
    } catch { /* not a table */ }
  }
  return file
}

/** Rank every importer against a set of uploaded members. */
export function detect(files) {
  const scores = []
  for (const importer of IMPORTERS) {
    let best = { confidence: 0 }
    let matched = 0
    for (const file of files) {
      const verdict = importer.detect({
        filename: file.archive ? `${file.archive}/${file.filename}` : file.filename,
        text: file.text,
        headers: file.headers,
        jsonSample: file.json,
      }) || { confidence: 0 }
      if (verdict.confidence > 0) matched++
      if (verdict.confidence > best.confidence) best = verdict
    }
    if (best.confidence > 0) {
      scores.push({
        id: importer.id,
        label: importer.label,
        confidence: Math.min(0.99, best.confidence + Math.min(0.04 * (matched - 1), 0.1)),
        reason: best.reason,
        mapping: best.mapping,
        options: importer.options || [],
        matchedFiles: matched,
      })
    }
  }
  return scores.sort((a, b) => b.confidence - a.confidence)
}

/** Which members a given importer should actually read. */
export function filesFor(importer, files) {
  if (importer.id === 'letterboxd') {
    const roled = files.filter((f) => letterboxd.roleForFilename(f.filename))
    if (roled.length) return roled
  }
  if (importer.id === 'audible') {
    // Most of an Audible export is telemetry that happens to carry a product
    // name; reading it all counted every playback event as a book.
    const relevant = files.filter((f) => audible.relevantFilename(f.filename))
    if (relevant.length) return relevant
  }
  if (importer.id === 'spotify') {
    const relevant = files.filter((f) =>
      /streaming_history|streaminghistory|yourlibrary|playlist/i.test(f.filename))
    if (relevant.length) return relevant
  }
  return files.filter((f) => {
    const verdict = importer.detect({
      filename: f.archive ? `${f.archive}/${f.filename}` : f.filename,
      text: f.text,
      headers: f.headers,
      jsonSample: f.json,
    }) || { confidence: 0 }
    return verdict.confidence > 0 || importer.id === 'generic'
  })
}

export function parseWith(importerId, files, opts = {}) {
  const importer = getImporter(importerId)
  if (!importer) throw new Error(`Unknown importer: ${importerId}`)
  const relevant = filesFor(importer, files)
  const records = importer.parse(relevant, opts) || []
  return {
    source: importer.id,
    label: importer.label,
    filesUsed: relevant.map((f) => f.filename),
    records,
  }
}
