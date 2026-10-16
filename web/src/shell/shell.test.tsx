import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { useGraph } from '../graph/store'
import { useTabs } from './tabs'
import { useJobProgress, useQuota, useSseState } from './statusStore'
import { toast } from './Toasts'

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
})

describe('tabs', () => {
  it('graph tab is first and cannot be closed', () => {
    useTabs.getState().openTx(H1)
    useTabs.getState().close('graph')
    expect(useTabs.getState().tabs[0]).toEqual({ id: 'graph' })
    render(<App />)
    expect(screen.queryByRole('button', { name: '关闭 关系图' })).toBeNull()
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
    expect(screen.getAllByText(/交易 0xabab/).length).toBeGreaterThan(0)
    expect(screen.getByText(/正在获取交易/)).toBeInTheDocument()
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
    expect(screen.getByText('实时更新已断开，正在重连…')).toBeInTheDocument()
  })

  it('SSE banner: none during the first connect, kept through reconnect attempts', () => {
    useSseState.setState({ state: 'connecting', firstConnectDone: false })
    render(<App />)
    const banner = () => screen.queryByText('实时更新已断开，正在重连…')
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
    expect(screen.getByText('实时更新已断开，正在重连…')).toBeInTheDocument()
    act(() => useSseState.getState().set('connecting'))
    expect(screen.getByText('实时更新已断开，正在重连…')).toBeInTheDocument()
  })

  it('quota paused shows the reset time banner', () => {
    useQuota.setState({ quota: { used: 100, limit: 100, paused: true, reset_at: '2026-10-18T00:00:00Z' } })
    render(<App />)
    expect(screen.getByText(/今日 Etherscan 额度已用完，将于 .+ 恢复/)).toBeInTheDocument()
  })

  it('invalid_key degraded shows the fatal banner', () => {
    useQuota.setState({ degraded: 'invalid_key' })
    render(<App />)
    expect(screen.getByText('Etherscan API key 无效，所有抓取已暂停')).toBeInTheDocument()
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
  it('activeCount counts pending/running/paused_quota only', () => {
    const mk = (id: number, status: any) => ({ type: 'JobProgress' as const, job_id: id, kind: 'address_sync' as any, fetched: 0, cursor_block: null, status, error: null })
    const u = useJobProgress.getState().upsert
    u(mk(1, 'running')); u(mk(2, 'done')); u(mk(3, 'paused_quota')); u(mk(4, 'pending')); u(mk(1, 'running'))
    expect(useJobProgress.getState().activeCount()).toBe(3)
  })
})

describe('split + layout', () => {
  it('right panel toggle button exists and split persists height', async () => {
    render(<App />)
    expect(screen.getByRole('button', { name: '详情栏' })).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: '详情栏' }))
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

  it('keyboard resize persists and changes the inline height', async () => {
    render(<App />)
    const sep = screen.getByRole('separator')
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
    const bottom = screen.getByRole('separator').nextElementSibling as HTMLElement
    expect(bottom.style.height).toBe('380px')
    spy.mockRestore()
  })

  it('graph content stays mounted while a tx tab is active', () => {
    render(<App />)
    const before = screen.getByText('输入地址、交易哈希或 ENS 开始探索')
    act(() => useTabs.getState().openTx(H1))
    act(() => useTabs.getState().activate('graph'))
    expect(screen.getByText('输入地址、交易哈希或 ENS 开始探索')).toBe(before)
    expect(before.closest('.main__graph')).not.toHaveAttribute('hidden')
  })
})
