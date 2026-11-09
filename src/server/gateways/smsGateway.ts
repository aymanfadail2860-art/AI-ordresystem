import type { Db } from '../db/database';
import { nowIso } from '../db/database';
import type { Bus, EventLog, IntegrationRegistry, KvState, SettingsService } from '../infra';
import type { ConversationService } from '../services/conversations';
import type { JobQueue, JobRow } from '../jobs/jobQueue';
import { PermanentJobError, RetryLaterError } from '../jobs/jobQueue';
import type { InboundSms, OutgoingObserved, SmsAdapter } from '../adapters/sms/types';
import { normalizePhone, maskPhone } from '../../core/phone';

/**
 * SMS-gateway: forbinder den udskiftelige SMS-adapter med resten af systemet.
 *
 * Garantier:
 * - Indgående beskeder registreres præcis én gang (unik external_guid).
 * - Udgående beskeder går gennem en vedvarende outbox. En besked sættes i
 *   status 'sending' FØR adapteren kaldes. Findes en besked i 'sending' efter
 *   genstart, er udfaldet ukendt → 'uncertain', og den gensendes ALDRIG automatisk.
 * - AI-beskeder kontrolleres mod samtalens AI-tilstand umiddelbart før afsendelse.
 */
export class SmsGateway {
  private adapter: SmsAdapter | null = null;

  constructor(
    private db: Db,
    private bus: Bus,
    private settings: SettingsService,
    private conversations: ConversationService,
    private jobs: JobQueue,
    private events: EventLog,
    private integrations: IntegrationRegistry,
    private kv: KvState,
  ) {
    jobs.register('send_sms', (job) => this.handleSendJob(job));
  }

  get current(): SmsAdapter | null {
    return this.adapter;
  }

  async start(adapter: SmsAdapter | null): Promise<void> {
    this.recoverAfterRestart();
    this.adapter = adapter;
    if (!adapter) {
      this.integrations.set('sms', 'not_configured', 'SMS-integration er ikke konfigureret');
      return;
    }
    await adapter.start({
      onInbound: (m) => this.ingestInbound(m),
      onOutgoingObserved: (m) => this.ingestObservedOutgoing(m),
      onHealth: (state, message) =>
        this.integrations.set('sms', adapter.simulated && state === 'ok' ? 'simulated' : state, message, {
          simulated: adapter.simulated,
        }),
      loadCursor: () => this.kv.get<number | null>(`sms_cursor:${adapter.kind}`, null),
      saveCursor: (c) => this.kv.set(`sms_cursor:${adapter.kind}`, c),
    });
  }

  async stop(): Promise<void> {
    await this.adapter?.stop();
  }

  /** Beskeder, der var under afsendelse ved nedlukning/nedbrud, har ukendt udfald. */
  recoverAfterRestart(): void {
    const rows = this.db
      .prepare(`SELECT id, conversation_id FROM messages WHERE direction = 'out' AND status = 'sending'`)
      .all() as { id: number; conversation_id: number }[];
    for (const r of rows) {
      this.conversations.setMessageStatus(r.id, 'uncertain', { error: 'Programmet stoppede under afsendelse – udfald ukendt' });
      this.flagUncertain(r.conversation_id, r.id);
    }
  }

  private flagUncertain(conversationId: number, messageId: number): void {
    this.conversations.setMode(conversationId, 'ai_paused', 'Usikker afsendelse – kontrollér samtalen på iPhone', 'system');
    this.events.log(
      'error',
      'sms',
      'send_uncertain',
      `Besked #${messageId} har ukendt afsendelsesstatus. AI er pauseret for samtalen. Kontrollér i Beskeder om den blev sendt.`,
      { requiresAction: true, data: { conversationId, messageId } },
    );
  }

