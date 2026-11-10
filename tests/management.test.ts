import { describe, it, expect, afterEach } from 'vitest';
import { km, placeOrder, type TestApp } from './helpers';
import { opsApp, route, say, press, lastGroup, groupOut, phone, GROUP, USERS } from './ops-fixture';
import { formatDkk } from '../src/core/money';
import { startOfToday } from '../src/server/services/orders';

/**
 * Ledelsesgruppen i Telegram – demo-scenarierne 1–4 samt rettigheder,
 * bekræftelser, logning og databasebaserede svar. Ingen API-nøgler.
 */
let t: TestApp;
afterEach(async () => t?.app.stop());

function lastCommand(t: TestApp) {
  return t.app.management.commands(1)[0];
}

async function withRoute() {
  const s = await opsApp();
  t = s.t;
  const ids = [1, 2, 3].map((i) => placeOrder(t.app.ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 2 }], locationId: s.anna.vehicleLocationId! }));
  await route(t.app, s.anna.id, ids);
  await t.run();
  return { ...s, ids };
}

describe('Spørgsmål fra ledelsen (svar fra databasen)', () => {
  it('1: "Hvad har vi omsat for i dag?" → præcist tal fra leverede ordrer', async () => {
    const s = await withRoute();
    t.tg.injectText(s.anna.telegramUserId!, 'Anna', `Ordre ${s.ids[0]} er leveret`);
    await t.run();
    const sum = (t.app.ctx.db.prepare(`SELECT COALESCE(SUM(total_ore),0) AS s FROM orders WHERE delivered_at >= ?`).get(startOfToday()) as { s: number }).s;
    expect(sum).toBeGreaterThan(0);
    say(t, 'observer', 'Hvad har vi omsat for i dag?');
    await t.run();
    const answer = lastGroup(t.app.ctx);
    expect(answer).toContain(formatDkk(sum));
    expect(answer).toContain('fra 1 ordrer');
    expect(answer).toMatch(/data kl\./);
    const cmd = lastCommand(t);
    expect(cmd).toMatchObject({ userName: USERS.observer.name, intent: 'revenue_today', decision: 'answered' });
  });

  it('2: "Hvordan går det med chauffør X?" → status, seneste Telegram-besked og rute', async () => {
    const s = await withRoute();
    t.tg.injectText(s.anna.telegramUserId!, 'Anna', `Ordre ${s.ids[0]}, jeg er der om 5 min`);
    await t.run();
    say(t, 'manager', `Hvordan går det med chauffør ${s.anna.id}?`);
    await t.run();
    const a = lastGroup(t.app.ctx);
    expect(a).toContain('Anna');
    expect(a).toContain(`jeg er der om 5 min`);
    for (const id of s.ids) expect(a).toContain(`#${id}`);
    expect(a).toMatch(/ingen live-GPS/);
  });

  it('svarer på lager, ventende ordrer, forsinkelser, lagerproblemer og "hvorfor"', async () => {
    const s = await withRoute();
    say(t, 'observer', `Hvor meget cola har chauffør ${s.anna.id} tilbage?`);
    await t.run();
    const lvl = t.app.ctx.inventory.levels().find((l) => l.locationId === s.anna.vehicleLocationId && l.productId === s.cola.id)!;
    expect(lastGroup(t.app.ctx)).toContain(`Coca-Cola: ${lvl.quantity} i bilen (${lvl.reserved} reserveret), ruten kræver 6`);
    say(t, 'observer', 'Hvilke ordrer afventer levering?');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/3 ordrer afventer levering/);
    say(t, 'observer', 'Hvem er mest forsinket?');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/forsinket|Ingen ordrer er forsinket/);
    say(t, 'observer', 'Vis mig alle lagerproblemer.');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/lagerproblemer/i);
    say(t, 'observer', `Hvorfor valgte du chauffør ${s.anna.id} til ordre ${s.ids[0]}?`);
    await t.run();
    expect(lastGroup(t.app.ctx)).toContain(`Ordre #${s.ids[0]} → Anna`);
    say(t, 'observer', 'Hvor mange ordrer mangler vi?');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/3 ordrer er ikke afsluttet/);
  });

  it('uklar instruktion → opklarende spørgsmål, intet udføres', async () => {
    await withRoute();
    say(t, 'manager', 'gør lige det der');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/hjælp/);
    expect(lastCommand(t).decision).toBe('clarify');
  });
});

