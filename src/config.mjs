// What we watch, and how to read each oracle's update event.
// Every address here was verified on-chain before being written down:
// Chainlink via proxy.aggregator(), RedStone via feed.getPriceFeedAdapter(),
// Chronicle via scribe.wat() returning the pair name.

export const CHAIN = { id: 1, name: 'Ethereum', blockSeconds: 12 };

export const PAIRS = {
  ETH: {
    label: 'ETH / USD',
    chainlinkProxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    redstoneFeedId: 'ETH',
    chronicle: '0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E',
    pyth: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  },
  BTC: {
    label: 'BTC / USD',
    chainlinkProxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    redstoneFeedId: 'BTC',
    chronicle: '0x24C392CDbF32Cf911B258981a66d5541d85269ce',
    pyth: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  },
  // RedStone publishes the dollar stablecoins on Ethereum as USDC_V2 and USDT_V2.
  USDC: {
    label: 'USDC / USD',
    chainlinkProxy: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    redstoneFeedId: 'USDC_V2',
    chronicle: null,
    pyth: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  },
  USDT: {
    label: 'USDT / USD',
    chainlinkProxy: '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
    redstoneFeedId: 'USDT_V2',
    chronicle: null,
    pyth: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
  },
};

// Which oracles actually publish a given pair here.
export const oraclesFor = (pair) => ORACLES.filter((o) => (o !== 'chronicle' || Boolean(PAIRS[pair]?.chronicle)) && (o !== 'pyth' || Boolean(PAIRS[pair]?.pyth)));

// RedStone writes every feed through one adapter; the feed id is inside the event.
export const REDSTONE_ADAPTER = '0xd72a6BA4a87DDB33e801b3f1c7750b2d0911fC6C';

// Pyth is a pull oracle: one contract, and a price lands only when someone pushes it.
// The feed id is the indexed topic. Every feed listed here has exponent -8 (checked
// with getPriceUnsafe on the contract).
export const PYTH = '0x4305FB66699C3B2702D4d05CF36551390A4c69C6';

export const ORACLES = ['chainlink', 'chronicle', 'redstone', 'pyth'];

export const EVENTS = {
  // Chainlink: current and roundId are indexed; updatedAt is in data.
  chainlinkAnswerUpdated: 'AnswerUpdated(int256,uint256,uint256)',
  // RedStone: nothing indexed; data = [value (8 decimals), feedId, updatedAt].
  redstoneValueUpdate: 'ValueUpdate(uint256,bytes32,uint256)',
  // Chronicle Scribe: caller indexed; data = [val (18 decimals), age].
  chroniclePoked: 'Poked(address,uint128,uint32)',
  // Chronicle ScribeOptimistic: optimistic write, finalised later; pokeData at the end.
  chronicleOpPoked: 'OpPoked(address,address,(bytes32,address,bytes),(uint128,uint32))',
  // Pyth: feed id indexed; data = [publishTime, price (int64, expo -8), conf].
  pythPriceFeedUpdate: 'PriceFeedUpdate(bytes32,uint64,int64,uint64)',
};

// Cost attribution. Chainlink and Chronicle write one feed per transaction, so the
// transaction's gas is that update's cost. RedStone writes several feeds in one
// transaction (about 2.5 on average), so its gas is split evenly across the feeds
// updated in that transaction. The page says so next to the number.
export const COST_RULE = {
  chainlink: 'whole transaction',
  chronicle: 'whole transaction',
  redstone: 'transaction gas divided by feeds updated in it',
  pyth: 'transaction gas divided by feeds updated in it',
};
