import { all, get, run, json } from './lib/db.js'
import { normaliseTitle, decade, uniqueBy, clamp } from './lib/util.js'
import { systemUserId } from './lib/user.js'
import { tmdb, itunes, ol, mb, tvmaze, wiki, gbooks, steam, boardgame, bookNoise } from './providers/index.js'
import { coverUrl } from './providers/openlibrary.js'
import * as wikidata from './providers/wikidata.js'
import * as bgg from './providers/bgg.js'
import * as cf from './lib/cf.js'

/* ------------------------------------------------------------------ profile */

// How much each kind of attribute is allowed to move a score.
const KIND_WEIGHT = {
  creator: 1.0,
  genre: 0.75,
  // Keywords are the sharpest signal there is once candidates actually carry
  // them: "dark comedy" and "gangster" separate films that share a genre.
  keyword: 0.7,
  // A decade matches almost everything you are shown, so it adds roughly the
  // same amount to every candidate and decides nothing. It stays only to
  // break ties and to colour an explanation.
  decade: 0.12,
  lang: 0.15,
}

/*
 * The floor below which a film or show is not worth suggesting at all.
 *
 * This is not taste, it is noise removal: TMDB's "recommended" tails are full
 * of titles with a handful of votes, and a 5.2-rated obscurity has no business
 * outranking a good match however many of your favourites it is adjacent to.
 */
const QUALITY = {
  film: { minVotes: 200, minRating: 6.0 },
  tv: { minVotes: 80, minRating: 6.2 },
}

/*
 * A stiffer bar for anything the ratings model has never heard of.
 *
 * The MovieLens data ends in 2023, so newer films reach the list through the
 * content path alone, with no crowd verdict to temper them. That let the odd
 * thin new release through on a six-point-something and a couple of hundred
 * votes — "The Killer's Game", "Swapped" — sitting incongruously among
 * Psycho and Akira. Recent titles have to be better regarded to earn a place,
 * and a film still gathering its first votes simply waits its turn.
 */
const DATASET_ENDS = 2023
const RECENT_QUALITY = {
  film: { minVotes: 900, minRating: 6.8 },
  tv: { minVotes: 350, minRating: 7.0 },
}

/*
 * Subjects that mean "this is for a small child". Open Library returns board
 * books alongside literary fiction for the same subject search, and a
 * recommendation of "Guess How Much I Love You" to someone reading Sanderson
 * is the kind of thing that makes the whole feature look broken.
 */
const JUVENILE = /juvenile|picture book|board book|children's|toddler|baby|preschool|early reader/i
// Never, whoever you are: these are for people who cannot read yet.
const PICTURE_BOOK = /picture book|board book|toddler|baby|preschool|early reader|bedtime|nursery/i

/*
 * Subjects too broad to search on. "Fiction" sorted by rating is a list of
 * whatever Open Library's readers rate highest, which is to say the Harry
 * Potter books, and says nothing about you.
 */
const TOO_BROAD = /^(fiction|literature|non-fiction|nonfiction|novel|novels|history|biography|english literature|american literature|general)$/i

/*
 * Open Library subjects that describe a plot, not a taste.
 *
 * It tags Northern Lights with "Missing persons", so anything else about a
 * missing person scored as a match and was offered with that as the reason —
 * an Enola Holmes mystery recommended off Philip Pullman, explained by a tag
 * that barely describes either book. These say what happens in a story, which
 * is no guide at all to whether someone will enjoy another one.
 *
 * Audience tags go too. Open Library files Sabriel, Northern Lights and a
 * board book alike as children's fiction, so "you rate children's fiction
 * highly" was true of this library and useless as a signal.
 */
const PLOT_TAG = new RegExp([
  'missing persons', 'kidnapping', 'runaways?', 'orphans?', 'friendship', 'revenge',
  'interpersonal relations', 'man-woman relationships', 'fathers and (?:sons|daughters)',
  'mothers and (?:sons|daughters)', 'brothers and sisters', 'best friends', 'first loves?',
  'secrecy', 'conduct of life', 'self-realization', 'coming of age', 'identity',
  'good and evil', 'courage', 'survival', 'loss \\(psychology\\)', 'grief', 'death',
  'schools?', 'boarding schools?', 'teenage (?:girls|boys)', 'children', 'families',
  'juvenile|young adult|children\'s', 'translations into', 'large type', 'reading level',
  // Cataloguers' notes rather than anything about the book.
  '^english language$', '^english fiction$', '^american fiction$', '^british fiction$',
  '^accessible book$', '^in library$', '^open library', '^internet archive',
  '^paperback', '^hardcover', '^audiobook', '^ebook', '^new york times',
].join('|'), 'i')

/** Subjects worth neither scoring on nor citing as a reason. */
export function uselessSubject(label) {
  const g = String(label || '').trim()
  return !g || TOO_BROAD.test(g) || PLOT_TAG.test(g)
}

// TMDB keywords that are bookkeeping, not taste: "based on novel or book" is
// true of half the catalogue, and "You go for alcohol" is not a reason.
const KEYWORD_NOISE = new RegExp([
  'based on', 'stinger', 'sequel', 'remake', 'prequel', 'woman director',
  'independent film', 'alcohol', 'drug', 'nudity', 'sex', 'violence',
  'profanity', '^\\d{4}s?$', 'anthology',
  // Places. TMDB tags half its catalogue with where it was set, and "you go
  // for chicago, illinois" is not a statement about anyone's taste.
  '^[a-z .\'-]+, (?:[a-z .\'-]+)$', '\\b(?:city|island|state|county|province)\\b',
  '^(?:new york|los angeles|london|paris|tokyo|chicago|san francisco|boston|texas|california)',
].join('|'), 'i')

/*
 * A reference work is not a reading recommendation, and a subject naming a
 * language other than English marks a foreign edition. Both turn up through
 * Open Library's author index, which is loose enough that a Spanish symbols
 * dictionary is credited to Philip Pullman — he wrote a foreword to one
 * edition, so the attribution check cannot catch it.
 */
const REFERENCE = /^(dictionar|encyclop|glossar|thesaur|textbook|bibliograph|concordance|almanac|atlas|catalog)/i
const OTHER_LANGUAGE = /^(spanish|french|german|italian|portuguese|dutch|polish|russian|chinese|japanese|turkish|swedish|danish|norwegian|finnish|czech|hungarian|romanian|catalan|greek|hebrew|arabic|korean|ukrainian|latin)$/i

function passesQuality(c, profile) {
  if (c.type === 'book' || c.type === 'audiobook') {
    if (c.language && String(c.language).toLowerCase() !== 'eng') return false

    /*
     * The same hangers-on that clutter book search clutter suggestions:
     * summaries, study guides, box sets, companions. Nobody wants "Summary of
     * Project Hail Mary" recommended to them.
     */
    if (bookNoise(c.title)) return false
    if (/\b(box ?set|boxed set|omnibus|books? \d+\s*[-–]\s*\d+)\b/i.test(c.title)) return false

    const subjects = (c.genres || []).map((g) => String(g).trim())
    if (subjects.some((g) => REFERENCE.test(g))) return false
    if (subjects.some((g) => OTHER_LANGUAGE.test(g))) return false

    const ratings = c.metadata?.ratings_count ?? 0

    /*
     * Something nobody has catalogued twice and nobody has rated is not a
     * book anyone is looking for — it is a shop's display pack or a one-off
     * edition record. Real books accumulate editions.
     */
    const editions = c.popularity ?? 0
    if (editions < 2 && ratings < 3) return false

    // Open Library's own rating, already on a 0–10 scale here.
    if (ratings >= 8 && (c.external_rating ?? 10) < 6.4) return false

    if (subjects.some((g) => PICTURE_BOOK.test(g))) return false
    const juvenile = subjects.some((g) => JUVENILE.test(g))
    if (juvenile) {
      /*
       * Open Library tags Sabriel and "Guess How Much I Love You" alike as
       * children's fiction, so the tag alone cannot tell a young-adult novel
       * from a picture book. Length can: nothing under a hundred-odd pages
       * is a novel. Past that, keep it only if you actually rate children's
       * books — rated, not merely shelved.
       */
      if (c.pages && c.pages < 120) return false
      const readsJuvenile = [...(profile?.attrs?.keys() || [])]
        .some((k) => k.startsWith('genre:') && JUVENILE.test(k) && (profile.attrs.get(k)?.rated ?? 0) >= 3)
      if (!readsJuvenile) return false
    }
    return true
  }

  const recent = (c.year ?? 0) > DATASET_ENDS
  const bar = (recent ? RECENT_QUALITY[c.type] : null) ?? QUALITY[c.type]
  if (!bar) return true
  /*
   * MovieLens rates stand-up specials, concert films and shorts alongside
   * features, and the crowd model is happy to suggest them. They are not what
   * someone opening a list of film suggestions is after.
   */
  if (c.type === 'film') {
    if (c.runtime && c.runtime < 60) return false
    if ((c.genres || []).includes('TV Movie')) return false
    if ((c.metadata?.keywords || []).some((k) => /stand-up|concert film/i.test(String(k)))) return false
  }
  /*
   * Nothing unreleased, and nothing with a year nobody has filled in. TMDB
   * lists films years ahead of release; "The Mandalorian and Grogu (2026)"
   * is an announcement, not a suggestion.
   */
  const thisYear = new Date().getFullYear()
  if (!c.year || c.year > thisYear) return false

  const votes = c.metadata?.vote_count ?? 0

  /*
   * A TMDB candidate with no votes is unreleased or unwatched, not merely
   * uncounted — this escape was meant for the keyless providers, which carry
   * no vote data at all, and it was letting the entire unreleased slate past.
   */
  const fromTmdb = Boolean(c.tmdb_id) || c.provider === 'tmdb'
  if (!votes && c.external_rating == null) return !fromTmdb

  if (votes < bar.minVotes) return false
  if ((c.external_rating ?? 0) < bar.minRating) return false
  return true
}

