<p align="center">
  <img src="docs/images/logo-light.png#gh-light-mode-only" alt="etherGraph" height="56">
  <img src="docs/images/logo-dark.png#gh-dark-mode-only" alt="etherGraph" height="56">
</p>

<p align="center">
  Explore Ethereum as a graph — follow funds between addresses, contracts and tokens.
</p>

<p align="center">
  <img src="docs/images/screenshot-light.png#gh-light-mode-only" alt="etherGraph address graph" width="900">
  <img src="docs/images/screenshot-dark.png#gh-dark-mode-only" alt="etherGraph address graph" width="900">
</p>

## Features

- **Address graph** — start from an address, ENS name or transaction hash and expand counterparties in budgeted batches, so the canvas never floods. Every expansion can be undone or cancelled.
- **Transaction view** — a fund-flow graph with the fee breakdown, decoded input, token transfers, internal calls, logs and raw JSON.
- **Labels** — your own labels, 13 categories (CEX, DEX, mixer, sanctioned, …) and the open [eth-labels](https://github.com/dawsbot/eth-labels) dataset.
- **Free-tier friendly** — runs on the free Etherscan API with a rate-limited job queue, a local Postgres cache and live progress.
- **Box selection, legend and help** built in; English and Chinese; light and dark themes.

## Quick start

Requires Rust 1.94+, [Bun](https://bun.sh) 1.3+, Docker, and an [Etherscan API key](https://etherscan.io/apis) (the free tier works).

```sh
docker compose up -d                  # Postgres on localhost:54329
cp config.example.toml config.toml    # then set etherscan.api_key
(cd web && bun install && bun run build)
cargo run --release -p eg-server -- serve
```

Open <http://127.0.0.1:8080>.

### Address labels (optional)

```sh
mkdir -p data/eth-labels
curl -L -o data/eth-labels/accounts.csv \
  https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/accounts.csv
cargo run --release -p eg-server -- import-labels --format eth-labels --csv data/eth-labels/accounts.csv
```

## Development

```sh
cargo run -p eg-server -- serve      # API on :8080
cd web && bun run dev                # Vite dev server, /api proxied to :8080
```

Tests: `cargo test --workspace` (needs the Postgres above), `bun run test` and `bun run e2e` in `web/`.

| Path | |
|---|---|
| `crates/eg-server` | HTTP API, server-sent events, CLI |
| `crates/eg-ingest` | Job queue: sync, transaction fetch, metadata |
| `crates/eg-etherscan` | Etherscan client with rate limiting |
| `crates/eg-decode` | ABI, ENS and token decoding |
| `crates/eg-store` | Postgres storage and migrations |
| `crates/eg-core` | Shared types |
| `web/` | React + Cytoscape front end |
| `docs/brand/` | Brand guidelines |

## License

[MIT](LICENSE) © YUHAN LI
