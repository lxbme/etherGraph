export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1 className="topbar__title">etherGraph</h1>
        <input
          type="search"
          className="topbar__search"
          placeholder="搜索 地址 / 交易哈希 / ENS"
          aria-label="搜索"
        />
      </header>
    </div>
  )
}
