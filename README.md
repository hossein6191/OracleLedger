# Oracle Ledger

Every on-chain oracle update for a pair, side by side — Chainlink, Chronicle and
RedStone on Ethereum — with a month of history, refreshed every 30 seconds.

Each point on the chart is one write to the oracle's own contract, read from the
event it emitted. Nothing is sampled or estimated. Under the chart, per oracle and
per window: how many times it wrote, the largest move between two consecutive
writes, and what that gas cost in dollars.

## How the numbers are made

| number | how |
| --- | --- |
| updates | count of update events in the window |
| max deviation | largest `|v[i] - v[i-1]| / v[i-1]` between consecutive updates of the same oracle |
| gas cost | `gasUsed × effectiveGasPrice` of the update transaction, priced at the current Chainlink ETH/USD |
| RedStone gas | RedStone writes several feeds in one transaction (about 2.5 on average), so its transaction gas is split evenly across the feeds written in that transaction |

Contracts (all verified on-chain before being written down): Chainlink through the
proxy's `aggregator()`, RedStone's multi-feed adapter (the feed id is inside the
event), Chronicle scribes whose `wat()` returns the pair name.

## Run

```bash
npm install
cp .env.example .env    # optional: add HYPERSYNC_TOKEN for a fast backfill
npm start               # http://localhost:3000
```

Without a HyperSync token the 30-day backfill runs over the public RPC in
10,000-block chunks and takes a few minutes. With one it takes seconds. Live
polling always uses the RPC.

## Deploy (Railway)

New service from this repo. `npm start` is detected. Set `HYPERSYNC_TOKEN` in the
service variables. The disk may be ephemeral; if the snapshot is lost the service
simply backfills again on boot.

## Adding a pair

Add an entry to `PAIRS` in `src/config.mjs` with the Chainlink proxy, the RedStone
feed id and the Chronicle scribe. Verify the scribe first — call `wat()` and check it
returns the pair.

Not affiliated with Chainlink, Chronicle or RedStone.
