import * as trakt from './trakt.js'
import * as lastfm from './lastfm.js'
import * as spotify from './spotify.js'
import * as steam from './steam.js'
import * as plex from './plex.js'

/** Services with a working live connection. */
export const LIVE = [plex, trakt, lastfm, spotify, steam]
const BY_ID = new Map(LIVE.map((c) => [c.id, c]))

export function getConnector(id) {
  return BY_ID.get(id)
}

/**
 * Services with no usable public API. Listed anyway — knowing *why* you cannot
 * connect, and what to do instead, is worth as much as a connect button.
 */
export const FILE_ONLY = [
  {
    id: 'letterboxd', brand: '#00c030', label: 'Letterboxd', mediaTypes: ['film'], kind: 'file',
    website: 'https://letterboxd.com',
    blurb: 'Letterboxd has no public API — theirs is still in closed beta and has been for years. '
      + 'The export is complete though, and importing it again later only adds what is new.',
    instructions: [
      'Open letterboxd.com/settings/data (Settings → Data).',
      'Press "Export your data" — you get a ZIP by download.',
      'Drop the whole ZIP on the Import page. Diary, ratings, watched, watchlist, likes, reviews and lists are all read.',
    ],
    alternative: 'Trakt connects live and covers the same ground — many people run both.',
  },
  {
    id: 'goodreads', brand: '#8a6a4b', label: 'Goodreads', mediaTypes: ['book'], kind: 'file',
    website: 'https://goodreads.com',
    blurb: 'Goodreads shut its API down in December 2020 and has issued no keys since, so an export is the only route.',
    instructions: [
      'Open goodreads.com/review/import.',
      'Press "Export Library" and wait for the link to appear, then download the CSV.',
      'Drop it on the Import page. Shelves become status and "to-read" becomes your list.',
    ],
    alternative: 'The StoryGraph exports the same data if you have moved across.',
  },
  {
    id: 'audible', brand: '#f8991c', label: 'Audible', mediaTypes: ['audiobook'], kind: 'file',
    website: 'https://audible.co.uk',
    blurb: 'Audible has no public API and no export button. Amazon will post you the data if you ask.',
    instructions: [
      'Go to amazon.co.uk → Account → "Request Your Information".',
      'Choose "Audible" (or "Request All Your Data") and submit.',
      'Amazon emails a download link, usually within a day or two.',
      'Unzip it and drop Audible.Library.csv (and Audible.Listening.csv if present) on the Import page.',
    ],
  },
  {
    id: 'imdb', brand: '#f5c518', label: 'IMDb', mediaTypes: ['film', 'tv'], kind: 'file',
    website: 'https://imdb.com',
    blurb: 'IMDb has no public API for your own ratings — the paid one is for licensing their catalogue.',
    instructions: [
      'Open imdb.com/list/ratings (Your Ratings).',
      'Use the ⋮ menu → Export, then download the CSV when the email arrives.',
      'Drop it on the Import page. Ratings out of 10 become stars.',
    ],
  },
  {
    id: 'netflix', brand: '#e50914', label: 'Netflix', mediaTypes: ['film', 'tv'], kind: 'file',
    website: 'https://netflix.com',
    blurb: 'No public API. The viewing activity export is complete but has no ratings in it.',
    instructions: [
      'Open netflix.com/viewingactivity while signed in to the right profile.',
      'Scroll to the bottom and press "Download all".',
      'Drop NetflixViewingHistory.csv on the Import page — episodes are grouped per season.',
    ],
  },
  {
    id: 'justwatch', brand: '#fbc500', label: 'JustWatch', mediaTypes: ['film', 'tv'], kind: 'file',
    website: 'https://justwatch.com',
    blurb: 'No public API, but the export covers your watchlist, seen list and ratings.',
    instructions: [
      'Open justwatch.com, then Profile → Settings → "Export your data".',
      'Drop the CSV on the Import page.',
    ],
  },
  {
    id: 'storygraph', brand: '#e4674e', label: 'The StoryGraph', mediaTypes: ['book', 'audiobook'], kind: 'file',
    website: 'https://thestorygraph.com',
    blurb: 'No public API yet. The export is rich — moods, pace and content warnings all come across as tags.',
    instructions: [
      'Open thestorygraph.com/user-export-requests (Manage Account → Export).',
      'Request the export, then download the CSV when it is ready.',
      'Drop it on the Import page.',
    ],
  },
]

