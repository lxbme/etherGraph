import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/endpoints'
import { ApiError } from '../api/errors'
import { useGraph } from '../graph/store'
import { useTabs } from '../shell/tabs'
import { SearchBox } from './SearchBox'

const A = '0x' + 'ab'.repeat(20)
const H = '0x' + 'cd'.repeat(32)

beforeEach(() => {
  vi.restoreAllMocks()
  useGraph.getState().reset()
  useTabs.setState({ tabs: [{ id: 'graph' }], active: 'graph' })
})

describe('SearchBox', () => {
  it('enter on address adds a center, selects it and triggers one auto sync', async () => {
    vi.spyOn(api, 'search').mockResolvedValue({ kind: 'address', value: A, resolved_address: null })
    const addr = vi.spyOn(api, 'address').mockResolvedValue({} as never)
    render(<SearchBox />)
    const box = screen.getByRole('searchbox')
    await userEvent.type(box, `${A}{Enter}`)
    await waitFor(() => expect(useGraph.getState().centers).toEqual([A]))
    expect(useGraph.getState().selection).toEqual({ kind: 'node', address: A })
    expect(useTabs.getState().active).toBe('graph')
    expect(addr).toHaveBeenCalledTimes(1)
    expect(addr).toHaveBeenCalledWith(A, { sync: 'auto' })
    expect(box).toHaveValue('')
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
    expect(await screen.findByText('未找到该名称或地址')).toBeInTheDocument()
    expect(useGraph.getState().centers).toEqual([])
  })

  it('invalid input shows inline hint without calling api', async () => {
    const s = vi.spyOn(api, 'search')
    render(<SearchBox />)
    await userEvent.type(screen.getByRole('searchbox'), 'hello{Enter}')
    expect(screen.getByText('请输入地址（0x+40位）、交易哈希（0x+64位）或 ENS 名称')).toBeInTheDocument()
    expect(s).not.toHaveBeenCalled()
  })

  it('disables re-submit while in flight', async () => {
    let resolve!: (v: never) => void
    const s = vi.spyOn(api, 'search').mockReturnValue(new Promise((r) => { resolve = r as never }))
    render(<SearchBox />)
    const box = screen.getByRole('searchbox')
    await userEvent.type(box, `${H}{Enter}`)
    expect(screen.getByText('搜索中…')).toBeInTheDocument()
    await userEvent.type(box, '{Enter}')
    expect(s).toHaveBeenCalledTimes(1)
    resolve({ kind: 'tx', value: H, resolved_address: null } as never)
    await waitFor(() => expect(screen.queryByText('搜索中…')).toBeNull())
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
})
