export type MediaType = 'film' | 'tv' | 'book' | 'audiobook' | 'album' | 'track' | 'podcast' | 'game' | 'boardgame'

export interface Creator { role?: string; name: string }

export interface WorkCard {
  id: number
  type: MediaType
  title: string
  year: number | null
  poster_url: string | null
  backdrop_url?: string | null
  creators: Creator[]
  genres: string[]
  rating: number | null
  liked?: boolean
  entry_count: number
  /** Entries you marked as a rewatch — the only thing that means "again". */
  repeat_count?: number
  /** Distinct seasons logged, which an import writes one entry each for. */
  season_count?: number
  last_on: string | null
  status: string | null
  runtime?: number | null
  pages?: number | null
  external_rating?: number | null
}

export interface Entry {
  id: number
  work_id: number
  status: string
  rating: number | null
  liked: boolean
  consumed_on: string | null
  is_repeat: boolean
  season: number | null
  episode: number | null
  progress: string | null
  review: string | null
  notes: string | null
  tags: string[]
  source: string
  /** How a book was taken in: 'book', 'audiobook', or 'both'. */
  format?: string | null
  created_at: string
}

export interface Work extends Omit<WorkCard, 'rating' | 'entry_count' | 'last_on' | 'status'> {
  overview: string | null
  runtime: number | null
  pages: number | null
  seasons: number | null
  episodes: number | null
  language: string | null
  release_date: string | null
  external_rating: number | null
  imdb_id: string | null
  tmdb_id: string | null
  isbn: string | null
  asin: string | null
  metadata: Record<string, any>
  entries: Entry[]
  stats: { count: number; rating: number | null; best: number | null; liked: boolean; last: string | null; status: string | null }
  lists: { id: number; name: string; slug: string }[]
}

export interface ProviderHit {
  type: MediaType
  title: string
  year: number | null
  release_date?: string | null
  poster_url: string | null
  creators: Creator[]
  genres: string[]
  overview: string | null
  provider: string
  external_rating?: number | null
  tmdb_id?: string | null
  imdb_id?: string | null
  isbn?: string | null
  olid?: string | null
  itunes_id?: string | null
  mbid?: string | null
  runtime?: number | null
  pages?: number | null
  metadata?: Record<string, any>
}

export interface Rec {
  id: number
  work_id: number | null
  type: MediaType | null
  title: string
  year: number | null
  creators: Creator[]
  poster_url: string | null
  recommender: string | null
  source_url: string | null
  note: string | null
  priority: number
  status: 'open' | 'done' | 'dismissed'
  origin: string
  added_at: string
  acted_at: string | null
}

export interface Pick {
  type: MediaType
  title: string
  year: number | null
  release_date: string | null
  creators: Creator[]
  genres: string[]
  overview: string | null
  poster_url: string | null
  backdrop_url: string | null
  external_rating: number | null
  /** The crowd model's guess at what you would give it, in stars. */
  predicted?: number | null
  score: number
  reasons: string[]
  fingerprint: string
  provider: string | null
  /** Which of your services carries it, when the list was narrowed. */
  on_services?: { id: number; name: string; logo: string | null }[] | null
  ids: Record<string, string | null>
}

export interface ActivityItem {
  entry_id: number
  work_id: number
  title: string
  type: MediaType
  year: number | null
  poster_url: string | null
  creators: Creator[]
  rating: number | null
  liked: boolean
  consumed_on: string | null
  is_repeat: boolean
  progress: string | null
  review: string | null
  status: string
  source: string
  tags: string[]
}

export interface SectionInfo {
  type: MediaType
  label: string
  singular: string
  verb: string
  works: number
  entries: number
  avg_rating: number | null
}
