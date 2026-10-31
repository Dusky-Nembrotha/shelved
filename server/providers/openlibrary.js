import { fetchJson } from '../lib/http.js'
import { plainText } from '../lib/util.js'

// Keyless. Great for books: covers, subjects, author graph, ratings.
const BASE = 'https://openlibrary.org'
/*
 * Open Library describes a *work* — every edition in every language rolled
 * together — so its cover and first sentence belong to whichever edition
 * happens to sort first. That is how an English novel ends up with a Turkish
 * cover and a Dutch opening line.
 *
 * Asking for `editions` alongside the work, with the search filtered to
 * English, returns the matching English editions too, and those are what we
 * actually want the cover and text from.
 */
const FIELDS = [
  'key', 'title', 'author_name', 'author_key', 'first_publish_year', 'cover_i', 'isbn',
  'subject', 'number_of_pages_median', 'edition_count', 'ratings_average', 'ratings_count',
  'language', 'first_sentence', 'publisher',
  'editions', 'editions.key', 'editions.title', 'editions.language', 'editions.cover_i',
  'editions.first_sentence', 'editions.isbn_13', 'editions.number_of_pages', 'editions.publish_date',
].join(',')

/** Open Library's MARC code for English. */
const ENGLISH = 'eng'

/** The English edition if there is one, else whichever came back first. */
function englishEdition(doc) {
  const editions = doc?.editions?.docs || []
  return editions.find((e) => (e.language || []).includes(ENGLISH)) || editions[0] || null
}

const firstOf = (v) => (Array.isArray(v) ? v[0] : v) || null

/** A cover by Open Library cover id, or by ISBN when that is all there is. */
/*
 * A cover, or nothing — never a blank.
 *
 * Open Library answers 200 with a one-pixel transparent GIF when it has no
 * cover for an ISBN, which is indistinguishable from a real answer to every
 * check in this app: the URL exists, the request succeeds, the card renders
 * empty. default=false makes a missing cover a 404, which is the truth and
 * which the fallbacks can act on.
 */
export function coverUrl(id, size = 'L', key = 'id') {
  return id ? `https://covers.openlibrary.org/b/${key}/${id}-${size}.jpg?default=false` : null
}

// Open Library subjects are a jumble: "genre:fantasy", "nyt:bestseller",
// "Fiction, fantasy, epic". Tidy them into things worth showing as genres.
const SUBJECT_NOISE = new RegExp([
  '^(nyt|accessible book|protected daisy|in library|overdrive|large type|internet archive',
  '|open library|lending library|popular print|reading level|ficci|roman|romans|erzahlung)',
  '|englisch|deutsch|fran[cç]ais|espa[nñ]ol|italiano|translations? into|fiction in english',
  '|new york times|bestseller|book club|reading group|textbooks?|study guide|abridged',
].join(''), 'i')

export function cleanSubjects(subjects) {
  const out = []
  for (const raw of subjects || []) {
    let s = String(raw).replace(/^(genre|form|subject|place|time|person|lcc|ddc):\s*/i, '').trim()
    if (!s || s.length > 34 || SUBJECT_NOISE.test(s)) continue
    if (/^\d+$/.test(s)) continue
    s = s.replace(/\s*\(.*?\)\s*$/, '').trim()
    s = s.charAt(0).toUpperCase() + s.slice(1)
    out.push(s)
  }
  return out
}

function normalise(doc, type = 'book') {
  if (!doc || !doc.title) return null

  const edition = englishEdition(doc)
  const isEnglish = Boolean(edition && (edition.language || []).includes(ENGLISH))
  const languages = doc.language || []

  // Only take the work-level opening line when every edition is English;
  // otherwise it could be from any of them.
  const workSentence = languages.length && languages.every((l) => l === ENGLISH)
    ? firstOf(doc.first_sentence)
    : null

  /*
   * Use the English edition's own title where we have one. The work keeps its
   * original-language name — Elie Wiesel's "Night" is filed as "La Nuit" —
   * which is confusing in a library that is otherwise entirely in English.
   */
  const title = (isEnglish && edition.title) || doc.title

  return {
    provider: 'openlibrary',
    type,
    title,
    year: doc.first_publish_year || null,
    creators: (doc.author_name || []).slice(0, 4).map((name) => ({ role: 'Author', name })),
    genres: cleanSubjects(doc.subject).slice(0, 12),
    overview: plainText((isEnglish ? firstOf(edition.first_sentence) : null) || workSentence),
    pages: doc.number_of_pages_median || edition?.number_of_pages || null,
    // An English edition's cover, where one came back; the work's otherwise.
    poster_url: coverUrl((isEnglish && edition.cover_i) || doc.cover_i, 'L'),
    original_title: title !== doc.title ? doc.title : null,
    backdrop_url: null,
    isbn: (doc.isbn || [])[0] || firstOf(edition?.isbn_13) || null,
    olid: doc.key ? String(doc.key).replace('/works/', '') : null,
    external_rating: doc.ratings_average ? Math.round(doc.ratings_average * 20) / 10 : null,
    popularity: doc.edition_count || null,
    // Say English when that is the edition we took, not whatever sorted first.
    language: isEnglish ? ENGLISH : (languages[0] || null),
    metadata: {
      author_keys: doc.author_key || [],
      ratings_count: doc.ratings_count,
      publisher: (doc.publisher || [])[0],
      ol_key: doc.key,
      ...(isEnglish ? { english_edition: edition.key } : {}),
    },
  }
}

