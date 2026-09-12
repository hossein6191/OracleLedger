# Oracle Ledger

Every on-chain oracle update for a pair, side by side: Chainlink, Chronicle,
RedStone and Pyth, on Ethereum and on Base, with a month of history, refreshed
every 30 seconds.

**https://oracleledger.up.railway.app**

Each point on the chart is one write to the oracle's own contract, read from the
event it emitted. Nothing is sampled or estimated, and no oracle's API is used.
Under the chart, per oracle and per window: how many times it wrote, the largest
move between two consecutive writes, and what that gas cost in dollars.
Double-click a point to open its transaction on Etherscan.

## Chains and pairs

| chain | pair | Chainlink | Chronicle | RedStone | Pyth |
| --- | --- | --- | --- | --- | --- |
| Ethereum | ETH / USD | yes | yes | yes | yes |
| Ethereum | BTC / USD | yes | yes | yes | yes |
| Ethereum | USDC / USD | yes | not tracked | yes | yes |
| Ethereum | USDT / USD | yes | not tracked | yes | yes |
| Base | ETH / USD | yes | yes | yes | yes |
| Base | BTC / USD | yes | not tracked | yes | yes |

*Not tracked* means no contract for that oracle and pair was verified on that
chain, not that none exists. On Base, Chronicle publishes WBTC / USD and
cbBTC / USD but no plain BTC / USD.

## Pyth, and why Base is here

Pyth is a pull oracle. A Pyth price lands on a chain only when someone pays to
push it, so the chart shows exactly as many Pyth points as there were pushes. On
Ethereum mainnet that is very few: ETH / USD is written a handful of times a
month and BTC / USD not at all, which is why Base is here too, where Pyth writes
both pairs every day. When no Pyth write for a pair is in the history, its card
shows the price stored in the Pyth contract (`getPriceUnsafe`) and how old it is,
and any value with no write for more than 36 hours is marked stale in the tooltip
and left out of the median.

## Two views

**Price**: what each oracle wrote, on one axis. The lines sit on top of each
other, because independent oracles arrive at the same price; that agreement is
the point.

**vs median**: each write as its distance, in basis points, from the median of the
oracles' latest values at that moment. This is where the lines come apart: it
shows which oracle moved first, which lagged, and by how much.

## How the numbers are made

| number | how |
| --- | --- |
| updates | count of update events in the window |
| max deviation | largest `|v[i] - v[i-1]| / v[i-1]` between consecutive updates of the same oracle |
| gas cost | `gasUsed × effectiveGasPrice` of the update transaction, in USD at the Chainlink ETH/USD rate when the update was recorded |
| RedStone and Pyth gas | both can write several feeds in one transaction, so the transaction's gas is split evenly across the feeds written in it |

Every contract was verified on-chain before being listed: Chainlink through the
proxy's `description()` and `aggregator()`; RedStone's multi-feed adapter, where
the feed id is inside the event (USDC and USDT are published as `USDC_V2` and
`USDT_V2`); Chronicle scribes whose `wat()` returns the pair name; and the Pyth
contract, where each feed id from Pyth's public feed list returns a price from
`getPriceUnsafe`.

Independent. Not affiliated with Chainlink, Chronicle, RedStone or Pyth.
