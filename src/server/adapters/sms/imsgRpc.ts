import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { InboundSms, SendResult, SmsAdapter, SmsAdapterHandlers } from './types';

/**
 * SMS-adapter baseret på `imsg rpc` (https://github.com/openclaw/imsg, MIT).
 *
 * imsg læser macOS' Messages-database (chat.db, read-only) og sender via
 * Messages.app's AppleScript-overflade. Almindelig SMS kræver, at
 * "Videresendelse af SMS" er slået til på virksomhedens iPhone for denne Mac.
 *
 * STATUS: Implementeret efter imsg's dokumenterede JSON-RPC-protokol, men
 * IKKE verificeret på rigtig hardware. Se INTEGRATIONS.md → Proof of Concept.
 *
 * Sikkerhedsprincipper:
 * - Afsendelser, der fejler med `may_have_completed` / `still_in_flight`,
 *   timeout eller procesnedbrud, rapporteres som `uncertain` og gensendes aldrig.
 * - Kun fejl, der beviser at intet blev sendt (`retry_safe: true` /
 *   valideringsfejl), rapporteres som `not_started`.
 */
export interface ImsgOptions {
  binaryPath: string;
  region: string;
  service: 'sms' | 'auto';
  requestTimeoutMs?: number;
  spawnFn?: (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcError) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data: Record<string, unknown> | null,
    public readonly kind: 'rpc' | 'timeout' | 'process_exit' = 'rpc',
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface ImsgMessage {
  id: number;
  guid: string;
  chat_id: number;
  chat_identifier?: string;
  chat_guid?: string;
  participants?: string[];
  is_group?: boolean;
  sender?: string;
  is_from_me: boolean;
  text?: string;
  created_at: string;
  type?: 'edited' | 'unsent';
}

export class ImsgRpcSmsAdapter implements SmsAdapter {
  readonly kind = 'imsg' as const;
  readonly simulated = false;
  readonly canObserveOutgoing = true;
  private child: ChildProcessWithoutNullStreams | null = null;
  private handlers: SmsAdapterHandlers | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stopped = true;
  private restartDelayMs = 1000;
  private restartTimer: NodeJS.Timeout | null = null;
  private cursor = 0;

  constructor(private opts: ImsgOptions) {}