const RECENCY_HALF_LIFE_YEARS = 5
/*
 * Shrinkage, and how much evidence an attribute needs before it is allowed to
 * drive anything. With these set too low the engine chased noise: three films
 * tagged "Male friendship" outranked two hundred tagged Drama.
 */
const SHRINK = 6
const CONFIDENCE_K = 8    // confidence = n / (n + K)
const MIN_SUPPORT = 4     // below this an attribute can explain, but not drive
const IMPLICIT_WEIGHT = 0.45
/*
 * What it means that you logged something and did not rate it.
 *
 * It means you chose it. That is weaker than a four-star rating but it is not
 * nothing, and for most of the books in a library it is the only signal there
 * is — the audiobooks arrived unrated, and a profile built from ratings alone
 * had never heard of the nature writing that makes up a third of the shelf.
 */
const LOGGED_DEV = 0.3

/*
 * Open Library subjects are too fine to calibrate a list against: a shelf
 * that is a third nature writing shows up as "Nature" 5%, "Ecology" 3%,
 * "Zoology" 3%, "Natural history" 3% and so on, none of them big enough to
 * count. For books, shares are measured in these broader shelves instead.
 */
const SHELVES = [
  ['fantasy', /\bfantasy\b|\bmagic\b|\bwizards?\b|\bdragons?\b|imaginary (places|wars)|\bquests?\b|good and evil/i],
  ['science fiction', /science fiction|\bspace\b|extraterrestrial|dystopia|time travel|\brobots?\b/i],
  ['nature', /\bnature\b|ecolog|zoolog|botan|wildlife|natural history|rewild|conservation|environment|countryside|\bbirds?\b|ornitholog|insects|\bbees\b|bumblebees|gardening|farming|rural life|\blandscapes?\b|\bforests?\b|\bmeadows?\b/i],
  ['history', /\bhistory\b|historical|\bwars?\b|military|medieval|ancient|\bempire\b/i],
  ['crime', /\bcrime\b|detective|\bmystery\b|murder|thriller|suspense|\bpolice\b/i],
  ['biography', /biograph|memoir|autobiograph|diaries|\btravel\b|voyages|description and travel/i],
  ['children', /children|juvenile|young adult|school stories|coming of age/i],
  ['science', /\bscience\b|physics|biology|evolution|mathematics|psychology|philosophy|economics|politics|sociology/i],
  ['myth', /\bmyth|\blegends?\b|folklore|fairy tales|\bgods\b|religion/i],
]

function shelfOf(type, genre) {
  if (type !== 'book' && type !== 'audiobook') return String(genre).toLowerCase()
  const g = String(genre)
  if (uselessSubject(g)) return null
  return SHELVES.find(([, re]) => re.test(g))?.[0] || null
}

/** The broad shelves a title belongs on, for calibrating the list. */
export function shelvesOf(c) {
  const limit = c.type === 'book' || c.type === 'audiobook' ? 6 : 2
  return [...new Set((c.genres || []).slice(0, limit).map((g) => shelfOf(c.type, g)).filter(Boolean))].slice(0, 2)
}

function attrsOf(work) {
  const out = []
  for (const g of work.genres || []) {
    out.push({ key: `genre:${String(g).toLowerCase()}`, weight: 1, display: String(g) })
  }
  for (const c of work.creators || []) {
    if (!c?.name) continue
    // "You like HBO" is not a useful reason to watch something.
    if (c.role === 'Network' || c.role === 'Publisher') continue
    out.push({
      key: `creator:${c.role || 'Creator'}|${String(c.name).toLowerCase()}`,
      // Sharing an actor rarely means two films are alike; sharing a director
      // usually does. Cast stays in so it can explain a pick, not choose one.
      weight: c.role === 'Cast' ? 0.12 : 1,
      display: String(c.name),
    })
  }
  for (const k of (work.metadata?.keywords || []).slice(0, 10)) {
    out.push({ key: `keyword:${String(k).toLowerCase()}`, weight: 0.9, display: String(k) })
  }
  const dec = decade(work.year)
  if (dec) out.push({ key: `decade:${dec}`, weight: 1, display: dec })
  if (work.language) out.push({ key: `lang:${String(work.language).toLowerCase()}`, weight: 1, display: String(work.language) })
  return out
}

function recencyWeight(dateStr) {
  if (!dateStr) return 0.7
  const years = (Date.now() - new Date(dateStr).getTime()) / (365.25 * 24 * 3600 * 1000)
  if (!Number.isFinite(years) || years < 0) return 1
  return 0.45 + 0.55 * Math.pow(0.5, years / RECENCY_HALF_LIFE_YEARS)
}

/**
 * Turn the log into a taste profile: for every genre, creator, decade and
 * keyword, how far above or below your own average you rate it.
 */
