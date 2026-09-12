// In memory, with a snapshot on disk so a restart does not mean a full backfill.
// Hosting disks may be wiped; if the snapshot is gone the backfill simply runs again.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { CHAINS, ORACLES, pairsOf } from './config.mjs';

const FILE = new URL('../data/snapshot.json', import.meta.url);
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);

const emptyChain = (chain) => ({
  pairs: Object.fromEntries(Object.keys(pairsOf(chain)).map((p) => [p, Object.fromEntries(ORACLES.map((o) => [o, []]))])),
  lastBlock: 0, ethUsd: 0, source: 'rpc', coverage: null, pythLatest: {},
  backfill: { status: 'starting', startedAt: Date.now(), finishedAt: 0 }, lastPoll: 0,
});

export const state = { chains: Object.fromEntries(Object.keys(CHAINS).map((c) => [c, emptyChain(c)])) };
export const chainState = (chain) => state.chains[chain];

const key = (u) => `${u.transactionHash}:${u.logIndex}`;

export function addUpdates(chain, pair, oracle, list) {
  const series = state.chains[chain].pairs[pair][oracle];
  const seen = new Set(series.map(key));
  let added = 0;
  for (const u of list) { const k = key(u); if (seen.has(k)) continue; seen.add(k); series.push(u); added++; }
  if (added) series.sort((a, b) => a.t - b.t || a.logIndex - b.logIndex);
  const cutoff = Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86400;
  while (series.length && series[0].t < cutoff) series.shift();
  return added;
}

export function save() {
  try { mkdirSync(new URL('../data/', import.meta.url), { recursive: true }); writeFileSync(FILE, JSON.stringify(state)); }
  catch (e) { console.warn('[snapshot] not saved:', e.message); }
}

export function load() {
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'));
    for (const c of Object.keys(state.chains)) {
      const saved = s?.chains?.[c];
      if (!saved) continue;
      const cs = state.chains[c];
      for (const p of Object.keys(cs.pairs)) for (const o of ORACLES) if (saved.pairs?.[p]?.[o]) cs.pairs[p][o] = saved.pairs[p][o];
      cs.lastBlock = saved.lastBlock || 0; cs.ethUsd = saved.ethUsd || 0; cs.coverage = saved.coverage || null;
    }
    return true;
  } catch { return false; }
}
