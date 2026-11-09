import type { TelegramAdapter, TelegramButton, TelegramHandlers, TelegramSendResult, TelegramUpdate } from './types';

/**
 * Telegram Bot API-adapter (long polling via getUpdates – ingen offentlig webhook
 * nødvendig, hvilket passer til en lokal Mac-installation).
 *
 * STATUS: Implementeret efter Telegram Bot API-dokumentationen, testet med
 * mockede HTTP-svar. Kræver verificering med en rigtig bot-token.
 */
export interface BotApiOptions {
  token: string;
  fetchFn?: typeof fetch;
  pollTimeoutS?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class TelegramBotApiAdapter implements TelegramAdapter {
  readonly kind = 'bot_api' as const;
  readonly simulated = false;
  private handlers: TelegramHandlers | null = null;
  private stopped = true;
  private offset = 0;
  private abort: AbortController | null = null;
  private backoffMs = 1000;
  private loopPromise: Promise<void> | null = null;

  constructor(private opts: BotApiOptions) {}

  private get fetchFn(): typeof fetch {
    return this.opts.fetchFn ?? fetch;
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.opts.token}/${method}`;
  }

  async start(h: TelegramHandlers): Promise<void> {
    this.handlers = h;
    this.stopped = false;
    this.offset = h.loadOffset() ?? 0;
    const me = await this.call<{ username: string }>('getMe', {}).catch((e: Error) => {
      h.onHealth('error', `Telegram-token afvist eller utilgængelig: ${e.message}`);
      return null;
    });
    if (me) h.onHealth('ok', `Forbundet som @${me.username}`);
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    await this.loopPromise?.catch(() => undefined);
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchFn(this.url(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (!json || !json.ok) {
      const err = new TelegramApiError(json?.description ?? `HTTP ${res.status}`, res.status, json?.parameters?.retry_after);
      throw err;
    }
    return json.result as T;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const updates = await this.call<RawUpdate[]>(
          'getUpdates',
          {
            offset: this.offset > 0 ? this.offset + 1 : undefined,
            timeout: this.opts.pollTimeoutS ?? 25,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
          },
          this.abort.signal,
        );
        this.backoffMs = 1000;
        for (const u of updates) {
          const mapped = mapUpdate(u);
          if (mapped) this.handlers?.onUpdate(mapped);
          // Offset gemmes efter hver update er registreret → genoptagelse efter genstart
          this.offset = Math.max(this.offset, u.update_id);
          this.handlers?.saveOffset(this.offset);
        }
        this.handlers?.onHealth('ok', 'Telegram-forbindelse aktiv');
      } catch (err) {
        if (this.stopped) return;
        const e = err as TelegramApiError;
        if (e instanceof TelegramApiError && (e.status === 401 || e.status === 404)) {
          this.handlers?.onHealth('error', 'Telegram-token er ugyldig. Opdatér den under Indstillinger.');
          await sleep(60000);
          continue;
        }
        this.handlers?.onHealth('degraded', `Telegram utilgængelig: ${e.message ?? String(err)}`);
        await sleep(e instanceof TelegramApiError && e.retryAfterS ? e.retryAfterS * 1000 : this.backoffMs);
        this.backoffMs = Math.min(60000, this.backoffMs * 2);
      }
    }
  }

  async sendMessage(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (buttons && buttons.length) {
      body.reply_markup = {
        inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) }))),
      };
    }
    try {
      const r = await this.call<{ message_id: number }>('sendMessage', body, AbortSignal.timeout(20000));
      return { disposition: 'sent', messageId: String(r.message_id) };
    } catch (err) {
      if (err instanceof TelegramApiError) {
        // Telegram svarede med en fejl → beskeden blev ikke leveret
        return {
          disposition: 'not_started',
          error: err.message,
          retryAfterMs: err.retryAfterS ? err.retryAfterS * 1000 : undefined,
        };
      }
      // Netværksfejl/timeout: vi ved ikke om Telegram modtog anmodningen
      const msg = (err as Error).message ?? String(err);
      const connRefused = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg);
      return { disposition: connRefused ? 'not_started' : 'uncertain', error: msg };
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text }).catch(() => undefined);
  }
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

interface RawUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface RawMessage {
  message_id: number;
  from?: RawUser;
  chat: { id: number; type: string };
  text?: string;
  date: number;
  location?: { latitude: number; longitude: number; live_period?: number };
}
interface RawUpdate {
  update_id: number;
  message?: RawMessage;
  edited_message?: RawMessage;
  callback_query?: { id: string; from: RawUser; data?: string; message?: RawMessage };
}

function name(u?: RawUser): string {
  if (!u) return 'Ukendt';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);
}

export function mapUpdate(u: RawUpdate): TelegramUpdate | null {
  const at = new Date().toISOString();
  if (u.callback_query) {
    const cq = u.callback_query;
    return {
      updateId: String(u.update_id),
      kind: 'callback',
      fromUserId: String(cq.from.id),
      fromName: name(cq.from),
      chatId: String(cq.message?.chat.id ?? cq.from.id),
      callbackId: cq.id,
      callbackData: cq.data,
      at,
    };
  }
  const m = u.message ?? u.edited_message;
  if (!m || !m.from) return null;
  if (m.location) {
    // Live-lokation sendes som edited_message ved hver opdatering
    return {
      updateId: String(u.update_id),
      kind: 'location',
      fromUserId: String(m.from.id),
      fromName: name(m.from),
      chatId: String(m.chat.id),
      location: { lat: m.location.latitude, lng: m.location.longitude, live: !!m.location.live_period || !!u.edited_message },
      at,
    };
  }
  if (u.edited_message) return null; // redigerede tekster behandles ikke igen
  if (typeof m.text !== 'string') return null;
  return {
    updateId: String(u.update_id),
    kind: 'message',
    fromUserId: String(m.from.id),
    fromName: name(m.from),
    chatId: String(m.chat.id),
    text: m.text,
    at,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
