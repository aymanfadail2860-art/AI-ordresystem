import type { Db } from '../db/database';
import { nowIso } from '../db/database';
import type { Bus, EventLog, IntegrationRegistry, SettingsService } from '../infra';
import type { AiCall, AiTaskType, AiUsageSummary, ModelPricing } from '../../shared/types';
import {
  ModelUnavailableError,
  PermanentAiError,
  TransientAiError,
  type AiUsage,
  type LlmProvider,
  type StructuredRequest,
} from '../adapters/ai/types';
import { DEFAULT_TZ, localToUtc, startOfLocalDay, zonedParts } from '../../core/time';
import { clock } from '../clock';

export class BudgetExceededError extends Error {
  constructor() {
    super('Månedligt AI-budget er opbrugt – AI-kald er stoppet');
    this.name = 'BudgetExceededError';
  }
}

export class AiDisabledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AiDisabledError';
  }
}

/** Beregn pris i USD ud fra konfigurerede modelpriser. Ukendt model → 0 (men logges). */
export function costUsd(model: string, usage: AiUsage, pricing: ModelPricing[]): number {
  const p = pricing.find((m) => model === m.id || model.startsWith(m.id));
  if (!p) return 0;
  return (
    (usage.inputTokens * p.inputPerMTokUsd +
      usage.outputTokens * p.outputPerMTokUsd +
      usage.cacheReadTokens * p.cacheReadPerMTokUsd +
      usage.cacheWriteTokens * p.cacheWritePerMTokUsd) /
    1_000_000
  );
}

/**
 * AI-gateway: ét samlet sted for alle sprogmodelkald.
 * - Modelvalg pr. opgavetype (konfigurerbart) + fallback-modeller
 * - Månedligt budget med advarsel og hårdt stop
 * - Logning af tokenforbrug, pris, latenstid og fejl
 */
export class AiGateway {
  private unavailableModels = new Map<string, number>();

  constructor(
    private db: Db,
    private bus: Bus,
    private settings: SettingsService,
    private events: EventLog,
    private integrations: IntegrationRegistry,
    private provider: LlmProvider | null,
  ) {}

  get configured(): boolean {
    return !!this.provider;
  }

  setProvider(p: LlmProvider | null): void {
    this.provider = p;
  }

