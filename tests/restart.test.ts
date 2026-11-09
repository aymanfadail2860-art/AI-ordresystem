import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from '../src/server/app';
import { MemorySecretStore } from '../src/server/secrets';
import { SimulatedSmsAdapter } from '../src/server/adapters/sms/simulator';
import { SimulatedTelegramAdapter } from '../src/server/adapters/telegram/simulator';
import { SimulatedMapsAdapter } from '../src/server/adapters/maps/simulator';
import { openDatabase, schemaVersion } from '../src/server/db/database';
import { MIGRATIONS } from '../src/server/db/migrations';
import { JobQueue, PermanentJobError } from '../src/server/jobs/jobQueue';
import { Bus, EventLog } from '../src/server/infra';
import { fixture, makeApp } from './helpers';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-r-'));
  const opts = (): AppOptions => ({
    mode: 'production',
    dbFile: path.join(dir, 'db.sqlite'),
    backupDir: path.join(dir, 'backups'),
    secrets: new MemorySecretStore(),
    manualJobs: true,
    overrides: { sms: new SimulatedSmsAdapter(), telegram: new SimulatedTelegramAdapter(), maps: new SimulatedMapsAdapter(), llm: null },
  });
  return { dir, opts };
}

describe('Genstart og gendannelse', () => {
  it('data, SMS-cursor og ventende jobs overlever genstart', async () => {
    const { opts } = tmp();
    const a1 = await createApp(opts());
    await a1.start();
    const f = fixture(a1.ctx);
    a1.ctx.kv.set('sms_cursor:simulator', 1234);
    a1.ctx.jobs.enqueue('dispatch_order', { orderId: 999 }, { delayMs: 60_000, dedupeKey: 'dispatch:999' });
    a1.ctx.db.prepare(`UPDATE jobs SET status = 'running' WHERE dedupe_key = 'dispatch:999'`).run();
    await a1.stop();

    const a2 = await createApp(opts());
    await a2.start();
    expect(a2.ctx.catalog.get(f.rb.id)?.name).toBe('Red Bull');
    expect(a2.ctx.kv.get('sms_cursor:simulator', 0)).toBe(1234);
    const job = a2.ctx.db.prepare(`SELECT status FROM jobs WHERE dedupe_key = 'dispatch:999'`).get() as { status: string };
    expect(job.status).toBe('pending');
    await a2.stop();
  });

  it('backup kan tages og gendannelse anvendes ved næste opstart', async () => {
    const { opts } = tmp();
    const a1 = await createApp(opts());
    await a1.start();
    a1.ctx.catalog.create({ sku: 'A', name: 'Før backup', category: 'x', priceOre: 100 });
    const b = await a1.backup.create('manual');
    a1.ctx.catalog.create({ sku: 'B', name: 'Efter backup', category: 'x', priceOre: 100 });
    await a1.backup.scheduleRestore(b.file);
    await a1.stop();
    const a2 = await createApp(opts());
    await a2.start();
    const names = a2.ctx.catalog.list().map((p) => p.name);
    expect(names).toContain('Før backup');
    expect(names).not.toContain('Efter backup');
    await a2.stop();
  });

  it('migrationer er idempotente og registreres', () => {
    const db = openDatabase({ file: ':memory:' });
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    db.close();
  });

  it('databasen afviser negativt lager og reserveret > beholdning', async () => {
    const t = await makeApp({ seed: false });
    const f = fixture(t.app.ctx);
    expect(() => t.app.ctx.db.prepare(`UPDATE stock_levels SET quantity = -1 WHERE location_id = ?`).run(f.central)).toThrow(/CHECK/);
    expect(() => t.app.ctx.db.prepare(`UPDATE stock_levels SET reserved = quantity + 1 WHERE location_id = ?`).run(f.central)).toThrow(/CHECK/);
    await t.app.stop();
  });

  it('produktion starter med automatik slået fra – intet sendes automatisk før aktivering', async () => {
    const { opts } = tmp();
    const o = opts();
    const sms = o.overrides!.sms as SimulatedSmsAdapter;
    const a = await createApp(o);
    await a.start();
    expect(a.ctx.settings.get().installation.automationEnabled).toBe(false);
    sms.injectInbound('+4512121212', 'hej');
    await a.ctx.jobs.drain();
    await new Promise((r) => setTimeout(r, 1700));
    await a.ctx.jobs.drain();
    expect(sms.sentLog).toHaveLength(0);
    await a.stop();
  });
});

describe('Jobkø', () => {
  it('dedupe, retry med backoff og permanent fejl', async () => {
    const db = openDatabase({ file: ':memory:' });
    const bus = new Bus();
    let clock = Date.now();
    const q = new JobQueue(db, new EventLog(db, bus), { now: () => clock });
    let runs = 0;
    q.register('flaky', async () => {
      runs++;
      if (runs < 3) throw new Error('midlertidig');
    });
    q.register('broken', async () => {
      throw new PermanentJobError('kaput');
    });
    expect(q.enqueue('flaky', {}, { dedupeKey: 'x' })).not.toBeNull();
    expect(q.enqueue('flaky', {}, { dedupeKey: 'x' })).toBeNull();
    q.enqueue('broken', {});
    for (let i = 0; i < 5; i++) {
      await q.drain();
      clock += 10 * 60_000;
    }
    expect(runs).toBe(3);
    const statuses = db.prepare(`SELECT type, status FROM jobs ORDER BY id`).all();
    expect(statuses).toEqual([{ type: 'flaky', status: 'done' }, { type: 'broken', status: 'dead' }]);
    bus.dispose();
    db.close();
  });
});
