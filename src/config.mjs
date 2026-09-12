// What the site watches, per chain.
//
// Every address here was verified on-chain before it was listed: Chainlink through the proxy's
// description() and aggregator(), Chronicle scribes through wat(), RedStone by decoding a real
// ValueUpdate from the adapter, Pyth through getPriceUnsafe on the feed id.

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

// Pyth feed ids are the same on every chain. Each of these returns exponent -8.
const PYTH_ID = {
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
};

export const CHAINS = {
  ethereum: {
    label: 'Ethereum',
    chainId: 1,
    blockSeconds: 12,
    rpcUrls: [process.env.RPC_URL, 'https://rpc.mevblocker.io', 'https://eth.llamarpc.com'].filter(Boolean),
    logChunk: 10000,
    hypersyncUrl: process.env.HYPERSYNC_URL || 'https://eth.hypersync.xyz/query',
    explorer: { name: 'Etherscan', tx: 'https://etherscan.io/tx/' },
    // RedStone writes every feed through one adapter; the feed id is inside the event.
    redstoneAdapter: '0xd72a6BA4a87DDB33e801b3f1c7750b2d0911fC6C',
    // Pyth is a pull oracle: one contract, and a price lands only when someone pushes it.
    pyth: '0x4305FB66699C3B2702D4d05CF36551390A4c69C6',
    // Gas is paid in ETH, priced from this Chainlink feed.
    ethUsdProxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    pairs: {
      ETH: { label: 'ETH / USD', chainlinkProxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', redstoneFeedId: 'ETH', chronicle: '0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E', pyth: PYTH_ID.ETH },
      BTC: { label: 'BTC / USD', chainlinkProxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', redstoneFeedId: 'BTC', chronicle: '0x24C392CDbF32Cf911B258981a66d5541d85269ce', pyth: PYTH_ID.BTC },
      // RedStone publishes the dollar stablecoins on Ethereum as USDC_V2 and USDT_V2.
      USDC: { label: 'USDC / USD', chainlinkProxy: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', redstoneFeedId: 'USDC_V2', chronicle: null, pyth: PYTH_ID.USDC },
      USDT: { label: 'USDT / USD', chainlinkProxy: '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', redstoneFeedId: 'USDT_V2', chronicle: null, pyth: PYTH_ID.USDT },
    },
  },
  base: {
    label: 'Base',
    chainId: 8453,
    blockSeconds: 2,
    // Public Base nodes rate limit hard, so several are tried in turn.
    rpcUrls: [process.env.BASE_RPC_URL, 'https://mainnet.base.org', 'https://1rpc.io/base', 'https://base.drpc.org'].filter(Boolean),
    // These nodes refuse wider eth_getLogs ranges.
    logChunk: 1800,
    hypersyncUrl: process.env.BASE_HYPERSYNC_URL || 'https://base.hypersync.xyz/query',
    explorer: { name: 'Basescan', tx: 'https://basescan.org/tx/' },
    redstoneAdapter: '0xb81131B6368b3F0a83af09dB4E39Ac23DA96C2Db',
    // Base runs two Pyth cores; this is the upgraded one, the current official deployment.
    pyth: '0xbC16aee60f64864882BC6C4E428e148Fc0E272F5',
    ethUsdProxy: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    pairs: {
      ETH: { label: 'ETH / USD', chainlinkProxy: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', redstoneFeedId: 'ETH', chronicle: '0x152598809fb59db55ca76f89a192fb23555531d8', pyth: PYTH_ID.ETH },
      // Chronicle publishes WBTC/USD and cbBTC/USD on Base, but no plain BTC/USD scribe.
      BTC: { label: 'BTC / USD', chainlinkProxy: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F', redstoneFeedId: 'BTC', chronicle: null, pyth: PYTH_ID.BTC },
    },
  },
};

export const CHAIN_IDS = Object.keys(CHAINS);
export const DEFAULT_CHAIN = 'ethereum';
export const pairsOf = (chain) => CHAINS[chain]?.pairs || {};

// Which oracles actually publish a given pair on a given chain.
export const oraclesFor = (chain, pair) => {
  const c = pairsOf(chain)[pair];
  return ORACLES.filter((o) => (o !== 'chronicle' || Boolean(c?.chronicle)) && (o !== 'pyth' || Boolean(c?.pyth)));
};

// Cost attribution. Chainlink and Chronicle write one feed per transaction, so the
// transaction's gas is that update's cost. RedStone and Pyth can write several feeds in
// one transaction, so their gas is split evenly across the feeds written in it.
export const COST_RULE = {
  chainlink: 'whole transaction',
  chronicle: 'whole transaction',
  redstone: 'transaction gas divided by feeds updated in it',
  pyth: 'transaction gas divided by feeds updated in it',
};
