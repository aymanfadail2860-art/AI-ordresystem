import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { Ctx } from '../context';
import { nowIso, parseJson } from '../db/database';
import { compareStrategies, STRATEGIES } from './daySimulation';
import type { DispatchStrategy, SimulationMetrics, SimulationRun } from '../../shared/types';

/**
 * Starter driftssimuleringer i en separat worker-tråd (eget virtuelt ur og
 * egen in-memory-database) og gemmer resultaterne i simulation_runs.
 * Påvirker ikke den kørende installations data, kunder eller chauffører.
 */
export class SimulationRunner {
  private worker: Worker | null = null;
  private progress = { groupId: null as string | null, strategy: null as DispatchStrategy | null, pct: 0, startedAt: null as string | null };

  constructor(
    private ctx: () => Ctx,
    private workerPath: string | null,
  ) {}

  status() {
    return { running: !!this.worker, available: !!this.workerPath && fs.existsSync(this.workerPath), ...this.progress };
  }

  start(p: { seed: number; orders: number; drivers: number; strategies?: DispatchStrategy[] }): { groupId: string } {
    if (this.worker) throw new Error('En simulering kører allerede');
    if (!this.workerPath || !fs.existsSync(this.workerPath)) throw new Error('Simuleringsmotoren er ikke bygget (npm run build:main)');
    const strategies = (p.strategies?.length ? p.strategies : STRATEGIES).filter((s) => STRATEGIES.includes(s));
    if (!Number.isInteger(p.orders) || p.orders < 10 || p.orders > 1000) throw new Error('Antal ordrer skal være 10–1000');
    if (!Number.isInteger(p.drivers) || p.drivers < 1 || p.drivers > 30) throw new Error('Antal chauffører skal være 1–30');
    const ctx = this.ctx();
    const groupId = `sim-${Date.now()}`;
    const ids = new Map<DispatchStrategy, number>();
    for (const s of strategies) {
      const r = ctx.db
        .prepare(`INSERT INTO simulation_runs (group_id, seed, strategy, config, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
        .run(groupId, p.seed, s, JSON.stringify({ orders: p.orders, drivers: p.drivers, simulated: true }), nowIso());
      ids.set(s, Number(r.lastInsertRowid));
    }
    this.progress = { groupId, strategy: strategies[0], pct: 0, startedAt: nowIso() };
    const w = new Worker(this.workerPath, { workerData: { seed: p.seed, orders: p.orders, drivers: p.drivers, strategies } });
    this.worker = w;
    const finish = () => {
      this.worker = null;
      ctx.bus.touch('simulation');
    };
    w.on('message', (m: { type: string; strategy?: DispatchStrategy; pct?: number; metrics?: SimulationMetrics; message?: string }) => {
      if (m.type === 'progress') {
        this.progress.pct = m.pct ?? 0;
        this.progress.strategy = m.strategy ?? null;
        ctx.bus.touch('simulation');
      } else if (m.type === 'result' && m.strategy) {
        ctx.db
          .prepare(`UPDATE simulation_runs SET status = 'completed', metrics = ?, finished_at = ?, duration_ms = ? WHERE id = ?`)
          .run(JSON.stringify(m.metrics), nowIso(), m.metrics?.wallClockMs ?? null, ids.get(m.strategy));
        ctx.bus.touch('simulation');
      } else if (m.type === 'error') {
        ctx.db.prepare(`UPDATE simulation_runs SET status = 'failed', error = ?, finished_at = ? WHERE group_id = ? AND status = 'running'`).run(m.message ?? 'fejl', nowIso(), groupId);
        ctx.events.log('error', 'simulation', 'failed', `Driftssimulering fejlede: ${m.message}`);
      } else if (m.type === 'done') {
        ctx.events.log('info', 'simulation', 'completed', `Driftssimulering færdig (seed ${p.seed}, ${p.orders} ordrer, ${p.drivers} chauffører) – simulerede data`);
      }
    });
    w.on('error', (e) => {
      ctx.db.prepare(`UPDATE simulation_runs SET status = 'failed', error = ?, finished_at = ? WHERE group_id = ? AND status = 'running'`).run(e.message, nowIso(), groupId);
      finish();
    });
    w.on('exit', finish);
    ctx.audit.record('staff', 'simulation_start', 'simulation', groupId, p);
    return { groupId };
  }

  list(limit = 60): SimulationRun[] {
    return (this.ctx().db.prepare(`SELECT * FROM simulation_runs ORDER BY id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      groupId: (r.group_id as string) ?? null,
      seed: r.seed as number,
      strategy: r.strategy as DispatchStrategy,
      config: parseJson(r.config as string, {}),
      status: r.status as SimulationRun['status'],
      metrics: parseJson<SimulationMetrics | null>(r.metrics as string | null, null),
      error: (r.error as string) ?? null,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string) ?? null,
      durationMs: (r.duration_ms as number) ?? null,
    }));
  }

  /** Sammenligning for hver gruppe (samme seed/dag på tværs af strategier). */
  comparisons() {
    const groups = new Map<string, SimulationRun[]>();
    for (const r of this.list(150)) if (r.groupId) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);
    return [...groups.entries()].map(([groupId, runs]) => {
      const done = runs.filter((r) => r.metrics).map((r) => r.metrics!);
      const order = STRATEGIES.filter((s) => done.some((d) => d.strategy === s));
      const sorted = order.map((s) => done.find((d) => d.strategy === s)!);
      return { groupId, seed: runs[0].seed, config: runs[0].config, runs, comparison: sorted.length >= 2 ? compareStrategies(sorted) : null };
    });
  }
}
