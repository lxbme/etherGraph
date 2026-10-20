import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/endpoints'
import { ApiError } from '../api/errors'
import { useCanvasMetrics } from '../graph/canvasMetrics'
import { useGraph } from '../graph/store'
import { useTabs } from '../shell/tabs'
import { queryClient } from '../api/queryClient'
import { useGraphData } from '../graph/useGraphData'
import { usePick } from '../panels/pick/pickStore'
import { useLocale } from '../i18n'
import { useInfo } from '../panels/info/infoStore'
import { SearchBox } from './SearchBox'

const A = '0x' + 'ab'.repeat(20)
const H = '0x' + 'cd'.repeat(32)

/** Runs the graph query, as the canvas does. */
function GraphProbe() {
  useGraphData()
  return null
}

beforeEach(() => {
  vi.restoreAllMocks()
  usePick.getState().close()
  useGraph.getState().reset()
  useTabs.setState({ tabs: [{ id: 'graph' }], active: 'graph' })
})

describe('SearchBox', () => {
  it('picking an address clears the graph info stack', async () => {
    useInfo.setState({ stacks: { graph: [{ kind: 'asset', asset: null }] } })
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'address', value: A, resolved_address: null })
    vi.spyOn(api, 'address').mockResolvedValue({} as never)
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), `${A}{Enter}`)
    await waitFor(() => expect(useGraph.getState().selection).toEqual({ kind: 'node', address: A }))
    expect(useInfo.getState().stacks['graph']).toEqual([])
  })

  afterEach(() => act(() => useLocale.getState().setLocale('en')))

  it('an error shown inline switches language immediately', async () => {
    vi.spyOn(api, 'search').mockRejectedValue(new ApiError('not_found', 404, 'nope'))
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), 'zzz.eth{Enter}')
    expect(await screen.findByText('No address or name found')).toBeInTheDocument()
    act(() => useLocale.getState().setLocale('zh'))
    expect(screen.getByText('未找到该名称或地址')).toBeInTheDocument()
  })

  it('search_reveals_alone_and_opens_picker', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'address', value: A, resolved_address: null })
    const addr = vi.spyOn(api, 'address').mockResolvedValue({} as never)
    const sync = vi.spyOn(api, 'sync')
    const edges = vi.spyOn(api, 'graphEdges').mockResolvedValue({ nodes: [], edges: [], omitted: {}, coverage: {} })
    useTabs.setState({ tabs: [{ id: 'graph' }, { id: H, kind: 'tx', hash: H }], active: H })
    queryClient.clear()
    render(
      <QueryClientProvider client={queryClient}>
        <SearchBox />
        <GraphProbe />
      </QueryClientProvider>,
    )
    const box = screen.getByRole('searchbox')
    await userEvent.type(box, `${A}{Enter}`)
    await waitFor(() => expect(useGraph.getState().centers).toEqual([A]))
    expect(useGraph.getState().selection).toEqual({ kind: 'node', address: A })
    expect(useTabs.getState().active).toBe('graph')
    expect(usePick.getState().targets).toEqual([A])
    expect(box).toHaveValue('')
    // The address alone: picked with none, so the graph request asks for no neighbours.
    await waitFor(() => expect(edges).toHaveBeenCalled())
    expect(edges.mock.calls.at(-1)![0]).toMatchObject({ addresses: [A], picks: { [A]: [] }, limits: {} })
    // Nothing is synced or refreshed before a click.
    expect(addr).not.toHaveBeenCalledWith(A, { sync: 'auto' })
    expect(sync).not.toHaveBeenCalled()
  })

  it('search_of_an_existing_center_opens_nothing', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'address', value: A, resolved_address: null })
    const sync = vi.spyOn(api, 'sync')
    useGraph.getState().setCenters([A])
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), `${A}{Enter}`)
    await waitFor(() => expect(useGraph.getState().selection).toEqual({ kind: 'node', address: A }))
    expect(useGraph.getState().centers).toEqual([A])
    expect(usePick.getState().targets).toBeNull()
    expect(sync).not.toHaveBeenCalled()
  })

  it('a searched address becomes a center picked with no neighbours yet', async () => {
    useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 0 })
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'address', value: A, resolved_address: null })
    vi.spyOn(api, 'address').mockResolvedValue({} as never)
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), `${A}{Enter}`)
    await waitFor(() => expect(useGraph.getState().picks).toEqual({ [A]: [] }))
    expect(useGraph.getState().limits).toEqual({})
  })

  it('searching a hidden address shows it again', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'address', value: A, resolved_address: null })
    vi.spyOn(api, 'address').mockResolvedValue({} as never)
    useGraph.getState().setCenters([A])
    useGraph.getState().setHidden([A], true)
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), `${A}{Enter}`)
    await waitFor(() => expect(useGraph.getState().ui[A]?.hidden).toBe(false))
    expect(useGraph.getState().centers).toEqual([A])
  })

  it('tx opens a tx tab', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'tx', value: H, resolved_address: null })
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), `${H}{Enter}`)
    await waitFor(() => expect(useTabs.getState().active).toBe(H))
    expect(useGraph.getState().centers).toEqual([])
  })

  it('ens uses resolved_address', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'ens', value: 'a.eth', resolved_address: A })
    vi.spyOn(api, 'address').mockResolvedValue({} as never)
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), 'a.eth{Enter}')
    await waitFor(() => expect(useGraph.getState().centers).toEqual([A]))
  })

  it('ens not_found shows message and does not change centers', async () => {
    vi.spyOn(api, 'search').mockRejectedValue(new ApiError('not_found', 404, 'nope'))
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), 'zzz.eth{Enter}')
    expect(await screen.findByText('No address or name found')).toBeInTheDocument()
    expect(useGraph.getState().centers).toEqual([])
  })

  it('invalid input shows inline hint without calling api', async () => {
    const s = vi.spyOn(api, 'search')
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), 'hello{Enter}')
    expect(screen.getByText('Enter an address (0x + 40 hex), a transaction hash (0x + 64 hex) or an ENS name')).toBeInTheDocument()
    expect(s).not.toHaveBeenCalled()
  })

  it('disables re-submit while in flight', async () => {
    let resolve!: (v: never) => void
    const s = vi.spyOn(api, 'search').mockReturnValue(new Promise((r) => { resolve = r as never }))
    render(<SearchBox />)
    const box = screen.getByRole('searchbox')
    await userEvent.type(box, `${H}{Enter}`)
    expect(screen.getByText('Searching…')).toBeInTheDocument()
    await userEvent.type(box, '{Enter}')
    expect(s).toHaveBeenCalledTimes(1)
    resolve({ kind: 'tx', value: H, resolved_address: null } as never)
    await waitFor(() => expect(screen.queryByText('Searching…')).toBeNull())
  })

  it('ctrl+K / meta+K focuses, Escape blurs and clears error', async () => {
    render(<SearchBox />)
    const box = screen.getByRole('searchbox')
    await userEvent.keyboard('{Control>}k{/Control}')
    expect(box).toHaveFocus()
    await userEvent.type(box, 'x{Enter}')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(box).not.toHaveFocus()
    expect(screen.queryByRole('alert')).toBeNull()
    await userEvent.keyboard('{Meta>}k{/Meta}')
    expect(box).toHaveFocus()
  })

  it('Mod+K leaves focus alone while a modal dialog is open', async () => {
    render(
      <>
        <SearchBox />
        <div role="dialog" aria-modal="true">
          <button>inside</button>
        </div>
      </>,
    )
    const inside = screen.getByRole('button', { name: 'inside' })
    inside.focus()
    await userEvent.keyboard('{Control>}k{/Control}')
    expect(inside).toHaveFocus()
  })
})