export function buildProfile() {
  const rows = all(`
    SELECT w.id, w.type, w.title, w.year, w.genres, w.creators, w.language, w.metadata, w.tmdb_id,
           e.rating, e.liked, e.consumed_on, e.format, e.id AS entry_id
    FROM entries e JOIN works w ON w.id = e.work_id
    ORDER BY ifnull(e.consumed_on, e.created_at) DESC`)

  /*
   * A book sits on the shelf you took it in from.
   *
   * Audiobooks are stored as books with the format on the entry, so a profile
   * keyed on the type column had no audiobooks in it at all — no favourites,
   * no authors, no narrators, nothing for the engine to reason from. The
   * audiobook shelf has a hundred and eighty titles and was being asked to
   * suggest from none of them.
   *
   * A book both read and listened to belongs to both, and counts on both.
   */
  const works = rows.flatMap((r) => {
    const base = {
      ...r,
      genres: json(r.genres, []),
      creators: json(r.creators, []),
      metadata: json(r.metadata, {}),
    }
    if (r.type !== 'book') return [base]
    if (r.format === 'audiobook') return [{ ...base, type: 'audiobook' }]
    if (r.format === 'both') return [base, { ...base, type: 'audiobook' }]
    return [base]
  })

  const ratedByType = {}
  for (const w of works) {
    if (w.rating == null) continue
    ;(ratedByType[w.type] ||= []).push(w.rating)
  }
  const meanByType = {}
  for (const [type, list] of Object.entries(ratedByType)) {
    meanByType[type] = list.reduce((a, b) => a + b, 0) / list.length
  }
  const allRated = Object.values(ratedByType).flat()
  const globalMean = allRated.length ? allRated.reduce((a, b) => a + b, 0) / allRated.length : 3.5

  /*
   * How much a mere log entry is worth, by kind. Where nearly everything is
   * rated (545 of 569 films) an unrated film is an afterthought; where almost
   * nothing is (25 of 120 books) choosing is most of the evidence there is,
   * and the weight of a log entry rises towards that of a rating.
   */
  const countByType = {}
  for (const w of works) countByType[w.type] = (countByType[w.type] || 0) + 1
  const implicitStrength = {}
  for (const [type, count] of Object.entries(countByType)) {
    const ratedShare = (ratedByType[type]?.length || 0) / count
    implicitStrength[type] = 1 + (1 - ratedShare)
  }

  const attrs = new Map()
  const seen = new Set()

  for (const w of works) {
    const mean = meanByType[w.type] ?? globalMean
    let dev
    let weight = recencyWeight(w.consumed_on)

    if (w.rating != null) {
      dev = w.rating - mean
      if (w.liked) dev += 0.25
    } else if (w.metadata?.play_count) {
      // Music arrives without stars: heavy rotation is the rating.
      dev = clamp(Math.log10(w.metadata.play_count) - 0.6, -0.5, 1.2)
      weight *= IMPLICIT_WEIGHT
    } else if (w.liked) {
      dev = 0.5
      weight *= IMPLICIT_WEIGHT
    } else {
      dev = LOGGED_DEV
      weight *= Math.min(1, IMPLICIT_WEIGHT * (implicitStrength[w.type] || 1))
    }

    for (const { key, weight: aw, display } of attrsOf(w)) {
      const slot = attrs.get(key) || { key, display, sum: 0, weightSum: 0, n: 0, rated: 0, support: [], types: new Set() }
      slot.sum += dev * weight * aw
      slot.weightSum += weight * aw
      slot.n += 1
      if (w.rating != null) slot.rated += 1
      slot.types.add(w.type)
      const dedupeKey = `${key}|${w.id}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        slot.support.push({ id: w.id, title: w.title, rating: w.rating, year: w.year, type: w.type, dev })
      }
      attrs.set(key, slot)
    }
  }

  for (const slot of attrs.values()) {
    slot.score = slot.sum / (slot.weightSum + SHRINK)
    slot.confidence = slot.n / (slot.n + CONFIDENCE_K)
    slot.support.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    slot.support = slot.support.slice(0, 5)
    slot.types = [...slot.types]
  }

  const list = [...attrs.values()]
  const pickTop = (prefix, minN) => list
    .filter((a) => a.key.startsWith(prefix) && a.n >= Math.max(minN, MIN_SUPPORT) && a.score > 0)
    .sort((a, b) => b.score * b.confidence - a.score * a.confidence)

  /*
   * What the shelf actually looks like, genre by genre: the share of your
   * films that are horror, of your books that are nature writing. The list
   * is held to roughly these proportions (see rank), which is what makes it
   * reflect the library rather than whichever genre you rate highest.
   */
  const genreShare = {}
  for (const w of works) {
    const shelves = shelvesOf(w)
    // Only what can be shelved at all counts: a book with no subjects on
    // record says nothing about the shape of the shelf.
    if (!shelves.length) continue
    const slot = (genreShare[w.type] ||= { total: 0, counts: new Map() })
    slot.total += 1
    for (const g of shelves) slot.counts.set(g, (slot.counts.get(g) || 0) + 1)
  }

  const favourites = works
    .filter((w) => w.rating != null && w.rating >= Math.max(4, (meanByType[w.type] ?? globalMean) + 0.5))
    .slice(0, 60)
  const favouriteIds = new Set(favourites.map((w) => w.id))

  return {
    attrs,
    globalMean,
    meanByType,
    genreShare,
    implicitStrength,
    counts: {
      entries: works.length,
      rated: allRated.length,
      works: new Set(works.map((w) => w.id)).size,
    },
    topCreators: pickTop('creator:', 2).slice(0, 25),
    topGenres: pickTop('genre:', 2).slice(0, 40),
    topKeywords: pickTop('keyword:', 2).slice(0, 20),
    topDecades: pickTop('decade:', 3).slice(0, 5),
    favourites,
    /*
     * Everything else you have logged, most recent first, minus what you
     * rated below your average. Favourites seed the search first, but a shelf
     * of unrated books is a shelf of choices, and with five rated shows the
     * other nineteen are most of what is known about your taste in TV.
     */
    logged: uniqueBy(
      works.filter((w) => !favouriteIds.has(w.id)
        && (w.rating == null || w.rating >= (meanByType[w.type] ?? globalMean) - 0.25)),
      (w) => w.id,
    ),
    // Music usually arrives unrated: heavy rotation is the only signal there is.
    mostPlayed: works
      .filter((w) => (w.metadata?.play_count || 0) > 0)
      .sort((a, b) => (b.metadata.play_count || 0) - (a.metadata.play_count || 0))
      .slice(0, 25),
  }
}

/*
 * What the cached suggestions were worked out from. When this changes, they
 * are no longer an answer to the current library and are recomputed.
 *
 * Entries alone are not enough. Logging something enriches it a few seconds
 * later — that is when its genres, keywords and director arrive, and those
 * are most of what the profile reasons from. The recompute triggered by the
 * entry therefore ran *before* the data it needed existed, and nothing fired
 * afterwards until the twelve-hour cache expired. So the works behind your
 * entries are watched too; candidate works the engine merely looked at are
 * not, or every suggestion run would invalidate its own cache.
 */
export function profileFingerprint() {
  const row = get(`
    SELECT
      (SELECT count(*) FROM entries) n,
      (SELECT ifnull(max(updated_at), '') FROM entries) u,
      (SELECT ifnull(sum(rating), 0) FROM entries) s,
      (SELECT ifnull(max(w.updated_at), '') FROM works w
         WHERE EXISTS (SELECT 1 FROM entries e WHERE e.work_id = w.id)) m
  `)
  return `${row.n}|${row.u}|${row.s}|${row.m}`
}

/* ----------------------------------------------------- candidate generation */

function parseCreatorKey(key) {
  const [role, name] = key.replace('creator:', '').split('|')
  return { role: role || 'Creator', name }
}

const ROLE_FOR_TYPE = {
  film: ['Director'],
  tv: ['Creator', 'Director'],
  book: ['Author'],
  audiobook: ['Author', 'Narrator'],
  album: ['Artist'],
  game: ['Developer'],
  // The credit that matters on a board game, and the one DBpedia records.
  boardgame: ['Designer'],
  podcast: ['Publisher'],
}

/*
 * How the crowd's score is put together, in the terms of lib/cf.js.
 *
 * `quality` is how much "everyone thinks it is good" counts next to "people
 * with your taste think it is good"; `popularity` is the price of fame,
 * charged per tenfold increase in raters beyond `familiar`. Set with the
 * engine's own holdout test: this mix still separates the films you rated
 * four stars and up from the ones you rated three and down with an AUC of
 * about 0.9, and brings the list's fame down from the top two hundred films
 * on MovieLens to the level of the ones you actually watch. The book data is
 * a tenth the size, so "familiar" is correspondingly smaller there.
 */
const CROWD_MIX = {
  film: { quality: 0.5, popularity: 0.12, familiar: 4000 },
  book: { quality: 0.5, popularity: 0.12, familiar: 1500 },
}
const mixFor = (type) => CROWD_MIX[type === 'audiobook' ? 'book' : type] || CROWD_MIX.film

const authorOf = (creators) => (creators || []).find((c) => c.role === 'Author' || !c.role)?.name

/**
 * Where you sit in the collaborative-filtering model for this kind of thing,
 * worked out from what you have rated — and, more weakly, from what you have
 * merely logged.
 *
 * Film and book each have their own model. Nothing for TV: there is no
 * public TV ratings set, and a show's TMDB id is a different number space
 * from a film's — a show's id was being read as a film's, which is how one
 * anime ended up with eighty "neighbours".
 */
export function crowdUser(type) {
  const kind = type === 'audiobook' ? 'book' : type
  const model = kind === 'film' ? cf.film : kind === 'book' ? cf.books : null
  if (!model?.available()) return null

  const rows = all(
    `SELECT w.id, w.title, w.creators, w.tmdb_id, max(e.rating) rating
       FROM works w JOIN entries e ON e.work_id = w.id
      WHERE w.type = ?
      GROUP BY w.id`,
    kind,
  )
  const rated = rows.filter((r) => r.rating != null)
  if (rated.length < 5) return null
  const mean = rated.reduce((a, r) => a + r.rating, 0) / rated.length

  const titleOf = new Map()
  const observations = []
  for (const r of rows) {
    const id = kind === 'film'
      ? Number(r.tmdb_id) || null
      : model.match(r.title, authorOf(json(r.creators, [])))
    if (!id) continue
    titleOf.set(id, r.title)
    observations.push(r.rating != null
      ? { id, rating: r.rating }
      : { id, rating: mean + LOGGED_DEV, weight: IMPLICIT_WEIGHT })
  }
  const user = model.foldIn(observations)
  return user ? { model, user, titleOf, kind } : null
}

/** The model's id for a candidate, if it has one. */
function crowdIdOf(crowd, c) {
  if (!crowd) return null
  if (crowd.kind === 'film') return c.type === 'film' && c.tmdb_id ? Number(c.tmdb_id) : null
  if (c.type !== 'book' && c.type !== 'audiobook') return null
  return c.metadata?.crowd_id || crowd.model.match(c.title, authorOf(c.creators))
}

/** Everything of this type with a TMDB id, rated or not: never suggest it back. */
function knownTmdbIds(type) {
  return new Set(
    all('SELECT DISTINCT tmdb_id FROM works WHERE type = ? AND tmdb_id IS NOT NULL', type)
      .map((r) => Number(r.tmdb_id)),
  )
}

export async function candidatesForType(type, profile, { breadth = 1, crowd = null } = {}) {
  const out = []
  const roles = ROLE_FOR_TYPE[type] || ['Creator']
  const ofType = (c) => {
    const { role } = parseCreatorKey(c.key)
    return c.types.includes(type) && roles.includes(role) && role !== 'Cast'
  }

  let creators = profile.topCreators.filter(ofType).slice(0, Math.round(6 * breadth))

  /*
   * A new shelf has nothing with four works behind it.
   *
   * MIN_SUPPORT asks for four before an attribute may drive the list, which
   * is the right bar on six hundred films — one shared director out of two
   * hundred is a coincidence. On a shelf of two board games it is unreachable
   * by definition, so nothing is ever suggested and nothing ever can be: you
   * would need four games by one designer before the engine said a word.
   *
   * So where the usual seeds come back empty, take the best of what little
   * there is. The scoring downstream still has to agree, and a pick resting
   * on one game says so in its reason.
   */
  if (!creators.length) {
    creators = [...profile.attrs.values()]
      .filter((a) => a.key.startsWith('creator:') && a.score > 0 && ofType(a))
      .sort((a, b) => b.score * b.confidence - a.score * a.confidence)
      .slice(0, Math.round(3 * breadth))
  }
  const genres = profile.topGenres
    .filter((g) => g.types.includes(type))
    .filter((g) => !TOO_BROAD.test(g.display || '') && !JUVENILE.test(g.key))
    .slice(0, Math.round((type === 'book' || type === 'audiobook' ? 7 : 4) * breadth))

  /*
   * Seeds: what you rated highly first, then what you merely chose. With one
   * five-star show and nothing else above the bar, every TV suggestion used
   * to trace back to Fargo; the other twenty-three shows in the log are a far
   * better picture of what you watch.
   */
  const seedWorks = uniqueBy([
    ...profile.favourites.filter((w) => w.type === type),
    ...(profile.mostPlayed || []).filter((w) => w.type === type),
    ...profile.logged.filter((w) => w.type === type),
  ], (w) => w.id).slice(0, Math.round((type === 'tv' ? 30 : 24) * breadth))

  const seeds = seedWorks

  /*
   * Attribution has to be earned, not assumed.
   *
   * This used to stamp the seed person's name onto any result that arrived
   * without credits, so that the card had a byline — which is how a Spanish
   * dictionary ended up recommended as "More from Philip Pullman". Open
   * Library's author index is not reliable enough for that. Now a result from
   * a person-specific lookup has to actually name that person, or it loses the
   * provenance that put it there.
   */
  const namesMatch = (creators, label) => {
    if (!label) return false
    const want = String(label).toLowerCase()
    const surname = want.split(/\s+/).pop()
    return (creators || []).some((c) => {
      const name = String(c?.name || '').toLowerCase()
      return name === want || (surname.length > 2 && name.includes(surname))
    })
  }

  const push = (items, via, seed, attrKey, label, role) => {
    for (const item of items || []) {
      if (!item || !item.title) continue

      if (via === 'creator' && label) {
        const credited = item.creators?.length
        if (credited && !namesMatch(item.creators, label)) continue
        if (!credited) {
          // No credits at all from a by-person lookup: keep it, but do not
          // claim who made it.
          out.push({ ...item, creators: [], type: item.type || type, via: [{ via: 'genre', seed, attrKey, label: null }] })
          continue
        }
      }

      out.push({
        ...item,
        creators: item.creators || [],
        type: item.type || type,
        via: [{ via, seed, attrKey, label }],
      })
    }
  }

  // The crowd's picks come first, and carry the most weight.
  if (crowd && type === 'film' && tmdb.hasKey()) {
    const best = crowd.model.rankAll(crowd.user, { ...mixFor(type), limit: Math.round(80 * breadth), exclude: knownTmdbIds(type) })

    const BATCH = 4
    for (let i = 0; i < best.length; i += BATCH) {
      const slice = best.slice(i, i + BATCH)
      const filled = await Promise.all(slice.map((b) => tmdb.detail(type, String(b.item_id)).catch(() => null)))
      for (let j = 0; j < filled.length; j++) {
        if (!filled[j]) continue
        out.push({ ...filled[j], type, via: [{ via: 'crowd', seed: null, attrKey: null, label: null }] })
      }
    }
  }

  if ((type === 'film' || type === 'tv') && tmdb.hasKey()) {
    // Both lists: "recommendations" is behavioural (what people who liked this
    // also liked), "similar" is content-based. They overlap, and a title in
    // both from several seeds is exactly what we are looking for.
    for (const seed of seeds) {
      const work = get('SELECT tmdb_id FROM works WHERE id = ?', seed.id)
      if (!work?.tmdb_id) continue
      push(await tmdb.recommendations(type, work.tmdb_id, 20), 'similar', seed)
      push(await tmdb.similar(type, work.tmdb_id, 12), 'similar', seed)
    }

    const genreIds = uniqueBy(
      genres.flatMap((g) => {
        const support = g.support[0]
        const meta = support ? json(get('SELECT metadata FROM works WHERE id = ?', support.id)?.metadata, {}) : {}
        return (meta.genre_ids || []).map((id) => ({ id, attrKey: g.key }))
      }),
      (x) => x.id,
    ).slice(0, 4)

    // Well-regarded titles in the genres you rate highly, and in the decades
    // you favour — the part of the catalogue you have not got to yet.
    if (genreIds.length) {
      push(await tmdb.discover(type, { genreIds: genreIds.map((g) => g.id), limit: 30 }), 'genre', null, genreIds[0].attrKey)
      for (const dec of (profile.topDecades || []).slice(0, 2)) {
        const from = Number(String(dec.display || dec.key.split(':')[1]).replace(/\D/g, ''))
        if (!from) continue
        push(
          await tmdb.discover(type, {
            genreIds: genreIds.slice(0, 2).map((g) => g.id),
            yearFrom: from, yearTo: from + 9, limit: 20,
          }),
          'genre', dec.support?.[0], dec.key, dec.display,
        )
      }
    }

    // And the people whose work you rate above your own average.
    for (const c of creators.slice(0, 6)) {
      const { name } = parseCreatorKey(c.key)
      const byPerson = await tmdb.personWorks(name, type, { limit: 14 }).catch(() => [])
      push(byPerson, 'creator', c.support[0], c.key, name)
    }
  }

  if (type === 'tv' && !tmdb.hasKey()) {
    for (const g of genres.slice(0, 2)) {
      const name = g.key.replace('genre:', '')
      push(await tvmaze.byGenre(name, { limit: 18 }), 'genre', g.support[0], g.key, g.display)
    }
  }

  if (type === 'book' || type === 'audiobook') {
    /*
     * What people who read what you read went on to rate highly. These come
     * with a title, an author and an ISBN and nothing else; the final picks
     * are filled in from Open Library afterwards.
     */
    if (crowd) {
      const best = crowd.model.rankAll(crowd.user, { ...mixFor(type), limit: Math.round(60 * breadth) })
      for (const b of best) {
        const t = crowd.model.describe(b.item_id)
        if (!t) continue
        const isbn = t.isbn13 || t.isbn || null
        out.push({
          provider: 'goodbooks',
          type,
          title: String(t.title).replace(/\s*\([^)]*\)\s*$/, ''),
          year: t.year,
          creators: String(t.authors || '').split(',').slice(0, 1).map((name) => ({ role: 'Author', name: name.trim() })).filter((c) => c.name),
          // Readers' own shelf names ("fantasy", "nature", "non-fiction"),
          // which is what a genre is.
          genres: String(t.tags || '').split(',').filter(Boolean).map((tag) => tag.replace(/-/g, ' ')),
          isbn,
          poster_url: isbn ? coverUrl(isbn, 'L', 'isbn') : null,
          metadata: { crowd_id: b.item_id, ratings_count: b.n },
          via: [{ via: 'crowd', seed: null, attrKey: null, label: null }],
        })
      }
    }

    /*
     * Authors you rate highly are the strongest book signal by a distance —
     * Open Library's subjects are a jumble ("Fiction", "History", "Histoire"),
     * and with only a couple of dozen books rated, an attribute threshold
     * built for six hundred films admits almost no authors at all.
     *
     * So the authors of individual books you thought were good count as seeds
     * in their own right, the same way one well-played album seeds music —
     * and after them, the authors you have gone back to, and the authors of
     * the books you simply read.
     */
    const returnedTo = [...profile.attrs.values()]
      .filter((a) => a.key.startsWith('creator:Author|') && a.types.includes(type) && a.n >= 2 && a.score > 0)
      .sort((a, b) => b.score * b.confidence - a.score * a.confidence)
    const seedAuthors = uniqueBy(
      [
        ...[...creators, ...returnedTo].map((c) => ({
          name: c.display || parseCreatorKey(c.key).name,
          support: c.support[0],
          key: c.key,
        })),
        ...seeds.map((w) => {
          const row = get('SELECT creators, metadata FROM works WHERE id = ?', w.id)
          const author = json(row?.creators, []).find((c) => c.role === 'Author' || !c.role)
          return author
            ? { name: author.name, support: w, key: `creator:Author|${String(author.name).toLowerCase()}`, metadata: json(row?.metadata, {}) }
            : null
        }).filter(Boolean),
      ],
      (a) => String(a.name).toLowerCase(),
    ).slice(0, Math.round(24 * breadth))

    for (const a of seedAuthors) {
      const meta = a.metadata
        || (a.support ? json(get('SELECT metadata FROM works WHERE id = ?', a.support.id)?.metadata, {}) : {})
      /*
       * Google Books describes one edition, so its categories and authors
       * are steadier than Open Library's merged works; it leads when a key
       * is set, and Open Library fills in whenever it has nothing to say.
       */
      let byAuthor = gbooks.hasKey() ? await gbooks.byAuthor(a.name, { limit: 16, type }).catch(() => []) : []
      if (!byAuthor.length) {
        const authorKey = (meta.author_keys || [])[0]
        byAuthor = authorKey
          ? await ol.byAuthorKey(authorKey, { limit: 20, type })
          : await ol.search(a.name, { limit: 14, type, author: a.name })
      }
      push(byAuthor, 'creator', a.support, a.key, a.name, 'Author')
      if (type === 'audiobook') push(await itunes.search('audiobook', a.name, 8), 'creator', a.support, a.key, a.name, 'Author')
    }

    for (const g of genres.slice(0, 7)) {
      push(await ol.bySubject(g.display || g.key.replace('genre:', ''), { limit: 20, type }), 'genre', g.support[0], g.key, g.display)
    }
  }

  if (type === 'album' || type === 'track') {
    // One album per artist is normal in music, so seed from the artists behind
    // your best-rated and most-played records rather than waiting for n >= 2.
    const seedArtists = uniqueBy(
      [
        ...creators.map((c) => ({ name: c.display || parseCreatorKey(c.key).name, support: c.support[0] })),
        ...seeds.map((w) => {
          const row = get('SELECT creators, metadata FROM works WHERE id = ?', w.id)
          const artist = json(row?.creators, []).find((c) => c.role === 'Artist')
          return artist ? { name: artist.name, support: w, metadata: json(row?.metadata, {}) } : null
        }).filter(Boolean),
      ],
      (a) => a.name.toLowerCase(),
    ).slice(0, Math.round(8 * breadth))

    for (const artist of seedArtists) {
      const meta = artist.metadata
        || (artist.support ? json(get('SELECT metadata FROM works WHERE id = ?', artist.support.id)?.metadata, {}) : {})
      const key = `creator:Artist|${artist.name.toLowerCase()}`
      if (meta?.artist_id) push(await itunes.byArtist('album', meta.artist_id, 12), 'creator', artist.support, key, artist.name, 'Artist')
      else push(await itunes.search('album', artist.name, 8), 'creator', artist.support, key, artist.name, 'Artist')
    }
    // MusicBrainz tags are real genre data; an iTunes text search for "Alternative" is not.
    for (const g of genres.slice(0, 3)) {
      push(await mb.byTag(g.display || g.key.replace('genre:', ''), 16), 'genre', g.support[0], g.key, g.display)
    }
  }

  if (type === 'podcast') {
    for (const g of genres.slice(0, 3)) {
      push(await itunes.search('podcast', g.display || g.key.replace('genre:', ''), 10), 'genre', g.support[0], g.key, g.display)
    }
  }

  if (type === 'boardgame') {
    /*
     * Who designed it is the whole signal.
     *
     * A Knizia and a Feld feel nothing like each other, and people who like
     * one tend to like the rest of theirs — it is the board game equivalent
     * of a director, and far stronger than a publisher or a shelf label.
     * Nothing else here is worth asking: Wikidata records no mechanics and
     * BoardGameGeek, which records all of them, is closed.
     */
    /*
     * Titles are a poor way to tell board games apart: Catan and The Settlers
     * of Catan are the same box, and the engine would have cheerfully offered
     * one to someone who owns the other. BoardGameGeek's id is the same for
     * both, so that is what ownership is checked against here.
     */
    const owned = new Set(
      all("SELECT json_extract(metadata, '$.bgg_id') bgg FROM works WHERE type = 'boardgame'")
        .map((r) => r.bgg).filter(Boolean).map(String),
    )

    const bggHot = bgg.hasKey() ? await bgg.hotDetailed(Math.round(40 * breadth)).catch(() => null) : null

    /*
     * What BoardGameGeek is talking about, as a pool to rank against.
     *
     * Every one of them arrives with its categories and its mechanics, which
     * is the first time this shelf has had anything to match on besides a
     * designer — "worker placement" and "deduction" are what people mean when
     * they say what they like about a game.
     */
    if (bggHot) {
      push(bggHot.filter((g) => !g.metadata?.bgg_id || !owned.has(String(g.metadata.bgg_id))),
        'genre', null, null, null)
    }

    for (const c of creators.slice(0, 4)) {
      const { role, name } = parseCreatorKey(c.key)
      if (role !== 'Designer') continue
      const found = await boardgame.byDesigner(name, Math.round(14 * breadth))
      push(
        found.filter((g) => !g.metadata?.bgg_id || !owned.has(String(g.metadata.bgg_id))),
        'creator', c.support[0], c.key, c.display || name, 'Designer',
      )
    }
  }

  if (type === 'game') {
    /*
     * The week's most-played, as a pool to rank your taste against.
     *
     * The Wikidata path below only fires for people you already rate highly,
     * which is nothing at all until a few games are logged. This gives the
     * engine a catalogue to reason about from the first game onwards. Steam
     * is one storefront and so one view of the medium, but it is the only
     * free one, and the scoring still has to agree before anything is shown.
     */
    push(await steam.charts({ limit: Math.round(40 * breadth) }), 'genre', null, null, null)
  }

  // Keyless film/TV/game: Wikidata knows the full catalogue of everyone you rate highly.
  if ((type === 'film' && !tmdb.hasKey()) || type === 'game' || (type === 'tv' && !tmdb.hasKey())) {
    for (const c of creators.slice(0, 5)) {
      const { role, name } = parseCreatorKey(c.key)
      const entity = await wikidata.findEntity(name, type)
      if (!entity) continue
      const works = await wikidata.worksBy(entity.qid, type, { role, limit: 25 })
      push(works, 'creator', c.support[0], c.key, c.display || name, role)
    }
  }

  return out
}

/* ------------------------------------------------------------------ scoring */

function candidateAttrs(c) {
  return attrsOf({
    genres: c.genres,
    creators: c.creators,
    year: c.year,
    language: c.language,
    metadata: c.metadata,
  })
}

const STAR = (n) => (n == null ? '' : '★'.repeat(Math.floor(n)) + (n % 1 ? '½' : ''))
const roundHalf = (n) => Math.round(n * 2) / 2

function explain(candidate, profile, contributions, crowdSlot) {
  const bits = []
  const creatorVia = candidate.via.find((v) => v.via === 'creator' && v.seed)
  const similarVia = candidate.via.find((v) => v.via === 'similar' && v.seed)

  /*
   * The crowd's reason is the most convincing one there is, so it leads:
   * naming the films of yours it rests on makes it checkable rather than
   * something you have to take on faith. The stars are the model's prediction
   * of what you would give it, which is a claim you can hold it to.
   */
  if (crowdSlot?.because?.length) {
    const named = crowdSlot.because.map((b) => b.title).filter(Boolean).slice(0, 2)
    const stars = STAR(clamp(roundHalf(crowdSlot.predicted), 0.5, 5))
    if (named.length) {
      /*
       * Say how much of the library this rests on.
       *
       * The prediction comes from the whole of it — every rating is folded
       * into the taste vector that produces this number — but the sentence
       * only had room to name the two titles that moved it most, which read
       * as though the whole recommendation hung on those two. It does not,
       * and saying so is the difference between a suggestion that looks
       * arbitrary and one that looks earned.
       */
      const basis = crowdSlot.basis || 0
      const rest = basis > named.length ? ` and ${basis - named.length} others you have rated` : ''
      bits.push(
        `Predicted ${stars} for you, from how people who share your taste rated`
        + ` ${named.join(', ')}${rest}`,
      )
    }
  }

  if (similarVia) {
    bits.push(`Similar to ${similarVia.seed.title}${similarVia.seed.rating ? ` (${STAR(similarVia.seed.rating)})` : ', which you logged'}`)
  }
  if (creatorVia) {
    const slot = creatorVia.attrKey ? profile.attrs.get(creatorVia.attrKey) : null
    const name = slot?.display || creatorVia.label
      || parseCreatorKey(creatorVia.attrKey || 'creator:Creator|').name
    const seed = creatorVia.seed
    bits.push(seed
      ? `More from ${name} — you ${seed.rating ? `gave ${seed.title} ${STAR(seed.rating)}` : `read ${seed.title}`}`
      : `More from ${name}`)
  }
  for (const c of contributions.slice(0, 6)) {
    if (bits.length >= 2) break
    // A reason has to be a reason *for* the pick.
    if (c.contribution <= 0) continue
    if (c.key.startsWith('creator:') && creatorVia) continue
    // Decades are a weak signal: only mention one if nothing better turned up.
    if (c.key.startsWith('decade:') && contributions.some((x) => x !== c && x.contribution > 0 && !x.key.startsWith('decade:'))) continue
    const label = c.slot.display || c.key.split(':').pop()
    if (c.key.startsWith('genre:')) {
      // "You rate Fiction above your average" is not a reason.
      if (uselessSubject(label)) continue
      const top = c.slot.support[0]
      bits.push(c.slot.rated >= MIN_SUPPORT
        ? `You rate ${label} above your average${top ? ` (${top.title} ${STAR(top.rating)})` : ''}`
        : `You keep picking ${label}${top ? ` (${top.title})` : ''}`)
    } else if (c.key.startsWith('creator:')) {
      bits.push(`You like ${label}`)
    } else if (c.key.startsWith('keyword:')) {
      if (KEYWORD_NOISE.test(label)) continue
      bits.push(`You go for ${label}`)
    } else if (c.key.startsWith('decade:')) {
      bits.push(`${label} is a sweet spot for you`)
    }
  }
  return uniqueBy(bits, (b) => b.slice(0, 20)).slice(0, 2)
}

function excluded() {
  const logged = new Set(
    all('SELECT DISTINCT w.type, w.title FROM works w JOIN entries e ON e.work_id = w.id')
      .map((r) => `${r.type}|${normaliseTitle(r.title)}`),
  )
  for (const r of all("SELECT ifnull(type,'') type, title FROM recs WHERE status IN ('open','dismissed','done')")) {
    logged.add(`${r.type}|${normaliseTitle(r.title)}`)
  }
  for (const r of all('SELECT fingerprint FROM rec_blocks')) logged.add(r.fingerprint)
  return logged
}

const fpOf = (c) => c.fingerprint || `${c.type}|${normaliseTitle(c.title)}`

/*
 * How far the crowd's view moves a score. Its score is on the scale of a star
 * deviation (a lift of 0.5 means "half a star more than most people"), and the
 * taste profile's contributions add up to a few tenths; this keeps the crowd
 * in charge of film while leaving the profile room to reorder.
 */
const CROWD_WEIGHT = 1.6

/*
 * The angles a suggestion can be found from.
 *
 * Refreshing used to re-run one algorithm and push the last list down the
 * order, which turns a list over without ever changing its mind: the same
 * reasoning, applied twice, finds much the same things. Each refresh now
 * moves to the next angle, which re-weights what the engine is allowed to
 * reason from — so one pass answers "who do you keep coming back to", the
 * next "what do people with your ratings rate highly", the next "what sits
 * beside the things you loved". The candidate pool is five hundred wide; the
 * difference between these lists is which of it rises.
 *
 *   kind   multiplies a kind of evidence (creator, genre, keyword, decade)
 *   crowd  multiplies the collaborative model's say
 *   links  multiplies the "adjacent to something you rated" bonus
 *
 * A negative multiplier inverts the evidence, which is how the last angle
 * looks for the decades and languages you have *not* been reading in.
 */
const ANGLES = [
  {
    key: 'taste',
    label: 'across your taste',
    blurb: 'Everything the engine knows about you, weighed together.',
    kind: {}, crowd: 1, links: 1,
  },
  {
    key: 'people',
    label: 'by people you return to',
    blurb: 'Led by the directors, writers and authors you keep going back to.',
    kind: { creator: 2.2, genre: 0.5, keyword: 0.5, decade: 0.4 }, crowd: 0.5, links: 1.4,
  },
  {
    key: 'crowd',
    label: 'from people who rate like you',
    blurb: 'Led by what people whose ratings match yours scored highly.',
    kind: { creator: 0.45, genre: 0.5, keyword: 0.5, decade: 0.3 }, crowd: 2, links: 0.6,
  },
  {
    key: 'adjacent',
    label: 'next to things you loved',
    blurb: 'Led by what sits closest to the titles you rated highest.',
    kind: { keyword: 1.9, genre: 1.3, creator: 0.6, decade: 0.5 }, crowd: 0.8, links: 2.3,
  },
  {
    key: 'unexplored',
    label: 'from corners you have not been to',
    blurb: 'Your genres, but from the decades and languages you have missed.',
    kind: { genre: 1.3, keyword: 1.1, creator: 0.5, decade: -1, lang: -1 }, crowd: 0.8, links: 0.7,
  },
]

const angleByKey = (key) => ANGLES.find((a) => a.key === key) || ANGLES[0]
/*
 * The next angle round. A list with no angle recorded was built before there
 * were any, by the balanced reasoning that is now the first of them — so it
 * counts as that one, and refreshing moves off it rather than back onto it.
 */
const nextAngle = (key) => {
  const i = ANGLES.findIndex((a) => a.key === key)
  return ANGLES[((i < 0 ? 0 : i) + 1) % ANGLES.length]
}

/*
 * Diversity. The old penalties were too small to matter — a twentieth of a
 * point per repeated genre, nothing at all for two picks resting on the same
 * film of yours — so a list could be ten crime films that all traced back to
 * Fargo. These are large enough to bite.
 */
const DIVERSITY = {
  creator: 0.45,      // per earlier pick by the same person
  calibration: 0.3,   // per pick a shelf would be over (or is still under) its share of the list
  seed: 0.2,          // per earlier pick explained by the same title of yours
}

/**
 * How far adding a title would push its shelves over, or leave them under,
 * their share of the list (Steck 2018, in whole picks): positive when a shelf
 * would then hold more of the list than it does of the library, negative
 * when it is still owed picks. A shelf that is a quarter of the library is
 * owed three of twelve, and the third nature book costs nothing while the
 * seventh fantasy novel costs the whole surplus.
 */
export function miscalibration(shelf, shelves, listCounts, listTotal) {
  if (!shelf?.total || !shelves.length) return 0
  let drift = 0
  for (const key of shelves) {
    const expected = ((shelf.counts.get(key) || 0) / shelf.total) * (listTotal + 1)
    drift += (listCounts.get(key) || 0) + 1 - expected
  }
  return drift / shelves.length
}

/** The titles of yours a pick is standing on, for the "same seed" penalty. */
function seedsOf(c) {
  const ids = new Set()
  for (const v of c.via) if (v.seed?.id) ids.add(`w${v.seed.id}`)
  for (const b of c.crowd?.because || []) ids.add(`c${b.item_id}`)
  return [...ids]
}

/** Score, explain and diversify. */
export function rank(candidates, profile, {
  limit = 12, shortlistOnly = false, crowd = null, shownBefore = null,
  skipShown = false, angle = ANGLES[0],
} = {}) {
  const skip = excluded()
  const distaste = buildDistaste()
  const merged = new Map()

  for (const c of candidates) {
    const fp = `${c.type}|${normaliseTitle(c.title)}`
    if (skip.has(fp)) continue
    const prev = merged.get(fp)
    if (prev) {
      prev.via.push(...c.via)
      // Keep whichever copy carries more metadata.
      if (!prev.poster_url && c.poster_url) prev.poster_url = c.poster_url
      if (!prev.overview && c.overview) prev.overview = c.overview
      if ((c.genres || []).length > (prev.genres || []).length) prev.genres = c.genres
      if ((c.creators || []).length > (prev.creators || []).length) prev.creators = c.creators
      continue
    }
    merged.set(fp, { ...c, fingerprint: fp })
  }

  const scored = []
  for (const c of merged.values()) {
    const contributions = []
    for (const { key, weight } of candidateAttrs(c)) {
      const slot = profile.attrs.get(key)
      if (!slot) continue
      const kind = key.split(':')[0]
      /*
       * A genre learnt from your TV ratings should nudge, not drive, a book
       * pick. Film and TV are close enough cousins that a film taste for
       * dark comedy is most of what is known about your TV taste.
       */
      const sameFamily = (a, b) => (a === 'film' && b === 'tv') || (a === 'tv' && b === 'film')
      const crossMedia = slot.types.includes(c.type) ? 1
        : slot.types.some((t) => sameFamily(t, c.type)) ? 0.7 : 0.4
      // Thin evidence can colour a recommendation but must not choose it.
      const support = slot.n >= MIN_SUPPORT ? 1 : 0.25
      /*
       * The angle's say over this kind of evidence. A negative multiplier
       * inverts it, which is what makes "corners you have not been to" look
       * for the decades you have been avoiding rather than the ones you live in.
       */
      const lens = angle.kind?.[kind] ?? 1
      const contribution = slot.score * slot.confidence * (KIND_WEIGHT[kind] ?? 0.4)
        * weight * crossMedia * support * lens
      contributions.push({ key, slot, contribution })
    }
    contributions.sort((a, b) => b.contribution - a.contribution)

    /*
     * Only the strongest few of each kind count. Open Library tags one
     * fantasy novel "Magic", "Fantasy fiction", "Fiction, fantasy, epic" and
     * "Imaginary places" at once, and letting every tag add up meant a book
     * with five names for the same thing beat one with a single sharp match.
     */
    let score = 0
    const counted = {}
    for (const c of contributions) {
      const kind = c.key.split(':')[0]
      counted[kind] = (counted[kind] || 0) + 1
      if (c.contribution > 0 && counted[kind] > 3) continue
      score += c.contribution
    }

    /*
     * What the crowd thinks. This is evidence rather than inference, so it
     * carries more weight than anything else here — but it only applies to
     * films the model knows, so the rest of the scoring still has to stand on
     * its own for everything else.
     */
    let crowdSlot = null
    const crowdId = crowdIdOf(crowd, c)
    // Another edition of something you have already read: "Mistborn" is
    // "Mistborn: The Final Empire", and the model knows it.
    if (crowdId && crowd.user.rated.has(crowdId)) continue
    if (crowdId) {
      const s = crowd.model.score(crowd.user, crowdId, mixFor(c.type))
      if (s) {
        crowdSlot = {
          ...s,
          because: crowd.model.because(crowd.user, crowdId).map((b) => ({ ...b, title: crowd.titleOf.get(b.item_id) })),
        }
        score += CROWD_WEIGHT * (angle.crowd ?? 1) * s.score

        /*
         * The model predicting three stars for someone who averages four is
         * the model saying "you would not much like this". It still scores
         * above an unknown title on confidence alone, which is how The
         * Vampire Diaries arrived at a predicted ★★★. Suggesting something
         * you are expected to rate below your own average is self-defeating.
         */
        const typeMean = profile.meanByType[c.type] ?? profile.globalMean
        if (s.predicted != null && s.predicted < typeMean - 0.1) score -= 1.2
      }
    }

    /*
     * A book nobody has vouched for, matched on nothing but subject tags, is
     * the weakest thing this engine can produce — and Open Library's tags are
     * loose enough that it produced plenty. Where a crowd verdict or an author
     * you return to was available and this has neither, it goes to the back.
     *
     * Not excluded outright: for a book too new or too obscure for the ratings
     * data, subject matching is all there is, and it is better than nothing.
     */
    if ((c.type === 'book' || c.type === 'audiobook') && !crowdSlot) {
      const fromPerson = c.via.some((v) => v.via === 'creator' && v.seed)
      if (!fromPerson) score -= 0.5
    }

    /*
     * Provenance: being adjacent to something you loved is evidence, but one
     * such link is weak evidence — every film has a hundred neighbours. What
     * counts is *how many* of your favourites point at the same title, so the
     * bonus grows with the square root of that count and saturates. A link
     * from something you logged but did not rate is worth a little.
     */
    const mean = profile.meanByType[c.type] ?? profile.globalMean
    const links = c.via.filter((v) => (v.via === 'similar' || v.via === 'creator') && v.seed)
    if (links.length) {
      const unratedLift = 0.15 * (profile.implicitStrength?.[c.type] || 1)
      const lift = links.reduce((a, v) => a + (v.seed.rating != null ? Math.max(0, v.seed.rating - mean) : unratedLift), 0) / links.length
      const breadth = Math.sqrt(links.length)
      score += 0.16 * (angle.links ?? 1) * breadth * (0.5 + lift)
    }

    /*
     * Quality prior. Deliberately firm: you rate 545 films at 3.6 on average,
     * so you watch well-regarded things, and a suggestion that is merely
     * adjacent to your taste but widely thought poor is a bad suggestion.
     *
     * Only a rating with some weight behind it counts. A 10/10 from a handful
     * of Open Library users was enough to float a Spanish dictionary to the
     * top of the book suggestions.
     */
    const backing = c.metadata?.vote_count ?? c.metadata?.ratings_count ?? 0
    const trusted = c.type === 'book' || c.type === 'audiobook' ? backing >= 8 : true
    if (c.external_rating != null && trusted) score += 0.55 * (c.external_rating / 10 - 0.66)
    // An author's one-off that nobody has catalogued or rated is their
    // least likely book to be the one you want next.
    if ((c.type === 'book' || c.type === 'audiobook') && backing < 3 && (c.popularity ?? 0) < 3) score -= 0.15
    const votes = c.metadata?.vote_count ?? 0
    if (votes) score += 0.08 * Math.min(2.2, Math.log10(1 + votes) - 2)
    if (c.popularity) score += 0.04 * Math.min(2, Math.log10(1 + c.popularity))
    if (!c.poster_url) score -= 0.08

    /*
     * Already offered recently. When there is enough left in the pool to
     * build a whole list without them, a refresh drops them outright — a
     * refresh that returns half the same titles is not one. Otherwise they
     * are merely pushed down, so a thin library still gets a full list.
     */
    if (shownBefore?.has(fpOf(c))) {
      if (skipShown) continue
      score -= 0.45
    }

    // And things built like the ones you have refused.
    score -= distastePenalty(c, distaste, profile)

    const reasons = explain(c, profile, contributions, crowdSlot)

    /*
     * If nothing can be said about why this is here, it should not be here.
     * An unexplained suggestion is indistinguishable from a random one, and
     * the explanation is the part that makes the list worth trusting.
     */
    if (!reasons.length) continue

    scored.push({ ...c, score, contributions, crowd: crowdSlot, reasons })
  }

  scored.sort((a, b) => b.score - a.score)
  if (shortlistOnly) return scored

  /*
   * Diversify. Greedy: each round takes the best remaining candidate after
   * charging it for what the list already has — the same director, the same
   * title of yours doing the explaining — and for how far adding it would
   * pull the list's mix of shelves away from the library's own. That last
   * one is a calibration rather than a flat penalty, and it works both ways:
   * a shelf that is a fifth horror should get a list that is about a fifth
   * horror, however highly crime is rated — and a shelf that is a fifth
   * nature writing, none of it rated, should still see some nature writing,
   * which no rating-driven score would ever put there.
   *
   * Subtracted, not multiplied: a score can be negative (anything shown on a
   * recent refresh is pushed below zero on purpose), and multiplying a
   * negative number by a penalty makes it *bigger*.
   */
  const picked = []
  const creatorCount = new Map()
  const genreCount = new Map()
  const seedCount = new Map()
  /*
   * Deep enough that calibration can reach the things the score alone
   * buries: an unrated nature book sits two hundred places down a list
   * ranked by ratings, and the whole point of the lift above is to go and
   * get it.
   */
  const pool = scored.slice(0, Math.max(limit * 25, 400))
  const shelf = profile.genreShare?.[pool[0]?.type] || profile.genreShare?.[Object.keys(profile.genreShare || {})[0]]

  while (picked.length < limit && pool.length) {
    let bestIdx = -1
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      let penalty = 0
      for (const cr of c.creators || []) {
        if (cr.role === 'Cast') continue
        const n = creatorCount.get(String(cr.name).toLowerCase()) || 0
        if (n) penalty += DIVERSITY.creator * n
      }
      // Something with no shelf neither helps nor hurts the mix.
      penalty += DIVERSITY.calibration * miscalibration(shelf, shelvesOf(c), genreCount, picked.length)
      for (const s of seedsOf(c)) {
        const n = seedCount.get(s) || 0
        if (n) penalty += DIVERSITY.seed * n
      }
      const adjusted = c.score - penalty
      if (adjusted > bestScore) { bestScore = adjusted; bestIdx = i }
    }
    if (bestIdx < 0) break
    const [chosen] = pool.splice(bestIdx, 1)
    picked.push({ ...chosen, adjustedScore: bestScore })
    for (const cr of chosen.creators || []) {
      if (cr.role === 'Cast') continue
      const k = String(cr.name).toLowerCase()
      creatorCount.set(k, (creatorCount.get(k) || 0) + 1)
    }
    for (const k of shelvesOf(chosen)) genreCount.set(k, (genreCount.get(k) || 0) + 1)
    for (const s of seedsOf(chosen)) seedCount.set(s, (seedCount.get(s) || 0) + 1)
  }

  return picked
}

/**
 * Fill in the credits and keywords a list-shaped result does not carry.
 *
 * Only the shortlist is fetched, a few at a time to stay polite, and anything
 * that fails keeps whatever it already had rather than dropping out.
 */
async function hydrateDetails(type, shortlist) {
  if ((type !== 'film' && type !== 'tv') || !tmdb.hasKey()) return shortlist

  const BATCH = 4
  const out = []
  for (let i = 0; i < shortlist.length; i += BATCH) {
    const slice = shortlist.slice(i, i + BATCH)
    const filled = await Promise.all(slice.map(async (c) => {
      if (!c.tmdb_id || c.metadata?.keywords?.length) return c
      const full = await tmdb.detail(type, c.tmdb_id).catch(() => null)
      if (!full) return c
      return {
        ...c,
        creators: full.creators?.length ? full.creators : c.creators,
        genres: full.genres?.length ? full.genres : c.genres,
        overview: c.overview || full.overview,
        runtime: c.runtime ?? full.runtime,
        language: c.language || full.language,
        imdb_id: c.imdb_id || full.imdb_id,
        metadata: { ...(c.metadata || {}), ...(full.metadata || {}) },
      }
    }))
    out.push(...filled)
  }
  return out
}

/**
 * Fill in the crowd's book picks from Open Library: a cover, subjects, the
 * first line. Only the final list, one lookup each, cached for a week.
 */
async function hydrateBooks(picks) {
  for (const p of picks) {
    if (p.provider !== 'goodbooks' || !p.isbn) continue
    /*
     * Both, not one or the other. Open Library answers for almost every ISBN
     * but has a cover for only some of them, and until default=false it said
     * so with a blank image that looked like success — which is why every
     * crowd-picked audiobook had an invisible card. Google's cover is
     * preferred when there is one; Open Library remains the better source
     * for everything else about the book.
     */
    const [olFound, gbFound] = await Promise.all([
      ol.byIsbn(p.isbn, p.type).catch(() => null),
      gbooks.hasKey() ? gbooks.byIsbn(p.isbn, p.type).catch(() => null) : null,
    ])
    const found = olFound || gbFound
    if (!found) continue
    p.olid = found.olid || p.olid
    p.poster_url = gbFound?.poster_url || olFound?.poster_url || p.poster_url
    p.overview = p.overview || found.overview
    p.pages = p.pages ?? found.pages
    if (found.genres?.length) p.genres = found.genres
    p.external_rating = found.external_rating ?? p.external_rating
  }
  return picks
}

/** Put artwork on the final shortlist (one batched request for Wikidata picks). */
async function hydrateArtwork(picks) {
  const needs = picks.filter((p) => !p.poster_url && p.metadata?.wikipedia_title)
  if (needs.length) {
    const map = await wiki.batchPageImages(needs.map((p) => p.metadata.wikipedia_title))
    for (const p of needs) {
      const info = map.get(p.metadata.wikipedia_title)
      if (info?.poster_url) {
        p.poster_url = info.poster_url
        p.backdrop_url = info.backdrop_url
        if (!p.overview) p.overview = info.overview
      }
    }
  }
  // Anything still bare: one targeted search each, capped so this stays quick.
  const stillBare = picks.filter((p) => !p.poster_url).slice(0, 6)
  for (const p of stillBare) {
    const hits = await wiki.search(p.type, `${p.title} ${p.year || ''}`.trim(), 3)
    const hit = hits.find((h) => normaliseTitle(h.title) === normaliseTitle(p.title)) || hits[0]
    if (hit?.poster_url) {
      p.poster_url = hit.poster_url
      p.backdrop_url = hit.backdrop_url
      if (!p.overview) p.overview = hit.overview
    }
  }
  return picks
}

/* ------------------------------------------------------------------- public */

const CACHE_TTL_MS = 12 * 60 * 60 * 1000

export async function recommend(type, { limit = 12, force = false, breadth = 1 } = {}) {
  const fingerprint = profileFingerprint()
  const cached = get('SELECT * FROM rec_cache WHERE type = ? ORDER BY id DESC LIMIT 1', type)
  if (!force && cached) {
    const payload = json(cached.payload, null)
    const age = Date.now() - new Date(cached.computed_at + 'Z').getTime()
    /*
     * The cached list is only usable if it is at least as long as the one
     * being asked for. "Show more" asks for a bigger slice, and without this
     * check it was handed back the same short list it already had — which is
     * why the button appeared to do nothing at all.
     */
    const longEnough = (payload?.picks?.length ?? 0) >= limit
    if (payload && payload.fingerprint === fingerprint && age < CACHE_TTL_MS && longEnough) {
      return { ...payload, picks: payload.picks.slice(0, limit), cached: true }
    }
  }

  const profile = buildProfile()
  const anythingOfType = profile.favourites.some((w) => w.type === type) || profile.logged.some((w) => w.type === type)
  if (!anythingOfType && !profile.counts.rated) {
    return { type, fingerprint, picks: [], profileThin: true, cached: false }
  }

  /*
   * What the last couple of refreshes already offered.
   *
   * Pressing Refresh and seeing the same eight titles is not a refresh. The
   * engine is deterministic, so without this the same list comes back every
   * time — the fix is to push what you have already been shown down the order
   * rather than to add randomness, so a genuinely strong pick can still hold
   * its place while the rest of the list turns over.
   */
  const shownBefore = new Set()
  if (force) {
    // One list per angle: a full turn of the rotation should not repeat itself.
    for (const row of all('SELECT payload FROM rec_cache WHERE type = ? ORDER BY id DESC LIMIT ?', type, ANGLES.length)) {
      for (const fp of json(row.payload, {})?.picks?.map((p) => p.fingerprint) || []) shownBefore.add(fp)
    }
  }

  /*
   * Refreshing moves to the next angle; asking for more of the list you are
   * already reading keeps the one it was built with, or the whole thing would
   * re-reason itself underneath you.
   */
  const lastAngle = json(cached?.payload, null)?.angle
  const angle = force ? nextAngle(lastAngle) : angleByKey(lastAngle)

  /*
   * A refresh deliberately does *not* widen the net. Casting further afield
   * was measured at fifteen seconds for five extra book candidates — Open
   * Library is the bottleneck and asking it more questions barely moves the
   * pool, while putting the request within range of the proxy's patience.
   * The angle below is what makes a refresh different; the pool stays put.
   */

  // Worked out once and used twice: to find candidates, and to score them.
  const crowd = crowdUser(type)
  const raw = await candidatesForType(type, profile, { breadth, crowd })

  // Noise removal before anything else: an obscure badly-reviewed title is not
  // a suggestion whatever it sits next to.
  const candidates = raw.filter((c) => passesQuality(c, profile))

  /*
   * Two passes.
   *
   * Candidates arrive from search-shaped endpoints, which carry a title, a
   * year, a rating and genres — but no director and no keywords. Those are the
   * two sharpest things the profile knows about you, so scoring at this point
   * can only compare genres and decades, and the result was close to a coin
   * toss dressed up with reasons.
   *
   * So: score cheaply, take a shortlist, fetch the full record for those, and
   * score again properly. The detail responses are cached for a month, so this
   * is mostly free on the second run.
   *
   * The shortlist is itself chosen with the diversity rules, not by raw score:
   * the point of calibrating the list to the shelf is to reach the things a
   * rating-driven score buries two hundred places down, and a shortlist of
   * the seventy highest scores would never contain them.
   */
  /*
   * The shortlist only demotes what has been shown before, so those titles
   * stay hydrated and available. The final cut drops them outright — a
   * refresh that hands back half the same list is not a refresh — but if
   * dropping them leaves the page short, they come back in, merely pushed
   * down. A full page with a couple of familiar faces beats four titles.
   */
  const shortlist = rank(candidates, profile, {
    limit: Math.max(limit * 5, 60), crowd, shownBefore, angle,
  })
  const detailed = await hydrateDetails(type, shortlist)

  const ranked = rank(detailed, profile, { limit, crowd, shownBefore, skipShown: force, angle })
  if (force && ranked.length < limit) {
    /*
     * Top up rather than start again: everything genuinely new keeps the top
     * of the list, and familiar titles only fill the space underneath it. An
     * angle that finds four unseen books should show those four first, not be
     * replaced wholesale by a list that is mostly repeats.
     */
    const seen = new Set(ranked.map(fpOf))
    for (const c of rank(detailed, profile, { limit: limit * 2, crowd, shownBefore, angle })) {
      if (ranked.length >= limit) break
      if (seen.has(fpOf(c))) continue
      seen.add(fpOf(c))
      ranked.push(c)
    }
  }
  const picks = await hydrateArtwork(await hydrateBooks(ranked))

  const payload = {
    type,
    fingerprint,
    computed_at: new Date().toISOString(),
    candidateCount: candidates.length,
    // Which way the engine was looking, so the page can say so and the next
    // refresh knows where to go next.
    angle: angle.key,
    angleLabel: angle.label,
    angleBlurb: angle.blurb,
    // Which catalogue actually answered, rather than which key happens to be
    // configured — books have never come from TMDB and saying so was a lie.
    usingTmdb: (type === 'film' || type === 'tv') && tmdb.hasKey(),
    source: type === 'film' || type === 'tv' ? (tmdb.hasKey() ? 'TMDB' : 'Wikidata')
      : type === 'book' || type === 'audiobook' ? (crowd ? 'Goodreads ratings and Open Library' : 'Open Library')
        : type === 'boardgame' ? 'BoardGameGeek'
          : type === 'game' ? 'Steam and Wikidata'
            : 'Apple',
    usingCrowd: Boolean(crowd),
    // How many of your own ratings the crowd model could place you by.
    crowdSize: crowd ? crowd.user.n : 0,
    picks: picks.map((p) => ({
      type: p.type,
      title: p.title,
      year: p.year,
      // TMDB gives a show's first air date; it is the sensible default for
      // "when did I watch this", so it has to survive the trip to the client.
      release_date: p.release_date || null,
      creators: (p.creators || []).slice(0, 4),
      genres: (p.genres || []).slice(0, 4),
      overview: p.overview || null,
      poster_url: p.poster_url || null,
      backdrop_url: p.backdrop_url || null,
      external_rating: p.external_rating ?? null,
      predicted: p.crowd ? Math.round(clamp(p.crowd.predicted, 0.5, 5) * 10) / 10 : null,
      score: Math.round(p.score * 1000) / 1000,
      reasons: p.reasons,
      fingerprint: p.fingerprint,
      ids: {
        tmdb_id: p.tmdb_id || null,
        imdb_id: p.imdb_id || null,
        isbn: p.isbn || null,
        olid: p.olid || null,
        itunes_id: p.itunes_id || null,
        mbid: p.mbid || null,
      },
      provider: p.provider || null,
    })),
  }

  // Keep one list per angle, so a full turn of the rotation has a memory of
  // everything it has already put in front of you.
  run(
    `DELETE FROM rec_cache
      WHERE type = ? AND id NOT IN (SELECT id FROM rec_cache WHERE type = ? ORDER BY id DESC LIMIT ${ANGLES.length})`,
    type, type,
  )
  run(
    "INSERT INTO rec_cache (user_id, type, payload, computed_at) VALUES (?, ?, ?, datetime('now'))",
    systemUserId(), type, JSON.stringify(payload),
  )
  return { ...payload, cached: false }
}

/**
 * Never show me this again — and, given a few of them, never show me this
 * *sort of thing* again. The pick is kept alongside the verdict so the second
 * half of that promise can be honoured.
 */
export function blockRecommendation(fingerprint, reason, pick) {
  const attrs = pick && (pick.genres?.length || pick.creators?.length)
    ? JSON.stringify({
        genres: (pick.genres || []).slice(0, 6),
        creators: (pick.creators || []).slice(0, 4),
        year: pick.year ?? null,
        language: pick.language ?? null,
      })
    : null
  run(
    'INSERT OR REPLACE INTO rec_blocks (user_id, fingerprint, reason, attrs) VALUES (?, ?, ?, ?)',
    systemUserId(), fingerprint, reason || null, attrs,
  )
}

/*
 * What you keep turning down.
 *
 * Deliberately cautious. One rejection is a mood — you were not in the mood
 * for a western on Tuesday — so an attribute has to be turned down more than
 * once before it counts at all. And a rejection is weighed against what you
 * actually own: dismissing two crime films when a hundred of your favourites
 * are crime films says nothing about crime, it says something about those two
 * films. Only the attributes over-represented among your rejections survive.
 */
const DISTASTE_MIN = 2
const DISTASTE_WEIGHT = 0.55
const DISTASTE_CAP = 0.9

function buildDistaste() {
  const counts = new Map()
  for (const row of all('SELECT attrs FROM rec_blocks WHERE attrs IS NOT NULL')) {
    const parsed = json(row.attrs, null)
    if (!parsed) continue
    /*
     * The same filter the positive side uses. Open Library files a Frank
     * Herbert novel under "Tooth Diseases" and half its catalogue under
     * "Fiction"; neither is a thing anyone can dislike, and a broad tag
     * recurring across rejections would quietly condemn an entire library.
     */
    const cleaned = { ...parsed, genres: (parsed.genres || []).filter((g) => !uselessSubject(g)) }
    // One title cannot vote twice for the same attribute.
    for (const key of new Set(attrsOf(cleaned).map((a) => a.key))) {
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return counts
}

/** How far a candidate should fall for looking like things you have refused. */
function distastePenalty(c, distaste, profile) {
  if (!distaste.size) return 0
  let pen = 0
  for (const { key, weight } of candidateAttrs(c)) {
    const turnedDown = distaste.get(key) || 0
    if (turnedDown < DISTASTE_MIN) continue
    // Discounted by how much of this you already own and kept.
    const owned = profile.attrs.get(key)?.n ?? 0
    const share = turnedDown / (turnedDown + owned + 1)
    pen += (KIND_WEIGHT[key.split(':')[0]] ?? 0.4) * weight * share
  }
  return Math.min(DISTASTE_CAP, DISTASTE_WEIGHT * pen)
}

/** The "your taste, in numbers" panel. */
export function profileSummary() {
  const p = buildProfile()
  const fmt = (list, label) => list.slice(0, 8).map((a) => ({
    label: a.display || (a.key.includes('|') ? a.key.split('|')[1] : a.key.split(':')[1]),
    role: a.key.startsWith('creator:') ? a.key.replace('creator:', '').split('|')[0] : label,
    score: Math.round(a.score * 100) / 100,
    n: a.n,
    support: a.support.map((s) => ({ id: s.id, title: s.title, rating: s.rating })),
  }))
  return {
    counts: p.counts,
    globalMean: Math.round(p.globalMean * 100) / 100,
    meanByType: Object.fromEntries(Object.entries(p.meanByType).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    creators: fmt(p.topCreators, 'creator'),
    genres: fmt(p.topGenres, 'genre'),
    keywords: fmt(p.topKeywords, 'keyword'),
    decades: fmt(p.topDecades, 'decade'),
    favourites: p.favourites.slice(0, 12).map((f) => ({ id: f.id, title: f.title, rating: f.rating, type: f.type, year: f.year })),
  }
}
