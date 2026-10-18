import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { useCanvasMetrics } from '../graph/canvasMetrics'
import { useGraph } from '../graph/store'
import { useTabs } from './tabs'
import { useJobProgress, useQuota, useSseState } from './statusStore'
import { toast } from './Toasts'
import { api } from '../api/endpoints'
import { queryClient } from '../api/queryClient'
import { useUi } from '../panels/uiStore'
import { formatLocalTime } from '../lib/format'
import { useAuth } from '../auth/useMe'

const ME = { address: '0xa0cf798816d4b9b9866b5330eea46a18382f251e', is_admin: false, quota: { used: 0, limit: 5000, reset_at: '2026-10-18T00:00:00Z' } }

// Cytoscape cannot render in jsdom and the SSE stream is covered by api/useEvents.test.tsx.
vi.mock('../graph/CytoscapeView', () => ({ CytoscapeView: () => <div data-testid="cy" /> }))
vi.mock('../api/useEvents', () => ({ useEvents: () => {} }))

const H1 = '0x' + 'ab'.repeat(32)
const A1 = '0x' + '12'.repeat(20)

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'graph' }], active: 'graph' })
  useGraph.getState().reset()
  useSseState.setState({ state: 'open' })
  useQuota.setState({ quota: null, degraded: null })
  useJobProgress.setState({ byId: {} })
  history.replaceState(null, '', '/')
  localStorage.clear()
  useUi.setState({ labelEditorFor: null, detailOpen: true, txSelection: {} })
  queryClient.clear()
  useAuth.setState({ status: 'authenticated', me: ME, reason: null })
})
afterEach(() => vi.restoreAllMocks())

describe('tabs', () => {
  it('graph tab is first and cannot be closed', () => {
    useTabs.getState().openTx(H1)
    useTabs.getState().close('graph')
    expect(useTabs.getState().tabs[0]).toEqual({ id: 'graph' })
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Close Graph' })).toBeNull()
  })

  it('openTx adds and activates a tab; reopening the same hash just activates', () => {
    const s = useTabs.getState()
    s.openTx(H1)
    expect(useTabs.getState().tabs).toHaveLength(2)
    expect(useTabs.getState().active).toBe(H1)
    useTabs.getState().activate('graph')
    useTabs.getState().openTx(H1.toUpperCase().replace('0X', '0x'))
    expect(useTabs.getState().tabs).toHaveLength(2)
    expect(useTabs.getState().active).toBe(H1)
  })

  it('closing the active tx tab falls back to the graph tab', () => {
    useTabs.getState().openTx(H1)
    useTabs.getState().close(H1)
    expect(useTabs.getState().active).toBe('graph')
    expect(useTabs.getState().tabs).toHaveLength(1)
  })
})

describe('hash routing', () => {
  it('location hash #/tx/<hash> opens a tx tab on load', () => {
    history.replaceState(null, '', '#/tx/' + H1)
    render(<App />)
    expect(useTabs.getState().active).toBe(H1)
    expect(screen.getAllByText(/Tx 0xabab/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Fetching transaction/)).toBeInTheDocument()
  })

  it('#/address/<addr> adds a center and activates graph', () => {
    history.replaceState(null, '', '#/address/' + A1)
    render(<App />)
    expect(useGraph.getState().centers).toContain(A1)
    expect(useTabs.getState().active).toBe('graph')
  })

  it('ignores malformed hashes', () => {
    history.replaceState(null, '', '#/tx/0x1234')
    render(<App />)
    expect(useTabs.getState().tabs).toHaveLength(1)
    history.replaceState(null, '', '#/address/zzz')
    render(<App />)
    expect(useGraph.getState().centers).toHaveLength(0)
  })

  it('writes the location hash back when the active tab changes', () => {
    render(<App />)
    act(() => useTabs.getState().openTx(H1))
    expect(location.hash).toBe('#/tx/' + H1)
    act(() => useTabs.getState().activate('graph'))
    expect(location.hash).toBe('#/')
    act(() => useGraph.getState().select({ kind: 'node', address: A1 }))
    expect(location.hash).toBe('#/address/' + A1)
  })
})

