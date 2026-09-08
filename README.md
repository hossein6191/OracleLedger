# Oracle Ledger

Every on-chain oracle update for a pair, side by side — Chainlink, Chronicle and
RedStone on Ethereum — with a month of history, refreshed every 30 seconds.

**https://oracleledger.up.railway.app**

Each point on the chart is one write to the oracle's own contract, read from the
event it emitted. Nothing is sampled or estimated. Under the chart, per oracle and
per window: how many times it wrote, the largest move between two consecutive
writes, and what that gas cost in dollars.

Two pairs, ETH / USD and BTC / USD: the ones all three oracles publish on
Ethereum, each read from a contract verified on-chain.

## Two views

**Price** — what each oracle wrote, on one axis. The lines sit on top of each
other, because three independent oracles arrive at the same price; that agreement
is the point.

**vs median** — each write as its distance, in basis points, from the median of
the oracles' latest values at that moment. This is where the lines come apart: it
shows which oracle moved first, which lagged, and by how much.

## How the numbers are made

| number | how |
| --- | --- |
| updates | count of update events in the window |
| max deviation | largest `|v[i] - v[i-1]| / v[i-1]` between consecutive updates of the same oracle |
| gas cost | `gasUsed × effectiveGasPrice` of the update transaction, priced at the current Chainlink ETH/USD |
| RedStone gas | RedStone writes several feeds in one transaction (about 2.5 on average), so its transaction gas is split evenly across the feeds written in that transaction |

Every contract was verified on-chain before being listed: Chainlink through the
proxy's `aggregator()`, RedStone's multi-feed adapter (the feed id is inside the
event), Chronicle scribes whose `wat()` returns the pair name.

Independent. Not affiliated with Chainlink, Chronicle or RedStone.
