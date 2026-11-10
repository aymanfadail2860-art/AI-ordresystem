import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clock } from '../src/server/clock';
import { createApp, type App } from '../src/server/app';
import { MemorySecretStore } from '../src/server/secrets';
import { SimulatedSmsAdapter } from '../src/server/adapters/sms/simulator';
import { SimulatedTelegramAdapter } from '../src/server/adapters/telegram/simulator';
import { ConcurrentModificationError } from '../src/server/services/orders';
import { InsufficientStockError } from '../src/server/services/inventory';
import { FakeLlm, km, placeOrder, TestMaps, makeApp, type TestApp } from './helpers';
import { opsApp, opsData, phone, route, say, press, lastGroup, groupOut, GROUP, USERS } from './ops-fixture';

/**
 * Robusthed og fejlscenarier (Etape 4, afsnit 5). Nogle scenarier er dækket af
 * eksisterende tests – se TESTING.md for den fulde oversigt.
 */
let t: TestApp | null = null;
afterEach(async () => {
  clock.reset();
  await t?.app.stop();
  t = null;
});

const MIN = 60_000;
const level = (app: App, loc: number, pid: number) => app.ctx.inventory.levels().find((l) => l.locationId === loc && l.productId === pid)!;

/** Installation med fil-database, så den kan "genstartes". */
function fileInstall(mode: 'demo' | 'production' = 'production') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-robust-'));
  const now = { t: Date.parse('2026-06-16T10:00:00Z') };
  clock.set(() => now.t);
  const open = async (llm: FakeLlm | null = null) => {
    const tg = new SimulatedTelegramAdapter();
    const app = await createApp({
      mode,
      dbFile: path.join(dir, 'db.sqlite'),
      backupDir: path.join(dir, 'b'),
      secrets: new MemorySecretStore(),
      manualJobs: true,
      skipSeed: true,
      now: () => now.t,
      overrides: { sms: new SimulatedSmsAdapter(), telegram: tg, maps: new TestMaps(), llm },
    });
    await app.start();
    app.demo?.stop();
    const drain = async (advance = 2000) => {
      now.t += advance;
      for (let i = 0; i < 20; i++) {
        await app.ctx.jobs.drain();
        await new Promise((r) => setImmediate(r));
        if (app.ctx.jobs.tick() === 0) break;
      }
      await app.ctx.jobs.drain();
    };
    return { app, tg, drain };
  };
  return { open, now };
}

