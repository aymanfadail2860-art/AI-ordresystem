// Genererer docs/simulation/v0.5/comparison.md (simulerede data).
// Før = hybridstrategi v0.4.1; Kun kapacitet = v0.5 uden alternative tider; Efter = v0.5.
import fs from 'node:fs';

const dir = 'docs/simulation/v0.5';
const load = (f) => JSON.parse(fs.readFileSync(`${dir}/${f}.json`, 'utf8')).results;
const sets = [
  ['Før (v0.4.1)', load('before')],
  ['Kun kapacitet', load('capacity-only')],
  ['Efter (v0.5)', load('after')],
  ['v0.5 + intern kø', load('after-with-queue')],
];
const EVAL = [
  ['ordersAccepted', 'Accepterede ordrer', 'higher'],
  ['delivered', 'Leverede ordrer', 'higher'],
  ['needsManual', 'Manuelle sager', 'lower'],
  ['openAtEnd', 'Åbne ved dagens slutning', 'lower'],
  ['altQueued', 'Ordrer sat i intern kø', null],
  ['altOrdersOffered', 'Ordrer tilbudt senere tidspunkt', null],
  ['altAccepted', 'Senere tidspunkter accepteret', null],
  ['windowsMet', 'Aftalte tidsrum overholdt', null],
  ['windowOrdersDelivered', 'Leverede med aftalt tidsrum', null],
  ['lateShare', 'Forsinkede (%)', 'lower'],
  ['lateMinutes', 'Forsinkelsesminutter', 'lower'],
  ['p90DelayMinutes', 'P90 forsinkelse (min)', 'lower'],
  ['avgDeliveryMinutes', 'Gns. leveringstid (min)', 'lower'],
  ['replenishments', 'Lageropfyldninger', 'lower'],
  ['capacityProblems', 'Kapacitetsproblemer', 'lower'],
  ['managementInterventionsDistinct', 'Ledelsesindgreb', 'lower'],
  ['failedOrUnresolvedActions', 'Fejlede/uafklarede', 'lower'],
];
const loads = [...new Set(sets[0][1].map((r) => r.load))].sort((a, b) => Number(a) - Number(b));
const stats = (rs, key, better) => {
  const v = rs.map((r) => r.metrics[key] ?? 0);
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length));
  const worst = better === 'higher' ? Math.min(...v) : Math.max(...v);
  return { mean, sd, worst };
};
const f = (x) => x.toLocaleString('da-DK', { maximumFractionDigits: 1 });
const out = [
  '# Etape 5 – hybridstrategien før og efter',
  '',
  '> **SIMULEREDE DATA.** Se [README.md](README.md) for forudsætninger, analyse og begrænsninger.',
  '',
  'Celler: gennemsnit ± standardafvigelse (dårligste) over 4 seeds/profiler (standard, store ordrer, spredte adresser, flere centrallagervarer). Strategi: adaptiv hybrid i alle kolonner.',
  '',
  '- **Før (v0.4.1):** ingen alternative tider; alle varer fylder ens, og bilerne har ubegrænset plads.',
  '- **Kun kapacitet:** v0.5 med fysisk kapacitet (240 lagerenheder pr. bil, fryseboks 12, husholdning 24, fast sortiment), men uden alternative tider.',
  '- **Efter (v0.5):** fysisk kapacitet + alternative leveringstider (standardindstillinger; intern kø slået fra).',
  '- **v0.5 + intern kø:** som Efter, men med `alternatives.queueWithinNormalTime = true`.',
  '',
];
for (const l of loads) {
  const first = sets[0][1].find((r) => r.load === l);
  out.push(`## ${first.orders} henvendelser, ${first.drivers} chauffører`, '', `| Nøgletal | ${sets.map((s) => s[0]).join(' | ')} |`, `|---|${sets.map(() => '---:').join('|')}|`);
  for (const [key, label, better] of EVAL) {
    out.push(`| ${label} | ${sets.map(([, rs]) => { const s = stats(rs.filter((r) => r.load === l), key, better); return `${f(s.mean)} ± ${f(s.sd)} (${f(s.worst)})`; }).join(' | ')} |`);
  }
  out.push('', '**Manuelle sager pr. årsag (sum over seeds):**', '');
  for (const [name, rs] of sets) {
    const agg = {};
    for (const r of rs.filter((x) => x.load === l)) for (const [k, v] of Object.entries(r.metrics.manualByReason ?? {})) agg[k] = (agg[k] ?? 0) + v;
    out.push(`- ${name}: ${Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join('; ') || 'ingen'}`);
  }
  out.push('');
}
fs.writeFileSync(`${dir}/comparison.md`, out.join('\n'));
console.log(out.join('\n'));
