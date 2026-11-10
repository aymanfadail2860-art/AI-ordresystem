import type { App } from '../app';
import { clock } from '../clock';

/**
 * Demo: chauffør med lager til 5 af 7 stop. Opretter syv fiktive ordrer på en
 * rute, hvor de sidste to må dækkes fra centrallageret → systemet foreslår
 * lageropfyldning til ledelsesgruppen.
 */
export async function replenishmentScenario(app: App): Promise<{ driverName: string; orderIds: number[] }> {
  const ctx = app.ctx;
  if (app.mode !== 'demo') throw new Error('Kun i Demo Mode');
  const product = ctx.catalog.getBySku('COLA50') ?? ctx.catalog.list()[0];
  const central = ctx.inventory.centralLocation();
  if (!central) throw new Error('Intet centrallager');
  const drivers = ctx.drivers.list().filter((d) => d.vehicleLocationId && d.status !== 'offline');
  const driver = drivers.find((d) => d.activeOrderCount === 0 && d.pendingOfferCount === 0) ?? drivers[0];
  if (!driver) throw new Error('Ingen ledig chauffør');
  const vehicle = driver.vehicleLocationId!;
  // Præcis 10 ledige i bilen
  const lvl = ctx.inventory.levels().find((l) => l.locationId === vehicle && l.productId === product.id);
  const free = (lvl?.quantity ?? 0) - (lvl?.reserved ?? 0);
  if (free !== 10) ctx.inventory.adjust(vehicle, product.id, 10 - free, 'Demo: opfyldningsscenarie', 'system');
  const base = driver.lastLat != null ? { lat: driver.lastLat, lng: driver.lastLng! } : { lat: 55.68, lng: 12.56 };
  const ids: number[] = [];
  const stamp = clock.now() % 1000;
  for (let i = 1; i <= 7; i++) {
    const phone = `+4599995${String((stamp + i) % 1000).padStart(3, '0')}`;
    const c = ctx.conversations.upsertCustomer(phone);
    const conv = ctx.conversations.getOrCreateConversation(c.id);
    const { id } = ctx.orders.createDraft({ customerId: c.id, conversationId: conv, idempotencyKey: `demo-rep:${phone}:${clock.now()}`, actor: 'system' });
    ctx.orders.setLines(id, [{ productId: product.id, quantity: 2 }], ctx.settings.get().pricing, 'system');
    ctx.orders.updateFields(id, { addressText: `Demogade ${i * 10}, 2100 København Ø`, addressLat: base.lat + i * 0.007, addressLng: base.lng + 0.002 * (i % 2), addressValidated: true }, 'system');
    ctx.orders.transition(id, 'awaiting_stock_check', 'system');
    ctx.inventory.reserveForOrder(id, i <= 5 ? vehicle : central.id);
    ctx.orders.transition(id, 'awaiting_confirmation', 'system');
    ctx.orders.transition(id, 'confirmed', 'customer');
    ctx.orders.transition(id, 'awaiting_driver', 'system');
    ids.push(id);
  }
  for (const id of ids) await app.agents.dispatch.assign(id, driver.id, 'system');
  app.agents.routing.applySequence(driver.id, ids, 'demo-scenarie');
  await app.agents.routing.refreshEtas(driver.id, 'demo-scenarie');
  app.agents.replenishment.scheduleCheck(driver.id, 'demo-scenarie');
  return { driverName: driver.name, orderIds: ids };
}
