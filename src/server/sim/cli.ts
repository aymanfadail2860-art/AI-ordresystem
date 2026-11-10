import fs from 'node:fs';
import path from 'node:path';
import { runStrategyComparison, STRATEGIES } from './daySimulation';
import { comparisonMarkdown } from './report';
import type { DispatchStrategy } from '../../shared/types';

/** Kør hel-dags-simuleringen fra kommandolinjen: node dist/sim/cli.js --orders 300 --drivers 8 --seed 42 */
async function main() {
  const arg = (name: string, def: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
  };
  const orders = Number(arg('orders', '300'));
  const drivers = Number(arg('drivers', '8'));
  const seed = Number(arg('seed', '42'));
  const out = arg('out', 'docs/simulation');
  const strategies = arg('strategies', STRATEGIES.join(',')).split(',') as DispatchStrategy[];
  console.log(`Simulerer ${orders} ordrer, ${drivers} chauffører, seed ${seed}, strategier: ${strategies.join(', ')} …`);
  const c = await runStrategyComparison({ seed, orders, drivers, onProgress: (p) => p % 25 === 0 && process.stdout.write(`${p}% `) }, strategies);
  console.log('');
  fs.mkdirSync(out, { recursive: true });
  const md = comparisonMarkdown(c, { orders, drivers });
  fs.writeFileSync(path.join(out, `comparison-seed${seed}.md`), md);
  fs.writeFileSync(path.join(out, `comparison-seed${seed}.json`), JSON.stringify({ simulated: true, seed, orders, drivers, results: c.results, best: c.best, economicNotBest: c.economicNotBest, summary: c.summary, logs: Object.fromEntries(c.runs.map((r) => [r.metrics.strategy, r.log])) }, null, 2));
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
