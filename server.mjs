import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS, CHAIN_IDS, DEFAULT_CHAIN, ORACLES, COST_RULE, oraclesFor, pairsOf } from './src/config.mjs';
import { TOPIC, feedIdBytes32, decodeChainlink, decodeRedstone, decodeChronicle, decodePyth, PYTH_GET_PRICE_UNSAFE, decodePythPrice } from './src/decode.mjs';
import { blockNumber, aggregatorOf, ethUsd, fetchLogs, rpcLogs, receiptsFor, hasHyperSync, ethCall } from './src/sources.mjs';
import { state, chainState, addUpdates, save, load } from './src/store.mjs';
import { statsFor, WINDOWS } from './src/stats.mjs';

// Minimal .env support for local runs; hosts inject real env vars.
if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);
const POLL_MS = Number(process.env.POLL_SECONDS || 30) * 1000;
const PORT = Number(process.env.PORT || 3000);

// Per chain: the Chainlink aggregators in use, the lookups from log to pair, and a signature
// of what is tracked (when that changes, the whole horizon is backfilled once).
const RT = Object.fromEntries(CHAIN_IDS.map((chain) => {
  const pairs = pairsOf(chain);
  return [chain, {
    aggregators: {},
    feedIdToPair: Object.fromEntries(Object.entries(pairs).map(([p, c]) => [feedIdBytes32(c.redstoneFeedId), p])),
    chronicleToPair: Object.fromEntries(Object.entries(pairs).filter(([, c]) => c.chronicle).map(([p, c]) => [c.chronicle.toLowerCase(), p])),
    pythToPair: Object.fromEntries(Object.entries(pairs).filter(([, c]) => c.pyth).map(([p, c]) => [c.pyth.toLowerCase(), p])),
    coverage: JSON.stringify(Object.keys(pairs).map((p) => [p, oraclesFor(chain, p)])),
    polls: 0,
  }];
}));

async function resolveAggregators(chain) {
  for (const [p, c] of Object.entries(pairsOf(chain))) RT[chain].aggregators[p] = await aggregatorOf(chain, c.chainlinkProxy);
}

// One pass over a block range on one chain: fetch every relevant log, price the gas, store.
async function ingest(chain, from, to, useArchive) {
  const get = useArchive ? fetchLogs : rpcLogs;
  const cfg = CHAINS[chain], rt = RT[chain], st = chainState(chain);
  const [cl, rs, ch, py] = await Promise.all([
    get(chain, Object.values(rt.aggregators), [TOPIC.chainlinkAnswerUpdated], from, to),
    get(chain, [cfg.redstoneAdapter], [TOPIC.redstoneValueUpdate], from, to),
    get(chain, Object.values(pairsOf(chain)).map((c) => c.chronicle).filter(Boolean), [TOPIC.chroniclePoked, TOPIC.chronicleOpPoked], from, to),
    get(chain, [cfg.pyth], [TOPIC.pythPriceFeedUpdate], from, to),
  ]);

  // RedStone: how many feeds each transaction wrote, before filtering to ours.
  const feedsPerTx = new Map();
  for (const l of rs.logs) feedsPerTx.set(l.transactionHash, (feedsPerTx.get(l.transactionHash) || 0) + 1);
  // Pyth: same idea, one transaction can push several feeds.
  const pythPerTx = new Map();
  for (const l of py.logs) pythPerTx.set(l.transactionHash, (pythPerTx.get(l.transactionHash) || 0) + 1);

  const wanted = [];
  for (const l of cl.logs) { const pair = Object.keys(rt.aggregators).find((p) => rt.aggregators[p] === l.address); if (pair) wanted.push({ pair, oracle: 'chainlink', log: l, ...decodeChainlink(l), share: 1 }); }
  for (const l of rs.logs) { const d = decodeRedstone(l); const pair = rt.feedIdToPair[d.feedIdRaw]; if (pair) wanted.push({ pair, oracle: 'redstone', log: l, ...d, share: feedsPerTx.get(l.transactionHash) || 1 }); }
  for (const l of ch.logs) { const d = decodeChronicle(l); const pair = rt.chronicleToPair[l.address]; if (pair && d) wanted.push({ pair, oracle: 'chronicle', log: l, ...d, share: 1 }); }
  for (const l of py.logs) { const d = decodePyth(l); const pair = rt.pythToPair[d.feedIdRaw]; if (pair) wanted.push({ pair, oracle: 'pyth', log: l, ...d, share: pythPerTx.get(l.transactionHash) || 1 }); }

  // Gas: from HyperSync when it came back with the logs, otherwise from receipts.
  const gas = new Map([...cl.txs, ...rs.txs, ...ch.txs, ...py.txs]);
  const missing = [...new Set(wanted.map((w) => w.log.transactionHash).filter((h) => !gas.has(h)))];
  for (let i = 0; i < missing.length; i += 200) for (const [h, g] of await receiptsFor(chain, missing.slice(i, i + 200))) gas.set(h, g);

  const price = st.ethUsd || 0;
  let added = 0;
  for (const w of wanted) {
    const g = gas.get(w.log.transactionHash);
    const costEth = g ? Number(g.gasUsed * g.effectiveGasPrice) / 1e18 : null;
    added += addUpdates(chain, w.pair, w.oracle, [{
      t: w.t, value: w.value, blockNumber: w.log.blockNumber, logIndex: w.log.logIndex, transactionHash: w.log.transactionHash,
      costEth: costEth == null ? null : costEth / w.share, costUsd: costEth == null ? null : (costEth / w.share) * price,
      feedsInTx: w.share, optimistic: w.optimistic || false,
    }]);
  }
  st.lastBlock = Math.max(st.lastBlock, to);
  return added;
}

