import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t?.app.stop();
});

describe('End-to-end: SMS-bestilling → levering (Demo Mode, simulerede adaptere)', () => {
  it('gennemfører hele flowet fra kundebesked til leveret ordre', async () => {
    t = await makeApp();
    const { ctx } = t.app;
    const phone = '+4599991111';
    t.sms.injectInbound(phone, 'Hej, kan jeg få 2 Red Bull og en pose chips til Fiktivgade 12, 2200 København N?');
    await t.run();
    const quote = t.lastSmsTo(phone);
    expect(quote).toContain('Svar JA');
    expect(quote).toContain('2 × Red Bull');

    const conv = ctx.conversations.list().find((c) => c.customerPhone === phone)!;
    const orderId = conv.activeOrderId!;
    let order = ctx.orders.get(orderId)!;
    expect(order.status).toBe('awaiting_confirmation');
    expect(order.subtotalOre).toBe(2 * 2500 + 3000);

    t.sms.injectInbound(phone, 'Ja tak');
    await t.run();
    order = ctx.orders.get(orderId)!;
    // Dispatch sender et tilbud til en chauffør via (simuleret) Telegram
    const offer = ctx.drivers.offers(orderId).find((o) => o.status === 'pending');
    expect(offer).toBeTruthy();
    const driver = ctx.drivers.get(offer!.driverId)!;

    t.tg.injectCallback(driver.telegramUserId!, driver.name, `offer:${offer!.id}:accept`);
    await t.run();
    order = ctx.orders.get(orderId)!;
    expect(order.status).toBe('driver_assigned');
    expect(order.driverId).toBe(driver.id);

    t.tg.injectCallback(driver.telegramUserId!, driver.name, `ord:${orderId}:pickup`);
    await t.run();
    expect(ctx.orders.get(orderId)!.status).toBe('out_for_delivery');

    const stockBefore = ctx.inventory.levels().filter((l) => l.locationId === order.stockLocationId);
    t.tg.injectText(driver.telegramUserId!, driver.name, `Ordre ${orderId} er leveret`);
    await t.run();
    order = ctx.orders.get(orderId)!;
    expect(order.status).toBe('delivered');
    expect(t.lastSmsTo(phone)).toContain('leveret');
    const stockAfter = ctx.inventory.levels().filter((l) => l.locationId === order.stockLocationId);
    const rb = ctx.catalog.getBySku('RB25')!;
    const before = stockBefore.find((l) => l.productId === rb.id)!;
    const after = stockAfter.find((l) => l.productId === rb.id)!;
    expect(after.quantity).toBe(before.quantity - 2);
    expect(after.reserved).toBe(before.reserved - 2);
  });
});