  async structured<T>(
    task: AiTaskType,
    agent: string,
    req: Omit<StructuredRequest<T>, 'model'>,
    ids: { conversationId?: number | null; orderId?: number | null; modelOverride?: string } = {},
  ): Promise<{ output: T | null; model: string; refused: boolean }> {
    const s = this.settings.get();
    if (!this.provider) throw new AiDisabledError('Claude API er ikke konfigureret');
    if (!s.ai.enabled) throw new AiDisabledError('AI er slået fra i indstillingerne');
    this.checkBudget();

    const primary = ids.modelOverride ?? s.ai.routing[task];
    const candidates = [primary, ...s.ai.fallbackModels.filter((m) => m !== primary)].filter((m) => {
      const until = this.unavailableModels.get(m);
      return !until || until < clock.now();
    });
    if (candidates.length === 0) throw new AiDisabledError('Ingen konfigurerede modeller er tilgængelige');

    let lastErr: unknown = null;
    for (const model of candidates) {
      const started = clock.now();
      try {
        const res = await this.provider.structured({ ...req, model });
        this.logCall({ agent, task, model: res.model || model, usage: res.usage, latencyMs: clock.now() - started, success: !!res.output, error: res.refused ? 'refusal' : res.output ? null : 'ugyldigt output', ids });
        this.integrations.set('ai', 'ok', `Seneste kald: ${model}`);
        return { output: res.output, model: res.model || model, refused: res.refused };
      } catch (err) {
        lastErr = err;
        this.logCall({ agent, task, model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, latencyMs: clock.now() - started, success: false, error: (err as Error).message, ids });
        if (err instanceof ModelUnavailableError) {
          this.unavailableModels.set(model, clock.now() + 30 * 60000);
          this.events.log('warn', 'ai', 'model_unavailable', `Modellen ${model} er ikke tilgængelig – prøver fallback`, {
            dedupeKey: `model_unavailable:${model}`,
            requiresAction: true,
          });
          continue;
        }
        if (err instanceof PermanentAiError) {
          this.integrations.set('ai', 'error', err.message);
          throw err;
        }
        if (err instanceof TransientAiError) {
          this.integrations.set('ai', 'degraded', err.message);
          throw err;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('AI-kald fejlede');
  }

  /** Log et simuleret kald (Demo Mode) – vises i AI Control Center som simuleret, pris 0. */
  logSimulated(agent: string, task: AiTaskType, approxInputChars: number, approxOutputChars: number, ids: { conversationId?: number | null } = {}): void {
    this.logCall({
      agent,
      task,
      model: 'demo-regelbaseret',
      usage: { inputTokens: Math.ceil(approxInputChars / 4), outputTokens: Math.ceil(approxOutputChars / 4), cacheReadTokens: 0, cacheWriteTokens: 0 },
      latencyMs: 1,
      success: true,
      error: null,
      ids,
      simulated: true,
    });
  }

  private logCall(c: {
    agent: string;
    task: string;
    model: string;
    usage: AiUsage;
    latencyMs: number;
    success: boolean;
    error: string | null;
    ids: { conversationId?: number | null; orderId?: number | null };
    simulated?: boolean;
  }): void {
    const cost = c.simulated ? 0 : costUsd(c.model, c.usage, this.settings.get().ai.models);
    this.db
      .prepare(
        `INSERT INTO ai_calls (agent, task_type, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd_micros, latency_ms, success, error, simulated, conversation_id, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.agent,
        c.task,
        c.model,
        c.usage.inputTokens,
        c.usage.outputTokens,
        c.usage.cacheReadTokens,
        c.usage.cacheWriteTokens,
        Math.round(cost * 1_000_000),
        c.latencyMs,
        c.success ? 1 : 0,
        c.error,
        c.simulated ? 1 : 0,
        c.ids.conversationId ?? null,
        c.ids.orderId ?? null,
        nowIso(),
      );
    this.bus.touch('ai');
    if (!c.simulated) this.checkBudgetWarnings();
  }

  private monthStartIso(): string {
    const p = zonedParts(clock.now(), this.settings.get().company.timezone || DEFAULT_TZ);
    return new Date(localToUtc(p.year, p.month, 1, 0, 0, this.settings.get().company.timezone || DEFAULT_TZ)).toISOString();
  }

  private monthCostUsd(): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd_micros), 0) AS c FROM ai_calls WHERE created_at >= ?`).get(this.monthStartIso()) as { c: number };
    return r.c / 1_000_000;
  }

  checkBudget(): void {
    const s = this.settings.get();
    if (s.ai.monthlyBudgetUsd > 0 && this.monthCostUsd() >= s.ai.monthlyBudgetUsd) {
      this.events.log('critical', 'ai', 'budget_exceeded', 'Månedligt AI-budget er opbrugt. AI-svar er stoppet – samtaler sendes til medarbejder.', {
        requiresAction: true,
        dedupeKey: `budget_exceeded:${clock.date().toISOString().slice(0, 7)}`,
        dedupeMinutes: 60 * 24 * 31,
      });
      throw new BudgetExceededError();
    }
  }

  private checkBudgetWarnings(): void {
    const s = this.settings.get();
    if (s.ai.monthlyBudgetUsd <= 0) return;
    const pct = (this.monthCostUsd() / s.ai.monthlyBudgetUsd) * 100;
    if (pct >= s.ai.warnAtPct) {
      this.events.log('warn', 'ai', 'budget_warning', `AI-forbrug har nået ${pct.toFixed(0)} % af månedsbudgettet`, {
        requiresAction: true,
        dedupeKey: `budget_warning:${clock.date().toISOString().slice(0, 7)}`,
        dedupeMinutes: 60 * 24 * 31,
      });
    }
  }

  summary(): AiUsageSummary {
    const s = this.settings.get();
    const monthStart = new Date(this.monthStartIso());
    const today = new Date(startOfLocalDay(clock.now(), s.company.timezone || DEFAULT_TZ));
    const m = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd_micros),0) AS c, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
         FROM ai_calls WHERE created_at >= ?`,
      )
      .get(monthStart.toISOString()) as { n: number; c: number; i: number; o: number };
    const t = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd_micros),0) AS c FROM ai_calls WHERE created_at >= ?`)
      .get(today.toISOString()) as { n: number; c: number };
    const byModel = this.db
      .prepare(
        `SELECT model, COUNT(*) AS calls, SUM(cost_usd_micros) AS c, SUM(input_tokens) AS i, SUM(output_tokens) AS o
         FROM ai_calls WHERE created_at >= ? GROUP BY model ORDER BY c DESC`,
      )
      .all(monthStart.toISOString()) as { model: string; calls: number; c: number; i: number; o: number }[];
    const byAgent = this.db
      .prepare(`SELECT agent, COUNT(*) AS calls, SUM(cost_usd_micros) AS c FROM ai_calls WHERE created_at >= ? GROUP BY agent ORDER BY calls DESC`)
      .all(monthStart.toISOString()) as { agent: string; calls: number; c: number }[];
    const monthCost = m.c / 1_000_000;
    return {
      monthCostUsd: monthCost,
      monthCalls: m.n,
      monthInputTokens: m.i,
      monthOutputTokens: m.o,
      todayCostUsd: t.c / 1_000_000,
      todayCalls: t.n,
      budgetUsd: s.ai.monthlyBudgetUsd,
      budgetUsedPct: s.ai.monthlyBudgetUsd > 0 ? (monthCost / s.ai.monthlyBudgetUsd) * 100 : 0,
      budgetBlocked: s.ai.monthlyBudgetUsd > 0 && monthCost >= s.ai.monthlyBudgetUsd,
      byModel: byModel.map((r) => ({ model: r.model, calls: r.calls, costUsd: r.c / 1_000_000, inputTokens: r.i, outputTokens: r.o })),
      byAgent: byAgent.map((r) => ({ agent: r.agent, calls: r.calls, costUsd: r.c / 1_000_000 })),
    };
  }

  calls(limit = 200): AiCall[] {
    return (this.db.prepare(`SELECT * FROM ai_calls ORDER BY id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      agent: r.agent as string,
      taskType: r.task_type as string,
      model: r.model as string,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
      costUsd: (r.cost_usd_micros as number) / 1_000_000,
      latencyMs: r.latency_ms as number,
      success: !!r.success,
      error: (r.error as string) ?? null,
      simulated: !!r.simulated,
      createdAt: r.created_at as string,
    }));
  }

  async listModels(): Promise<string[]> {
    if (!this.provider) throw new AiDisabledError('Claude API er ikke konfigureret');
    return this.provider.listModels();
  }
}
