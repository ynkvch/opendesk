import { useCallback, useEffect, useState } from 'react'
import { TopBar } from './components/TopBar'
import { TradeView } from './components/TradeView'
import { ErrorNote, Skeleton } from './components/ui'
import { api, type AccountDay, type Costs, type Summary, type TradeRow } from './lib/api'
import { navigate, useLocation, withTrade } from './lib/router'
import { Dashboard } from './pages/Dashboard'
import { Journal } from './pages/Journal'
import { RegimePage } from './pages/Regime'
import { VolPage } from './pages/Vol'

type Data = { trades: TradeRow[]; summary: Summary; account: AccountDay[]; costs: Costs }

export default function App() {
  const { path, trade } = useLocation()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  // order of the list the trade view was opened from, for previous / next
  const [order, setOrder] = useState<number[] | null>(null)

  const load = useCallback(() => {
    setError(null)
    Promise.all([api.trades(), api.summary(), api.account(), api.costs()])
      .then(([trades, summary, account, costs]) => setData({ trades, summary, account, costs }))
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(load, [load])

  // pick up new syncs without a reload; skipped while the tab is hidden
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => window.clearInterval(id)
  }, [load])

  const open = useCallback((id: number, list: number[]) => {
    setOrder(list)
    navigate(withTrade(id))
  }, [])
  const go = useCallback((id: number) => navigate(withTrade(id), { replace: true }), [])
  const close = useCallback(() => navigate(withTrade(null)), [])

  const page = path === '/journal' ? 'journal'
    : ['/flow', '/vol'].some((p) => path === p || path.startsWith(`${p}/`)) ? 'flow'
    : path === '/regime' || path.startsWith('/regime/') || path === '/data' || path === '/signals' ? 'regime' : 'dashboard'
  const journalPage = page !== 'regime' && page !== 'flow'

  return (
    <div className="min-h-[100dvh]">
      <TopBar path={page === 'dashboard' ? '/' : `/${page}`} asOf={journalPage ? data?.summary.as_of ?? null : null}
        source={journalPage ? data?.trades[0]?.source ?? null : null} />
      <main className="mx-auto max-w-[1400px] space-y-10 px-4 pb-24 pt-6 md:px-8 md:pt-8">
        {page === 'dashboard' && <h1 className="sr-only">Dashboard</h1>}
        {page === 'regime' && <RegimePage path={path} />}
        {page === 'flow' && <VolPage path={path} />}
        {journalPage && error && <ErrorNote message={error} onRetry={load} />}
        {journalPage && !data && !error && <PageSkeleton />}
        {data && page === 'dashboard' && (
          <Dashboard trades={data.trades} summary={data.summary} account={data.account} costs={data.costs} selected={trade} onOpen={open} />
        )}
        {data && page === 'journal' && <Journal trades={data.trades} selected={trade} onOpen={open} />}
      </main>
      {trade != null && data && (
        <TradeView id={trade} order={order ?? data.trades.map((t) => t.id)} onClose={close} onGo={go} onSaved={load} />
      )}
    </div>
  )
}

function PageSkeleton() {
  return (
    <div className="space-y-10" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="panel space-y-5 p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-11 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="panel space-y-3 p-6">
          {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}
        </div>
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  )
}