describe('Genstart', () => {
  it('under en aktiv ordre: leveringen registreres og lageret fradrages præcis én gang', async () => {
    const f = fileInstall();
    const a = await f.open();
    const d = opsData(a.app);
    a.app.ctx.settings.update({ installation: { automationEnabled: true } });
    const id = placeOrder(a.app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: d.cola.id, quantity: 3 }], locationId: d.anna.vehicleLocationId! });
    await route(a.app, d.anna.id, [id]);
    a.tg.injectCallback(d.anna.telegramUserId!, 'Anna', `ord:${id}:pickup`);
    await a.drain();
    expect(a.app.ctx.orders.get(id)!.status).toBe('out_for_delivery');
    const before = level(a.app, d.anna.vehicleLocationId!, d.cola.id).quantity;
    await a.app.stop();

    const b = await f.open();
    b.tg.injectCallback(d.anna.telegramUserId!, 'Anna', `ord:${id}:delivered`);
    b.tg.injectText(d.anna.telegramUserId!, 'Anna', `Ordre ${id} er leveret`);
    await b.drain();
    expect(b.app.ctx.orders.get(id)!.status).toBe('delivered');
    expect(level(b.app, d.anna.vehicleLocationId!, d.cola.id).quantity).toBe(before - 3);
    expect(b.app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM order_events WHERE order_id = ? AND to_status = 'delivered'`).get(id)).toEqual({ c: 1 });
    await b.app.stop();
  });

  it('under ledelsesgodkendelse: bekræftelsen virker efter genstart og udføres kun én gang', async () => {
    const f = fileInstall('demo');
    const a = await f.open();
    const d = opsData(a.app);
    const id = placeOrder(a.app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: d.cola.id, quantity: 1 }], locationId: d.anna.vehicleLocationId! });
    await route(a.app, d.anna.id, [id]);
    a.tg.injectGroupText(GROUP, USERS.manager.uid, USERS.manager.name, `Flyt ordre ${id} til chauffør ${d.bo.id}`);
    await a.drain();
    const cmd = a.app.management.commands(1)[0];
    expect(cmd.decision).toBe('needs_confirmation');
    await a.app.stop();

    const b = await f.open();
    b.tg.injectGroupCallback(GROUP, USERS.manager.uid, USERS.manager.name, `mgmt:${cmd.id}:confirm`);
    b.tg.injectGroupCallback(GROUP, USERS.manager.uid, USERS.manager.name, `mgmt:${cmd.id}:confirm`); // dobbelttryk
    await b.drain();
    expect(b.app.management.commands(5).find((c) => c.id === cmd.id)!.decision).toBe('executed');
    expect(b.app.ctx.drivers.offers(id).filter((o) => o.driverId === d.bo.id)).toHaveLength(1);
    expect(groupOut(b.app.ctx).some((m) => /allerede afgjort/.test(m))).toBe(true);
    // Nedbrud midt i udførelsen af en anden handling → markeres usikker og udføres aldrig automatisk
    b.app.ctx.db.prepare(`UPDATE management_commands SET decision = 'executing' WHERE id = ?`).run(cmd.id);
    await b.app.stop();
    const c = await f.open();
    expect(c.app.management.commands(5).find((x) => x.id === cmd.id)!.decision).toBe('uncertain');
    expect(c.app.ctx.events.list({ limit: 20 }).some((e) => e.type === 'command_uncertain')).toBe(true);
    await c.app.stop();
  });

  it('efter længere nedetid: udløbne tilbud afsluttes, ordren planlægges igen, og intet sendes dobbelt', async () => {
    const f = fileInstall();
    const a = await f.open();
    const d = opsData(a.app);
    a.app.ctx.settings.update({ installation: { automationEnabled: true } });
    const id = placeOrder(a.app.ctx, { phone: phone(), at: km(1, 0), lines: [{ productId: d.cola.id, quantity: 1 }], locationId: d.anna.vehicleLocationId! });
    a.app.agents.dispatch.enqueue(id);
    await a.drain();
    const offer = a.app.ctx.drivers.offers(id).find((o) => o.status === 'pending')!;
    expect(offer).toBeTruthy();
    const sentBefore = a.app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM driver_messages WHERE direction = 'out'`).get() as { c: number };
    await a.app.stop();
    f.now.t += 3 * 60 * MIN; // nede i 3 timer
    const b = await f.open();
    b.app.agents.logistics.start();
    await b.drain(10_000);
    await b.drain(61_000);
    expect(b.app.ctx.drivers.offers(id).find((o) => o.id === offer.id)!.status).toBe('expired');
    // Ordren er ikke tabt: den har et nyt tilbud eller er markeret til manuel håndtering
    const o = b.app.ctx.orders.get(id)!;
    expect(['awaiting_driver', 'needs_manual', 'driver_assigned']).toContain(o.status);
    expect(b.app.ctx.drivers.offers(id).filter((x) => x.status === 'pending').length).toBeLessThanOrEqual(1);
    // Ingen besked er sendt to gange til samme chauffør (det gamle tilbud gensendes ikke)
    const dup = b.app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM (SELECT driver_id, body FROM driver_messages WHERE direction = 'out' GROUP BY driver_id, body HAVING COUNT(*) > 1)`).get() as { c: number };
    expect(dup.c).toBe(0);
    void sentBefore;
    await b.app.stop();
  });
});

describe('Telegram', () => {
  it('manglende forbindelse: beskeder venter på forbindelsen i stedet for at blive opgivet, og sendes én gang', async () => {
    const s = await opsApp();
    t = s.t;
    const { app } = t;
    t.tg.setOutage(true);
    expect(app.ctx.integrations.get('telegram')!.state).toBe('error');
    app.ctx.telegram.sendToDriver(s.anna.id, 'Testbesked under udfald', 'test:outage');
    app.ctx.telegram.sendToChat(GROUP, 'Gruppebesked under udfald', 'test:outage-group');
    for (let i = 0; i < 12; i++) await t.run(61_000); // 12 minutter uden forbindelse
    const msg = () => app.ctx.db.prepare(`SELECT status FROM driver_messages WHERE body = 'Testbesked under udfald'`).get() as { status: string };
    expect(msg().status).toBe('queued');
    expect(app.ctx.telegram.chatMessageStatus('test:outage-group')).toBe('queued');
    t.tg.setOutage(false);
    await t.run(61_000);
    await t.run(61_000);
    expect(msg().status).toBe('sent');
    expect(app.ctx.telegram.chatMessageStatus('test:outage-group')).toBe('sent');
    await t.run(61_000);
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE type IN ('send_telegram','send_telegram_chat') AND status = 'pending'`).get()).toEqual({ c: 0 });
  });

  it('dublerede opdateringer behandles én gang; forsinket accept af et udløbet tilbud tildeler ikke ordren', async () => {
    const s = await opsApp();
    t = s.t;
    const { app } = t;
    const id = placeOrder(app.ctx, { phone: phone(), at: km(1, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await route(app, s.anna.id, [id]);
    // Samme Telegram-update leveret to gange (fx efter netværksfejl i long polling)
    const handlers = (t.tg as unknown as { handlers: { onUpdate: (u: unknown) => void } }).handlers;
    const upd = { kind: 'callback', fromUserId: s.anna.telegramUserId, fromName: 'Anna', chatId: s.anna.telegramUserId, callbackData: `ord:${id}:delivered`, callbackId: 'cb-x', updateId: 'dup-1', at: clock.iso() };
    handlers.onUpdate(upd);
    handlers.onUpdate(upd);
    await t.run();
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM order_events WHERE order_id = ? AND to_status = 'delivered'`).get(id)).toEqual({ c: 1 });
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM driver_messages WHERE external_update_id LIKE '%:dup-1'`).get()).toEqual({ c: 1 });

    // Forsinket accept
    const id2 = placeOrder(app.ctx, { phone: phone(), at: km(1, 1), lines: [{ productId: s.chips.id, quantity: 1 }], locationId: s.central });
    app.agents.dispatch.enqueue(id2);
    await t.run();
    const offer = app.ctx.drivers.offers(id2).find((o) => o.status === 'pending')!;
    app.ctx.db.prepare(`UPDATE dispatch_offers SET status = 'expired' WHERE id = ?`).run(offer.id);
    t.tg.injectCallback(`sim-driver-${offer.driverId}`, 'Chauffør', `offer:${offer.id}:accept`);
    await t.run();
    expect(app.ctx.orders.get(id2)!.driverId).toBeNull();
  });
});

