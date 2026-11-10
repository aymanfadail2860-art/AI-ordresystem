import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runDaySimulation, type SimProfile } from './daySimulation';
import { DISPATCH_STRATEGY_LABELS, type DispatchStrategy, type SimulationMetrics } from '../../shared/types';

/**
 * Simuleringsmatrix: belastninger × (seed, profil) × strategier.
 * Kører parallelt i worker-tråde (hver kørsel har sin egen database og sit eget ur).
 *
 *   node dist/sim/matrix.js --out docs/simulation/v0.4.1/after.json --strategies fifo,shortest_detour,economic,adaptive
 */

export interface LoadScenario {
  id: string;
  orders: number;
  drivers: number;
}

export const LOADS: LoadScenario[] = [
  { id: '100', orders: 100, drivers: 8 },
  { id: '150', orders: 150, drivers: 8 },
  { id: '300', orders: 300, drivers: 8 },
  { id: '500', orders: 500, drivers: 10 },
  { id: '1000', orders: 1000, drivers: 16 },
];

/** Forskellige seeds med forskellige fordelinger af ordrestørrelser, adresser og varebehov. */
export const VARIANTS: { seed: number; profile: SimProfile }[] = [
  { seed: 11, profile: 'standard' },
  { seed: 23, profile: 'large' },
  { seed: 37, profile: 'spread' },
  { seed: 42, profile: 'central' },
];

interface Job {
  load: LoadScenario;
  seed: number;
  profile: SimProfile;
  strategy: DispatchStrategy;
  adaptive?: Record<string, number>;
  legacyRules?: boolean;
}

export interface MatrixResult {
  load: string;
  orders: number;
  drivers: number;
  seed: number;
  profile: SimProfile;
  strategy: DispatchStrategy;
  metrics: SimulationMetrics;
}

/** Nøgletal i evalueringen og om højere eller lavere er bedst. */
export const EVAL: { key: keyof SimulationMetrics; label: string; better: 'higher' | 'lower'; money?: boolean }[] = [
  { key: 'ordersAccepted', label: 'Accepterede ordrer', better: 'higher' },
  { key: 'delivered', label: 'Leverede ordrer', better: 'higher' },
  { key: 'openAtEnd', label: 'Åbne ved dagens slutning', better: 'lower' },
  { key: 'needsManual', label: 'Manuel behandling', better: 'lower' },
  { key: 'revenueOre', label: 'Omsætning', better: 'higher', money: true },
  { key: 'contributionOre', label: 'Dækningsbidrag', better: 'higher', money: true },
  { key: 'avgDeliveryMinutes', label: 'Gns. leveringstid (min)', better: 'lower' },
  { key: 'lateShare', label: 'Forsinkede (%)', better: 'lower' },
  { key: 'lateMinutes', label: 'Forsinkelsesminutter', better: 'lower' },
  { key: 'p90DelayMinutes', label: 'P90 forsinkelse (min)', better: 'lower' },
  { key: 'p90DeliveryMinutes', label: 'P90 leveringstid (min)', better: 'lower' },
  { key: 'slaLateShare', label: 'Over 60 min (%)', better: 'lower' },
  { key: 'etaChanges', label: 'ETA-ændringer', better: 'lower' },
  { key: 'driveMinutes', label: 'Køretid (min)', better: 'lower' },
  { key: 'replenishments', label: 'Lageropfyldninger', better: 'lower' },
  { key: 'managementInterventionsDistinct', label: 'Ledelsesindgreb', better: 'lower' },
  { key: 'failedOrUnresolvedActions', label: 'Fejlede/uafklarede', better: 'lower' },
];

export function aggregate(results: MatrixResult[]) {
  const loads = [...new Set(results.map((r) => r.load))];
  const strategies = [...new Set(results.map((r) => r.strategy))];
  return loads.map((load) => ({
    load,
    rows: strategies.map((strategy) => {
      const runs = results.filter((r) => r.load === load && r.strategy === strategy).map((r) => r.metrics);
      const stats = Object.fromEntries(
        EVAL.map((m) => {
          const v = runs.map((x) => (x[m.key] as number) ?? 0);
          const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
          const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length));
          const worst = m.better === 'higher' ? Math.min(...v) : Math.max(...v);
          return [m.key, { mean, sd, worst, n: v.length }];
        }),
      );
      return { strategy, stats };
    }),
  }));
}

