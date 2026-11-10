import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clock } from '../src/server/clock';
import { DEFAULT_TZ, formatClock, localToUtc, startOfLocalDay, tzOffsetMs, zonedParts } from '../src/core/time';
import { isOpen } from '../src/core/openingHours';
import { opsApp, opsData, phone, GROUP, say, groupOut } from './ops-fixture';
import { km, makeApp, placeOrder, TestMaps } from './helpers';
import { createApp } from '../src/server/app';
import { MemorySecretStore } from '../src/server/secrets';
import { SimulatedSmsAdapter } from '../src/server/adapters/sms/simulator';
import { SimulatedTelegramAdapter } from '../src/server/adapters/telegram/simulator';
import type { Ctx } from '../src/server/context';

const H = 3_600_000;
afterEach(() => clock.reset());

/** Lever en ordre på et bestemt tidspunkt (direkte i databasen – kun til rapporttal). */
function deliveredAt(ctx: Ctx, id: number, confirmedIso: string, deliveredIso: string, promisedIso?: string) {
  ctx.db
    .prepare(`UPDATE orders SET status = 'delivered', confirmed_at = ?, delivered_at = ?, eta_communicated = ? WHERE id = ?`)
    .run(confirmedIso, deliveredIso, promisedIso ?? deliveredIso, id);
}

function reportMessages(ctx: Ctx): string[] {
  return groupOut(ctx).filter((m) => m.startsWith('📊'));
}

describe('tidszone og åbningstider (Europe/Copenhagen)', () => {
  it('sommer- og vintertid håndteres korrekt', () => {
    // Sommertid: UTC+2, vintertid: UTC+1
    expect(tzOffsetMs(Date.parse('2026-07-01T12:00:00Z'))).toBe(2 * H);
    expect(tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'))).toBe(1 * H);
    // Skift til sommertid 29. marts 2026 kl. 02:00 → 03:00
    expect(formatClock(Date.parse('2026-03-29T00:59:00Z'))).toBe('01.59');
    expect(formatClock(Date.parse('2026-03-29T01:00:00Z'))).toBe('03.00');
    // Skift til vintertid 25. oktober 2026 kl. 03:00 → 02:00 (timen 02–03 forekommer to gange)
    expect(formatClock(Date.parse('2026-10-25T00:30:00Z'))).toBe('02.30');
    expect(formatClock(Date.parse('2026-10-25T01:30:00Z'))).toBe('02.30');
    // Lokal midnat og døgnlængder (23 og 25 timer)
    expect(new Date(startOfLocalDay(Date.parse('2026-07-01T10:00:00Z'))).toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(new Date(startOfLocalDay(Date.parse('2026-01-15T10:00:00Z'))).toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(localToUtc(2026, 3, 30, 0, 0) - localToUtc(2026, 3, 29, 0, 0)).toBe(23 * H);
    expect(localToUtc(2026, 10, 26, 0, 0) - localToUtc(2026, 10, 25, 0, 0)).toBe(25 * H);
    expect(zonedParts(Date.parse('2026-11-10T23:30:00Z')).weekday).toBe(3); // onsdag lokalt
  });

  it('åbningstider vurderes i virksomhedens tidszone uanset maskinens', () => {
    const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '10:00', close: '22:00', closed: false }])) as never;
    expect(isOpen(hours, new Date('2026-06-15T08:30:00Z'), DEFAULT_TZ)).toBe(true); // 10:30 CEST
    expect(isOpen(hours, new Date('2026-12-15T08:30:00Z'), DEFAULT_TZ)).toBe(false); // 09:30 CET
    expect(isOpen(hours, new Date('2026-12-15T09:30:00Z'), DEFAULT_TZ)).toBe(true); // 10:30 CET
    expect(isOpen(hours, new Date('2026-06-15T20:00:00Z'), DEFAULT_TZ)).toBe(false); // 22:00 CEST
  });
});

