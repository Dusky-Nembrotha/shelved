import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { PosterArt, PosterSkeleton } from './Poster'
import { CreatorSheet } from './CreatorSheet'
import { Empty } from './Modal'
import { qs } from '../lib/api'
import { useFetch } from '../lib/store'
import { SECTION_META } from '../lib/format'
import type { MediaType } from '../lib/types'

interface Artist {
  name: string
  count: number
  poster_url: string | null
  rating: number | null
  last_on: string | null
  genres: string[]
}

const SORTS: [string, string][] = [
  ['count', 'Most of theirs'],
  ['name', 'A–Z'],
  ['rating', 'Best rated'],
  ['recent', 'Most recent'],
]

const PAGE = 120

/**
 * The music library, by the people who made it.
 *
 * Six thousand tracks is not a shelf you can read — nobody scrolls a
 * spreadsheet looking for a song, they look for the band. So this shelf is
 * artists: how much of theirs you have, what they play, and the artwork off
 * one of their records. The artist opens to everything they have made,
 * which is the page you actually wanted.
 */
export function ArtistShelf({ type }: { type: MediaType }) {
  const meta = SECTION_META[type]
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('count')
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<string | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)

  // A new filter or order starts the list again from the top.
  useEffect(() => { setLimit(PAGE) }, [q, sort])

  const { data, loading } = useFetch<{ artists: Artist[]; total: number }>(
    `/artists${qs({ type, q: q.trim() || null, sort, limit })}`,
    [type, q, sort, limit],
  )

  const artists = data?.artists ?? []
  const total = data?.total ?? 0

  /* The end of the list is the request for more of it. */
  useEffect(() => {
    const node = sentinel.current
    if (!node || loading || artists.length >= total) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) setLimit((n) => n + PAGE) },
      { rootMargin: '600px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [loading, artists.length, total])

  return (
    <>
      {open && <CreatorSheet name={open} type={type} onClose={() => setOpen(null)} />}

      <div className="toolbar">
        <label className="toolbar__search">
          <Icon name="search" size={15} className="u-mut" />
          <input
            className="toolbar__input"
            placeholder="Filter artists…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter artists"
          />
          {q && (
            <button className="toolbar__clear" onClick={() => setQ('')} aria-label="Clear filter text">
              <Icon name="x" size={13} />
            </button>
          )}
        </label>

        <div className="selectwrap toolbar__sort">
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>

      <p className="u-xs u-mut" style={{ margin: '0 0 12px' }}>
        {total.toLocaleString('en-GB')} artist{total === 1 ? '' : 's'}
        {q ? ' matching' : ` across your ${meta.label.toLowerCase()}`}
      </p>

      {loading && !artists.length ? (
        <div className="grid" style={{ ['--card-w' as string]: '150px' }}>
          {Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} aspect="1 / 1" />)}
        </div>
      ) : !artists.length ? (
        <Empty icon="mic" title={q ? `No artist matching “${q}”` : 'No artists yet'}>
          {q ? 'Try a shorter piece of the name.' : 'Import a playlist or log something and they will appear here.'}
        </Empty>
      ) : (
        <>
          <div className="grid" style={{ ['--card-w' as string]: '150px' }}>
            {artists.map((a) => (
              <button key={a.name} type="button" className="poster artistcard" onClick={() => setOpen(a.name)}>
                <PosterArt src={a.poster_url} title={a.name} type={type} aspect="1 / 1" />
                <div className="poster__meta">
                  <div className="poster__title u-trunc">{a.name}</div>
                  <div className="poster__sub u-trunc">
                    {a.count} {a.count === 1 ? meta.singular.toLowerCase() : `${meta.singular.toLowerCase()}s`}
                    {a.rating != null ? ` · ${a.rating}★` : ''}
                  </div>
                  {a.genres.length > 0 && (
                    <div className="poster__sub u-trunc u-mut">{a.genres.join(' · ')}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
          <div ref={sentinel} style={{ height: 1 }} />
          {artists.length < total && (
            <p className="u-xs u-mut" style={{ textAlign: 'center', marginTop: 16 }}>
              {total - artists.length} more…
            </p>
          )}
        </>
      )}
    </>
  )
}
