import { act, render, screen } from '@testing-library/react'
import { useLocale } from './i18n'
import { App } from './App'

// Cytoscape cannot render in jsdom and the SSE stream is covered by api/useEvents.test.tsx.
vi.mock('./graph/CytoscapeView', () => ({ CytoscapeView: () => <div data-testid="cy" /> }))
vi.mock('./api/useEvents', () => ({ useEvents: () => {} }))

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
