import { afterEach, describe, expect, it } from 'vitest';
import { clock } from '../src/server/clock';
import { km, placeOrder, type TestApp } from './helpers';
import { opsApp, phone, route, groupOut, sevenStops } from './ops-fixture';
import type { App } from '../src/server/app';

/** Proaktiv ledelsesassistent: klassifikation A/B/C/D, dedupe, eskalering og log. */
let t: TestApp;
afterEach(async () => {
  clock.reset();
  await t?.app.stop();
});

const MIN = 60_000;

async function setup() {
  const s = await opsApp();
  t = s.t;
  clock.set(() => t.clock.t);
  return s;
}

const alerts = (app: App) => app.agents.monitor.list({ status: ['open', 'acknowledged'] });
const alertMsgs = (app: App) => groupOut(app.ctx).filter((m) => /Orientering|Kræver godkendelse|KRÆVER OVERTAGELSE|Løst/.test(m));

function setPromise(app: App, id: number, promisedMs: number, etaMs: number, confidence = 'medium') {
  app.ctx.db
    .prepare(`UPDATE orders SET eta_communicated = ?, eta = ?, eta_confidence = ? WHERE id = ?`)
    .run(new Date(promisedMs).toISOString(), new Date(etaMs).toISOString(), confidence, id);
}