describe('Samtidighed og belastning', () => {
  it('samtidige ordreændringer: optimistisk låsning afviser den forældede ændring', async () => {
    const s = await opsApp();
    t = s.t;
    const { ctx } = t.app;
    const id = placeOrder(ctx, { phone: phone(), at: km(1, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    const v = ctx.orders.get(id)!.version;
    ctx.orders.transition(id, 'needs_manual', 'staff', { reason: 'medarbejder A' }, v);
    expect(() => ctx.orders.transition(id, 'cancelled', 'staff', { reason: 'medarbejder B' }, v)).toThrow(ConcurrentModificationError);
    expect(ctx.orders.get(id)!.status).toBe('needs_manual');
  });

  it('lagerreservation under høj belastning: 200 samtidige ordrer om 50 varer → præcis 50 reserveres', async () => {
    const s = await opsApp();
    t = s.t;
    const { ctx } = t.app;
    const rare = ctx.catalog.create({ sku: 'RARE', name: 'Sjælden vare', category: 'Test', priceOre: 1000 });
    ctx.inventory.adjust(s.central, rare.id, 50, 'start', 'system');
    const ids: number[] = [];
    for (let i = 0; i < 200; i++) {
      const c = ctx.conversations.upsertCustomer(`+4550${String(100000 + i)}`);
      const conv = ctx.conversations.getOrCreateConversation(c.id);
      const { id } = ctx.orders.createDraft({ customerId: c.id, conversationId: conv, idempotencyKey: `load:${i}`, actor: 'staff' });
      ctx.orders.setLines(id, [{ productId: rare.id, quantity: 1 }], ctx.settings.get().pricing, 'staff');
      ids.push(id);
    }
    const results = await Promise.allSettled(ids.map(async (id) => ctx.inventory.reserveForOrder(id, s.central)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(50);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientStockError)).toBe(true);
    expect(level(t.app, s.central, rare.id)).toMatchObject({ quantity: 50, reserved: 50 });
  });
});

describe('Udløbne knapper', () => {
  it('bekræftelse efter udløb udfører intet; godkendelse af en udløbet opfyldning afvises', async () => {
    const s = await opsApp();
    t = s.t;
    clock.set(() => t!.clock.t);
    const { app } = t;
    const id = placeOrder(app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: s.cola.id, quantity: 1 }], locationId: s.anna.vehicleLocationId! });
    await route(app, s.anna.id, [id]);
    say(t, 'manager', `Flyt ordre ${id} til chauffør ${s.bo.id}`);
    await t.run();
    const cmd = app.management.commands(1)[0];
    t.clock.t += 30 * MIN;
    press(t, 'manager', `mgmt:${cmd.id}:confirm`);
    await t.run();
    expect(app.management.commands(1)[0].decision).toBe('expired');
    expect(lastGroup(app.ctx)).toMatch(/udløbet/);
    expect(app.ctx.drivers.offers(id).filter((o) => o.driverId === s.bo.id)).toHaveLength(0);
    // Udløbet opfyldning
    const r = app.ctx.db
      .prepare(`INSERT INTO replenishments (driver_id, location_id, status, items, covers_orders, created_at, updated_at) VALUES (?, ?, 'expired', '[]', '[]', ?, ?)`)
      .run(s.anna.id, s.central, clock.iso(), clock.iso());
    press(t, 'manager', `rep:${r.lastInsertRowid}:approve`);
    await t.run();
    expect(app.agents.replenishment.get(Number(r.lastInsertRowid))!.status).toBe('expired');
  });
});