// Pyth's stored price per pair, read from the contract: shown when no Pyth write is in the history.
async function readPythLatest(chain) {
  for (const [p, c] of Object.entries(pairsOf(chain))) if (c.pyth) chainState(chain).pythLatest[p] = decodePythPrice(await ethCall(chain, CHAINS[chain].pyth, PYTH_GET_PRICE_UNSAFE + c.pyth.slice(2)));
}

async function backfill(chain) {
  const cfg = CHAINS[chain], st = chainState(chain);
  const latest = await blockNumber(chain);
  const horizon = latest - Math.ceil(HISTORY_DAYS * 86400 / cfg.blockSeconds);
  // Resume from the snapshot, unless the tracked pairs or oracles changed since it was
  // taken. (An empty series is not a reason: Pyth can go a month without a write.)
  const full = st.coverage !== RT[chain].coverage;
  const from = full ? horizon : Math.max(horizon, st.lastBlock ? st.lastBlock + 1 : 0);
  st.source = hasHyperSync() ? 'hypersync' : 'rpc';
  st.backfill = { status: 'running', startedAt: Date.now(), finishedAt: 0, from, to: latest };
  console.log(`[backfill] ${chain} ${st.source}: blocks ${from}..${latest} (${latest - from} blocks, ~${((latest - from) * cfg.blockSeconds / 86400).toFixed(1)} days)`);
  const added = await ingest(chain, from, latest, true);
  st.backfill = { ...st.backfill, status: 'done', finishedAt: Date.now(), added };
  st.coverage = RT[chain].coverage;
  console.log(`[backfill] ${chain} done: ${added} updates in ${((Date.now() - st.backfill.startedAt) / 1000).toFixed(1)}s`);
  save();
}

async function poll(chain) {
  const st = chainState(chain), rt = RT[chain];
  try {
    st.ethUsd = await ethUsd(chain);
    if (++rt.polls % 20 === 0) await resolveAggregators(chain);
    if (rt.polls % 20 === 1) await readPythLatest(chain).catch((e) => console.warn(`[pyth] ${chain} latest read failed:`, e.message));
    const latest = await blockNumber(chain);
    // Never scan from block 1: if the backfill failed there is no floor, so take the last
    // few minutes instead and let the next backfill fill the history.
    const floor = latest - Math.ceil(600 / CHAINS[chain].blockSeconds);
    const from = Math.max(st.lastBlock + 1, floor);
    if (latest >= from) { const added = await ingest(chain, from, latest, false); if (added) console.log(`[poll] ${chain} +${added} updates, block ${latest}`); }
    st.lastPoll = Date.now();
    if (rt.polls % 2 === 0) save();
  } catch (e) { console.warn(`[poll] ${chain} failed:`, e.message); }
}