describe('banners', () => {
  it('SSE closed state shows the reconnect banner', () => {
    useSseState.setState({ state: 'closed' })
    render(<App />)
    expect(screen.getByText('Live updates disconnected, reconnecting…')).toBeInTheDocument()
  })

  it('SSE banner: none during the first connect, kept through reconnect attempts', () => {
    useSseState.setState({ state: 'connecting', firstConnectDone: false })
    render(<App />)
    const banner = () => screen.queryByText('Live updates disconnected, reconnecting…')
    expect(banner()).toBeNull()
    act(() => useSseState.getState().set('open'))
    expect(banner()).toBeNull()
    act(() => useSseState.getState().set('closed'))
    expect(banner()).toBeInTheDocument()
    act(() => useSseState.getState().set('connecting'))
    expect(banner()).toBeInTheDocument()
    act(() => useSseState.getState().set('open'))
    expect(banner()).toBeNull()
  })

  it('SSE banner shows when the very first connect fails', () => {
    useSseState.setState({ state: 'connecting', firstConnectDone: false })
    render(<App />)
    act(() => useSseState.getState().set('closed'))
    expect(screen.getByText('Live updates disconnected, reconnecting…')).toBeInTheDocument()
    act(() => useSseState.getState().set('connecting'))
    expect(screen.getByText('Live updates disconnected, reconnecting…')).toBeInTheDocument()
  })

  it('over their own quota: the banner says names fill in tomorrow and counts the waiting jobs', async () => {
    useQuota.setState({ quota: { used: 5000, limit: 5000, paused: true, server_paused: false, reset_at: '2026-10-18T00:00:00Z' } })
    const job = (id: number, status: string) => ({ id, kind: 'contract_meta', status, params: [], attempts: 0, error: null, batches: [] })
    vi.spyOn(api, 'jobs').mockResolvedValue([job(1, 'running'), job(2, 'paused_user_quota'), job(3, 'paused_user_quota')] as never)
    // Job 1 paused after the list was loaded: its progress event is the newer status.
    useJobProgress.getState().upsert({ type: 'JobProgress', job_id: 1, kind: 'contract_meta', fetched: 0, cursor_block: null, status: 'paused_user_quota', error: null })
    render(<App />)
    const text = await screen.findByText(
      "Today's quota is used up: names and metadata are filled in tomorrow. 3 jobs wait for the reset at 2026-10-18 00:00:00 UTC",
    )
    expect(text).toHaveAttribute('title', formatLocalTime('2026-10-18T00:00:00Z'))
    expect(document.querySelector('.topbar__quota')).toHaveTextContent('Quota 5,000/5,000')
    expect(document.querySelector('.topbar__quota')).toHaveClass('chip--error')
  })

  it('over their own quota with nothing waiting: no job count', () => {
    useQuota.setState({ quota: { used: 5000, limit: 5000, paused: true, server_paused: false, reset_at: '2026-10-18T00:00:00Z' } })
    vi.spyOn(api, 'jobs').mockResolvedValue([])
    render(<App />)
    expect(screen.getByText("Today's quota is used up: names and metadata are filled in tomorrow. It resets at 2026-10-18 00:00:00 UTC")).toBeInTheDocument()
  })

  it('the server total used up: everyone waits, said differently', () => {
    useQuota.setState({ quota: { used: 10, limit: 5000, paused: true, server_paused: true, reset_at: '2026-10-18T00:00:00Z' } })
    render(<App />)
    expect(screen.getByText("The server's Etherscan quota is used up for today; all jobs resume at 2026-10-18 00:00:00 UTC")).toBeInTheDocument()
    expect(screen.queryByText(/names and metadata are filled in tomorrow/)).toBeNull()
  })

  it('the quota chip shows the user\'s own used / limit and what is left', () => {
    useQuota.setState({ quota: { used: 1200, limit: 5000, paused: false, server_paused: false, reset_at: '2026-10-18T00:00:00Z' } })
    render(<App />)
    const chip = document.querySelector('.topbar__quota')
    expect(chip).toHaveTextContent('Quota 1,200/5,000')
    expect(chip).toHaveAttribute(
      'title',
      `Your Etherscan calls today: 1,200 used, 3,800 left. Resets at 2026-10-18 00:00:00 UTC (local ${formatLocalTime('2026-10-18T00:00:00Z')})`,
    )
    expect(screen.queryByText(/quota is used up/)).toBeNull()
  })

  it('invalid_key degraded shows the fatal banner', () => {
    useQuota.setState({ degraded: 'invalid_key' })
    render(<App />)
    expect(screen.getByText('Etherscan API key is invalid; all fetching is paused')).toBeInTheDocument()
  })
})

