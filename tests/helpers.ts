import { createApp, type App, type AppOptions } from '../src/server/app';
import { MemorySecretStore } from '../src/server/secrets';
import { SimulatedSmsAdapter } from '../src/server/adapters/sms/simulator';
import { SimulatedTelegramAdapter } from '../src/server/adapters/telegram/simulator';
import { SimulatedMapsAdapter } from '../src/server/adapters/maps/simulator';
import type { LlmProvider } from '../src/server/adapters/ai/types';

export interface TestApp {
  app: App;
  sms: SimulatedSmsAdapter;
  tg: SimulatedTelegramAdapter;
  clock: { t: number };
  /** Spol uret frem og kør alle forfaldne jobs. */
  run(advanceMs?: number): Promise<void>;
  lastSmsTo(phone: string): string | undefined;
}

export async function makeApp(o: Partial<AppOptions> & { seed?: boolean; llm?: LlmProvider | null } = {}): Promise<TestApp> {
  const clock = { t: Date.now() };
  const sms = new SimulatedSmsAdapter();
  const tg = new SimulatedTelegramAdapter();
  const app = await createApp({
    mode: o.mode ?? 'demo',
    dbFile: ':memory:',
    backupDir: '/tmp/ai-dispatch-test-backups',
    secrets: new MemorySecretStore(),
    manualJobs: true,
    skipSeed: o.seed === false,
    now: () => clock.t,
    overrides: { sms, telegram: tg, maps: new SimulatedMapsAdapter(), llm: o.llm ?? null, ...(o.overrides ?? {}) },
  });
  await app.start();
  // Bot-simulatoren bruges ikke i tests – vi styrer alt eksplicit
  app.demo?.stop();
  return {
    app,
    sms,
    tg,
    clock,
    async run(advanceMs = 2000) {
      clock.t += advanceMs;
      for (let i = 0; i < 20; i++) {
        await app.ctx.jobs.drain();
        await new Promise((r) => setImmediate(r));
        if (app.ctx.jobs.tick() === 0) break;
      }
      await app.ctx.jobs.drain();
    },
    lastSmsTo(phone: string) {
      return [...sms.sentLog].reverse().find((m) => m.to === phone)?.text;
    },
  };
}

import type { Ctx } from '../src/server/context';
import type { StructuredRequest, StructuredResponse } from '../src/server/adapters/ai/types';

/** Deterministiske testdata (uafhængige af demo-seed). */
export function fixture(ctx: Ctx) {
  ctx.settings.update({
    company: { name: 'Test ApS', phone: '+4570000000' },
    installation: { automationEnabled: true },
    openingHours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '00:00', closed: false }])) as never,
    pricing: { deliveryFeeOre: 3900, freeDeliveryThresholdOre: 0, minimumOrderOre: 0 },
  });
  const rb = ctx.catalog.create({ sku: 'RB25', name: 'Red Bull', category: 'Energidrik', priceOre: 2500, synonyms: ['red bull', 'redbull'] });
  const chips = ctx.catalog.create({ sku: 'CHIPS', name: 'Kartoffelchips', category: 'Snacks', priceOre: 3000, synonyms: ['chips'] });
  const central = ctx.inventory.createLocation('Central', 'central', null, 55.6863, 12.561);
  ctx.inventory.adjust(central, rb.id, 100, 'start', 'system');
  ctx.inventory.adjust(central, chips.id, 100, 'start', 'system');
  const mk = (name: string, lat: number, lng: number) => {
    const d = ctx.drivers.create({ name, vehicleName: name });
    const uid = `sim-driver-${d.id}`;
    ctx.db.prepare(`UPDATE drivers SET telegram_user_id = ?, telegram_chat_id = ? WHERE id = ?`).run(uid, uid, d.id);
    ctx.drivers.setStatus(d.id, 'available');
    ctx.drivers.setPosition(d.id, lat, lng, 'demo');
    return ctx.drivers.get(d.id)!;
  };
  const a = mk('Anna', 55.68, 12.56);
  const b = mk('Bo', 55.7, 12.6);
  ctx.inventory.adjust(a.vehicleLocationId!, rb.id, 10, 'bil', 'system');
  return { rb, chips, central, a, b };
}

/** Falsk LLM-udbyder til tests – returnerer det, testen bestemmer. Ingen netværk. */
export class FakeLlm {
  readonly kind = 'claude' as const;
  calls: StructuredRequest<unknown>[] = [];
  constructor(public respond: (req: StructuredRequest<unknown>) => unknown | Error) {}
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const out = this.respond(req as StructuredRequest<unknown>);
    if (out instanceof Error) throw out;
    return { output: out as T, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: req.model, stopReason: 'end_turn', refused: false };
  }
  async listModels() {
    return ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  }
}

export function convFor(ctx: Ctx, phone: string) {
  return ctx.conversations.list().find((c) => c.customerPhone === phone)!;
}
