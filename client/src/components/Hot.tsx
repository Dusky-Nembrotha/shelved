import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './Icon'
import { PosterArt, PosterSkeleton } from './Poster'
import { Empty } from './Modal'
import { Preview } from './Preview'
import { GenrePick, type GenreCount } from './GenrePick'
import type { PreviewTarget } from './Preview'
import { api, qs } from '../lib/api'
import { useApp } from '../lib/store'
import { SECTION_META, creatorLine } from '../lib/format'
import type { MediaType } from '../lib/types'

interface HotItem {
  type: MediaType
  title: string
  year: number | null
  poster_url: string | null
  overview: string | null
  creators: { role?: string; name: string }[]
  genres: string[]
  external_rating: number | null
  imdb: { rating: number; votes: number | null } | null
  work_id: number | null
  inLibrary: boolean
  onList: boolean
}

const BATCH = 18

/**
 * What everyone is talking about in this medium at the moment.
 *
 * Deliberately not personalised — Suggestions answers "what would I like",
 * and this answers the different question of what is going on. Things you
 * already have are marked rather than hidden: knowing you have seen the film
 * everyone is discussing is worth knowing.
 *
 * Loaded a screenful at a time and topped up as you reach the bottom, because
 * the IMDb score on each card costs a lookup and fetching two hundred of them
 * for a list nobody scrolls would be wasteful.
 */
