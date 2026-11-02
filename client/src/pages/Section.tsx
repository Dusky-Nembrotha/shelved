import { useEffect, useMemo, useRef, useState } from 'react'
import { Preview } from '../components/Preview'
import type { PreviewTarget } from '../components/Preview'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { PosterCard, PosterSkeleton } from '../components/Poster'
import { Stars } from '../components/Stars'
import { Empty, Modal } from '../components/Modal'
import { Suggestions } from '../components/Suggestions'
import { Hot } from '../components/Hot'
import { useApp, useFetch } from '../lib/store'
import { qs } from '../lib/api'
import { SECTION_META, creatorLine, fmtDate, fmtRuntime, relDate } from '../lib/format'
import { api } from '../lib/api'
import { artworkUrl } from '../lib/img'
import type { MediaType, Rec, WorkCard } from '../lib/types'
import { PosterArt } from '../components/Poster'

const SORTS = [
  ['recent', 'Last logged'],
  ['rating', 'Your rating'],
  ['added', 'Recently added'],
  ['title', 'Title'],
  ['year', 'Release year'],
] as const

const RATINGS = [4.5, 4, 3] as const

const STATUSES = [
  ['in_progress', 'In progress'],
  ['completed', 'Finished'],
  ['abandoned', 'Gave up'],
  ['unlogged', 'Not logged'],
] as const

interface Filters {
  format: string | null
  creator: string | null
  genre: string | null
  decade: string | null
  minRating: number | null
  status: string | null
  unrated: boolean
}

type Tab = 'done' | 'planned' | 'suggested' | 'hot'

function dirLabel(sort: string, dir: 'desc' | 'asc') {
  if (sort === 'title') return dir === 'desc' ? 'A to Z' : 'Z to A'
  if (sort === 'rating') return dir === 'desc' ? 'Best first' : 'Worst first'
  if (sort === 'year') return dir === 'desc' ? 'Newest first' : 'Oldest first'
  if (sort === 'runtime') return dir === 'desc' ? 'Longest first' : 'Shortest first'
  return dir === 'desc' ? 'Newest first' : 'Oldest first'
}

const EMPTY: Filters = { format: null, creator: null, genre: null, decade: null, minRating: null, status: null, unrated: false }

