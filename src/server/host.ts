import fs from 'node:fs';
import path from 'node:path';
import { createApp, type App } from './app';
import { createApi, type AppHost } from './api';
import type { SecretStore } from './secrets';
import type { InstallationMode, LiveTopic } from '../shared/types';

/**
 * Fælles værtslogik for Electron og dev-webserveren:
 * - Hver tilstand (demo/produktion) har sin EGEN database, så demodata aldrig
 *   blandes med rigtige data.
 * - Valgt tilstand gemmes i en lille konfigurationsfil i datamappen.
 */
export interface HostOptions {
  dataDir: string;
  secrets: SecretStore;
  version: string;
  platform: string;
  onLive: (topics: LiveTopic[]) => void;
  onRestartRequested: () => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  imsgCandidates?: string[];
}

interface HostConfig {
  mode: InstallationMode;
}

export class AppHostImpl implements AppHost {
  private current: App | null = null;
  readonly version: string;
  readonly platform: string;
  readonly dataDir: string;
  readonly api: ReturnType<typeof createApi>;

  constructor(private opts: HostOptions) {
    this.version = opts.version;
    this.platform = opts.platform;
    this.dataDir = opts.dataDir;
    this.api = createApi(this);
  }

  private configFile(): string {
    return path.join(this.opts.dataDir, 'config.json');
  }

  readConfig(): HostConfig {
    try {
      const c = JSON.parse(fs.readFileSync(this.configFile(), 'utf8')) as HostConfig;
      return { mode: c.mode === 'production' ? 'production' : 'demo' };
    } catch {
      return { mode: 'demo' };
    }
  }

  private writeConfig(c: HostConfig): void {
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    fs.writeFileSync(this.configFile(), JSON.stringify(c, null, 2));
  }

  async start(): Promise<void> {
    await this.boot(this.readConfig().mode);
  }

  private async boot(mode: InstallationMode): Promise<void> {
    const dir = path.join(this.opts.dataDir, mode);
    const app = await createApp({
      mode,
      dbFile: path.join(dir, `ai-dispatch-${mode}.sqlite`),
      backupDir: path.join(dir, 'backups'),
      secrets: this.opts.secrets,
      log: this.opts.log,
      imsgCandidates: this.opts.imsgCandidates,
    });
    app.ctx.bus.on('live', (topics: LiveTopic[]) => this.opts.onLive(topics));
    await app.start();
    this.current = app;
  }

  app(): App {
    if (!this.current) throw new Error('Programmet starter stadig…');
    return this.current;
  }

  async switchMode(mode: InstallationMode): Promise<void> {
    if (this.current?.mode === mode) return;
    const old = this.current;
    this.current = null;
    await old?.stop();
    this.writeConfig({ mode });
    await this.boot(mode);
    this.opts.onLive(['settings', 'orders', 'conversations', 'drivers', 'inventory', 'products', 'events', 'integrations', 'ai', 'logistics', 'demo']);
  }

  requestRestart(): void {
    this.opts.onRestartRequested();
  }

  async stop(): Promise<void> {
    await this.current?.stop();
    this.current = null;
  }

  /** Kald en API-metode. Fejl returneres som { error } så UI kan vise dem. */
  async invoke(method: string, params: unknown): Promise<{ result?: unknown; error?: string }> {
    const fn = this.api[method];
    if (!fn) return { error: `Ukendt metode: ${method}` };
    try {
      const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      return { result: await fn(p) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
