import fs from 'node:fs';
import { openDatabase, type Db } from './db/database';
import { AuditLog, Bus, EventLog, IntegrationRegistry, KvState, SettingsService } from './infra';
import { JobQueue } from './jobs/jobQueue';
import { CatalogService } from './services/catalog';
import { InventoryService } from './services/inventory';
import { ConversationService } from './services/conversations';
import { OrderService } from './services/orders';
import { DriverService } from './services/drivers';
import { MapsService } from './services/maps';
import { AiGateway } from './ai/gateway';
import {
  ClaudeCustomerInterpreter,
  ClaudeDriverInterpreter,
  RuleBasedCustomerInterpreter,
  RuleBasedDriverInterpreter,
  type CustomerInterpreter,
  type DriverInterpreter,
} from './ai/interpreters';
import { SmsGateway } from './gateways/smsGateway';
import { TelegramGateway } from './gateways/telegramGateway';
import { CustomerAgent } from './agents/customerAgent';
import { RoutingService } from './agents/routing';
import { DispatchAgent } from './agents/dispatchAgent';
import { DriverAgent } from './agents/driverAgent';
import { LogisticsAgent } from './agents/logisticsAgent';
import { AuthService, BackupService, RetentionService } from './maintenance';
import { seedDemo } from './demo/seed';
import { DemoSimulator } from './demo/simulator';
import { SimulatedSmsAdapter } from './adapters/sms/simulator';
import { ImsgRpcSmsAdapter } from './adapters/sms/imsgRpc';
import { SimulatedTelegramAdapter } from './adapters/telegram/simulator';
import { TelegramBotApiAdapter } from './adapters/telegram/botApi';
import { SimulatedMapsAdapter } from './adapters/maps/simulator';
import { GoogleMapsAdapter } from './adapters/maps/google';
import { ClaudeProvider } from './adapters/ai/claude';
import type { LlmProvider } from './adapters/ai/types';
import type { SmsAdapter } from './adapters/sms/types';
import type { TelegramAdapter } from './adapters/telegram/types';
import type { MapsAdapter } from './adapters/maps/types';
import type { SecretStore } from './secrets';
import type { Ctx } from './context';
import type { InstallationMode } from '../shared/types';

export interface AppOptions {
  mode: InstallationMode;
  dbFile: string;
  backupDir: string;
  secrets: SecretStore;
  /** Til tests: injicér adaptere i stedet for at bygge dem ud fra indstillinger. */
  overrides?: {
    sms?: SmsAdapter | null;
    telegram?: TelegramAdapter | null;
    maps?: MapsAdapter | null;
    llm?: LlmProvider | null;
  };
  /** Start ikke baggrundsjob/timere automatisk (tests). */
  manualJobs?: boolean;
  /** Demo: opret ikke demodata (tests). */
  skipSeed?: boolean;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Mulige placeringer af imsg (medfølgende kopi, Homebrew), hvis ingen sti er angivet. */
  imsgCandidates?: string[];
  /** Til tests: styr jobkøens ur. */
  now?: () => number;
}

export interface App {
  ctx: Ctx;
  mode: InstallationMode;
  agents: {
    customer: CustomerAgent;
    dispatch: DispatchAgent;
    driver: DriverAgent;
    logistics: LogisticsAgent;
    routing: RoutingService;
  };
  backup: BackupService;
  retention: RetentionService;
  auth: AuthService;
  demo: DemoSimulator | null;
  secrets: SecretStore;
  start(): Promise<void>;
  stop(): Promise<void>;
  reloadIntegrations(): Promise<void>;
}

