import { describe, expect, it } from 'vitest';
import { compareStrategies, runDaySimulation, type SimResult } from '../src/server/sim/daySimulation';
import { comparisonMarkdown } from '../src/server/sim/report';
import { chooseInsertion, compareByStrategy, type InsertionResult } from '../src/core/routePlanning';
import type { App } from '../src/server/app';
import type { SimulationMetrics } from '../src/shared/types';

/**
 * Driftssimulering (Demo Mode, virtuelt ur, fast seed). En mindre dag end
 * den fulde 300-ordrers kørsel (npm run simulate) for at holde testen hurtig.
 */
const small = { seed: 7, orders: 45, drivers: 4 };

interface Checks {
  realAdapters: boolean;
  negativeStock: number;
  overReserved: number;
  doubleDelivered: number;
  activeRepsPerDriver: number;
  deliveredNotDeducted: number;
  duplicateOutbound: number;
}

function inspect(into: Checks) {
  return (app: App) => {
    const db = app.ctx.db;
    const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    into.realAdapters = !app.ctx.sms.current?.simulated || !app.ctx.telegram.current?.simulated || !app.ctx.maps.simulated;
    into.negativeStock = one(`SELECT COUNT(*) AS c FROM stock_levels WHERE quantity < 0 OR reserved < 0`);
    into.overReserved = one(`SELECT COUNT(*) AS c FROM stock_levels WHERE reserved > quantity`);
    into.doubleDelivered = one(`SELECT COUNT(*) AS c FROM (SELECT order_id FROM order_events WHERE to_status = 'delivered' GROUP BY order_id HAVING COUNT(*) > 1)`);
    into.activeRepsPerDriver = one(
      `SELECT COALESCE(MAX(n), 0) AS c FROM (SELECT COUNT(*) AS n FROM replenishments WHERE status IN ('proposed','awaiting_management','approved','awaiting_driver','en_route','awaiting_pickup') GROUP BY driver_id)`,
    );
    into.deliveredNotDeducted = one(`SELECT COUNT(*) AS c FROM orders WHERE status = 'delivered' AND stock_state <> 'deducted'`);
    into.duplicateOutbound = one(`SELECT COUNT(*) AS c FROM (SELECT idempotency_key FROM messages WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING COUNT(*) > 1)`);
  };
}

describe('Hel arbejdsdag i Demo Mode', () => {
  let first: SimResult;
  const checks = {} as Checks;

  it('gennemfører dagen med fejl, opfyldning, ledelse og rapporter – uden dataintegritetsfejl', async () => {
    first = await runDaySimulation({ ...small, strategy: 'economic', inspect: inspect(checks) });
    const m = first.metrics;
    expect(m.ordersGenerated).toBe(45);
    expect(m.ordersAccepted).toBeGreaterThan(35);
    expect(m.delivered).toBeGreaterThan(30);
    // Hver accepteret ordre ender som leveret, annulleret eller uafklaret – intet forsvinder
    expect(m.delivered + m.cancelled + m.unresolved).toBe(m.ordersAccepted);
    expect(m.revenueOre).toBeGreaterThan(0);
    expect(m.contributionOre).toBeGreaterThan(0);
    expect(m.contributionOre).toBeLessThan(m.revenueOre);
    expect(m.integrationFailures).toBe(2); // Telegram- og Maps-udfald
    expect(m.hourlyReportsSent).toBe(12); // 10–22: én pr. hele time i åbningstiden
    expect(m.alertsRaised).toBeGreaterThan(0);
    expect(m.alertsByCategory.takeover).toBeGreaterThan(0); // Telegram-udfald → menneskelig overtagelse
    expect(first.log.some((l) => /Telegram-udfald starter/.test(l))).toBe(true);
    // Integritet
    expect(checks).toEqual({
      realAdapters: false,
      negativeStock: 0,
      overReserved: 0,
      doubleDelivered: 0,
      activeRepsPerDriver: expect.any(Number),
      deliveredNotDeducted: 0,
      duplicateOutbound: 0,
    });
    expect(checks.activeRepsPerDriver).toBeLessThanOrEqual(1);
  }, 240_000);

  it('er reproducerbar med samme seed', async () => {
    const again = await runDaySimulation({ ...small, strategy: 'economic' });
    const strip = (m: SimulationMetrics) => ({ ...m, wallClockMs: 0 });
    expect(strip(again.metrics)).toEqual(strip(first.metrics));
  }, 240_000);

  it('strategierne får de samme ordrer og accepterer de samme gyldige ordrer', async () => {
    const fifo = await runDaySimulation({ ...small, strategy: 'fifo' });
    expect(fifo.metrics.ordersGenerated).toBe(first.metrics.ordersGenerated);
    expect(fifo.metrics.ordersAccepted).toBe(first.metrics.ordersAccepted);
    const c = compareStrategies([fifo.metrics, first.metrics]);
    expect(Object.keys(c.best).length).toBeGreaterThan(5);
    const md = comparisonMarkdown(c, small);
    expect(md).toMatch(/SIMULEREDE DATA/);
    expect(md).toMatch(/beviser ikke ydeevne/);
  }, 240_000);
});

describe('Dispatchstrategier (kerne)', () => {
  const res = (insertIndex: number, feasible: boolean, score: number, extra: number, eta: number): InsertionResult =>
    ({ insertIndex, feasible, violations: [], sequence: [], etas: [], baseline: [], analysis: { score, extraDriveMinutes: extra, newOrderEtaMinutes: eta } }) as unknown as InsertionResult;
  const results = [res(0, true, 900, 6, 10), res(1, true, 700, 2, 25), res(2, true, 500, 4, 40)];

  it('vælger placering efter strategi – med de samme hårde begrænsninger', () => {
    expect(chooseInsertion(results, 'economic')!.insertIndex).toBe(0);
    expect(chooseInsertion(results, 'shortest_detour')!.insertIndex).toBe(1);
    expect(chooseInsertion(results, 'fifo')!.insertIndex).toBe(2); // altid bagerst
    // Er det bagerste ikke gyldigt, rykker først-til-mølle ikke ordren frem
    expect(chooseInsertion([results[0], results[1], res(2, false, 0, 1, 99)], 'fifo')).toBeNull();
    expect(chooseInsertion([res(0, false, 999, 0, 1)], 'economic')).toBeNull();
  });

  it('rangerer chauffører efter strategi', () => {
    const a = res(0, true, 100, 9, 12);
    const b = res(0, true, 200, 3, 30);
    expect([a, b].sort(compareByStrategy('economic'))[0]).toBe(b);
    expect([a, b].sort(compareByStrategy('shortest_detour'))[0]).toBe(b);
    expect([a, b].sort(compareByStrategy('fifo'))[0]).toBe(a); // tidligste levering
  });

  it('sammenligningen viser ærligt, hvor den økonomiske strategi ikke er bedst', () => {
    const base = { seed: 1, lateShare: 10, avgDeliveryMinutes: 40 } as unknown as SimulationMetrics;
    const eco = { ...base, strategy: 'economic', contributionOre: 200_000, delivered: 100, lateShare: 20 } as SimulationMetrics;
    const fifo = { ...base, strategy: 'fifo', contributionOre: 150_000, delivered: 90, lateShare: 12 } as SimulationMetrics;
    const c = compareStrategies([fifo, eco]);
    expect(c.best.contributionOre).toEqual(['economic']);
    expect(c.best.lateShare).toEqual(['fifo']);
    expect(c.economicNotBest).toContain('Andel forsinkede (%)');
    expect(c.summary.at(-1)).toMatch(/IKKE bedst/);
  });
});
