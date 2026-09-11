import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAIRS, ORACLES, REDSTONE_ADAPTER, COST_RULE, CHAIN, oraclesFor } from './src/config.mjs';
import { TOPIC, feedIdBytes32, decodeChainlink, decodeRedstone, decodeChronicle } from './src/decode.mjs';
import { blockNumber, aggregatorOf, ethUsd, fetchLogs, rpcLogs, receiptsFor, hasHyperSync } from './src/sources.mjs';
import { state, addUpdates, save, load } from './src/store.mjs';
import { statsFor, WINDOWS } from './src/stats.mjs';

// Minimal .env support for local runs; hosts inject real env vars.
if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);
const POLL_MS = Number(process.env.POLL_SECONDS || 30) * 1000;
const PORT = Number(process.env.PORT || 3000);

const aggregators = {};       // pair -> chainlink aggregator address
const feedIdToPair = Object.fromEntries(Object.entries(PAIRS).map(([p, c]) => [feedIdBytes32(c.redstoneFeedId), p]));
const chronicleToPair = Object.fromEntries(Object.entries(PAIRS).filter(([, c]) => c.chronicle).map(([p, c]) => [c.chronicle.toLowerCase(), p]));

async function resolveAggregators() {
  for (const [p, c] of Object.entries(PAIRS)) aggregators[p] = await aggregatorOf(c.chainlinkProxy);
}

// One pass over a block range: fetch every relevant log, price the gas, store.
async function ingest(from, to, useArchive) {
  const get = useArchive ? fetchLogs : rpcLogs;
  const clAddrs = Object.values(aggregators);
  const [cl, rs, ch] = await Promise.all([
    get(clAddrs, [TOPIC.chainlinkAnswerUpdated], from, to),
    get([REDSTONE_ADAPTER], [TOPIC.redstoneValueUpdate], from, to),
    get(Object.values(PAIRS).map((c) => c.chronicle).filter(Boolean), [TOPIC.chroniclePoked, TOPIC.chronicleOpPoked], from, to),
  ]);

  // RedStone: how many feeds each transaction wrote, before filtering to ours.
  const feedsPerTx = new Map();
  for (const l of rs.logs) feedsPerTx.set(l.transactionHash, (feedsPerTx.get(l.transactionHash) || 0) + 1);

  const wanted = [];
  for (const l of cl.logs) { const pair = Object.keys(aggregators).find((p) => aggregators[p] === l.address); if (pair) wanted.push({ pair, oracle: 'chainlink', log: l, ...decodeChainlink(l), share: 1 }); }
  for (const l of rs.logs) { const d = decodeRedstone(l); const pair = feedIdToPair[d.feedIdRaw]; if (pair) wanted.push({ pair, oracle: 'redstone', log: l, ...d, share: feedsPerTx.get(l.transactionHash) || 1 }); }
  for (const l of ch.logs) { const d = decodeChronicle(l); const pair = chronicleToPair[l.address]; if (pair && d) wanted.push({ pair, oracle: 'chronicle', log: l, ...d, share: 1 }); }

  // Gas: from HyperSync when it came back with the logs, otherwise from receipts.
  const gas = new Map([...cl.txs, ...rs.txs, ...ch.txs]);
  const missing = [...new Set(wanted.map((w) => w.log.transactionHash).filter((h) => !gas.has(h)))];
  for (let i = 0; i < missing.length; i += 200) for (const [h, g] of await receiptsFor(missing.slice(i, i + 200))) gas.set(h, g);

  const price = state.ethUsd || 0;
  let added = 0;
  for (const w of wanted) {
    const g = gas.get(w.log.transactionHash);
    const costEth = g ? Number(g.gasUsed * g.effectiveGasPrice) / 1e18 : null;
    added += addUpdates(w.pair, w.oracle, [{
      t: w.t, value: w.value, blockNumber: w.log.blockNumber, logIndex: w.log.logIndex, transactionHash: w.log.transactionHash,
      costEth: costEth == null ? null : costEth / w.share, costUsd: costEth == null ? null : (costEth / w.share) * price,
      feedsInTx: w.share, optimistic: w.optimistic || false,
    }]);
  }
  state.lastBlock = Math.max(state.lastBlock, to);
  return added;
}

