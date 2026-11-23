/**
 * Telling a gig from everything else a venue puts on.
 *
 * A city listing is not a gig guide: between the bands are club nights, DJ
 * residencies, film festivals, photography exhibitions, quizzes, choir
 * parties and a drink-and-draw. None of them are a band playing, none of
 * them can be matched to a record collection, and looking each one up in
 * MusicBrainz is a second of somebody's server spent proving that "Short
 * Story Night - Fresh Fiction Somerset Anthology" is not an artist.
 *
 * The test is deliberately conservative in one direction: it is better to
 * let a club night through than to throw away a band. Anything it rejects
 * disappears from the tab entirely, so the rules below only cover things
 * that are plainly not a gig.
 */

/* A bill is a sentence, not a list of acts. */
export const BILL_SPLIT = /\s*(?:\/|\+|&|,|•|•|\bwith\b|\bw\/\b|\bpresents?\b|\bfeat\.?\b|\bft\.?\b|\bsupported by\b|\bplus\b|:|\s[–—-]\s)\s*/i

/**
 * An act name, compared on its letters.
 *
 * Unlike normaliseTitle this keeps a leading "the", because band names are
 * not book titles: without it a club night called HEAVY matched The Heavy,
 * and "Mario Kart With A Band" matched The Band.
 */
export function actKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function actsIn(billing) {
  const whole = String(billing || '').trim()
  /* The whole string as well as its parts: "Florence & the Machine" and
     "Godspeed You! Black Emperor" are one act with a separator in them. */
  const parts = [whole, ...whole.split(BILL_SPLIT)]
  return [...new Set(parts.map(actKey).filter((p) => p.length > 2))]
}

/* Not music at all. */
const NOT_MUSIC = /\b(exhibition|photography|film fest|cine|cinema|screening|book launch|short story|poetry|spoken word|comedy|stand[- ]?up|quiz|bingo|drink & draw|drink and draw|life drawing|market|workshop|talk|lecture|q&a|panel|wrestling|drag brunch|brunch|yoga|jumble|car boot|fair|auction)\b/i

/* Music, but nobody playing instruments on a stage. */
const CLUB_NIGHT = /\b(club night|clubnight|indie club|emo night|emo club|disco|discotheque|rave|warehouse party|all night long|all[- ]?nighter|anthems|classics night|karaoke|silent disco|open decks|vinyl session|selectors?|soundsystem|sound system|dj set|djs?\b.*\bset|residency|afters|house party|nostalgi[ac]|throwback|back to the|\d{2}s night|party night|xmas party|christmas party|nye party|new year'?s eve party|takeover|sessions?)\b/i

/* But a band can be called any of those things, so a few names are spared. */
const KNOWN_BAND = /\b(tour|album|live|band|ep launch|single launch|in concert)\b/i

/**
 * Is this a band playing, as far as anyone can tell from a listing?
 *
 * @returns {{ gig: boolean, why: string|null }}
 */
export function isProbablyAGig(name) {
  const text = String(name || '').trim()
  if (!text) return { gig: false, why: 'no name' }
  if (NOT_MUSIC.test(text)) return { gig: false, why: 'not music' }
  if (CLUB_NIGHT.test(text) && !KNOWN_BAND.test(text)) return { gig: false, why: 'club night' }
  return { gig: true, why: null }
}