describe('AI og kort', () => {
  it('manglende Claude API: ledelsen kan stadig få rapport og svar (regelbaseret reserve)', async () => {
    t = await makeApp({ mode: 'production', seed: false, overrides: { maps: new TestMaps() } });
    opsData(t.app);
    say(t, 'observer', 'Rapport');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/Rapport kl\./);
    expect(lastGroup(t.app.ctx)).toMatch(/ingen Claude API-kald/);
    say(t, 'manager', 'Hvad har vi omsat for i dag?');
    await t.run();
    expect(lastGroup(t.app.ctx)).toMatch(/omsat|Omsætning/i);
  });

  it('ugyldige AI-svar udfører aldrig en handling', async () => {
    const llm = new FakeLlm(() => ({ intent: 'reassign_order', orderId: 'ikke et tal' }));
    t = await makeApp({ mode: 'production', seed: false, llm, overrides: { maps: new TestMaps() } });
    const d = opsData(t.app);
    const id = placeOrder(t.app.ctx, { phone: phone(), at: km(2, 0), lines: [{ productId: d.cola.id, quantity: 1 }], locationId: d.anna.vehicleLocationId! });
    await route(t.app, d.anna.id, [id]);
    say(t, 'manager', `Flyt ordre ${id} til chauffør ${d.bo.id}`);
    await t.run();
    const cmd = t.app.management.commands(1)[0];
    expect(['clarify', 'failed', 'needs_confirmation']).toContain(cmd.decision);
    expect(t.app.ctx.drivers.offers(id).filter((o) => o.driverId === d.bo.id)).toHaveLength(0);
    expect(t.app.ctx.orders.get(id)!.driverId).toBe(d.anna.id);
  });

  it('fejl i Google Maps: adressen valideres ikke, samtalen går til medarbejder, og intet loves', async () => {
    const maps = new TestMaps();
    maps.geocode = async () => {
      throw new Error('HTTP 503');
    };
    t = await makeApp({ seed: false, overrides: { maps } });
    const d = opsData(t.app);
    void d;
    t.sms.injectInbound('+4588776655', 'Hej, kan jeg få 2 Coca-Cola til Lærkevej 12, 2200 København N?');
    await t.run();
    await t.run(5000);
    const o = t.app.ctx.orders.list({}).find((x) => x.customerPhone === '+4588776655');
    expect(o?.status).not.toBe('awaiting_confirmation');
    const conv = t.app.ctx.conversations.list().find((c) => c.customerPhone === '+4588776655')!;
    expect(conv.aiMode).toBe('ai_paused');
    expect(t.sms.sentLog.filter((m) => m.to === '+4588776655').every((m) => !/Svar JA/.test(m.text))).toBe(true);
  });
});
