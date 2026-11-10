import type { Bus, EventLog, IntegrationRegistry, KvState, SettingsService } from '../infra';
import type { DriverService } from '../services/drivers';
import type { JobQueue, JobRow } from '../jobs/jobQueue';
import { PermanentJobError, RetryLaterError } from '../jobs/jobQueue';
import type { TelegramAdapter, TelegramButton, TelegramUpdate } from '../adapters/telegram/types';
import type { Db } from '../db/database';
import { clock } from '../clock';

/**
 * Telegram-gateway: chaufførkommunikation.
 * - Indgående updates registreres én gang (unik update-ID) og sendes videre som domænehændelse.
 * - Udgående beskeder logges og sendes via jobkø; usikre udfald gensendes ikke.
 */
/** Afsendelsesforsøg pr. besked: 1, 2, 4 … 60 s mellem forsøg ≈ 35 minutters udfald. */
const SEND_ATTEMPTS = 40;
const retryDelay = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));

export class TelegramGateway {
  private adapter: TelegramAdapter | null = null;

  constructor(
    private db: Db,
    private bus: Bus,
    private drivers: DriverService,
    private jobs: JobQueue,
    private events: EventLog,
    private integrations: IntegrationRegistry,
    private kv: KvState,
    private settings: SettingsService,
  ) {
    jobs.register('send_telegram', (job) => this.handleSend(job));
    jobs.register('send_telegram_chat', (job) => this.handleSendChat(job));
  }

  /** Er opdateringen fra ledelsesgruppen eller en ledelsesbrugers private chat? */
  private isManagement(u: TelegramUpdate): boolean {
    const m = this.settings.get().management;
    if (m.groupChatId && u.chatId === m.groupChatId) return true;
    if (u.callbackData && /^(mgmt|rep):\d+:(approve|reject|alts|confirm|cancel)$/.test(u.callbackData)) return true;
    if (m.allowPrivateChats && u.chatId === u.fromUserId) {
      const r = this.db.prepare(`SELECT 1 FROM management_users WHERE telegram_user_id = ? AND active = 1`).get(u.fromUserId);
      if (r) return true;
      if (u.text && /^\/leder\s+/i.test(u.text.trim())) return true;
    }
    return false;
  }

  get current(): TelegramAdapter | null {
    return this.adapter;
  }

  async start(adapter: TelegramAdapter | null): Promise<void> {
    this.adapter = adapter;
    // Nedbrud midt i en afsendelse til en ledelseschat: vi ved ikke om den nåede frem → aldrig gensend
    this.db.prepare(`UPDATE management_messages SET status = 'uncertain' WHERE status = 'sending' AND direction = 'out'`).run();
    if (!adapter) {
      this.integrations.set('telegram', 'not_configured', 'Telegram-bot er ikke konfigureret');
      return;
    }
    await adapter.start({
      onUpdate: (u) => this.ingest(u),
      onHealth: (state, message) =>
        this.integrations.set('telegram', adapter.simulated && state === 'ok' ? 'simulated' : state, message, { simulated: adapter.simulated }),
      loadOffset: () => this.kv.get<number | null>(`telegram_offset:${adapter.kind}`, null),
      saveOffset: (o) => this.kv.set(`telegram_offset:${adapter.kind}`, o),
    });
  }

  async stop(): Promise<void> {
    await this.adapter?.stop();
  }