describe('toasts', () => {
  it('shows max 3 and auto-dismisses after 5s', () => {
    vi.useFakeTimers()
    render(<App />)
    act(() => { for (let i = 0; i < 4; i++) toast('消息' + i, 'info') })
    expect(screen.queryByText('消息0')).toBeNull()
    expect(screen.getByText('消息3')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5100) })
    expect(screen.queryByText('消息3')).toBeNull()
    vi.useRealTimers()
  })
})

describe('status stores', () => {
  it('activeCount counts pending/running/paused_quota/paused_user_quota only', () => {
    const mk = (id: number, status: any) => ({ type: 'JobProgress' as const, job_id: id, kind: 'address_sync' as any, fetched: 0, cursor_block: null, status, error: null })
    const u = useJobProgress.getState().upsert
    u(mk(1, 'running')); u(mk(2, 'done')); u(mk(3, 'paused_quota')); u(mk(4, 'pending')); u(mk(1, 'running'))
    u(mk(5, 'paused_user_quota')); u(mk(6, 'cancelled'))
    expect(useJobProgress.getState().activeCount()).toBe(4)
  })
})

describe('split + layout', () => {
  it('right panel toggle button exists and split persists height', async () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Toggle details' })).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize the details table' })).toBeInTheDocument()
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: 'Toggle details' }))
  })
})

describe('institutional-light shell', () => {
  it('renders Lucide icons instead of glyph icons', () => {
    useTabs.getState().openTx(H1)
    useSseState.setState({ state: 'closed', firstConnectDone: true })
    render(<App />)
    expect(document.body.textContent).not.toMatch(/[⚙▾▤×⚠✓✗]/)
    expect(document.querySelectorAll('.topbar svg.lucide').length).toBeGreaterThanOrEqual(4)
    expect(screen.getByRole('button', { name: 'Close Tx 0xabab…abab' }).querySelector('svg.lucide')).not.toBeNull()
    expect(document.querySelector('.banner svg.lucide')).not.toBeNull()
  })

  it('status bar shows the SSE state as a coloured dot', () => {
    render(<App />)
    expect(screen.getByText('Live').querySelector('.dot--pos')).not.toBeNull()
    act(() => useSseState.getState().set('closed'))
    expect(screen.getByText('Disconnected').querySelector('.dot--neg')).not.toBeNull()
  })

  it('the right panel is 320px wide by default and resizable from its left edge', () => {
    render(<App />)
    const handle = screen.getByRole('separator', { name: 'Resize the details panel' })
    expect((document.querySelector('.main__right') as HTMLElement).style.width).toBe('320px')
    expect(handle.closest('.main__right')).not.toBeNull()
  })
})

