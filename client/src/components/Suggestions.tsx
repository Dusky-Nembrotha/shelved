import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './Icon'
import { PosterArt, PosterSkeleton } from './Poster'
import { Preview } from './Preview'
import type { PreviewTarget } from './Preview'
import { Empty } from './Modal'
import { GenrePick, type GenreCount } from './GenrePick'
import { JustLogged } from './JustLogged'
import type { LoggedThing } from './JustLogged'
import { api } from '../lib/api'
import { useApp } from '../lib/store'
import { SECTION_META, creatorLine } from '../lib/format'
import type { MediaType, Pick } from '../lib/types'

const PAGE = 18

interface RecResponse {
  type: MediaType
  picks: Pick[]
  cached?: boolean
  profileThin?: boolean
  usingTmdb?: boolean
  /** Which catalogue actually answered, rather than which key is set. */
  source?: string
  usingCrowd?: boolean
  crowdSize?: number
  /** Which way the engine was looking this time round. */
  angle?: string
  angleLabel?: string
  angleBlurb?: string
  candidateCount?: number
  computed_at?: string
  genres?: GenreCount[]
  genre?: string | null
}

/**
 * What the taste engine thinks you'd like in one media type, worked out from
 * how far above your own average you rate each genre, person and decade.
 * Lives as a tab inside each library, next to what you've finished and what
 * you mean to get to.
 */
