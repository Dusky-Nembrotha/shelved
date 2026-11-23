import { Link } from 'react-router-dom'
import { Icon } from './Icon'
import { Empty } from './Modal'
import { useFetch } from '../lib/store'
import { fmtDate } from '../lib/format'

interface Why { artist: string | null; tracks: number; reason: string }

export interface Gig {
  id: string
  name: string
  artists: string[]
  date: string | null
  time: string | null
  dateTbd: boolean
  venue: string | null
  city: string | null
  url: string | null
  image: string | null
  genres: string[]
  price: { min: number; max: number; currency: string } | null
  why: Why[]
}

interface GigsResponse {
  city: string
  radiusKm: number
  days: number
  counted: number
  knownArtists: number
  yours: Gig[]
  similar: Gig[]
  needsKey?: boolean
  error?: string
}

function money(price: Gig['price']) {
  if (!price) return null
  try {
    const f = new Intl.NumberFormat('en-GB', { style: 'currency', currency: price.currency, maximumFractionDigits: 0 })
    return price.min === price.max ? f.format(price.min) : `${f.format(price.min)}–${f.format(price.max)}`
  } catch { return null }
}

function GigRow({ gig }: { gig: Gig }) {
  const when = gig.date ? fmtDate(gig.date) : 'Date to be confirmed'
  const title = gig.artists.length ? gig.artists.slice(0, 2).join(' + ') : gig.name
  return (
    <a className="gig" href={gig.url || undefined} target="_blank" rel="noreferrer">
      <span className="gig__art">
        {gig.image
          ? <img src={gig.image} alt="" loading="lazy" />
          : <Icon name="note" size={18} />}
      </span>
      <span className="gig__body">
        <span className="gig__title u-trunc">{title}</span>
        <span className="gig__where u-trunc u-sm u-dim">
          {[gig.venue, gig.city].filter(Boolean).join(' · ') || 'Venue to be confirmed'}
        </span>
        <span className="chiprow">
          {gig.why.slice(0, 2).map((w, i) => (
            <span key={i} className="chip chip--why"><Icon name="sparkle" size={11} /> {w.reason}</span>
          ))}
        </span>
      </span>
      <span className="gig__when u-col">
        <span className="gig__date u-tnum">{when}</span>
        {gig.time && <span className="u-xs u-mut u-tnum">{gig.time.slice(0, 5)}</span>}
        {money(gig.price) && <span className="u-xs u-mut">{money(gig.price)}</span>}
        <Icon name="external" size={12} />
      </span>
    </a>
  )
}

/**
 * What is on near you that you would want to be at.
 *
 * Two lists, deliberately not merged. The first is arithmetic — these are
 * bands whose records are on your shelves — and is ordered by date, because
 * the useful question is what you are about to miss. The second is a guess
 * from genre, ordered by how good a guess it is.
 */
export function Gigs() {
  /*
   * `error` is read, not just `data`. The route goes out of its way to
   * explain a rejected key — and the fetch helper throws on any non-2xx, so
   * reading only `data` turned that explanation into "nothing on near you",
   * which is the one message that would send you looking in the wrong place.
   */
  const { data, loading, error } = useFetch<GigsResponse>('/gigs', [])

  if (loading) {
    return (
      <div className="u-col" style={{ gap: 10, marginTop: 14 }}>
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="skel" style={{ height: 76, borderRadius: 14 }} />)}
      </div>
    )
  }

  if (data?.needsKey) {
    return (
      <Empty
        icon="mic"
        title="Gigs needs a Ticketmaster key"
        action={(
          <div className="u-row u-wrap" style={{ gap: 8 }}>
            <Link className="btn btn--primary" to="/connections"><Icon name="key" size={14} /> Add the key</Link>
            <Link className="btn" to="/settings">Change the town</Link>
          </div>
        )}
      >
        It is free and takes a minute: sign up at <strong>developer.ticketmaster.com</strong>, add an app,
        then paste its Consumer Key into Connections. Nothing else changes — the key is only used to ask
        what is on near {data.city}.
      </Empty>
    )
  }

  if (error || data?.error) {
    const message = error || data?.error || ''
    const keyProblem = /key/i.test(message)
    return (
      <Empty
        icon="x"
        title={keyProblem ? 'That key was refused' : 'The listings did not answer'}
        action={keyProblem
          ? <Link className="btn btn--primary" to="/connections"><Icon name="key" size={14} /> Check the key</Link>
          : undefined}
      >
        {message}
      </Empty>
    )
  }

  const yours = data?.yours ?? []
  const similar = data?.similar ?? []

  if (!yours.length && !similar.length) {
    return (
      <Empty icon="mic" title={`Nothing on near ${data?.city ?? 'you'}`}>
        {data?.counted
          ? `Looked at ${data.counted} gigs in the next ${data.days} days and none of them are your sort of thing.`
          : 'No listings came back for that town. Check the town and the distance in Settings.'}
      </Empty>
    )
  }

  return (
    <div className="u-col" style={{ gap: 20, marginTop: 10 }}>
      {yours.length > 0 && (
        <div className="u-col" style={{ gap: 8 }}>
          <span className="u-caps">Artists you listen to</span>
          <div className="u-col" style={{ gap: 8 }}>
            {yours.map((g) => <GigRow key={g.id} gig={g} />)}
          </div>
        </div>
      )}

      {similar.length > 0 && (
        <div className="u-col" style={{ gap: 8 }}>
          <span className="u-caps">Your sort of thing</span>
          <span className="u-xs u-mut" style={{ marginTop: -4 }}>
            Matched on genre rather than on anything you have listened to — a guess, not a fact.
          </span>
          <div className="u-col" style={{ gap: 8 }}>
            {similar.map((g) => <GigRow key={g.id} gig={g} />)}
          </div>
        </div>
      )}

      <p className="u-xs u-mut" style={{ margin: 0 }}>
        {data?.counted} gigs within {data?.radiusKm}km of {data?.city} over the next {data?.days} days, from
        Ticketmaster — which does not carry the small independent venues, so this is not everything that is on.
      </p>
    </div>
  )
}
