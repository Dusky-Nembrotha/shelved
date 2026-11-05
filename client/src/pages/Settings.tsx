import { useEffect, useState } from 'react'
import { StreamingPicker } from '../components/StreamingPicker'
import { Link } from 'react-router-dom'
import { PoorArtworkList } from '../components/ArtworkPicker'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { useApp, useFetch } from '../lib/store'
import { fmtNumber } from '../lib/format'

interface AuthStatus { configured: boolean; authenticated: boolean; canSetup: boolean; lockedOut: boolean }

/** Set the first password, or change an existing one. */
function PasswordCard() {
  const { toast } = useApp()
  const auth = useFetch<AuthStatus>('/auth/status')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const configured = auth.data?.configured ?? false

  async function save() {
    if (next !== confirm) { toast('Those two do not match', 'error'); return }
    if (next.length < 8) { toast('At least 8 characters, please', 'error'); return }
    setBusy(true)
    try {
      await api.post('/auth/password', { current: configured ? current : undefined, password: next })
      toast(configured ? 'Password changed — other devices signed out' : 'Password set')
      setCurrent(''); setNext(''); setConfirm('')
      auth.reload()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally { setBusy(false) }
  }

  return (
    <section className="card card--pad-lg">
      <h2 style={{ marginBottom: 4 }}>Password</h2>
      {configured ? (
        <p className="u-sm u-mut" style={{ marginBottom: 16 }}>
          A password is set. Changing it signs out every other device straight away.
        </p>
      ) : (
        <div className="promo promo--tip" style={{ marginBottom: 16 }}>
          <div className="u-col" style={{ gap: 3 }}>
            <strong style={{ fontSize: 14 }}>No password set</strong>
            <span className="u-sm u-dim">
              Anyone who can reach this app can use it. That is fine on your own network,
              but set one before publishing it to a public address — and set it from here,
              because the app refuses to let anyone choose the first password from outside.
            </span>
          </div>
        </div>
      )}

      <div className="u-col" style={{ gap: 12, maxWidth: 380 }}>
        {configured && (
          <div className="field">
            <label htmlFor="pw-current">Current password</label>
            <input id="pw-current" className="input" type="password" autoComplete="current-password"
              value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="pw-new">{configured ? 'New password' : 'Choose a password'}</label>
          <input id="pw-new" className="input" type="password" autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} />
          <span className="field__hint">At least 8 characters.</span>
        </div>
        <div className="field">
          <label htmlFor="pw-confirm">And again</label>
          <input id="pw-confirm" className="input" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div className="u-row" style={{ gap: 8 }}>
          <button className="btn btn--primary" disabled={busy || !next} onClick={save}>
            {busy ? 'Saving…' : configured ? 'Change password' : 'Set password'}
          </button>
          {configured && (
            <button className="btn btn--ghost" onClick={async () => {
              await api.post('/auth/logout')
              window.location.reload()
            }}>Sign out</button>
          )}
        </div>
      </div>
    </section>
  )
}

export function SettingsPage() {
  const { toast, refresh, settings, theme, setTheme, counts } = useApp()
  const [owner, setOwner] = useState('')
  const [saving, setSaving] = useState(false)
  const [resetText, setResetText] = useState('')
  const enrich = useFetch<any>('/enrich/status')

  useEffect(() => { setOwner(settings.owner_name || '') }, [settings.owner_name])

  async function save(patch: Record<string, unknown>, message = 'Saved') {
    setSaving(true)
    try {
      await api.put('/settings', patch)
      toast(message)
      await refresh()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally { setSaving(false) }
  }

  return (
    <div className="page">
      <div className="settingswrap">
        <section className="card card--pad-lg u-hide">
          <div className="u-spread" style={{ marginBottom: 10 }}>
            <div className="u-col" style={{ gap: 3 }}>
              <h2 style={{ margin: 0 }}>Connected services</h2>
              <span className="u-sm u-mut">Trakt, Last.fm, Spotify and Steam sync live; everything else imports from a file.</span>
            </div>
            <Link className="btn" to="/connections"><Icon name="key" size={15} /> Manage</Link>
          </div>
        </section>

        <section className="card card--pad-lg">
          <h2 style={{ marginBottom: 4 }}>Your streaming services</h2>
          <p className="u-sm u-mut" style={{ marginBottom: 14 }}>
            Tick what you subscribe to and both the chart and your suggestions can be narrowed to
            things you can press play on tonight. Renting and buying are not counted — the question
            is what you can watch without paying again.
          </p>
          <StreamingPicker />
        </section>

        <section className="card card--pad-lg">
          <h2 style={{ marginBottom: 4 }}>Metadata keys</h2>
          <p className="u-sm u-mut" style={{ marginBottom: 16 }}>
            Everything works without any keys — books come from Google Books and Open Library,
            music from Apple and MusicBrainz, TV from TVmaze, films from Wikipedia and Wikidata.
            A few free keys sharpen things up considerably: TMDB for film and TV detail, OMDb for
            IMDb and Rotten Tomatoes scores, Google Books for steadier book records.
          </p>
          <p className="u-sm u-mut" style={{ marginBottom: 16 }}>
            Each key now lives with the service it belongs to, next to the steps for getting one.
          </p>
          <Link className="btn btn--primary" to="/connections">
            <Icon name="key" size={15} /> Manage keys in Connections
          </Link>
        </section>

        <section className="card card--pad-lg">
          <h2 style={{ marginBottom: 4 }}>Your library</h2>
          <p className="u-sm u-mut" style={{ marginBottom: 14 }}>
            Everything about getting data in, and what it adds up to.
          </p>
          <div className="settinglinks">
            <Link to="/stats" className="settinglink">
              <span className="settinglink__icon"><Icon name="chart" size={19} /></span>
              <span className="u-col" style={{ gap: 2 }}>
                <strong>Stats</strong>
                <span className="u-xs u-mut">Ratings, activity and what you return to</span>
              </span>
              <Icon name="chevronRight" size={15} className="u-mut" />
            </Link>
            <Link to="/connections" className="settinglink">
              <span className="settinglink__icon"><Icon name="key" size={19} /></span>
              <span className="u-col" style={{ gap: 2 }}>
                <strong>Connections</strong>
                <span className="u-xs u-mut">Live sync, API keys, and how to export from everywhere else</span>
              </span>
              <Icon name="chevronRight" size={15} className="u-mut" />
            </Link>
            <Link to="/import" className="settinglink">
              <span className="settinglink__icon"><Icon name="import" size={19} /></span>
              <span className="u-col" style={{ gap: 2 }}>
                <strong>Import a file</strong>
                <span className="u-xs u-mut">Letterboxd, Goodreads, Audible, Spotify and more</span>
              </span>
              <Icon name="chevronRight" size={15} className="u-mut" />
            </Link>
            <Link to="/inbox" className="settinglink">
              <span className="settinglink__icon"><Icon name="inbox" size={19} /></span>
              <span className="u-col" style={{ gap: 2 }}>
                <strong>Everything to check out</strong>
                <span className="u-xs u-mut">All your lists in one place, across every kind of media</span>
              </span>
              <Icon name="chevronRight" size={15} className="u-mut" />
            </Link>
          </div>
        </section>

        <PasswordCard />

        <section className="card card--pad-lg">
          <h2 style={{ marginBottom: 4 }}>Appearance</h2>
          <p className="u-sm u-mut" style={{ marginBottom: 16 }}>Dark is the designed default; light is a full second theme, not an inversion.</p>
          <div className="u-row" style={{ gap: 8 }}>
            <button className={`chip${theme === 'dark' ? ' is-on' : ''}`} onClick={() => setTheme('dark')}><Icon name="moon" size={13} /> Dark</button>
            <button className={`chip${theme === 'light' ? ' is-on' : ''}`} onClick={() => setTheme('light')}><Icon name="sun" size={13} /> Light</button>
          </div>
          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="owner">What should the home page call you?</label>
            <div className="u-row" style={{ gap: 8 }}>
              <input id="owner" className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Charlie" />
              <button className="btn" disabled={saving} onClick={() => save({ owner_name: owner.trim() })}>Save</button>
            </div>
          </div>
        </section>

        <section className="card card--pad-lg">
          <h2 style={{ marginBottom: 4 }}>Covers that need attention</h2>
          <PoorArtworkList />
        </section>

        <section className="card card--pad-lg">
          <h2 style={{ marginBottom: 4 }}>Metadata backfill</h2>
          <p className="u-sm u-mut" style={{ marginBottom: 14 }}>
            {enrich.data
              ? `${fmtNumber(enrich.data.total - enrich.data.missingArtwork)} of ${fmtNumber(enrich.data.total)} titles have artwork.`
              : 'Checking…'}
            {enrich.data?.pending ? ` ${enrich.data.pending} in the queue right now.` : ''}
          </p>
          <div className="u-row u-wrap" style={{ gap: 8 }}>
            <button className="btn" onClick={async () => { await api.post('/enrich', {}); toast('Queued the titles that are missing artwork', 'info'); enrich.reload() }}>
              <Icon name="refresh" size={14} /> Fill in what is missing
            </button>
            <button className="btn btn--ghost" onClick={async () => { await api.post('/enrich', { all: true }); toast('Re-fetching and replacing metadata for everything', 'info'); enrich.reload() }}>
              Re-fetch and replace everything
            </button>
            <button className="btn btn--ghost" onClick={async () => { await api.post('/admin/clear-cache'); toast('Provider cache cleared') }}>
              Clear provider cache
            </button>
          </div>
        </section>

        <section className="card card--pad-lg">
          <h2 style={{ marginBottom: 4 }}>Your data</h2>
          <p className="u-sm u-mut" style={{ marginBottom: 14 }}>
            {fmtNumber(counts.entries)} entries and {fmtNumber(counts.works)} titles live in a single SQLite
            file on this machine. Nothing is sent anywhere except the metadata lookups you can see above.
          </p>
          <div className="u-row u-wrap" style={{ gap: 8 }}>
            <a className="btn" href="/api/export?format=json" download><Icon name="import" size={14} /> Export JSON</a>
            <a className="btn" href="/api/export?format=csv" download><Icon name="import" size={14} /> Export CSV</a>
          </div>
        </section>

        <section className="card card--pad-lg dangerzone">
          <h2 style={{ marginBottom: 4 }}>Start again</h2>
          <p className="u-sm u-mut" style={{ marginBottom: 14 }}>
            Deletes every title, entry, list and recommendation. Your settings and the provider cache stay.
            Type <code>DELETE EVERYTHING</code> to confirm.
          </p>
          <div className="u-row" style={{ gap: 8 }}>
            <input className="input" style={{ maxWidth: 240 }} value={resetText} onChange={(e) => setResetText(e.target.value)} placeholder="DELETE EVERYTHING" />
            <button
              className="btn btn--danger"
              disabled={resetText !== 'DELETE EVERYTHING'}
              onClick={async () => {
                try {
                  await api.post('/admin/reset', { confirm: resetText })
                  toast('Library wiped')
                  setResetText('')
                  await refresh()
                } catch (err) { toast((err as Error).message, 'error') }
              }}
            >
              Wipe the library
            </button>
          </div>
        </section>

        <p className="u-xs u-mut" style={{ textAlign: 'center' }}>
          Shelved v0.1 · self-hosted · data in <code>data/shelved.db</code>
        </p>
      </div>
    </div>
  )
}
