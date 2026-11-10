import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { km, placeOrder, TestMaps, type TestApp } from './helpers';
import { opsApp, opsData, sevenStops, press, lastGroup, groupOut, route, phone } from './ops-fixture';
import { createApp, type App } from '../src/server/app';
import { MemorySecretStore } from '../src/server/secrets';
import { SimulatedSmsAdapter } from '../src/server/adapters/sms/simulator';
import { SimulatedTelegramAdapter } from '../src/server/adapters/telegram/simulator';
import { forecastVehicleStock } from '../src/core/replenishment';

/**
 * Proaktiv lageropfyldning – demo-scenarierne 5–15. Ingen API-nøgler.
 */
let t: TestApp;
afterEach(async () => t?.app.stop());

const level = (app: App, loc: number, pid: number) => app.ctx.inventory.levels().find((l) => l.locationId === loc && l.productId === pid) ?? { quantity: 0, reserved: 0 };

describe('Lagerprognose (kerne)', () => {
  it('lager efter hvert stop og første underskud', () => {
    const f = forecastVehicleStock({ 1: 10 }, Array.from({ length: 7 }, (_, i) => ({ orderId: i + 1, needs: { 1: 2 } })), []);
    expect(f.after.map((a) => a[1])).toEqual([8, 6, 4, 2, 0, 0, 0]);
    expect(f.shortages).toEqual([{ productId: 1, missing: 4, firstStopIndex: 5 }]);
    const g = forecastVehicleStock({ 1: 10 }, Array.from({ length: 7 }, (_, i) => ({ orderId: i + 1, needs: { 1: 2 } })), [{ afterIndex: 3, items: { 1: 4 } }]);
    expect(g.shortages).toEqual([]);
    expect(g.after[6][1]).toBe(0);
  });
});

