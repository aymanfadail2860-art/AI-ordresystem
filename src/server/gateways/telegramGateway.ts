import type { Bus, EventLog, IntegrationRegistry, KvState } from '../infra';
import type { DriverService } from '../services/drivers';
import type { JobQueue, JobRow } from '../jobs/jobQueue';
import { PermanentJobError, RetryLaterError } from '../jobs/jobQueue';
import type { TelegramAdapter, TelegramButton, TelegramUpdate } from '../adapters/telegram/types';
import type { Db } from '../db/database';

/**
 * Telegram-gateway: chaufførkommunikation.
 * - Indgående updates registreres én gang (unik update-ID) og sendes videre som domænehændelse.
 * - Udgående beskeder logges og sendes via jobkø; usikre udfald gensendes ikke.
 */
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
  ) {
    jobs.register('send_telegram', (job) => this.handleSend(job));
  }

  get current(): TelegramAdapter | null {
    return this.adapter;
  }

  async start(adapter: TelegramAdapter | null): Promise<void> {
    this.adapter = adapter;
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
    this.jobs.enqueue('send_telegram', { messageId: msgId, driverId, text, buttons: opts.buttons ?? [] }, { lane: `driver:${driverId}`, maxAttempts: 6 });
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
      this.drivers.setMessageStatus(messageId, 'queued');
      if (r.retryAfterMs) throw new RetryLaterError(r.error ?? 'Telegram rate limit', r.retryAfterMs);
      throw new Error(r.error ?? 'Telegram-afsendelse fejlede');
    }
    this.drivers.setMessageStatus(messageId, 'uncertain');
    this.events.log('warn', 'telegram', 'send_uncertain', `Telegram-besked til ${driver.name} har ukendt status (${r.error})`, {
      requiresAction: true,
      data: { driverId, messageId },
    });
  }
}