  async start(handlers: SmsAdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    this.cursor = handlers.loadCursor() ?? 0;
    await this.launch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const c = this.child;
    this.child = null;
    if (c) {
      c.stdin.end(); // imsg afslutter pænt, når stdin lukkes
      setTimeout(() => c.kill('SIGTERM'), 3000).unref();
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string) {
    this.opts.log?.(level, `[imsg] ${msg}`);
  }

  private async launch(): Promise<void> {
    if (this.stopped) return;
    const spawnFn = this.opts.spawnFn ?? ((cmd, args) => spawn(cmd, args, { stdio: 'pipe' }));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(this.opts.binaryPath, ['rpc']);
    } catch (err) {
      this.handlers?.onHealth('error', `Kunne ikke starte imsg: ${(err as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    child.on('error', (err) => {
      this.handlers?.onHealth('error', `imsg-procesfejl: ${err.message}`);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    child.stderr.on('data', (d: Buffer) => this.log('warn', d.toString().trim().slice(0, 500)));
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));

    try {
      const status = (await this.request('initialize', { protocol_version: 1 }, 15000)) as {
        database?: { ready?: boolean; error?: string };
        version?: string;
      };
      if (!status?.database?.ready) {
        this.handlers?.onHealth(
          'error',
          `Messages-databasen kan ikke læses (${status?.database?.error ?? 'ukendt'}). Giv AI Dispatch "Fuld diskadgang".`,
        );
        // Prøv igen senere – imsg genåbner databasen ved næste forespørgsel
        this.scheduleRestart();
        return;
      }
      await this.request('watch.subscribe', { since_rowid: this.cursor > 0 ? this.cursor : 0, debounce_ms: 500 }, 15000);
      this.restartDelayMs = 1000;
      this.handlers?.onHealth('ok', `Forbundet til Messages via imsg ${status.version ?? ''}`.trim());
    } catch (err) {
      this.handlers?.onHealth('error', `imsg-opstart fejlede: ${(err as Error).message}`);
      this.scheduleRestart();
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: string | null) {
    if (this.child !== child && this.child !== null) return;
    this.child = null;
    // Alle ventende forespørgsler har ukendt udfald
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(-1, `imsg afsluttede (kode ${code}, signal ${signal})`, null, 'process_exit'));
      this.pending.delete(id);
    }
    if (!this.stopped) {
      this.handlers?.onHealth('error', `imsg-processen stoppede uventet (kode ${code}). Genstarter…`);
      this.scheduleRestart();
    }
  }

  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(60000, this.restartDelayMs * 2);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.child) {
        const c = this.child;
        this.child = null;
        c.stdin.end();
        c.kill('SIGTERM');
      }
      void this.launch();
    }, delay);
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log('warn', `Ugyldig JSON fra imsg: ${line.slice(0, 200)}`);
      return;
    }
    if ('id' in msg && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if ('error' in msg && msg.error) {
        const e = msg.error as { code: number; message: string; data?: unknown };
        p.reject(new RpcError(e.code, e.message, typeof e.data === 'object' && e.data ? (e.data as Record<string, unknown>) : null));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'message') {
      const params = msg.params as { message: ImsgMessage };
      this.onMessage(params.message);
    } else if (msg.method === 'watch.overflow') {
      const params = msg.params as { resume_after_rowid: number };
      this.log('warn', `Watch-buffer løb over – genabonnerer fra række ${params.resume_after_rowid}`);
      this.cursor = Math.min(this.cursor, params.resume_after_rowid);
      this.request('watch.subscribe', { since_rowid: params.resume_after_rowid, debounce_ms: 500 }, 15000).catch((e) =>
        this.handlers?.onHealth('error', `Kunne ikke genabonnere: ${(e as Error).message}`),
      );
    }
  }

  private onMessage(m: ImsgMessage) {
    if (!this.handlers || !m || typeof m.id !== 'number') return;
    if (m.type) return; // redigeringer/tilbagekaldelser ændrer ikke ordrer automatisk
    if (m.id > this.cursor) {
      this.cursor = m.id;
      this.handlers.saveCursor(m.id);
    }
    if (m.is_group) {
      this.log('info', `Ignorerer gruppebesked ${m.guid}`);
      return;
    }
    const service = serviceFromChatGuid(m.chat_guid);
    const text = (m.text ?? '').trim();
    if (m.is_from_me) {
      const to = m.participants?.[0] ?? m.chat_identifier ?? '';
      this.handlers.onOutgoingObserved({
        externalGuid: m.guid,
        externalRowId: m.id,
        chatId: m.chat_guid ?? String(m.chat_id),
        to,
        text,
        at: m.created_at,
        service,
      });
      return;
    }
    if (!text) return; // fx rene billeder/tapbacks – registreres ikke som ordretekst
    const inbound: InboundSms = {
      externalGuid: m.guid,
      externalRowId: m.id,
      chatId: m.chat_guid ?? String(m.chat_id),
      from: m.sender ?? m.chat_identifier ?? '',
      text,
      receivedAt: m.created_at,
      service,
    };
    this.handlers.onInbound(inbound);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new RpcError(-1, 'imsg kører ikke', null, 'process_exit'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-2, `Timeout på ${method}`, null, 'timeout'));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 60000);
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async send(to: string, text: string): Promise<SendResult> {
    if (!this.child) return { disposition: 'not_started', error: 'imsg kører ikke' };
    try {
      const result = (await this.request('send', {
        to,
        text,
        service: this.opts.service,
        region: this.opts.region,
        ...(this.opts.service === 'auto' ? { allow_sms_fallback: true } : {}),
      })) as { ok?: boolean; id?: number; guid?: string };
      if (result?.ok) {
        return { disposition: 'sent', externalGuid: result.guid, externalRowId: result.id };
      }
      return { disposition: 'uncertain', error: 'imsg svarede uden ok=true' };
    } catch (err) {
      return { ...classifySendError(err), error: (err as Error).message };
    }
  }
}

/** Klassificér en afsendelsesfejl. Kun bevist ikke-afsendte fejl er sikre at gentage. */
export function classifySendError(err: unknown): { disposition: 'not_started' | 'uncertain' } {
  if (err instanceof RpcError) {
    if (err.kind !== 'rpc') return { disposition: 'uncertain' }; // timeout / processtop
    if (err.data && err.data.retry_safe === true) return { disposition: 'not_started' };
    if (err.data && (err.data.disposition === 'not_started')) return { disposition: 'not_started' };
    // JSON-RPC protokol-/valideringsfejl afvises før afsendelse
    if ([-32700, -32600, -32601, -32602].includes(err.code)) return { disposition: 'not_started' };
    // -32004: mutation-lane blokeret af tidligere usikker afsendelse – intet afsendt
    if (err.code === -32004) return { disposition: 'not_started' };
  }
  return { disposition: 'uncertain' };
}

export function serviceFromChatGuid(guid?: string): string {
  if (!guid) return 'unknown';
  const prefix = guid.split(';')[0];
  return prefix || 'unknown';
}
