import { afterEach, describe, expect, it } from 'vitest';
import { clock } from '../src/server/clock';
import { parseTimeReply, ceilToQuarter } from '../src/core/timeReply';
import { CapacityError } from '../src/server/services/inventory';
import { km, placeOrder, type TestApp } from './helpers';
import { opsApp, phone, route, lastGroup } from './ops-fixture';

/**
 * Etape 5: alternative leveringstider, kø-reservation og fysisk kapacitet i bilerne.
 * Alle integrationer er simulerede (SMS/Telegram-simulator, testkort 30 km/t).
 */
let t: TestApp | null = null;
afterEach(async () => {
  clock.reset();
  await t?.app.stop();
  t = null;
});
const MIN = 60_000;

async function setup() {
  const s = await opsApp();
  t = s.t;
  t.clock.t = Date.parse('2026-06-16T14:00:00Z');
  clock.set(() => t!.clock.t);
  const { ctx } = t.app;
  // Kun Anna kører; hun er ved loftet med én lang levering (ca. 65 min væk)
  ctx.drivers.setStatus(s.bo.id, 'offline');
  ctx.drivers.update(s.anna.id, { maxActiveOrders: 1 });
  const far = placeOrder(ctx, { phone: phone(), at: km(32, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
  await route(t.app, s.anna.id, [far]);
  return { ...s, far };
}

/** Ny kundeordre, der ikke kan få en chauffør (kapacitet), og som efter 8 min får et forslag. */
async function orderNeedingAlternative(s: Awaited<ReturnType<typeof setup>>, at = km(1, 0)) {
  const p = phone();
  const id = placeOrder(t!.app.ctx, { phone: p, at, lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
  t!.app.agents.dispatch.enqueue(id);
  for (let i = 0; i < 10; i++) await t!.run(61_000);
  return { id, phone: p };
}

const promised = (id: number) => (t!.app.ctx.db.prepare(`SELECT eta_communicated AS e FROM orders WHERE id = ?`).get(id) as { e: string | null }).e;
const smsTo = (p: string) => t!.sms.sentLog.filter((m) => m.to === p).map((m) => m.text);
const offerOf = (id: number) => t!.app.agents.timeOffers.list({ orderId: id });
async function reply(p: string, text: string) {
  t!.sms.injectInbound(p, text);
  await t!.run(3000);
  await t!.run(3000);
}

describe('Fortolkning af kundens svar (deterministisk)', () => {
  const now = Date.parse('2026-06-16T18:00:00Z'); // 20.00 lokal tid
  it.each([
    ['Ja', 'accept'],
    ['Det er fint', 'accept'],
    ['ok tak', 'accept'],
    ['Nej, det er for sent', 'decline'],
    ['Det passer ikke', 'decline'],
    ['Hvad er det tidligste?', 'earliest'],
    ['Kan I komme kl. 22?', 'request'],
    ['kl 21.30 er bedre', 'request'],
    ['Måske, jeg ved det ikke', 'unclear'],
  ])('"%s" → %s', (text, kind) => {
    expect(parseTimeReply(text, now).kind).toBe(kind);
  });
  it('klokkeslæt i lokal tid; "kl. 9" om aftenen betyder 21; passerede tider afvises', () => {
    expect(new Date(parseTimeReply('Kan I komme kl. 22?', now).requestedMs!).toISOString()).toBe('2026-06-16T20:00:00.000Z');
    expect(new Date(parseTimeReply('kl. 9', now).requestedMs!).toISOString()).toBe('2026-06-16T19:00:00.000Z');
    expect(parseTimeReply('kl. 19', now).kind).toBe('unclear');
    expect(new Date(ceilToQuarter(Date.parse('2026-06-16T18:01:00Z'))).toISOString()).toBe('2026-06-16T18:15:00.000Z');
  });
});

describe('Alternative leveringstider', () => {
  it('kunden accepterer et senere tidspunkt → noteres (ikke "bekræftet"), tildeles før tidsrummet og løftet holdes', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const o = await orderNeedingAlternative(s);
    const offerText = smsTo(o.phone).at(-1)!;
    expect(offerText).toMatch(/Vi har ekstra travlt lige nu\. Vi kan levere din bestilling \(ordre #\d+\) omkring kl\. \d{2}\.\d{2}–\d{2}\.\d{2}\. Passer det dig\?/);
    expect(ctx.orders.get(o.id)!.status).toBe('awaiting_driver'); // ikke afvist, ikke manuel
    await reply(o.phone, 'Ja');
    const ord = ctx.orders.get(o.id)!;
    const offer = offerOf(o.id)[0];
    expect(offer.status).toBe('accepted');
    expect(ord.windowEnd).toBe(offer.windowEnd);
    expect(promised(o.id)).toBe(offer.windowEnd);
    expect(smsTo(o.phone).at(-1)).toMatch(/Vi har noteret levering .* ca\. kl\./);
    expect(smsTo(o.phone).join(' ')).not.toMatch(/bekræftet/i);
    // Anna leverer den lange ordre → plads; tæt på tidsrummet tildeles ordren
    ctx.orders.transition(s.far, 'out_for_delivery', 'driver');
    ctx.orders.transition(s.far, 'delivered', 'driver');
    // Tidligst muligt-tidsrum må leveres højst 30 min før; dispatch prøver hvert minut
    t!.clock.t = new Date(offer.windowStart).getTime() - 25 * MIN;
    t!.app.agents.dispatch.enqueue(o.id);
    await t!.run();
    const dOffer = ctx.drivers.offers(o.id).find((x) => x.status === 'pending')!;
    t!.tg.injectCallback(s.anna.telegramUserId!, 'Anna', `offer:${dOffer.id}:accept`);
    await t!.run();
    expect(ctx.orders.get(o.id)!.status).toBe('driver_assigned');
    expect(offerOf(o.id)[0].status).toBe('fulfilled');
    expect(smsTo(o.phone).at(-1)).toMatch(/Levering som aftalt ca\. kl\./);
    // Løftet bliver aldrig senere end det aftalte (kan chaufføren komme tidligere, får kunden besked)
    expect(new Date(promised(o.id)!).getTime()).toBeLessThanOrEqual(new Date(offer.windowEnd).getTime());
  });

  it('kunden ønsker et senere tidspunkt → noteres, hvis det kan nås; for tidligt → nyt forslag', async () => {
    const s = await setup();
    const o = await orderNeedingAlternative(s);
    const first = offerOf(o.id)[0];
    // For tidligt: før det tidligste mulige
    const early = new Date(new Date(first.windowStart).getTime() - 60 * MIN);
    const hhmm = (d: Date) => d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });
    await reply(o.phone, `Kan I komme kl. ${hhmm(early)}?`);
    expect(smsTo(o.phone).at(-1)).toMatch(/kan vi desværre ikke nå/);
    const second = offerOf(o.id).find((x) => x.status === 'pending')!;
    expect(second).toBeTruthy();
    // Senere: kan nås
    const later = new Date(ceilToQuarter(new Date(second.windowEnd).getTime() + 45 * MIN));
    await reply(o.phone, `Kan I komme kl. ${hhmm(later)}?`);
    const ord = t!.app.ctx.orders.get(o.id)!;
    expect(ord.windowKind).toBe('requested');
    expect(new Date(ord.windowStart!).getTime()).toBe(later.getTime());
    expect(smsTo(o.phone).at(-1)).toMatch(/Det passer fint/);
  });

  it('"Hvad er det tidligste?" giver et nyt (opdateret) forslag', async () => {
    const s = await setup();
    const o = await orderNeedingAlternative(s);
    await reply(o.phone, 'Hvad er det tidligste?');
    const offers = offerOf(o.id);
    expect(offers.map((x) => x.status).sort()).toEqual(['pending', 'superseded']);
    expect(smsTo(o.phone).at(-1)).toMatch(/Det tidligste, vi kan nå lige nu: .*Passer det dig\?/);
  });

  it('kunden afviser → medarbejder overtager; AI påstår aldrig, at levering er bekræftet', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const o = await orderNeedingAlternative(s);
    await reply(o.phone, 'Nej, det er for sent');
    expect(ctx.orders.get(o.id)!.status).toBe('needs_manual');
    expect(offerOf(o.id)[0].status).toBe('declined');
    const conv = ctx.conversations.list().find((c) => c.customerPhone === o.phone)!;
    expect(conv.aiMode).toBe('ai_paused');
    expect(smsTo(o.phone).at(-1)).toMatch(/En medarbejder kontakter dig/);
    expect(smsTo(o.phone).join(' ')).not.toMatch(/bekræftet/i);
  });

  it('kunden svarer ikke → forslaget udløber og en medarbejder overtager', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const o = await orderNeedingAlternative(s);
    for (let i = 0; i < 12; i++) await t!.run(61_000);
    expect(offerOf(o.id)[0].status).toBe('expired');
    expect(ctx.orders.get(o.id)!.status).toBe('needs_manual');
    expect(smsTo(o.phone).at(-1)).toMatch(/Vi har ikke hørt fra dig/);
  });

  it('flere kunder accepterer samtidigt → hver får sin egen plads i køen (samme kapacitet loves ikke to gange)', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const p1 = phone();
    const p2 = phone();
    const a = placeOrder(ctx, { phone: p1, at: km(1, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    const b = placeOrder(ctx, { phone: p2, at: km(1.2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    t!.app.agents.dispatch.enqueue(a);
    t!.app.agents.dispatch.enqueue(b);
    for (let i = 0; i < 10; i++) await t!.run(61_000);
    const oa = offerOf(a)[0];
    const ob = offerOf(b)[0];
    expect(oa.status).toBe('pending');
    expect(ob.status).toBe('pending');
    // B's plads ligger efter A's i Annas kø (begge kan godt dele et kvarter, hvis ruten kan nå det)
    const eta = (id: number) => (ctx.db.prepare(`SELECT est_eta FROM delivery_time_offers WHERE order_id = ?`).get(id) as { est_eta: string }).est_eta;
    expect(new Date(eta(b)).getTime()).toBeGreaterThan(new Date(eta(a)).getTime());
    expect(new Date(ob.windowStart).getTime()).toBeGreaterThanOrEqual(new Date(oa.windowStart).getTime());
    t!.sms.injectInbound(p1, 'Ja');
    t!.sms.injectInbound(p2, 'Ja tak');
    await t!.run(3000);
    await t!.run(3000);
    expect(offerOf(a)[0].status).toBe('accepted');
    expect(offerOf(b)[0].status).toBe('accepted');
    expect(offerOf(a)[0].driverId).toBe(s.anna.id);
  });

  it('kapaciteten ændres før accept → tidspunktet valideres igen, og kunden får et nyt forslag', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const o = await orderNeedingAlternative(s);
    const first = offerOf(o.id)[0];
    // Mens kunden tænker, får Anna endnu en lang levering (kontoret tildeler manuelt)
    const extra = placeOrder(ctx, { phone: phone(), at: km(50, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await t!.app.agents.dispatch.assign(extra, s.anna.id, 'staff');
    t!.app.agents.routing.applySequence(s.anna.id, [s.far, extra], 'test');
    await t!.app.agents.routing.refreshEtas(s.anna.id, 'test');
    await reply(o.phone, 'Ja');
    expect(offerOf(o.id).find((x) => x.id === first.id)!.status).toBe('superseded');
    expect(offerOf(o.id).find((x) => x.status === 'pending')).toBeTruthy();
    expect(smsTo(o.phone).at(-1)).toMatch(/Tidspunktet blev desværre optaget/);
    expect(ctx.orders.get(o.id)!.windowEnd).toBeNull();
  });

  it('kan ordren nås inden for den normale leveringstid, sættes den i kø uden at spørge kunden – og bliver ikke en manuel sag', async () => {
    const s = await opsApp();
    t = s.t;
    clock.set(() => t!.clock.t);
    const { ctx } = t.app;
    ctx.drivers.setStatus(s.bo.id, 'offline');
    ctx.drivers.update(s.anna.id, { maxActiveOrders: 1 });
    const near = placeOrder(ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await route(t.app, s.anna.id, [near]);
    const p = phone();
    const id = placeOrder(ctx, { phone: p, at: km(3, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    t.app.agents.dispatch.enqueue(id);
    for (let i = 0; i < 25; i++) await t.run(61_000);
    expect(ctx.orders.get(id)!.status).toBe('awaiting_driver'); // ikke manuel efter 25 min
    expect(offerOf(id)[0]).toMatchObject({ kind: 'queued', status: 'accepted' });
    expect(t.sms.sentLog.filter((m) => m.to === p && /Passer det/.test(m.text))).toHaveLength(0);
    ctx.orders.transition(near, 'out_for_delivery', 'driver');
    ctx.orders.transition(near, 'delivered', 'driver');
    await t.run(61_000);
    expect(ctx.drivers.offers(id).some((x) => x.status === 'pending')).toBe(true);
  });

  it('en lavværdiordre afvises aldrig – den får samme forslag', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const gum = ctx.catalog.create({ sku: 'GUM', name: 'Tyggegummi', category: 'Slik', priceOre: 500, costOre: 490 });
    ctx.inventory.adjust(s.anna.vehicleLocationId!, gum.id, 5, 'test', 'system');
    const p = phone();
    const id = placeOrder(ctx, { phone: p, at: km(1, 0), lines: [{ productId: gum.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    t!.app.agents.dispatch.enqueue(id);
    for (let i = 0; i < 10; i++) await t!.run(61_000);
    expect(offerOf(id)[0]?.status).toBe('pending');
  });
});

describe('Fysisk kapacitet i bilerne', () => {
  async function capSetup() {
    const s = await opsApp();
    t = s.t;
    const { ctx } = t.app;
    ctx.settings.update({ replenishment: { topUpHorizonMinutes: 90, topUpMaxUnits: 40 } });
    const tp = ctx.catalog.create({ sku: 'TP', name: 'Toiletpapir', category: 'Husholdning', priceOre: 5000, costOre: 3000, unitVolume: 8 });
    const gum = ctx.catalog.create({ sku: 'GUM', name: 'Vingummi', category: 'Slik', priceOre: 2200, costOre: 800, unitVolume: 1 });
    for (const p of [tp, gum]) ctx.inventory.adjust(s.central, p.id, 100, 'start', 'system');
    return { ...s, tp, gum };
  }

  it('overførsel ud over bilens plads afvises; kapacitet pr. varetype og plads uden for sortimentet', async () => {
    const s = await capSetup();
    const inv = t!.app.ctx.inventory;
    const v = s.anna.vehicleLocationId!; // 10 cola i bilen
    inv.setCapacity(v, { capacityUnits: 40, categoryCaps: { Husholdning: 16 }, flexUnits: 20 });
    inv.setAssortment(v, [{ productId: s.cola.id, parLevel: 10, maxQty: 20 }]);
    expect(inv.capacity(v)).toMatchObject({ capacityUnits: 40, usedUnits: 10, freeUnits: 30 });
    expect(() => inv.transfer(s.central, v, s.tp.id, 3)).toThrow(CapacityError); // 24 > 16 (Husholdning)
    inv.transfer(s.central, v, s.tp.id, 2); // 16 enheder
    expect(() => inv.transfer(s.central, v, s.gum.id, 5)).toThrow(/sortiment/); // flex: 16 + 5 > 20
    inv.transfer(s.central, v, s.gum.id, 4); // flex 20 brugt
    expect(() => inv.transfer(s.central, v, s.cola.id, 11)).toThrow(/plads til 10/); // 30 + 11 > 40
  });

  it('næsten fuld bil: opfyldningen dækker kun de ordrer, der kan være i bilen, og ledelsen ser pladsen', async () => {
    const s = await capSetup();
    const { ctx } = t!.app;
    const v = s.anna.vehicleLocationId!;
    ctx.inventory.setCapacity(v, { capacityUnits: 22 }); // 10 cola i bilen → 12 fri
    const ids: number[] = [];
    for (let i = 1; i <= 3; i++) ids.push(placeOrder(ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 2 }], locationId: v }));
    for (let i = 4; i <= 6; i++) ids.push(placeOrder(ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.chips.id, quantity: 3 }], locationId: s.central }));
    await route(t!.app, s.anna.id, ids);
    await t!.run();
    const rep = t!.app.agents.replenishment.list({ activeOnly: true })[0];
    // 12 fri + 6 cola leveret før stop 4 = 18 → plads til alle tre chipsordrer à 3 (9 enheder)
    expect(rep.coversOrders).toEqual(ids.slice(3));
    expect(lastGroup(ctx)).toMatch(/Bilens plads: 10 af 22 lagerenheder brugt/);
    // Gør bilen for lille: 2 fri + 6 cola leveret før = 8 → kun to chipsordrer à 3 kan dækkes
    ctx.inventory.setCapacity(v, { capacityUnits: 12 });
    t!.app.agents.replenishment.cancel(rep.id, 'test', 'test');
    await t!.app.agents.replenishment.evaluate(s.anna.id, 'test');
    const rep2 = t!.app.agents.replenishment.list({ activeOnly: true })[0];
    expect(rep2.coversOrders).toEqual(ids.slice(3, 5));
    expect(t!.app.ctx.events.list({ limit: 30 }).some((e) => e.type === 'capacity_limited')).toBe(true);
  });

  it('påfyldning der overstiger kapaciteten: bedste kombination efter dækningsbidrag pr. lagerenhed, med begrundelse', async () => {
    const s = await capSetup();
    const { ctx } = t!.app;
    const v = s.anna.vehicleLocationId!;
    ctx.inventory.setCapacity(v, { capacityUnits: 30 });
    // Efterspørgsel de seneste 2 timer: toiletpapir (8 enheder, DB 20 kr.) og vingummi (1 enhed, DB 14 kr.)
    for (let i = 0; i < 6; i++) {
      placeOrder(ctx, { phone: phone(), at: km(9, i), lines: [{ productId: s.tp.id, quantity: 2 }], locationId: s.central });
      placeOrder(ctx, { phone: phone(), at: km(9, i), lines: [{ productId: s.gum.id, quantity: 4 }], locationId: s.central });
    }
    const top = t!.app.agents.replenishment.topUpFor(s.anna.id, s.central, { [s.chips.id]: 3 });
    const gum = top.items.find((i) => i.productId === s.gum.id);
    const tp = top.items.find((i) => i.productId === s.tp.id);
    expect(gum?.quantity).toBeGreaterThan(0); // højere DB pr. lagerenhed vælges først
    const used = 10 + 3 + (gum?.quantity ?? 0) + (tp?.quantity ?? 0) * 8;
    expect(used).toBeLessThanOrEqual(30);
    expect(top.dropped.some((d) => /Toiletpapir/.test(d))).toBe(true);
    expect(top.notes.join(' ')).toMatch(/dækningsbidrag pr\. lagerenhed/);
  });

  it('lageret mangler en vare → den indgår ikke i påfyldningen, og intet fejler', async () => {
    const s = await capSetup();
    const { ctx } = t!.app;
    placeOrder(ctx, { phone: phone(), at: km(9, 0), lines: [{ productId: s.gum.id, quantity: 4 }], locationId: s.central });
    ctx.inventory.adjust(s.central, s.gum.id, -ctx.inventory.available(s.central, s.gum.id), 'udsolgt', 'system');
    const top = t!.app.agents.replenishment.topUpFor(s.anna.id, s.central, {});
    expect(top.items.find((i) => i.productId === s.gum.id)).toBeUndefined();
  });

  it('en ny aftalt levering ændrer påfyldningen: dens varer prioriteres før forventet efterspørgsel', async () => {
    const s = await capSetup();
    const { ctx } = t!.app;
    const id = placeOrder(ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.tp.id, quantity: 1 }], locationId: s.central });
    ctx.db
      .prepare(
        `INSERT INTO delivery_time_offers (order_id, driver_id, status, kind, window_start, window_end, attempt, expires_at, created_at) VALUES (?, ?, 'accepted', 'earliest', ?, ?, 1, ?, ?)`,
      )
      .run(id, s.anna.id, clock.iso(), clock.iso(), clock.iso(), clock.iso());
    const top = t!.app.agents.replenishment.topUpFor(s.anna.id, s.central, {});
    expect(top.items[0]).toMatchObject({ productId: s.tp.id, tier: 2 });
    expect(top.items[0].quantity).toBeGreaterThanOrEqual(1);
  });

  it('en ordre, der ikke kan være i nogen bil, går straks til en medarbejder', async () => {
    const s = await capSetup();
    const { ctx } = t!.app;
    for (const d of [s.anna, s.bo]) ctx.inventory.setCapacity(d.vehicleLocationId!, { capacityUnits: 100, categoryCaps: { Husholdning: 16 } });
    const id = placeOrder(ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.tp.id, quantity: 3 }], locationId: s.central });
    t!.app.agents.dispatch.enqueue(id);
    await t!.run();
    const o = ctx.orders.get(id)!;
    expect(o.status).toBe('needs_manual');
    expect(o.attentionReason ?? '').toMatch(/plads/);
  });
});

describe('QA-regression: kundeløfter', () => {
  it('gentildeling overskriver ikke kundens løfte i stilhed', async () => {
    const s = await opsApp();
    t = s.t;
    const { ctx } = t.app;
    const id = placeOrder(ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    t.app.agents.dispatch.enqueue(id);
    await t.run();
    const offer = ctx.drivers.offers(id).find((o) => o.status === 'pending')!;
    const d = ctx.drivers.get(offer.driverId)!;
    t.tg.injectCallback(d.telegramUserId!, d.name, `offer:${offer.id}:accept`);
    await t.run();
    const before = promised(id);
    expect(before).toBeTruthy();
    // Notifikation ved en ny tildeling (fx omfordeling) med en anden ETA
    (t.app.agents.dispatch as unknown as { notifier: { initial: (a: number, b: string, c: number, d: boolean) => void } }).notifier.initial(id, 'Bo', clock.now() + 90 * MIN, true);
    expect(promised(id)).toBe(before);
  });
});

describe('QA-regression: manuel overtagelse og overvågning', () => {
  it('overtager en medarbejder samtalen, mens et forslag afventer, sender systemet intet og bevarer manuel tilstand', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const o = await orderNeedingAlternative(s);
    const conv = ctx.conversations.list().find((c) => c.customerPhone === o.phone)!;
    ctx.conversations.setMode(conv.id, 'manual', 'medarbejder tog over', 'staff');
    const before = smsTo(o.phone).length;
    for (let i = 0; i < 12; i++) await t!.run(61_000); // forslaget udløber
    expect(offerOf(o.id)[0].status).toBe('expired');
    expect(ctx.orders.get(o.id)!.status).toBe('needs_manual');
    expect(ctx.conversations.get(conv.id)!.aiMode).toBe('manual');
    expect(smsTo(o.phone).length).toBe(before);
  });

  it('ordrer med aftalt tidsrum eller afventende svar udløser ikke "manglende kapacitet → overtagelse"', async () => {
    const s = await setup();
    const { ctx } = t!.app;
    const o = await orderNeedingAlternative(s);
    t!.clock.t += 25 * MIN; // kunden har ikke svaret endnu (forslaget er stadig åbent i testen)
    ctx.db.prepare(`UPDATE delivery_time_offers SET expires_at = ? WHERE order_id = ?`).run(new Date(t!.clock.t + 10 * MIN).toISOString(), o.id);
    await t!.app.agents.monitor.evaluate();
    expect(t!.app.agents.monitor.list({ status: ['open'] }).find((a) => a.rule === 'capacity_shortage')).toBeUndefined();
  });
});
