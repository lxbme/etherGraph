<p align="center">
  <img src="docs/images/logo-light.png#gh-light-mode-only" alt="etherGraph" height="56">
  <img src="docs/images/logo-dark.png#gh-dark-mode-only" alt="etherGraph" height="56">
</p>

<p align="center">
  Explore Ethereum as a graph — follow funds between addresses, contracts and tokens, and open any transaction down to its calls.
</p>

<p align="center">
  <img src="docs/images/screenshot-light.png#gh-light-mode-only" alt="etherGraph address graph" width="900">
  <img src="docs/images/screenshot-dark.png#gh-dark-mode-only" alt="etherGraph address graph" width="900">
</p>

## Features

- **Address graph** — start from an address, ENS name or transaction hash and expand counterparties in budgeted batches, so the canvas never floods. Each expansion shows how many nodes and API calls it will cost before it runs, and can be undone or cancelled. Hidden neighbours wait in draggable "+N more" nodes; Re-layout spreads the graph out again.
- **Transaction view** — a fund-flow graph with a summary of the token transfers, the fee breakdown, decoded input, token transfers, internal calls, logs and raw JSON. EIP-7702 authorizations and delegations are drawn as well.
- **Call tree** — the full call trace as a linked call graph and tree. Calls through proxies are decoded with the implementation's ABI, ERC-20 amounts in arguments show their decimals, and read-only calls stay hidden until you ask for them.
- **Tokens you can trust** — tokens from the Uniswap and CoinGecko lists are marked listed; tokens impersonating a listed one, and known scams, are flagged wherever they appear. Nodes say when they are ERC-20 tokens or proxies.
- **Labels** — your own labels, 13 categories (CEX, DEX, mixer, sanctioned, …) and the open [eth-labels](https://github.com/dawsbot/eth-labels) dataset.
- **Workspaces and files** — save tabs with their layout, export any view or the whole workspace as a snapshot file for someone else to open, or export an image (PNG, transparent PNG, SVG).
- **Multi-user** — sign in with an Ethereum wallet. Each user has their own workspaces, labels and a daily API quota; admins manage the whitelist, quotas and sessions with signed actions and an audit log.
- **Free-tier friendly** — runs on the free Etherscan and Blockscout APIs with a rate-limited job queue, a local Postgres cache and live progress.
- Box selection, legend and help built in; times in UTC with local time on hover; English and Chinese; light and dark themes.

<p align="center">
  <img src="docs/images/tx-flow-light.png#gh-light-mode-only" alt="Transaction fund flow" width="900">
  <img src="docs/images/tx-flow-dark.png#gh-dark-mode-only" alt="Transaction fund flow" width="900">
</p>

<p align="center">
  <img src="docs/images/call-tree-light.png#gh-light-mode-only" alt="Call tree" width="900">
  <img src="docs/images/call-tree-dark.png#gh-dark-mode-only" alt="Call tree" width="900">
</p>

## Quick start

Requires Rust 1.94+, [Bun](https://bun.sh) 1.3+, Docker, an [Etherscan API key](https://etherscan.io/apis) (the free tier works) and a browser wallet such as MetaMask.

```sh
docker compose up -d                  # Postgres on localhost:54329
cp config.example.toml config.toml    # then set etherscan.api_key and auth.admins
(cd web && bun install && bun run build)
cargo run --release -p eg-server -- serve
```

Put your wallet address in `auth.admins` so you can sign in, then open <http://127.0.0.1:8080> — the address must match `auth.public_origin`. From the admin panel you can whitelist other wallets or open registration.

### Address labels and token lists (optional)

```sh
mkdir -p data/eth-labels data/tokens
curl -L -o data/eth-labels/accounts.csv \
  https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/accounts.csv
cargo run --release -p eg-server -- import-labels --format eth-labels --csv data/eth-labels/accounts.csv

curl -L -o data/tokens/uniswap-default.json https://tokens.uniswap.org
curl -L -o data/tokens/coingecko.json https://tokens.coingecko.com/uniswap/all.json
curl -L -o data/tokens/eth-labels-tokens.csv \
  https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/tokens.csv
cargo run --release -p eg-server -- import-tokens --format uniswap --file data/tokens/uniswap-default.json
cargo run --release -p eg-server -- import-tokens --format coingecko --file data/tokens/coingecko.json
cargo run --release -p eg-server -- import-tokens --format eth-labels --file data/tokens/eth-labels-tokens.csv
```

## Development

```sh
cargo run -p eg-server -- serve      # API on :8080
cd web && bun run dev                # Vite dev server, /api proxied to :8080
```

Tests: `cargo test --workspace` (needs the Postgres above), `bun run test` and `bun run e2e` in `web/`.

| Path | |
|---|---|
| `crates/eg-server` | HTTP API, wallet sign-in, server-sent events, CLI |
| `crates/eg-ingest` | Job queue: sync, transaction fetch, call traces, metadata |
| `crates/eg-etherscan` | Etherscan client with rate limiting |
| `crates/eg-blockscout` | Blockscout client for call traces |
| `crates/eg-decode` | ABI, ENS and token decoding |
| `crates/eg-store` | Postgres storage and migrations |
| `crates/eg-core` | Shared types |
| `web/` | React + Cytoscape front end |
| `docs/brand/` | Brand guidelines |

## License

[MIT](LICENSE) © YUHAN LI
