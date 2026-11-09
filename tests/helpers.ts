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