export async function createApp(opts: AppOptions): Promise<App> {
  BackupService.applyPendingRestore(opts.dbFile);
  let preMigrateBackup: string | null = null;
  const db: Db = openDatabase({
    file: opts.dbFile,
    beforeMigrate: (d) => {
      // Backup før migration af en eksisterende database
      if (opts.dbFile !== ':memory:') {
        fs.mkdirSync(opts.backupDir, { recursive: true });
        preMigrateBackup = `${opts.backupDir}/pre-migration-${Date.now()}.sqlite`;
        d.exec(`VACUUM INTO '${preMigrateBackup.replace(/'/g, "''")}'`);
      }
    },
  });
  const bus = new Bus();
  bus.setMaxListeners(50);
  const settings = new SettingsService(db, bus, opts.mode);
  const events = new EventLog(db, bus);
  if (preMigrateBackup) events.log('info', 'system', 'pre_migration_backup', 'Backup taget før databaseopdatering');
  const integrations = new IntegrationRegistry(db, bus, events);
  const kv = new KvState(db);
  const audit = new AuditLog(db);
  const jobs = new JobQueue(db, events, { concurrency: 4, now: opts.now });
  const catalog = new CatalogService(db, bus);
  const inventory = new InventoryService(db, bus);
  const conversations = new ConversationService(db, bus, events, audit);
  const orders = new OrderService(db, bus, inventory, catalog, audit);
  const drivers = new DriverService(db, bus, inventory, audit);

  // Sørg for at installationstilstanden i databasen matcher den valgte database
  if (settings.get().installation.mode !== opts.mode) settings.update({ installation: { mode: opts.mode } });

  const isDemo = opts.mode === 'demo';
  const s0 = settings.get();

  const buildMaps = (): MapsAdapter | null => {
    if (opts.overrides && 'maps' in opts.overrides) return opts.overrides.maps ?? null;
    if (isDemo) return new SimulatedMapsAdapter({ lat: s0.delivery.centerLat, lng: s0.delivery.centerLng });
    const key = opts.secrets.get('google_maps_api_key');
    return key ? new GoogleMapsAdapter({ apiKey: key, region: settings.get().maps.region, language: settings.get().maps.language }) : null;
  };
  const buildLlm = (): LlmProvider | null => {
    if (opts.overrides && 'llm' in opts.overrides) return opts.overrides.llm ?? null;
    if (isDemo) return null;
    const key = opts.secrets.get('anthropic_api_key');
    return key ? new ClaudeProvider(key) : null;
  };
  const buildSms = (): SmsAdapter | null => {
    if (opts.overrides && 'sms' in opts.overrides) return opts.overrides.sms ?? null;
    if (isDemo) return new SimulatedSmsAdapter();
    const s = settings.get().sms;
    if (s.backend !== 'imsg') return null;
    const binaryPath = s.imsgPath || (opts.imsgCandidates ?? []).find((p) => fs.existsSync(p));
    if (!binaryPath) return null;
    return new ImsgRpcSmsAdapter({ binaryPath, region: s.region, service: s.service, log: opts.log });
  };
  const buildTelegram = (): TelegramAdapter | null => {
    if (opts.overrides && 'telegram' in opts.overrides) return opts.overrides.telegram ?? null;
    if (isDemo) return new SimulatedTelegramAdapter();
    const token = opts.secrets.get('telegram_bot_token');
    return token ? new TelegramBotApiAdapter({ token, log: opts.log }) : null;
  };

  let mapsAdapter = buildMaps();
  const maps = new MapsService(db, mapsAdapter, integrations, { geocodeTtlHours: s0.maps.cacheTtlHours, travelTtlMinutes: 10 });
  const llm = buildLlm();
  const ai = new AiGateway(db, bus, settings, events, integrations, llm);

  const ctx = {
    db,
    bus,
    settings,
    events,
    integrations,
    kv,
    audit,
    jobs,
    catalog,
    inventory,
    conversations,
    orders,
    drivers,
    maps,
    ai,
  } as Partial<Ctx> as Ctx;

  const customerInterpreter: CustomerInterpreter = isDemo
    ? new RuleBasedCustomerInterpreter(ai)
    : new ClaudeCustomerInterpreter(ai, () => settings.get().ai.escalateBelowConfidence);
  const driverInterpreter: DriverInterpreter = isDemo ? new RuleBasedDriverInterpreter(ai) : new ClaudeDriverInterpreter(ai);
  ctx.customerInterpreter = customerInterpreter;
  ctx.driverInterpreter = driverInterpreter;
  ctx.sms = new SmsGateway(db, bus, settings, conversations, jobs, events, integrations, kv);
  ctx.telegram = new TelegramGateway(db, bus, drivers, jobs, events, integrations, kv);

  const routing = new RoutingService(ctx);
  const customer = new CustomerAgent(ctx);
  const dispatch = new DispatchAgent(ctx, routing);
  const driver = new DriverAgent(ctx, dispatch, routing);
  const logistics = new LogisticsAgent(ctx, dispatch, routing);
  const backup = new BackupService(ctx, opts.dbFile, opts.backupDir);
  const retention = new RetentionService(ctx);
  const auth = new AuthService(ctx);

  if (isDemo && !opts.skipSeed) seedDemo(ctx);

  let smsAdapter = buildSms();
  let tgAdapter = buildTelegram();
  let demo: DemoSimulator | null = null;
  if (isDemo && smsAdapter instanceof SimulatedSmsAdapter && tgAdapter instanceof SimulatedTelegramAdapter) {
    demo = new DemoSimulator(ctx, smsAdapter, tgAdapter);
  }

  const setStaticStatuses = () => {
    if (isDemo) {
      integrations.set('maps', 'simulated', 'Simuleret kort (Demo Mode)', { simulated: true });
      integrations.set('ai', 'simulated', 'Regelbaseret demo-AI – ingen Claude API-kald', { simulated: true });
    } else {
      if (!mapsAdapter) integrations.set('maps', 'not_configured', 'Google Maps API-nøgle mangler');
      else if (integrations.get('maps')?.state !== 'ok') integrations.set('maps', 'degraded', 'Konfigureret – endnu ikke testet');
      if (!ai.configured) integrations.set('ai', 'not_configured', 'Claude API-nøgle mangler');
      else if (integrations.get('ai')?.state !== 'ok') integrations.set('ai', 'degraded', 'Konfigureret – endnu ikke testet');
    }
  };

  const app: App = {
    ctx,
    mode: opts.mode,
    agents: { customer, dispatch, driver, logistics, routing },
    backup,
    retention,
    auth,
    demo,
    secrets: opts.secrets,
    async start() {
      jobs.recoverAfterRestart();
      setStaticStatuses();
      await ctx.sms.start(smsAdapter);
      await ctx.telegram.start(tgAdapter);
      if (!opts.manualJobs) {
        logistics.start();
        backup.start();
        retention.start();
        jobs.start();
        demo?.start();
      }
      events.log('info', 'system', 'started', `AI Dispatch startet (${isDemo ? 'Demo Mode' : 'Produktion'})`);
    },
    async stop() {
      demo?.stop();
      await jobs.stop();
      await ctx.sms.stop();
      await ctx.telegram.stop();
      bus.dispose();
      db.close();
    },
    async reloadIntegrations() {
      if (isDemo) return;
      await ctx.sms.stop();
      await ctx.telegram.stop();
      smsAdapter = buildSms();
      tgAdapter = buildTelegram();
      mapsAdapter = buildMaps();
      maps.setAdapter(mapsAdapter);
      ai.setProvider(buildLlm());
      setStaticStatuses();
      await ctx.sms.start(smsAdapter);
      await ctx.telegram.start(tgAdapter);
    },
  };
  return app;
}
