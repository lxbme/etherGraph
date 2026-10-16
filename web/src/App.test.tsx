import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('渲染搜索框', () => {
    render(<App />)
    const box = screen.getByRole('searchbox')
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('地址 / 交易哈希 / ENS'))
  })
})
