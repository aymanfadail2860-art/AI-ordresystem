// Genererer docs/simulation/v0.4.1/comparison.md ud fra before.json og after.json (simulerede data).
// Brug: node scripts/sim-report.mjs
import fs from 'node:fs';

const dir = 'docs/simulation/v0.4.1';
const before = JSON.parse(fs.readFileSync(`${dir}/before.json`, 'utf8')).results;
const after = JSON.parse(fs.readFileSync(`${dir}/after.json`, 'utf8')).results;

const EVAL = [
  ['ordersAccepted', 'Accepterede ordrer', 'higher'],
  ['delivered', 'Leverede ordrer', 'higher'],
  ['openAtEnd', 'Åbne ved dagens slutning', 'lower'],
  ['needsManual', 'Eskaleret til manuel behandling', 'lower'],
  ['revenueOre', 'Omsætning (kr.)', 'higher', true],
  ['contributionOre', 'Dækningsbidrag (kr.)', 'higher', true],
  ['avgDeliveryMinutes', 'Gns. leveringstid (min)', 'lower'],
  ['lateShare', 'Forsinkede (%)', 'lower'],
  ['lateMinutes', 'Forsinkelsesminutter', 'lower'],
  ['p90DelayMinutes', 'P90 forsinkelse (min)', 'lower'],
  ['etaChanges', 'Ændrede ETA\'er til kunder', 'lower'],
  ['driveMinutes', 'Køretid (min)', 'lower'],
  ['replenishments', 'Lageropfyldninger', 'lower'],
  ['managementInterventionsDistinct', 'Ledelsesindgreb', 'lower'],
  ['failedOrUnresolvedActions', 'Fejlede/uafklarede', 'lower'],
];
const LABEL = { fifo: 'A. Først-til-mølle', shortest_detour: 'B. Korteste ekstra køretid', economic: 'C. Økonomisk (v0.4)', adaptive: 'D. Adaptiv hybrid' };
const loads = ['100', '150', '300', '500', '1000'];
const pick = (rs, load, s) => rs.filter((r) => r.load === load && r.strategy === s).map((r) => r.metrics);
const stats = (ms, key, better) => {
  const v = ms.map((m) => m[key] ?? 0);
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length));
  return { mean, sd, worst: better === 'higher' ? Math.min(...v) : Math.max(...v) };
};
const fmt = (x, money) => (money ? Math.round(x / 100).toLocaleString('da-DK') : x.toLocaleString('da-DK', { maximumFractionDigits: 1 }));
const cell = (s, money) => `${fmt(s.mean, money)} ± ${fmt(s.sd, money)} (${fmt(s.worst, money)})`;
const meta = (load) => {
  const r = after.find((x) => x.load === load);
  return `${r.orders} henvendelser, ${r.drivers} chauffører`;
};

const out = [
  '# Før og efter – Etape 4.1',
  '',
  '> **SIMULEREDE DATA.** Se [README.md](README.md) for årsagsanalyse, forudsætninger og begrænsninger.',
  '',
  'Celler: gennemsnit ± standardafvigelse (dårligste) over 4 seeds med forskellige profiler (standard, store ordrer, spredte adresser, flere centrallagervarer).',
  '',
  '**Før** = v0.4.0-strategien (C. økonomisk) med v0.4.0-regler (ingen påfyldning, dobbelttælling af beslutninger), kørt i den rettede simulator.',
  '**Efter** = D. adaptiv hybrid med v0.4.1-regler.',
  '',
];
for (const load of loads) {
  out.push(`## ${meta(load)}`, '', '| Nøgletal | Før (C, v0.4.0-regler) | Efter (D, v0.4.1) | Ændring |', '|---|---:|---:|---:|');
  for (const [key, label, better, money] of EVAL) {
    const b = stats(pick(before, load, 'economic'), key, better);
    const a = stats(pick(after, load, 'adaptive'), key, better);
    const d = a.mean - b.mean;
    const good = better === 'higher' ? d > 0 : d < 0;
    const pct = b.mean ? ` (${d >= 0 ? '+' : ''}${Math.round((d / b.mean) * 100)} %)` : '';
    out.push(`| ${label} | ${cell(b, money)} | ${cell(a, money)} | ${Math.abs(d) < 1e-9 ? '0' : `${good ? '✅' : '⚠️'} ${d >= 0 ? '+' : ''}${fmt(d, money)}${pct}`} |`);
  }
  out.push('');
}

out.push('# Alle fire strategier efter v0.4.1 (identiske input og regler)', '');
const notBest = {};
for (const load of loads) {
  out.push(`## ${meta(load)}`, '', `| Nøgletal | ${Object.values(LABEL).join(' | ')} |`, `|---|${Object.keys(LABEL).map(() => '---:').join('|')}|`);
  for (const [key, label, better, money] of EVAL) {
    const ss = Object.keys(LABEL).map((s) => stats(pick(after, load, s), key, better));
    const best = better === 'higher' ? Math.max(...ss.map((s) => s.mean)) : Math.min(...ss.map((s) => s.mean));
    const adaptiveBest = Math.abs(ss[3].mean - best) < 1e-9;
    if (!adaptiveBest) (notBest[load] ??= []).push(label);
    out.push(`| ${label} | ${ss.map((s) => (Math.abs(s.mean - best) < 1e-9 ? `**${cell(s, money)}**` : cell(s, money))).join(' | ')} |`);
  }
  out.push('');
}
out.push('## Hvor den adaptive strategi IKKE er bedst (gennemsnit)', '');
for (const load of loads) out.push(`- **${meta(load)}:** ${(notBest[load] ?? []).join(', ') || 'bedst eller delt bedst på alle nøgletal'}`);
out.push('');
fs.writeFileSync(`${dir}/comparison.md`, out.join('\n'));
console.log(out.join('\n'));
