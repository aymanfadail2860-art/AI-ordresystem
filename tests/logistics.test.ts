import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, TestMaps, km, placeOrder, type TestApp } from './helpers';
import { createApp, type App } from '../src/server/app';
import { MemorySecretStore } from '../src/server/secrets';
import { SimulatedSmsAdapter } from '../src/server/adapters/sms/simulator';
import { SimulatedTelegramAdapter } from '../src/server/adapters/telegram/simulator';
import type { Ctx } from '../src/server/context';
import type { RoutePlanSummary } from '../src/shared/types';

/**
 * Logistik uden live-GPS: Telegram-baseret ETA, kundeopdateringer,
 * økonomisk ruteplanlægning og sikkerhedsregler. Alle tests kører uden
 * rigtige API-nøgler (simuleret SMS/Telegram, deterministisk testkort).
 */

let t: TestApp;
afterEach(async () => t?.app.stop());

function setupData(ctx: Ctx) {
  ctx.settings.update({
    company: { name: 'Test ApS', phone: '+4570000000' },
    installation: { automationEnabled: true },
    openingHours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '00:00', closed: false }])) as never,
    pricing: { deliveryFeeOre: 3900, freeDeliveryThresholdOre: 0, minimumOrderOre: 0 },
    // Scenarierne tester den økonomiske model (v0.2–0.4); standarden er nu den adaptive strategi
    economics: { strategy: 'economic' },
  });
  const rb = ctx.catalog.create({ sku: 'RB25', name: 'Red Bull', category: 'Energidrik', priceOre: 2500, synonyms: ['red bull'] });
  const champ = ctx.catalog.create({ sku: 'CHAMP', name: 'Champagnekasse', category: 'Vin', priceOre: 500000 });
  const c = km(-14, 0);
  const central = ctx.inventory.createLocation('Central', 'central', null, c.lat, c.lng);
  ctx.inventory.adjust(central, rb.id, 500, 'start', 'system');
  const mk = (name: string, at: { lat: number; lng: number }) => {
    const d = ctx.drivers.create({ name, vehicleName: name });
    const uid = `sim-driver-${d.id}`;
    ctx.db.prepare(`UPDATE drivers SET telegram_user_id = ?, telegram_chat_id = ? WHERE id = ?`).run(uid, uid, d.id);
    ctx.drivers.setStatus(d.id, 'available');
    ctx.drivers.setPosition(d.id, at.lat, at.lng, 'manual');
    return ctx.drivers.get(d.id)!;
  };
  const anna = mk('Anna', km(0, 0));
  const bo = mk('Bo', km(-15, 0));
  ctx.inventory.adjust(anna.vehicleLocationId!, rb.id, 300, 'bil', 'system');
  ctx.inventory.adjust(anna.vehicleLocationId!, champ.id, 3, 'bil', 'system');
  return { rb, champ, central, anna, bo };
}

async function setup() {
  t = await makeApp({ seed: false, overrides: { maps: new TestMaps() } });
  return { ctx: t.app.ctx, ...setupData(t.app.ctx) };
}

let phoneSeq = 0;
const phone = () => `+45888800${String(++phoneSeq).padStart(2, '0')}`;

/** Byg en bindende rute for en chauffør med de givne stop i rækkefølge. */
async function buildRoute(app: App, driverId: number, orderIds: number[]) {
  for (const id of orderIds) await app.agents.dispatch.assign(id, driverId, 'staff');
  app.agents.routing.applySequence(driverId, orderIds, 'test');
  await app.agents.routing.refreshEtas(driverId, 'test');
}

function eta(ctx: Ctx, id: number) {
  return new Date(ctx.orders.get(id)!.eta!).getTime();
}

function promise(ctx: Ctx, id: number, offsetMin: number | null) {
  const v = offsetMin === null ? null : new Date(eta(ctx, id) + offsetMin * 60000).toISOString();
  ctx.db.prepare(`UPDATE orders SET eta_communicated = ?, eta_notified_at = NULL, eta_updates_sent = 0 WHERE id = ?`).run(v, id);
}

