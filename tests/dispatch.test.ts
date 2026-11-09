import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, fixture, convFor, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => t?.app.stop());
const PHONE = '+4555556666';

async function confirmedOrder(t: TestApp, text: string) {
  t.sms.injectInbound(PHONE, text);
  await t.run();
  t.sms.injectInbound(PHONE, 'ja');
  await t.run();
  return convFor(t.app.ctx, PHONE).activeOrderId!;
}

describe('Dispatch Agent', () => {
  it('tildeler kun chauffør, hvis bilen har varerne (uden centrallager-afhentning)', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    ctx.settings.update({ delivery: { allowCentralPickup: false } });
    const id = await confirmedOrder(t, '2 red bull til Fiktivgade 1, 2200 København N');
    const offers = ctx.drivers.offers(id);
    expect(offers).toHaveLength(1);
    expect(offers[0].driverId).toBe(f.a.id); // kun Anna har Red Bull i bilen
  });

  it('ingen chauffør med varer → ordren tildeles ikke og der advares', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    ctx.settings.update({ delivery: { allowCentralPickup: false } });
    t.sms.injectInbound(PHONE, '2 chips til Fiktivgade 1, 2200 København N');
    await t.run();
    // Chips findes kun på centrallageret, som ikke må bruges → intet tilbud muligt
    expect(t.lastSmsTo(PHONE)).toMatch(/ikke nok|ikke samle/);
  });

  it('afvisning sender tilbuddet videre til næste chauffør', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const id = await confirmedOrder(t, '2 chips til Fiktivgade 1, 2200 København N');
    const first = ctx.drivers.offers(id)[0];
    const d1 = ctx.drivers.get(first.driverId)!;
    t.tg.injectCallback(d1.telegramUserId!, d1.name, `offer:${first.id}:reject`);
    await t.run();
    const all = ctx.drivers.offers(id);
    expect(all.find((o) => o.id === first.id)!.status).toBe('rejected');
    const second = all.find((o) => o.status === 'pending')!;
    expect(second.driverId).not.toBe(first.driverId);
  });

  it('udløbet tilbud går videre', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const id = await confirmedOrder(t, '2 chips til Fiktivgade 1, 2200 København N');
    const first = ctx.drivers.offers(id)[0];
    ctx.db.prepare(`UPDATE dispatch_offers SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), first.id);
    await t.run(130_000);
    expect(ctx.drivers.offers(id).find((o) => o.id === first.id)!.status).toBe('expired');
    expect(ctx.drivers.offers(id).some((o) => o.status === 'pending' && o.driverId !== first.driverId)).toBe(true);
  });

  it('accept flytter reservationen til chaufførens bil og giver kunden besked', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    const id = await confirmedOrder(t, '2 red bull til Fiktivgade 1, 2200 København N');
    const offer = ctx.drivers.offers(id)[0];
    const d = ctx.drivers.get(offer.driverId)!;
    t.tg.injectCallback(d.telegramUserId!, d.name, `offer:${offer.id}:accept`);
    await t.run();
    const o = ctx.orders.get(id)!;
    expect(o.status).toBe('driver_assigned');
    expect(o.stockLocationId).toBe(d.vehicleLocationId);
    expect(ctx.inventory.levels().find((l) => l.locationId === d.vehicleLocationId && l.productId === f.rb.id)!.reserved).toBe(2);
    expect(t.lastSmsTo(PHONE)).toContain('kører med din ordre');
  });
});

describe('Driver Communication Agent', () => {
  async function assigned(t: TestApp) {
    const { ctx } = t.app;
    const id = await confirmedOrder(t, '2 red bull til Fiktivgade 1, 2200 København N');
    const offer = ctx.drivers.offers(id)[0];
    const d = ctx.drivers.get(offer.driverId)!;
    t.tg.injectCallback(d.telegramUserId!, d.name, `offer:${offer.id}:accept`);
    await t.run();
    return { id, d };
  }

  it('forstår "Jeg er fremme" og giver kunden besked', async () => {
    t = await makeApp({ seed: false });
    fixture(t.app.ctx);
    const { d } = await assigned(t);
    t.tg.injectText(d.telegramUserId!, d.name, 'Jeg er fremme');
    await t.run();
    expect(t.lastSmsTo(PHONE)).toContain('fremme');
  });

  it('forstår forsinkelse og opdaterer ETA', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const { id, d } = await assigned(t);
    const before = ctx.orders.get(id)!.eta!;
    t.tg.injectText(d.telegramUserId!, d.name, 'Jeg bliver 15 minutter forsinket');
    await t.run();
    const after = ctx.orders.get(id)!.eta!;
    expect(new Date(after).getTime() - new Date(before).getTime()).toBe(15 * 60000);
    expect(t.lastSmsTo(PHONE)).toContain('15 minutter forsinket');
  });

  it('"Kunden svarer ikke" markerer ordren og advarer kontoret', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const { id, d } = await assigned(t);
    t.tg.injectText(d.telegramUserId!, d.name, 'Kunden svarer ikke');
    await t.run();
    expect(ctx.orders.get(id)!.needsAttention).toBe(true);
    expect(ctx.events.list({ onlyOpen: true }).some((e) => e.type === 'customer_unreachable')).toBe(true);
  });

  it('"Jeg har ikke flere Red Bull" registreres som lagerafvigelse på berørte ordrer', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const { id, d } = await assigned(t);
    t.tg.injectText(d.telegramUserId!, d.name, 'Jeg har ikke flere Red Bull');
    await t.run();
    expect(ctx.orders.get(id)!.needsAttention).toBe(true);
    expect(ctx.events.list({ onlyOpen: true }).some((e) => e.type === 'vehicle_stock_discrepancy')).toBe(true);
  });

  it('"Ordre X er leveret" afslutter ordren og trækker lager', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const { id, d } = await assigned(t);
    t.tg.injectText(d.telegramUserId!, d.name, `Ordre ${id} er leveret`);
    await t.run();
    expect(ctx.orders.get(id)!.status).toBe('delivered');
    expect(ctx.drivers.get(d.id)!.status).toBe('available');
  });

  it('en chauffør kan ikke afslutte en anden chaufførs ordre', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    const { id, d } = await assigned(t);
    const other = [f.a, f.b].find((x) => x.id !== d.id)!;
    t.tg.injectText(other.telegramUserId!, other.name, `Ordre ${id} er leveret`);
    await t.run();
    expect(ctx.orders.get(id)!.status).toBe('driver_assigned');
  });

  it('ved flere aktive ordrer gætter systemet ikke – det spørger', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const { id, d } = await assigned(t);
    // Endnu en ordre til samme chauffør
    const phone2 = '+4555557777';
    t.sms.injectInbound(phone2, '1 red bull til Demovej 5, 2200 København N');
    await t.run();
    t.sms.injectInbound(phone2, 'ja');
    await t.run();
    const id2 = convFor(ctx, phone2).activeOrderId!;
    ctx.db.prepare(`UPDATE dispatch_offers SET status='cancelled' WHERE order_id = ?`).run(id2);
    await t.app.agents.dispatch.assign(id2, d.id, 'staff');
    t.tg.injectText(d.telegramUserId!, d.name, 'Leveret');
    await t.run();
    expect(ctx.orders.get(id)!.status).toBe('driver_assigned');
    expect(ctx.orders.get(id2)!.status).toBe('driver_assigned');
    const last = ctx.drivers.messages(d.id).filter((m) => m.direction === 'out').pop()!;
    expect(last.body).toMatch(/Hvilken ordre/);
  });

  it('ukendt Telegram-bruger kan knyttes til chauffør med engangskode', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const d = ctx.drivers.create({ name: 'Ny' });
    t.tg.injectText('tg-999', 'Ny Chauffør', `/start ${d.telegramLinkCode}`);
    await t.run();
    expect(ctx.drivers.get(d.id)!.telegramUserId).toBe('tg-999');
  });
});
