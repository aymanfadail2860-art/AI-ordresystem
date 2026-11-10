import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SendResult, SmsAdapter, SmsAdapterHandlers } from './types';
import { clock } from '../../clock';

/**
 * SIMULERET SMS-adapter til Demo Mode og tests.
 * Sender ALDRIG rigtige beskeder – alt foregår i hukommelsen.
 */
export class SimulatedSmsAdapter implements SmsAdapter {
  readonly kind = 'simulator' as const;
  readonly simulated = true;
  readonly canObserveOutgoing = true;
  /** Til tests: tving næste afsendelser til at fejle på en bestemt måde. */
  failNext: { disposition: 'not_started' | 'uncertain'; count: number } | null = null;
  readonly outbox = new EventEmitter(); // 'sent' (to, text)
  private handlers: SmsAdapterHandlers | null = null;
  private rowId = 0;
  readonly sentLog: { to: string; text: string; guid: string; at: string }[] = [];

  async start(handlers: SmsAdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.rowId = handlers.loadCursor() ?? 0;
    handlers.onHealth('ok', 'Simuleret SMS-forbindelse (Demo Mode)');
  }

  async stop(): Promise<void> {
    this.handlers = null;
  }

  async send(to: string, text: string): Promise<SendResult> {
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      const d = this.failNext.disposition;
      if (this.failNext.count === 0) this.failNext = null;
      return { disposition: d, error: `Simuleret fejl (${d})` };
    }
    const guid = `sim-out-${randomUUID()}`;
    const at = clock.date().toISOString();
    this.sentLog.push({ to, text, guid, at });
    this.rowId++;
    this.handlers?.saveCursor(this.rowId);
    // Den simulerede "telefon" modtager beskeden asynkront
    setImmediate(() => this.outbox.emit('sent', to, text));
    return { disposition: 'sent', externalGuid: guid, externalRowId: this.rowId };
  }

  /** Simulér at en kunde sender en SMS til virksomhedens nummer. */
  injectInbound(from: string, text: string): string {
    if (!this.handlers) throw new Error('SMS-simulator er ikke startet');
    const guid = `sim-in-${randomUUID()}`;
    this.rowId++;
    this.handlers.onInbound({
      externalGuid: guid,
      externalRowId: this.rowId,
      from,
      text,
      receivedAt: clock.date().toISOString(),
      service: 'SMS',
      chatId: `SMS;-;${from}`,
    });
    this.handlers.saveCursor(this.rowId);
    return guid;
  }

  /** Simulér at en medarbejder svarer manuelt fra iPhonen (observeret udgående besked). */
  injectManualOutgoing(to: string, text: string): string {
    if (!this.handlers) throw new Error('SMS-simulator er ikke startet');
    const guid = `sim-manual-${randomUUID()}`;
    this.rowId++;
    this.handlers.onOutgoingObserved({
      externalGuid: guid,
      externalRowId: this.rowId,
      to,
      text,
      at: clock.date().toISOString(),
      service: 'SMS',
      chatId: `SMS;-;${to}`,
    });
    return guid;
  }
}
