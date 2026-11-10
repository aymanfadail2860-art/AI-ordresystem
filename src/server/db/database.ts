import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, type Migration } from './migrations';
import { clock } from '../clock';

export type Db = BetterSqlite3.Database;

export interface OpenDbOptions {
  /** Filsti eller ':memory:' */
  file: string;
  /** Kaldes før migrationer køres på en eksisterende database (fx backup). */
  beforeMigrate?: (db: Db, pending: Migration[]) => void;
}

export function nowIso(): string {
  return clock.date().toISOString();
}

export function openDatabase(opts: OpenDbOptions): Db {
  if (opts.file !== ':memory:') fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  const db = new BetterSqlite3(opts.file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, opts.beforeMigrate);
  cacheStatements(db);
  return db;
}

/**
 * Genbrug forberedte SQL-sætninger (better-sqlite3 kompilerer ellers SQL ved
 * hvert kald). Ingen kode bruger iterate/pluck/raw, så sætningerne kan deles.
 * Dynamiske sætninger (fx IN-lister) holdes nede af en simpel størrelsesgrænse.
 */
function cacheStatements(db: Db): void {
  const original = db.prepare.bind(db);
  const cache = new Map<string, ReturnType<Db['prepare']>>();
  (db as { prepare: Db['prepare'] }).prepare = ((sql: string) => {
    let st = cache.get(sql);
    if (!st) {
      st = original(sql);
      if (cache.size > 2000) cache.clear();
      cache.set(sql, st);
    }
    return st;
  }) as Db['prepare'];
}

export function migrate(db: Db, beforeMigrate?: OpenDbOptions['beforeMigrate']): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return 0;
  if (applied.size > 0 && beforeMigrate) beforeMigrate(db, pending);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        nowIso(),
      );
    })();
  }
  return pending.length;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/** Hjælper: JSON-parse med fallback. */
export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