describe('fix round 1', () => {
  it('hashchange to #/address keeps the hash and selects the node', () => {
    render(<App />)
    const A2 = '0x' + '34'.repeat(20)
    act(() => {
      history.replaceState(null, '', '#/address/' + A2)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(location.hash).toBe('#/address/' + A2)
    expect(useGraph.getState().selection).toEqual({ kind: 'node', address: A2 })
  })

  it('a #/address route center gets a budgeted first batch', () => {
    useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 0 })
    render(<App />)
    const A2 = '0x' + '78'.repeat(20)
    act(() => {
      history.replaceState(null, '', '#/address/' + A2)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(useGraph.getState().limits[A2]).toEqual(expect.any(Number))
    expect(useGraph.getState().limits[A2]).toBeGreaterThanOrEqual(3)
  })

  it('a #/address route to a hidden node shows it again', () => {
    const A2 = '0x' + '56'.repeat(20)
    useGraph.getState().setCenters([A2])
    useGraph.getState().setHidden([A2], true)
    render(<App />)
    act(() => {
      history.replaceState(null, '', '#/address/' + A2)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(useGraph.getState().ui[A2]?.hidden).toBe(false)
    expect(useGraph.getState().centers).toEqual([A2])
  })

  it('keyboard resize persists and changes the inline height', async () => {
    render(<App />)
    const sep = screen.getByRole('separator', { name: 'Resize the details table' })
    const bottom = sep.nextElementSibling as HTMLElement
    expect(bottom.style.height).toBe('32%')
    sep.focus()
    await userEvent.setup().keyboard('{ArrowUp}')
    expect(bottom.style.height).toMatch(/px$/)
    expect(Number(localStorage.getItem('ethergraph.splitHeight'))).toBeGreaterThanOrEqual(120)
  })

  it('clamps an oversized stored height on mount', () => {
    localStorage.setItem('ethergraph.splitHeight', '900')
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 500 } as DOMRect)
    render(<App />)
    const bottom = screen.getByRole('separator', { name: 'Resize the details table' }).nextElementSibling as HTMLElement
    expect(bottom.style.height).toBe('380px')
    spy.mockRestore()
  })

  it('graph content stays mounted while a tx tab is active', () => {
    render(<App />)
    const before = screen.getByText('Enter an address, tx hash or ENS name to start exploring')
    act(() => useTabs.getState().openTx(H1))
    act(() => useTabs.getState().activate('graph'))
    expect(screen.getByText('Enter an address, tx hash or ENS name to start exploring')).toBe(before)
    expect(before.closest('.main__graph')).not.toHaveAttribute('hidden')
  })
})

describe('final review fixes', () => {
  const profile = (a: string) => ({
    node: { address: a, kind: 'eoa' as const, display_name: null, ens: null, contract_name: null, labels: [], partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null },
    is_proxy: false, implementation: null, creator: null, creation_tx: null, coverage: [], first_seen: null, last_seen: null,
  })

  it('on a tx tab exactly one Add label button exists (the tx tab detail in the right panel)', async () => {
    const A2 = '0x' + '34'.repeat(20)
    vi.spyOn(api, 'address').mockImplementation(async (a) => profile(a))
    vi.spyOn(api, 'tx').mockResolvedValue({ status: 'pending', flow: null, job_id: null })
    render(<App />)
    act(() => {
      useGraph.getState().select({ kind: 'node', address: A1 })
      useTabs.getState().openTx(H1)
      useUi.getState().selectTx(H1, A2)
    })
    expect(await screen.findByText(A2)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add label', hidden: true })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Add to graph' })).toBeInTheDocument()
    act(() => useTabs.getState().activate('graph'))
    expect(await screen.findByText(A1)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add label', hidden: true })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Add to graph' })).toBeNull()
  })

  it('the detail toggle and the label editor request drive the shared detailOpen state', async () => {
    vi.spyOn(api, 'address').mockImplementation(async (a) => profile(a))
    render(<App />)
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: 'Toggle details' }))
    expect(document.querySelector('.main__right')).toBeNull()
    act(() => {
      useGraph.getState().select({ kind: 'node', address: A1 })
      useUi.getState().openLabelEditor(A1)
    })
    expect(document.querySelector('.main__right')).not.toBeNull()
    expect(await screen.findByText('Label text')).toBeInTheDocument()
  })
})
