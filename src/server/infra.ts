import { EventEmitter } from 'node:events';
import type { Db } from './db/database';
import { nowIso, parseJson } from './db/database';
import { defaultSettings, mergeSettings } from './defaultSettings';
import type {
  EventLevel,
  IntegrationName,
  IntegrationState,
  IntegrationStatus,
  LiveTopic,
  Settings,
  SystemEvent,
} from '../shared/types';

/** Intern hændelsesbus. `live` sendes til UI'et; øvrige hændelser er domænehændelser. */
export class Bus extends EventEmitter {
  private pending = new Set<LiveTopic>();
  private timer: NodeJS.Timeout | null = null;

  /** Signalér at data for et emne er ændret (samles og sendes max hvert 150 ms). */
  touch(...topics: LiveTopic[]): void {
    for (const t of topics) this.pending.add(t);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const topics = [...this.pending];
        this.pending.clear();
        this.emit('live', topics);
      }, 150);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.removeAllListeners();
  }
}

export class SettingsService {
  private cache: Settings | null = null;
  constructor(
    private db: Db,
    private bus: Bus,
    private defaultMode: Settings['installation']['mode'],
  ) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as { value: string } | undefined;
    const base = defaultSettings(this.defaultMode);
    this.cache = row ? mergeSettings(base, parseJson(row.value, {})) : base;
    return this.cache;
  }

  update(patch: DeepPartial<Settings>): Settings {
    const next = mergeSettings(this.get(), patch);
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(next), nowIso());
    this.cache = next;
    this.bus.touch('settings');
    return next;
  }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Monitoring/hændelseslog. Alle advarsler og fejl, der kræver handling, registreres her. */
export class EventLog {
  constructor(
    private db: Db,
    private bus: Bus,
  ) {}

  log(
    level: EventLevel,
    source: string,
    type: string,
    message: string,
    opts: { data?: Record<string, unknown>; requiresAction?: boolean; dedupeKey?: string; dedupeMinutes?: number } = {},
  ): number | null {
    if (opts.dedupeKey) {
      const since = new Date(Date.now() - (opts.dedupeMinutes ?? 10) * 60000).toISOString();
      const existing = this.db
        .prepare(
          `SELECT id FROM events WHERE dedupe_key = ? AND acknowledged_at IS NULL AND created_at >= ? LIMIT 1`,
        )
        .get(opts.dedupeKey, since);
      if (existing) return null;
    }
    const r = this.db
      .prepare(
        `INSERT INTO events (level, source, type, message, data, requires_action, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        level,
        source,
        type,
        message,
        opts.data ? JSON.stringify(opts.data) : null,
        opts.requiresAction ? 1 : 0,
        opts.dedupeKey ?? null,
        nowIso(),
      );
    this.bus.touch('events');
    if (level === 'error' || level === 'critical') this.bus.emit('alert', { level, source, type, message });
    return Number(r.lastInsertRowid);
  }

  list(opts: { limit?: number; onlyOpen?: boolean; minLevel?: EventLevel } = {}): SystemEvent[] {
    const levels: EventLevel[] = ['info', 'warn', 'error', 'critical'];
    const min = levels.indexOf(opts.minLevel ?? 'info');
    const allowed = levels.slice(min);
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE level IN (${allowed.map(() => '?').join(',')})
         ${opts.onlyOpen ? 'AND acknowledged_at IS NULL AND requires_action = 1' : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...allowed, opts.limit ?? 200) as Record<string, unknown>[];
    return rows.map(mapEvent);
  }

  acknowledge(id: number): void {
    this.db.prepare(`UPDATE events SET acknowledged_at = ? WHERE id = ?`).run(nowIso(), id);
    this.bus.touch('events');
  }

  openActionCount(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM events WHERE requires_action = 1 AND acknowledged_at IS NULL`)
        .get() as { c: number }
    ).c;
  }
}

function mapEvent(r: Record<string, unknown>): SystemEvent {
  return {
    id: r.id as number,
    level: r.level as EventLevel,
    source: r.source as string,
    type: r.type as string,
    message: r.message as string,
    data: parseJson(r.data as string | null, null),
    createdAt: r.created_at as string,
    acknowledgedAt: (r.acknowledged_at as string) ?? null,
    requiresAction: !!r.requires_action,
  };
}

export class IntegrationRegistry {
  constructor(
    private db: Db,
    private bus: Bus,
    private events: EventLog,
  ) {}

