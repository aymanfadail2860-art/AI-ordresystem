import { EventEmitter } from 'node:events';
import type { TelegramAdapter, TelegramButton, TelegramHandlers, TelegramSendResult } from './types';

/**
 * SIMULERET Telegram-adapter. Sender ALDRIG rigtige Telegram-beskeder.
 */
export class SimulatedTelegramAdapter implements TelegramAdapter {
  readonly kind = 'simulator' as const;
  readonly simulated = true;
  readonly outbox = new EventEmitter(); // 'sent' (chatId, text, buttons)
  private handlers: TelegramHandlers | null = null;
  private updateId = 0;
  private messageId = 0;

  async start(h: TelegramHandlers): Promise<void> {
    this.handlers = h;
    this.updateId = h.loadOffset() ?? 0;
    h.onHealth('ok', 'Simuleret Telegram-bot (Demo Mode)');
  }

  async stop(): Promise<void> {
    this.handlers = null;
  }

  async sendMessage(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<TelegramSendResult> {
    this.messageId++;
    setImmediate(() => this.outbox.emit('sent', chatId, text, buttons ?? []));
    return { disposition: 'sent', messageId: String(this.messageId) };
  }

  async answerCallback(): Promise<void> {}

  injectText(userId: string, name: string, text: string): void {
    this.push({ kind: 'message', fromUserId: userId, fromName: name, chatId: userId, text });
  }

  injectCallback(userId: string, name: string, data: string): void {
    this.push({ kind: 'callback', fromUserId: userId, fromName: name, chatId: userId, callbackData: data, callbackId: `cb-${this.updateId + 1}` });
  }

  /** Simulér en besked fra en bruger i en gruppechat (fx ledelsesgruppen). */
  injectGroupText(chatId: string, userId: string, name: string, text: string): void {
    this.push({ kind: 'message', fromUserId: userId, fromName: name, chatId, text });
  }

  injectGroupCallback(chatId: string, userId: string, name: string, data: string): void {
    this.push({ kind: 'callback', fromUserId: userId, fromName: name, chatId, callbackData: data, callbackId: `cb-${this.updateId + 1}` });
  }

  injectLocation(userId: string, name: string, lat: number, lng: number): void {
    this.push({ kind: 'location', fromUserId: userId, fromName: name, chatId: userId, location: { lat, lng, live: true } });
  }

  private push(u: Omit<Parameters<TelegramHandlers['onUpdate']>[0], 'updateId' | 'at'>): void {
    if (!this.handlers) throw new Error('Telegram-simulator er ikke startet');
    this.updateId++;
    this.handlers.onUpdate({ ...u, updateId: `sim-${this.updateId}`, at: new Date().toISOString() });
    this.handlers.saveOffset(this.updateId);
  }
}
