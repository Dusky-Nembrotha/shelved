import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { PosterArt } from './Poster'
import { CreatorSheet } from './CreatorSheet'
import { api, qs } from '../lib/api'
import { useApp, useFetch } from '../lib/store'
import { SECTION_META, creatorLine, fmtDate, fmtRuntime } from '../lib/format'
import type { MediaType } from '../lib/types'

export interface PreviewTarget {
  type: MediaType
  title: string
  year?: number | null
  creator?: string | null
  /** A date to inherit when adding — the rest of a series read in one run. */
  consumedOn?: string | null
  /** Why the engine put this in front of you, when it came from Suggestions. */
  reasons?: string[]
}

interface Provider { name: string; logo?: string | null }

interface PreviewBody {
  type: MediaType
  title: string
  year: number | null
  creators: { role?: string; name: string }[]
  cast: string[]
  genres: string[]
  overview: string | null
  poster_url: string | null
  runtime: number | null
  pages: number | null
  language: string | null
  external_rating: number | null
  release_date: string | null
  provider: string | null
}

/**
 * A look at something you do not own.
 *
 * Covers shown in a series row, a chart or a suggestion were previously a
 * dead end — a title and a picture and no way to find out what it was before
 * deciding. This fetches the same details a work page would show, without
 * adding anything to the library.
 */
