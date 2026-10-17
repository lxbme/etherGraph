import { render, screen } from '@testing-library/react'
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