  set(
    name: IntegrationName,
    state: IntegrationState,
    message: string | null,
    opts: { simulated?: boolean; productionVerified?: boolean } = {},
  ): void {
    const prev = this.get(name);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO integration_status (name, state, message, simulated, production_verified, updated_at, last_ok_at)
         VALUES (@name, @state, @message, @simulated, @verified, @now, @lastOk)
         ON CONFLICT(name) DO UPDATE SET state = excluded.state, message = excluded.message,
           simulated = excluded.simulated, production_verified = excluded.production_verified,
           updated_at = excluded.updated_at,
           last_ok_at = COALESCE(excluded.last_ok_at, integration_status.last_ok_at)`,
      )
      .run({
        name,
        state,
        message,
        simulated: opts.simulated ? 1 : 0,
        verified: opts.productionVerified ? 1 : 0,
        now,
        lastOk: state === 'ok' || state === 'simulated' ? now : null,
      });
    if (prev?.state !== state) {
      if (state === 'error') {
        this.events.log('critical', 'monitoring', 'integration_error', `${label(name)}: ${message ?? 'fejl'}`, {
          requiresAction: true,
          dedupeKey: `integration_error:${name}`,
          data: { integration: name },
        });
      } else if (state === 'degraded') {
        this.events.log('warn', 'monitoring', 'integration_degraded', `${label(name)}: ${message ?? 'forringet'}`, {
          dedupeKey: `integration_degraded:${name}`,
        });
      } else if (prev && (prev.state === 'error' || prev.state === 'degraded') && state === 'ok') {
        this.events.log('info', 'monitoring', 'integration_recovered', `${label(name)} fungerer igen`);
      }
      this.bus.emit('integration_state', { name, state, prev: prev?.state ?? null });
    }
    this.bus.touch('integrations');
  }

  get(name: IntegrationName): IntegrationStatus | null {
    const r = this.db.prepare(`SELECT * FROM integration_status WHERE name = ?`).get(name) as
      | Record<string, unknown>
      | undefined;
    return r ? mapIntegration(r) : null;
  }

  list(): IntegrationStatus[] {
    const names: IntegrationName[] = ['sms', 'telegram', 'maps', 'ai'];
    return names.map(
      (n) =>
        this.get(n) ?? {
          name: n,
          state: 'not_configured',
          message: null,
          updatedAt: nowIso(),
          lastOkAt: null,
          simulated: false,
          productionVerified: false,
        },
    );
  }

  isHealthy(name: IntegrationName): boolean {
    const s = this.get(name);
    return !!s && (s.state === 'ok' || s.state === 'simulated' || s.state === 'degraded');
  }
}

function label(n: IntegrationName): string {
  return { sms: 'SMS (Apple Messages)', telegram: 'Telegram', maps: 'Google Maps', ai: 'Claude API' }[n];
}

function mapIntegration(r: Record<string, unknown>): IntegrationStatus {
  return {
    name: r.name as IntegrationName,
    state: r.state as IntegrationState,
    message: (r.message as string) ?? null,
    updatedAt: r.updated_at as string,
    lastOkAt: (r.last_ok_at as string) ?? null,
    simulated: !!r.simulated,
    productionVerified: !!r.production_verified,
  };
}

/** Simpel nøgle/værdi-tilstand (fx cursor for beskedovervågning, Telegram-offset). */
export class KvState {
  constructor(private db: Db) {}
  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare(`SELECT value FROM kv_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return r ? parseJson(r.value, fallback) : fallback;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }
}

export class AuditLog {
  constructor(private db: Db) {}
  record(actor: string, action: string, entity?: string, entityId?: string | number, data?: unknown): void {
    this.db
      .prepare(`INSERT INTO audit_log (actor, action, entity, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(actor, action, entity ?? null, entityId != null ? String(entityId) : null, data ? JSON.stringify(data) : null, nowIso());
  }
  list(limit = 200): { id: number; actor: string; action: string; entity: string | null; entityId: string | null; data: unknown; createdAt: string }[] {
    return (this.db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      actor: r.actor as string,
      action: r.action as string,
      entity: (r.entity as string) ?? null,
      entityId: (r.entity_id as string) ?? null,
      data: parseJson(r.data as string | null, null),
      createdAt: r.created_at as string,
    }));
  }
}