async function backfill() {
  const latest = await blockNumber();
  const horizon = latest - Math.ceil(HISTORY_DAYS * 86400 / CHAIN.blockSeconds);
  // Resume from the snapshot — unless some tracked series is still empty (a pair
  // added since the snapshot was taken), in which case take the whole horizon.
  const anyEmpty = Object.entries(state.pairs).some(([p, byO]) => oraclesFor(p).some((o) => !byO[o]?.length));
  const from = anyEmpty ? horizon : Math.max(horizon, state.lastBlock ? state.lastBlock + 1 : 0);
  state.source = hasHyperSync() ? 'hypersync' : 'rpc';
  state.backfill = { status: 'running', startedAt: Date.now(), finishedAt: 0, from, to: latest };
  console.log(`[backfill] ${state.source}: blocks ${from}..${latest} (${latest - from} blocks, ~${((latest - from) * CHAIN.blockSeconds / 86400).toFixed(1)} days)`);
  const added = await ingest(from, latest, true);
  state.backfill = { ...state.backfill, status: 'done', finishedAt: Date.now(), added };
  console.log(`[backfill] done: ${added} updates in ${((Date.now() - state.backfill.startedAt) / 1000).toFixed(1)}s`);
  save();
}

let polls = 0;
async function poll() {
  try {
    state.ethUsd = await ethUsd();
    if (++polls % 20 === 0) await resolveAggregators();
    const latest = await blockNumber();
    if (latest > state.lastBlock) { const added = await ingest(state.lastBlock + 1, latest, false); if (added) console.log(`[poll] +${added} updates, block ${latest}`); }
    state.lastPoll = Date.now();
    if (polls % 2 === 0) save();
  } catch (e) { console.warn('[poll] failed:', e.message); }
}

// ---- HTTP ----
const INDEX = new URL('./public/index.html', import.meta.url);
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const pair = url.searchParams.get('pair') || 'ETH';
  if (url.pathname === '/api/health') return json(res, { ok: true, chain: CHAIN.name, source: state.source, backfill: state.backfill, lastBlock: state.lastBlock, lastPoll: state.lastPoll, ethUsd: state.ethUsd, pairs: Object.keys(PAIRS), historyDays: HISTORY_DAYS });
  if (url.pathname === '/api/pairs') return json(res, { pairs: Object.entries(PAIRS).map(([id, c]) => ({ id, label: c.label, oracles: oraclesFor(id) })), oracles: ORACLES, costRule: COST_RULE });
  if ((url.pathname === '/api/updates' || url.pathname === '/api/stats') && !PAIRS[pair]) return json(res, { error: 'unknown pair' }, 404);
  if (url.pathname === '/api/updates') {
    const winKey = url.searchParams.get('window') || '30d';
    if (!WINDOWS[winKey]) return json(res, { error: 'unknown window' }, 400);
    const from = Math.floor(Date.now() / 1000) - WINDOWS[winKey];
    const out = {}, prior = {};
    for (const o of ORACLES) {
      const series = state.pairs[pair][o];
      let last = null; for (const u of series) if (u.t < from && (!last || u.t >= last.t)) last = u;
      prior[o] = last ? last.value : null; // each oracle's last value before the window, so "vs median" starts with a full median
      out[o] = series.filter((u) => u.t >= from).map((u) => ({ t: u.t, v: u.value, c: u.costUsd, tx: u.transactionHash, b: u.blockNumber, n: u.feedsInTx, op: u.optimistic || undefined }));
    }
    return json(res, { pair, oracles: oraclesFor(pair), window: winKey, ethUsd: state.ethUsd, prior, updates: out });
  }
  if (url.pathname === '/api/stats') {
    const out = {}; for (const [w, secs] of Object.entries(WINDOWS)) { out[w] = {}; for (const o of ORACLES) out[w][o] = statsFor(state.pairs[pair][o], secs); }
    return json(res, { pair, oracles: oraclesFor(pair), ethUsd: state.ethUsd, costRule: COST_RULE, stats: out });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(INDEX)); }
  // Static files under public/ (logo, fonts). Path is resolved inside public/ only.
  const file = resolve(PUBLIC, '.' + decodeURIComponent(url.pathname));
  if (file.startsWith(PUBLIC + sep) && existsSync(file) && statSync(file).isFile()) {
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
    return res.end(readFileSync(file));
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log(`[http] listening on ${PORT}`));

// ---- boot ----
(async () => {
  load();
  state.ethUsd = await ethUsd().catch(() => state.ethUsd);
  await resolveAggregators();
  console.log('[boot] aggregators', aggregators, '| source', hasHyperSync() ? 'hypersync' : 'rpc', '| snapshot lastBlock', state.lastBlock);
  await backfill().catch((e) => { state.backfill.status = 'failed: ' + e.message; console.error('[backfill] failed:', e.message); });
  setInterval(poll, POLL_MS); poll();
})();
