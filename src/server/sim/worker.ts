import { parentPort, workerData } from 'node:worker_threads';
import { runDaySimulation } from './daySimulation';
import type { DispatchStrategy } from '../../shared/types';

/**
 * Worker-tråd til driftssimulering. Kører i sin egen tråd med sit eget
 * virtuelle ur og sin egen in-memory-database, så den ikke påvirker den
 * kørende installation.
 */
async function main() {
  const { seed, orders, drivers, strategies } = workerData as { seed: number; orders: number; drivers: number; strategies: DispatchStrategy[] };
  for (const [i, strategy] of strategies.entries()) {
    parentPort!.postMessage({ type: 'start', strategy });
    const r = await runDaySimulation({
      seed,
      orders,
      drivers,
      strategy,
      onProgress: (p) => parentPort!.postMessage({ type: 'progress', strategy, pct: Math.round(((i + p / 100) / strategies.length) * 100) }),
    });
    parentPort!.postMessage({ type: 'result', strategy, metrics: r.metrics, config: r.config, log: r.log });
  }
  parentPort!.postMessage({ type: 'done' });
}

main().catch((e) => parentPort!.postMessage({ type: 'error', message: (e as Error).message }));
