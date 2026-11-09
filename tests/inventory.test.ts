import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, fixture, type TestApp } from './helpers';
import { InsufficientStockError } from '../src/server/services/inventory';

let t: TestApp;
afterEach(async () => t?.app.stop());

function draftWith(t: TestApp, productId: number, qty: number, key: string) {
  const { ctx } = t.app;
  const c = ctx.conversations.upsertCustomer('+4511110000');
  const { id } = ctx.orders.createDraft({ customerId: c.id, conversationId: null, idempotencyKey: key, actor: 'staff' });
  ctx.orders.setLines(id, [{ productId, quantity: qty }], ctx.settings.get().pricing, 'staff');
  return id;
}

describe('Lagerreservation', () => {
  it('reserverer, frigiver og fradrager præcis én gang', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    const id = draftWith(t, f.rb.id, 3, 'k1');
    ctx.inventory.reserveForOrder(id, f.central);
    expect(ctx.inventory.available(f.central, f.rb.id)).toBe(97);
    expect(() => ctx.inventory.reserveForOrder(id, f.central)).toThrow(/allerede/);
    expect(ctx.inventory.releaseForOrder(id)).toBe(true);
    expect(ctx.inventory.releaseForOrder(id)).toBe(false); // idempotent
    expect(ctx.inventory.available(f.central, f.rb.id)).toBe(100);
    ctx.inventory.reserveForOrder(id, f.central);
    expect(ctx.inventory.deductForOrder(id)).toBe(true);
    expect(ctx.inventory.deductForOrder(id)).toBe(false);
    const lvl = ctx.inventory.levels().find((l) => l.locationId === f.central && l.productId === f.rb.id)!;
    expect(lvl).toMatchObject({ quantity: 97, reserved: 0 });
  });

  it('kan ikke reservere mere end ledigt – sidste vare går kun til én ordre', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    ctx.inventory.adjust(f.central, f.chips.id, -98, 'test');
    const o1 = draftWith(t, f.chips.id, 2, 'a');
    const o2 = draftWith(t, f.chips.id, 1, 'b');
    ctx.inventory.reserveForOrder(o1, f.central);
    expect(() => ctx.inventory.reserveForOrder(o2, f.central)).toThrow(InsufficientStockError);
    expect(ctx.inventory.available(f.central, f.chips.id)).toBe(0);
  });

  it('reservation er atomisk: mangler én vare, reserveres intet', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    const c = ctx.conversations.upsertCustomer('+4511110001');
    const { id } = ctx.orders.createDraft({ customerId: c.id, conversationId: null, idempotencyKey: 'x', actor: 'staff' });
    ctx.orders.setLines(id, [{ productId: f.rb.id, quantity: 5 }, { productId: f.chips.id, quantity: 1 }], ctx.settings.get().pricing, 'staff');
    // Bilen har Red Bull men ingen chips
    expect(() => ctx.inventory.reserveForOrder(id, f.a.vehicleLocationId!)).toThrow(InsufficientStockError);
    expect(ctx.inventory.available(f.a.vehicleLocationId!, f.rb.id)).toBe(10);
  });

  it('manuel regulering kan ikke fjerne reserverede varer', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    const id = draftWith(t, f.rb.id, 8, 'r');
    ctx.inventory.reserveForOrder(id, f.a.vehicleLocationId!);
    expect(() => ctx.inventory.adjust(f.a.vehicleLocationId!, f.rb.id, -5, 'svind')).toThrow(/reserveret/);
    ctx.inventory.adjust(f.a.vehicleLocationId!, f.rb.id, -2, 'svind');
    expect(ctx.inventory.available(f.a.vehicleLocationId!, f.rb.id)).toBe(0);
  });

  it('flytter reservation atomisk og overfører varer', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    const id = draftWith(t, f.rb.id, 4, 'm');
    ctx.inventory.reserveForOrder(id, f.central);
    ctx.inventory.moveReservation(id, f.a.vehicleLocationId!);
    expect(ctx.inventory.available(f.central, f.rb.id)).toBe(100);
    expect(ctx.inventory.available(f.a.vehicleLocationId!, f.rb.id)).toBe(6);
    expect(() => ctx.inventory.moveReservation(id, f.b.vehicleLocationId!)).toThrow(InsufficientStockError);
    ctx.inventory.transfer(f.central, f.b.vehicleLocationId!, f.rb.id, 5);
    ctx.inventory.moveReservation(id, f.b.vehicleLocationId!);
    expect(ctx.inventory.available(f.b.vehicleLocationId!, f.rb.id)).toBe(1);
  });

  it('annullering frigiver lager via tilstandsmaskinen', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    const id = draftWith(t, f.rb.id, 2, 'c');
    ctx.orders.transition(id, 'awaiting_stock_check', 'system');
    ctx.inventory.reserveForOrder(id, f.central);
    ctx.orders.transition(id, 'awaiting_confirmation', 'system');
    ctx.orders.cancel(id, 'test', 'staff');
    expect(ctx.inventory.available(f.central, f.rb.id)).toBe(100);
  });
});
