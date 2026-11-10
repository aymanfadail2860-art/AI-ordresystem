import type { App } from './app';
import { schemaVersion } from './db/database';
import { SECRET_NAMES, maskSecret, type SecretName } from './secrets';
import { startOfToday } from './services/orders';
import { demoScenarios } from './demo/simulator';
import { replenishmentScenario } from './demo/scenarios';
import type { DispatchStrategy, ManagementRole } from '../shared/types';
import { SimulationRunner } from './sim/runner';
import type {
  AiMode,
  DashboardStats,
  InstallationMode,
  OrderStatus,
  Settings,
} from '../shared/types';
import { AI_MODES, ORDER_STATUSES } from '../shared/types';
import type { DeepPartial } from './infra';
import { krToOre } from '../core/money';
import { clock } from './clock';

/** Værten (Electron main eller dev-webserver) leverer disse funktioner. */
export interface AppHost {
  app(): App;
  switchMode(mode: InstallationMode): Promise<void>;
  requestRestart(): void;
  version: string;
  platform: string;
  dataDir: string;
  /** Sti til den byggede simulerings-worker (null = ikke tilgængelig, fx i tests). */
  simWorkerPath?: string | null;
}

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

function num(v: unknown, name: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`Ugyldig værdi for ${name}`);
  return n;
}
function str(v: unknown, name: string, max = 2000): string {
  if (typeof v !== 'string') throw new Error(`Ugyldig værdi for ${name}`);
  if (v.length > max) throw new Error(`${name} er for lang`);
  return v;
}

/**
 * API-kontrakt mellem UI og backend. Alle metoder validerer input.
 * Følsomme handlinger kræver oplåsning med administrator-PIN.
 */
