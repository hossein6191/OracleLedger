// In memory, with a snapshot on disk so a restart does not mean a full backfill.
// Hosting disks may be wiped; if the snapshot is gone the backfill simply runs again.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PAIRS, ORACLES } from './config.mjs';

const FILE = new URL('../data/snapshot.json', import.meta.url);
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);

export const state = {
  pairs: Object.fromEntries(Object.keys(PAIRS).map((p) => [p, Object.fromEntries(ORACLES.map((o) => [o, []]))])),
  lastBlock: 0, ethUsd: 0, source: 'rpc', backfill: { status: 'starting', startedAt: Date.now(), finishedAt: 0 }, lastPoll: 0,
};

const key = (u) => `${u.transactionHash}:${u.logIndex}`;

export function addUpdates(pair, oracle, list) {
  const series = state.pairs[pair][oracle];
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
    if (s?.pairs) { for (const p of Object.keys(state.pairs)) for (const o of ORACLES) if (s.pairs[p]?.[o]) state.pairs[p][o] = s.pairs[p][o]; }
    state.lastBlock = s.lastBlock || 0; state.ethUsd = s.ethUsd || 0;
    return true;
  } catch { return false; }
}