  ingestInbound(m: InboundSms): void {
    const phone = normalizePhone(m.from, '45');
    if (!phone) {
      this.events.log('warn', 'sms', 'unknown_sender', `Besked fra ukendt afsender-format ignoreret (${m.service})`, {
        data: { guid: m.externalGuid },
      });
      return;
    }
    const simulated = !!this.adapter?.simulated;
    const result = this.db.transaction(() => {
      const customer = this.conversations.upsertCustomer(phone);
      const convId = this.conversations.getOrCreateConversation(customer.id, m.chatId);
      const msgId = this.conversations.insertInbound(convId, m.text.slice(0, 2000), m.externalGuid, m.externalRowId ?? null, simulated);
      return { convId, msgId };
    })();
    if (result.msgId === null) return; // dublet – allerede registreret
    if (m.service === 'iMessage') {
      this.events.log('info', 'sms', 'imessage_received', `Besked fra ${maskPhone(phone)} kom via iMessage (ikke SMS)`, {
        dedupeKey: `imessage:${phone}`,
        dedupeMinutes: 1440,
      });
    }
    this.bus.emit('inbound_message', { conversationId: result.convId, messageId: result.msgId });
  }

  ingestObservedOutgoing(m: OutgoingObserved): void {
    // Er det en af vores egne beskeder? Match på GUID, ellers tekst + samtale inden for 3 minutter.
    const byGuid = this.db.prepare(`SELECT id FROM messages WHERE external_guid = ?`).get(m.externalGuid) as { id: number } | undefined;
    if (byGuid) return;
    const phone = normalizePhone(m.to, '45');
    if (!phone) return;
    const customer = this.conversations.customerByPhone(phone);
    const convId = customer ? this.conversations.getOrCreateConversation(customer.id) : null;
    if (convId) {
      const since = new Date(Date.now() - 3 * 60000).toISOString();
      const own = this.db
        .prepare(
          `SELECT id FROM messages WHERE conversation_id = ? AND direction = 'out' AND body = ? AND status IN ('sending','sent','uncertain')
           AND external_guid IS NULL AND created_at >= ? ORDER BY id DESC LIMIT 1`,
        )
        .get(convId, m.text, since) as { id: number } | undefined;
      if (own) {
        this.conversations.setMessageStatus(own.id, 'confirmed', { externalGuid: m.externalGuid, externalRowId: m.externalRowId ?? null });
        return;
      }
    }
    // Ukendt udgående besked = sandsynligvis en medarbejder, der svarer manuelt fra iPhone/Mac
    const c = customer ?? this.conversations.upsertCustomer(phone);
    const cid = convId ?? this.conversations.getOrCreateConversation(c.id, m.chatId);
    this.db
      .prepare(
        `INSERT INTO messages (conversation_id, direction, author, body, status, external_guid, external_rowid, simulated, created_at, sent_at)
         VALUES (?, 'out', 'staff', ?, 'confirmed', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(cid, m.text, m.externalGuid, m.externalRowId ?? null, this.adapter?.simulated ? 1 : 0, nowIso(), nowIso());
    this.bus.touch('messages', 'conversations');
    const conv = this.conversations.get(cid);
    if (this.settings.get().sms.pauseOnUnknownOutgoing && conv && conv.aiMode === 'ai_active') {
      this.conversations.setMode(cid, 'manual', 'Manuel besked registreret fra iPhone/Mac', 'system');
      this.events.log('info', 'sms', 'manual_activity', `Manuel besked registreret til ${maskPhone(phone)} – samtalen er sat til manuel overtagelse`, {
        data: { conversationId: cid },
      });
    }
  }

  /** Læg en besked i outbox og planlæg afsendelse. */
  queue(conversationId: number, body: string, author: 'ai' | 'staff' | 'system', idempotencyKey: string, orderId?: number | null): number {
    const { id, created } = this.conversations.queueOutbound(conversationId, body, author, idempotencyKey, {
      orderId,
      simulated: !!this.adapter?.simulated,
    });
    if (created) this.jobs.enqueue('send_sms', { messageId: id }, { lane: `conv:${conversationId}`, maxAttempts: 8 });
    return id;
  }

  private async handleSendJob(job: JobRow): Promise<void> {
    const messageId = job.payload.messageId as number;
    const row = this.db
      .prepare(
        `SELECT m.*, cu.phone, c.ai_mode FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN customers cu ON cu.id = c.customer_id WHERE m.id = ?`,
      )
      .get(messageId) as Record<string, unknown> | undefined;
    if (!row) throw new PermanentJobError(`Besked ${messageId} findes ikke`);
    const status = row.status as string;
    if (status === 'sending') {
      // Et tidligere forsøg nåede at overdrage beskeden – udfald ukendt
      this.conversations.setMessageStatus(messageId, 'uncertain', { error: 'Tidligere afsendelsesforsøg afbrudt' });
      this.flagUncertain(row.conversation_id as number, messageId);
      return;
    }
    if (status !== 'queued') return; // allerede sendt/blokeret – intet at gøre (idempotent)
    const author = row.author as string;
    const s = this.settings.get();
    if (author === 'ai') {
      if (row.ai_mode !== 'ai_active') {
        this.conversations.setMessageStatus(messageId, 'blocked', { error: 'AI ikke aktiv for samtalen' });
        return;
      }
      if (!s.installation.automationEnabled || !s.automation.customerReplies) {
        this.conversations.setMessageStatus(messageId, 'blocked', { error: 'Automatiske svar er slået fra' });
        return;
      }
      // For gamle automatiske svar sendes ikke (fx efter langt nedbrud)
      if (Date.now() - new Date(row.created_at as string).getTime() > 15 * 60000) {
        this.conversations.setMessageStatus(messageId, 'blocked', { error: 'Svaret blev for gammelt til automatisk afsendelse' });
        this.events.log('warn', 'sms', 'stale_reply', `Automatisk svar #${messageId} blev ikke sendt, fordi det var over 15 minutter gammelt`, {
          requiresAction: true,
          data: { conversationId: row.conversation_id },
        });
        return;
      }
    }
    const adapter = this.adapter;
    if (!adapter) {
      this.conversations.setMessageStatus(messageId, 'failed', { error: 'SMS-integration ikke konfigureret' });
      throw new PermanentJobError('SMS-integration ikke konfigureret');
    }
    const health = this.integrations.get('sms');
    if (health && health.state === 'error') {
      throw new RetryLaterError('SMS-integrationen er i fejltilstand', 15000);
    }
    // Overdragelse markeres FØR afsendelse (crash-sikkert)
    const claimed = this.db
      .prepare(`UPDATE messages SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'`)
      .run(messageId);
    if (claimed.changes === 0) return;
    this.bus.touch('messages');
    const result = await adapter.send(row.phone as string, row.body as string);
    if (result.disposition === 'sent') {
      this.conversations.setMessageStatus(messageId, result.externalGuid ? 'confirmed' : 'sent', {
        externalGuid: result.externalGuid ?? null,
        externalRowId: result.externalRowId ?? null,
        error: null,
      });
      return;
    }
    if (result.disposition === 'not_started') {
      this.db.prepare(`UPDATE messages SET status = 'queued', error = ? WHERE id = ?`).run(result.error ?? 'Ikke afsendt', messageId);
      this.bus.touch('messages');
      if (job.attempts >= job.maxAttempts) {
        this.conversations.setMessageStatus(messageId, 'failed', { error: result.error ?? 'Afsendelse fejlede' });
        this.events.log('error', 'sms', 'send_failed', `Besked #${messageId} kunne ikke sendes: ${result.error}`, {
          requiresAction: true,
          data: { conversationId: row.conversation_id },
        });
        return;
      }
      throw new Error(result.error ?? 'SMS ikke afsendt – prøver igen');
    }
    // uncertain
    this.conversations.setMessageStatus(messageId, 'uncertain', { error: result.error ?? 'Ukendt udfald' });
    this.flagUncertain(row.conversation_id as number, messageId);
  }

  /** Medarbejder bekræfter manuelt udfaldet af en usikker besked. */
  resolveUncertain(messageId: number, wasSent: boolean): void {
    const m = this.conversations.message(messageId);
    if (!m || m.status !== 'uncertain') throw new Error('Beskeden er ikke i usikker tilstand');
    this.conversations.setMessageStatus(messageId, wasSent ? 'sent' : 'failed', {
      error: wasSent ? 'Bekræftet sendt af medarbejder' : 'Bekræftet IKKE sendt af medarbejder',
    });
  }
}