describe('Handlinger, rettigheder og bekræftelse', () => {
  it('3: leder anmoder om omfordeling → kræver bekræftelse → tilbud til ny chauffør (som skal acceptere)', async () => {
    const s = await withRoute();
    const order = s.ids[2];
    say(t, 'manager', `Flyt ordre ${order} til chauffør ${s.bo.id}`);
    await t.run();
    const cmd = lastCommand(t);
    expect(cmd.decision).toBe('needs_confirmation');
    expect(lastGroup(t.app.ctx)).toMatch(/Bekræft/);
    expect(t.app.ctx.drivers.offers(order).filter((o) => o.status === 'pending')).toHaveLength(0); // intet før bekræftelse
    press(t, 'manager', `mgmt:${cmd.id}:confirm`);
    await t.run();
    const offer = t.app.ctx.drivers.offers(order).find((o) => o.status === 'pending')!;
    expect(offer.driverId).toBe(s.bo.id);
    expect(offer.kind).toBe('reassignment');
    expect(t.app.ctx.orders.get(order)!.driverId).toBe(s.anna.id); // ændres først ved accept
    const logged = t.app.management.commands(5).find((c) => c.id === cmd.id)!;
    expect(logged).toMatchObject({ decision: 'executed', confirmedBy: USERS.manager.name, affectedOrders: [order] });
    t.tg.injectCallback(s.bo.telegramUserId!, 'Bo', `offer:${offer.id}:accept`);
    await t.run();
    expect(t.app.ctx.orders.get(order)!.driverId).toBe(s.bo.id);
  });

  it('4: observatør forsøger en handling → afvist og logget', async () => {
    const s = await withRoute();
    say(t, 'observer', `Flyt ordre ${s.ids[0]} til chauffør ${s.bo.id}`);
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/må ikke udføre handlinger/);
    expect(lastCommand(t)).toMatchObject({ decision: 'denied', intent: 'reassign_order', affectedOrders: [s.ids[0]] });
    expect(t.app.ctx.drivers.offers(s.ids[0]).filter((o) => o.status === 'pending')).toHaveLength(0);
  });

  it('ukendt bruger i gruppen og forkert chat afvises', async () => {
    await withRoute();
    t.tg.injectGroupText(GROUP, 'u-ukendt', 'Fremmed', 'Hvad har vi omsat for i dag?');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/ikke registreret som leder/);
    expect(lastCommand(t).decision).toBe('denied');
    // Registreret leder, men fra en anden gruppe → behandles ikke som ledelseskommando
    const before = t.app.management.commands(100).length;
    t.tg.injectGroupText('anden-gruppe', USERS.admin.uid, USERS.admin.name, 'Slå automatik fra');
    await t.run();
    expect(t.app.ctx.settings.get().installation.automationEnabled).toBe(true);
    expect(t.app.management.commands(100).length).toBe(before);
  });

  it('kun den der gav instruktionen (eller en administrator) kan bekræfte', async () => {
    const s = await withRoute();
    say(t, 'manager', `Sæt ordre ${s.ids[2]} på pause`);
    await t.run();
    const cmd = lastCommand(t);
    press(t, 'observer', `mgmt:${cmd.id}:confirm`);
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/Kun Omar Leder eller en administrator/);
    expect(t.app.ctx.orders.get(s.ids[2])!.status).toBe('driver_assigned');
    press(t, 'admin', `mgmt:${cmd.id}:confirm`);
    await t.run();
    expect(t.app.ctx.orders.get(s.ids[2])!.status).toBe('needs_manual');
    expect(t.app.ctx.orders.get(s.ids[2])!.pausedFromStatus).toBe('driver_assigned');
    // Genoptag → tilbage til automatisk tildeling
    say(t, 'manager', `Genoptag ordre ${s.ids[2]}`);
    await t.run();
    press(t, 'manager', `mgmt:${lastCommand(t).id}:confirm`);
    await t.run();
    expect(['awaiting_driver', 'driver_assigned']).toContain(t.app.ctx.orders.get(s.ids[2])!.status);
    expect(t.app.ctx.orders.get(s.ids[2])!.pausedFromStatus).toBeNull();
  });

  it('kritiske regler kræver administrator', async () => {
    await withRoute();
    say(t, 'manager', 'Sæt tolerance til 10 min');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/må ikke ændre kritiske regler/);
    say(t, 'admin', 'Sæt tolerance til 10 min');
    await t.run();
    press(t, 'admin', `mgmt:${lastCommand(t).id}:confirm`);
    await t.run();
    expect(t.app.ctx.settings.get().economics.promiseToleranceMinutes).toBe(10);
    say(t, 'admin', 'Sæt tolerance til 500 min');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/mellem 0 og 30/);
  });

  it('prioritering rykker kun ordren frem, hvis løfterne holder – og kræver chaufførens accept', async () => {
    const s = await withRoute();
    const [a, b, c] = s.ids;
    const ctx = t.app.ctx;
    ctx.db.prepare(`UPDATE orders SET eta_communicated = NULL WHERE id IN (?, ?, ?)`).run(a, b, c);
    say(t, 'manager', `Prioritér ordre ${c}, hvis det kan ske uden at bryde leveringsløfter`);
    await t.run();
    press(t, 'manager', `mgmt:${lastCommand(t).id}:confirm`);
    await t.run();
    const offer = ctx.drivers.offers(c).find((o) => o.status === 'pending' && o.kind === 'route_change')!;
    expect(offer).toBeTruthy();
    expect(offer.plan!.sequence.indexOf(c)).toBeLessThan(2);
    expect(ctx.drivers.routeStops(s.anna.id).map((x) => x.orderId)).toEqual([a, b, c]); // uændret indtil accept
    t.tg.injectCallback(s.anna.telegramUserId!, 'Anna', `offer:${offer.id}:accept`);
    await t.run();
    expect(ctx.drivers.routeStops(s.anna.id).map((x) => x.orderId)).toEqual(offer.plan!.sequence);
  });

  it('prioritering afvises, hvis den ville bryde givne løfter', async () => {
    const s = await withRoute();
    const [a, b, c] = s.ids;
    const ctx = t.app.ctx;
    for (const id of [a, b]) ctx.db.prepare(`UPDATE orders SET eta_communicated = eta WHERE id = ?`).run(id);
    say(t, 'manager', `Prioritér ordre ${c}`);
    await t.run();
    press(t, 'manager', `mgmt:${lastCommand(t).id}:confirm`);
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/kan ikke rykkes frem uden at bryde leveringsløfter/);
    expect(ctx.drivers.offers(c).filter((o) => o.status === 'pending')).toHaveLength(0);
    expect(ctx.orders.get(c)!.priority).toBe(1);
  });

  it('"Find en bedre rute" sender et bedre forslag til chaufføren', async () => {
    const s = await opsApp();
    t = s.t;
    const ctx = t.app.ctx;
    // Bevidst dårlig rækkefølge: 3 km, 1 km, 2 km
    const ids = [3, 1, 2].map((i) => placeOrder(ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! }));
    await route(t.app, s.anna.id, ids);
    ctx.db.prepare(`UPDATE orders SET eta_communicated = NULL`).run();
    await t.run();
    say(t, 'manager', `Find en bedre rute til chauffør ${s.anna.id}`);
    await t.run();
    press(t, 'manager', `mgmt:${lastCommand(t).id}:confirm`);
    await t.run();
    expect(lastGroup(ctx)).toMatch(/Bedre rute fundet/);
    const offer = ctx.drivers.offers().find((o) => o.kind === 'route_change' && o.status === 'pending')!;
    expect(offer.plan!.sequence).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('godkendelse af opfyldning via tekst kræver bekræftelse; AI kan ikke godkende selv', async () => {
    const s = await opsApp();
    t = s.t;
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) ids.push(placeOrder(t.app.ctx, { phone: phone(), at: km(i, 0), lines: [{ productId: s.cola.id, quantity: 2 }], locationId: i <= 5 ? s.anna.vehicleLocationId! : s.central }));
    await route(t.app, s.anna.id, ids);
    await t.run();
    const rep = t.app.agents.replenishment.list({ activeOnly: true })[0];
    // Systemet har kun foreslået – intet er godkendt automatisk
    expect(rep.status).toBe('awaiting_management');
    expect(rep.approvedBy).toBeNull();
    say(t, 'manager', `Godkend opfyldning ${rep.id}`);
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!.status).toBe('awaiting_management');
    press(t, 'manager', `mgmt:${lastCommand(t).id}:confirm`);
    await t.run();
    expect(t.app.agents.replenishment.get(rep.id)!).toMatchObject({ status: 'awaiting_driver', approvedBy: USERS.manager.name });
  });

  it('alle instruktioner logges med bruger, instruktion, intention, beslutning og resultat', async () => {
    await withRoute();
    say(t, 'observer', 'Rapport');
    say(t, 'manager', 'hjælp');
    await t.run();
    const log = t.app.management.commands(10);
    expect(log.length).toBeGreaterThanOrEqual(2);
    for (const c of log) {
      expect(c.userName).toBeTruthy();
      expect(c.instruction).toBeTruthy();
      expect(c.decision).toBeTruthy();
      expect(c.result).toBeTruthy();
      expect(c.createdAt).toBeTruthy();
    }
    expect(groupOut(t.app.ctx).length).toBeGreaterThanOrEqual(2);
  });
});
