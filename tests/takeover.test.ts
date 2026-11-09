import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, fixture, convFor, type TestApp } from './helpers';
import { SimulatedSmsAdapter } from '../src/server/adapters/sms/simulator';
import { createApp } from '../src/server/app';
import { MemorySecretStore } from '../src/server/secrets';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let t: TestApp;
afterEach(async () => t?.app.stop());
const PHONE = '+4544445555';

describe('Human Takeover', () => {
  it('ved manuel overtagelse sender AI ingen beskeder, men indgående registreres', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    const conv = convFor(ctx, PHONE);
    const before = t.sms.sentLog.length;
    ctx.conversations.setMode(conv.id, 'manual', 'test', 'staff');
    t.sms.injectInbound(PHONE, '2 red bull til Fiktivgade 1, 2200 København N');
    await t.run();
    expect(t.sms.sentLog.length).toBe(before);
    const msgs = ctx.conversations.messages(conv.id);
    expect(msgs.filter((m) => m.direction === 'in')).toHaveLength(2);
    expect(convFor(ctx, PHONE).unreadCount).toBeGreaterThan(0);
  });

  it('ventende AI-svar blokeres i samme øjeblik samtalen overtages', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    const conv = convFor(ctx, PHONE);
    const id = ctx.sms.queue(conv.id, 'AI-svar', 'ai', 'pending-ai');
    ctx.conversations.setMode(conv.id, 'manual', 'overtaget', 'staff');
    await t.run();
    expect(ctx.conversations.message(id)!.status).toBe('blocked');
    expect(t.sms.sentLog.some((m) => m.text === 'AI-svar')).toBe(false);
  });

  it('medarbejderbeskeder sendes også under overtagelse', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    const c = ctx.conversations.upsertCustomer(PHONE);
    const conv = ctx.conversations.getOrCreateConversation(c.id);
    ctx.conversations.setMode(conv, 'manual', 'x', 'staff');
    ctx.sms.queue(conv, 'Hej fra Lise', 'staff', 'staff-1');
    await t.run();
    expect(t.lastSmsTo(PHONE)).toBe('Hej fra Lise');
  });

  it('manuel besked fra iPhone registreres og sætter samtalen til manuel', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    t.sms.injectManualOutgoing(PHONE, 'Hej, det er Lise');
    const conv = convFor(ctx, PHONE);
    expect(conv.aiMode).toBe('manual');
    expect(ctx.conversations.messages(conv.id).some((m) => m.author === 'staff' && m.body === 'Hej, det er Lise')).toBe(true);
  });

  it('systemets egne beskeder genkendes og fejltolkes ikke som manuel aktivitet', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    const sent = t.sms.sentLog.find((m) => m.to === PHONE)!;
    ctx.sms.ingestObservedOutgoing({ externalGuid: sent.guid, to: PHONE, text: sent.text, at: sent.at, service: 'SMS' });
    expect(convFor(ctx, PHONE).aiMode).toBe('ai_active');
  });

  it('genaktivering besvarer ikke beskeder modtaget under overtagelsen', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    const conv = convFor(ctx, PHONE);
    ctx.conversations.setMode(conv.id, 'manual', 'x', 'staff');
    t.sms.injectInbound(PHONE, 'gammel besked');
    await t.run();
    const before = t.sms.sentLog.length;
    ctx.conversations.setMode(conv.id, 'ai_active', 'tilbage', 'staff');
    await t.run();
    expect(t.sms.sentLog.length).toBe(before);
  });
});

describe('Sikker SMS-afsendelse', () => {
  it('ukendt udfald (uncertain) gensendes aldrig og pauserer AI', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    t.sms.failNext = { disposition: 'uncertain', count: 1 };
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    await t.run(60000);
    const conv = convFor(ctx, PHONE);
    const out = ctx.conversations.messages(conv.id).filter((m) => m.direction === 'out');
    expect(out[0].status).toBe('uncertain');
    expect(t.sms.sentLog.filter((m) => m.to === PHONE)).toHaveLength(0);
    expect(conv.aiMode).toBe('ai_paused');
  });

  it('bevist ikke-afsendt (not_started) prøves igen og sendes én gang', async () => {
    t = await makeApp({ seed: false });
    const { ctx } = t.app;
    fixture(ctx);
    t.sms.failNext = { disposition: 'not_started', count: 2 };
    t.sms.injectInbound(PHONE, 'hej');
    for (let i = 0; i < 6; i++) await t.run(10000);
    expect(t.sms.sentLog.filter((m) => m.to === PHONE)).toHaveLength(1);
    expect(ctx.conversations.messages(convFor(ctx, PHONE).id).find((m) => m.direction === 'out')!.status).toBe('confirmed');
  });

  it('besked i "sending" ved genstart markeres usikker og sendes ikke igen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-'));
    const dbFile = path.join(dir, 'db.sqlite');
    const opts = (sms: SimulatedSmsAdapter) => ({
      mode: 'production' as const,
      dbFile,
      backupDir: path.join(dir, 'b'),
      secrets: new MemorySecretStore(),
      manualJobs: true,
      overrides: { sms, telegram: null, maps: null, llm: null },
    });
    const sms1 = new SimulatedSmsAdapter();
    const a1 = await createApp(opts(sms1));
    await a1.start();
    const c = a1.ctx.conversations.upsertCustomer(PHONE);
    const conv = a1.ctx.conversations.getOrCreateConversation(c.id);
    const id = a1.ctx.sms.queue(conv, 'Hej', 'staff', 'k');
    // Simulér nedbrud midt i afsendelsen
    a1.ctx.db.prepare(`UPDATE messages SET status = 'sending' WHERE id = ?`).run(id);
    await a1.stop();
    const sms2 = new SimulatedSmsAdapter();
    const a2 = await createApp(opts(sms2));
    await a2.start();
    await a2.ctx.jobs.drain();
    expect(a2.ctx.conversations.message(id)!.status).toBe('uncertain');
    expect(sms2.sentLog).toHaveLength(0);
    expect(a2.ctx.events.list({ onlyOpen: true }).some((e) => e.type === 'send_uncertain')).toBe(true);
    await a2.stop();
  });
});
