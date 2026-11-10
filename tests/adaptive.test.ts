import { afterEach, describe, expect, it } from 'vitest';
import { clock } from '../src/server/clock';
import {
  DEFAULT_ADAPTIVE,
  adaptiveCost,
  chooseAdaptive,
  evaluateInsertions,
  nextLoadLevel,
  promiseProtected,
  type InsertionArgs,
  type InsertionResult,
} from '../src/core/routePlanning';
import { runDaySimulation } from '../src/server/sim/daySimulation';
import { km, placeOrder, type TestApp } from './helpers';
import { opsApp, phone, route, groupOut } from './ops-fixture';
import { defaultSettings } from '../src/server/defaultSettings';

/**
 * Regressionstests for Etape 4.1: adaptiv hybridstrategi, løftebeskyttelse,
 * påfyldning ved lagerbesøg, færre dobbelte indgreb og simuleringsfejl.
 */
const econ = defaultSettings('demo').economics;
const A = DEFAULT_ADAPTIVE;
let t: TestApp | null = null;
afterEach(async () => {
  clock.reset();
  await t?.app.stop();
  t = null;
});

/** Rute langs en linje: anker i 0, stop i 2, 4, 6 km (500 m/min); ny ordre et givet sted. */
function args(newAt: number, promised: (number | null)[]): InsertionArgs {
  const pos = [0, 2, 4, 6];
  const now = 0;
  const point = (node: number) => (node === -1 ? 0 : node === 3 ? newAt : pos[node + 1]);
  return {
    nowMs: now,
    anchor: { kind: 'delivered', atMs: now, reportedAtMs: now, orderId: null },
    existing: [0, 1, 2].map((i) => ({ orderId: i + 1, promisedMs: promised[i], extraDelayMs: 0, value: { revenueOre: 10000, contributionOre: 5000, contributionEstimated: false } })),
    lockedCount: 0,
    newOrder: { orderId: 99, value: { revenueOre: 10000, contributionOre: 5000, contributionEstimated: false } },
    travel: (from, to) => Math.abs(point(from) - point(to)) * 120,
    eta: { serviceMinutes: 3, staleMinutes: 60, biasMinutes: 0 },
    econ,
    reassignment: false,
  };
}

describe('Belastningsniveau med hysterese', () => {
  it('skifter først når grænsen passeres tydeligt og ikke frem og tilbage omkring en grænse', () => {
    expect(nextLoadLevel('low', 0.59, 60, A)).toBe('low');
    expect(nextLoadLevel('low', 0.61, 60, A)).toBe('medium');
    // Lige under op-grænsen igen → bliver på mellem (ned-grænsen er 0,4)
    expect(nextLoadLevel('medium', 0.55, 60, A)).toBe('medium');
    expect(nextLoadLevel('medium', 0.39, 60, A)).toBe('low');
    expect(nextLoadLevel('medium', 1.2, 60, A)).toBe('high');
    expect(nextLoadLevel('high', 0.95, 60, A)).toBe('high');
    expect(nextLoadLevel('high', 0.8, 60, A)).toBe('medium');
    // Mindste opholdstid forhindrer hurtige skift – undtagen et spring over to niveauer
    expect(nextLoadLevel('low', 0.8, 3, A)).toBe('low');
    expect(nextLoadLevel('low', 1.5, 3, A)).toBe('high');
  });
});