export function Hot({ type, genre = null, onGenre }: {
  type: MediaType
  /* Owned by the library page so it is shared by every tab and survives the
     back button; see SectionPage. */
  genre?: string | null
  onGenre?: (genre: string | null) => void
}) {
  const meta = SECTION_META[type]
  const { toast, refresh } = useApp()

  const [items, setItems] = useState<HotItem[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [done, setDone] = useState(false)
  const [added, setAdded] = useState<Record<string, true>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  const [sort, setSort] = useState<'hot' | 'rating' | 'released'>('hot')
  const [genres, setGenres] = useState<GenreCount[]>([])

  const sentinel = useRef<HTMLDivElement>(null)
  const offset = useRef(0)
  const inFlight = useRef(false)

  const loadMore = useCallback(async () => {
    if (inFlight.current || done) return
    inFlight.current = true
    if (offset.current > 0) setMore(true)
    try {
      const res = await api.get<{
        source: string | null; items: HotItem[]; hasMore: boolean
        unsupported?: boolean; genres?: GenreCount[]
      }>(
        `/hot${qs({ type, limit: BATCH, offset: offset.current, sort, genre })}`,
      )
      setSource(res.source)
      if (res.genres?.length) setGenres(res.genres)
      setUnsupported(Boolean(res.unsupported))
      setItems((prev) => {
        // The charts shift while you scroll, so guard against repeats.
        const seen = new Set(prev.map((p) => p.title))
        return [...prev, ...res.items.filter((i) => !seen.has(i.title))]
      })
      offset.current += BATCH
      if (!res.hasMore || !res.items.length) setDone(true)
    } catch (err) {
      toast((err as Error).message, 'error')
      setDone(true)
    } finally {
      inFlight.current = false
      setLoading(false)
      setMore(false)
    }
  }, [type, done, sort, genre, toast])

  // Start again from the top whenever the library changes.
  // Start again from the top when the library or the ordering changes.
  useEffect(() => {
    offset.current = 0
    inFlight.current = false
    setItems([]); setDone(false); setLoading(true); setAdded({})
    void loadMore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, sort, genre])

  // Top up when the bottom of the list comes into view.
  useEffect(() => {
    const node = sentinel.current
    if (!node || done || loading) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMore() },
      { rootMargin: '600px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [loadMore, done, loading, items.length])

  async function add(item: HotItem) {
    setBusy(item.title)
    try {
      await api.post('/recs', {
        type: item.type, title: item.title, year: item.year,
        creators: item.creators, poster_url: item.poster_url,
        note: 'Trending',
        // The chart already carried the artwork and the credits.
        enrichNow: !item.poster_url,
      })
      toast(`${item.title} added to ${meta.planned.toLowerCase()}`)
      setAdded((a) => ({ ...a, [item.title]: true }))
      void refresh()
    } catch (err) { toast((err as Error).message, 'error') }
    finally { setBusy(null) }
  }

  if (loading) {
    return <div className="grid">{Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} aspect={meta.aspect} />)}</div>
  }

  if (!unsupported && genre && !items.length && !loading) {
    return (
      <>
        <div className="u-spread u-wrap" style={{ gap: 10, margin: '4px 0 14px' }}>
          <span className="u-sm u-mut">Nothing in the chart under {genre} today.</span>
          <GenrePick genres={genres} value={genre} onChange={(g) => onGenre?.(g)} />
        </div>
      </>
    )
  }

  if (unsupported || !items.length) {
    return (
      <Empty icon="sparkle" title={`No chart for ${meta.label.toLowerCase()}`}>
        {unsupported
          ? 'BoardGameGeek keep exactly this list and nobody else does, and their API now turns away '
            + 'anonymous requests. Add a key in Connections and this fills itself in; inventing a chart '
            + 'out of something that is not one would be worse than saying so.'
          : 'The source is quiet at the moment. Try again later.'}
      </Empty>
    )
  }

  return (
    <>
      {preview && <Preview target={preview} onClose={() => setPreview(null)} />}

      {/* Controls only; what the chart is and where it came from is on the
          sort chips, which is the part that acts on it. */}
      <div className="controlbar">
        <GenrePick genres={genres} value={genre} onChange={(g) => onGenre?.(g)} />
        <div
          className="chiprow"
          title={`What is being watched, read and talked about most right now · ${source ?? ''}`}
        >
          {([['hot', 'Hottest'], ['rating', 'Best rated'], ['released', 'Newest']] as const).map(([v, label]) => (
            <button key={v} className={`chip${sort === v ? ' is-on' : ''}`} onClick={() => setSort(v)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="grid" style={{ ['--card-w' as string]: meta.aspect === '1 / 1' ? '164px' : '150px' }}>
        {items.map((item, i) => {
          const art = (
            <>
              <span className="hotrank u-tnum">{i + 1}</span>
              {item.imdb && (
                <span className="hotscore u-tnum" title={`IMDb ${item.imdb.rating.toFixed(1)}${item.imdb.votes ? ` from ${item.imdb.votes.toLocaleString('en-GB')} votes` : ''}`}>
                  <span className="hotscore__mark">IMDb</span>
                  {item.imdb.rating.toFixed(1)}
                </span>
              )}
              <PosterArt src={item.poster_url} title={item.title} type={item.type} aspect={meta.aspect} />
            </>
          )
          const caption = (
            <div className="poster__meta">
              <div className="poster__title">{item.title}</div>
              <div className="poster__sub u-trunc">
                {[item.year, creatorLine(item.creators, 1)].filter(Boolean).join(' · ')}
              </div>
            </div>
          )

          if (item.work_id) {
            return (
              <Link key={item.title} to={`/work/${item.work_id}`} className="poster hotcard is-mine" title={`${item.title} — already yours`}>
                {art}{caption}
                <span className="hotflag">Yours</span>
              </Link>
            )
          }

          return (
            <div key={item.title} className="poster hotcard">
              {/* Openable even though you do not have it — a cover and a
                  title alone is not enough to decide on. */}
              <button
                type="button"
                className="poster__open"
                onClick={() => setPreview({
                  type: item.type,
                  title: item.title,
                  year: item.year,
                  creator: item.creators?.[0]?.name ?? null,
                })}
                title={`What is ${item.title}?`}
              >
                {art}
              </button>
              {caption}
              {added[item.title] || item.onList ? (
                <span className="hotflag">On your list</span>
              ) : (
                <button className="btn btn--sm hotadd" disabled={busy === item.title} onClick={() => add(item)}>
                  <Icon name="plus" size={13} /> {meta.planned}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div ref={sentinel} style={{ height: 1 }} />
      {more && (
        <div className="grid" style={{ marginTop: 14 }}>
          {Array.from({ length: 6 }, (_, i) => <PosterSkeleton key={i} aspect={meta.aspect} />)}
        </div>
      )}
      {done && items.length > BATCH && (
        <p className="u-xs u-mut" style={{ textAlign: 'center', marginTop: 20 }}>
          That is the whole chart.
        </p>
      )}
    </>
  )
}
