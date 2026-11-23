import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'
import type { MediaType, SectionInfo, Work, ProviderHit } from './types'

type Toast = { id: number; message: string; tone: 'ok' | 'error' | 'info' }

export type LogTarget =
  | { kind: 'work'; work: Work }
  | { kind: 'hit'; hit: ProviderHit }
  | { kind: 'blank'; type?: MediaType; mode?: 'log' | 'want' }

export interface EnrichState {
  pending: number
  done: number
  missingArtwork: number
  total: number
  lastTitle: string | null
}

interface Ctx {
  enrich: EnrichState | null
  sections: SectionInfo[]
  counts: { works: number; entries: number; backfilled: number; recsOpen: number; lists: number }
  /*
   * Whether the first load has come back yet, either way.
   *
   * Counts start at zero because they have to start at something, and an
   * empty library and an unread one look identical from there — which is why
   * the app flashed its "nothing logged yet" welcome at someone with a
   * thousand entries every time they opened it. Nobody should read counts
   * without knowing whether they mean anything.
   */
  ready: boolean
  bootError: string | null
  settings: Record<string, any>
  refresh: () => Promise<void>
  toast: (message: string, tone?: Toast['tone']) => void
  toasts: Toast[]
  dismissToast: (id: number) => void
  logTarget: LogTarget | null
  openLog: (target: LogTarget) => void
  closeLog: () => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
  version: number
}

const AppCtx = createContext<Ctx | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [sections, setSections] = useState<SectionInfo[]>([])
  const [counts, setCounts] = useState({ works: 0, entries: 0, backfilled: 0, recsOpen: 0, lists: 0 })
  const [ready, setReady] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const [enrich, setEnrich] = useState<EnrichState | null>(null)
  const [theme, setThemeState] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('mm-theme') as 'dark' | 'light') || 'dark',
  )

  const setTheme = useCallback((t: 'dark' | 'light') => {
    setThemeState(t)
    localStorage.setItem('mm-theme', t)
    document.documentElement.dataset.theme = t
  }, [])

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  const refresh = useCallback(async () => {
    try {
      const [boot, secs] = await Promise.all([
        api.get<{ counts: Ctx['counts']; settings: Record<string, any> }>('/bootstrap'),
        api.get<SectionInfo[]>('/sections'),
      ])
      setCounts(boot.counts)
      setSettings(boot.settings)
      setSections(secs)
      setBootError(null)
      setVersion((v) => v + 1)
    } catch (err) {
      setBootError((err as Error).message)
      console.error(err)
    } finally {
      // Attempted, which is the thing anyone reading counts needs to know.
      setReady(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /*
   * While metadata is being filled in, keep an eye on the queue and nudge the
   * pages to refetch, so artwork appears as it arrives rather than on reload.
   */
  useEffect(() => {
    let stop = false
    let timer: number | undefined
    let wasPending = 0

    const tick = async () => {
      if (stop) return
      try {
        const next = await api.get<EnrichState>('/enrich/status')
        setEnrich(next)
        // Refetch while it works, and once more when it finishes.
        if (next.pending > 0 || wasPending > 0) setVersion((v) => v + 1)
        wasPending = next.pending
        timer = window.setTimeout(tick, next.pending > 0 ? 6000 : 30000)
      } catch {
        timer = window.setTimeout(tick, 30000)
      }
    }
    void tick()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [])

  const toast = useCallback((message: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  const value = useMemo<Ctx>(() => ({
    enrich,
    sections,
    counts,
    ready,
    bootError,
    settings,
    refresh,
    toast,
    toasts,
    dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    logTarget,
    openLog: setLogTarget,
    closeLog: () => setLogTarget(null),
    paletteOpen,
    setPaletteOpen,
    theme,
    setTheme,
    version,
  }), [enrich, sections, counts, ready, bootError, settings, refresh, toast, toasts, logTarget, paletteOpen, theme, setTheme, version])

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

export function useApp() {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}

/** Tiny data-fetching hook: enough for a single-user app, no library needed. */
export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!path) { setLoading(false); return }
    let live = true
    setLoading(true)
    setError(null)
    api.get<T>(path)
      .then((d) => { if (live) { setData(d); setLoading(false) } })
      .catch((e) => { if (live) { setError(e.message); setLoading(false) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps])

  return { data, loading, error, reload: () => setNonce((n) => n + 1), setData }
}