function smsTo(t: TestApp, ctx: Ctx, orderId: number) {
  const p = ctx.orders.get(orderId)!.customerPhone;
  return t.sms.sentLog.filter((m) => m.to === p);
}

describe('Telegram-baseret ETA og kundeopdateringer', () => {
  it('1+2: chaufføren melder 5 min til ankomst → korrekt "stå klar"-SMS og ETA', async () => {
    const { ctx, rb, anna } = await setup();
    const a = placeOrder(ctx, { phone: phone(), at: km(3, 0), lines: [{ productId: rb.id, quantity: 4 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [a]);
    await t.run();
    t.tg.injectText(anna.telegramUserId!, 'Anna', `Ordre ${a}, jeg er der om 5 min`);
    await t.run();
    const sms = smsTo(t, ctx, a);
    expect(sms.at(-1)!.text).toBe('Din bestilling forventes leveret om cirka 5 minutter. Du må meget gerne stå klar.');
    expect(Math.abs(eta(ctx, a) - (Date.now() + 5 * 60000))).toBeLessThan(60000);
    expect(ctx.orders.get(a)!.etaConfidence).toBe('high');
    // Gentaget melding giver ikke en ny "stå klar"-SMS
    t.tg.injectText(anna.telegramUserId!, 'Anna', `Ordre ${a}, der om 4 min`);
    await t.run();
    expect(smsTo(t, ctx, a).filter((m) => m.text.includes('stå klar'))).toHaveLength(1);
  });

  it('3+4+5: 10 min forsinkelse ved A → alle ETA\'er A–D genberegnes, kun relevante kunder opdateres', async () => {
    const { ctx, rb, anna } = await setup();
    const ids = [3, 6, 9, 12].map((n) => placeOrder(ctx, { phone: phone(), at: km(n, 0), lines: [{ productId: rb.id, quantity: 2 }], locationId: anna.vehicleLocationId! }));
    const [A, B, C, D] = ids;
    await buildRoute(t.app, anna.id, ids);
    await t.run();
    promise(ctx, A, 0); // A og B har fået præcis den beregnede tid
    promise(ctx, B, 0);
    promise(ctx, C, 15); // C har fået en tid med god margin
    promise(ctx, D, null); // D har ikke fået et tidspunkt
    const before = Object.fromEntries(ids.map((id) => [id, eta(ctx, id)]));
    const sentBefore = Object.fromEntries(ids.map((id) => [id, smsTo(t, ctx, id).length]));

    t.tg.injectText(anna.telegramUserId!, 'Anna', 'Jeg er 10 min forsinket');
    await t.run();

    for (const id of ids) expect((eta(ctx, id) - before[id]) / 60000).toBeCloseTo(10, 1);
    expect(smsTo(t, ctx, A).length - sentBefore[A]).toBe(1);
    expect(smsTo(t, ctx, B).length - sentBefore[B]).toBe(1);
    expect(smsTo(t, ctx, C).length - sentBefore[C]).toBe(0);
    expect(smsTo(t, ctx, D).length - sentBefore[D]).toBe(0);
    expect(smsTo(t, ctx, A).at(-1)!.text).toMatch(/forsinket.*kl\./);
    for (const id of ids) expect(ctx.orders.events(id).some((e) => e.type === 'eta_changed')).toBe(true);
    expect(ctx.orders.events(A).some((e) => e.type === 'customer_notified')).toBe(true);

    // Lille ekstra forsinkelse giver ingen gentagne beskeder
    t.tg.injectText(anna.telegramUserId!, 'Anna', 'Jeg er 4 min forsinket');
    await t.run();
    for (const id of ids) expect(smsTo(t, ctx, id).length - sentBefore[id]).toBe(id === A || id === B ? 1 : 0);
  });

  it('9: uklar chaufførbesked → opklarende spørgsmål, ingen gæt og ingen kundebesked', async () => {
    const { ctx, rb, anna } = await setup();
    const a = placeOrder(ctx, { phone: phone(), at: km(3, 0), lines: [{ productId: rb.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    const b = placeOrder(ctx, { phone: phone(), at: km(6, 0), lines: [{ productId: rb.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [a, b]);
    await t.run();
    const sent = t.sms.sentLog.length;
    const anchorBefore = t.app.agents.routing.getAnchor(anna.id);
    t.tg.injectText(anna.telegramUserId!, 'Anna', 'Jeg er der om 5 min');
    await t.run();
    let last = ctx.drivers.messages(anna.id).filter((m) => m.direction === 'out').at(-1)!;
    expect(last.body).toMatch(/Hvilken ordre/);
    expect(t.sms.sentLog.length).toBe(sent);
    expect(t.app.agents.routing.getAnchor(anna.id)!.kind).toBe(anchorBefore!.kind);
    t.tg.injectText(anna.telegramUserId!, 'Anna', 'øhh den der med det');
    await t.run();
    last = ctx.drivers.messages(anna.id).filter((m) => m.direction === 'out').at(-1)!;
    expect(last.body).toMatch(/forstod ikke/);
    expect(t.sms.sentLog.length).toBe(sent);
  });

  it('forstår "færdig med X og kører mod Y" og "trafik, bliver 20 min senere"', async () => {
    const { ctx, rb, anna } = await setup();
    const a = placeOrder(ctx, { phone: phone(), at: km(3, 0), lines: [{ productId: rb.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    const b = placeOrder(ctx, { phone: phone(), at: km(6, 0), lines: [{ productId: rb.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    const c = placeOrder(ctx, { phone: phone(), at: km(9, 0), lines: [{ productId: rb.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [a, b, c]);
    await t.run();
    t.tg.injectText(anna.telegramUserId!, 'Anna', `Jeg er færdig med ${a} og kører mod ${c}`);
    await t.run();
    expect(ctx.orders.get(a)!.status).toBe('delivered');
    expect(ctx.drivers.get(anna.id)!.currentOrderId).toBe(c);
    expect(ctx.drivers.routeStops(anna.id).map((s) => s.orderId)).toEqual([c, b]);
    // Senest kendte stop er nu A's adresse – ikke en GPS-position
    expect(ctx.drivers.get(anna.id)!.lastPositionSource).toBe('delivered_stop');
    const beforeB = eta(ctx, b);
    t.tg.injectText(anna.telegramUserId!, 'Anna', 'Der er trafik, bliver nok 20 min senere');
    await t.run();
    expect((eta(ctx, b) - beforeB) / 60000).toBeCloseTo(20, 0);
    expect(ctx.orders.get(c)!.needsAttention).toBe(true); // ≥ 20 min markeres
  });

  it('"Jeg kan godt tage en ekstra ordre på vejen" registreres som ekstra kapacitet', async () => {
    const { ctx, anna } = await setup();
    t.tg.injectText(anna.telegramUserId!, 'Anna', 'Jeg kan godt tage en ekstra ordre på vejen');
    await t.run();
    expect(ctx.drivers.get(anna.id)!.extraCapacityUntil).not.toBeNull();
  });

  it('live-position fra Telegram gemmes ikke', async () => {
    const { ctx, anna } = await setup();
    const before = ctx.drivers.get(anna.id)!;
    t.tg.injectLocation(anna.telegramUserId!, 'Anna', 55.9, 12.9);
    await t.run();
    const after = ctx.drivers.get(anna.id)!;
    expect(after.lastLat).toBe(before.lastLat);
    expect(ctx.drivers.messages(anna.id).at(-1)!.body).toMatch(/bruger ikke live-position/);
  });

  it('13: forældet status → ETA markeres usikker, loves ikke, og chaufføren bedes om status', async () => {
    const { ctx, rb, anna } = await setup();
    const a = placeOrder(ctx, { phone: phone(), at: km(3, 0), lines: [{ productId: rb.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [a]);
    await t.run();
    expect(ctx.orders.get(a)!.etaConfidence).not.toBe('low');
    const old = new Date(Date.now() - 30 * 60000).toISOString();
    ctx.db.prepare(`UPDATE eta_anchors SET reported_at = ?, at = ? WHERE driver_id = ?`).run(old, new Date(Date.now() - 2 * 60000).toISOString(), anna.id);
    ctx.db.prepare(`UPDATE drivers SET last_status_at = ? WHERE id = ?`).run(old, anna.id);
    promise(ctx, a, -15); // kunden har fået en tid, der nu er passeret
    const sent = smsTo(t, ctx, a).length;
    await t.app.agents.logistics.tick();
    await t.run();
    const o = ctx.orders.get(a)!;
    expect(o.etaConfidence).toBe('low');
    expect(o.etaSource).toBe('estimate');
    expect(ctx.drivers.routeStops(anna.id)[0].etaBasis).toMatch(/forældet/);
    // Kunden får ikke et opdigtet tidspunkt – kun besked om forsinkelse uden tid
    const newSms = smsTo(t, ctx, a).slice(sent);
    expect(newSms.every((m) => !/kl\.\s*\d/.test(m.text))).toBe(true);
    expect(ctx.drivers.messages(anna.id).some((m) => m.direction === 'out' && /hvordan går det/i.test(m.body))).toBe(true);
  });
});

describe('Økonomisk ruteplanlægning', () => {
  async function bigVsSmall(promiseOffset: number) {
    const s = await setup();
    const { ctx, rb, champ, anna, bo } = s;
    ctx.drivers.setStatus(bo.id, 'offline');
    const B = placeOrder(ctx, { phone: phone(), at: km(3, 0), lines: [{ productId: rb.id, quantity: 20 }], locationId: anna.vehicleLocationId! });
    const C = placeOrder(ctx, { phone: phone(), at: km(6, 0), lines: [{ productId: rb.id, quantity: 20 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [B, C]);
    await t.run();
    promise(ctx, B, promiseOffset);
    promise(ctx, C, promiseOffset);
    const X = placeOrder(ctx, { phone: phone(), at: km(3, 2), lines: [{ productId: champ.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    const Y = placeOrder(ctx, { phone: phone(), at: km(3, 2), lines: [{ productId: rb.id, quantity: 20 }], locationId: anna.vehicleLocationId! });
    const plan = async (id: number) => {
      const o = ctx.orders.get(id)!;
      return t.app.agents.routing.planInsertion(ctx.drivers.get(anna.id)!, { id, point: { lat: o.addressLat!, lng: o.addressLng! }, needsPickup: false, deliveryFeeOre: o.deliveryFeeOre }, { reassignment: false });
    };
    return { ...s, B, C, X, Y, plan };
  }

  it('7: stor ordre (5.000 kr.) prioriteres højere end mindre ordre, når løfterne tillader det', async () => {
    const { X, Y, plan } = await bigVsSmall(40);
    const big = (await plan(X)).find((r) => r.feasible)!;
    const small = (await plan(Y)).find((r) => r.feasible)!;
    expect(big.insertIndex).toBe(0);
    expect(small.insertIndex).toBeGreaterThan(big.insertIndex);
    expect(big.analysis.contributionOre).toBeGreaterThan(small.analysis.contributionOre);
    expect(big.analysis.explanation.join(' ')).toMatch(/Dækningsbidrag/);
  });

  it('8: stor ordre må ikke bryde eksisterende leveringsløfter → placeres efter dem', async () => {
    const { ctx, X, B, C, anna, plan } = await bigVsSmall(2);
    const results = await plan(X);
    const best = results.find((r) => r.feasible)!;
    expect(best.insertIndex).toBe(2);
    const first = results.find((r) => r.insertIndex === 0)!;
    expect(first.feasible).toBe(false);
    expect(first.violations.join(' ')).toMatch(/lovede/);
    // Gennem dispatch: tilbuddet til chaufføren bevarer B og C forrest
    t.app.agents.dispatch.enqueue(X);
    await t.run();
    const offer = ctx.drivers.offers(X).find((o) => o.status === 'pending')!;
    expect(offer.driverId).toBe(anna.id);
    expect(offer.plan!.sequence).toEqual([B, C, X]);
  });

  it('6: ny ordre 3 min fra et eksisterende stop vurderes som oplagt indsættelse', async () => {
    const { ctx, rb, anna, bo } = await setup();
    const S = placeOrder(ctx, { phone: phone(), at: km(5, 0), lines: [{ productId: rb.id, quantity: 4 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [S]);
    await t.run();
    const N = placeOrder(ctx, { phone: phone(), at: km(5, 1.5), lines: [{ productId: rb.id, quantity: 4 }], locationId: anna.vehicleLocationId! });
    t.app.agents.dispatch.enqueue(N);
    await t.run();
    const offer = ctx.drivers.offers(N).find((o) => o.status === 'pending')!;
    expect(offer.driverId).toBe(anna.id);
    expect(offer.plan!.analysis.nearby).toBe(true);
    expect(offer.plan!.analysis.explanation.join(' ')).toMatch(/fra et eksisterende stop/);
    // Bo (langt væk, skal via centrallager) er vurderet som et dårligere alternativ
    const boAlt = offer.plan!.alternatives.find((a) => a.driverId === bo.id)!;
    expect(boAlt.score).toBeLessThan(offer.plan!.analysis.score);
  });

  it('11: flere chauffører kan tage ordren → bedste vælges, næstbedste ved afvisning', async () => {
    const { ctx, rb, anna, bo } = await setup();
    ctx.inventory.adjust(bo.vehicleLocationId!, rb.id, 50, 'bil', 'system');
    ctx.drivers.setPosition(bo.id, km(4, 4).lat, km(4, 4).lng, 'manual');
    const N = placeOrder(ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: rb.id, quantity: 4 }], locationId: anna.vehicleLocationId! });
    t.app.agents.dispatch.enqueue(N);
    await t.run();
    const first = ctx.drivers.offers(N).find((o) => o.status === 'pending')!;
    expect(first.driverId).toBe(anna.id);
    const alts = first.plan!.alternatives.filter((a) => a.feasible).map((a) => a.driverId).sort();
    expect(alts).toEqual([anna.id, bo.id].sort());
    t.tg.injectCallback(anna.telegramUserId!, 'Anna', `offer:${first.id}:reject`);
    await t.run();
    const second = ctx.drivers.offers(N).find((o) => o.status === 'pending')!;
    expect(second.driverId).toBe(bo.id);
  });

  it('12: væsentlig ruteændring kræver chaufførens accept, også når accept ellers ikke kræves', async () => {
    const { ctx, rb, champ, anna, bo } = await setup();
    ctx.drivers.setStatus(bo.id, 'offline');
    ctx.settings.update({ delivery: { requireDriverAcceptance: false } });
    const B = placeOrder(ctx, { phone: phone(), at: km(3, 0), lines: [{ productId: rb.id, quantity: 20 }], locationId: anna.vehicleLocationId! });
    const C = placeOrder(ctx, { phone: phone(), at: km(6, 0), lines: [{ productId: rb.id, quantity: 20 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [B, C]);
    await t.run();
    promise(ctx, B, 40);
    promise(ctx, C, 40);
    // Ikke-væsentlig ændring (ordre bagerst, ingen forsinkelser) tildeles direkte
    const Y = placeOrder(ctx, { phone: phone(), at: km(9, 0), lines: [{ productId: rb.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    t.app.agents.dispatch.enqueue(Y);
    await t.run();
    expect(ctx.orders.get(Y)!.status).toBe('driver_assigned');
    expect(ctx.drivers.routeStops(anna.id).map((s) => s.orderId)).toEqual([B, C, Y]);
    promise(ctx, Y, 40);
    // Væsentlig ændring (stor ordre forrest) kræver accept
    const X = placeOrder(ctx, { phone: phone(), at: km(3, 2), lines: [{ productId: champ.id, quantity: 1 }], locationId: anna.vehicleLocationId! });
    t.app.agents.dispatch.enqueue(X);
    await t.run();
    const offer = ctx.drivers.offers(X).find((o) => o.status === 'pending')!;
    expect(offer.plan!.analysis.significantChange).toBe(true);
    expect(ctx.orders.get(X)!.status).toBe('awaiting_driver');
    expect(ctx.drivers.routeStops(anna.id).map((s) => s.orderId)).toEqual([B, C, Y]); // uændret
    expect(ctx.drivers.messages(anna.id).at(-1)!.body).toMatch(/Ruteændring/);
    t.tg.injectCallback(anna.telegramUserId!, 'Anna', `offer:${offer.id}:accept`);
    await t.run();
    expect(ctx.drivers.routeStops(anna.id).map((s) => s.orderId)).toEqual(offer.plan!.sequence);
  });

  it('10: chaufføren svarer ikke → ruten ændres ikke; status efterspørges og eskaleres', async () => {
    const { ctx, rb, anna, bo } = await setup();
    ctx.drivers.setStatus(bo.id, 'offline');
    const S = placeOrder(ctx, { phone: phone(), at: km(5, 0), lines: [{ productId: rb.id, quantity: 4 }], locationId: anna.vehicleLocationId! });
    await buildRoute(t.app, anna.id, [S]);
    await t.run();
    const N = placeOrder(ctx, { phone: phone(), at: km(5, 1), lines: [{ productId: rb.id, quantity: 4 }], locationId: anna.vehicleLocationId! });
    t.app.agents.dispatch.enqueue(N);
    await t.run();
    const offer = ctx.drivers.offers(N).find((o) => o.status === 'pending')!;
    ctx.db.prepare(`UPDATE dispatch_offers SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), offer.id);
    await t.run(ctx.settings.get().delivery.offerTimeoutSeconds * 1000 + 1000);
    expect(ctx.drivers.offers(N).find((o) => o.id === offer.id)!.status).toBe('expired');
    expect(ctx.drivers.routeStops(anna.id).map((s) => s.orderId)).toEqual([S]);
    expect(ctx.orders.get(N)!.needsAttention).toBe(true); // ingen anden forsvarlig løsning → medarbejder

    // Ingen status fra chaufføren: først efterspørgsel, derefter eskalering
    const t25 = new Date(Date.now() - 25 * 60000).toISOString();
    ctx.db.prepare(`UPDATE eta_anchors SET reported_at = ? WHERE driver_id = ?`).run(t25, anna.id);
    ctx.db.prepare(`UPDATE drivers SET last_status_at = ? WHERE id = ?`).run(t25, anna.id);
    await t.app.agents.logistics.tick();
    await t.run();
    expect(ctx.drivers.messages(anna.id).some((m) => /hvordan går det/i.test(m.body))).toBe(true);
    const t40 = new Date(Date.now() - 40 * 60000).toISOString();
    ctx.db.prepare(`UPDATE eta_anchors SET reported_at = ? WHERE driver_id = ?`).run(t40, anna.id);
    ctx.db.prepare(`UPDATE drivers SET last_status_at = ?, status_request_sent_at = ? WHERE id = ?`).run(t40, t25, anna.id);
    await t.app.agents.logistics.tick();
    expect(ctx.events.list({ onlyOpen: true }).some((e) => e.type === 'driver_no_status')).toBe(true);
  });

  it('15: flere nye ordrer samtidigt → ingen dobbeltbooking af kapacitet eller lager', async () => {
    const { ctx, rb, anna, bo } = await setup();
    ctx.inventory.adjust(bo.vehicleLocationId!, rb.id, 50, 'bil', 'system');
    ctx.drivers.setPosition(bo.id, km(1, 1).lat, km(1, 1).lng, 'manual');
    ctx.drivers.update(anna.id, { maxActiveOrders: 2 });
    ctx.drivers.update(bo.id, { maxActiveOrders: 2 });
    ctx.settings.update({ delivery: { allowCentralPickup: false } });
    const ids = [1, 2, 3, 4, 5, 6].map((n) => placeOrder(ctx, { phone: phone(), at: km(n, 1), lines: [{ productId: rb.id, quantity: 3 }], locationId: anna.vehicleLocationId! }));
    for (const id of ids) t.app.agents.dispatch.enqueue(id);
    await t.run();
    // Højst ét ubesvaret tilbud pr. chauffør ad gangen
    const firstRound = ctx.drivers.offers().filter((o) => o.status === 'pending');
    expect(firstRound).toHaveLength(2);
    expect(new Set(firstRound.map((o) => o.driverId)).size).toBe(2);
    // Chaufførerne accepterer løbende, indtil kapaciteten er brugt
    for (let round = 0; round < 6; round++) {
      for (const o of ctx.drivers.offers().filter((x) => x.status === 'pending')) {
        const d = ctx.drivers.get(o.driverId)!;
        t.tg.injectCallback(d.telegramUserId!, d.name, `offer:${o.id}:accept`);
      }
      await t.run(61_000);
    }
    for (const d of [anna, bo]) expect(ctx.drivers.get(d.id)!.activeOrderCount).toBeLessThanOrEqual(2);
    expect(ids.filter((id) => ctx.orders.get(id)!.status === 'driver_assigned')).toHaveLength(4);
    expect(ids.filter((id) => ctx.orders.get(id)!.status === 'awaiting_driver').every((id) => ctx.orders.get(id)!.needsAttention)).toBe(true);
    const reserved = ctx.inventory.levels().reduce((s, l) => s + l.reserved, 0);
    expect(reserved).toBe(6 * 3);
    for (const d of [anna, bo]) {
      const seq = ctx.drivers.routeStops(d.id).map((s) => s.orderId);
      expect(new Set(seq).size).toBe(seq.length);
    }
  });
});

describe('14: genstart midt i en ruteændring', () => {
  it('et ventende tilbud med ruteplan overlever genstart og kan accepteres bagefter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-route-'));
    const mk = async () => {
      const sms = new SimulatedSmsAdapter();
      const tg = new SimulatedTelegramAdapter();
      const app = await createApp({
        mode: 'production',
        dbFile: path.join(dir, 'db.sqlite'),
        backupDir: path.join(dir, 'b'),
        secrets: new MemorySecretStore(),
        manualJobs: true,
        overrides: { sms, telegram: tg, maps: new TestMaps(), llm: null },
      });
      await app.start();
      return { app, sms, tg };
    };
    const drain = async (app: App) => {
      for (let i = 0; i < 10; i++) await app.ctx.jobs.drain();
    };
    const r1 = await mk();
    const { rb, anna, bo } = setupData(r1.app.ctx);
    r1.app.ctx.drivers.setStatus(bo.id, 'offline');
    const S = placeOrder(r1.app.ctx, { phone: phone(), at: km(5, 0), lines: [{ productId: rb.id, quantity: 2 }], locationId: anna.vehicleLocationId! });
    await buildRoute(r1.app, anna.id, [S]);
    const N = placeOrder(r1.app.ctx, { phone: phone(), at: km(2, 1), lines: [{ productId: rb.id, quantity: 2 }], locationId: anna.vehicleLocationId! });
    await r1.app.agents.dispatch.dispatch(N);
    const offer = r1.app.ctx.drivers.offers(N).find((o) => o.status === 'pending')!;
    const plan = offer.plan as RoutePlanSummary;
    await r1.app.stop(); // "nedbrud" midt i ruteændringen

    const r2 = await mk();
    expect(r2.app.ctx.drivers.offers(N).find((o) => o.id === offer.id)!.status).toBe('pending');
    expect(r2.app.ctx.drivers.routeStops(anna.id).map((s) => s.orderId)).toEqual([S]);
    r2.tg.injectCallback(anna.telegramUserId!, 'Anna', `offer:${offer.id}:accept`);
    await drain(r2.app);
    expect(r2.app.ctx.orders.get(N)!.status).toBe('driver_assigned');
    const seq = r2.app.ctx.drivers.routeStops(anna.id).map((s) => s.orderId);
    expect(seq).toEqual(plan.sequence);
    expect(new Set(seq).size).toBe(seq.length);
    await r2.app.stop();
  });
});
