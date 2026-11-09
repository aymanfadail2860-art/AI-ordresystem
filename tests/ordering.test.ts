import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, fixture, convFor, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => t?.app.stop());

const PHONE = '+4522223333';
const ADDR = 'Fiktivgade 12, 2200 København N';

describe('Ordreflow og dubletbeskyttelse', () => {
  it('samme indgående besked (samme GUID) registreres og besvares kun én gang', async () => {
    t = await makeApp({ seed: false });
    fixture(t.app.ctx);
    const inbound = { externalGuid: 'GUID-1', from: PHONE, text: `2 red bull til ${ADDR}`, receivedAt: new Date().toISOString(), service: 'SMS' };
    t.app.ctx.sms.ingestInbound(inbound);
    t.app.ctx.sms.ingestInbound(inbound);
    t.app.ctx.sms.ingestInbound({ ...inbound });
    await t.run();
    const conv = convFor(t.app.ctx, PHONE);
    const msgs = t.app.ctx.conversations.messages(conv.id);
    expect(msgs.filter((m) => m.direction === 'in')).toHaveLength(1);
    expect(msgs.filter((m) => m.direction === 'out')).toHaveLength(1);
    expect(t.app.ctx.orders.list({})).toHaveLength(1);
  });

  it('flere hurtige SMS behandles samlet som én tur med ét svar', async () => {
    t = await makeApp({ seed: false });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, '2 red bull');
    t.sms.injectInbound(PHONE, `til ${ADDR}`);
    await t.run();
    const conv = convFor(t.app.ctx, PHONE);
    const out = t.app.ctx.conversations.messages(conv.id).filter((m) => m.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('Svar JA');
  });

  it('udgående besked med samme idempotensnøgle oprettes kun én gang', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const c = ctx.conversations.upsertCustomer(PHONE);
    const conv = ctx.conversations.getOrCreateConversation(c.id);
    ctx.sms.queue(conv, 'Hej', 'system', 'key-1');
    ctx.sms.queue(conv, 'Hej', 'system', 'key-1');
    await t.run();
    expect(t.sms.sentLog.filter((m) => m.to === PHONE)).toHaveLength(1);
  });

  it('kladde-oprettelse er idempotent', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const c = ctx.conversations.upsertCustomer(PHONE);
    const a = ctx.orders.createDraft({ customerId: c.id, conversationId: null, idempotencyKey: 'draft:1:1', actor: 'ai' });
    const b = ctx.orders.createDraft({ customerId: c.id, conversationId: null, idempotencyKey: 'draft:1:1', actor: 'ai' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.id).toBe(b.id);
  });

  it('spørger efter manglende adresse og fortsætter når den kommer', async () => {
    t = await makeApp({ seed: false });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, 'Kan jeg få 3 chips');
    await t.run();
    expect(t.lastSmsTo(PHONE)).toMatch(/adresse/i);
    const conv = convFor(t.app.ctx, PHONE);
    expect(t.app.ctx.orders.get(conv.activeOrderId!)!.status).toBe('awaiting_customer_info');
    t.sms.injectInbound(PHONE, ADDR);
    await t.run();
    expect(t.lastSmsTo(PHONE)).toContain('3 × Kartoffelchips');
  });

  it('ændring før bekræftelse frigiver og genreserverer lager', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    t.sms.injectInbound(PHONE, `2 red bull til ${ADDR}`);
    await t.run();
    t.sms.injectInbound(PHONE, 'tilføj også 3 chips');
    await t.run();
    const o = ctx.orders.get(convFor(ctx, PHONE).activeOrderId!)!;
    expect(o.status).toBe('awaiting_confirmation');
    expect(o.lines.map((l) => [l.sku, l.quantity]).sort()).toEqual([['CHIPS', 3], ['RB25', 2]]);
    const reservedTotal = ctx.inventory.levels().filter((l) => l.productId === f.rb.id).reduce((s, l) => s + l.reserved, 0);
    expect(reservedTotal).toBe(2); // ikke 4 – den gamle reservation er frigivet
  });

  it('kunden kan annullere, og lageret frigives', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    t.sms.injectInbound(PHONE, `2 red bull til ${ADDR}`);
    await t.run();
    t.sms.injectInbound(PHONE, 'ja');
    await t.run();
    const id = convFor(ctx, PHONE).activeOrderId!;
    t.sms.injectInbound(PHONE, 'annuller min ordre');
    await t.run();
    expect(ctx.orders.get(id)!.status).toBe('cancelled');
    expect(ctx.inventory.levels().filter((l) => l.productId === f.rb.id).reduce((s, l) => s + l.reserved, 0)).toBe(0);
    expect(t.lastSmsTo(PHONE)).toContain('annulleret');
  });

  it('udløbet tilbud annulleres og frigiver lager', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const f = fixture(ctx);
    t.sms.injectInbound(PHONE, `2 red bull til ${ADDR}`);
    await t.run();
    const id = convFor(ctx, PHONE).activeOrderId!;
    ctx.db.prepare(`UPDATE orders SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 31 * 60000).toISOString(), id);
    await t.run(31 * 60000);
    expect(ctx.orders.get(id)!.status).toBe('cancelled');
    expect(ctx.inventory.available(f.central, f.rb.id) + ctx.inventory.available(f.a.vehicleLocationId!, f.rb.id)).toBe(110);
  });

  it('adresse uden for leveringsområdet afvises', async () => {
    t = await makeApp({ seed: false });
    fixture(t.app.ctx);
    t.app.ctx.settings.update({ delivery: { postalCodes: ['2100'] } });
    t.sms.injectInbound(PHONE, `2 red bull til ${ADDR}`);
    await t.run();
    expect(t.lastSmsTo(PHONE)).toContain('uden for vores leveringsområde');
  });

  it('klage sendes til medarbejder og AI pauseres', async () => {
    t = await makeApp({ seed: false });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, 'Min ordre kom aldrig, jeg vil have pengene tilbage');
    await t.run();
    const conv = convFor(t.app.ctx, PHONE);
    expect(conv.aiMode).toBe('ai_paused');
    expect(t.lastSmsTo(PHONE)).toContain('medarbejder');
    expect(t.app.ctx.events.list({ onlyOpen: true }).some((e) => e.type === 'handoff')).toBe(true);
  });

  it('mange samtidige kunder får hver deres ordre uden at blande data', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    const phones = Array.from({ length: 25 }, (_, i) => `+45333300${String(i).padStart(2, '0')}`);
    phones.forEach((p, i) => t.sms.injectInbound(p, `${(i % 3) + 1} red bull til Testvej ${i + 1}, 2300 København S`));
    await t.run();
    phones.forEach((p) => t.sms.injectInbound(p, 'ja'));
    await t.run();
    for (const [i, p] of phones.entries()) {
      const conv = convFor(ctx, p);
      const o = ctx.orders.get(conv.activeOrderId!)!;
      expect(o.lines[0].quantity).toBe((i % 3) + 1);
      expect(['awaiting_driver', 'driver_assigned']).toContain(o.status);
    }
    const reserved = ctx.inventory.levels().reduce((s, l) => s + l.reserved, 0);
    expect(reserved).toBe(phones.reduce((s, _, i) => s + (i % 3) + 1, 0));
  });
});