describe('Løftebeskyttelse', () => {
  it('ved lav belastning rykkes lovede stop ikke, hvis der findes en anden placering', () => {
    // Ny ordre ved 3 km: indsættelse midt i ruten rykker stop 2 og 3 (begge lovet)
    const res = evaluateInsertions(args(3, [10 * 60000, 25 * 60000, 40 * 60000]));
    const front = res.find((r) => r.insertIndex === 1)!;
    expect(front.promise.delayedPromised).toBeGreaterThan(0);
    expect(promiseProtected(front, 'low', A)).toBe(false);
    const { best } = chooseAdaptive(res, 'low', econ, A);
    expect(best!.promise.delayedPromised === 0 || best!.promise.maxPromisedDelay <= 1).toBe(true);
  });

  it('ved mellem belastning må et lovet stop kun rykkes kort og med margin til løftet', () => {
    const res = evaluateInsertions(args(3, [10 * 60000, 60 * 60000, 80 * 60000]));
    for (const r of res.filter((x) => promiseProtected(x, 'medium', A))) {
      expect(r.promise.maxPromisedDelay <= A.maxPromisedDelayMedium || r.promise.delayedPromised === 0).toBe(true);
      expect(r.promise.minSlackAfter == null || r.promise.minSlackAfter >= A.protectBufferMinutes).toBe(true);
    }
  });

  it('findes ingen beskyttet placering, bruges den mindst skadelige gyldige (ordren afvises ikke)', () => {
    // Alle stop er lovet stramt, så enhver placering foran dem rykker et løfte
    const res = evaluateInsertions(args(1, [5 * 60000, 10 * 60000, 14 * 60000]));
    const c = chooseAdaptive(res, 'low', econ, A);
    expect(c.relaxed).not.toBeNull();
  });

  it('ved lav belastning foretrækkes hurtigst levering; ved høj belastning mindst køretid', () => {
    const res = evaluateInsertions(args(3, [null, null, null]));
    const low = [...res].sort((a, b) => adaptiveCost(a, 'low', econ) - adaptiveCost(b, 'low', econ))[0];
    const high = [...res].sort((a, b) => adaptiveCost(a, 'high', econ) - adaptiveCost(b, 'high', econ))[0];
    expect(low.newEtaMinutesExact).toBeLessThanOrEqual(high.newEtaMinutesExact);
    expect(high.extraDriveMinutesExact).toBeLessThanOrEqual(low.extraDriveMinutesExact);
  });

  it('ordreværdien vægter højst 1,25× – store ordrer springer ikke foran af værdi alene', () => {
    const r = evaluateInsertions(args(3, [null, null, null]))[0] as InsertionResult;
    const big = { ...r, analysis: { ...r.analysis, contributionOre: 1_000_000 } };
    const small = { ...r, analysis: { ...r.analysis, contributionOre: 100 } };
    const diff = adaptiveCost(small, 'high', econ) - adaptiveCost(big, 'high', econ);
    expect(diff).toBeLessThanOrEqual(r.newEtaMinutesExact * econ.waitCostPerMinuteOre * 0.25 + 1);
  });
});