// ---- HTTP ----
const INDEX = new URL('./public/index.html', import.meta.url);
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const chainList = () => CHAIN_IDS.map((id) => ({ id, label: CHAINS[id].label, explorer: CHAINS[id].explorer }));

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const chain = url.searchParams.get('chain') || DEFAULT_CHAIN;
  const pair = url.searchParams.get('pair') || 'ETH';
  const apiCall = url.pathname.startsWith('/api/');

  if (url.pathname === '/api/health') {
    return json(res, {
      ok: true, historyDays: HISTORY_DAYS,
      chains: Object.fromEntries(CHAIN_IDS.map((c) => {
        const st = chainState(c);
        return [c, { label: CHAINS[c].label, source: st.source, backfill: st.backfill, lastBlock: st.lastBlock, lastPoll: st.lastPoll, ethUsd: st.ethUsd, pairs: Object.keys(pairsOf(c)) }];
      })),
    });
  }
  if (apiCall && !CHAINS[chain]) return json(res, { error: 'unknown chain' }, 404);
  if (url.pathname === '/api/pairs') {
    return json(res, {
      chain, chains: chainList(), oracles: ORACLES, costRule: COST_RULE,
      pairs: Object.entries(pairsOf(chain)).map(([id, c]) => ({ id, label: c.label, oracles: oraclesFor(chain, id) })),
    });
  }
  if ((url.pathname === '/api/updates' || url.pathname === '/api/stats') && !pairsOf(chain)[pair]) return json(res, { error: 'unknown pair' }, 404);
  if (url.pathname === '/api/updates') {
    const winKey = url.searchParams.get('window') || '30d';
    if (!WINDOWS[winKey]) return json(res, { error: 'unknown window' }, 400);
    const from = Math.floor(Date.now() / 1000) - WINDOWS[winKey];
    const out = {}, prior = {};
    for (const o of ORACLES) {
      const series = chainState(chain).pairs[pair][o];
      let last = null; for (const u of series) if (u.t < from && (!last || u.t >= last.t)) last = u;
      prior[o] = last ? { v: last.value, t: last.t } : null; // each oracle's last value before the window, so "vs median" starts with a full median
      out[o] = series.filter((u) => u.t >= from).map((u) => ({ t: u.t, v: u.value, c: u.costUsd, tx: u.transactionHash, b: u.blockNumber, n: u.feedsInTx, op: u.optimistic || undefined }));
    }
    return json(res, { chain, pair, oracles: oraclesFor(chain, pair), window: winKey, ethUsd: chainState(chain).ethUsd, prior, updates: out });
  }
  if (url.pathname === '/api/stats') {
    const st = chainState(chain);
    const out = {}; for (const [w, secs] of Object.entries(WINDOWS)) { out[w] = {}; for (const o of ORACLES) out[w][o] = statsFor(st.pairs[pair][o], secs); }
    const pl = st.pythLatest[pair], nowS = Math.floor(Date.now() / 1000);
    if (pl) for (const w of Object.keys(out)) if (out[w].pyth.lastValue == null) Object.assign(out[w].pyth, { lastValue: pl.value, lastAt: pl.t, ageSeconds: nowS - pl.t, fromContract: true });
    return json(res, { chain, pair, oracles: oraclesFor(chain, pair), ethUsd: st.ethUsd, costRule: COST_RULE, stats: out });
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
// Chains are backfilled one after another so the default chain is ready first and the
// HyperSync pace is shared fairly.
(async () => {
  load();
  for (const chain of CHAIN_IDS) {
    const st = chainState(chain);
    st.ethUsd = await ethUsd(chain).catch(() => st.ethUsd);
    await resolveAggregators(chain).catch((e) => console.warn(`[boot] ${chain} aggregators failed:`, e.message));
    console.log(`[boot] ${chain}: aggregators`, RT[chain].aggregators, '| source', hasHyperSync() ? 'hypersync' : 'rpc', '| snapshot lastBlock', st.lastBlock);
    await backfill(chain).catch((e) => { st.backfill.status = 'failed: ' + e.message; console.error(`[backfill] ${chain} failed:`, e.message); });
  }
  setInterval(() => { for (const chain of CHAIN_IDS) poll(chain); }, POLL_MS);
  for (const chain of CHAIN_IDS) poll(chain);
})();
