import { act, render, screen } from '@testing-library/react'
import { useLocale } from './i18n'
import { App } from './App'
import { clearExport, requestExport } from './workspace/fileRequest'
import { useAuth } from './auth/useMe'
import { useTabs } from './shell/tabs'
import { useUi } from './panels/uiStore'

// Cytoscape cannot render in jsdom and the SSE stream is covered by api/useEvents.test.tsx.
vi.mock('./graph/CytoscapeView', () => ({ CytoscapeView: () => <div data-testid="cy" /> }))
vi.mock('./api/useEvents', () => ({ useEvents: () => {} }))

// Signed in: the login gate is covered by auth/AuthGate.test.tsx.
beforeEach(() =>
  useAuth.setState({
    status: 'authenticated',
    me: { address: '0xa0cf798816d4b9b9866b5330eea46a18382f251e', is_admin: false, quota: { used: 0, limit: 5000, reset_at: '2026-10-20T00:00:00Z' } },
    reason: null,
  }),
)

describe('App', () => {
  it('渲染搜索框', () => {
    render(<App />)
    const box = screen.getByRole('searchbox')
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('address / tx hash / ENS'))
  })
})

describe('App language switch', () => {
  afterEach(() => act(() => useLocale.getState().setLocale('en')))

  it('re-translates the workspace status in the status bar', () => {
    render(<App />)
    expect(screen.getByText('Workspace: Not saved')).toBeInTheDocument()
    act(() => useLocale.getState().setLocale('zh'))
    expect(screen.getByText('画布: 未保存')).toBeInTheDocument()
  })
})

describe('App files', () => {
  /** A drag event on the window carrying `files`. */
  function dragEvent(type: string, files: File[]) {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } })
    return e
  }

  it('a file dropped on the window is imported; a bad one shows the reason', async () => {
    render(<App />)
    const over = dragEvent('dragover', [])
    act(() => void window.dispatchEvent(over))
    expect(over.defaultPrevented).toBe(true)
    const drop = dragEvent('drop', [new File(['not json'], 'x.json')])
    act(() => void window.dispatchEvent(drop))
    expect(drop.defaultPrevented).toBe(true)
    expect(await screen.findByText('Cannot import the file: The file is not valid JSON')).toBeInTheDocument()
  })

  it('a canvas export request opens the export file dialog', () => {
    render(<App />)
    act(() => requestExport('workspace'))
    expect(screen.getByRole('dialog', { name: 'Export file' })).toBeInTheDocument()
    act(() => clearExport())
  })
})

describe('App tabs', () => {
  afterEach(() => act(() => useTabs.getState().closeAllTx()))

  it('the right panel is absent on the data tab', () => {
    useUi.setState({ detailOpen: true })
    const { container } = render(<App />)
    expect(container.querySelector('.main__right')).not.toBeNull()
    act(() => useTabs.getState().activate('data'))
    expect(container.querySelector('.main__right')).toBeNull()
    expect(container.querySelector('.main__graph')).toHaveAttribute('hidden')
    expect(container.querySelector('.main__data')).not.toBeNull()
    act(() => useTabs.getState().activate('graph'))
    expect(container.querySelector('.main__right')).not.toBeNull()
    expect(container.querySelector('.main__data')).toBeNull()
  })
})