describe('Opfyldningsflow', () => {
  it('5–10: lager til 5 af 7 stop → forslag efter stop 4 → godkendt → chaufføraccept → afhentning → lager opdateret', async () => {
    const s = await opsApp();
    t = s.t;
    const { ctx } = t.app;
    const ids = await sevenStops(t, s);
    // 5: prognosen opdager manglen før stop 6
    const f = t.app.agents.replenishment.forecast(s.anna.id);
    expect(f.shortages).toEqual([expect.objectContaining({ productId: s.cola.id, missing: 4, firstStopOrderId: ids[5] })]);
    // 6: forslag efter stop 4 sendt til ledelsen
    const rep = t.app.agents.replenishment.list({ activeOnly: true })[0];
    expect(rep.status).toBe('awaiting_management');
    expect(rep.afterOrderId).toBe(ids[3]);
    expect(rep.items).toEqual([expect.objectContaining({ productId: s.cola.id, quantity: 4 })]);
    const msg = lastGroup(ctx);
    for (const part of ['Chauffør: Anna', 'Aktuelt lager', 'Resterende behov', 'Manglende varer', 'Foreslået lager: Centrallager', 'efter stop 4', 'Afhent: 4× Coca-Cola', 'Ekstra køretid', 'Effekt', 'Alternativer', 'Begrundelse']) {
      expect(msg).toContain(part);
    }
    // Stop 6 og 7 er usikre, indtil opfyldningen er accepteret
    expect(ctx.orders.get(ids[5])!.etaConfidence).toBe('low');
    expect(ctx.drivers.routeStops(s.anna.id)[5].etaBasis).toMatch(/afventer godkendelse/);
    const vehicleBefore = level(t.app, s.anna.vehicleLocationId!, s.cola.id).quantity;
    // 7: ledelsen godkender
    press(t, 'manager', `rep:${rep.id}:approve`);
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!.status).toBe('awaiting_driver');
    expect(level(t.app, s.anna.vehicleLocationId!, s.cola.id).quantity).toBe(vehicleBefore); // godkendelse ≠ varer i bilen
    // 8: chaufføren accepterer
    t.tg.injectCallback(s.anna.telegramUserId!, 'Anna', `rep:${rep.id}:driver_accept`);
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!.status).toBe('en_route');
    expect(ctx.drivers.routeStops(s.anna.id)[5].etaBasis).not.toMatch(/afventer/);
    expect(level(t.app, s.anna.vehicleLocationId!, s.cola.id).quantity).toBe(vehicleBefore);
    // 9: fysisk afhentning bekræftet
    const centralBefore = level(t.app, s.central, s.cola.id);
    t.tg.injectText(s.anna.telegramUserId!, 'Anna', 'Afhentet');
    await t.run();
    const done = t.app.agents.replenishment.get(rep.id)!;
    expect(done.status).toBe('completed');
    // 10: lageret er flyttet korrekt (beholdning og reservation)
    expect(level(t.app, s.anna.vehicleLocationId!, s.cola.id).quantity).toBe(vehicleBefore + 4);
    expect(level(t.app, s.central, s.cola.id).quantity).toBe(centralBefore.quantity - 4);
    expect(level(t.app, s.central, s.cola.id).reserved).toBe(centralBefore.reserved - 4);
    expect(ctx.orders.get(ids[6])!.stockLocationId).toBe(s.anna.vehicleLocationId);
    expect(t.app.agents.replenishment.forecast(s.anna.id).shortages).toEqual([]);
    // Dobbelt bekræftelse giver ikke dobbelt opfyldning
    expect(await t.app.agents.replenishment.driverPickedUp(rep.id, s.anna.id)).toMatch(/allerede/);
    expect(level(t.app, s.anna.vehicleLocationId!, s.cola.id).quantity).toBe(vehicleBefore + 4);
    const statuses = t.app.agents.replenishment.events(rep.id).map((e) => e.toStatus);
    expect(statuses).toEqual(['proposed', 'awaiting_management', 'approved', 'awaiting_driver', 'en_route', 'picked_up', 'completed']);
  });

  it('11: ledelsen afviser → nyt alternativt forslag uden den afviste mulighed', async () => {
    const s = await opsApp();
    t = s.t;
    const ids = await sevenStops(t, s);
    const rep = t.app.agents.replenishment.list({ activeOnly: true })[0];
    press(t, 'manager', `rep:${rep.id}:reject`);
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!.status).toBe('rejected');
    const next = t.app.agents.replenishment.list({ activeOnly: true })[0];
    expect(next.id).not.toBe(rep.id);
    expect(next.status).toBe('awaiting_management');
    expect(next.afterOrderId).not.toBe(rep.afterOrderId);
    expect(ids.slice(0, 5)).toContain(next.afterOrderId);
    expect(lastGroup(t.app.ctx)).toMatch(/Alternativt forslag/);
  });

  it('observatør kan ikke godkende; "vis alternativer" er tilladt', async () => {
    const s = await opsApp();
    t = s.t;
    await sevenStops(t, s);
    const rep = t.app.agents.replenishment.list({ activeOnly: true })[0];
    press(t, 'observer', `rep:${rep.id}:approve`);
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!.status).toBe('awaiting_management');
    expect(lastGroup(t.app.ctx)).toMatch(/Kun ledere og administratorer/);
    press(t, 'observer', `rep:${rep.id}:alts`);
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/Alternativer for opfyldning/);
  });

  it('12: ledelsen svarer ikke → påmindelse, eskalering før sidste sikre punkt, og nyt forslag ved udløb', async () => {
    const s = await opsApp();
    t = s.t;
    const { ctx } = t.app;
    const ids = await sevenStops(t, s);
    const rep = t.app.agents.replenishment.list({ activeOnly: true })[0];
    ctx.db.prepare(`UPDATE replenishments SET sent_at = ? WHERE id = ?`).run(new Date(Date.now() - 11 * 60000).toISOString(), rep.id);
    await t.app.agents.replenishment.tick();
    await t.run();
    expect(groupOut(ctx).some((m) => /Påmindelse: Opfyldning #/.test(m))).toBe(true);
    ctx.db.prepare(`UPDATE replenishments SET deadline_at = ? WHERE id = ?`).run(new Date(Date.now() + 5 * 60000).toISOString(), rep.id);
    await t.app.agents.replenishment.tick();
    await t.run();
    expect(groupOut(ctx).some((m) => /HASTER/.test(m))).toBe(true);
    expect(ctx.events.list({ onlyOpen: true }).some((e) => e.type === 'escalated')).toBe(true);
    ctx.db.prepare(`UPDATE replenishments SET deadline_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), rep.id);
    await t.app.agents.replenishment.tick();
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!.status).toBe('expired');
    expect(ctx.orders.get(ids[5])!.needsAttention).toBe(true);
    const next = t.app.agents.replenishment.list({ activeOnly: true })[0];
    expect(next?.status).toBe('awaiting_management'); // aldrig stiltiende umulig levering
  });

  it('13: en ny ordre ændrer opfyldningsbehovet → forslaget opdateres', async () => {
    const s = await opsApp();
    t = s.t;
    const ids = await sevenStops(t, s);
    const rep = t.app.agents.replenishment.list({ activeOnly: true })[0];
    const extra = placeOrder(t.app.ctx, { phone: phone(), at: km(8, 0), lines: [{ productId: s.cola.id, quantity: 3 }], locationId: s.central });
    await t.app.agents.dispatch.assign(extra, s.anna.id, 'staff');
    await t.run();
    const updated = t.app.agents.replenishment.get(rep.id)!;
    expect(updated.status).toBe('awaiting_management');
    expect(updated.coversOrders.sort()).toEqual([ids[5], ids[6], extra].sort());
    expect(updated.items[0].quantity).toBe(7);
    expect(lastGroup(t.app.ctx)).toMatch(/Opdateret forslag/);
    // Annulleres de ordrer der kræver varer fra lager, er opfyldningen ikke længere nødvendig
    for (const id of [ids[5], ids[6], extra]) t.app.ctx.orders.cancel(id, 'test', 'staff');
    await t.app.agents.routing.refreshEtas(s.anna.id, 'test');
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!.status).toBe('cancelled');
  });

  it('chaufførens lagermelding flytter ordrer til lageret og udløser forslag', async () => {
    const s = await opsApp();
    t = s.t;
    const ids: number[] = [];
    for (let i = 1; i <= 4; i++) ids.push(placeOrder(t.app.ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 2 }], locationId: s.anna.vehicleLocationId! }));
    await route(t.app, s.anna.id, ids);
    await t.run();
    expect(t.app.agents.replenishment.list({ activeOnly: true })).toHaveLength(0);
    t.tg.injectText(s.anna.telegramUserId!, 'Anna', 'Jeg har kun 4 cola tilbage');
    await t.run();
    expect(level(t.app, s.anna.vehicleLocationId!, s.cola.id).quantity).toBe(4);
    expect(t.app.ctx.orders.get(ids[2])!.stockLocationId).toBe(s.central);
    expect(t.app.ctx.orders.get(ids[3])!.stockLocationId).toBe(s.central);
    const rep = t.app.agents.replenishment.list({ activeOnly: true })[0];
    expect(rep.coversOrders.sort()).toEqual([ids[2], ids[3]].sort());
  });

  it('14: flere chauffører konkurrerer om samme centrallagerbeholdning → ingen dobbeltreservation', async () => {
    const s = await opsApp();
    t = s.t;
    const { ctx } = t.app;
    // Kun 5 ledige cola på centrallageret
    ctx.inventory.adjust(s.central, s.cola.id, -95, 'test');
    const a = [1, 2, 3].map((i) => placeOrder(ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 3 }], locationId: s.anna.vehicleLocationId! }));
    const b = [1, 2, 3].map((i) => placeOrder(ctx, { phone: phone(), at: km(i, 3), lines: [{ productId: s.cola.id, quantity: 3 }], locationId: s.bo.vehicleLocationId! }));
    await route(t.app, s.anna.id, a);
    await route(t.app, s.bo.id, b);
    await t.run();
    // Begge melder for lidt i bilen – samme centrallager skal dække
    t.tg.injectText(s.anna.telegramUserId!, 'Anna', 'Jeg har kun 6 cola tilbage');
    t.tg.injectText(s.bo.telegramUserId!, 'Bo', 'Jeg har kun 6 cola tilbage');
    await t.run();
    const central = level(t.app, s.central, s.cola.id);
    expect(central.reserved).toBeLessThanOrEqual(central.quantity);
    expect(central.reserved).toBe(3); // kun én ordre kunne dækkes
    const flagged = [...a, ...b].filter((id) => ctx.orders.get(id)!.needsAttention);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(ctx.events.list().some((e) => e.type === 'vehicle_stock_reported')).toBe(true);
  });
});

describe('15: genstart midt i en opfyldning', () => {
  it('accepteret lagerbesøg overlever genstart, og afhentning registreres præcis én gang', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-rep-'));
    const mk = async () => {
      const tg = new SimulatedTelegramAdapter();
      const app = await createApp({
        mode: 'production',
        dbFile: path.join(dir, 'db.sqlite'),
        backupDir: path.join(dir, 'b'),
        secrets: new MemorySecretStore(),
        manualJobs: true,
        overrides: { sms: new SimulatedSmsAdapter(), telegram: tg, maps: new TestMaps(), llm: null },
      });
      await app.start();
      return { app, tg };
    };
    const drain = async (app: App) => {
      for (let i = 0; i < 10; i++) await app.ctx.jobs.drain();
    };
    const r1 = await mk();
    const d = opsData(r1.app);
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) ids.push(placeOrder(r1.app.ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: d.cola.id, quantity: 2 }], locationId: i <= 5 ? d.anna.vehicleLocationId! : d.central }));
    await route(r1.app, d.anna.id, ids);
    await drain(r1.app);
    const rep = r1.app.agents.replenishment.list({ activeOnly: true })[0];
    expect(r1.app.agents.replenishment.approve(rep.id, { name: 'Test', source: 'staff' })).toMatch(/godkendt/);
    await r1.app.agents.replenishment.driverRespond(rep.id, d.anna.id, true);
    await drain(r1.app);
    const vehicleBefore = level(r1.app, d.anna.vehicleLocationId!, d.cola.id).quantity;
    await r1.app.stop();

    const r2 = await mk();
    expect(r2.app.agents.replenishment.get(rep.id)!.status).toBe('en_route');
    r2.tg.injectText(d.anna.telegramUserId!, 'Anna', 'Afhentet');
    await drain(r2.app);
    r2.tg.injectText(d.anna.telegramUserId!, 'Anna', 'Afhentet');
    await drain(r2.app);
    expect(r2.app.agents.replenishment.get(rep.id)!.status).toBe('completed');
    expect(level(r2.app, d.anna.vehicleLocationId!, d.cola.id).quantity).toBe(vehicleBefore + 4);
    await r2.app.stop();
  });
});