describe('Proaktiv overvågning', () => {
  it('kritisk forsinkelse eskalerer A → B → D, med én besked pr. eskalering og automatisk lukning', async () => {
    const s = await setup();
    const { app } = t;
    const id = placeOrder(app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await route(app, s.anna.id, [id]);
    const now = clock.now();
    // A: lidt forsinket → automatisk (kunden opdateres), ingen besked
    setPromise(app, id, now - 8 * MIN, now + 1 * MIN);
    await app.agents.monitor.evaluate();
    expect(alerts(app)).toEqual([expect.objectContaining({ rule: 'critical_delay', category: 'auto' })]);
    expect(alertMsgs(app)).toHaveLength(0);
    // B: 20 min → orientering
    setPromise(app, id, now - 20 * MIN, now);
    await app.agents.monitor.evaluate();
    await app.agents.monitor.evaluate();
    await app.agents.monitor.evaluate();
    expect(alerts(app)).toHaveLength(1);
    expect(alerts(app)[0]).toMatchObject({ category: 'inform', occurrences: 4 });
    expect(alertMsgs(app)).toHaveLength(1); // ingen gentagelser
    // D: 45 min → menneskelig overtagelse, ordren markeres
    setPromise(app, id, now - 45 * MIN, now);
    await app.agents.monitor.evaluate();
    expect(alerts(app)[0].category).toBe('takeover');
    expect(app.ctx.orders.get(id)!.needsAttention).toBe(true);
    expect(alertMsgs(app)).toHaveLength(2);
    expect(alertMsgs(app)[1]).toMatch(/KRÆVER OVERTAGELSE/);
    // Leveret → advarslen lukkes, og ledelsen får besked om løsningen
    app.ctx.orders.transition(id, 'out_for_delivery', 'driver');
    app.ctx.orders.transition(id, 'delivered', 'driver');
    const r = await app.agents.monitor.evaluate();
    expect(r.resolved).toBe(1);
    expect(alerts(app)).toHaveLength(0);
    expect(alertMsgs(app).at(-1)).toMatch(/Løst/);
    // Alle beslutninger er logget
    const d = app.agents.monitor.decisions().map((x) => x.decision);
    expect(d.some((x) => /Ny hændelse/.test(x))).toBe(true);
    expect(d.filter((x) => /Eskaleret/.test(x))).toHaveLength(2);
    expect(d.some((x) => /Løst/.test(x))).toBe(true);
    expect(d.some((x) => /Automatisk handling udført/.test(x))).toBe(true);
  });

  it('chauffør svarer ikke: orientering, derefter overtagelse', async () => {
    const s = await setup();
    const { app } = t;
    const id = placeOrder(app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await route(app, s.anna.id, [id]);
    app.ctx.db.prepare(`UPDATE drivers SET last_status_at = ? WHERE id = ?`).run(new Date(clock.now() - 30 * MIN).toISOString(), s.anna.id);
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((a) => a.rule === 'driver_unresponsive')).toMatchObject({ category: 'inform' });
    t.clock.t += 25 * MIN;
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((a) => a.rule === 'driver_unresponsive')).toMatchObject({ category: 'takeover' });
  });

  it('manglende chaufførkapacitet og kraftigt stigende ordretilgang', async () => {
    const s = await setup();
    const { app } = t;
    const now = clock.now();
    const ids: number[] = [];
    for (let i = 0; i < 9; i++) ids.push(placeOrder(app.ctx, { phone: phone(), at: km(1, i * 0.2), lines: [{ productId: s.chips.id, quantity: 1 }], locationId: s.central }));
    // Bekræftet for 12 min siden (ordretilgang inden for seneste 30 min)
    app.ctx.db.prepare(`UPDATE orders SET confirmed_at = ? WHERE id IN (${ids.join(',')})`).run(new Date(now - 12 * MIN).toISOString());
    await app.agents.monitor.evaluate();
    const a = alerts(app);
    expect(a.find((x) => x.rule === 'capacity_shortage')).toMatchObject({ category: 'inform' });
    expect(a.find((x) => x.key === 'order_volume_change:up')).toMatchObject({ category: 'inform' });
    t.clock.t += 10 * MIN;
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((x) => x.rule === 'capacity_shortage')).toMatchObject({ category: 'takeover' });
  });

  it('lagerunderskud med forslag til godkendelse: kategori C uden dobbelt besked; godkendelse der udløber', async () => {
    const s = await setup();
    const { app } = t;
    await sevenStops(t, s);
    const rep = app.agents.replenishment.list({ activeOnly: true })[0];
    expect(rep.status).toBe('awaiting_management');
    const before = groupOut(app.ctx).length;
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((x) => x.rule === 'stock_shortage')).toMatchObject({ category: 'approval' });
    expect(groupOut(app.ctx).length).toBe(before); // forslaget er allerede sendt med knapper
    // Deadline nærmer sig
    app.ctx.db.prepare(`UPDATE replenishments SET deadline_at = ? WHERE id = ?`).run(new Date(clock.now() + 3 * MIN).toISOString(), rep.id);
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((x) => x.rule === 'approval_expiring')).toMatchObject({ category: 'approval', severity: 'critical' });
  });

  it('integrationsfejl: Telegram nede → overtagelse; genoprettet → lukket. Kvitteret advarsel forbliver tavs', async () => {
    await setup();
    const { app } = t;
    app.ctx.integrations.set('telegram', 'error', 'Ingen forbindelse');
    await app.agents.monitor.evaluate();
    const a = alerts(app).find((x) => x.rule === 'integration_failure')!;
    expect(a.category).toBe('takeover');
    expect(app.ctx.events.list({ minLevel: 'critical' }).some((e) => e.type === 'alert_integration_failure')).toBe(true);
    app.agents.monitor.acknowledge(a.id, 'Lise');
    await app.agents.monitor.evaluate();
    await app.agents.monitor.evaluate();
    expect(app.agents.monitor.list().filter((x) => x.rule === 'integration_failure')).toHaveLength(1);
    app.ctx.integrations.set('telegram', 'simulated', 'ok');
    await app.agents.monitor.evaluate();
    expect(app.agents.monitor.list().find((x) => x.id === a.id)!.status).toBe('resolved');
    // Maps-fejl er en orientering (fallback håndterer køretider)
    app.ctx.integrations.set('maps', 'error', 'API-fejl');
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((x) => x.key === 'integration_failure:maps')).toMatchObject({ category: 'inform' });
  });

  it('risiko for brud på løfte: automatisk overvågning, eller godkendelse når et omfordelingsforslag findes', async () => {
    const s = await setup();
    const { app } = t;
    const id = placeOrder(app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await route(app, s.anna.id, [id]);
    const now = clock.now();
    setPromise(app, id, now + 10 * MIN, now + 12 * MIN, 'low');
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((x) => x.rule === 'promise_risk')).toMatchObject({ category: 'auto' });
    app.ctx.db
      .prepare(`INSERT INTO reassignment_suggestions (order_id, from_driver_id, to_driver_id, reason, created_at) VALUES (?, ?, ?, 'test', ?)`)
      .run(id, s.anna.id, s.bo.id, clock.iso());
    await app.agents.monitor.evaluate();
    expect(alerts(app).find((x) => x.rule === 'promise_risk')).toMatchObject({ category: 'approval' });
  });
});
