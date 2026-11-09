import { randomBytes } from 'node:crypto';
import type { Db } from '../db/database';
import { nowIso, parseJson } from '../db/database';
import type { AuditLog, Bus } from '../infra';
import type { ManagementCommand, ManagementRole, ManagementUser } from '../../shared/types';

export const ROLE_RANK: Record<ManagementRole, number> = { observer: 1, manager: 2, admin: 3 };

function code(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('');
}

function mapUser(r: Record<string, unknown>): ManagementUser {
  return {
    id: r.id as number,
    name: r.name as string,
    role: r.role as ManagementRole,
    telegramUserId: (r.telegram_user_id as string) ?? null,
    linkCode: (r.link_code as string) ?? null,
    active: !!r.active,
    createdAt: r.created_at as string,
  };
}

/** Ledelsesbrugere, roller og revisionsspor for instruktioner. */
export class ManagementService {
  constructor(
    private db: Db,
    private bus: Bus,
    private audit: AuditLog,
  ) {}

  users(): ManagementUser[] {
    return (this.db.prepare(`SELECT * FROM management_users ORDER BY active DESC, name`).all() as Record<string, unknown>[]).map(mapUser);
  }

  user(id: number): ManagementUser | null {
    const r = this.db.prepare(`SELECT * FROM management_users WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapUser(r) : null;
  }

  byTelegram(userId: string): ManagementUser | null {
    const r = this.db.prepare(`SELECT * FROM management_users WHERE telegram_user_id = ? AND active = 1`).get(userId) as Record<string, unknown> | undefined;
    return r ? mapUser(r) : null;
  }

  createUser(name: string, role: ManagementRole, actor: string): ManagementUser {
    if (!name.trim()) throw new Error('Navn mangler');
    if (!ROLE_RANK[role]) throw new Error('Ukendt rolle');
    const r = this.db.prepare(`INSERT INTO management_users (name, role, link_code) VALUES (?, ?, ?)`).run(name.trim(), role, code());
    this.audit.record(actor, 'management_user_create', 'management_user', Number(r.lastInsertRowid), { role });
    this.bus.touch('management');
    return this.user(Number(r.lastInsertRowid))!;
  }

  updateUser(id: number, patch: { role?: ManagementRole; active?: boolean; name?: string }, actor: string): ManagementUser {
    const u = this.user(id);
    if (!u) throw new Error('Bruger findes ikke');
    if (patch.role && !ROLE_RANK[patch.role]) throw new Error('Ukendt rolle');
    this.db
      .prepare(`UPDATE management_users SET name = ?, role = ?, active = ? WHERE id = ?`)
      .run(patch.name?.trim() || u.name, patch.role ?? u.role, patch.active === undefined ? (u.active ? 1 : 0) : patch.active ? 1 : 0, id);
    this.audit.record(actor, 'management_user_update', 'management_user', id, patch);
    this.bus.touch('management');
    return this.user(id)!;
  }

  regenerateCode(id: number, actor: string): string {
    const c = code();
    this.db.prepare(`UPDATE management_users SET link_code = ?, telegram_user_id = NULL WHERE id = ?`).run(c, id);
    this.audit.record(actor, 'management_user_code', 'management_user', id);
    this.bus.touch('management');
    return c;
  }

  link(linkCode: string, telegramUserId: string): ManagementUser | null {
    const r = this.db.prepare(`SELECT id FROM management_users WHERE link_code = ? AND active = 1`).get(linkCode.trim().toUpperCase()) as { id: number } | undefined;
    if (!r) return null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE management_users SET telegram_user_id = NULL WHERE telegram_user_id = ?`).run(telegramUserId);
      this.db.prepare(`UPDATE management_users SET telegram_user_id = ?, link_code = NULL WHERE id = ?`).run(telegramUserId, r.id);
    })();
    this.audit.record('telegram', 'management_user_linked', 'management_user', r.id, { telegramUserId });
    this.bus.touch('management');
    return this.user(r.id);
  }

  // ---------------- Kommandolog ----------------

  logCommand(c: {
    user: ManagementUser | null;
    telegramUserId: string | null;
    chatId: string | null;
    instruction: string;
    intent: string | null;
    params?: Record<string, unknown>;
    affectedOrders?: number[];
    decision: string;
    result: string;
    confirmToken?: string | null;
    confirmExpiresAt?: string | null;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO management_commands (user_id, user_name, telegram_user_id, chat_id, instruction, intent, params, affected_orders, decision, result, confirm_token, confirm_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.user?.id ?? null,
        c.user?.name ?? null,
        c.telegramUserId,
        c.chatId,
        c.instruction.slice(0, 1000),
        c.intent,
        c.params ? JSON.stringify(c.params) : null,
        JSON.stringify(c.affectedOrders ?? []),
        c.decision,
        c.result.slice(0, 2000),
        c.confirmToken ?? null,
        c.confirmExpiresAt ?? null,
        nowIso(),
        nowIso(),
      );
    this.bus.touch('management');
    return Number(r.lastInsertRowid);
  }

  updateCommand(id: number, patch: { decision: string; result: string; confirmedBy?: string }): void {
    this.db
      .prepare(`UPDATE management_commands SET decision = ?, result = ?, confirmed_by = COALESCE(?, confirmed_by), updated_at = ? WHERE id = ?`)
      .run(patch.decision, patch.result.slice(0, 2000), patch.confirmedBy ?? null, nowIso(), id);
    this.bus.touch('management');
  }

  commandRow(id: number): Record<string, unknown> | null {
    return (this.db.prepare(`SELECT * FROM management_commands WHERE id = ?`).get(id) as Record<string, unknown> | undefined) ?? null;
  }

  commands(limit = 200): ManagementCommand[] {
    return (this.db.prepare(`SELECT * FROM management_commands ORDER BY id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      userName: (r.user_name as string) ?? null,
      instruction: r.instruction as string,
      intent: (r.intent as string) ?? null,
      params: parseJson(r.params as string | null, null),
      affectedOrders: parseJson<number[]>(r.affected_orders as string | null, []),
      decision: r.decision as string,
      result: (r.result as string) ?? null,
      confirmedBy: (r.confirmed_by as string) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  messages(limit = 100) {
    return (
      this.db.prepare(`SELECT * FROM (SELECT * FROM management_messages ORDER BY id DESC LIMIT ?) ORDER BY id`).all(limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      chatId: r.chat_id as string,
      direction: r.direction as 'in' | 'out',
      userName: (r.user_name as string) ?? null,
      body: r.body as string,
      status: r.status as string,
      simulated: !!r.simulated,
      createdAt: r.created_at as string,
    }));
  }
}
