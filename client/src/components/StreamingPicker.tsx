import { useState } from 'react'
import { Icon } from './Icon'
import { api } from '../lib/api'
import { useApp, useFetch } from '../lib/store'

interface Service { id: number; name: string; logo: string | null; priority: number }

/**
 * Which services you pay for.
 *
 * TMDB lists a hundred and forty for the UK and almost nobody has heard of
 * most of them, so the common ones show and the rest hide behind a link —
 * a wall of a hundred and forty logos is not a choice, it is a search
 * problem. Saved as you tick, because a save button on a list of toggles is
 * a step nobody expects.
 */
export function StreamingPicker() {
  const { toast } = useApp()
  const { data, loading } = useFetch<{ region: string; available: Service[]; selected: number[] }>('/watch/services')
  const [selected, setSelected] = useState<number[] | null>(null)
  const [showAll, setShowAll] = useState(false)

  const chosen = selected ?? data?.selected ?? []
  const all = data?.available ?? []
  // The ones people mean, then everything else behind a link.
  const shown = showAll ? all : all.slice(0, 14)

  async function toggle(id: number) {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]
    setSelected(next)
    try {
      await api.put('/watch/services', { selected: next })
    } catch (err) {
      setSelected(chosen)
      toast((err as Error).message, 'error')
    }
  }

  if (loading) return <div className="skel" style={{ height: 96 }} />

  if (!all.length) {
    return (
      <p className="u-sm u-mut" style={{ margin: 0 }}>
        This needs a TMDB key — the list of services and what is on them both come from there.
      </p>
    )
  }

  return (
    <>
      <div className="services">
        {shown.map((s) => {
          const on = chosen.includes(s.id)
          return (
            <button
              key={s.id}
              type="button"
              className={`service${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => toggle(s.id)}
              title={s.name}
            >
              {s.logo
                ? <img src={s.logo} alt="" loading="lazy" />
                : <span className="service__initial">{s.name.slice(0, 1)}</span>}
              <span className="service__name u-trunc">{s.name}</span>
              {on && <span className="service__tick"><Icon name="check" size={12} /></span>}
            </button>
          )
        })}
      </div>

      {all.length > shown.length && (
        <button className="linkish u-xs" style={{ marginTop: 10 }} onClick={() => setShowAll(true)}>
          Show the other {all.length - shown.length} services
        </button>
      )}

      <p className="u-xs u-mut" style={{ margin: '12px 0 0' }}>
        {chosen.length
          ? `${chosen.length} selected — Hot and Suggestions can now be narrowed to what you can watch.`
          : 'Pick the ones you subscribe to, then Hot and Suggestions can be narrowed to what you can watch.'}
      </p>
    </>
  )
}
