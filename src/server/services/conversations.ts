import type { Db } from '../db/database';
import { nowIso } from '../db/database';
import type { AuditLog, Bus, EventLog } from '../infra';
import type { AiMode, Conversation, Customer, Message, MessageAuthor, MessageStatus } from '../../shared/types';
import { AI_MODE_LABELS } from '../../shared/types';
import { DRAFT_STATUSES, ACTIVE_STATUSES } from '../../core/orderStateMachine';

export function mapMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as number,
    conversationId: r.conversation_id as number,
    direction: r.direction as 'in' | 'out',
    author: r.author as MessageAuthor,
    body: r.body as string,
    status: r.status as MessageStatus,
    externalGuid: (r.external_guid as string) ?? null,
    error: (r.error as string) ?? null,
    createdAt: r.created_at as string,
    sentAt: (r.sent_at as string) ?? null,
    orderId: (r.order_id as number) ?? null,
    simulated: !!r.simulated,
  };
}

const ACTIVE_LIST = ACTIVE_STATUSES.map((s) => `'${s}'`).join(',');

export class ConversationService {
  constructor(
    private db: Db,
    private bus: Bus,
    private events: EventLog,
    private audit: AuditLog,
  ) {}

  upsertCustomer(phone: string): Customer {
    this.db
      .prepare(`INSERT INTO customers (phone, last_seen_at) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
      .run(phone, nowIso());
    return this.customerByPhone(phone)!;
  }

  customerByPhone(phone: string): Customer | null {
    const r = this.db.prepare(`SELECT * FROM customers WHERE phone = ?`).get(phone) as Record<string, unknown> | undefined;
    return r ? mapCustomer(r) : null;
  }

  customer(id: number): Customer | null {
    const r = this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapCustomer(r) : null;
  }

  updateCustomer(id: number, patch: { name?: string | null; defaultAddress?: string | null }): void {
    if (patch.name !== undefined) this.db.prepare(`UPDATE customers SET name = ? WHERE id = ?`).run(patch.name, id);
    if (patch.defaultAddress !== undefined)
      this.db.prepare(`UPDATE customers SET default_address = ? WHERE id = ?`).run(patch.defaultAddress, id);
    this.bus.touch('conversations');
  }

  getOrCreateConversation(customerId: number, externalChatId?: string): number {
    this.db
      .prepare(`INSERT INTO conversations (customer_id, channel, external_chat_id) VALUES (?, 'sms', ?) ON CONFLICT(customer_id, channel) DO NOTHING`)
      .run(customerId, externalChatId ?? null);
    const r = this.db.prepare(`SELECT id, external_chat_id FROM conversations WHERE customer_id = ? AND channel = 'sms'`).get(customerId) as {
      id: number;
      external_chat_id: string | null;
    };
    if (externalChatId && !r.external_chat_id) {
      this.db.prepare(`UPDATE conversations SET external_chat_id = ? WHERE id = ?`).run(externalChatId, r.id);
    }
    return r.id;
  }

  get(id: number): Conversation | null {
    const r = this.db.prepare(`${CONV_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapConversation(r) : null;
  }

  list(): Conversation[] {
    return (this.db.prepare(`${CONV_SELECT} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 500`).all() as Record<
      string,
      unknown
    >[]).map(mapConversation);
  }

  messages(conversationId: number, limit = 200): Message[] {
    return (
      this.db
        .prepare(`SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
        .all(conversationId, limit) as Record<string, unknown>[]
    ).map(mapMessage);
  }

  message(id: number): Message | null {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapMessage(r) : null;
  }

  markRead(conversationId: number): void {
    this.db.prepare(`UPDATE conversations SET unread_count = 0 WHERE id = ?`).run(conversationId);
    this.bus.touch('conversations');
  }

  /**
   * Skift AI-tilstand for en samtale. Ved manuel overtagelse eller pause
   * blokeres alle ventende automatiske beskeder i samme transaktion.
   */
  setMode(conversationId: number, mode: AiMode, reason: string, by: string): void {
    this.db.transaction(() => {
      const cur = this.db.prepare(`SELECT ai_mode FROM conversations WHERE id = ?`).get(conversationId) as { ai_mode: AiMode } | undefined;
      if (!cur) throw new Error('Samtale findes ikke');
      this.db
        .prepare(`UPDATE conversations SET ai_mode = ?, mode_reason = ?, mode_changed_at = ?, mode_changed_by = ? WHERE id = ?`)
        .run(mode, reason, nowIso(), by, conversationId);
      if (mode !== 'ai_active') {
        this.db
          .prepare(
            `UPDATE messages SET status = 'blocked', error = ? WHERE conversation_id = ? AND direction = 'out' AND status = 'queued'
             AND (author = 'ai' OR (author = 'system' AND COALESCE(idempotency_key, '') NOT LIKE 'handoff:%'))`,
          )
          .run(`Blokeret: ${AI_MODE_LABELS[mode]}`, conversationId);
      } else {
        // Ved genaktivering: indgående beskeder modtaget under overtagelsen besvares IKKE bagudrettet
        this.db
          .prepare(`UPDATE messages SET processed_at = ? WHERE conversation_id = ? AND direction = 'in' AND processed_at IS NULL`)
          .run(nowIso(), conversationId);
      }
      if (cur.ai_mode !== mode) {
        this.audit.record(by, 'conversation_mode', 'conversation', conversationId, { from: cur.ai_mode, to: mode, reason });
      }
    })();
    this.bus.touch('conversations', 'messages');
  }

  insertInbound(conversationId: number, body: string, externalGuid: string | null, externalRowId: number | null, simulated: boolean): number | null {
    const r = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, direction, author, body, status, external_guid, external_rowid, simulated, created_at)
         VALUES (?, 'in', 'customer', ?, 'received', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(conversationId, body, externalGuid, externalRowId, simulated ? 1 : 0, nowIso());
    if (r.changes === 0) return null; // dublet
    this.db
      .prepare(`UPDATE conversations SET last_message_at = ?, unread_count = unread_count + 1 WHERE id = ?`)
      .run(nowIso(), conversationId);
    this.bus.touch('conversations', 'messages');
    return Number(r.lastInsertRowid);
  }

  /**
   * Læg en udgående besked i outbox. Idempotent via `idempotencyKey`:
   * samme nøgle giver aldrig to beskeder (beskytter mod retries/dubletter).
   */
  queueOutbound(
    conversationId: number,
    body: string,
    author: MessageAuthor,
    idempotencyKey: string,
    opts: { orderId?: number | null; simulated?: boolean } = {},
  ): { id: number; created: boolean } {
    const r = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, direction, author, body, status, idempotency_key, order_id, simulated, created_at)
         VALUES (?, 'out', ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(conversationId, author, body, idempotencyKey, opts.orderId ?? null, opts.simulated ? 1 : 0, nowIso());
    if (r.changes === 0) {
      const existing = this.db.prepare(`SELECT id FROM messages WHERE idempotency_key = ?`).get(idempotencyKey) as { id: number };
      return { id: existing.id, created: false };
    }
    this.db.prepare(`UPDATE conversations SET last_message_at = ? WHERE id = ?`).run(nowIso(), conversationId);
    this.bus.touch('messages', 'conversations');
    return { id: Number(r.lastInsertRowid), created: true };
  }

  setMessageStatus(id: number, status: MessageStatus, patch: { error?: string | null; externalGuid?: string | null; externalRowId?: number | null } = {}): void {
    this.db
      .prepare(
        `UPDATE messages SET status = ?, error = COALESCE(?, error),
           external_guid = COALESCE(?, external_guid), external_rowid = COALESCE(?, external_rowid),
           sent_at = CASE WHEN ? IN ('sent','confirmed') AND sent_at IS NULL THEN ? ELSE sent_at END
         WHERE id = ?`,
      )
      .run(status, patch.error ?? null, patch.externalGuid ?? null, patch.externalRowId ?? null, status, nowIso(), id);
    this.bus.touch('messages');
  }

  /** Uafsluttede indgående beskeder (til samlet behandling som én kundetur). */
  unprocessedInbound(conversationId: number): Message[] {
    return (
      this.db
        .prepare(`SELECT * FROM messages WHERE conversation_id = ? AND direction = 'in' AND processed_at IS NULL ORDER BY id`)
        .all(conversationId) as Record<string, unknown>[]
    ).map(mapMessage);
  }

  markProcessed(ids: number[]): void {
    const stmt = this.db.prepare(`UPDATE messages SET processed_at = ? WHERE id = ?`);
    const now = nowIso();
    for (const id of ids) stmt.run(now, id);
  }

  /** Den aktuelle ordre for samtalen: åben kladde først, ellers seneste aktive ordre. */
  activeOrderId(conversationId: number): number | null {
    const draft = this.db
      .prepare(
        `SELECT id FROM orders WHERE conversation_id = ? AND status IN (${DRAFT_STATUSES.map((s) => `'${s}'`).join(',')}) ORDER BY id DESC LIMIT 1`,
      )
      .get(conversationId) as { id: number } | undefined;
    if (draft) return draft.id;
    const active = this.db
      .prepare(`SELECT id FROM orders WHERE conversation_id = ? AND status IN (${ACTIVE_LIST}) ORDER BY id DESC LIMIT 1`)
      .get(conversationId) as { id: number } | undefined;
    return active?.id ?? null;
  }

  needingAttentionCount(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM conversations WHERE ai_mode IN ('ai_paused','integration_error') OR (ai_mode = 'manual' AND unread_count > 0)`)
        .get() as { c: number }
    ).c;
  }
}

const CONV_SELECT = `
SELECT c.*, cu.phone AS customer_phone, cu.name AS customer_name,
  (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_preview,
  (SELECT o.id FROM orders o WHERE o.conversation_id = c.id AND o.status IN (${ACTIVE_LIST}) ORDER BY o.id DESC LIMIT 1) AS active_order_id,
  (SELECT o.status FROM orders o WHERE o.conversation_id = c.id AND o.status IN (${ACTIVE_LIST}) ORDER BY o.id DESC LIMIT 1) AS active_order_status
FROM conversations c JOIN customers cu ON cu.id = c.customer_id`;

function mapConversation(r: Record<string, unknown>): Conversation {
  return {
    id: r.id as number,
    customerId: r.customer_id as number,
    customerPhone: r.customer_phone as string,
    customerName: (r.customer_name as string) ?? null,
    channel: 'sms',
    externalChatId: (r.external_chat_id as string) ?? null,
    aiMode: r.ai_mode as AiMode,
    modeReason: (r.mode_reason as string) ?? null,
    modeChangedAt: (r.mode_changed_at as string) ?? null,
    modeChangedBy: (r.mode_changed_by as string) ?? null,
    lastMessageAt: (r.last_message_at as string) ?? null,
    lastMessagePreview: (r.last_preview as string) ?? null,
    unreadCount: r.unread_count as number,
    activeOrderId: (r.active_order_id as number) ?? null,
    activeOrderStatus: (r.active_order_status as Conversation['activeOrderStatus']) ?? null,
  };
}

function mapCustomer(r: Record<string, unknown>): Customer {
  return {
    id: r.id as number,
    phone: r.phone as string,
    name: (r.name as string) ?? null,
    defaultAddress: (r.default_address as string) ?? null,
    createdAt: r.created_at as string,
    lastSeenAt: (r.last_seen_at as string) ?? null,
  };
}