export function Preview({ target, onClose, onLogged }: {
  target: PreviewTarget
  onClose: () => void
  /** Told what was created, so the caller can offer a rating and a date. */
  onLogged?: (thing: { workId: number; entryId: number | null; title: string; type: MediaType; consumedOn: string | null }) => void
}) {
  const meta = SECTION_META[target.type]
  const navigate = useNavigate()
  const { toast, refresh } = useApp()
  const [busy, setBusy] = useState(false)
  const [creator, setCreator] = useState<string | null>(null)
  // Following "more like this" from inside the sheet, without losing your place.
  const [also, setAlso] = useState<PreviewTarget | null>(null)

  const { data, loading } = useFetch<{
    found: boolean
    work_id: number | null
    preview: PreviewBody
    watch: { stream?: Provider[]; rent?: Provider[]; buy?: Provider[]; free?: Provider[]; link?: string } | null
    region: string
    ratings: { source: string; display: string | null; url: string | null }[]
    similar: { type: MediaType; title: string; year: number | null; poster_url: string | null; work_id: number | null }[]
    trailer: { name: string; url: string; thumbnail: string } | null
  }>(
    `/preview${qs({ type: target.type, title: target.title, creator: target.creator ?? null, year: target.year ?? null })}`,
    [target.type, target.title, target.creator, target.year],
  )

  const p = data?.preview

  async function add(mode: 'done' | 'planned') {
    setBusy(true)
    try {
      if (mode === 'planned') {
        await api.post('/recs', {
          type: target.type,
          title: p?.title ?? target.title,
          year: p?.year ?? target.year ?? null,
          creators: p?.creators ?? [],
          poster_url: p?.poster_url ?? null,
          /*
           * This sheet has just looked the thing up, so there is nothing left
           * to find. Letting the server go and fetch it all again made the
           * request slow enough to be killed by the proxy — a 502 on a button
           * whose whole job is to be instant.
           */
          enrichNow: false,
        })
        toast(`${p?.title ?? target.title} added to ${meta.planned.toLowerCase()}`)
      } else {
        const res = await api.post<{ work: { id: number; title: string }; entry_id: number }>('/log', {
          work: {
            type: target.type,
            title: p?.title ?? target.title,
            year: p?.year ?? target.year ?? null,
            creators: p?.creators ?? [],
            poster_url: p?.poster_url ?? null,
            overview: p?.overview ?? null,
            genres: p?.genres ?? [],
            pages: p?.pages ?? null,
          },
          /*
           * A series is watched over weeks, so "today" is rarely right and
           * nobody wants to set a date for every show they add. Its first
           * air date is at least in the right era, and it can be edited in
           * the sheet that follows.
           */
          consumed_on: target.consumedOn
            ?? (target.type === 'tv' && (p?.release_date || p?.year)
              ? (p.release_date || `${p.year}-01-01`)
              : undefined),
          status: 'completed',
          format: target.type === 'book' ? 'book' : null,
        })
        if (onLogged) {
          onLogged({
            workId: res.work.id, entryId: res.entry_id, title: res.work.title,
            type: target.type, consumedOn: target.consumedOn ?? null,
          })
        } else {
          toast(`${meta.verb} ${res.work.title}`)
        }
      }
      void refresh()
      onClose()
    } catch (err) { toast((err as Error).message, 'error') }
    finally { setBusy(false) }
  }

  /*
   * Buying, renting and streaming all count as somewhere to watch it; a film
   * only out in cinemas has none of them, which is worth saying plainly
   * rather than leaving a gap where the section would be.
   */
  const streamable = Boolean(
    data?.watch && (data.watch.stream?.length || data.watch.free?.length
      || data.watch.rent?.length || data.watch.buy?.length),
  )
  const unreleased = Boolean(p?.release_date && new Date(p.release_date) > new Date())

  const facts = [
    p?.year ? String(p.year) : null,
    p?.runtime ? fmtRuntime(p.runtime) : null,
    p?.pages ? `${p.pages} pages` : null,
    p?.external_rating ? `${p.external_rating.toFixed(1)} externally` : null,
  ].filter(Boolean)

  if (creator) {
    return <CreatorSheet name={creator} type={target.type} onClose={() => setCreator(null)} />
  }
  if (also) {
    return <Preview target={also} onClose={() => setAlso(null)} onLogged={onLogged} />
  }

  return (
    <Modal
      title={p?.title ?? target.title}
      onClose={onClose}
      footer={
        data?.work_id ? (
          <>
            <button className="btn btn--ghost" onClick={onClose}>Close</button>
            <button className="btn btn--primary" onClick={() => { onClose(); navigate(`/work/${data.work_id}`) }}>
              Open in your library
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--ghost" onClick={onClose}>Close</button>
            <button className="btn" disabled={busy || loading} onClick={() => add('planned')}>
              {meta.planned}
            </button>
            <button className="btn btn--primary" disabled={busy || loading} onClick={() => add('done')}>
              <Icon name="check" size={14} /> {meta.verb}
              {target.consumedOn ? ` · ${fmtDate(target.consumedOn)}` : ''}
            </button>
          </>
        )
      }
    >
      <div className="sheet__body">
        {loading ? (
          <div className="u-row" style={{ gap: 14 }}>
            <div className="skel" style={{ width: 96, height: 140, flex: '0 0 auto' }} />
            <div className="u-col u-grow" style={{ gap: 8 }}>
              <div className="skel" style={{ height: 14, width: '70%' }} />
              <div className="skel" style={{ height: 11, width: '45%' }} />
              <div className="skel" style={{ height: 60 }} />
            </div>
          </div>
        ) : (
          <>
            <div className="u-row" style={{ gap: 14, alignItems: 'flex-start' }}>
              <span style={{ width: 96, flex: '0 0 auto' }}>
                <PosterArt src={p?.poster_url ?? null} title={p?.title ?? target.title} type={target.type} aspect={meta.aspect} />
              </span>
              <div className="u-col u-grow" style={{ gap: 6, minWidth: 0 }}>
                <span className="u-row u-wrap" style={{ gap: 8 }}>
                  <span className="pill" style={{ color: meta.hue }}>{meta.singular}</span>
                  {data?.work_id && <span className="pill pill--good">Already yours</span>}
                </span>
                {/* The people are a way in, not just a label. */}
                {(p?.creators ?? []).length > 0 && (
                  <span className="u-sm u-dim">
                    {(p?.creators ?? []).slice(0, 3).map((c, i) => (
                      <span key={c.name}>
                        {i > 0 && <span className="u-mut">, </span>}
                        <button className="linkish" onClick={() => setCreator(c.name)}>{c.name}</button>
                      </span>
                    ))}
                  </span>
                )}
                {facts.length > 0 && <span className="u-xs u-mut">{facts.join(' · ')}</span>}
                {p?.genres?.length ? (
                  <span className="chiprow">
                    {p.genres.slice(0, 4).map((g) => <span key={g} className="chip">{g}</span>)}
                  </span>
                ) : null}
              </div>
            </div>

            {/* The case for it, carried in from whichever list sent you here. */}
            {target.reasons?.length ? (
              <div className="u-col" style={{ gap: 7 }}>
                <span className="u-caps">Why you are seeing this</span>
                <div className="chiprow">
                  {target.reasons.map((r, i) => (
                    <span key={i} className="chip chip--why"><Icon name="sparkle" size={11} /> {r}</span>
                  ))}
                </div>
              </div>
            ) : null}

            {p?.overview ? (
              <p className="u-sm" style={{ margin: 0, lineHeight: 1.6, color: 'var(--ink-2)' }}>{p.overview}</p>
            ) : (
              <p className="u-sm u-mut" style={{ margin: 0 }}>
                No synopsis found for this one.
              </p>
            )}

            {/* The trailer, which is the fastest answer to "what is this?" */}
            {data?.trailer && (
              <a
                className="trailer"
                href={data.trailer.url}
                target="_blank"
                rel="noreferrer"
                title={data.trailer.name}
              >
                <img src={data.trailer.thumbnail} alt="" loading="lazy" />
                <span className="trailer__play"><Icon name="play" size={20} /></span>
                <span className="trailer__label">Watch the trailer</span>
              </a>
            )}

            {p?.cast?.length ? (
              <p className="u-xs u-mut" style={{ margin: 0 }}>
                With {p.cast.slice(0, 6).map((n, i) => (
                  <span key={n}>
                    {i > 0 && ', '}
                    <button className="linkish" onClick={() => setCreator(n)}>{n}</button>
                  </span>
                ))}
              </p>
            ) : null}

            {/* What everyone else made of it. */}
            {data?.ratings?.length ? (
              <div className="pubratings">
                {data.ratings.filter((r) => r.display).map((r) => (
                  r.url
                    ? <a key={r.source} className="pubrating" href={r.url} target="_blank" rel="noreferrer">
                        <span className="pubratings__score u-tnum">{r.display}</span>
                        <span className="pubratings__src">{r.source}</span>
                      </a>
                    : <span key={r.source} className="pubrating">
                        <span className="pubratings__score u-tnum">{r.display}</span>
                        <span className="pubratings__src">{r.source}</span>
                      </span>
                ))}
              </div>
            ) : null}

            {/*
              * Where you could actually watch it tonight — and when there is
              * nowhere, that too. Hiding the section left people looking for
              * something that was never going to appear, with no way to tell
              * a film nobody streams from one the app had failed to ask about.
              */}
            {screen && data?.watch ? (
              <div className="u-col" style={{ gap: 8 }}>
                <span className="u-caps">Where to watch · {data.region}</span>
                {!streamable && (
                  <span className="u-sm u-mut">
                    {unreleased
                      ? `Not out yet${p?.release_date ? ` — due ${fmtDate(p.release_date)}` : ''}.`
                      : `Nothing streaming, renting or buying it in ${data.region} at the moment.`}
                  </span>
                )}
                {([['Streaming', data.watch.stream], ['Free', data.watch.free],
                   ['Rent', data.watch.rent], ['Buy', data.watch.buy]] as const)
                  .filter(([, list]) => list?.length)
                  .map(([label, list]) => (
                    <div key={label} className="u-row u-wrap" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="u-xs u-mut" style={{ minWidth: 62 }}>{label}</span>
                      <span className="providers">
                        {(list || []).slice(0, 6).map((pr) => (
                          <span key={pr.name} className="provider" title={pr.name}>
                            {pr.logo ? <img src={pr.logo} alt={pr.name} loading="lazy" /> : <span className="provider__text">{pr.name}</span>}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                {data.watch.link && (
                  <a className="u-xs linkish" href={data.watch.link} target="_blank" rel="noreferrer">
                    {streamable ? 'Open on JustWatch' : 'Check JustWatch'} <Icon name="external" size={11} />
                  </a>
                )}
              </div>
            ) : null}

            {/* And what it sits next to. */}
            {data?.similar?.length ? (
              <div className="u-col" style={{ gap: 8 }}>
                <span className="u-caps">More like this</span>
                <div className="previewrow">
                  {data.similar.map((x) => (
                    <button
                      key={x.title}
                      type="button"
                      className="previewrow__item"
                      onClick={() => {
                        if (x.work_id) { onClose(); navigate(`/work/${x.work_id}`) }
                        else setAlso({ type: x.type, title: x.title, year: x.year })
                      }}
                      title={x.title}
                    >
                      <PosterArt src={x.poster_url} title={x.title} type={x.type} aspect={meta.aspect} />
                      <span className="previewrow__title u-trunc">{x.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {p?.provider && (
              <p className="u-xs u-mut" style={{ margin: 0, textTransform: 'capitalize' }}>
                Details from {p.provider}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