  private ingest(u: TelegramUpdate): void {
    if (this.isManagement(u)) {
      const body = u.kind === 'callback' ? `[knap] ${u.callbackData ?? ''}` : u.text ?? '';
      const r = this.db
        .prepare(
          `INSERT INTO management_messages (chat_id, direction, user_name, body, external_update_id, simulated, created_at) VALUES (?, 'in', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(u.chatId, u.fromName, body, `${this.adapter?.kind}:${u.updateId}`, this.adapter?.simulated ? 1 : 0, clock.date().toISOString());
      if (r.changes === 0) return; // dublet
      this.bus.touch('management');
      if (u.kind === 'location') return;
      this.bus.emit('management_update', { update: u });
      return;
    }
    const driver = this.drivers.byTelegramUser(u.fromUserId);
    const body =
      u.kind === 'message' ? u.text ?? '' : u.kind === 'callback' ? `[knap] ${u.callbackData ?? ''}` : `[position] ${u.location?.lat.toFixed(5)}, ${u.location?.lng.toFixed(5)}`;
    if (u.kind !== 'location') {
      const id = this.drivers.logMessage({
        driverId: driver?.id ?? null,
        direction: 'in',
        body,
        updateId: `${this.adapter?.kind}:${u.updateId}`,
        simulated: !!this.adapter?.simulated,
      });
      if (id === null) return; // dublet
    }
    this.bus.emit('telegram_update', { update: u, driverId: driver?.id ?? null });
  }

  /** Send besked til en chauffør (via jobkø). `idempotencyKey` forhindrer dubletter. */
  sendToDriver(driverId: number, text: string, idempotencyKey: string, opts: { buttons?: TelegramButton[][]; orderId?: number | null } = {}): void {
    const msgId = this.drivers.logMessage({
      driverId,
      direction: 'out',
      body: text,
      idempotencyKey,
      orderId: opts.orderId ?? null,
      simulated: !!this.adapter?.simulated,
    });
    if (msgId === null) return;
    this.jobs.enqueue('send_telegram', { messageId: msgId, driverId, text, buttons: opts.buttons ?? [] }, { lane: `driver:${driverId}`, maxAttempts: SEND_ATTEMPTS });
  }

  /** Send en besked til en vilkårlig chat (fx ledelsesgruppen). Idempotent via nøglen. */
  sendToChat(chatId: string, text: string, idempotencyKey: string, buttons?: TelegramButton[][]): boolean {
    return this.db.transaction(() => this.queueChat(chatId, text, idempotencyKey, buttons))();
  }

  private queueChat(chatId: string, text: string, idempotencyKey: string, buttons?: TelegramButton[][]): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO management_messages (chat_id, direction, body, idempotency_key, status, simulated, created_at) VALUES (?, 'out', ?, ?, 'queued', ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(chatId, text, idempotencyKey, this.adapter?.simulated ? 1 : 0, clock.date().toISOString());
    if (r.changes === 0) return false;
    this.bus.touch('management');
    this.jobs.enqueue('send_telegram_chat', { messageId: Number(r.lastInsertRowid), chatId, text, buttons: buttons ?? [] }, { lane: `chat:${chatId}`, maxAttempts: SEND_ATTEMPTS });
    return true;
  }

  /** Afsendelsesstatus for en ledelsesbesked (via idempotensnøgle). */
  chatMessageStatus(idempotencyKey: string): string | null {
    return (this.db.prepare(`SELECT status FROM management_messages WHERE idempotency_key = ?`).get(idempotencyKey) as { status: string } | undefined)?.status ?? null;
  }

  private async handleSendChat(job: JobRow): Promise<void> {
    const { messageId, chatId, text, buttons } = job.payload as { messageId: number; chatId: string; text: string; buttons: TelegramButton[][] };
    const status = (this.db.prepare(`SELECT status FROM management_messages WHERE id = ?`).get(messageId) as { status: string } | undefined)?.status;
    if (status !== 'queued') return;
    const giveUp = (msg: string) => {
      this.db.prepare(`UPDATE management_messages SET status = 'failed' WHERE id = ? AND status = 'queued'`).run(messageId);
      this.bus.touch('management');
      return new PermanentJobError(msg);
    };
    if (!this.adapter) throw giveUp('Telegram ikke konfigureret');
    const last = job.attempts >= job.maxAttempts;
    this.db.prepare(`UPDATE management_messages SET status = 'sending' WHERE id = ?`).run(messageId);
    let r: Awaited<ReturnType<TelegramAdapter['sendMessage']>>;
    try {
      r = await this.adapter.sendMessage(chatId, text, buttons);
    } catch (e) {
      // Uventet undtagelse: afsendelsen kan være nået frem → usikker, aldrig gensendt
      this.db.prepare(`UPDATE management_messages SET status = 'uncertain' WHERE id = ?`).run(messageId);
      this.bus.touch('management');
      void e;
      return;
    }
    if (r.disposition === 'sent') {
      this.db.prepare(`UPDATE management_messages SET status = 'sent' WHERE id = ?`).run(messageId);
      return;
    }
    if (r.disposition === 'not_started') {
      this.db.prepare(`UPDATE management_messages SET status = 'queued' WHERE id = ?`).run(messageId);
      if (last) throw giveUp(r.error ?? 'Telegram-afsendelse fejlede');
      throw new RetryLaterError(r.error ?? 'Telegram-afsendelse fejlede', r.retryAfterMs ?? retryDelay(job.attempts));
    }
    this.db.prepare(`UPDATE management_messages SET status = 'uncertain' WHERE id = ?`).run(messageId);
  }

  async answerCallback(callbackId: string | undefined, text?: string): Promise<void> {
    if (callbackId) await this.adapter?.answerCallback(callbackId, text);
  }

  private async handleSend(job: JobRow): Promise<void> {
    const { messageId, driverId, text, buttons } = job.payload as { messageId: number; driverId: number; text: string; buttons: TelegramButton[][] };
    const status = (this.db.prepare(`SELECT status FROM driver_messages WHERE id = ?`).get(messageId) as { status: string } | undefined)?.status;
    if (status === 'sending') {
      this.drivers.setMessageStatus(messageId, 'uncertain');
      return;
    }
    if (status !== 'queued') return;
    const driver = this.drivers.get(driverId);
    if (!driver?.telegramChatId) {
      this.drivers.setMessageStatus(messageId, 'failed');
      this.events.log('warn', 'telegram', 'driver_not_linked', `Chauffør ${driver?.name ?? driverId} er ikke forbundet til Telegram`, {
        requiresAction: true,
        dedupeKey: `driver_not_linked:${driverId}`,
      });
      throw new PermanentJobError('Chauffør ikke forbundet til Telegram');
    }
    if (!this.adapter) throw new PermanentJobError('Telegram ikke konfigureret');
    this.drivers.setMessageStatus(messageId, 'sending');
    const r = await this.adapter.sendMessage(driver.telegramChatId, text, buttons);
    if (r.disposition === 'sent') {
      this.drivers.setMessageStatus(messageId, 'sent');
      return;
    }
    if (r.disposition === 'not_started') {
      // Bevist ikke afsendt → sikkert at prøve igen. Ved netværksudfald ventes op til ca. 35 min.
      if (job.attempts >= job.maxAttempts) {
        this.drivers.setMessageStatus(messageId, 'failed');
        throw new PermanentJobError(r.error ?? 'Telegram-afsendelse fejlede');
      }
      this.drivers.setMessageStatus(messageId, 'queued');
      throw new RetryLaterError(r.error ?? 'Telegram-afsendelse fejlede', r.retryAfterMs ?? retryDelay(job.attempts));
    }
    this.drivers.setMessageStatus(messageId, 'uncertain');
    this.events.log('warn', 'telegram', 'send_uncertain', `Telegram-besked til ${driver.name} har ukendt status (${r.error})`, {
      requiresAction: true,
      data: { driverId, messageId },
    });
  }
}
