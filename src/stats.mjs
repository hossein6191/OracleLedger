// The numbers under the chart, per oracle, per window.
export const WINDOWS = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };

export function statsFor(series, windowSeconds, now = Math.floor(Date.now() / 1000)) {
  const from = now - windowSeconds;
  const w = series.filter((u) => u.t >= from);
  let maxDev = 0;
  for (let i = 1; i < w.length; i++) if (w[i - 1].value) maxDev = Math.max(maxDev, Math.abs(w[i].value - w[i - 1].value) / w[i - 1].value * 100);
  const costs = w.map((u) => u.costUsd).filter((c) => Number.isFinite(c));
  const total = costs.reduce((a, b) => a + b, 0);
  const last = series[series.length - 1];
  return {
    updates: w.length, maxDeviationPct: maxDev,
    costTotalUsd: total, costAvgUsd: costs.length ? total / costs.length : 0, costMaxUsd: costs.length ? Math.max(...costs) : 0,
    lastValue: last?.value ?? null, lastAt: last?.t ?? null, ageSeconds: last ? now - last.t : null,
  };
}