describe('Adaptiv dispatch i systemet', () => {
  it('lavværdiordre accepteres og tildeles; beslutningen begrundes med belastningsniveau', async () => {
    const s = await opsApp();
    t = s.t;
    const { app } = t;
    app.ctx.settings.update({ economics: { strategy: 'adaptive' } });
    const cheap = app.ctx.catalog.create({ sku: 'CHEAP', name: 'Tyggegummi', category: 'Slik', priceOre: 500, costOre: 480 });
    app.ctx.inventory.adjust(s.anna.vehicleLocationId!, cheap.id, 5, 'test', 'system');
    const id = placeOrder(app.ctx, { phone: phone(), at: km(1, 0), lines: [{ productId: cheap.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    app.agents.dispatch.enqueue(id);
    await t.run();
    const offer = app.ctx.drivers.offers(id).find((o) => o.status === 'pending');
    expect(offer).toBeTruthy();
    expect(offer!.plan!.analysis.explanation.join(' ')).toMatch(/Adaptiv strategi – belastning lav/);
  });

  it('belastningen måles i kapacitet (arbejdstimer pr. aktiv chauffør), ikke i antal ordrer', async () => {
    const s = await opsApp();
    t = s.t;
    const { app } = t;
    expect(app.agents.routing.loadState()).toMatchObject({ level: 'low', activeDrivers: 2 });
    const ids: number[] = [];
    for (let i = 1; i <= 6; i++) ids.push(placeOrder(app.ctx, { phone: phone(), at: km(i * 3, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! }));
    await route(app, s.anna.id, ids);
    const st = app.agents.routing.loadState();
    expect(st.value).toBeGreaterThan(0.3); // ca. 50 min arbejde fordelt på 2 aktive chauffører
    // Samme ordrer, men kun én aktiv chauffør → dobbelt så høj belastning
    app.ctx.drivers.setStatus(s.bo.id, 'offline');
    const one = app.agents.routing.loadState();
    expect(one.activeDrivers).toBe(1);
    expect(one.value).toBeCloseTo(st.value * 2, 1);
  });
});

describe('Lageropfyldning og ledelsesindgreb', () => {
  it('lagerbesøg fylder bilen op efter de seneste 2 timers salg, og påfyldningen flyttes ved afhentning', async () => {
    const s = await opsApp();
    t = s.t;
    const { app } = t;
    app.ctx.settings.update({ replenishment: { topUpHorizonMinutes: 90, topUpMaxUnits: 40 } });
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) ids.push(placeOrder(app.ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 2 }], locationId: i <= 5 ? s.anna.vehicleLocationId! : s.central }));
    await route(app, s.anna.id, ids);
    await t.run();
    const rep = app.agents.replenishment.list({ activeOnly: true })[0];
    expect(rep.analysis?.topUp?.length).toBeGreaterThan(0);
    expect(groupOut(app.ctx).some((m) => /Påfyldning \(ekstra lager til kommende ordrer\)/.test(m))).toBe(true);
    const topUp = rep.analysis!.topUp!.reduce((a, x) => a + x.quantity, 0);
    app.agents.replenishment.approve(rep.id, { name: 'Test', source: 'staff' });
    await app.agents.replenishment.driverRespond(rep.id, s.anna.id, true);
    const before = app.ctx.inventory.levels().find((l) => l.locationId === s.anna.vehicleLocationId && l.productId === s.cola.id)!.quantity;
    await app.agents.replenishment.driverPickedUp(rep.id, s.anna.id);
    const after = app.ctx.inventory.levels().find((l) => l.locationId === s.anna.vehicleLocationId && l.productId === s.cola.id)!.quantity;
    expect(after - before).toBe(4 + topUp);
  });

  it('samme opfyldningsbeslutning giver ikke et ekstra ledelsesindgreb i overvågningen', async () => {
    const s = await opsApp();
    t = s.t;
    const { app } = t;
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) ids.push(placeOrder(app.ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 2 }], locationId: i <= 5 ? s.anna.vehicleLocationId! : s.central }));
    await route(app, s.anna.id, ids);
    await t.run();
    await app.agents.monitor.evaluate();
    const shortage = app.agents.monitor.list().find((a) => a.rule === 'stock_shortage')!;
    expect(shortage.category).toBe('auto');
    // Med v0.4.0-reglerne talte den som en selvstændig godkendelse
    app.ctx.settings.update({ monitoring: { dedupeLinkedDecisions: false } });
    app.ctx.db.prepare(`DELETE FROM monitor_decisions`).run();
    app.ctx.db.prepare(`DELETE FROM monitor_alerts`).run();
    await app.agents.monitor.evaluate();
    expect(app.agents.monitor.list().find((a) => a.rule === 'stock_shortage')!.category).toBe('approval');
  });
});

describe('Simuleringen (regression)', () => {
  it('botten genbesøger aldrig en leveret ordre, og løfterne er ikke systematisk for optimistiske', async () => {
    const r = await runDaySimulation({ seed: 5, orders: 60, drivers: 4, strategy: 'adaptive' });
    expect(r.metrics.botRevisits).toBe(0);
    const d = r.metrics.promiseDiagnostics!;
    for (const k of ['pos0', 'pos1', 'pos2plus'] as const) if (d[k].n >= 5) expect(Math.abs(d[k].meanErr)).toBeLessThan(5);
    expect(r.metrics.delivered + r.metrics.cancelled + r.metrics.unresolved).toBe(r.metrics.ordersAccepted);
  }, 240_000);
});

describe('Standardindstillinger (v0.4.1)', () => {
  it('adaptiv strategi er standard; valgfrie omfordelingsforslag tæller ikke som ledelsesindgreb', async () => {
    expect(defaultSettings('demo').economics.strategy).toBe('adaptive');
    const s = await opsApp();
    t = s.t;
    clock.set(() => t!.clock.t);
    const { app } = t;
    const id = placeOrder(app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await route(app, s.anna.id, [id]);
    const now = clock.now();
    app.ctx.db.prepare(`UPDATE orders SET eta_communicated = ?, eta = ?, eta_confidence = 'low' WHERE id = ?`).run(new Date(now + 10 * 60000).toISOString(), new Date(now + 12 * 60000).toISOString(), id);
    app.ctx.db.prepare(`INSERT INTO reassignment_suggestions (order_id, from_driver_id, to_driver_id, reason, created_at) VALUES (?, ?, ?, 'test', ?)`).run(id, s.anna.id, s.bo.id, clock.iso());
    await app.agents.monitor.evaluate();
    expect(app.agents.monitor.list().find((x) => x.rule === 'promise_risk')).toMatchObject({ category: 'auto' });
  });
});