export function createApi(host: AppHost): Record<string, Handler> {
  const A = () => host.app();
  const C = () => host.app().ctx;
  const guard = () => A().auth.require();
  const sim = new SimulationRunner(() => host.app().ctx, host.simWorkerPath ?? null);
  const strategies = (v: unknown): DispatchStrategy[] | undefined =>
    Array.isArray(v) ? (v.filter((x) => ['fifo', 'shortest_detour', 'economic'].includes(String(x))) as DispatchStrategy[]) : undefined;

  const api: Record<string, Handler> = {
    // ---------------- System ----------------
    'system.info': () => {
      const app = A();
      return {
        mode: app.mode,
        version: host.version,
        platform: host.platform,
        dataDir: host.dataDir,
        schemaVersion: schemaVersion(app.ctx.db),
        jobs: app.ctx.jobs.stats(),
        secretsSecure: app.secrets.secure,
        setupCompleted: app.ctx.settings.get().installation.setupCompleted,
      };
    },
    'system.setMode': async (p) => {
      const mode = p.mode === 'production' ? 'production' : 'demo';
      if (mode === 'production') guard();
      A().ctx.audit.record('staff', 'switch_mode', 'system', mode);
      await host.switchMode(mode);
      return { ok: true };
    },
    'system.setAutomation': (p) => {
      const enabled = !!p.enabled;
      C().settings.update({ installation: { automationEnabled: enabled } });
      C().audit.record('staff', 'automation', 'system', String(enabled));
      C().events.log(enabled ? 'info' : 'warn', 'system', 'automation', enabled ? 'Automatik slået TIL' : 'Automatik slået FRA – ingen automatiske svar eller tildelinger');
      return { ok: true };
    },

    'dashboard.get': (): DashboardStats => {
      const c = C();
      const s = c.settings.get();
      const today = startOfToday();
      const q = (sql: string, ...args: unknown[]) => (c.db.prepare(sql).get(...args) as { n: number }).n;
      const ai = c.ai.summary();
      const drivers = c.drivers.list();
      return {
        activeOrders: q(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('confirmed','awaiting_driver','driver_assigned','out_for_delivery','needs_manual')`),
        ordersToday: q(`SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND status <> 'cancelled'`, today),
        deliveredToday: q(`SELECT COUNT(*) AS n FROM orders WHERE delivered_at >= ?`, today),
        pendingOrders: q(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('new_inquiry','awaiting_customer_info','awaiting_stock_check','awaiting_confirmation')`),
        delayedOrders: q(
          `SELECT COUNT(*) AS n FROM orders WHERE status IN ('driver_assigned','out_for_delivery') AND eta IS NOT NULL AND eta < ?`,
          new Date(clock.now() - 5 * 60000).toISOString(),
        ),
        needsManual: q(`SELECT COUNT(*) AS n FROM orders WHERE status = 'needs_manual' OR (needs_attention = 1 AND status NOT IN ('delivered','cancelled'))`),
        activeDrivers: drivers.filter((d) => d.activeOrderCount > 0).length,
        onlineDrivers: drivers.filter((d) => d.status !== 'offline').length,
        revenueTodayOre: (c.db.prepare(`SELECT COALESCE(SUM(total_ore),0) AS n FROM orders WHERE delivered_at >= ?`).get(today) as { n: number }).n,
        openAlerts: c.events.openActionCount(),
        conversationsNeedingAttention: c.conversations.needingAttentionCount(),
        aiCostTodayUsd: ai.todayCostUsd,
        aiCostMonthUsd: ai.monthCostUsd,
        aiBudgetUsedPct: ai.budgetUsedPct,
        integrations: c.integrations.list(),
        mode: s.installation.mode,
        automationEnabled: s.installation.automationEnabled,
      };
    },
    'dashboard.timeline': () => {
      const c = C();
      const rows = c.db
        .prepare(
          `SELECT strftime('%H', created_at, 'localtime') AS h, COUNT(*) AS n FROM orders WHERE created_at >= ? AND status <> 'cancelled' GROUP BY h ORDER BY h`,
        )
        .all(startOfToday()) as { h: string; n: number }[];
      return rows.map((r) => ({ hour: parseInt(r.h, 10), orders: r.n }));
    },

    // ---------------- Ordrer ----------------
    'orders.list': (p) => {
      const status = Array.isArray(p.status) ? (p.status.filter((x) => ORDER_STATUSES.includes(x as OrderStatus)) as OrderStatus[]) : undefined;
      return C().orders.list({ status, activeOnly: !!p.activeOnly, today: !!p.today, limit: p.limit ? num(p.limit, 'limit') : 300 });
    },
    'orders.get': (p) => {
      const c = C();
      const id = num(p.id, 'id');
      const order = c.orders.get(id);
      if (!order) throw new Error('Ordre findes ikke');
      return { order, events: c.orders.events(id), offers: c.drivers.offers(id), route: c.drivers.routeStops().filter((r) => r.orderId === id) };
    },
    'orders.transition': (p) => {
      const to = str(p.to, 'status') as OrderStatus;
      if (!ORDER_STATUSES.includes(to)) throw new Error('Ukendt status');
      const id = num(p.id, 'id');
      const o = C().orders.transition(id, to, 'staff', { reason: typeof p.reason === 'string' ? p.reason : 'manuel' });
      C().audit.record('staff', 'order_transition', 'order', id, { to });
      if (to === 'awaiting_driver') C().jobs.enqueue('dispatch_order', { orderId: id }, { dedupeKey: `dispatch:${id}`, lane: 'dispatch' });
      return o;
    },
    'orders.cancel': (p) => {
      const c = C();
      const id = num(p.id, 'id');
      const o = c.orders.get(id);
      const driverId = o?.driverId;
      const res = c.orders.cancel(id, typeof p.reason === 'string' && p.reason ? p.reason : 'Annulleret af medarbejder', 'staff');
      if (driverId) c.bus.emit('order_cancelled_for_driver', { orderId: id, driverId });
      if (p.notifyCustomer && o?.conversationId) {
        c.sms.queue(o.conversationId, `Din ordre #${id} er desværre annulleret. Kontakt os gerne, hvis du har spørgsmål.`, 'staff', `staff_cancel:${id}`, id);
      }
      return res;
    },
    'orders.assign': async (p) => {
      const app = A();
      const id = num(p.id, 'id');
      const driverId = num(p.driverId, 'driverId');
      const o = app.ctx.orders.get(id);
      if (!o) throw new Error('Ordre findes ikke');
      if (o.status === 'driver_assigned') await app.agents.dispatch.unassign(id, 'omfordelt af kontoret', 'staff');
      else if (o.status === 'confirmed') app.ctx.orders.transition(id, 'awaiting_driver', 'staff');
      else if (o.status === 'needs_manual') app.ctx.orders.transition(id, 'awaiting_driver', 'staff');
      await app.agents.dispatch.assign(id, driverId, 'staff');
      app.ctx.audit.record('staff', 'order_assign', 'order', id, { driverId });
      return app.ctx.orders.get(id);
    },
    'orders.redispatch': (p) => {
      const id = num(p.id, 'id');
      C().jobs.enqueue('dispatch_order', { orderId: id }, { dedupeKey: `dispatch:${id}`, lane: 'dispatch' });
      return { ok: true };
    },
    'orders.editLines': (p) => {
      const c = C();
      const id = num(p.id, 'id');
      if (!Array.isArray(p.lines)) throw new Error('Linjer mangler');
      const lines = p.lines.map((l) => ({ productId: num((l as Record<string, unknown>).productId, 'produkt'), quantity: num((l as Record<string, unknown>).quantity, 'antal') }));
      c.orders.staffEditLines(id, lines, c.settings.get().pricing);
      return c.orders.get(id);
    },
    'orders.updateFields': (p) => {
      const c = C();
      const id = num(p.id, 'id');
      const patch: Parameters<typeof c.orders.updateFields>[1] = {};
      if (typeof p.deliveryInstructions === 'string') patch.deliveryInstructions = p.deliveryInstructions.slice(0, 300);
      if (typeof p.paymentStatus === 'string' && ['pending', 'paid', 'not_applicable'].includes(p.paymentStatus)) patch.paymentStatus = p.paymentStatus;
      c.orders.updateFields(id, patch, 'staff');
      return c.orders.get(id);
    },
    'orders.setAddress': async (p) => {
      const c = C();
      const id = num(p.id, 'id');
      const address = str(p.address, 'adresse', 200);
      const geo = await c.maps.geocode(address);
      if (!geo.found) throw new Error('Adressen blev ikke fundet');
      c.orders.updateFields(id, { addressText: geo.formatted ?? address, addressLat: geo.lat!, addressLng: geo.lng!, addressValidated: !geo.approximate }, 'staff');
      return c.orders.get(id);
    },
    'orders.clearFlag': (p) => {
      C().orders.updateFields(num(p.id, 'id'), { needsAttention: false, attentionReason: null }, 'staff');
      return { ok: true };
    },

    // ---------------- Samtaler ----------------
    'conversations.list': () => C().conversations.list(),
    'conversations.get': (p) => {
      const c = C();
      const id = num(p.id, 'id');
      const conversation = c.conversations.get(id);
      if (!conversation) throw new Error('Samtale findes ikke');
      const orders = c.db.prepare(`SELECT id FROM orders WHERE conversation_id = ? ORDER BY id DESC LIMIT 10`).all(id) as { id: number }[];
      return {
        conversation,
        customer: c.conversations.customer(conversation.customerId),
        messages: c.conversations.messages(id, 300),
        orders: orders.map((o) => c.orders.get(o.id)!),
        smsCanObserveOutgoing: !!c.sms.current?.canObserveOutgoing,
      };
    },
    'conversations.setMode': (p) => {
      const mode = str(p.mode, 'tilstand') as AiMode;
      if (!AI_MODES.includes(mode)) throw new Error('Ukendt tilstand');
      C().conversations.setMode(num(p.id, 'id'), mode, typeof p.reason === 'string' && p.reason ? p.reason : 'Ændret af medarbejder', 'staff');
      return { ok: true };
    },
    'conversations.sendStaffMessage': (p) => {
      const c = C();
      const id = num(p.id, 'id');
      const text = str(p.text, 'tekst', 1000).trim();
      if (!text) throw new Error('Beskeden er tom');
      const conv = c.conversations.get(id);
      if (!conv) throw new Error('Samtale findes ikke');
      // En medarbejder der skriver, overtager samtalen (AI stopper)
      if (conv.aiMode === 'ai_active') c.conversations.setMode(id, 'manual', 'Medarbejder skrev i samtalen', 'staff');
      c.sms.queue(id, text, 'staff', `staff:${id}:${clock.now()}:${Math.random().toString(36).slice(2)}`);
      return { ok: true };
    },
    'conversations.markRead': (p) => {
      C().conversations.markRead(num(p.id, 'id'));
      return { ok: true };
    },
    'messages.resolveUncertain': (p) => {
      C().sms.resolveUncertain(num(p.id, 'id'), !!p.wasSent);
      C().audit.record('staff', 'resolve_uncertain', 'message', num(p.id, 'id'), { wasSent: !!p.wasSent });
      return { ok: true };
    },

    // ---------------- Chauffører ----------------
    'drivers.list': () => C().drivers.list(true),
    'drivers.get': (p) => {
      const c = C();
      const id = num(p.id, 'id');
      const driver = c.drivers.get(id);
      if (!driver) throw new Error('Chauffør findes ikke');
      return {
        driver,
        messages: c.drivers.messages(id),
        orders: c.orders.list({ driverId: id, limit: 30 }),
        stock: driver.vehicleLocationId ? c.inventory.levels().filter((l) => l.locationId === driver.vehicleLocationId) : [],
        route: c.drivers.routeStops(id),
      };
    },
    'drivers.create': (p) =>
      C().drivers.create({
        name: str(p.name, 'navn', 100),
        phone: typeof p.phone === 'string' ? p.phone : null,
        vehicleName: typeof p.vehicleName === 'string' ? p.vehicleName : null,
        maxActiveOrders: p.maxActiveOrders ? num(p.maxActiveOrders, 'maks') : 4,
      }),
    'drivers.update': (p) =>
      C().drivers.update(num(p.id, 'id'), {
        name: typeof p.name === 'string' ? p.name : undefined,
        phone: typeof p.phone === 'string' ? p.phone : undefined,
        vehicleName: typeof p.vehicleName === 'string' ? p.vehicleName : undefined,
        maxActiveOrders: p.maxActiveOrders ? num(p.maxActiveOrders, 'maks') : undefined,
        active: typeof p.active === 'boolean' ? p.active : undefined,
      }),
    'drivers.setStatus': (p) => {
      const st = str(p.status, 'status');
      if (!['offline', 'available', 'busy', 'break'].includes(st)) throw new Error('Ukendt status');
      C().drivers.setStatus(num(p.id, 'id'), st as 'offline', 'staff');
      return { ok: true };
    },
    'drivers.regenerateCode': (p) => ({ code: C().drivers.regenerateLinkCode(num(p.id, 'id')) }),
    'drivers.unlinkTelegram': (p) => {
      C().drivers.unlinkTelegram(num(p.id, 'id'));
      return { ok: true };
    },
    'drivers.sendMessage': (p) => {
      const id = num(p.id, 'id');
      C().telegram.sendToDriver(id, str(p.text, 'tekst', 1000), `staff_tg:${id}:${clock.now()}`);
      return { ok: true };
    },

    // ---------------- Logistik ----------------
    'logistics.overview': () => {
      const app = A();
      const c = app.ctx;
      const s = c.settings.get();
      const today = startOfToday();
      const margin = s.economics.defaultMarginPct;
      const allStops = c.drivers.routeStops();
      const orders = c.orders.list({ activeOnly: true });
      const byId = new Map(orders.map((o) => [o.id, o]));
      const drivers = c.drivers.list().map((d) => {
        const stops = allStops.filter((x) => x.driverId === d.id);
        const delivered = c.db
          .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_ore),0) AS rev, MIN(confirmed_at) AS first FROM orders WHERE driver_id = ? AND delivered_at >= ?`)
          .get(d.id, today) as { n: number; rev: number; first: string | null };
        const hours = delivered.first ? Math.max(0.5, (clock.now() - new Date(delivered.first).getTime()) / 3600000) : 0;
        const planned = stops.map((x) => {
          const o = byId.get(x.orderId);
          return o ? app.agents.routing.valueOf(o.id, o.deliveryFeeOre, margin) : { revenueOre: 0, contributionOre: 0, contributionEstimated: false };
        });
        const anchor = app.agents.routing.getAnchor(d.id);
        const lastInfo = Math.max(anchor?.reportedAtMs ?? 0, d.lastStatusAt ? new Date(d.lastStatusAt).getTime() : 0);
        const statusAgeMin = lastInfo ? Math.round((clock.now() - lastInfo) / 60000) : null;
        return {
          driver: d,
          stops: stops.map((x, i) => ({ ...x, totalOre: byId.get(x.orderId)?.totalOre ?? 0, contributionOre: planned[i].contributionOre })),
          statusAgeMin,
          statusStale: stops.length > 0 && (statusAgeMin === null || statusAgeMin > s.logistics.statusStaleMinutes),
          anchorKind: anchor?.kind ?? null,
          deliveredToday: delivered.n,
          revenueTodayOre: delivered.rev,
          deliveriesPerHour: hours ? Math.round((delivered.n / hours) * 10) / 10 : 0,
          plannedRevenueOre: planned.reduce((a, x) => a + x.revenueOre, 0),
          plannedContributionOre: planned.reduce((a, x) => a + x.contributionOre, 0),
          contributionEstimated: planned.some((x) => x.contributionEstimated),
          extraCapacity: !!d.extraCapacityUntil && new Date(d.extraCapacityUntil).getTime() > clock.now(),
        };
      });
      const deliveredAll = c.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_ore),0) AS rev, MIN(confirmed_at) AS first FROM orders WHERE delivered_at >= ?`).get(today) as {
        n: number;
        rev: number;
        first: string | null;
      };
      const hoursAll = deliveredAll.first ? Math.max(0.5, (clock.now() - new Date(deliveredAll.first).getTime()) / 3600000) : 0;
      return {
        drivers,
        orders,
        offers: c.drivers.offers(),
        suggestions: c.drivers.suggestions(true),
        central: c.inventory.centralLocation(),
        area: { lat: s.delivery.centerLat, lng: s.delivery.centerLng, radiusKm: s.delivery.radiusKm },
        mapsSimulated: c.maps.simulated,
        totals: {
          deliveredToday: deliveredAll.n,
          revenueTodayOre: deliveredAll.rev,
          deliveriesPerHour: hoursAll ? Math.round((deliveredAll.n / hoursAll) * 10) / 10 : 0,
          plannedRevenueOre: drivers.reduce((a, d) => a + d.plannedRevenueOre, 0),
          awaitingDriver: orders.filter((o) => o.status === 'awaiting_driver').length,
        },
        statusStaleMinutes: s.logistics.statusStaleMinutes,
      };
    },
    'logistics.applySuggestion': async (p) => {
      await A().agents.dispatch.applySuggestion(num(p.id, 'id'));
      return { ok: true };
    },
    'logistics.dismissSuggestion': (p) => {
      C().db.prepare(`UPDATE reassignment_suggestions SET status = 'dismissed' WHERE id = ?`).run(num(p.id, 'id'));
      C().bus.touch('logistics');
      return { ok: true };
    },
    'logistics.recompute': async () => {
      const app = A();
      for (const d of app.ctx.drivers.list()) if (d.activeOrderCount > 0) await app.agents.routing.refreshEtas(d.id, 'manuel genberegning');
      return { ok: true };
    },

    // ---------------- Produkter og lager ----------------
    'products.list': () => C().catalog.list({ includeInactive: true }),
    'products.save': (p) => {
      const input = {
        sku: str(p.sku, 'SKU', 40),
        name: str(p.name, 'navn', 100),
        category: typeof p.category === 'string' ? p.category : 'Andet',
        variant: typeof p.variant === 'string' && p.variant ? p.variant : null,
        priceOre: p.priceKr !== undefined ? krToOre(num(p.priceKr, 'pris')) : num(p.priceOre, 'pris'),
        costOre: p.costKr === undefined || p.costKr === null || p.costKr === '' ? null : krToOre(num(p.costKr, 'vareomkostning')),
        active: p.active !== false,
        description: typeof p.description === 'string' && p.description ? p.description : null,
        synonyms: Array.isArray(p.synonyms) ? p.synonyms.filter((x): x is string => typeof x === 'string') : [],
      };
      const res = p.id ? C().catalog.update(num(p.id, 'id'), input) : C().catalog.create(input);
      C().audit.record('staff', p.id ? 'product_update' : 'product_create', 'product', res.id, { priceOre: res.priceOre });
      return res;
    },
    'products.setActive': (p) => {
      C().catalog.setActive(num(p.id, 'id'), !!p.active);
      return { ok: true };
    },
    'inventory.overview': () => {
      const c = C();
      return { locations: c.inventory.locations(true), levels: c.inventory.levels(), products: c.catalog.list({ includeInactive: true }) };
    },
    'inventory.adjust': (p) => {
      C().inventory.adjust(num(p.locationId, 'lokation'), num(p.productId, 'produkt'), num(p.delta, 'antal'), typeof p.note === 'string' ? p.note : 'Manuel regulering');
      return { ok: true };
    },
    'inventory.transfer': (p) => {
      C().inventory.transfer(num(p.fromId, 'fra'), num(p.toId, 'til'), num(p.productId, 'produkt'), num(p.quantity, 'antal'));
      return { ok: true };
    },
    'inventory.movements': () => C().inventory.movements(300),
    'inventory.createLocation': (p) => ({ id: C().inventory.createLocation(str(p.name, 'navn', 100), 'central', null) }),

    // ---------------- AI ----------------
    'ai.summary': () => C().ai.summary(),
    'ai.calls': () => C().ai.calls(200),
    'ai.listModels': async () => {
      guard();
      return C().ai.listModels();
    },

    // ---------------- Hændelser ----------------
    'events.list': (p) => C().events.list({ onlyOpen: !!p.onlyOpen, limit: p.limit ? num(p.limit, 'limit') : 200 }),
    'events.ack': (p) => {
      C().events.acknowledge(num(p.id, 'id'));
      return { ok: true };
    },
    'events.ackAll': () => {
      C().db.prepare(`UPDATE events SET acknowledged_at = ? WHERE acknowledged_at IS NULL`).run(clock.date().toISOString());
      C().bus.touch('events');
      return { ok: true };
    },

    // ---------------- Indstillinger og nøgler ----------------
    'settings.get': () => C().settings.get(),
    'settings.update': async (p) => {
      const patch = (p.patch ?? {}) as DeepPartial<Settings>;
      const sensitive = ['ai', 'sms', 'telegram', 'maps', 'retention', 'backup', 'installation', 'pricing', 'economics'];
      if (Object.keys(patch).some((k) => sensitive.includes(k))) guard();
      if (patch.installation && 'mode' in patch.installation) delete (patch.installation as Record<string, unknown>).mode;
      const res = C().settings.update(patch);
      C().audit.record('staff', 'settings_update', 'settings', Object.keys(patch).join(','));
      if (patch.sms || patch.maps) await A().reloadIntegrations();
      if (patch.demo) A().demo?.applyTrafficSetting();
      return res;
    },
    'secrets.status': () => {
      const app = A();
      return {
        secure: app.secrets.secure,
        keys: Object.fromEntries(SECRET_NAMES.map((n) => [n, maskSecret(app.secrets.get(n))])),
      };
    },
    'secrets.set': async (p) => {
      guard();
      const name = str(p.name, 'navn') as SecretName;
      if (!SECRET_NAMES.includes(name)) throw new Error('Ukendt nøgle');
      const value = str(p.value, 'værdi', 500).trim();
      if (!value) throw new Error('Nøglen er tom');
      A().secrets.set(name, value);
      C().audit.record('staff', 'secret_set', 'secret', name);
      await A().reloadIntegrations();
      return { ok: true };
    },
    'secrets.delete': async (p) => {
      guard();
      const name = str(p.name, 'navn') as SecretName;
      if (!SECRET_NAMES.includes(name)) throw new Error('Ukendt nøgle');
      A().secrets.delete(name);
      C().audit.record('staff', 'secret_delete', 'secret', name);
      await A().reloadIntegrations();
      return { ok: true };
    },
    'integrations.list': () => C().integrations.list(),
    'integrations.test': async (p) => {
      const app = A();
      const c = app.ctx;
      const name = str(p.name, 'integration');
      if (name === 'ai') {
        if (app.mode === 'demo') return { ok: true, message: 'Demo Mode bruger regelbaseret AI – ingen API-kald' };
        try {
          const models = await c.ai.listModels();
          const wanted = Object.values(c.settings.get().ai.routing);
          const missing = wanted.filter((m) => !models.includes(m));
          c.integrations.set('ai', missing.length ? 'degraded' : 'ok', missing.length ? `Modeller ikke tilgængelige: ${missing.join(', ')}` : `${models.length} modeller tilgængelige`);
          return { ok: !missing.length, message: missing.length ? `Disse modeller er ikke tilgængelige for nøglen: ${missing.join(', ')}` : `Forbundet. ${models.length} modeller tilgængelige.` };
        } catch (e) {
          c.integrations.set('ai', 'error', (e as Error).message);
          return { ok: false, message: (e as Error).message };
        }
      }
      if (name === 'maps') {
        try {
          const g = await c.maps.geocode('Rådhuspladsen 1, 1550 København V');
          return { ok: g.found, message: g.found ? `Geokodning virker${c.maps.simulated ? ' (simuleret)' : ''}` : 'Testadresse ikke fundet' };
        } catch (e) {
          return { ok: false, message: (e as Error).message };
        }
      }
      const st = c.integrations.get(name as 'sms');
      return { ok: !!st && ['ok', 'simulated'].includes(st.state), message: st?.message ?? 'Ikke konfigureret' };
    },
    'integrations.reload': async () => {
      guard();
      await A().reloadIntegrations();
      return { ok: true };
    },

    // ---------------- Adgang ----------------
    'auth.status': () => ({ hasPin: A().auth.hasPin(), unlocked: A().auth.isUnlocked() }),
    'auth.unlock': (p) => ({ ok: A().auth.unlock(str(p.pin, 'PIN', 20)) }),
    'auth.lock': () => {
      A().auth.lock();
      return { ok: true };
    },
    'auth.setPin': (p) => {
      A().auth.setPin(str(p.pin, 'PIN', 20), typeof p.currentPin === 'string' ? p.currentPin : undefined);
      return { ok: true };
    },

    // ---------------- Backup og GDPR ----------------
    'backup.list': () => A().backup.list(),
    'backup.create': async () => {
      guard();
      return A().backup.create('manual');
    },
    'backup.restore': async (p) => {
      guard();
      await A().backup.scheduleRestore(str(p.file, 'fil', 200));
      host.requestRestart();
      return { ok: true, restartRequired: true };
    },
    'gdpr.searchCustomers': (p) => {
      const q = `%${str(p.query ?? '', 'søgning', 50)}%`;
      return C().db.prepare(`SELECT id, phone, name, created_at AS createdAt FROM customers WHERE phone LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 50`).all(q, q);
    },
    'gdpr.exportCustomer': (p) => {
      guard();
      return A().retention.exportCustomer(num(p.id, 'id'));
    },
    'gdpr.anonymizeCustomer': (p) => {
      guard();
      A().retention.anonymizeCustomer(num(p.id, 'id'), 'staff');
      return { ok: true };
    },
    'retention.run': () => {
      guard();
      return A().retention.run();
    },
    'audit.list': () => {
      guard();
      return C().audit.list(300);
    },

    // ---------------- Opsætning ----------------
    'setup.complete': () => {
      guard();
      C().settings.update({ installation: { setupCompleted: true } });
      C().audit.record('staff', 'setup_completed');
      return { ok: true };
    },

    // ---------------- Ledelsescenter ----------------
    'management.overview': () => {
      const app = A();
      return {
        users: app.management.users(),
        commands: app.management.commands(200),
        messages: app.management.messages(150),
        pendingConfirmations: app.management.commands(200).filter((x) => x.decision === 'needs_confirmation'),
        settings: app.ctx.settings.get().management,
      };
    },
    'management.createUser': (p) => {
      guard();
      const role = str(p.role, 'rolle') as ManagementRole;
      return A().management.createUser(str(p.name, 'navn', 100), role, 'staff');
    },
    'management.updateUser': (p) => {
      guard();
      return A().management.updateUser(num(p.id, 'id'), { role: typeof p.role === 'string' ? (p.role as ManagementRole) : undefined, active: typeof p.active === 'boolean' ? p.active : undefined }, 'staff');
    },
    'management.regenerateCode': (p) => {
      guard();
      return { code: A().management.regenerateCode(num(p.id, 'id'), 'staff') };
    },
    'management.setGroup': (p) => {
      guard();
      C().settings.update({ management: { groupChatId: str(p.groupChatId ?? '', 'chat-ID', 64).trim(), allowPrivateChats: !!p.allowPrivateChats } });
      C().audit.record('staff', 'management_group', 'settings', String(p.groupChatId));
      return { ok: true };
    },

    // ---------------- Lageropfyldning ----------------
    'replenishment.overview': () => {
      const app = A();
      const c = app.ctx;
      const forecasts = c.drivers
        .list()
        .filter((d) => d.vehicleLocationId)
        .map((d) => {
          const f = app.agents.replenishment.forecast(d.id);
          return { driverId: f.driverId, driverName: f.driverName, vehicleLocationId: f.vehicleLocationId, start: f.start, stops: f.stops, shortages: f.shortages, activeReplenishmentId: f.activeReplenishmentId };
        });
      const reps = app.agents.replenishment.list({ limit: 100 });
      return {
        forecasts,
        active: reps.filter((r) => !['completed', 'rejected', 'cancelled', 'expired'].includes(r.status)),
        history: reps.filter((r) => ['completed', 'rejected', 'cancelled', 'expired'].includes(r.status)),
        locations: c.inventory.locations(),
        levels: c.inventory.levels(),
        products: c.catalog.list({ includeInactive: true }),
      };
    },
    'replenishment.events': (p) => A().agents.replenishment.events(num(p.id, 'id')),
    'replenishment.approve': (p) => ({ message: A().agents.replenishment.approve(num(p.id, 'id'), { name: 'Kontoret (kontrolpanel)', source: 'staff' }) }),
    'replenishment.reject': async (p) => ({
      message: await A().agents.replenishment.reject(num(p.id, 'id'), { name: 'Kontoret (kontrolpanel)', source: 'staff' }, typeof p.reason === 'string' && p.reason ? p.reason : 'Afvist i kontrolpanelet'),
    }),
    'replenishment.cancel': (p) => ({ message: A().agents.replenishment.cancel(num(p.id, 'id'), 'staff', 'Annulleret i kontrolpanelet') }),
    'replenishment.recompute': async (p) => {
      await A().agents.replenishment.evaluate(num(p.driverId, 'chauffør'), 'manuel genberegning');
      return { ok: true };
    },

    // ---------------- Demo ----------------
    'demo.status': () => {
      const app = A();
      return { enabled: !!app.demo, ...(app.demo?.status() ?? { activeBots: 0, autoTraffic: false }), scenarios: demoScenarios().map((s) => ({ id: s.id, title: s.title })) };
    },
    'demo.startScenario': (p) => {
      const d = demoOnly(A());
      return { phone: d.startScenario(typeof p.id === 'string' ? p.id : undefined) };
    },
    'demo.sendAsCustomer': (p) => {
      demoOnly(A()).sendAsCustomer(str(p.phone, 'nummer', 20), str(p.text, 'tekst', 1000));
      return { ok: true };
    },
    'demo.sendAsStaffFromPhone': (p) => {
      demoOnly(A()).sendAsStaffFromPhone(str(p.phone, 'nummer', 20), str(p.text, 'tekst', 1000));
      return { ok: true };
    },
    'demo.sendAsDriver': (p) => {
      demoOnly(A()).sendAsDriver(num(p.driverId, 'chauffør'), str(p.text, 'tekst', 1000));
      return { ok: true };
    },
    'demo.sendAsManager': (p) => {
      const app = A();
      demoOnly(app);
      const who = str(p.who, 'bruger');
      const u = app.management.users().find((x) => x.telegramUserId === who);
      if (!u) throw new Error('Ukendt demo-leder');
      const group = app.ctx.settings.get().management.groupChatId;
      const tg = app.ctx.telegram.current as unknown as { injectGroupText(c: string, u: string, n: string, t: string): void; injectGroupCallback(c: string, u: string, n: string, d: string): void };
      if (typeof p.data === 'string') tg.injectGroupCallback(group, who, u.name, p.data);
      else tg.injectGroupText(group, who, u.name, str(p.text, 'tekst', 1000));
      return { ok: true };
    },
    'demo.replenishmentScenario': async () => {
      demoOnly(A());
      return replenishmentScenario(A());
    },
    // ---------------- Drift: rapporter, overvågning, simulering ----------------
    'operations.overview': () => {
      const app = A();
      return {
        integrations: app.ctx.integrations.list(),
        mode: app.mode,
        openAlerts: app.agents.monitor.list({ status: ['open', 'acknowledged'] }),
        criticalEvents: app.ctx.events.list({ minLevel: 'error', limit: 50 }),
        lastReport: app.agents.reports.list(1)[0] ?? null,
        settings: { monitoring: app.ctx.settings.get().monitoring, hourlyReports: app.ctx.settings.get().management.hourlyReports, groupConfigured: !!app.ctx.settings.get().management.groupChatId },
      };
    },
    'reports.list': (p) => A().agents.reports.list(p.limit ? num(p.limit, 'limit') : 100),
    'reports.preview': () => A().agents.reports.preview(),
    'reports.sendNow': () => {
      const app = A();
      const chat = app.ctx.settings.get().management.groupChatId;
      if (!chat) throw new Error('Ledelsesgruppen er ikke konfigureret (Ledelsescenter → Ledere og rettigheder)');
      const r = app.agents.reports.sendOnDemand(chat, 'kontrolpanel');
      app.ctx.audit.record('staff', 'report_send', 'report', r.id);
      return r;
    },
    'monitoring.alerts': (p) => A().agents.monitor.list({ status: Array.isArray(p.status) ? (p.status as never) : undefined, limit: 300 }),
    'monitoring.decisions': (p) => A().agents.monitor.decisions(p.alertId ? num(p.alertId, 'alertId') : undefined),
    'monitoring.acknowledge': (p) => {
      A().agents.monitor.acknowledge(num(p.id, 'id'), 'kontrolpanel');
      return { ok: true };
    },
    'monitoring.evaluate': async () => A().agents.monitor.evaluate(),
    'simulation.status': () => sim.status(),
    'simulation.list': () => ({ status: sim.status(), groups: sim.comparisons() }),
    'simulation.run': (p) =>
      sim.start({
        seed: Math.trunc(num(p.seed ?? 42, 'seed')),
        orders: Math.trunc(num(p.orders ?? 300, 'orders')),
        drivers: Math.trunc(num(p.drivers ?? 8, 'drivers')),
        strategies: strategies(p.strategies),
      }),
    'demo.telegramOutage': (p) => {
      const d = demoOnly(A());
      d.setTelegramOutage(!!p.on);
      return { on: d.telegramOutage };
    },
    'demo.setAutoTraffic': (p) => {
      demoOnly(A());
      C().settings.update({ demo: { autoTraffic: !!p.enabled } });
      A().demo!.applyTrafficSetting();
      return { ok: true };
    },
  };
  return api;
}

function demoOnly(app: App) {
  if (app.mode !== 'demo' || !app.demo) throw new Error('Kun tilgængelig i Demo Mode');
  return app.demo;
}
