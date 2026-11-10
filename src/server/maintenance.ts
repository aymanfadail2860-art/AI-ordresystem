import fs from 'node:fs';
import path from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './context';
import type { BackupInfo } from '../shared/types';
import { clock } from './clock';

/**
 * Backup og gendannelse. Bruger SQLites online backup-API, så der kan tages
 * backup mens programmet kører. Gendannelse sker ved næste opstart (sikkert).
 */
export class BackupService {
  constructor(
    private ctx: Ctx,
    private dbFile: string,
    private backupDir: string,
  ) {
    ctx.jobs.register('backup_tick', async () => {
      try {
        const s = ctx.settings.get();
        if (s.backup.enabled && this.dbFile !== ':memory:') {
          const last = this.list()[0];
          if (!last || clock.now() - new Date(last.createdAt).getTime() > s.backup.intervalHours * 3600000) await this.create('auto');
        }
      } finally {
        ctx.jobs.enqueue('backup_tick', {}, { delayMs: 30 * 60000, dedupeKey: 'backup_tick' });
      }
    });
  }

  start(): void {
    this.ctx.jobs.enqueue('backup_tick', {}, { delayMs: 60_000, dedupeKey: 'backup_tick' });
  }

  async create(reason: 'auto' | 'manual' | 'pre_restore'): Promise<BackupInfo> {
    if (this.dbFile === ':memory:') throw new Error('Backup kræver en fil-database');
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = clock.date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.backupDir, `ai-dispatch-${stamp}-${reason}.sqlite`);
    await this.ctx.db.backup(file);
    this.ctx.events.log('info', 'backup', 'backup_created', `Backup oprettet (${reason})`);
    this.prune();
    return this.info(file);
  }

  private info(file: string): BackupInfo {
    const st = fs.statSync(file);
    return { file: path.basename(file), sizeBytes: st.size, createdAt: st.mtime.toISOString() };
  }

  list(): BackupInfo[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.sqlite'))
      .map((f) => this.info(path.join(this.backupDir, f)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private prune(): void {
    const keep = this.ctx.settings.get().backup.keep;
    for (const b of this.list().slice(keep)) fs.rmSync(path.join(this.backupDir, b.file), { force: true });
  }

  /** Planlæg gendannelse: filen kopieres på plads ved næste opstart. */
  async scheduleRestore(fileName: string): Promise<void> {
    const safe = path.basename(fileName);
    const src = path.join(this.backupDir, safe);
    if (!fs.existsSync(src)) throw new Error('Backup findes ikke');
    await this.create('pre_restore');
    fs.copyFileSync(src, `${this.dbFile}.restore-pending`);
    this.ctx.audit.record('staff', 'restore_scheduled', 'backup', safe);
  }

  /** Kaldes før databasen åbnes ved opstart. */
  static applyPendingRestore(dbFile: string): boolean {
    const pending = `${dbFile}.restore-pending`;
    if (!fs.existsSync(pending)) return false;
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
    fs.renameSync(pending, dbFile);
    return true;
  }
}

/** GDPR: konfigurerbar dataopbevaring, eksport og sletning af kundedata. */
export class RetentionService {
  constructor(private ctx: Ctx) {
    ctx.jobs.register('retention_tick', async () => {
      try {
        this.run();
      } finally {
        ctx.jobs.enqueue('retention_tick', {}, { delayMs: 6 * 3600000, dedupeKey: 'retention_tick' });
      }
    });
  }

  start(): void {
    this.ctx.jobs.enqueue('retention_tick', {}, { delayMs: 120_000, dedupeKey: 'retention_tick' });
  }

  run(): { messages: number; customers: number; events: number } {
    const { db } = this.ctx;
    const r = this.ctx.settings.get().retention;
    const cut = (days: number) => new Date(clock.now() - days * 86400000).toISOString();
    const messages = db
      .prepare(`UPDATE messages SET body = '[slettet efter opbevaringsperiode]' WHERE created_at < ? AND body <> '[slettet efter opbevaringsperiode]'`)
      .run(cut(r.messageBodyDays)).changes;
    db.prepare(`UPDATE driver_messages SET body = '[slettet]' WHERE created_at < ? AND body <> '[slettet]'`).run(cut(r.messageBodyDays));
    const inactive = db
      .prepare(`SELECT id FROM customers WHERE anonymized_at IS NULL AND COALESCE(last_seen_at, created_at) < ?`)
      .all(cut(r.inactiveCustomerDays)) as { id: number }[];
    for (const c of inactive) this.anonymizeCustomer(c.id, 'system');
    const events = db.prepare(`DELETE FROM events WHERE created_at < ? AND (acknowledged_at IS NOT NULL OR requires_action = 0)`).run(cut(r.eventLogDays)).changes;
    db.prepare(`DELETE FROM ai_calls WHERE created_at < ?`).run(cut(400));
    this.ctx.jobs.purge(7);
    return { messages, customers: inactive.length, events };
  }

  exportCustomer(customerId: number): Record<string, unknown> {
    const { db } = this.ctx;
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
    if (!customer) throw new Error('Kunde findes ikke');
    const orders = db.prepare(`SELECT * FROM orders WHERE customer_id = ?`).all(customerId);
    const messages = db
      .prepare(`SELECT m.direction, m.author, m.body, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.customer_id = ? ORDER BY m.id`)
      .all(customerId);
    this.ctx.audit.record('staff', 'gdpr_export', 'customer', customerId);
    return { exportedAt: clock.date().toISOString(), customer, orders, messages };
  }

  /** Anonymisér kunden (ordrer bevares til regnskab, persondata fjernes). */
  anonymizeCustomer(customerId: number, actor: string): void {
    const { db } = this.ctx;
    db.transaction(() => {
      db.prepare(`UPDATE customers SET phone = ?, name = NULL, default_address = NULL, notes = NULL, anonymized_at = ? WHERE id = ?`).run(
        `anonym-${customerId}`,
        clock.date().toISOString(),
        customerId,
      );
      db.prepare(
        `UPDATE orders SET address_text = '[anonymiseret]', address_lat = NULL, address_lng = NULL, delivery_instructions = NULL WHERE customer_id = ? AND status IN ('delivered','cancelled')`,
      ).run(customerId);
      db.prepare(`UPDATE messages SET body = '[anonymiseret]' WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = ?)`).run(customerId);
    })();
    this.ctx.audit.record(actor, 'gdpr_anonymize', 'customer', customerId);
    this.ctx.bus.touch('conversations', 'orders');
  }
}

/**
 * Adgangskontrol til følsomme handlinger: en administrator-PIN (scrypt-hash).
 * Efter oplåsning er følsomme handlinger tilladt i 10 minutter.
 */
export class AuthService {
  private unlockedUntil = 0;
  constructor(private ctx: Ctx) {}

  hasPin(): boolean {
    return !!this.ctx.kv.get<string | null>('admin_pin_hash', null);
  }

  setPin(pin: string, currentPin?: string): void {
    if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN skal være 4–8 cifre');
    if (this.hasPin() && !this.verify(currentPin ?? '')) throw new Error('Nuværende PIN er forkert');
    const salt = randomBytes(16);
    const hash = scryptSync(pin, salt, 32);
    this.ctx.kv.set('admin_pin_hash', `${salt.toString('hex')}:${hash.toString('hex')}`);
    this.ctx.audit.record('staff', 'pin_set');
  }

  verify(pin: string): boolean {
    const stored = this.ctx.kv.get<string | null>('admin_pin_hash', null);
    if (!stored) return true; // ingen PIN konfigureret endnu (kun under opsætning)
    const [saltHex, hashHex] = stored.split(':');
    const test = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
    return timingSafeEqual(test, Buffer.from(hashHex, 'hex'));
  }

  unlock(pin: string): boolean {
    const ok = this.verify(pin);
    this.ctx.audit.record('staff', ok ? 'unlock_ok' : 'unlock_failed');
    if (ok) this.unlockedUntil = clock.now() + 10 * 60000;
    return ok;
  }

  lock(): void {
    this.unlockedUntil = 0;
  }

  isUnlocked(): boolean {
    return !this.hasPin() || clock.now() < this.unlockedUntil;
  }

  require(): void {
    if (!this.isUnlocked()) throw new Error('LOCKED: Denne handling kræver administrator-PIN');
  }
}
