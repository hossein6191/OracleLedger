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
  },
  BTC: {
    label: 'BTC / USD',
    chainlinkProxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    redstoneFeedId: 'BTC',
    chronicle: '0x24C392CDbF32Cf911B258981a66d5541d85269ce',
  },
};

// RedStone writes every feed through one adapter; the feed id is inside the event.
export const REDSTONE_ADAPTER = '0xd72a6BA4a87DDB33e801b3f1c7750b2d0911fC6C';

export const ORACLES = ['chainlink', 'chronicle', 'redstone'];

export const EVENTS = {
  // Chainlink: current and roundId are indexed; updatedAt is in data.
  chainlinkAnswerUpdated: 'AnswerUpdated(int256,uint256,uint256)',
  // RedStone: nothing indexed; data = [value (8 decimals), feedId, updatedAt].
  redstoneValueUpdate: 'ValueUpdate(uint256,bytes32,uint256)',
  // Chronicle Scribe: caller indexed; data = [val (18 decimals), age].
  chroniclePoked: 'Poked(address,uint128,uint32)',
  // Chronicle ScribeOptimistic: optimistic write, finalised later; pokeData at the end.
  chronicleOpPoked: 'OpPoked(address,address,(bytes32,address,bytes),(uint128,uint32))',
};

// Cost attribution. Chainlink and Chronicle write one feed per transaction, so the
// transaction's gas is that update's cost. RedStone writes several feeds in one
// transaction (about 2.5 on average), so its gas is split evenly across the feeds
// updated in that transaction. The page says so next to the number.
export const COST_RULE = {
  chainlink: 'whole transaction',
  chronicle: 'whole transaction',
  redstone: 'transaction gas divided by feeds updated in it',
};