describe('automatiske timerapporter', () => {
  async function setup(at = '2026-06-15T12:00:30Z') {
    const o = await opsApp();
    o.t.clock.t = Date.parse(at);
    clock.set(() => o.t.clock.t);
    return o;
  }

  it('sender én rapport ved hver hele time med tal beregnet fra databasen', async () => {
    const { t, cola, anna } = await setup();
    const ctx = t.app.ctx;
    // To leverede ordrer i timen 11–12 UTC (13–14 lokal), én tidligere på dagen
    const ids = [1, 2, 3].map(() => placeOrder(ctx, { phone: phone(), at: km(1, 0), lines: [{ productId: cola.id, quantity: 2 }], locationId: anna.vehicleLocationId! }));
    deliveredAt(ctx, ids[0], '2026-06-15T10:50:00Z', '2026-06-15T11:20:00Z');
    deliveredAt(ctx, ids[1], '2026-06-15T11:05:00Z', '2026-06-15T11:45:00Z', '2026-06-15T11:30:00Z'); // 15 min for sent
    deliveredAt(ctx, ids[2], '2026-06-15T06:00:00Z', '2026-06-15T06:30:00Z');
    const id = t.app.agents.reports.runDue();
    expect(id).not.toBeNull();
    await t.run();
    const r = t.app.agents.reports.list()[0];
    expect(r.status).toBe('sent');
    expect(r.periodStart).toBe('2026-06-15T11:00:00.000Z');
    const m = r.metrics!;
    // Ordre: 2 × 25 kr. + 39 kr. levering = 89 kr.; DB = 39 + 2 × (25 − 12) = 65 kr.
    expect(m.hour.revenueOre).toBe(2 * 8900);
    expect(m.hour.contributionOre).toBe(2 * 6500);
    expect(m.hour.delivered).toBe(2);
    expect(m.day.revenueOre).toBe(3 * 8900);
    expect(m.day.avgOrderValueOre).toBe(8900);
    expect(m.day.avgDeliveryMinutes).toBe(Math.round((30 + 40 + 30) / 3));
    expect(m.day.onTimePct).toBe(67); // 2 af 3 inden for tolerancen
    const msg = reportMessages(ctx);
    expect(msg).toHaveLength(1);
    expect(msg[0]).toMatch(/Timerapport 13\.00–14\.00/); // lokal tid (CEST)
    expect(msg[0]).toMatch(/178 kr\. omsætning/);
    expect(msg[0]).toMatch(/Vurdering:/);
    expect(msg[0]).toMatch(/DEMO: simulerede data/);
    // Gentagne kørsler i samme time giver ingen ekstra rapport
    t.app.agents.reports.runDue();
    t.app.agents.reports.runDue();
    await t.run();
    expect(reportMessages(ctx)).toHaveLength(1);
  });

  it('sender ikke uden for åbningstiden, men gør det i åbningstiden (lokal tid)', async () => {
    const { t } = await setup('2026-12-15T08:00:30Z'); // 09:00 CET → timen 08–09 lokal
    const ctx = t.app.ctx;
    ctx.settings.update({ openingHours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '10:00', close: '22:00', closed: false }])) as never });
    expect(t.app.agents.reports.runDue()).toBeNull();
    t.clock.t = Date.parse('2026-12-15T10:00:30Z'); // 11:00 CET → timen 10–11 er åben
    expect(t.app.agents.reports.runDue()).not.toBeNull();
    t.clock.t = Date.parse('2026-12-15T21:00:30Z'); // 22:00 CET → sidste åbne time 21–22
    expect(t.app.agents.reports.runDue()).not.toBeNull();
    t.clock.t = Date.parse('2026-12-15T22:00:30Z'); // 23:00 – lukket
    expect(t.app.agents.reports.runDue()).toBeNull();
  });

  it('to perioder med samme lokale klokkeslæt ved skift til vintertid giver to rapporter', async () => {
    const { t } = await setup('2026-10-25T01:00:30Z');
    expect(t.app.agents.reports.runDue()).not.toBeNull(); // 00–01 UTC = 02:00 CEST – 02:00 CET
    t.clock.t = Date.parse('2026-10-25T02:00:30Z');
    expect(t.app.agents.reports.runDue()).not.toBeNull(); // 01–02 UTC = 02:00–03:00 CET
    await t.run();
    const msgs = reportMessages(t.app.ctx);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatch(/02\.00–02\.00/);
    expect(msgs[1]).toMatch(/02\.00–03\.00/);
  });

  it('kan sendes uden Claude API (produktion uden nøgle)', async () => {
    const t = await makeApp({ mode: 'production', seed: false, overrides: { maps: new TestMaps() } });
    const d = opsData(t.app);
    void d;
    t.clock.t = Date.parse('2026-06-15T12:00:30Z');
    clock.set(() => t.clock.t);
    expect(t.app.ctx.ai.configured).toBe(false);
    expect(t.app.agents.reports.runDue()).not.toBeNull();
    await t.run();
    const msg = reportMessages(t.app.ctx)[0];
    expect(msg).toMatch(/ingen Claude API-kald/);
    expect(msg).not.toMatch(/DEMO/);
    expect(t.app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM ai_calls`).get()).toEqual({ c: 0 });
  });

  it('ledelsen kan anmode om en rapport når som helst', async () => {
    const { t } = await setup('2026-06-15T12:34:00Z');
    say(t, 'observer', 'Rapport');
    await t.run();
    const msg = reportMessages(t.app.ctx);
    expect(msg).toHaveLength(1);
    expect(msg[0]).toMatch(/Rapport kl\. 14\.34/);
    const reps = t.app.agents.reports.list();
    expect(reps[0]).toMatchObject({ kind: 'on_demand', status: 'sent', requestedBy: 'Jonas Observatør' });
    const cmd = t.app.management.commands()[0];
    expect(cmd).toMatchObject({ intent: 'report', decision: 'answered' });
  });

  it('nedbrud under timerapport: oprettet rapport genoptages én gang; afbrudt afsendelse gensendes aldrig', async () => {
    const { t } = await setup();
    const ctx = t.app.ctx;
    // Nedbrud lige efter rapporten blev oprettet (før udbakken)
    ctx.db
      .prepare(`INSERT INTO management_reports (kind, period_start, period_end, status, created_at, updated_at) VALUES ('hourly', '2026-06-15T11:00:00.000Z', '2026-06-15T12:00:00.000Z', 'pending', ?, ?)`)
      .run(clock.iso(), clock.iso());
    expect(t.app.agents.reports.runDue()).toBeNull(); // perioden findes – ingen ny række
    await t.run();
    expect(reportMessages(ctx)).toHaveLength(1);
    expect(t.app.agents.reports.list()[0].status).toBe('sent');

    // Næste time: nedbrud midt i Telegram-afsendelsen
    t.clock.t += H;
    t.app.agents.reports.runDue();
    ctx.db.prepare(`UPDATE management_messages SET status = 'sending' WHERE idempotency_key LIKE 'report:hourly:2026-06-15T12%'`).run();
    ctx.db.prepare(`UPDATE jobs SET status = 'done' WHERE type = 'send_telegram_chat'`).run();
    await ctx.telegram.stop();
    await ctx.telegram.start(t.tg); // "genstart"
    t.app.agents.reports.runDue();
    await t.run();
    const r = t.app.agents.reports.list()[0];
    expect(r.status).toBe('uncertain');
    // Kun den første rapport er faktisk afsendt – den afbrudte gensendes ikke
    expect(ctx.db.prepare(`SELECT status FROM management_messages WHERE body LIKE '📊%' ORDER BY id`).all()).toEqual([{ status: 'sent' }, { status: 'uncertain' }]);
    expect(ctx.db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE type = 'send_telegram_chat' AND status = 'pending'`).get()).toEqual({ c: 0 });
  });

  it('ingen dobbeltrapporter efter genstart; efter længere nedetid sendes kun den seneste periode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dispatch-report-'));
    const file = path.join(dir, 'db.sqlite');
    const mk = async (tg: SimulatedTelegramAdapter) => {
      const app = await createApp({
        mode: 'demo',
        dbFile: file,
        backupDir: dir,
        secrets: new MemorySecretStore(),
        manualJobs: true,
        skipSeed: true,
        now: () => clock.now(),
        overrides: { sms: new SimulatedSmsAdapter(), telegram: tg, maps: new TestMaps(), llm: null },
      });
      await app.start();
      app.demo?.stop();
      return app;
    };
    let now = Date.parse('2026-06-15T09:00:20Z');
    clock.set(() => now);
    const tg1 = new SimulatedTelegramAdapter();
    let app = await mk(tg1);
    opsData(app);
    const drain = async () => {
      for (let i = 0; i < 5; i++) {
        await app.ctx.jobs.drain();
        if (app.ctx.jobs.tick() === 0) break;
      }
      await app.ctx.jobs.drain();
    };
    app.agents.reports.runDue();
    await drain();
    await app.stop();
    // Genstart i samme time → ingen ny rapport
    app = await mk(new SimulatedTelegramAdapter());
    app.agents.reports.runDue();
    await drain();
    expect(app.agents.reports.list().filter((r) => r.status === 'sent')).toHaveLength(1);
    await app.stop();
    // Nede i 5 timer
    now += 5 * H;
    app = await mk(new SimulatedTelegramAdapter());
    app.agents.reports.runDue();
    await drain();
    const list = app.agents.reports.list();
    expect(list.filter((r) => r.status === 'sent').map((r) => r.periodStart)).toEqual(['2026-06-15T13:00:00.000Z', '2026-06-15T08:00:00.000Z']);
    expect(list.filter((r) => r.status === 'skipped')).toHaveLength(4);
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS c FROM management_messages WHERE body LIKE '📊%'`).get()).toEqual({ c: 2 });
    await app.stop();
  });

  it('manglende Telegram-forbindelse: rapporten markeres som fejlet uden at stoppe systemet', async () => {
    const { t } = await setup();
    await t.app.ctx.telegram.stop();
    await t.app.ctx.telegram.start(null);
    t.app.agents.reports.runDue();
    await t.run();
    expect(t.app.agents.reports.list()[0].status).toBe('failed');
    expect(GROUP).toBe('mgmt-group');
  });
});