export function Suggestions({ type, genre = null, onGenre }: {
  type: MediaType
  /* Owned by the library page so it is shared by every tab and survives the
     back button; see SectionPage. */
  genre?: string | null
  onGenre?: (genre: string | null) => void
}) {
  const meta = SECTION_META[type]
  const { toast, refresh, settings } = useApp()
  const [data, setData] = useState<RecResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [hidden, setHidden] = useState<string[]>([])
  /*
   * Logged from here, and deliberately still on screen. Retiring a card the
   * moment you tick it takes away the one thing you most often want next: the
   * way back in to set a rating or correct the date. Dismissals do vanish —
   * there the whole point is to not see it again. Cleared by Refresh.
   */
  const [marked, setMarked] = useState<Record<string, number>>({})
  const [logged, setLogged] = useState<LoggedThing | null>(null)
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  // Which pick the sheet is showing, so logging from inside it marks the card.
  const [previewOf, setPreviewOf] = useState<string | null>(null)
  const [sort, setSort] = useState<'match' | 'rating' | 'released'>('match')
  // Kept aside so narrowing to a genre does not shorten the list of genres.
  const [genres, setGenres] = useState<GenreCount[]>([])
  const [limit, setLimit] = useState(PAGE)
  const [more, setMore] = useState(false)
  // The ranking runs out eventually; stop asking once it has.
  const [done, setDone] = useState(false)

  const sentinel = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)

  /*
   * Asking for more is a bigger slice of the same ranking, not a different
   * one — the order is deterministic, so the titles already on screen keep
   * their places and the new ones land underneath.
   */
  const load = async (force = false, want = limit) => {
    // The observer can fire twice before the first answer lands.
    if (inFlight.current) return
    inFlight.current = true
    if (want > limit) setMore(true)
    else setLoading(true)
    try {
      const res = await api.get<RecResponse>(
        `/recommendations?type=${type}&limit=${want}${force ? '&force=1' : ''}`
        + `${genre ? `&genre=${encodeURIComponent(genre)}` : ''}`,
      )
      if (res.genres?.length) setGenres(res.genres)
      /*
       * Asking for more must not rearrange what you are already looking at.
       * The ranking is recomputed for the longer list and can shuffle near
       * the margins, which made new picks appear above ones you had just
       * read. Whatever is on screen keeps its place; the rest goes beneath.
       */
      setData((prev) => {
        if (force || !prev?.picks?.length) return res
        const byFingerprint = new Map(res.picks.map((p) => [p.fingerprint, p]))
        const kept = prev.picks.map((p) => byFingerprint.get(p.fingerprint) ?? p)
        const seen = new Set(kept.map((p) => p.fingerprint))
        return { ...res, picks: [...kept, ...res.picks.filter((p) => !seen.has(p.fingerprint))] }
      })
      setLimit(want)
      // Fewer back than asked for means that is the whole ranking.
      setDone(res.picks.length < want)
      if (force) { setHidden([]); setMarked({}) }
    } catch (err) {
      toast((err as Error).message, 'error')
      if (want === limit) setData(null)
      // Don't spin on a failing endpoint as the page scrolls.
      setDone(true)
    } finally { inFlight.current = false; setLoading(false); setMore(false) }
  }

  useEffect(() => {
    setLimit(PAGE); setDone(false); inFlight.current = false
    void load(false, PAGE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, genre])

  /*
   * The card offers the one answer a suggestion usually wants — yes, I have
   * had this — and nothing else. Putting it on the list instead is a rarer
   * decision that deserves the sheet, where you can see what you are agreeing
   * to before you agree to it.
   */
  async function act(pick: Pick, what: 'log' | 'dismiss') {
    setBusy(pick.fingerprint)
    try {
      if (what === 'log') {
        const res = await api.post<{ work_id: number; entry_id: number; consumed_on: string | null }>(
          '/recommendations/log', { pick },
        )
        setLogged({
          workId: res.work_id, entryId: res.entry_id, title: pick.title,
          type: pick.type, consumedOn: res.consumed_on,
        })
        setMarked((m) => ({ ...m, [pick.fingerprint]: res.work_id }))
        void refresh()
      } else {
        // Send the whole pick, not just its name: "no more of this sort of
        // thing" can only be learnt from what the thing was.
        await api.post('/recommendations/dismiss', { fingerprint: pick.fingerprint, reason: 'not interested', pick })
        setHidden((h) => [...h, pick.fingerprint])
      }
    } catch (err) { toast((err as Error).message, 'error') } finally { setBusy(null) }
  }

  /*
   * The engine's own order is the best match; the others re-read that same
   * list rather than asking for a different one, so nothing is recomputed
   * and the picks stay the picks.
   */
  const ordered = (() => {
    const list = (data?.picks ?? []).filter((p) => !hidden.includes(p.fingerprint))
    if (sort === 'rating') return [...list].sort((a, b) => (b.external_rating ?? 0) - (a.external_rating ?? 0))
    if (sort === 'released') return [...list].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    return list
  })()
  const picks = ordered
  const needsTmdb = (type === 'film' || type === 'tv') && !settings.has_tmdb

  /*
   * Top up as the bottom comes into view. Reaching the end of a list is
   * itself the request for more of it; a button only makes you say so twice.
   * The margin asks early enough that the next screenful is usually there
   * before you arrive at it.
   */
  useEffect(() => {
    const node = sentinel.current
    if (!node || done || loading || more) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void load(false, limit + PAGE) },
      { rootMargin: '600px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, loading, more, limit, picks.length])

  return (
    <>
      {logged && <JustLogged thing={logged} onClose={() => setLogged(null)} />}
      {preview && (
        <Preview
          target={preview}
          onClose={() => { setPreview(null); setPreviewOf(null) }}
          onLogged={(t) => {
            if (previewOf) setMarked((m) => ({ ...m, [previewOf]: t.workId }))
            setPreview(null); setPreviewOf(null); setLogged(t)
          }}
        />
      )}

      <div className="u-spread" style={{ margin: '4px 0 14px' }}>
        <span className="u-sm u-mut" title={data?.angleBlurb || undefined}>
          {loading
            ? 'Working out what you would like…'
            : `${picks.length}${data?.angleLabel ? ` ${data.angleLabel}` : ''}`
              + ` · from ${data?.candidateCount ?? 0} candidates`
              + `${data?.usingCrowd ? ` · placed by ${(data.crowdSize ?? 0).toLocaleString('en-GB')} of your ratings` : ''}`
              + `${data?.source ? ` · ${data.source}` : ''}`
              + `${data?.cached ? ' · cached' : ''}`}
        </span>
        <div className="u-row u-wrap" style={{ gap: 8 }}>
          <GenrePick genres={genres} value={genre} onChange={(g) => onGenre?.(g)} />
          <div className="chiprow">
            {([['match', 'Best match'], ['rating', 'Best rated'], ['released', 'Newest']] as const).map(([v, label]) => (
              <button key={v} className={`chip${sort === v ? ' is-on' : ''}`} onClick={() => setSort(v)}>{label}</button>
            ))}
          </div>
          <button
            className="btn btn--sm"
            onClick={() => load(true, PAGE)}
            disabled={loading}
            title="Look again from a different angle"
          >
            <Icon name="refresh" size={14} /> {loading ? 'Thinking…' : 'Refresh'}
          </button>
        </div>
      </div>

      {needsTmdb && (
        <div className="promo promo--tip">
          <div className="u-col" style={{ gap: 3 }}>
            <strong style={{ fontSize: 14 }}>These get much sharper with a TMDB key</strong>
            <span className="u-sm u-dim">
              Without one, suggestions come from Wikidata — every title by the people you rate highly.
              A free TMDB key adds genre, keyword and “people also liked” matching.
            </span>
          </div>
          <Link className="btn" to="/settings"><Icon name="key" size={14} /> Add key</Link>
        </div>
      )}

      {loading ? (
        <div className="grid" style={{ ['--card-w' as string]: meta.aspect === '1 / 1' ? '164px' : '150px' }}>
          {Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} aspect={meta.aspect} />)}
        </div>
      ) : !picks.length ? (
        <Empty
          icon="sparkle"
          title={`No ${meta.label.toLowerCase()} suggestions yet`}
          action={<button className="btn btn--primary" onClick={() => load(true)}>Try again</button>}
        >
          {genre
            ? `Nothing suggested under ${genre} this time. Refresh looks again from a different angle.`
            : data?.profileThin
              ? 'Rate a few things first — this works from your own ratings, not a generic popularity chart.'
              : 'Either everything suggested is already in your library, or the metadata sources are having a quiet moment.'}
        </Empty>
      ) : (
        <>
        <div className="grid" style={{ ['--card-w' as string]: meta.aspect === '1 / 1' ? '164px' : '150px' }}>
          {picks.map((pick, i) => (
            <div
              key={pick.fingerprint}
              className={`poster hotcard${marked[pick.fingerprint] != null ? ' is-logged' : ''}`}
            >
              {/*
                * A cover, a name and a way in — the same card Hot uses. Why it
                * was picked, what it is about and where to watch it all live in
                * the sheet, because eighteen of those at once is a wall of text
                * nobody reads and the grid could not lay out.
                */}
              <button
                type="button"
                className="poster__open"
                onClick={() => {
                  setPreviewOf(pick.fingerprint)
                  setPreview({
                    type: pick.type,
                    title: pick.title,
                    year: pick.year,
                    creator: pick.creators?.[0]?.name ?? null,
                    reasons: pick.reasons,
                  })
                }}
                title={`What is ${pick.title}?`}
              >
                <span className="hotrank u-tnum">{i + 1}</span>
                {pick.external_rating != null && (
                  <span
                    className="recscore u-tnum"
                    title={`Rated ${pick.external_rating.toFixed(1)} out of 10${pick.provider ? ` by ${pick.provider}` : ''}`
                      + (pick.predicted != null ? ` · we think you would give it ${pick.predicted.toFixed(1)}` : '')}
                  >
                    <Icon name="star" size={10} strokeWidth={0} />
                    {pick.external_rating.toFixed(1)}
                  </span>
                )}
                <PosterArt src={pick.poster_url} title={pick.title} type={pick.type} aspect={meta.aspect} />
              </button>

              <div className="poster__meta">
                <div className="poster__title">{pick.title}</div>
                <div className="poster__sub u-trunc">
                  {[pick.year, creatorLine(pick.creators, 1)].filter(Boolean).join(' \u00b7 ')}
                </div>
              </div>

              {marked[pick.fingerprint] != null ? (
                /* Already in the library, still on the page — so the pencil,
                   not the tick, is the thing left to press. */
                <div className="recactions">
                  <span className="recdone"><Icon name="check" size={13} /> {meta.done}</span>
                  <Link
                    className="btn btn--sm btn--ghost"
                    to={`/work/${marked[pick.fingerprint]}`}
                    title={`Edit your ${pick.title} entry`}
                    aria-label={`Edit your ${pick.title} entry`}
                  >
                    <Icon name="pencil" size={13} />
                  </Link>
                </div>
              ) : (
                <div className="recactions">
                  <button
                    className="btn btn--sm"
                    disabled={busy === pick.fingerprint}
                    onClick={() => act(pick, 'log')}
                    title={`${meta.done} — open it to put it on your list instead`}
                  >
                    <Icon name="check" size={13} /> {meta.done}
                  </button>
                  <button
                    className="btn btn--sm btn--ghost"
                    disabled={busy === pick.fingerprint}
                    onClick={() => act(pick, 'dismiss')}
                    title="Never suggest this again"
                    aria-label={`Never suggest ${pick.title} again`}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div ref={sentinel} style={{ height: 1 }} />

        {more && (
          <div className="grid" style={{ ['--card-w' as string]: meta.aspect === '1 / 1' ? '164px' : '150px', marginTop: 14 }}>
            {Array.from({ length: 6 }, (_, i) => <PosterSkeleton key={i} aspect={meta.aspect} />)}
          </div>
        )}

        {done && picks.length > PAGE && (
          <p className="u-xs u-mut" style={{ textAlign: 'center', marginTop: 20 }}>
            That is everything worth putting in front of you.
          </p>
        )}
        </>
      )}
    </>
  )
}
