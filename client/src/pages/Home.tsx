import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { artworkUrl } from '../lib/img'
import { Row } from '../components/Row'
import { PosterCard, PosterSkeleton } from '../components/Poster'
import { Empty, Failed } from '../components/Modal'
import { useApp, useFetch } from '../lib/store'
import { SECTION_META, TYPE_ORDER, creatorLine, fmtDate, relDate, fmtNumber } from '../lib/format'
import type { ActivityItem, Rec, WorkCard, MediaType } from '../lib/types'

export function HomePage() {
  const { counts, sections, openLog, ready, bootError, refresh } = useApp()

  /*
   * The diary, not the library: `exclude=backfill` drops entries that were
   * imported in bulk to describe taste — a saved playlist, dated by the
   * record's release — which would otherwise fill this row with songs.
   */
  const recent = useFetch<{ works: WorkCard[] }>('/works?sort=recent&status=logged&limit=18&exclude=backfill')
  const inProgress = useFetch<{ works: WorkCard[] }>('/works?status=in_progress&limit=12')
  const activity = useFetch<{ activity: ActivityItem[] }>('/activity?limit=8')
  const inbox = useFetch<{ recs: Rec[] }>('/recs?status=open')
  const topRated = useFetch<{ works: WorkCard[] }>('/works?sort=rating&minRating=4.5&limit=18')

  /*
   * Counts are zero until the first load answers, so an unread library and an
   * empty one are the same thing from here. Showing the welcome before anyone
   * has looked meant flashing "nothing logged yet" at a thousand entries on
   * every single visit. Wait to be told.
   */
  if (!ready) {
    return (
      <div className="page">
        <div className="grid" style={{ marginTop: 28 }}>
          {Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} />)}
        </div>
      </div>
    )
  }

  if (bootError && counts.works === 0) {
    return (
      <div className="page">
        <Failed what="your library" error={bootError} onRetry={() => { void refresh() }} />
      </div>
    )
  }

  const isEmpty = counts.works === 0

  if (isEmpty) {
    return (
      <div className="page">
        <div className="hero-empty">
          <span className="pill pill--accent">Nothing logged yet</span>
          <h1>A home for everything you watch, read and listen to.</h1>
          <p className="u-dim">
            Import years of history from Letterboxd, Goodreads, Audible, Spotify, Trakt, IMDb, Netflix
            and JustWatch — or add something by hand and let the taste engine learn from it.
          </p>
          <div className="u-row u-wrap" style={{ gap: 10, marginTop: 6 }}>
            <Link className="btn btn--primary btn--lg" to="/import"><Icon name="import" size={16} /> Import your data</Link>
            <button className="btn btn--lg" onClick={() => openLog({ kind: 'blank' })}><Icon name="plus" size={16} /> Add something</button>
          </div>
        </div>
      </div>
    )
  }

  const live = sections.filter((s) => s.works > 0)
  // Sections you have actually logged in, which is what the sentence counts.
  const logged = sections.filter((s) => s.live_entries > 0)

  return (
    <div className="page">
      <header className="home-hero">
        <p className="home-hero__line u-dim">
          {counts.entries.toLocaleString('en-GB')} entries across {logged.length} section{logged.length === 1 ? '' : 's'}
          {activity.data?.activity?.[0]?.consumed_on
            ? ` · last ${relDate(activity.data.activity[0].consumed_on)}`
            : ''}
          {/* Said plainly rather than folded into the count: these are not
              things you logged, they are things you told it you like. */}
          {counts.backfilled > 0
            ? ` · ${counts.backfilled.toLocaleString('en-GB')} tracks on file`
            : ''}
        </p>
        <div className="statstrip">
          {live.slice(0, 4).map((s) => (
            <Link key={s.type} to={SECTION_META[s.type as MediaType].path} className="stattile">
              <span className="stattile__icon" style={{ color: SECTION_META[s.type as MediaType].hue }}>
                <Icon name={SECTION_META[s.type as MediaType].icon} size={17} />
              </span>
              <span className="stattile__value u-tnum">{fmtNumber(s.works)}</span>
              <span className="stattile__label">{s.label}</span>
              {s.avg_rating != null && <span className="stattile__foot u-tnum">avg {s.avg_rating.toFixed(1)}★</span>}
            </Link>
          ))}
        </div>
      </header>

      {inProgress.data?.works?.length ? (
        <Row title="On the go" subtitle="Part-way through" cardWidth={150}>
          {inProgress.data.works.map((w) => <PosterCard key={w.id} work={w} />)}
        </Row>
      ) : null}

      <Row
        title="Recently logged"
        cardWidth={150}
      >
        {recent.loading
          ? Array.from({ length: 8 }, (_, i) => <PosterSkeleton key={i} />)
          : recent.data?.works?.map((w) => <PosterCard key={w.id} work={w} />)}
      </Row>

      <div className="home-split">
        <section>
          <div className="section-head">
            <div>
              <h2>Latest activity</h2>
              <p>Your diary, in brief</p>
            </div>
          </div>
          <div className="card" style={{ padding: 6 }}>
            {activity.data?.activity?.length
              ? activity.data.activity.map((a) => (
                <Link key={a.entry_id} to={`/work/${a.work_id}`} className="actrow">
                  {a.poster_url
                    ? <img className="actrow__thumb" src={artworkUrl(a.poster_url)} alt="" loading="lazy" />
                    : <span className="actrow__thumb" />}
                  <span className="u-grow u-col" style={{ gap: 2, minWidth: 0 }}>
                    <span className="u-trunc" style={{ fontSize: 13.5, fontWeight: 560 }}>{a.title}</span>
                    <span className="u-xs u-mut u-trunc">
                      {[SECTION_META[a.type].label, a.year, creatorLine(a.creators, 1)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="u-col" style={{ alignItems: 'flex-end', gap: 2, flex: '0 0 auto' }}>
                    {a.rating != null && <span className="u-xs u-tnum" style={{ color: 'var(--star)' }}>{a.rating}★</span>}
                    <span className="u-xs u-mut">{fmtDate(a.consumed_on) || 'no date'}</span>
                  </span>
                </Link>
              ))
              : <Empty icon="calendar" title="Nothing logged yet" />}
          </div>
        </section>

        <section>
          <div className="section-head">
            <div>
              <h2>To check out</h2>
              <p>Things you wanted to remember</p>
            </div>
            <Link className="btn btn--sm btn--ghost" to="/inbox">All <Icon name="chevronRight" size={14} /></Link>
          </div>
          <div className="card" style={{ padding: 6 }}>
            {inbox.data?.recs?.length
              ? inbox.data.recs.slice(0, 6).map((r) => (
                <div key={r.id} className="actrow">
                  {r.poster_url
                    ? <img className="actrow__thumb" src={artworkUrl(r.poster_url)} alt="" loading="lazy" />
                    : <span className="actrow__thumb" />}
                  <span className="u-grow u-col" style={{ gap: 2, minWidth: 0 }}>
                    <span className="u-trunc" style={{ fontSize: 13.5, fontWeight: 560 }}>{r.title}</span>
                    <span className="u-xs u-mut u-trunc">
                      {[r.type ? SECTION_META[r.type].singular : null, r.year, r.recommender].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {r.priority === 2 && <span className="pill pill--accent">Soon</span>}
                </div>
              ))
              : (
                <Empty icon="inbox" title="Inbox empty">
                  Add anything a friend tells you to watch — it keeps the pile honest.
                </Empty>
              )}
          </div>
        </section>
      </div>

      {topRated.data?.works?.length ? (
        <Row title="Your favourites" subtitle="Everything you rated 4½ or 5" cardWidth={150}>
          {topRated.data.works.map((w) => <PosterCard key={w.id} work={w} />)}
        </Row>
      ) : null}

      <div className="promo">
        <div className="u-col" style={{ gap: 4 }}>
          <strong style={{ fontSize: 15 }}>Recommendations built from your own ratings</strong>
          <span className="u-sm u-dim">
            The taste engine reads which genres, directors, authors and decades you rate above your own
            average, then goes looking for things you have not logged yet.
          </span>
        </div>
        <Link className="btn btn--primary" to="/films"><Icon name="sparkle" size={15} /> See suggestions</Link>
      </div>
    </div>
  )
}