export async function search(term, { limit = 12, type = 'book', author } = {}) {
  if (!term && !author) return []
  const q = author ? `${term} author:${author}` : term
  try {
    const data = await fetchJson(
      `${BASE}/search.json?q=${encodeURIComponent(q)}&language=${ENGLISH}&limit=${limit}&fields=${FIELDS}`,
      { ttlSeconds: 60 * 60 * 24 * 14 },
    )
    return (data.docs || []).map((d) => normalise(d, type)).filter(Boolean)
  } catch {
    return []
  }
}

export async function byIsbn(isbn, type = 'book') {
  try {
    const data = await fetchJson(
      `${BASE}/search.json?q=isbn:${encodeURIComponent(isbn)}&limit=1&fields=${FIELDS}`,
    )
    return (data.docs || []).map((d) => normalise(d, type))[0] || null
  } catch {
    return null
  }
}

export async function byAuthorKey(authorKey, { limit = 24, type = 'book' } = {}) {
  if (!authorKey) return []
  try {
    const data = await fetchJson(
      `${BASE}/search.json?q=author_key:${encodeURIComponent(authorKey)}&language=${ENGLISH}&sort=rating&limit=${limit}&fields=${FIELDS}`,
      { ttlSeconds: 60 * 60 * 24 * 7 },
    )
    return (data.docs || []).map((d) => normalise(d, type)).filter(Boolean)
  } catch {
    return []
  }
}

/** Highly-rated books in a subject — candidate generation for the recommender. */
export async function bySubject(subject, { limit = 24, type = 'book' } = {}) {
  if (!subject) return []
  const q = `subject:"${String(subject).replace(/"/g, '')}"`
  try {
    const data = await fetchJson(
      `${BASE}/search.json?q=${encodeURIComponent(q)}&language=${ENGLISH}&sort=rating&limit=${limit}&fields=${FIELDS}`,
      { ttlSeconds: 60 * 60 * 24 * 7 },
    )
    return (data.docs || []).map((d) => normalise(d, type)).filter(Boolean)
  } catch {
    return []
  }
}

export async function workDetail(olid) {
  if (!olid) return null
  try {
    const data = await fetchJson(`${BASE}/works/${olid}.json`)
    const desc = typeof data.description === 'string' ? data.description : data.description?.value
    // Publishers supply these with markup in them.
    return { overview: plainText(desc), subjects: data.subjects || [] }
  } catch {
    return null
  }
}

/** Covers from every edition Open Library knows of, so a poor scan can be swapped. */
export async function editionCovers(title, author, limit = 12) {
  if (!title) return []
  const q = author ? `${title} author:${author}` : title

  // English editions are asked for separately and offered first: a cover in a
  // language you cannot read is a last resort, not a candidate.
  const url = (lang) =>
    `${BASE}/search.json?q=${encodeURIComponent(q)}${lang ? `&language=${lang}` : ''}&limit=6`
    + '&fields=key,title,author_name,cover_i,edition_key,first_publish_year,language'
    + ',editions,editions.key,editions.language,editions.cover_i'

  const collect = (data, english) => {
    const out = []
    for (const doc of data?.docs || []) {
      for (const ed of doc?.editions?.docs || []) {
        if (!ed.cover_i) continue
        out.push({
          url: coverUrl(ed.cover_i, 'L'),
          source: 'Open Library',
          label: english ? doc.title : `${doc.title} (${(ed.language || [])[0] || 'other'})`,
        })
      }
      if (doc.cover_i) out.push({ url: coverUrl(doc.cover_i, 'L'), source: 'Open Library', label: doc.title })
      for (const ed of (doc.edition_key || []).slice(0, 4)) {
        out.push({
          url: `https://covers.openlibrary.org/b/olid/${ed}-L.jpg`,
          source: 'Open Library',
          label: `${doc.title} (edition)`,
        })
      }
    }
    return out
  }

  try {
    const [eng, any] = await Promise.all([
      fetchJson(url(ENGLISH), { ttlSeconds: 60 * 60 * 24 * 7 }).catch(() => null),
      fetchJson(url(null), { ttlSeconds: 60 * 60 * 24 * 7 }).catch(() => null),
    ])
    const seen = new Set()
    const out = []
    for (const c of [...collect(eng, true), ...collect(any, false)]) {
      if (!c.url || seen.has(c.url)) continue
      seen.add(c.url)
      out.push(c)
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}


/**
 * What people are reading right now.
 *
 * Open Library publishes what is being borrowed and looked up, which is the
 * closest thing to a "what is everyone talking about" list that does not need
 * a commercial bestseller licence.
 */
export async function trending(period = 'weekly', { limit = 24, type = 'book' } = {}) {
  try {
    const data = await fetchJson(
      `${BASE}/trending/${period}.json?limit=${Math.min(100, limit * 2)}`,
      { ttlSeconds: 60 * 60 * 6 },
    )
    return (data.works || [])
      .map((d) => normalise(d, type))
      .filter(Boolean)
      .slice(0, limit)
  } catch {
    return []
  }
}
