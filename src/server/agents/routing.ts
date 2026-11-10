import type { Ctx } from '../context';
import type { LatLng } from '../../core/geo';
import { computeRouteEtas, etaCommunicable, historicalBias, type EtaAnchor, type StopEta } from '../../core/eta';
import { evaluateInsertions, optimizeSequence, orderValue, type InsertionResult, type OrderValue, type PlanningStop, type SequenceEvaluation } from '../../core/routePlanning';
import type { Driver } from '../../shared/types';
import type { TravelResult } from '../services/maps';
import type { CustomerNotifier } from './notifier';
import { DEFAULT_ADAPTIVE, nextLoadLevel, type LoadLevel } from '../../core/routePlanning';
import { clock } from '../clock';

export interface RouteStopRow {
  orderId: number;
  sequence: number;
  point: LatLng | null;
  status: string;
  promisedMs: number | null;
  extraDelayMs: number;
  /** Ordrens varer ligger ikke i bilen (reserveret på et lager) → kræver afhentning før levering. */
  needsPickup: boolean;
  stockLocationId: number | null;
  priority: number;
  value: OrderValue;
  previousEta: string | null;
}

export const ACTIVE_REPLENISHMENT = ['proposed', 'awaiting_management', 'approved', 'awaiting_driver', 'en_route', 'awaiting_pickup', 'picked_up'];
/** Statusser hvor chaufføren har accepteret lagerbesøget (tæller som sikker plan). */
export const ACCEPTED_REPLENISHMENT = ['en_route', 'awaiting_pickup', 'picked_up'];

export interface PlannedPickup {
  id: number;
  status: string;
  afterOrderId: number | null;
  locationId: number;
  point: LatLng | null;
  covers: number[];
}

export interface RefreshResult {
  etas: StopEta[];
  quality: TravelResult['quality'];
  notifiedOrderIds: number[];
}

/**
 * Ruteplanlægning uden live-GPS.
 *
 * - Rækkefølgen i `route_stops` er BINDENDE: den ændres kun ved en accepteret
 *   plan (tilbud), chaufførens egen melding eller en medarbejder.
 * - ETA'er genberegnes ud fra chaufførens anker (melding/levering/afgang),
 *   køretider fra kortadapteren, meldte forsinkelser og historisk tillæg.
 */
export const LOAD_LABELS: Record<LoadLevel, string> = { low: 'lav', medium: 'mellem', high: 'høj' };

export class RoutingService {
  constructor(
    private ctx: Ctx,
    private notifier: CustomerNotifier,
  ) {}

  // ---------------- Anker ----------------

  getAnchor(driverId: number): (EtaAnchor & { lat: number | null; lng: number | null }) | null {
    const r = this.ctx.db.prepare(`SELECT * FROM eta_anchors WHERE driver_id = ?`).get(driverId) as
      | { kind: EtaAnchor['kind']; at: string; reported_at: string; order_id: number | null; lat: number | null; lng: number | null }
      | undefined;
    if (!r) return null;
    return { kind: r.kind, atMs: new Date(r.at).getTime(), reportedAtMs: new Date(r.reported_at).getTime(), orderId: r.order_id, lat: r.lat, lng: r.lng };
  }

  setAnchor(driverId: number, a: { kind: EtaAnchor['kind']; atMs: number; orderId?: number | null; point?: LatLng | null; reportedAtMs?: number }): void {
    const prev = this.getAnchor(driverId);
    const point = a.point !== undefined ? a.point : prev ? (prev.lat != null ? { lat: prev.lat, lng: prev.lng! } : null) : null;
    this.ctx.db
      .prepare(
        `INSERT INTO eta_anchors (driver_id, kind, at, lat, lng, order_id, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(driver_id) DO UPDATE SET kind=excluded.kind, at=excluded.at, lat=excluded.lat, lng=excluded.lng,
           order_id=excluded.order_id, reported_at=excluded.reported_at`,
      )
      .run(driverId, a.kind, new Date(a.atMs).toISOString(), point?.lat ?? null, point?.lng ?? null, a.orderId ?? null, new Date(a.reportedAtMs ?? clock.now()).toISOString());
  }

