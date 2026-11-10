import { makeApp, TestMaps, km, placeOrder, type TestApp } from './helpers';
import type { App } from '../src/server/app';
import type { Ctx } from '../src/server/context';

export const GROUP = 'mgmt-group';
export const USERS = {
  admin: { uid: 'u-admin', name: 'Lise Admin' },
  manager: { uid: 'u-mgr', name: 'Omar Leder' },
  observer: { uid: 'u-obs', name: 'Jonas Observatør' },
};

/** Fælles testdata til ledelses- og opfyldningstests (ingen API-nøgler). */
export function opsData(app: App) {
  const ctx = app.ctx;
  ctx.settings.update({
    company: { name: 'Test ApS', phone: '+4570000000' },
    installation: { automationEnabled: true },
    openingHours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '00:00', closed: false }])) as never,
    pricing: { deliveryFeeOre: 3900, freeDeliveryThresholdOre: 0, minimumOrderOre: 0 },
    management: { groupChatId: GROUP, allowPrivateChats: false },
    delivery: { requireDriverAcceptance: true },
    // Påfyldning (v0.4.1) slået fra i de oprindelige opfyldningstests, så de måler præcis behovet
    replenishment: { topUpHorizonMinutes: 0 },
  });
  const cola = ctx.catalog.create({ sku: 'COLA', name: 'Coca-Cola', category: 'Sodavand', priceOre: 2500, costOre: 1200, synonyms: ['cola'] });
  const chips = ctx.catalog.create({ sku: 'CHIPS', name: 'Chips', category: 'Snacks', priceOre: 3000, synonyms: ['chips'] });
  const c = km(4, 0.5);
  const central = ctx.inventory.createLocation('Centrallager', 'central', null, c.lat, c.lng);
  ctx.inventory.adjust(central, cola.id, 100, 'start', 'system');
  ctx.inventory.adjust(central, chips.id, 100, 'start', 'system');
  const mk = (name: string, at: { lat: number; lng: number }) => {
    const d = ctx.drivers.create({ name, vehicleName: name, maxActiveOrders: 10 });
    const uid = `sim-driver-${d.id}`;
    ctx.db.prepare(`UPDATE drivers SET telegram_user_id = ?, telegram_chat_id = ? WHERE id = ?`).run(uid, uid, d.id);
    ctx.drivers.setStatus(d.id, 'available');
    ctx.drivers.setPosition(d.id, at.lat, at.lng, 'manual');
    return ctx.drivers.get(d.id)!;
  };
  const anna = mk('Anna', km(0, 0));
  const bo = mk('Bo', km(0, 3));
  ctx.inventory.adjust(anna.vehicleLocationId!, cola.id, 10, 'bil', 'system');
  ctx.inventory.adjust(bo.vehicleLocationId!, cola.id, 20, 'bil', 'system');
  const mgmt = app.management;
  const link = (role: 'admin' | 'manager' | 'observer', u: { uid: string; name: string }) => {
    const user = mgmt.createUser(u.name, role, 'test');
    mgmt.link(user.linkCode!, u.uid);
    return mgmt.user(user.id)!;
  };
  const admin = link('admin', USERS.admin);
  const manager = link('manager', USERS.manager);
  const observer = link('observer', USERS.observer);
  return { cola, chips, central, anna, bo, admin, manager, observer };
}

export async function opsApp() {
  const t = await makeApp({ seed: false, overrides: { maps: new TestMaps() } });
  return { t, ...opsData(t.app) };
}

let seq = 0;
export const phone = () => `+45777700${String(++seq).padStart(2, '0')}`;

/** Byg en bindende rute (rækkefølge som givet). */
export async function route(app: App, driverId: number, ids: number[]) {
  for (const id of ids) await app.agents.dispatch.assign(id, driverId, 'staff');
  app.agents.routing.applySequence(driverId, ids, 'test');
  await app.agents.routing.refreshEtas(driverId, 'test');
}

export function say(t: TestApp, who: keyof typeof USERS, text: string) {
  t.tg.injectGroupText(GROUP, USERS[who].uid, USERS[who].name, text);
}

export function press(t: TestApp, who: keyof typeof USERS, data: string) {
  t.tg.injectGroupCallback(GROUP, USERS[who].uid, USERS[who].name, data);
}

/** Seneste beskeder fra botten til ledelsesgruppen. */
export function groupOut(ctx: Ctx): string[] {
  return ctx.db.prepare(`SELECT body FROM management_messages WHERE chat_id = ? AND direction = 'out' ORDER BY id`).all(GROUP).map((r) => (r as { body: string }).body);
}

export function lastGroup(ctx: Ctx): string {
  return groupOut(ctx).at(-1) ?? '';
}

/** Rute med 7 stop à 2 cola; bilen har 10 cola → stop 6 og 7 dækkes fra centrallageret. */
export async function sevenStops(t: TestApp, d: ReturnType<typeof opsData>) {
  const ctx = t.app.ctx;
  const ids: number[] = [];
  for (let i = 1; i <= 7; i++) {
    ids.push(placeOrder(ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: d.cola.id, quantity: 2 }], locationId: i <= 5 ? d.anna.vehicleLocationId! : d.central }));
  }
  await route(t.app, d.anna.id, ids);
  await t.run();
  return ids;
}