export function SectionPage({ type }: { type: MediaType }) {
  const meta = SECTION_META[type]
  const [params, setParams] = useSearchParams()

  /*
   * Which tab, and which genre, live in the address rather than in this
   * component.
   *
   * Opening a film from Suggestions and pressing back used to land on
   * Watched, because the tab was state and state does not survive leaving the
   * page. And a genre chosen on Hot meant nothing on Suggestions, because
   * each kept its own. In the URL both are shared by every tab and restored
   * by the back button, which is what a back button is for.
   */
  const tab = (['done', 'planned', 'suggested', 'hot'].includes(params.get('tab') || '')
    ? params.get('tab')
    : 'done') as Tab

  const patchParams = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace })
  }

  const setTab = (t: Tab) => patchParams({ tab: t === 'done' ? null : t })
  const [sort, setSort] = useState<string>('recent')
  // Choosing the sort you are already on turns it round.
  const [dir, setDir] = useState<'desc' | 'asc'>('desc')
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('mm-view') as 'grid' | 'list') || 'grid')
  const [limit, setLimit] = useState(60)
  // Reaching the bottom is the request for more of it; see the observer below.
  const moreSentinel = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [showMore, setShowMore] = useState(false)
  // Selecting several at once, so a bad import can be cleared in one go.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const selecting = selected.size > 0

  // A ?creator= link from a work page is a filter request, and lands you on
  // what you have already seen rather than on what you might.
  const urlCreator = params.get('creator')
  const urlGenre = params.get('genre')
  useEffect(() => {
    if (!urlCreator) return
    setFilters((f) => ({ ...f, creator: urlCreator }))
    patchParams({ tab: null }, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCreator])

  // The genre belongs to the whole library, so the grid reads it from there.
  useEffect(() => {
    setFilters((f) => (f.genre === (urlGenre ?? null) ? f : { ...f, genre: urlGenre ?? null }))
  }, [urlGenre])

  const query = qs({
    type, sort, dir, limit, q: q.trim() || null,
    creator: filters.creator, genre: filters.genre, decade: filters.decade, format: filters.format,
    minRating: filters.minRating, status: filters.status,
    unrated: filters.unrated ? 1 : null,
  })
  const { version, toast, refresh } = useApp()
  const { data, loading } = useFetch<{ works: WorkCard[]; total: number }>(`/works${query}`, [query, version])
  const facets = useFetch<{ genres: { name: string; count: number }[]; decades: { name: string; count: number }[] }>(`/facets${qs({ type })}`)

  /*
   * Load the next sixty when the end of the list appears, with enough margin
   * that they are usually there before you arrive.
   */
  const total = data?.total ?? 0
  const shown = data?.works?.length ?? 0
  useEffect(() => {
    const node = moreSentinel.current
    if (!node || loading || shown >= total) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) setLimit((l) => Math.max(l, shown) + 60) },
      { rootMargin: '700px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [loading, shown, total, view])

  const active = useMemo(() => {
    const out: { key: keyof Filters; label: string }[] = []
    if (filters.creator) out.push({ key: 'creator', label: filters.creator })
    if (filters.format) out.push({ key: 'format', label: filters.format === 'audiobook' ? 'Listened to' : 'Read' })
    if (filters.genre) out.push({ key: 'genre', label: filters.genre })
    if (filters.decade) out.push({ key: 'decade', label: filters.decade })
    if (filters.minRating) out.push({ key: 'minRating', label: `${filters.minRating}★ and up` })
    if (filters.status) out.push({ key: 'status', label: STATUSES.find((s) => s[0] === filters.status)?.[1] ?? filters.status })
    if (filters.unrated) out.push({ key: 'unrated', label: 'Unrated' })
    return out
  }, [filters])

  const works = data?.works ?? []
  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const setViewPersist = (v: 'grid' | 'list') => { setView(v); localStorage.setItem('mm-view', v) }
  const dropParam = (key: string) => {
    if (!params.has(key)) return
    const next = new URLSearchParams(params)
    next.delete(key)
    setParams(next, { replace: true })
  }
  const clearOne = (key: keyof Filters) => {
    setFilters((f) => ({ ...f, [key]: key === 'unrated' ? false : null }))
    dropParam(key)
  }
  const clearAll = () => {
    setFilters(EMPTY)
    setQ('')
    setParams(new URLSearchParams(), { replace: true })
  }

  if (tab !== 'done') {
    return (
      <div className="page">
        <SectionTabs type={type} tab={tab} setTab={setTab} />
        {tab === 'planned' ? <PlannedList type={type} />
          : tab === 'hot'
            ? <Hot type={type} genre={urlGenre} onGenre={(g) => patchParams({ genre: g })} />
            : <Suggestions type={type} genre={urlGenre} onGenre={(g) => patchParams({ genre: g })} />}
      </div>
    )
  }

  return (
    <div className="page">
      <SectionTabs type={type} tab={tab} setTab={setTab} />
      <div className="toolbar">
        <label className="toolbar__search">
          <Icon name="search" size={15} className="u-mut" />
          <input
            className="toolbar__input"
            placeholder={`Filter ${meta.label.toLowerCase()}…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={`Filter ${meta.label}`}
          />
          {q && (
            <button className="toolbar__clear" onClick={() => setQ('')} aria-label="Clear filter text">
              <Icon name="x" size={13} />
            </button>
          )}
        </label>

        <div className="selectwrap toolbar__sort">
          <select
            className="select"
            value={sort}
            onChange={(e) => { setSort(e.target.value); setDir('desc') }}
            aria-label="Sort by"
          >
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        <button
          className="btn btn--sm sortdir"
          onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          aria-label={dir === 'desc' ? 'Sorted high to low — reverse it' : 'Sorted low to high — reverse it'}
          title={`${SORTS.find(([v]) => v === sort)?.[1] ?? 'Sorted'}: ${dirLabel(sort, dir)}`}
        >
          <Icon name={dir === 'desc' ? 'arrowDown' : 'arrowUp'} size={14} />
        </button>

        <button
          className={`btn btn--sm toolbar__filters${active.length ? ' is-on' : ''}`}
          onClick={() => setSheetOpen(true)}
        >
          <Icon name="filter" size={14} />
          <span className="toolbar__filterlabel">Filters</span>
          {active.length > 0 && <span className="toolbar__badge u-tnum">{active.length}</span>}
        </button>

        {type === 'book' && (
          <div className="selectwrap toolbar__sort">
            <select
              className="select"
              value={filters.format ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, format: e.target.value || null }))}
              aria-label="Read or listened to"
            >
              <option value="">Read and heard</option>
              <option value="book">Read</option>
              <option value="audiobook">Listened to</option>
            </select>
          </div>
        )}

        <button
          className={`btn btn--sm${selecting ? ' is-on' : ''}`}
          onClick={() => setSelected((prev) => (prev.size ? new Set() : new Set(works.slice(0, 1).map((w) => w.id))))}
          title={selecting ? 'Stop selecting' : 'Select several'}
        >
          <Icon name={selecting ? 'x' : 'check'} size={14} />
          <span className="toolbar__filterlabel">{selecting ? 'Done' : 'Select'}</span>
        </button>

        <div className="viewtoggle">
          <button className={view === 'grid' ? 'is-on' : ''} onClick={() => setViewPersist('grid')} aria-label="Grid view"><Icon name="grid" size={15} /></button>
          <button className={view === 'list' ? 'is-on' : ''} onClick={() => setViewPersist('list')} aria-label="List view"><Icon name="rows" size={15} /></button>
        </div>
      </div>

      {selecting && (
        <div className="selectbar">
          <strong className="u-tnum">{selected.size} selected</strong>
          <button className="linkish" onClick={() => setSelected(new Set(works.map((w) => w.id)))}>
            Select all {works.length}
          </button>
          <button className="linkish" onClick={() => setSelected(new Set())}>Clear</button>
          <span className="u-grow" />
          <button className="btn btn--sm btn--danger" onClick={() => setConfirmBulk(true)}>
            <Icon name="trash" size={14} /> Remove {selected.size}
          </button>
        </div>
      )}

      {filters.creator && (
        <div className="creatorbar">
          <div className="u-col" style={{ gap: 2, minWidth: 0 }}>
            <span className="u-caps">{meta.label} by</span>
            <strong className="u-trunc" style={{ fontSize: 18 }}>{filters.creator}</strong>
            <span className="u-xs u-mut">
              {data ? `${data.total} on your shelf` : 'Counting…'}
            </span>
          </div>
          <button className="btn btn--primary btn--sm" onClick={() => setShowMore(true)}>
            <Icon name="search" size={14} /> Find more
          </button>
        </div>
      )}

      {active.length > 0 && (
        <div className="chiprow activefilters">
          {active.map((a) => (
            <button key={a.key} className="chip is-on" onClick={() => clearOne(a.key)} title="Remove this filter">
              {a.label} <Icon name="x" size={11} />
            </button>
          ))}
          <button className="chip" onClick={clearAll}>Clear all</button>
          {data && <span className="u-xs u-mut" style={{ marginLeft: 2 }}>{data.total} match{data.total === 1 ? '' : 'es'}</span>}
        </div>
      )}

      {loading && !works.length ? (
        <div className="grid">{Array.from({ length: 18 }, (_, i) => <PosterSkeleton key={i} aspect={meta.aspect} />)}</div>
      ) : !works.length ? (
        <Empty
          icon={meta.icon}
          title={active.length || q ? 'Nothing matches those filters' : `No ${meta.label.toLowerCase()} yet`}
          action={active.length || q
            ? <button className="btn" onClick={clearAll}>Clear filters</button>
            : <Link className="btn btn--primary" to="/import"><Icon name="import" size={15} /> Import your history</Link>}
        >
          {active.length || q ? null : `Add your first ${meta.singular.toLowerCase()}, or import an export from another service.`}
        </Empty>
      ) : view === 'grid' ? (
        <>
          <div className="grid" style={{ ['--card-w' as string]: meta.aspect === '1 / 1' ? '164px' : '150px' }}>
            {works.map((w) => (
              <PosterCard
                key={w.id}
                work={w}
                aspect={meta.aspect}
                selectable={selecting}
                selected={selected.has(w.id)}
                onSelect={toggle}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {works.map((w) => selecting ? (
            <button key={w.id} type="button" className={`listrow listrow--pick${selected.has(w.id) ? ' is-picked' : ''}`} onClick={() => toggle(w.id)}>
              <span className="listrow__tick"><Icon name={selected.has(w.id) ? 'check' : 'plus'} size={13} /></span>
              {w.poster_url
                ? <img className="listrow__thumb" src={artworkUrl(w.poster_url)} alt="" loading="lazy" style={{ aspectRatio: meta.aspect }} />
                : <span className="listrow__thumb" style={{ aspectRatio: meta.aspect }} />}
              <span className="u-col u-grow" style={{ gap: 3, minWidth: 0, textAlign: 'left' }}>
                <span style={{ fontSize: 14, fontWeight: 560 }} className="u-trunc">{w.title}</span>
                <span className="u-xs u-mut u-trunc">
                  {[w.year, creatorLine(w.creators, 2), w.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="listrow__right u-xs u-mut">{fmtDate(w.last_on)}</span>
            </button>
          ) : (
            <Link key={w.id} to={`/work/${w.id}`} className="listrow">
              {w.poster_url
                ? <img className="listrow__thumb" src={artworkUrl(w.poster_url)} alt="" loading="lazy" style={{ aspectRatio: meta.aspect }} />
                : <span className="listrow__thumb" style={{ aspectRatio: meta.aspect }} />}
              <span className="u-col u-grow" style={{ gap: 3, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 560 }} className="u-trunc">{w.title}</span>
                <span className="u-xs u-mut u-trunc">
                  {[w.year, creatorLine(w.creators, 2), w.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="listrow__right u-xs u-mut">{fmtRuntime(w.runtime) || (w.pages ? `${w.pages}p` : '')}</span>
              <span className="listrow__right">{w.rating != null ? <Stars value={w.rating} size={13} /> : <span className="u-xs u-mut">—</span>}</span>
              <span className="listrow__right u-xs u-mut">{fmtDate(w.last_on)}</span>
            </Link>
          ))}
        </div>
      )}

      {/*
        * Top up as the bottom comes into view, in either view — the list had
        * no way to go past the first sixty at all. The button stays for the
        * keyboard and for anyone who would rather ask, but six hundred films
        * sixty at a time should not need ten presses.
        */}
      <div ref={moreSentinel} style={{ height: 1 }} />
      {data && data.total > works.length && (
        <div style={{ display: 'grid', placeItems: 'center', marginTop: 26 }}>
          <button className="btn" onClick={() => setLimit((l) => l + 60)} disabled={loading}>
            {loading ? 'Loading…' : `Show more — ${data.total - works.length} to go`}
          </button>
        </div>
      )}

      {confirmBulk && (
        <Modal
          title={`Remove ${selected.size} ${selected.size === 1 ? meta.singular.toLowerCase() : meta.label.toLowerCase()}?`}
          onClose={() => setConfirmBulk(false)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirmBulk(false)}>Keep them</button>
              <button
                className="btn btn--danger"
                onClick={async () => {
                  try {
                    const res = await api.post<{ removed: number }>('/works/delete', { ids: [...selected] })
                    toast(`Removed ${res.removed} ${res.removed === 1 ? 'title' : 'titles'}`)
                    setSelected(new Set())
                    setConfirmBulk(false)
                    void refresh()
                  } catch (err) { toast((err as Error).message, 'error') }
                }}
              >
                Remove {selected.size}
              </button>
            </>
          }
        >
          <div className="sheet__body">
            <p className="u-sm u-dim" style={{ margin: 0 }}>
              This deletes {selected.size === 1 ? 'it' : 'them'} and every log entry against
              {selected.size === 1 ? ' it' : ' them'}. Re-importing the original export would bring
              {selected.size === 1 ? ' it' : ' them'} back.
            </p>
            <div className="chiprow">
              {works.filter((w) => selected.has(w.id)).slice(0, 10).map((w) => (
                <span key={w.id} className="chip">{w.title}</span>
              ))}
              {selected.size > 10 && <span className="u-xs u-mut">+{selected.size - 10} more</span>}
            </div>
          </div>
        </Modal>
      )}

      {showMore && filters.creator && (
        <CreatorMore name={filters.creator} type={type} onClose={() => setShowMore(false)} />
      )}

      {sheetOpen && (
        <Modal
          title={`Filter ${meta.label.toLowerCase()}`}
          onClose={() => setSheetOpen(false)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={clearAll}>Clear all</button>
              <button className="btn btn--primary" onClick={() => setSheetOpen(false)}>
                Show {data?.total ?? 0}
              </button>
            </>
          }
        >
          <div className="sheet__body">
            <div className="field sheet-sort">
              <label htmlFor="f-sort">Sort by</label>
              <div className="u-row" style={{ gap: 8 }}>
                <div className="selectwrap u-grow">
                  <select id="f-sort" className="select" value={sort} onChange={(e) => { setSort(e.target.value); setDir('desc') }}>
                    {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <button className="btn sortdir" onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
                  <Icon name={dir === 'desc' ? 'arrowDown' : 'arrowUp'} size={14} />
                  <span className="u-xs">{dirLabel(sort, dir)}</span>
                </button>
              </div>
            </div>

            {/* A library with nothing filed under a genre gets no dead control. */}
            {(facets.data?.genres ?? []).length > 0 && (
              <div className="field">
                <label htmlFor="f-genre">Genre</label>
                <div className="selectwrap">
                  <select
                    id="f-genre"
                    className="select"
                    value={filters.genre ?? ''}
                    onChange={(e) => setFilters((f) => ({ ...f, genre: e.target.value || null }))}
                  >
                    <option value="">All genres</option>
                    {(facets.data?.genres ?? []).map((g) => <option key={g.name} value={g.name}>{g.name} ({g.count})</option>)}
                  </select>
                </div>
              </div>
            )}

            <div className="field">
              <label htmlFor="f-decade">Decade</label>
              <div className="selectwrap">
                <select
                  id="f-decade"
                  className="select"
                  value={filters.decade ?? ''}
                  onChange={(e) => setFilters((f) => ({ ...f, decade: e.target.value || null }))}
                >
                  <option value="">Any decade</option>
                  {(facets.data?.decades ?? []).map((d) => <option key={d.name} value={d.name}>{d.name} ({d.count})</option>)}
                </select>
              </div>
            </div>

            <div className="field">
              <label>Rating</label>
              <div className="chiprow">
                {RATINGS.map((r) => (
                  <button
                    key={r}
                    className={`chip${filters.minRating === r ? ' is-on' : ''}`}
                    onClick={() => setFilters((f) => ({ ...f, minRating: f.minRating === r ? null : r, unrated: false }))}
                  >
                    {r}★ and up
                  </button>
                ))}
                <button
                  className={`chip${filters.unrated ? ' is-on' : ''}`}
                  onClick={() => setFilters((f) => ({ ...f, unrated: !f.unrated, minRating: null }))}
                >
                  Unrated
                </button>
              </div>
            </div>

            <div className="field">
              <label>Status</label>
              <div className="chiprow">
                {STATUSES.map(([v, l]) => (
                  <button
                    key={v}
                    className={`chip${filters.status === v ? ' is-on' : ''}`}
                    onClick={() => setFilters((f) => ({ ...f, status: f.status === v ? null : v }))}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}


/** Switches a library between what you've done, what you mean to, and what it suggests. */
function SectionTabs({ type, tab, setTab }: {
  type: MediaType
  tab: Tab
  setTab: (t: Tab) => void
}) {
  const meta = SECTION_META[type]
  const { data } = useFetch<{ recs: Rec[] }>(`/recs?status=open&type=${type}`, [type])
  const waiting = data?.recs?.length ?? 0

  return (
    <div className="sectiontabs">
      <button className={tab === 'done' ? 'is-on' : ''} onClick={() => setTab('done')}>
        {meta.done}
      </button>
      <button className={tab === 'planned' ? 'is-on' : ''} onClick={() => setTab('planned')}>
        {meta.planned}
        {waiting > 0 && <span className="sectiontabs__count u-tnum">{waiting}</span>}
      </button>
      <button className={tab === 'suggested' ? 'is-on' : ''} onClick={() => setTab('suggested')}>
        Suggestions
      </button>
      <button className={tab === 'hot' ? 'is-on' : ''} onClick={() => setTab('hot')}>
        Hot
      </button>
    </div>
  )
}

/** The things you mean to get to, for this one kind of media. */
function PlannedList({ type }: { type: MediaType }) {
  const meta = SECTION_META[type]
  const { toast, refresh, openLog } = useApp()
  const { data, loading, reload } = useFetch<{ recs: Rec[] }>(`/recs?status=open&type=${type}`, [type])
  // Nothing on this list was openable, so the only way to remember what a
  // title was before ticking it off was to go and search for it.
  const [preview, setPreview] = useState<PreviewTarget | null>(null)

  async function act(rec: Rec, what: 'log' | 'dismiss' | 'priority') {
    try {
      if (what === 'log') {
        await api.post('/recommendations/log', {
          pick: { type: rec.type || type, title: rec.title, year: rec.year, creators: rec.creators, poster_url: rec.poster_url },
          rec_id: rec.id,
        })
        toast(`Logged ${rec.title}`)
      } else if (what === 'dismiss') {
        await api.patch(`/recs/${rec.id}`, { status: 'dismissed' })
      } else {
        await api.patch(`/recs/${rec.id}`, { priority: rec.priority === 2 ? 1 : 2 })
      }
      reload()
      void refresh()
    } catch (err) { toast((err as Error).message, 'error') }
  }

  if (loading && !data) {
    return <div className="grid">{Array.from({ length: 8 }, (_, i) => <PosterSkeleton key={i} aspect={meta.aspect} />)}</div>
  }

  const recs = data?.recs ?? []
  if (!recs.length) {
    return (
      <Empty
        icon="inbox"
        title={`Nothing on your ${meta.planned.toLowerCase()} list`}
        action={<button className="btn btn--primary" onClick={() => openLog({ kind: 'blank', type, mode: 'want' })}>
          <Icon name="plus" size={15} /> Add something
        </button>}
      >
        Search for anything and choose “Want to”, or import a watchlist — they land here.
      </Empty>
    )
  }

  return (
    <>
      {preview && (
        <Preview
          target={preview}
          onClose={() => setPreview(null)}
          onLogged={() => { setPreview(null); reload(); void refresh() }}
        />
      )}
      <div className="u-spread" style={{ marginBottom: 14 }}>
        <span className="u-sm u-mut">{recs.length} waiting</span>
        <button className="btn btn--sm" onClick={() => openLog({ kind: 'blank', type, mode: 'want' })}>
          <Icon name="plus" size={14} /> Add
        </button>
      </div>
      <div className="grid" style={{ ['--card-w' as string]: meta.aspect === '1 / 1' ? '164px' : '150px' }}>
        {recs.map((rec) => (
          <div key={rec.id} className="plannedcard">
            <button
              type="button"
              className="poster__open"
              onClick={() => setPreview({
                type: rec.type || type,
                title: rec.title,
                year: rec.year,
                creator: rec.creators?.[0]?.name ?? null,
              })}
              title={`What is ${rec.title}?`}
            >
              <PosterArt src={rec.poster_url} title={rec.title} type={rec.type || type} aspect={meta.aspect} />
            </button>
            <div className="poster__meta">
              <div className="poster__title">{rec.title}</div>
              <div className="poster__sub u-trunc">
                {[rec.year, rec.recommender].filter(Boolean).join(' · ')}
              </div>
              {rec.note && <div className="u-xs u-mut u-clamp-2" style={{ marginTop: 3 }}>{rec.note}</div>}
              <div className="plannedcard__actions">
                <button className="btn btn--sm btn--primary" onClick={() => act(rec, 'log')} title={`Mark as ${meta.done.toLowerCase()}`}>
                  <Icon name="check" size={13} />
                </button>
                <button className={`btn btn--sm${rec.priority === 2 ? ' btn--primary' : ''}`} onClick={() => act(rec, 'priority')} title="Priority">
                  <Icon name="star" size={13} />
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => act(rec, 'dismiss')} title="Not for me">
                  <Icon name="x" size={13} />
                </button>
              </div>
              {rec.added_at && <div className="u-xs u-mut" style={{ marginTop: 4 }}>added {relDate(rec.added_at.slice(0, 10))}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

interface CreatorFind {
  name: string
  role: string | null
  type: MediaType
  mine: number
  more: {
    type: MediaType
    title: string
    year: number | null
    poster_url: string | null
    overview: string | null
    creators: { role?: string; name: string }[]
    external_rating: number | null
    source: string
  }[]
}

/**
 * The rest of someone's output — what the metadata sources know about that
 * isn't on your shelf yet. Each one can go straight onto a to-do list or be
 * logged as already done.
 */
function CreatorMore({ name, type, onClose }: { name: string; type: MediaType; onClose: () => void }) {
  const meta = SECTION_META[type]
  const { toast, refresh } = useApp()
  const { data, loading } = useFetch<CreatorFind>(
    `/creator${qs({ name, type, more: 1 })}`, [name, type],
  )
  const [added, setAdded] = useState<Record<string, true>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function add(item: CreatorFind['more'][number], mode: 'want' | 'done') {
    setBusy(item.title)
    try {
      if (mode === 'want') {
        await api.post('/recs', {
          type: item.type, title: item.title, year: item.year,
          creators: item.creators, poster_url: item.poster_url,
          note: `From ${name}'s back catalogue`,
        })
        toast(`${item.title} added to ${meta.planned.toLowerCase()}`)
      } else {
        await api.post('/recommendations/log', {
          pick: {
            type: item.type, title: item.title, year: item.year,
            creators: item.creators, poster_url: item.poster_url,
          },
        })
        toast(`Logged ${item.title}`)
      }
      setAdded((a) => ({ ...a, [item.title]: true }))
      void refresh()
    } catch (err) { toast((err as Error).message, 'error') }
    finally { setBusy(null) }
  }

  const more = data?.more ?? []

  return (
    <Modal
      title={`More by ${name}`}
      onClose={onClose}
      footer={<button className="btn btn--ghost" onClick={onClose}>Done</button>}
    >
      <div className="sheet__body">
        {loading ? (
          <div className="u-col" style={{ gap: 10 }}>
            <span className="u-sm u-mut">Asking the metadata sources…</span>
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="skel" style={{ height: 68 }} />)}
          </div>
        ) : !more.length ? (
          <p className="u-sm u-mut" style={{ margin: 0 }}>
            Nothing else found — either you have it all, or the sources don’t list
            any other {meta.label.toLowerCase()} under that name.
          </p>
        ) : (
          <>
            <p className="u-xs u-mut" style={{ margin: '0 0 4px' }}>
              {more.length} not on your shelf · you already have {data?.mine ?? 0}
            </p>
            <div className="u-col" style={{ gap: 8 }}>
              {more.map((item) => (
                <div key={`${item.title}-${item.year}`} className="findrow">
                  <span className="findrow__art" style={{ aspectRatio: meta.aspect }}>
                    <PosterArt src={item.poster_url} title={item.title} type={item.type} aspect={meta.aspect} />
                  </span>
                  <span className="u-col u-grow" style={{ gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 560 }}>{item.title}</span>
                    <span className="u-xs u-mut">
                      {[item.year, item.external_rating ? `${item.external_rating.toFixed(1)} externally` : null]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {added[item.title] ? (
                    <span className="u-xs u-mut">Added</span>
                  ) : (
                    <span className="u-row" style={{ gap: 6 }}>
                      <button className="btn btn--sm" disabled={busy === item.title} onClick={() => add(item, 'want')}>
                        {meta.planned}
                      </button>
                      <button className="btn btn--sm btn--ghost" disabled={busy === item.title} onClick={() => add(item, 'done')}>
                        {meta.verb}
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
