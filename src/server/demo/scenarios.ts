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

export type AltVariant = 'accept' | 'other_time' | 'earliest' | 'decline' | 'no_reply';

/**
 * Demo: alternativt leveringstidspunkt. Opretter en bekræftet ordre for en simuleret
 * kunde og sender – som når chaufførerne er fuldt booket – et forslag om senere
 * levering. Den simulerede kunde svarer efter den valgte variant. Kapacitetsudløseren
 * selv er dækket af tests og driftssimuleringen.
 */
export async function altTimeScenario(app: App, variant: AltVariant): Promise<{ phone: string; orderId: number; offerId: number | null }> {
  const ctx = app.ctx;
  if (app.mode !== 'demo' || !app.demo) throw new Error('Kun i Demo Mode');
  const product = ctx.catalog.list()[0];
  const loc = ctx.inventory.centralLocation();
  if (!product || !loc) throw new Error('Mangler produkter eller centrallager');
  const phone = `+459998${String(clock.now() % 10000).padStart(4, '0')}`;
  const c = ctx.conversations.upsertCustomer(phone);
  const conv = ctx.conversations.getOrCreateConversation(c.id);
  const { id } = ctx.orders.createDraft({ customerId: c.id, conversationId: conv, idempotencyKey: `demo-alt:${phone}`, actor: 'system' });
  ctx.orders.setLines(id, [{ productId: product.id, quantity: 2 }], ctx.settings.get().pricing, 'system');
  const center = ctx.settings.get().delivery;
  ctx.orders.updateFields(id, { addressText: 'Demovej 7, 2200 København N', addressLat: center.centerLat + 0.01, addressLng: center.centerLng + 0.01, addressValidated: true }, 'system');
  ctx.orders.transition(id, 'awaiting_stock_check', 'system');
  ctx.inventory.reserveForOrder(id, loc.id);
  ctx.orders.transition(id, 'awaiting_confirmation', 'system');
  ctx.orders.transition(id, 'confirmed', 'customer');
  ctx.orders.transition(id, 'awaiting_driver', 'system');
  const offerId = await app.agents.timeOffers.propose(id, 'demo: alle chauffører er fuldt booket');
  const offer = offerId ? app.agents.timeOffers.list({ orderId: id })[0] : null;
  const later = offer ? new Date(new Date(offer.windowEnd).getTime() + 60 * 60000) : null;
  const hhmm = (d: Date) => d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });
  const steps: Record<AltVariant, { when: RegExp; say: string }[]> = {
    accept: [{ when: /Passer det dig/, say: 'Ja, det er fint' }],
    other_time: [{ when: /Passer det dig/, say: later ? `Kan I komme kl. ${hhmm(later)}?` : 'Kan I komme kl. 22?' }],
    earliest: [
      { when: /Passer det dig/, say: 'Hvad er det tidligste?' },
      { when: /Passer det dig/, say: 'Ja tak' },
    ],
    decline: [{ when: /Passer det dig/, say: 'Nej, det er for sent' }],
    no_reply: [],
  };
  app.demo.registerBot(phone, steps[variant]);
  return { phone, orderId: id, offerId };
}

/**
 * Demo: næsten fuld bil. Sætter en kapacitet på chaufførens bil (lige over det, der er
 * i bilen nu) og kører opfyldningsscenariet – ledelsen ser bilens plads, hvilke ordrer
 * der kan dækkes, og hvilken påfyldning der er valgt eller fravalgt pga. plads.
 */
export async function vehicleCapacityScenario(app: App): Promise<{ driverName: string; orderIds: number[]; capacityUnits: number }> {
  const res = await replenishmentScenario(app);
  const driver = app.ctx.drivers.list().find((d) => d.name === res.driverName)!;
  const loc = driver.vehicleLocationId!;
  const used = app.ctx.inventory.capacity(loc).usedUnits;
  const capacityUnits = Math.ceil(used + 6);
  app.ctx.inventory.setCapacity(loc, { capacityUnits, categoryCaps: {}, flexUnits: null });
  const act = app.agents.replenishment.list({ driverId: driver.id, activeOnly: true })[0];
  if (act) app.agents.replenishment.cancel(act.id, 'demo', 'Ny beregning med bilens kapacitet');
  await app.agents.replenishment.evaluate(driver.id, 'demo: bilen er næsten fuld');
  return { ...res, capacityUnits };
}