  /** Markér at chaufføren netop har givet en frisk status (uden at ændre ankerets tid). */
  touchAnchor(driverId: number): void {
    this.ctx.db.prepare(`UPDATE eta_anchors SET reported_at = ? WHERE driver_id = ?`).run(clock.date().toISOString(), driverId);
  }

  /** Sørg for at chaufføren har et anker (afgang nu fra senest kendte stop / centrallager). */
  ensureAnchor(driver: Driver): EtaAnchor & { lat: number | null; lng: number | null } {
    const existing = this.getAnchor(driver.id);
    if (existing) return existing;
    const central = this.ctx.inventory.centralLocation();
    const point = driver.lastLat != null ? { lat: driver.lastLat, lng: driver.lastLng! } : central?.lat != null ? { lat: central.lat, lng: central.lng! } : null;
    this.setAnchor(driver.id, { kind: 'start', atMs: clock.now(), point });
    return this.getAnchor(driver.id)!;
  }

  // ---------------- Rute ----------------

  /** Bring route_stops i overensstemmelse med chaufførens tildelte ordrer (uden at omsortere). */
  syncStops(driverId: number): void {
    const { db } = this.ctx;
    db.transaction(() => {
      db.prepare(
        `DELETE FROM route_stops WHERE driver_id = ? AND order_id NOT IN (SELECT id FROM orders WHERE driver_id = ? AND status IN ('driver_assigned','out_for_delivery'))`,
      ).run(driverId, driverId);
      const missing = db
        .prepare(
          `SELECT id FROM orders WHERE driver_id = ? AND status IN ('driver_assigned','out_for_delivery') AND id NOT IN (SELECT order_id FROM route_stops WHERE driver_id = ?) ORDER BY id`,
        )
        .all(driverId, driverId) as { id: number }[];
      let max = (db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS m FROM route_stops WHERE driver_id = ?`).get(driverId) as { m: number }).m;
      for (const m of missing) db.prepare(`INSERT INTO route_stops (driver_id, order_id, sequence) VALUES (?, ?, ?)`).run(driverId, m.id, ++max);
      // Normalisér sekvens 1..n
      const rows = db.prepare(`SELECT order_id FROM route_stops WHERE driver_id = ? ORDER BY sequence`).all(driverId) as { order_id: number }[];
      rows.forEach((r, i) => db.prepare(`UPDATE route_stops SET sequence = ? WHERE driver_id = ? AND order_id = ?`).run(-(i + 1), driverId, r.order_id));
      db.prepare(`UPDATE route_stops SET sequence = -sequence WHERE driver_id = ?`).run(driverId);
    })();
  }

  stops(driverId: number): RouteStopRow[] {
    const { ctx } = this;
    this.syncStops(driverId);
    const vehicle = ctx.inventory.vehicleLocationForDriver(driverId);
    const margin = ctx.settings.get().economics.defaultMarginPct;
    const rows = ctx.db
      .prepare(
        `SELECT rs.order_id, rs.sequence, rs.extra_delay_s, o.address_lat, o.address_lng, o.status, o.eta_communicated, o.stock_location_id, o.delivery_fee_ore, o.eta, o.priority
         FROM route_stops rs JOIN orders o ON o.id = rs.order_id WHERE rs.driver_id = ? ORDER BY rs.sequence`,
      )
      .all(driverId) as Record<string, unknown>[];
    return rows.map((r) => ({
      orderId: r.order_id as number,
      sequence: r.sequence as number,
      point: r.address_lat != null ? { lat: r.address_lat as number, lng: r.address_lng as number } : null,
      status: r.status as string,
      promisedMs: r.eta_communicated ? new Date(r.eta_communicated as string).getTime() : null,
      extraDelayMs: ((r.extra_delay_s as number) ?? 0) * 1000,
      needsPickup: r.stock_location_id != null && r.stock_location_id !== vehicle,
      stockLocationId: (r.stock_location_id as number) ?? null,
      priority: (r.priority as number) ?? 0,
      value: this.valueOf(r.order_id as number, (r.delivery_fee_ore as number) ?? 0, margin),
      previousEta: (r.eta as string) ?? null,
    }));
  }

  valueOf(orderId: number, deliveryFeeOre: number, marginPct: number): OrderValue {
    const lines = this.ctx.db
      .prepare(`SELECT ol.quantity, ol.unit_price_ore, p.cost_ore FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ?`)
      .all(orderId) as { quantity: number; unit_price_ore: number; cost_ore: number | null }[];
    return orderValue(lines.map((l) => ({ quantity: l.quantity, unitPriceOre: l.unit_price_ore, costOre: l.cost_ore })), deliveryFeeOre, marginPct);
  }

  /** Skriv ny bindende rækkefølge og øg ruteversionen. */
  applySequence(driverId: number, sequence: number[], reason: string): void {
    const { db } = this.ctx;
    db.transaction(() => {
      const keepDelay = new Map(
        (db.prepare(`SELECT order_id, extra_delay_s FROM route_stops WHERE driver_id = ?`).all(driverId) as { order_id: number; extra_delay_s: number }[]).map((r) => [r.order_id, r.extra_delay_s]),
      );
      db.prepare(`DELETE FROM route_stops WHERE driver_id = ?`).run(driverId);
      const ins = db.prepare(`INSERT INTO route_stops (driver_id, order_id, sequence, extra_delay_s) VALUES (?, ?, ?, ?)`);
      sequence.forEach((id, i) => ins.run(driverId, id, i + 1, keepDelay.get(id) ?? 0));
      db.prepare(`UPDATE drivers SET route_version = route_version + 1 WHERE id = ?`).run(driverId);
    })();
    this.ctx.events.log('info', 'routing', 'route_changed', `Rute for chauffør #${driverId} ændret (${reason}): ${sequence.map((x) => '#' + x).join(' → ')}`);
    this.ctx.bus.touch('logistics', 'drivers');
  }

  /** Flyt et stop forrest (chaufførens egen melding om, hvor han kører hen). */
  moveToFront(driverId: number, orderId: number, reason: string): boolean {
    const seq = this.stops(driverId).map((s) => s.orderId);
    if (!seq.includes(orderId) || seq[0] === orderId) return false;
    this.applySequence(driverId, [orderId, ...seq.filter((x) => x !== orderId)], reason);
    return true;
  }

  addStopDelay(driverId: number, orderId: number, minutes: number): void {
    this.ctx.db.prepare(`UPDATE route_stops SET extra_delay_s = extra_delay_s + ? WHERE driver_id = ? AND order_id = ?`).run(Math.round(minutes * 60), driverId, orderId);
  }

  clearStopDelay(driverId: number, orderId: number): void {
    this.ctx.db.prepare(`UPDATE route_stops SET extra_delay_s = 0 WHERE driver_id = ? AND order_id = ?`).run(driverId, orderId);
  }

  // ---------------- Køretider ----------------

  /** Aktive lageropfyldninger for chaufføren (planlagte lagerbesøg). */
  plannedPickups(driverId: number): PlannedPickup[] {
    const rows = this.ctx.db
      .prepare(`SELECT id, status, after_order_id, location_id, covers_orders FROM replenishments WHERE driver_id = ? AND status IN (${ACTIVE_REPLENISHMENT.map((x) => `'${x}'`).join(',')})`)
      .all(driverId) as { id: number; status: string; after_order_id: number | null; location_id: number; covers_orders: string }[];
    return rows
      .filter((r) => r.status !== 'picked_up')
      .map((r) => {
        const loc = this.ctx.inventory.location(r.location_id);
        return {
          id: r.id,
          status: r.status,
          afterOrderId: r.after_order_id,
          locationId: r.location_id,
          point: loc?.lat != null ? { lat: loc.lat, lng: loc.lng! } : null,
          covers: JSON.parse(r.covers_orders) as number[],
        };
      });
  }

  /**
   * Køretidsfunktion over knuder: -1 = ankerpunkt, 0..n-1 = stop, n = ekstra (ny ordre).
   * - Planlagte lagerbesøg (opfyldninger) lægges ind før stoppet efter `afterOrderId`.
   * - Stop hvis varer ligger på et lager, og som ikke er dækket af en planlagt
   *   opfyldning, estimeres med en omvej via lageret (kun som estimat).
   */
  async travelFor(
    anchorPoint: LatLng | null,
    stops: { orderId?: number; point: LatLng | null; needsPickup: boolean; stockLocationId?: number | null }[],
    extra?: { orderId?: number; point: LatLng; needsPickup: boolean; stockLocationId?: number | null },
    pickups: PlannedPickup[] = [],
  ) {
    const { ctx } = this;
    const central = ctx.inventory.centralLocation();
    const centralPt = central?.lat != null ? { lat: central.lat, lng: central.lng! } : null;
    const all = [...stops, ...(extra ? [extra] : [])];
    const fallbackPt = all.find((s) => s.point)?.point ?? centralPt ?? { lat: 0, lng: 0 };
    const points: LatLng[] = [anchorPoint ?? centralPt ?? fallbackPt, ...all.map((s) => s.point ?? fallbackPt)];
    const locNode = new Map<number, number>();
    const nodeForLocation = (locationId: number | null | undefined, pt?: LatLng | null): number => {
      const id = locationId ?? central?.id ?? -1;
      if (locNode.has(id)) return locNode.get(id)!;
      const loc = id >= 0 ? ctx.inventory.location(id) : null;
      const p = pt ?? (loc?.lat != null ? { lat: loc.lat, lng: loc.lng! } : centralPt);
      if (!p) return -99;
      const node = points.push(p) - 1;
      locNode.set(id, node);
      return node;
    };
    // Planlagte lagerbesøg: før hvilket stop-indeks
    const explicit = new Map<number, number>();
    const covered = new Set<number>();
    for (const p of pickups) {
      const idx = p.afterOrderId == null ? 0 : stops.findIndex((x) => x.orderId === p.afterOrderId) + 1;
      if (idx < 0 || idx > stops.length) continue;
      explicit.set(idx, nodeForLocation(p.locationId, p.point));
      p.covers.forEach((c) => covered.add(c));
    }
    all.forEach((s) => {
      if (s.needsPickup && !(s.orderId && covered.has(s.orderId))) nodeForLocation(s.stockLocationId);
    });
    const m = await ctx.maps.matrix(points, points);
    const s = ctx.settings.get();
    const pickupS = s.replenishment.pickupMinutes * 60;
    const flat = m.flat();
    const quality: TravelResult['quality'] = flat.some((x) => x.quality === 'fallback') ? 'fallback' : flat.some((x) => x.quality === 'simulated') ? 'simulated' : 'live';
    const idx = (node: number) => node + 1; // -1 → 0
    const travel = (from: number, to: number): number => {
      const via = explicit.get(to);
      if (via !== undefined && via >= 0 && to < stops.length) return m[idx(from)][via].durationS + pickupS + m[via][idx(to)].durationS;
      const target = all[to];
      if (target?.needsPickup && !(target.orderId && covered.has(target.orderId)) && !(from >= 0 && all[from]?.needsPickup)) {
        const node = nodeForLocation(target.stockLocationId);
        if (node >= 0) return m[idx(from)][node].durationS + pickupS + m[node][idx(to)].durationS;
      }
      return m[idx(from)][idx(to)].durationS;
    };
    return { travel, quality, covered };
  }

  biasMinutes(): number {
    const rows = this.ctx.db
      .prepare(`SELECT eta_communicated, delivered_at FROM orders WHERE status = 'delivered' AND eta_communicated IS NOT NULL AND delivered_at IS NOT NULL ORDER BY id DESC LIMIT 50`)
      .all() as { eta_communicated: string; delivered_at: string }[];
    return historicalBias(
      rows.map((r) => ({ promisedMs: new Date(r.eta_communicated).getTime(), deliveredMs: new Date(r.delivered_at).getTime() })),
      this.ctx.settings.get().logistics.historicalBufferMaxMinutes,
    );
  }

  etaParams() {
    const l = this.ctx.settings.get().logistics;
    return { serviceMinutes: l.serviceMinutesPerStop, staleMinutes: l.statusStaleMinutes, biasMinutes: this.biasMinutes() };
  }

  /** Antal låste stop: det stop chaufføren har meldt han er på vej til / er ankommet til. */
  lockedCount(driver: Driver, stops: RouteStopRow[], anchor: EtaAnchor): number {
    if (!stops.length) return 0;
    if (anchor.kind === 'driver_report' && anchor.orderId === stops[0].orderId) return 1;
    if (driver.currentOrderId && driver.currentOrderId === stops[0].orderId) return 1;
    return 0;
  }

  // ---------------- Belastning (adaptiv strategi) ----------------

  /**
   * Aktuel belastning målt i kapacitet – ikke antal ordrer: timers planlagt
   * arbejde pr. aktiv chauffør (resterende rute frem til sidste stops ETA
   * + ventende ordrer uden chauffør). Niveauet skifter med hysterese.
   */
  loadState(): { value: number; level: LoadLevel; activeDrivers: number; waitingOrders: number; changedAt: number } {
    const { ctx } = this;
    const a = { ...DEFAULT_ADAPTIVE, ...(ctx.settings.get().economics.adaptive ?? {}) };
    const now = clock.now();
    const active = ctx.drivers.list().filter((d) => d.status === 'available' || d.status === 'busy');
    const lastEtas = new Map(
      (
        ctx.db
          .prepare(
            `SELECT rs.driver_id AS d, MAX(rs.eta) AS eta FROM route_stops rs JOIN orders o ON o.id = rs.order_id WHERE o.status IN ('driver_assigned','out_for_delivery') GROUP BY rs.driver_id`,
          )
          .all() as { d: number; eta: string | null }[]
      ).map((r) => [r.d, r.eta ? new Date(r.eta).getTime() : now]),
    );
    const backlog = active.reduce((sum, d) => sum + Math.max(0, ((lastEtas.get(d.id) ?? now) - now) / 60000), 0);
    const waiting = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('confirmed','awaiting_driver')`).get() as { c: number }).c;
    const value = active.length ? (backlog + waiting * a.minutesPerWaitingOrder) / (active.length * 60) : waiting ? 9 : 0;
    const prev = ctx.kv.get<{ level: LoadLevel; changedAt: number; switches: number }>('dispatch:load', { level: 'low', changedAt: 0, switches: 0 });
    const level = nextLoadLevel(prev.level, value, (now - prev.changedAt) / 60000, a);
    if (level !== prev.level) {
      ctx.kv.set('dispatch:load', { level, changedAt: now, switches: prev.switches + 1 });
      ctx.events.log('info', 'dispatch', 'load_level', `Belastning skiftet fra ${LOAD_LABELS[prev.level]} til ${LOAD_LABELS[level]} (${value.toFixed(2)} timers arbejde pr. aktiv chauffør)`, {
        data: { from: prev.level, to: level, value },
      });
      return { value, level, activeDrivers: active.length, waitingOrders: waiting, changedAt: now };
    }
    return { value, level, activeDrivers: active.length, waitingOrders: waiting, changedAt: prev.changedAt };
  }

  /** Planlagte minutter tilbage i chaufførens rute (til lastbalancering). */
  backlogMinutes(driverId: number): number {
    const r = this.ctx.db
      .prepare(`SELECT MAX(rs.eta) AS eta FROM route_stops rs JOIN orders o ON o.id = rs.order_id WHERE rs.driver_id = ? AND o.status IN ('driver_assigned','out_for_delivery')`)
      .get(driverId) as { eta: string | null };
    return r.eta ? Math.max(0, (new Date(r.eta).getTime() - clock.now()) / 60000) : 0;
  }

  // ---------------- Planlægning af ny ordre ----------------

  async planInsertion(
    driver: Driver,
    order: { id: number; point: LatLng; needsPickup: boolean; deliveryFeeOre: number; stockLocationId?: number | null; priority?: number },
    opts: { reassignment: boolean },
  ): Promise<InsertionResult[]> {
    const anchor = this.ensureAnchor(driver);
    const stops = this.stops(driver.id).filter((s) => s.orderId !== order.id);
    const anchorPt = anchor.lat != null ? { lat: anchor.lat, lng: anchor.lng! } : null;
    const { travel } = await this.travelFor(anchorPt, stops, { point: order.point, needsPickup: order.needsPickup, stockLocationId: order.stockLocationId }, this.plannedPickups(driver.id));
    const s = this.ctx.settings.get();
    const existing: PlanningStop[] = stops.map((x) => ({ orderId: x.orderId, promisedMs: x.promisedMs, extraDelayMs: x.extraDelayMs, value: x.value, priority: x.priority }));
    // Anker til planlægning: et afgangsanker i fortiden betyder at chaufføren allerede er undervejs
    const planAnchor = anchor.kind === 'start' && stops.length === 0 ? { ...anchor, atMs: Math.max(anchor.atMs, clock.now()), reportedAtMs: clock.now() } : anchor;
    return evaluateInsertions({
      nowMs: clock.now(),
      anchor: planAnchor,
      existing,
      lockedCount: this.lockedCount(driver, stops, anchor),
      newOrder: { orderId: order.id, value: this.valueOf(order.id, order.deliveryFeeOre, s.economics.defaultMarginPct), priority: order.priority ?? 0 },
      travel,
      eta: this.etaParams(),
      econ: s.economics,
      reassignment: opts.reassignment,
    });
  }

  /** Fælles planlægningsgrundlag for chaufførens nuværende rute. */
  private async routeContext(driver: Driver) {
    const anchor = this.ensureAnchor(driver);
    const stops = this.stops(driver.id);
    const anchorPt = anchor.lat != null ? { lat: anchor.lat, lng: anchor.lng! } : null;
    const { travel } = await this.travelFor(anchorPt, stops, undefined, this.plannedPickups(driver.id));
    const s = this.ctx.settings.get();
    const existing: PlanningStop[] = stops.map((x) => ({ orderId: x.orderId, promisedMs: x.promisedMs, extraDelayMs: x.extraDelayMs, value: x.value, priority: x.priority }));
    return { anchor, stops, travel, existing, econ: s.economics, eta: this.etaParams(), locked: this.lockedCount(driver, stops, anchor) };
  }

  /** "Find en bedre rute": bedste rækkefølge af de stop, der ikke er låst. */
  async optimizeRoute(driverId: number): Promise<{ current: SequenceEvaluation; best: SequenceEvaluation } | null> {
    const driver = this.ctx.drivers.get(driverId);
    if (!driver) return null;
    const c = await this.routeContext(driver);
    if (c.stops.length < 2) return null;
    return optimizeSequence({ nowMs: clock.now(), anchor: c.anchor, existing: c.existing, lockedCount: c.locked, travel: c.travel, eta: c.eta, econ: c.econ });
  }

  /**
   * Prioritér en ordre i chaufførens rute: tidligste placering, der ikke bryder
   * givne løfter for andre kunder. null = ikke muligt.
   */
  async prioritizePlan(driverId: number, orderId: number): Promise<InsertionResult | null> {
    const driver = this.ctx.drivers.get(driverId);
    if (!driver) return null;
    const stops = this.stops(driverId);
    const current = stops.findIndex((x) => x.orderId === orderId);
    if (current <= 0) return null;
    const o = this.ctx.orders.get(orderId)!;
    const results = await this.planInsertion(
      driver,
      { id: orderId, point: { lat: o.addressLat!, lng: o.addressLng! }, needsPickup: stops[current].needsPickup, stockLocationId: stops[current].stockLocationId, deliveryFeeOre: o.deliveryFeeOre, priority: 1 },
      { reassignment: false },
    );
    return results.filter((r) => r.feasible && r.insertIndex < current).sort((a, b) => a.insertIndex - b.insertIndex)[0] ?? null;
  }

  // ---------------- ETA-genberegning ----------------

  /**
   * Genberegn ETA'er for chaufførens bindende rute, gem dem, registrér
   * væsentlige ændringer i ordrehistorikken og opdatér berørte kunder.
   */
  async refreshEtas(driverId: number, reason = 'genberegning'): Promise<RefreshResult> {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId);
    const stops = this.stops(driverId);
    if (!driver || !stops.length) {
      ctx.bus.touch('logistics');
      return { etas: [], quality: 'live', notifiedOrderIds: [] };
    }
    const anchor = this.ensureAnchor(driver);
    const anchorPt = anchor.lat != null ? { lat: anchor.lat, lng: anchor.lng! } : null;
    const pickups = this.plannedPickups(driverId);
    const { travel, quality } = await this.travelFor(anchorPt, stops, undefined, pickups);
    // Stop der afhænger af en lageropfyldning, chaufføren endnu ikke har accepteret, er usikre
    const blockedBy = (orderId: number, needsPickup: boolean): string | null => {
      if (!needsPickup) return null;
      const p = pickups.find((x) => x.covers.includes(orderId));
      if (!p) return 'afventer lageropfyldning';
      if (ACCEPTED_REPLENISHMENT.includes(p.status)) return null;
      if (p.status === 'approved' || p.status === 'awaiting_driver') return 'afventer chaufførens accept af lagerbesøg';
      return 'afventer godkendelse af lageropfyldning';
    };
    const etas = computeRouteEtas(
      clock.now(),
      anchor,
      stops.map((s) => ({ orderId: s.orderId, extraDelayMs: s.extraDelayMs, blocked: blockedBy(s.orderId, s.needsPickup) })),
      (i) => travel(i === 0 ? -1 : i - 1, i),
      this.etaParams(),
    );
    const mode = ctx.settings.get().installation.mode;
    const notified: number[] = [];
    const now = clock.date().toISOString();
    ctx.db.transaction(() => {
      etas.forEach((e, i) => {
        const stop = stops[i];
        const etaIso = new Date(e.etaMs).toISOString();
        ctx.db
          .prepare(
            `UPDATE route_stops SET eta = ?, eta_low = ?, eta_high = ?, eta_basis = ?, confidence = ?, duration_from_prev_s = ?, computed_at = ? WHERE driver_id = ? AND order_id = ?`,
          )
          .run(etaIso, new Date(e.lowMs).toISOString(), new Date(e.highMs).toISOString(), e.basis, e.confidence, Math.round(e.driveSeconds), now, driverId, stop.orderId);
        const etaSource = e.confidence === 'low' ? 'estimate' : quality === 'live' ? 'route_live' : quality === 'simulated' ? 'route_simulated' : 'estimate';
        ctx.orders.updateFields(
          stop.orderId,
          { eta: etaIso, etaSource, etaLow: new Date(e.lowMs).toISOString(), etaHigh: new Date(e.highMs).toISOString(), etaConfidence: e.confidence },
          'system',
        );
        if (stop.previousEta && Math.abs(new Date(stop.previousEta).getTime() - e.etaMs) >= 2 * 60000) {
          ctx.orders.addEvent(stop.orderId, 'eta_changed', 'system', { from: stop.previousEta, to: etaIso, reason, basis: e.basis, confidence: e.confidence });
        }
        if (this.notifier.evaluate(stop.orderId, e.etaMs, etaCommunicable(e.confidence, quality, mode))) notified.push(stop.orderId);
      });
    })();
    ctx.bus.touch('logistics', 'orders');
    ctx.bus.emit('route_refreshed', { driverId });
    return { etas, quality, notifiedOrderIds: notified };
  }
}
