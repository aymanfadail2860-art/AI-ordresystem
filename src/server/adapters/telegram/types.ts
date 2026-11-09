export interface TelegramUpdate {
  /** Unik update-ID fra Telegram – bruges til dubletkontrol. */
  updateId: string;
  kind: 'message' | 'callback' | 'location';
  fromUserId: string;
  fromName: string;
  chatId: string;
  text?: string;
  callbackId?: string;
  callbackData?: string;
  location?: { lat: number; lng: number; live: boolean };
  at: string;
}

export interface TelegramButton {
  text: string;
  data: string;
}

export type TelegramSendDisposition = 'sent' | 'not_started' | 'uncertain';

export interface TelegramSendResult {
  disposition: TelegramSendDisposition;
  messageId?: string;
  error?: string;
  retryAfterMs?: number;
}

export interface TelegramHandlers {
  onUpdate(u: TelegramUpdate): void;
  onHealth(state: 'ok' | 'degraded' | 'error', message: string): void;
  loadOffset(): number | null;
  saveOffset(offset: number): void;
}

export interface TelegramAdapter {
  readonly kind: 'simulator' | 'bot_api';
  readonly simulated: boolean;
  start(h: TelegramHandlers): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<TelegramSendResult>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
}
