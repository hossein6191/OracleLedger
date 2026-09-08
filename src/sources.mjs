// Where the data comes from.
//   HyperSync  — Envio's log archive. With a token, a month of logs is a few requests.
//   RPC        — a public JSON-RPC node. Used for live polling always, and for the
//                backfill when there is no token (10,000-block chunks).
// Both return logs in one normalised shape so the rest of the code does not care.

const RPC_URL = process.env.RPC_URL || 'https://rpc.mevblocker.io';
const HYPERSYNC_URL = 'https://eth.hypersync.xyz/query';
const TOKEN = process.env.HYPERSYNC_TOKEN || '';

const hex = (n) => '0x' + Number(n).toString(16);

export async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

export async function rpcBatch(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 40) {
    const slice = calls.slice(i, i + 40).map((c, k) => ({ jsonrpc: '2.0', id: k, ...c }));
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slice) });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('batch unsupported');
    out.push(...j.sort((a, b) => a.id - b.id).map((x) => x.result));
  }
  return out;
}

export const blockNumber = async () => parseInt(await rpc('eth_blockNumber', []), 16);

export async function ethCall(to, data) { return rpc('eth_call', [{ to, data }, 'latest']); }

// Chainlink proxy -> current aggregator (the contract that actually emits events).
export async function aggregatorOf(proxy) {
  const r = await ethCall(proxy, '0x245a7bfc');
  return '0x' + r.slice(26).toLowerCase();
}

// Current ETH/USD from Chainlink, used only to price gas in dollars.
export async function ethUsd() {
  const r = await ethCall('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', '0x50d25bcd');
  return Number(BigInt(r)) / 1e8;
}

function normaliseRpcLog(l) {
  return {
    blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16),
    transactionHash: l.transactionHash, address: l.address.toLowerCase(), topics: l.topics, data: l.data,
  };
}

export async function rpcLogs(addresses, topic0s, from, to) {
  const out = [];
  for (let start = from; start <= to; start += 10000) {
    const end = Math.min(start + 9999, to);
    const filter = { address: addresses, fromBlock: hex(start), toBlock: hex(end) };
    if (topic0s?.length) filter.topics = [topic0s];
    const logs = await rpc('eth_getLogs', [filter]);
    out.push(...logs.map(normaliseRpcLog));
  }
  return { logs: out, txs: new Map() };
}

export const hasHyperSync = () => Boolean(TOKEN);

export async function hypersyncLogs(addresses, topic0s, from, to) {
  const logs = []; const txs = new Map();
  let next = from;
  for (let page = 0; page < 200 && next <= to; page++) {
    const body = {
      from_block: next, to_block: to + 1,
      logs: [{ address: addresses, ...(topic0s?.length ? { topics: [topic0s] } : {}) }],
      field_selection: {
        log: ['block_number', 'log_index', 'transaction_hash', 'address', 'data', 'topic0', 'topic1', 'topic2', 'topic3'],
        transaction: ['hash', 'gas_used', 'effective_gas_price'],
      },
    };
    const r = await fetch(HYPERSYNC_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    if (r.status !== 200) throw new Error(`hypersync ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const chunk of j.data || []) {
      for (const l of chunk.logs || []) logs.push({
        blockNumber: l.block_number, logIndex: l.log_index, transactionHash: l.transaction_hash,
        address: l.address.toLowerCase(), data: l.data,
        topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter((t) => t != null),
      });
      for (const t of chunk.transactions || []) if (t.gas_used != null && t.effective_gas_price != null) txs.set(t.hash, { gasUsed: BigInt(t.gas_used), effectiveGasPrice: BigInt(t.effective_gas_price) });
    }
    if (!j.next_block || j.next_block <= next) break;
    next = j.next_block;
  }
  return { logs, txs };
}

// Fill in gas for any transaction HyperSync did not give us (or all of them on the RPC path).
export async function receiptsFor(hashes) {
  const results = await rpcBatch(hashes.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
  const m = new Map();
  hashes.forEach((h, i) => { const r = results[i]; if (r) m.set(h, { gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice) }); });
  return m;
}

export async function fetchLogs(addresses, topic0s, from, to) {
  if (hasHyperSync()) {
    try { return await hypersyncLogs(addresses, topic0s, from, to); }
    catch (e) { console.warn('[hypersync] falling back to rpc:', e.message); }
  }
  return rpcLogs(addresses, topic0s, from, to);
}
