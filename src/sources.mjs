// Where the data comes from, per chain.
//   HyperSync  — Envio's log archive. With a token, a month of logs is a few requests.
//   RPC        — a public JSON-RPC node. Used for live polling always, and for the
//                backfill when there is no token (in chunks the node will accept).
// Both return logs in one normalised shape so the rest of the code does not care.

import { CHAINS } from './config.mjs';

const TOKEN = process.env.HYPERSYNC_TOKEN || '';
const hex = (n) => '0x' + Number(n).toString(16);
const cfg = (chain) => {
  const c = CHAINS[chain];
  if (!c) throw new Error(`unknown chain ${chain}`);
  return c;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (text) => /rate limit|too many|429|timeout|busy|capacity|-32016|-32005/i.test(text);

// Public nodes rate limit and go down. Each chain lists several; a busy answer moves to
// the next one after a pause, a real error (a revert, a bad request) is thrown straight away.
export async function rpc(chain, method, params) {
  const urls = cfg(chain).rpcUrls;
  let last;
  for (let attempt = 0; attempt < urls.length * 2; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!r.ok) { last = new Error(`${chain} ${method}: http ${r.status}`); if (!busy(String(r.status))) throw last; await sleep(400 * (attempt + 1)); continue; }
      const j = await r.json();
      if (j.error) {
        const msg = JSON.stringify(j.error);
        last = new Error(`${chain} ${method}: ${msg.slice(0, 160)}`);
        if (!busy(msg)) throw last;
        await sleep(400 * (attempt + 1));
        continue;
      }
      return j.result;
    } catch (e) {
      if (e === last) throw e;
      last = e; await sleep(300 * (attempt + 1));
    }
  }
  throw last;
}

export async function rpcBatch(chain, calls) {
  const urls = cfg(chain).rpcUrls;
  const out = [];
  for (let i = 0; i < calls.length; i += 40) {
    const slice = calls.slice(i, i + 40).map((c, k) => ({ jsonrpc: '2.0', id: k, ...c }));
    let done = false, last;
    for (let attempt = 0; attempt < urls.length * 2 && !done; attempt++) {
      try {
        const r = await fetch(urls[attempt % urls.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slice) });
        const j = await r.json();
        if (!Array.isArray(j)) throw new Error(`batch unsupported: ${JSON.stringify(j).slice(0, 120)}`);
        out.push(...j.sort((a, b) => a.id - b.id).map((x) => x.result));
        done = true;
      } catch (e) { last = e; await sleep(400 * (attempt + 1)); }
    }
    if (!done) throw last;
  }
  return out;
}

export const blockNumber = async (chain) => parseInt(await rpc(chain, 'eth_blockNumber', []), 16);

export async function ethCall(chain, to, data) { return rpc(chain, 'eth_call', [{ to, data }, 'latest']); }

// Chainlink proxy -> current aggregator (the contract that actually emits events).
export async function aggregatorOf(chain, proxy) {
  const r = await ethCall(chain, proxy, '0x245a7bfc');
  return '0x' + r.slice(26).toLowerCase();
}

// Current ETH/USD from that chain's Chainlink feed, used only to price gas in dollars.
export async function ethUsd(chain) {
  const r = await ethCall(chain, cfg(chain).ethUsdProxy, '0x50d25bcd');
  return Number(BigInt(r)) / 1e8;
}

function normaliseRpcLog(l) {
  return {
    blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16),
    transactionHash: l.transactionHash, address: l.address.toLowerCase(), topics: l.topics, data: l.data,
  };
}

// Nodes disagree about how many blocks one eth_getLogs may cover, and they say so in the
// error. Rather than guess per node, start at the chain's chunk size and shrink on refusal.
export async function rpcLogs(chain, addresses, topic0s, from, to) {
  const out = [];
  let step = cfg(chain).logChunk || 10000;
  let start = from;
  while (start <= to) {
    const end = Math.min(start + step - 1, to);
    const filter = { address: addresses, fromBlock: hex(start), toBlock: hex(end) };
    if (topic0s?.length) filter.topics = [topic0s];
    try {
      const logs = await rpc(chain, 'eth_getLogs', [filter]);
      out.push(...logs.map(normaliseRpcLog));
      start = end + 1;
    } catch (e) {
      if (step > 50 && /limit|range|too large|exceed|too many/i.test(e.message)) { step = Math.max(50, Math.floor(step / 4)); continue; }
      throw e;
    }
  }
  return { logs: out, txs: new Map() };
}

export const hasHyperSync = () => Boolean(TOKEN);

// HyperSync's free package allows 30 requests a minute across every chain, so the pace
// below is shared: a slower backfill beats a rejected one.
const HS_MAX_PER_MIN = Number(process.env.HYPERSYNC_MAX_RPM || 24);
const hsStamps = [];
async function paceHyperSync() {
  const now = Date.now();
  while (hsStamps.length && now - hsStamps[0] > 60000) hsStamps.shift();
  if (hsStamps.length >= HS_MAX_PER_MIN) {
    const wait = 60000 - (now - hsStamps[0]) + 250;
    await new Promise((r) => setTimeout(r, wait));
    return paceHyperSync();
  }
  hsStamps.push(Date.now());
}

export async function hypersyncLogs(chain, addresses, topic0s, from, to) {
  const logs = []; const txs = new Map();
  const url = cfg(chain).hypersyncUrl;
  let next = from;
  for (let page = 0; page < 2000 && next <= to; page++) {
    await paceHyperSync();
    const body = {
      from_block: next, to_block: to + 1,
      logs: [{ address: addresses, ...(topic0s?.length ? { topics: [topic0s] } : {}) }],
      field_selection: {
        log: ['block_number', 'log_index', 'transaction_hash', 'address', 'data', 'topic0', 'topic1', 'topic2', 'topic3'],
        transaction: ['hash', 'gas_used', 'effective_gas_price'],
      },
    };
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    if (r.status !== 200) throw new Error(`hypersync ${chain} ${r.status}: ${(await r.text()).slice(0, 120)}`);
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
export async function receiptsFor(chain, hashes) {
  const results = await rpcBatch(chain, hashes.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
  const m = new Map();
  hashes.forEach((h, i) => { const r = results[i]; if (r) m.set(h, { gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice) }); });
  return m;
}

export async function fetchLogs(chain, addresses, topic0s, from, to) {
  if (hasHyperSync()) {
    try { return await hypersyncLogs(chain, addresses, topic0s, from, to); }
    catch (e) { console.warn(`[hypersync] ${chain}: falling back to rpc:`, e.message); }
  }
  return rpcLogs(chain, addresses, topic0s, from, to);
}