/** The metadata providers — not accounts, but worth seeing in one place. */
export const METADATA = [
  {
    id: 'tmdb', brand: '#01b4e4', label: 'TMDB', mediaTypes: ['film', 'tv'], kind: 'metadata-key',
    website: 'https://themoviedb.org',
    blurb: 'Optional but the single best upgrade: proper film and TV genres, cast, keywords and '
      + '"people also liked" for recommendations. Free and approved instantly.',
    instructions: [
      'Create an account at themoviedb.org.',
      'Go to Settings → API → "Request an API key" → Developer.',
      'Fill in anything sensible for the application details (it is approved immediately).',
      'Copy the "API Key (v3 auth)" and paste it into Settings here.',
    ],
    settingKey: 'tmdb_api_key',
  },
  {
    id: 'omdb', brand: '#ffb300', label: 'OMDb (IMDb & Rotten Tomatoes)', mediaTypes: ['film', 'tv'], kind: 'metadata-key',
    website: 'https://www.omdbapi.com',
    blurb: 'Public scores for film and TV: IMDb, Rotten Tomatoes and Metacritic, all from one request. '
      + 'IMDb and Rotten Tomatoes have no free API of their own, so this is the way to get them.',
    instructions: [
      'Go to omdbapi.com/apikey.aspx and choose the FREE tier (1,000 requests a day).',
      'Enter your email and submit.',
      'Open the activation link in the email they send — the key does not work until you do.',
      'Paste the key into Settings here.',
    ],
    settingKey: 'omdb_api_key',
  },
  {
    id: 'googlebooks', brand: '#4285f4', label: 'Google Books', mediaTypes: ['book'], kind: 'metadata-key',
    website: 'https://books.google.com',
    blurb: 'Steadier book details than Open Library: one published edition rather than every edition '
      + 'in every language at once, so titles, authors, page counts and synopses are the publisher\'s own. '
      + 'Open Library stays on for cover art, which it has far more of.',
    instructions: [
      'Create a project at console.cloud.google.com/projectcreate.',
      'Enable the Books API: console.cloud.google.com/apis/library/books.googleapis.com.',
      'Make a key at console.cloud.google.com/apis/credentials → Create credentials → API key.',
      'Optionally restrict the key to the Books API, then paste it into Settings here.',
      'The free allowance is 1,000 lookups a day, and results are cached for weeks.',
    ],
    settingKey: 'google_books_api_key',
  },
  {
    id: 'bgg', brand: '#ff5100', label: 'BoardGameGeek', mediaTypes: ['boardgame'], kind: 'metadata-key',
    website: 'https://boardgamegeek.com',
    blurb: 'The only serious catalogue of board games — designers, player counts, weight, '
      + 'rankings and the artwork. Their XML API now refuses anonymous requests, so until a key '
      + 'is issued board games run on Wikidata, which carries little beyond a title and a BGG id. '
      + 'Every game still links straight through to its page there.',
    instructions: [
      'Apply at boardgamegeek.com/using_the_xml_api — access is granted per application.',
      'Paste the key here once it arrives; board games will switch over to BGG on their own.',
      'Until then search runs on Wikidata, whose coverage of games is thin but open.',
    ],
    settingKey: 'bgg_api_key',
  },
  {
    id: 'ticketmaster', brand: '#026cdf', label: 'Ticketmaster', mediaTypes: ['album', 'track'], kind: 'metadata-key',
    website: 'https://developer.ticketmaster.com',
    blurb: 'What is on near you, for the Gigs tab in your music library: every music event within '
      + 'reach of your town, ranked by how many of the artists are already on your shelves. Free, '
      + 'instant, and the only thing here that looks outwards rather than backwards. It does not '
      + 'carry the small independent venues, so treat it as most of what is on, not all of it.',
    instructions: [
      'Create an account at developer.ticketmaster.com.',
      'Go to My Apps → Add a new app; any name and description will do.',
      'Copy the "Consumer Key" — not the secret — and paste it here.',
      'Set your town and how far you will travel in Settings → Gigs.',
    ],
    settingKey: 'ticketmaster_api_key',
  },
  { id: 'openlibrary', brand: '#b7410e', label: 'Open Library', mediaTypes: ['book'], kind: 'metadata-free', website: 'https://openlibrary.org', blurb: 'Covers, authors, subjects and ratings for books. No key needed; already in use.' },
  { id: 'itunes', brand: '#fa243c', label: 'Apple', mediaTypes: ['album', 'audiobook', 'podcast'], kind: 'metadata-free', website: 'https://music.apple.com', blurb: 'Artwork and metadata for music, audiobooks and podcasts. No key needed; already in use.' },
  { id: 'musicbrainz', brand: '#ba478f', label: 'MusicBrainz', mediaTypes: ['album'], kind: 'metadata-free', website: 'https://musicbrainz.org', blurb: 'Release data and genre tags, with cover art from the Cover Art Archive. No key needed.' },
  { id: 'tvmaze', brand: '#3c948b', label: 'TVmaze', mediaTypes: ['tv'], kind: 'metadata-free', website: 'https://tvmaze.com', blurb: 'TV artwork, genres, networks and episode counts. No key needed; already in use.' },
  { id: 'wikidata', brand: '#3366cc', label: 'Wikipedia & Wikidata', mediaTypes: ['film', 'game'], kind: 'metadata-free', website: 'https://wikidata.org', blurb: 'Poster art, directors, genres and runtimes for films and games when TMDB is not connected, and the board game catalogue until BoardGameGeek issues a key.' },
]

export function catalogue() {
  return {
    live: LIVE.map((c) => ({
      id: c.id,
      label: c.label,
      brand: c.brand || null,
      mediaTypes: c.mediaTypes,
      kind: c.kind,
      capabilities: c.capabilities || [],
      website: c.website,
      blurb: c.blurb,
      fields: (c.fields || []).map((f) => ({ ...f })),
      instructions: c.instructions || [],
      options: c.options || [],
    })),
    fileOnly: FILE_ONLY,
    metadata: METADATA,
  }
}