export function matrixMarkdown(results: MatrixResult[], title: string): string {
  const agg = aggregate(results);
  const fmt = (m: (typeof EVAL)[number], x: number) =>
    m.money ? `${Math.round(x / 100).toLocaleString('da-DK')}` : x.toLocaleString('da-DK', { maximumFractionDigits: 1 });
  const out = [`# ${title}`, '', '> **SIMULEREDE DATA** – se docs/simulation/README.md for forudsætninger og begrænsninger.', '', 'Celler: gennemsnit ± standardafvigelse (dårligste) over seeds/profiler. Beløb i kr. **Fed** = bedste gennemsnit.', ''];
  for (const a of agg) {
    const first = results.find((r) => r.load === a.load)!;
    out.push(`## ${first.orders} henvendelser, ${first.drivers} chauffører (${new Set(results.filter((r) => r.load === a.load).map((r) => r.seed)).size} seeds)`, '');
    out.push(`| Nøgletal | ${a.rows.map((r) => DISPATCH_STRATEGY_LABELS[r.strategy]).join(' | ')} |`);
    out.push(`|---|${a.rows.map(() => '---:').join('|')}|`);
    for (const m of EVAL) {
      const means = a.rows.map((r) => r.stats[m.key as string].mean);
      const best = m.better === 'higher' ? Math.max(...means) : Math.min(...means);
      out.push(
        `| ${m.label} | ${a.rows
          .map((r) => {
            const s = r.stats[m.key as string];
            const cell = `${fmt(m, s.mean)} ± ${fmt(m, s.sd)} (${fmt(m, s.worst)})`;
            return Math.abs(s.mean - best) < 1e-9 ? `**${cell}**` : cell;
          })
          .join(' | ')} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

async function runPool(jobs: Job[], workers: number, onDone: (r: MatrixResult) => void): Promise<void> {
  let next = 0;
  const one = () =>
    new Promise<void>((resolve, reject) => {
      const loop = () => {
        if (next >= jobs.length) return resolve();
        const job = jobs[next++];
        const w = new Worker(__filename, { workerData: job });
        w.once('message', (m: MatrixResult | { error: string }) => {
          if ('error' in m) return reject(new Error(`${job.strategy}/${job.load.id}/${job.seed}: ${m.error}`));
          onDone(m);
          void w.terminate();
          loop();
        });
        w.once('error', reject);
      };
      loop();
    });
  await Promise.all(Array.from({ length: workers }, one));
}

async function main() {
  const arg = (name: string, def: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
  };
  const strategies = arg('strategies', 'fifo,shortest_detour,economic,adaptive').split(',') as DispatchStrategy[];
  const loads = LOADS.filter((l) => arg('loads', LOADS.map((x) => x.id).join(',')).split(',').includes(l.id));
  const variants = VARIANTS.filter((v) => arg('seeds', VARIANTS.map((x) => x.seed).join(',')).split(',').map(Number).includes(v.seed));
  const out = arg('out', 'docs/simulation/matrix.json');
  const title = arg('title', 'Simuleringsmatrix');
  const workers = Number(arg('workers', String(Math.max(1, os.cpus().length))));
  // Største kørsler først, så parallelliseringen udnyttes
  const jobs: Job[] = [];
  const adaptive = process.env.SIM_ADAPTIVE ? (JSON.parse(process.env.SIM_ADAPTIVE) as Record<string, number>) : undefined;
  for (const load of [...loads].sort((a, b) => b.orders - a.orders)) for (const v of variants) for (const strategy of strategies) jobs.push({ load, seed: v.seed, profile: v.profile, strategy, adaptive, legacyRules: process.argv.includes('--legacy-rules') });
  const results: MatrixResult[] = [];
  const t0 = Date.now();
  await runPool(jobs, workers, (r) => {
    results.push(r);
    console.log(`[${results.length}/${jobs.length}] ${r.load} ${r.profile}/${r.seed} ${r.strategy}: leveret ${r.metrics.delivered}, forsinket ${r.metrics.lateShare} %, ${Math.round(r.metrics.wallClockMs / 1000)} s`);
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ simulated: true, generatedAt: new Date().toISOString(), results }, null, 1));
  const md = matrixMarkdown(results, title);
  fs.writeFileSync(out.replace(/\.json$/, '.md'), md);
  console.log(`Færdig på ${Math.round((Date.now() - t0) / 1000)} s → ${out}`);
}

if (isMainThread) {
  if (require.main === module) {
    main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
} else {
  const job = workerData as Job;
  runDaySimulation({ seed: job.seed, orders: job.load.orders, drivers: job.load.drivers, strategy: job.strategy, profile: job.profile, adaptive: job.adaptive, legacyRules: job.legacyRules })
    .then((r) =>
      parentPort!.postMessage({
        load: job.load.id,
        orders: job.load.orders,
        drivers: job.load.drivers,
        seed: job.seed,
        profile: job.profile,
        strategy: job.strategy,
        metrics: { ...r.metrics, wallClockMs: r.metrics.wallClockMs },
      } satisfies MatrixResult),
    )
    .catch((e) => parentPort!.postMessage({ error: (e as Error).message }));
}
