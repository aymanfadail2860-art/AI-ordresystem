import type { Db } from '../db/database';
import { nowIso, parseJson } from '../db/database';
import type { EventLog } from '../infra';
import { clock } from '../clock';

/**
 * Vedvarende jobkø i SQLite.
 * - Overlever genstart (jobs gemmes i databasen).
 * - `dedupeKey` forhindrer dubletter af aktive jobs (fx flere hurtige SMS fra samme kunde).
 * - `lane` serialiserer jobs, der rører samme samtale/ordre.
 * - Retries med eksponentiel backoff + jitter. Handler kan kaste `PermanentJobError`
 *   for at undgå retry.
 */
export interface JobRow {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  lane: string | null;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (job: JobRow) => Promise<void>;

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export class RetryLaterError extends Error {
  constructor(
    message: string,
    public readonly delayMs: number,
  ) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

export interface EnqueueOptions {
  runAt?: Date;
  delayMs?: number;
  dedupeKey?: string;
  lane?: string;
  maxAttempts?: number;
}

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private busyLanes = new Set<string>();
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inflight = new Set<Promise<void>>();

  constructor(
    private db: Db,
    private events: EventLog,
    private opts: { concurrency?: number; pollMs?: number; now?: () => number } = {},
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, payload: Record<string, unknown>, o: EnqueueOptions = {}): number | null {
    const now = this.opts.now?.() ?? clock.now();
    const runAt = o.runAt ? o.runAt.toISOString() : new Date(now + (o.delayMs ?? 0)).toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO jobs (type, payload, lane, status, run_at, max_attempts, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(type, JSON.stringify(payload), o.lane ?? null, runAt, o.maxAttempts ?? 5, o.dedupeKey ?? null, nowIso(), nowIso());
    if (r.changes === 0) return null; // aktivt job med samme dedupe-nøgle findes allerede
    this.kick();
    return Number(r.lastInsertRowid);
  }

  /** Annullér ventende jobs med en given dedupe-nøgle (fx timeout for et tilbud, der er besvaret). */
  cancelByDedupeKey(dedupeKey: string): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE dedupe_key = ? AND status = 'pending'`)
      .run(nowIso(), dedupeKey);
  }

  /** Ved opstart: jobs der var 'running' da appen stoppede, sættes tilbage til 'pending'. */
  recoverAfterRestart(): number {
    const r = this.db
      .prepare(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`)
      .run(nowIso());
    return r.changes;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inflight]);
  }

  /** Kør alle forfaldne jobs indtil køen er tom (bruges i tests og demo). */
  async drain(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const started = this.tick();
      if (started === 0 && this.inflight.size === 0) return;
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 5))]);
    }
  }

  private kick(): void {
    if (!this.stopped) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
      this.schedule(this.opts.pollMs ?? 250);
    }, ms);
  }

  /** Start forfaldne jobs. Returnerer antal startede jobs. */
  tick(): number {
    const concurrency = this.opts.concurrency ?? 4;
    if (this.running >= concurrency) return 0;
    const now = new Date(this.opts.now?.() ?? clock.now()).toISOString();
    const due = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 50`)
      .all(now) as Record<string, unknown>[];
    let started = 0;
    for (const r of due) {
      if (this.running >= concurrency) break;
      const lane = (r.lane as string) ?? null;
      if (lane && this.busyLanes.has(lane)) continue;
      const claimed = this.db
        .prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(nowIso(), r.id);
      if (claimed.changes === 0) continue;
      const job: JobRow = {
        id: r.id as number,
        type: r.type as string,
        payload: parseJson(r.payload as string, {}),
        lane,
        attempts: (r.attempts as number) + 1,
        maxAttempts: r.max_attempts as number,
      };
      if (lane) this.busyLanes.add(lane);
      this.running++;
      started++;
      const p = this.execute(job).finally(() => {
        this.running--;
        if (lane) this.busyLanes.delete(lane);
        this.inflight.delete(p);
      });
      this.inflight.add(p);
    }
    return started;
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.finish(job, 'dead', `Ingen handler for jobtype ${job.type}`);
      return;
    }
    try {
      await handler(job);
      this.finish(job, 'done', null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PermanentJobError || job.attempts >= job.maxAttempts) {
        this.finish(job, 'dead', msg);
        this.events.log('error', 'jobs', 'job_failed', `Job ${job.type} fejlede permanent: ${msg}`, {
          data: { jobId: job.id, type: job.type, payload: job.payload },
          requiresAction: true,
          dedupeKey: `job_failed:${job.type}:${JSON.stringify(job.payload)}`,
        });
        return;
      }
      const delay =
        err instanceof RetryLaterError
          ? err.delayMs
          : Math.min(5 * 60_000, 1000 * 2 ** (job.attempts - 1)) * (0.8 + Math.random() * 0.4);
      const runAt = new Date((this.opts.now?.() ?? clock.now()) + delay).toISOString();
      this.db
        .prepare(`UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(runAt, msg, nowIso(), job.id);
    }
  }

  private finish(job: JobRow, status: 'done' | 'dead', error: string | null): void {
    this.db
      .prepare(`UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(status, error, nowIso(), job.id);
  }

  stats(): { pending: number; running: number; dead: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS c FROM jobs WHERE status IN ('pending','running','dead') GROUP BY status`)
      .all() as { status: string; c: number }[];
    const get = (s: string) => rows.find((r) => r.status === s)?.c ?? 0;
    return { pending: get('pending'), running: get('running'), dead: get('dead') };
  }

  /** Ryd gamle afsluttede jobs. */
  purge(olderThanDays = 7): void {
    const cutoff = new Date(clock.now() - olderThanDays * 86400000).toISOString();
    this.db.prepare(`DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at < ?`).run(cutoff);
  }
}
