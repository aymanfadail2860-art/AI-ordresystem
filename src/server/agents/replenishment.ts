import type { Ctx } from '../context';
import type { RoutingService, RouteStopRow } from './routing';
import { ACTIVE_REPLENISHMENT } from './routing';
import { evaluateReplenishmentOptions, forecastVehicleStock, type Qty, type ReplenishmentOptionResult } from '../../core/replenishment';
import { formatTime } from './replies';
import { InsufficientStockError } from '../services/inventory';
import { parseJson } from '../db/database';
import type { Replenishment, ReplenishmentOption, ReplenishmentStatus, StockForecast } from '../../shared/types';
import { REPLENISHMENT_STATUS_LABELS } from '../../shared/types';
import type { TelegramButton } from '../adapters/telegram/types';

/** Gyldige statusskift for en lageropfyldning. */
const TRANSITIONS: Record<ReplenishmentStatus, ReplenishmentStatus[]> = {
  proposed: ['awaiting_management', 'cancelled'],
  awaiting_management: ['approved', 'rejected', 'cancelled', 'expired', 'awaiting_management'],
  approved: ['awaiting_driver', 'cancelled', 'awaiting_management'],
  awaiting_driver: ['en_route', 'rejected', 'cancelled', 'awaiting_management'],
  en_route: ['awaiting_pickup', 'picked_up', 'cancelled'],
  awaiting_pickup: ['picked_up', 'cancelled'],
  picked_up: ['completed'],
  completed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

export interface Approver {
  name: string;
  source: 'telegram' | 'staff';
}

interface Row {
  id: number;
  driver_id: number;
  location_id: number;
  status: ReplenishmentStatus;
  after_order_id: number | null;
  items: string;
  covers_orders: string;
  analysis: string | null;
  deadline_at: string | null;
  sent_at: string | null;
  reminder_sent_at: string | null;
  escalated_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_reason: string | null;
  driver_accepted_at: string | null;
  picked_up_at: string | null;
  completed_at: string | null;
  created_at: string;
}

/**
 * Proaktiv lageropfyldning af chaufførernes biler.
 *
 * - Prognose: lager efter hvert planlagt stop (deterministisk).
 * - Ved forventet underskud: vurdér alle opfyldningspunkter og lagerlokationer
 *   økonomisk og send et forslag til ledelsen (aldrig auto-godkendt).
 * - Statusflow: foreslået → afventer ledelse → godkendt → afventer chauffør →
 *   på vej til lager → afventer afhentning → afhentning bekræftet → afsluttet.
 * - Bilens lager øges FØRST ved bekræftet fysisk afhentning.
 * - Påmindelse og eskalering før sidste sikre opfyldningspunkt.
 */
export class ReplenishmentService {
  /** Sættes efter konstruktion (undgår cirkulær afhængighed). */
  onUncoverable: ((orderIds: number[], driverId: number) => Promise<void>) | null = null;

  constructor(
    private ctx: Ctx,
    private routing: RoutingService,
  ) {
    ctx.jobs.register('replenishment_check', async (job) => {
      await this.evaluate(job.payload.driverId as number, (job.payload.reason as string) ?? 'genberegning');
    });
    ctx.jobs.register('replenishment_tick', async () => {
      try {
        await this.tick();
      } finally {
        ctx.jobs.enqueue('replenishment_tick', {}, { delayMs: 60_000, dedupeKey: 'replenishment_tick' });
      }
    });
    ctx.bus.on('route_refreshed', ({ driverId }: { driverId: number }) => this.scheduleCheck(driverId, 'rute genberegnet'));
  }

  start(): void {
    this.ctx.jobs.enqueue('replenishment_tick', {}, { delayMs: 30_000, dedupeKey: 'replenishment_tick' });
  }

  scheduleCheck(driverId: number, reason: string): void {
    this.ctx.jobs.enqueue('replenishment_check', { driverId, reason }, { dedupeKey: `rep_check:${driverId}`, lane: `rep:${driverId}` });
  }

  // ---------------- Læsning ----------------

  private map(r: Row): Replenishment {
    const loc = this.ctx.inventory.location(r.location_id);
    const driver = this.ctx.drivers.get(r.driver_id);
    const items = parseJson<{ productId: number; quantity: number }[]>(r.items, []);
    return {
      id: r.id,
      driverId: r.driver_id,
      driverName: driver?.name ?? `#${r.driver_id}`,
      locationId: r.location_id,
      locationName: loc?.name ?? `#${r.location_id}`,
      status: r.status,
      afterOrderId: r.after_order_id,
      items: items.map((i) => ({ ...i, productName: this.ctx.catalog.get(i.productId)?.name ?? `#${i.productId}` })),
      coversOrders: parseJson<number[]>(r.covers_orders, []),
      analysis: parseJson(r.analysis, null),
      deadlineAt: r.deadline_at,
      sentAt: r.sent_at,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      rejectedBy: r.rejected_by,
      rejectedReason: r.rejected_reason,
      driverAcceptedAt: r.driver_accepted_at,
      pickedUpAt: r.picked_up_at,
      completedAt: r.completed_at,
      createdAt: r.created_at,
    };
  }

  private row(id: number): Row | null {
    return (this.ctx.db.prepare(`SELECT * FROM replenishments WHERE id = ?`).get(id) as Row | undefined) ?? null;
  }

  get(id: number): Replenishment | null {
    const r = this.row(id);
    return r ? this.map(r) : null;
  }

  list(opts: { activeOnly?: boolean; driverId?: number; limit?: number } = {}): Replenishment[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.activeOnly) where.push(`status IN (${ACTIVE_REPLENISHMENT.map((x) => `'${x}'`).join(',')})`);
    if (opts.driverId) {
      where.push(`driver_id = ?`);
      args.push(opts.driverId);
    }
    return (
      this.ctx.db.prepare(`SELECT * FROM replenishments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, opts.limit ?? 100) as Row[]
    ).map((r) => this.map(r));
  }

  active(driverId: number): Row | null {
    return (
      (this.ctx.db
        .prepare(`SELECT * FROM replenishments WHERE driver_id = ? AND status IN (${ACTIVE_REPLENISHMENT.map((x) => `'${x}'`).join(',')}) ORDER BY id DESC LIMIT 1`)
        .get(driverId) as Row | undefined) ?? null
    );
  }

  private transition(id: number, to: ReplenishmentStatus, actor: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): void {
    const r = this.row(id);
    if (!r) throw new Error('Opfyldning findes ikke');
    if (!TRANSITIONS[r.status].includes(to)) throw new Error(`Ugyldigt statusskift for opfyldning: ${REPLENISHMENT_STATUS_LABELS[r.status]} → ${REPLENISHMENT_STATUS_LABELS[to]}`);
    const sets = ['status = ?', 'updated_at = ?'];
    const args: unknown[] = [to, new Date().toISOString()];
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      args.push(v);
    }
    this.ctx.db.prepare(`UPDATE replenishments SET ${sets.join(', ')} WHERE id = ? AND status = ?`).run(...args, id, r.status);
    this.ctx.db
      .prepare(`INSERT INTO replenishment_events (replenishment_id, from_status, to_status, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, r.status, to, actor, JSON.stringify(data), new Date().toISOString());
    this.ctx.bus.touch('replenishment', 'inventory', 'logistics');
    // ETA-grundlaget afhænger af opfyldningens status → genberegn ruten
    this.ctx.jobs.enqueue('refresh_route', { driverId: r.driver_id, reason: `opfyldning ${REPLENISHMENT_STATUS_LABELS[to].toLowerCase()}` }, { dedupeKey: `refresh_route:${r.driver_id}` });
  }

  events(id: number) {
    return (this.ctx.db.prepare(`SELECT * FROM replenishment_events WHERE replenishment_id = ? ORDER BY id`).all(id) as Record<string, unknown>[]).map((e) => ({
      fromStatus: e.from_status as string | null,
      toStatus: e.to_status as string,
      actor: e.actor as string,
      data: parseJson(e.data as string | null, null),
      createdAt: e.created_at as string,
    }));
  }

  // ---------------- Prognose ----------------

  private needsOf(orderId: number): Qty {
    const rows = this.ctx.db.prepare(`SELECT product_id, SUM(quantity) AS q FROM order_lines WHERE order_id = ? GROUP BY product_id`).all(orderId) as { product_id: number; q: number }[];
    return Object.fromEntries(rows.map((r) => [r.product_id, r.q]));
  }

  /** Lager efter hvert planlagt stop for en chauffør. */
  forecast(driverId: number): StockForecast & { rows: RouteStopRow[]; pickupOrders: RouteStopRow[] } {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId)!;
    const stops = this.routing.stops(driverId);
    const vehicle = driver.vehicleLocationId;
    const start: Qty = {};
    if (vehicle) {
      for (const l of ctx.inventory.levels().filter((x) => x.locationId === vehicle)) start[l.productId] = l.quantity;
      // Varer reserveret i bilen til ordrer uden for ruten er ikke til rådighed
      const outside = ctx.db
        .prepare(`SELECT id FROM orders WHERE stock_location_id = ? AND stock_state = 'reserved' AND id NOT IN (SELECT order_id FROM route_stops WHERE driver_id = ?)`)
        .all(vehicle, driverId) as { id: number }[];
      for (const o of outside) for (const [pid, q] of Object.entries(this.needsOf(o.id))) start[Number(pid)] = (start[Number(pid)] ?? 0) - q;
    }
    const act = this.active(driverId);
    const pickups: { afterIndex: number; items: Qty }[] = [];
    if (act && ['approved', 'awaiting_driver', 'en_route', 'awaiting_pickup'].includes(act.status)) {
      const items: Qty = {};
      for (const i of parseJson<{ productId: number; quantity: number }[]>(act.items, [])) items[i.productId] = i.quantity;
      const idx = act.after_order_id == null ? -1 : stops.findIndex((s) => s.orderId === act.after_order_id);
      pickups.push({ afterIndex: idx, items });
    }
    const needs = stops.map((s) => this.needsOf(s.orderId));
    const f = forecastVehicleStock(start, stops.map((s, i) => ({ orderId: s.orderId, needs: needs[i] })), pickups);
    const covers = act ? parseJson<number[]>(act.covers_orders, []) : [];
    const pickupOrders = stops.filter((s) => s.needsPickup);
    return {
      driverId,
      driverName: driver.name,
      vehicleLocationId: vehicle,
      start,
      stops: stops.map((s, i) => ({
        orderId: s.orderId,
        sequence: s.sequence,
        eta: s.previousEta,
        needs: needs[i],
        after: f.after[i],
        pickupBefore: pickups.some((p) => p.afterIndex === i - 1),
        uncovered: s.needsPickup && !covers.includes(s.orderId),
      })),
      shortages: f.shortages.map((x) => ({
        productId: x.productId,
        productName: ctx.catalog.get(x.productId)?.name ?? `#${x.productId}`,
        missing: x.missing,
        firstStopOrderId: stops[x.firstStopIndex].orderId,
        firstStopIndex: x.firstStopIndex,
      })),
      activeReplenishmentId: act?.id ?? null,
      rows: stops,
      pickupOrders,
    };
  }

  // ---------------- Vurdering af opfyldningsmuligheder ----------------

  async options(driverId: number, coverIds: number[], excluded: string[] = []): Promise<{ results: ReplenishmentOptionResult[]; need: Qty; sourceLocationId: number | null }> {
    const { ctx } = this;
    const s = ctx.settings.get();
    const driver = ctx.drivers.get(driverId)!;
    const stops = this.routing.stops(driverId);
    const anchor = this.routing.ensureAnchor(driver);
    const need: Qty = {};
    for (const id of coverIds) for (const [pid, q] of Object.entries(this.needsOf(id))) need[Number(pid)] = (need[Number(pid)] ?? 0) + q;
    const mustBeBefore = Math.min(...coverIds.map((id) => stops.findIndex((x) => x.orderId === id)).filter((i) => i >= 0));
    const sourceLocationId = stops.find((x) => coverIds.includes(x.orderId))?.stockLocationId ?? null;
    // Kandidater: centrale lagre (inkl. det lager varerne allerede er reserveret på)
    const centrals = ctx.inventory.locations().filter((l) => l.type === 'central');
    const levels = ctx.inventory.levels();
    const points = [anchor.lat != null ? { lat: anchor.lat, lng: anchor.lng! } : null, ...stops.map((x) => x.point)];
    const locs = centrals
      .map((l) => ({ l, loc: ctx.inventory.location(l.id)! }))
      .filter((x) => x.loc.lat != null)
      .map((x, j) => {
        const available: Qty = {};
        for (const pid of Object.keys(need).map(Number)) {
          const lvl = levels.find((v) => v.locationId === x.l.id && v.productId === pid);
          const free = lvl ? lvl.quantity - lvl.reserved : 0;
          // Varer der allerede er reserveret til de dækkede ordrer på dette lager er til rådighed for dem
          available[pid] = free + (x.l.id === sourceLocationId ? need[pid] : 0);
        }
        return { id: x.l.id, name: x.l.name, node: stops.length + j, available, point: { lat: x.loc.lat!, lng: x.loc.lng! } };
      });
    const fallback = points.find((p) => p) ?? locs[0]?.point ?? { lat: 0, lng: 0 };
    const all = [...points.map((p) => p ?? fallback), ...locs.map((l) => l.point)];
    const m = await ctx.maps.matrix(all, all);
    const travel = (from: number, to: number) => m[from + 1][to + 1].durationS;
    const results = evaluateReplenishmentOptions({
      nowMs: Date.now(),
      anchor,
      stops: stops.map((x) => ({ orderId: x.orderId, promisedMs: x.promisedMs, extraDelayMs: x.extraDelayMs, value: x.value, priority: x.priority })),
      lockedCount: this.routing.lockedCount(driver, stops, anchor),
      mustBeBeforeIndex: Number.isFinite(mustBeBefore) ? mustBeBefore : 0,
      need,
      coveredOrderIds: coverIds,
      locations: locs,
      travel,
      pickupMinutes: s.replenishment.pickupMinutes,
      eta: this.routing.etaParams(),
      econ: s.economics,
    }).filter((r) => !excluded.includes(`${r.locationId}:${r.afterOrderId ?? 'start'}`));
    return { results, need, sourceLocationId };
  }

  private toOption(r: ReplenishmentOptionResult): ReplenishmentOption {
    return { ...r, safeUntil: new Date(r.safeUntilMs).toISOString() };
  }

  // ---------------- Hovedlogik ----------------

  /** Genberegn prognosen og opret/opdatér/annullér opfyldningsforslag. */
  async evaluate(driverId: number, reason: string): Promise<void> {
    const { ctx } = this;
    if (!ctx.settings.get().replenishment.enabled) return;
    const driver = ctx.drivers.get(driverId);
    if (!driver) return;
    const f = this.forecast(driverId);
    const act = this.active(driverId);
    const needingPickup = f.pickupOrders.map((p) => p.orderId);
    if (!needingPickup.length) {
      if (act && ['proposed', 'awaiting_management', 'approved', 'awaiting_driver'].includes(act.status)) {
        this.transition(act.id, 'cancelled', 'system', { reason: 'Ikke længere nødvendig' });
        this.notifyGroup(`ℹ️ Opfyldning #${act.id} til ${driver.name} er ikke længere nødvendig (${reason}).`, `rep_cancel:${act.id}`);
        if (act.status === 'awaiting_driver') ctx.telegram.sendToDriver(driverId, `Lagerbesøg (opfyldning #${act.id}) er aflyst – ikke længere nødvendigt.`, `rep_cancel_driver:${act.id}`);
      }
      return;
    }
    // Én lagerlokation ad gangen: den hvis varer skal bruges først
    const sourceLoc = f.pickupOrders[0].stockLocationId;
    const coverIds = f.pickupOrders.filter((p) => p.stockLocationId === sourceLoc).map((p) => p.orderId);

    if (act) {
      const covers = parseJson<number[]>(act.covers_orders, []);
      const newOnes = coverIds.filter((id) => !covers.includes(id));
      const removed = covers.filter((id) => !coverIds.includes(id));
      if (!newOnes.length && !removed.length) return; // uændret
      if (['en_route', 'awaiting_pickup'].includes(act.status) && act.location_id === sourceLoc) {
        // Chaufføren er på vej til lageret – udvid blot afhentningen
        this.updateCovers(act.id, coverIds, 'system');
        ctx.telegram.sendToDriver(driverId, `Opdatering til lagerbesøg #${act.id}: hent ${this.itemsText(coverIds)}.`, `rep_extend:${act.id}:${coverIds.join('-')}`);
        this.notifyGroup(`ℹ️ Opfyldning #${act.id} (${driver.name}) udvidet: ${this.itemsText(coverIds)} (${reason}).`, `rep_extend_g:${act.id}:${coverIds.join('-')}`);
        return;
      }
      if (['approved', 'awaiting_driver'].includes(act.status)) {
        const stops = f.rows;
        const pointIdx = act.after_order_id == null ? -1 : stops.findIndex((s) => s.orderId === act.after_order_id);
        const allAfter = newOnes.every((id) => stops.findIndex((s) => s.orderId === id) > pointIdx);
        if (allAfter && act.location_id === sourceLoc && pointIdx >= -1) {
          this.updateCovers(act.id, coverIds, 'system');
          if (act.status === 'awaiting_driver') this.requestDriver(act.id, true);
          return;
        }
        // Behovet opstår før det godkendte punkt → kræver ny godkendelse
        await this.replan(act.id, coverIds, `Behovet er ændret (${reason}) – kræver ny godkendelse`);
        return;
      }
      if (['proposed', 'awaiting_management'].includes(act.status)) {
        await this.replan(act.id, coverIds, `Opdateret forslag (${reason})`);
        return;
      }
      return;
    }
    await this.propose(driverId, coverIds, reason, []);
  }

  private itemsText(orderIds: number[]): string {
    const need: Qty = {};
    for (const id of orderIds) for (const [pid, q] of Object.entries(this.needsOf(id))) need[Number(pid)] = (need[Number(pid)] ?? 0) + q;
    return Object.entries(need)
      .map(([pid, q]) => `${q}× ${this.ctx.catalog.get(Number(pid))?.name ?? pid}`)
      .join(', ');
  }

  private updateCovers(id: number, coverIds: number[], actor: string): void {
    const need: Qty = {};
    for (const o of coverIds) for (const [pid, q] of Object.entries(this.needsOf(o))) need[Number(pid)] = (need[Number(pid)] ?? 0) + q;
    this.ctx.db
      .prepare(`UPDATE replenishments SET covers_orders = ?, items = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(coverIds), JSON.stringify(Object.entries(need).map(([productId, quantity]) => ({ productId: Number(productId), quantity }))), new Date().toISOString(), id);
    this.ctx.db
      .prepare(`INSERT INTO replenishment_events (replenishment_id, from_status, to_status, actor, data, created_at) VALUES (?, NULL, NULL, ?, ?, ?)`)
      .run(id, actor, JSON.stringify({ covers: coverIds }), new Date().toISOString());
    this.ctx.bus.touch('replenishment');
  }

  /** Opret et nyt forslag og send det til ledelsen. */
  private async propose(driverId: number, coverIds: number[], reason: string, excluded: string[], intro?: string): Promise<number | null> {
    const { ctx } = this;
    const { results, need } = await this.options(driverId, coverIds, excluded);
    const feasible = results.filter((r) => r.feasible);
    const driver = ctx.drivers.get(driverId)!;
    if (!feasible.length) {
      await this.escalateNoSolution(driverId, coverIds, results, reason);
      return null;
    }
    const chosen = feasible[0];
    const deadline = Math.max(...feasible.filter((r) => r.locationId === chosen.locationId).map((r) => r.safeUntilMs));
    const reasoning = this.reasoning(chosen, feasible, results);
    const analysis = { chosen: this.toOption(chosen), alternatives: results.filter((r) => r !== chosen).slice(0, 6).map((r) => this.toOption(r)), reasoning, rejectedOptions: excluded };
    let id: number;
    try {
      const r = ctx.db
        .prepare(
          `INSERT INTO replenishments (driver_id, location_id, status, after_order_id, items, covers_orders, analysis, deadline_at, created_at, updated_at)
           VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          driverId,
          chosen.locationId,
          chosen.afterOrderId,
          JSON.stringify(Object.entries(need).map(([productId, quantity]) => ({ productId: Number(productId), quantity }))),
          JSON.stringify(coverIds),
          JSON.stringify(analysis),
          new Date(deadline).toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      id = Number(r.lastInsertRowid);
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) return null; // allerede et aktivt forslag (samtidighed)
      throw e;
    }
    ctx.db
      .prepare(`INSERT INTO replenishment_events (replenishment_id, from_status, to_status, actor, data, created_at) VALUES (?, NULL, 'proposed', 'system', ?, ?)`)
      .run(id, JSON.stringify({ reason }), new Date().toISOString());
    ctx.events.log('info', 'replenishment', 'proposed', `Opfyldning foreslået til ${driver.name}: ${this.itemsText(coverIds)} på ${chosen.locationName} (${reason})`, {
      data: { replenishmentId: id, driverId },
    });
    this.transition(id, 'awaiting_management', 'system', {}, { sent_at: new Date().toISOString() });
    this.sendProposal(id, intro ?? '🔄 Forslag til lageropfyldning');
    return id;
  }

  private reasoning(chosen: ReplenishmentOptionResult, feasible: ReplenishmentOptionResult[], all: ReplenishmentOptionResult[]): string[] {
    const r = [
      `Valgt fordi det giver den laveste samlede driftsomkostning (${Math.round(chosen.costOre / 100)} kr.) blandt ${feasible.length} gyldige muligheder.`,
    ];
    const next = feasible[1];
    if (next) r.push(`Næstbedste: ${next.explanation[0].toLowerCase()} (${Math.round((next.costOre - chosen.costOre) / 100)} kr. dyrere).`);
    const infeasible = all.filter((x) => !x.feasible).length;
    if (infeasible) r.push(`${infeasible} mulighed(er) er udelukket, fordi de bryder leveringsløfter eller lageret mangler varer.`);
    r.push('Varerne til ordrerne er reserveret på lageret; bilens lager opdateres først, når chaufføren bekræfter afhentningen.');
    return r;
  }

  private async replan(id: number, coverIds: number[], reason: string): Promise<void> {
    const r = this.row(id)!;
    const { results, need } = await this.options(r.driver_id, coverIds, parseJson<{ rejectedOptions?: string[] }>(r.analysis, {}).rejectedOptions ?? []);
    const feasible = results.filter((x) => x.feasible);
    if (!feasible.length) {
      this.transition(id, 'cancelled', 'system', { reason: 'Ingen gyldig opfyldning efter ændring' });
      await this.escalateNoSolution(r.driver_id, coverIds, results, reason);
      return;
    }
    const chosen = feasible[0];
    const deadline = Math.max(...feasible.filter((x) => x.locationId === chosen.locationId).map((x) => x.safeUntilMs));
    const analysis = { chosen: this.toOption(chosen), alternatives: results.filter((x) => x !== chosen).slice(0, 6).map((x) => this.toOption(x)), reasoning: this.reasoning(chosen, feasible, results) };
    this.ctx.db
      .prepare(`UPDATE replenishments SET location_id = ?, after_order_id = ?, items = ?, covers_orders = ?, analysis = ?, deadline_at = ?, reminder_sent_at = NULL, escalated_at = NULL, updated_at = ? WHERE id = ?`)
      .run(
        chosen.locationId,
        chosen.afterOrderId,
        JSON.stringify(Object.entries(need).map(([productId, quantity]) => ({ productId: Number(productId), quantity }))),
        JSON.stringify(coverIds),
        JSON.stringify(analysis),
        new Date(deadline).toISOString(),
        new Date().toISOString(),
        id,
      );
    if (r.status === 'awaiting_driver') this.ctx.telegram.sendToDriver(r.driver_id, `Lagerbesøg #${id} er ændret og skal godkendes igen – afvent ny besked.`, `rep_replan_driver:${id}:${Date.now()}`);
    this.transition(id, 'awaiting_management', 'system', { reason }, { sent_at: new Date().toISOString(), approved_by: null, approved_at: null });
    this.sendProposal(id, `🔁 ${reason}`);
  }

  private async escalateNoSolution(driverId: number, coverIds: number[], results: ReplenishmentOptionResult[], reason: string): Promise<void> {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId)!;
    for (const id of coverIds) ctx.orders.flag(id, 'Ingen forsvarlig lageropfyldning – kræver ledelsesbeslutning');
    const why = results.slice(0, 3).map((r) => `• ${r.explanation[0]}: ${r.violations.join('; ') || 'ukendt'}`).join('\n');
    ctx.events.log('critical', 'replenishment', 'no_solution', `Ingen forsvarlig lageropfyldning for ${driver.name} (ordrer ${coverIds.map((x) => '#' + x).join(', ')})`, {
      requiresAction: true,
      dedupeKey: `rep_no_solution:${driverId}:${coverIds.join('-')}`,
      data: { driverId, orderIds: coverIds },
    });
    this.notifyGroup(
      `⚠️ Ingen forsvarlig lageropfyldning for ${driver.name}.\nOrdrer der mangler varer: ${coverIds.map((x) => '#' + x).join(', ')} (${this.itemsText(coverIds)}).\nÅrsag (${reason}):\n${why || '• Ingen lagerlokation med varerne'}\nForslag: omfordel ordrerne til en chauffør med varer ("flyt ordre X til chauffør Y") eller sæt dem i manuel håndtering.`,
      `rep_nosol:${driverId}:${coverIds.join('-')}:${Math.floor(Date.now() / 600000)}`,
    );
    if (this.onUncoverable) await this.onUncoverable(coverIds, driverId);
  }

  // ---------------- Kommunikation ----------------

  private groupChat(): string | null {
    return this.ctx.settings.get().management.groupChatId || null;
  }

  notifyGroup(text: string, key: string, buttons?: TelegramButton[][]): void {
    const chat = this.groupChat();
    if (chat) this.ctx.telegram.sendToChat(chat, text, key, buttons);
  }

  proposalText(rep: Replenishment, title: string): string {
    const { ctx } = this;
    const f = this.forecast(rep.driverId);
    const c = rep.analysis?.chosen;
    const relevant = rep.items.map((i) => i.productId);
    const stockNow = relevant.map((pid) => `${ctx.catalog.get(pid)?.name}: ${Math.max(0, f.start[pid] ?? 0)}`).join(', ') || '–';
    const totalNeed: Qty = {};
    for (const st of f.stops) for (const [pid, q] of Object.entries(st.needs)) if (relevant.includes(Number(pid))) totalNeed[Number(pid)] = (totalNeed[Number(pid)] ?? 0) + q;
    const needText = Object.entries(totalNeed).map(([pid, q]) => `${ctx.catalog.get(Number(pid))?.name}: ${q}`).join(', ');
    const missing = f.shortages.map((s) => `${s.productName}: ${s.missing} (fra stop #${s.firstStopOrderId})`).join(', ') || 'dækket af planen';
    const afterIdx = c ? c.afterIndex : -1;
    const afterStop = rep.afterOrderId ? f.stops.find((s) => s.orderId === rep.afterOrderId) : null;
    const point = rep.afterOrderId ? `efter stop ${afterIdx + 1} (ordre #${rep.afterOrderId}${afterStop?.eta ? `, ca. kl. ${formatTime(afterStop.eta)}` : ''})` : 'før første stop';
    const effect = c?.delays.length ? c.delays.map((d) => `#${d.orderId} +${d.minutes} min`).join(', ') : 'ingen leveringer rykkes';
    const alts = (rep.analysis?.alternatives ?? [])
      .filter((a) => a.feasible)
      .slice(0, 3)
      .map((a) => `• ${a.explanation[0]} – +${a.extraDriveMinutes} min kørsel, ${Math.round(a.costOre / 100)} kr.`)
      .join('\n');
    return [
      `${title} #${rep.id}`,
      `Chauffør: ${rep.driverName}`,
      `Aktuelt lager i bilen: ${stockNow}`,
      `Resterende behov på ruten: ${needText}`,
      `Manglende varer: ${missing}`,
      `Foreslået lager: ${rep.locationName}`,
      `Tidspunkt: ${point}`,
      `Afhent: ${rep.items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')}`,
      `Ekstra køretid: ${c?.extraDriveMinutes ?? '?'} min + ${c?.pickupMinutes ?? '?'} min afhentning`,
      `Effekt: ${effect}`,
      `Alternativer:\n${alts || '• ingen andre gyldige'}`,
      `Begrundelse: ${(rep.analysis?.reasoning ?? []).join(' ')}`,
      rep.deadlineAt ? `Senest sikre tidspunkt for beslutning: kl. ${formatTime(rep.deadlineAt)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private sendProposal(id: number, title: string): void {
    const rep = this.get(id)!;
    const text = this.proposalText(rep, title);
    if (this.groupChat()) {
      this.notifyGroup(text, `rep_proposal:${id}:${Date.now()}`, [
        [
          { text: '✅ Godkend', data: `rep:${id}:approve` },
          { text: '🔍 Vis alternativer', data: `rep:${id}:alts` },
          { text: '❌ Afvis', data: `rep:${id}:reject` },
        ],
      ]);
    } else {
      this.ctx.events.log('warn', 'replenishment', 'awaiting_approval', `Opfyldning #${id} til ${rep.driverName} afventer godkendelse (ingen ledelsesgruppe konfigureret)`, {
        requiresAction: true,
        dedupeKey: `rep_await:${id}`,
        data: { replenishmentId: id, driverId: rep.driverId },
      });
    }
  }

  alternativesText(id: number): string {
    const rep = this.get(id);
    if (!rep?.analysis) return 'Ingen alternativer registreret.';
    const lines = [rep.analysis.chosen, ...rep.analysis.alternatives].map(
      (a, i) => `${i === 0 ? '★' : `${i}.`} ${a.explanation[0]} – ${a.feasible ? `+${a.extraDriveMinutes} min kørsel, maks. forsinkelse ${a.maxDelayMinutes} min, ${Math.round(a.costOre / 100)} kr.` : `ugyldig: ${a.violations.join('; ')}`}`,
    );
    return `Alternativer for opfyldning #${id}:\n${lines.join('\n')}`;
  }

  // ---------------- Ledelsens beslutning (kun menneskelige handlinger) ----------------

  approve(id: number, by: Approver): string {
    const { ctx } = this;
    const r = this.row(id);
    if (!r) return 'Opfyldningen findes ikke.';
    if (r.status !== 'awaiting_management' && r.status !== 'proposed') return `Opfyldning #${id} kan ikke godkendes (status: ${REPLENISHMENT_STATUS_LABELS[r.status]}).`;
    const covers = parseJson<number[]>(r.covers_orders, []);
    try {
      ctx.db.transaction(() => {
        // Sikr at varerne er reserveret på det valgte lager (flyt reservationen atomisk om nødvendigt)
        for (const orderId of covers) {
          const o = ctx.db.prepare(`SELECT stock_state, stock_location_id FROM orders WHERE id = ?`).get(orderId) as { stock_state: string; stock_location_id: number | null };
          if (o.stock_state !== 'reserved') throw new Error(`Ordre #${orderId} har ingen lagerreservation`);
          if (o.stock_location_id !== r.location_id) ctx.inventory.moveReservation(orderId, r.location_id);
        }
        this.transition(id, 'approved', by.name, { source: by.source }, { approved_by: by.name, approved_at: new Date().toISOString() });
      })();
    } catch (e) {
      const msg = e instanceof InsufficientStockError ? 'lageret har ikke længere varerne (en anden chauffør har fået dem)' : (e as Error).message;
      ctx.events.log('warn', 'replenishment', 'approve_failed', `Opfyldning #${id} kunne ikke godkendes: ${msg}`, { data: { replenishmentId: id } });
      this.scheduleCheck(r.driver_id, 'godkendelse fejlede');
      return `Opfyldning #${id} kunne ikke godkendes: ${msg}. Der beregnes et nyt forslag.`;
    }
    ctx.audit.record(by.name, 'replenishment_approve', 'replenishment', id, { source: by.source });
    this.requestDriver(id, false);
    ctx.jobs.enqueue('refresh_route', { driverId: r.driver_id, reason: 'opfyldning godkendt' }, { dedupeKey: `refresh_route:${r.driver_id}` });
    return `✅ Opfyldning #${id} godkendt af ${by.name}. Chaufføren er bedt om at bekræfte.`;
  }

  private requestDriver(id: number, updated: boolean): void {
    const rep = this.get(id)!;
    if (rep.status === 'approved') this.transition(id, 'awaiting_driver', 'system');
    const c = rep.analysis?.chosen;
    this.ctx.telegram.sendToDriver(
      rep.driverId,
      `${updated ? 'Opdateret lagerbesøg' : 'Lagerbesøg'} #${id}: Hent ${rep.items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')} på ${rep.locationName} ${rep.afterOrderId ? `efter ordre #${rep.afterOrderId}` : 'før næste stop'}.\nEkstra ca. ${c ? Math.round(c.extraDriveMinutes + c.pickupMinutes) : '?'} min. Kan du det?`,
      `rep_driver:${id}:${updated ? Date.now() : 'first'}`,
      { buttons: [[{ text: '✅ Accepter', data: `rep:${id}:driver_accept` }, { text: '❌ Kan ikke', data: `rep:${id}:driver_reject` }]] },
    );
  }

  async reject(id: number, by: Approver, reason: string): Promise<string> {
    const r = this.row(id);
    if (!r) return 'Opfyldningen findes ikke.';
    if (r.status !== 'awaiting_management' && r.status !== 'proposed') return `Opfyldning #${id} kan ikke afvises (status: ${REPLENISHMENT_STATUS_LABELS[r.status]}).`;
    this.transition(id, 'rejected', by.name, { reason, source: by.source }, { rejected_by: by.name, rejected_reason: reason });
    this.ctx.audit.record(by.name, 'replenishment_reject', 'replenishment', id, { reason });
    const covers = parseJson<number[]>(r.covers_orders, []);
    const excluded = [...(parseJson<{ rejectedOptions?: string[] }>(r.analysis, {}).rejectedOptions ?? []), `${r.location_id}:${r.after_order_id ?? 'start'}`];
    const newId = await this.propose(r.driver_id, covers, 'alternativ efter afvisning', excluded, `🔁 Alternativt forslag efter afvisning af #${id}`);
    return newId ? `Opfyldning #${id} afvist. Alternativt forslag #${newId} er sendt.` : `Opfyldning #${id} afvist. Der findes ingen anden forsvarlig løsning – sagen er eskaleret.`;
  }

  // ---------------- Chaufføren ----------------

  async driverRespond(id: number, driverId: number, accept: boolean): Promise<string> {
    const { ctx } = this;
    const r = this.row(id);
    if (!r || r.driver_id !== driverId) return 'Lagerbesøget blev ikke fundet.';
    if (r.status !== 'awaiting_driver') return `Lagerbesøg #${id} afventer ikke dit svar (status: ${REPLENISHMENT_STATUS_LABELS[r.status]}).`;
    if (accept) {
      this.transition(id, 'en_route', 'driver', {}, { driver_accepted_at: new Date().toISOString() });
      ctx.db.prepare(`UPDATE drivers SET route_version = route_version + 1 WHERE id = ?`).run(driverId);
      this.routing.touchAnchor(driverId);
      await this.routing.refreshEtas(driverId, 'lagerbesøg accepteret');
      this.notifyGroup(`🚚 ${ctx.drivers.get(driverId)?.name} har accepteret lagerbesøg #${id}.`, `rep_driver_ok:${id}`);
      return `Tak! Kør til ${this.get(id)!.locationName} ${r.after_order_id ? `efter ordre #${r.after_order_id}` : 'nu'}. Tryk "Afhentet", når varerne er i bilen.`;
    }
    this.transition(id, 'rejected', 'driver', { reason: 'Chaufføren kan ikke' }, { rejected_by: 'chauffør', rejected_reason: 'Chaufføren kan ikke' });
    const covers = parseJson<number[]>(r.covers_orders, []);
    const excluded = [`${r.location_id}:${r.after_order_id ?? 'start'}`];
    const newId = await this.propose(driverId, covers, 'chaufføren kunne ikke', excluded, `⚠️ ${ctx.drivers.get(driverId)?.name} kan ikke gennemføre lagerbesøg #${id}. Nyt forslag`);
    return newId ? 'Noteret. Kontoret får et nyt forslag.' : 'Noteret. Kontoret er informeret.';
  }

  driverArrived(id: number, driverId: number): string {
    const r = this.row(id);
    if (!r || r.driver_id !== driverId) return 'Lagerbesøget blev ikke fundet.';
    if (r.status !== 'en_route') return `Lagerbesøg #${id} kan ikke markeres (status: ${REPLENISHMENT_STATUS_LABELS[r.status]}).`;
    this.transition(id, 'awaiting_pickup', 'driver');
    return `Noteret – du er ved lageret. Tryk "Afhentet", når varerne er i bilen.`;
  }

  /** Bekræftet fysisk afhentning → varer flyttes til bilen (transaktion) → afsluttet. Idempotent. */
  async driverPickedUp(id: number, driverId: number): Promise<string> {
    const { ctx } = this;
    const r = this.row(id);
    if (!r || r.driver_id !== driverId) return 'Lagerbesøget blev ikke fundet.';
    if (r.status === 'completed' || r.status === 'picked_up') return `Afhentningen for #${id} er allerede registreret.`;
    if (!['en_route', 'awaiting_pickup'].includes(r.status)) return `Lagerbesøg #${id} kan ikke bekræftes (status: ${REPLENISHMENT_STATUS_LABELS[r.status]}).`;
    const driver = ctx.drivers.get(driverId)!;
    if (!driver.vehicleLocationId) return 'Din bil har ingen lagerlokation – kontakt kontoret.';
    const covers = parseJson<number[]>(r.covers_orders, []);
    let moved: { productId: number; quantity: number }[] = [];
    ctx.db.transaction(() => {
      moved = ctx.inventory.pickupForOrders(covers, r.location_id, driver.vehicleLocationId!, id);
      this.transition(id, 'picked_up', 'driver', { moved }, { picked_up_at: new Date().toISOString() });
      this.transition(id, 'completed', 'system', {}, { completed_at: new Date().toISOString() });
      const loc = ctx.inventory.location(r.location_id);
      if (loc?.lat != null) {
        ctx.drivers.setPosition(driverId, loc.lat, loc.lng!, 'central');
        this.routing.setAnchor(driverId, { kind: 'start', atMs: Date.now(), point: { lat: loc.lat, lng: loc.lng! } });
      }
      ctx.db.prepare(`UPDATE drivers SET route_version = route_version + 1 WHERE id = ?`).run(driverId);
    })();
    const text = moved.map((m) => `${m.quantity}× ${ctx.catalog.get(m.productId)?.name}`).join(', ');
    ctx.events.log('info', 'replenishment', 'completed', `Opfyldning #${id} afsluttet: ${driver.name} har hentet ${text}`);
    this.notifyGroup(`✅ Opfyldning #${id} afsluttet – ${driver.name} har hentet ${text}.`, `rep_done:${id}`);
    await this.routing.refreshEtas(driverId, 'opfyldning afsluttet');
    return `✅ Afhentning registreret: ${text}. Bilens lager er opdateret.`;
  }

  cancel(id: number, by: string, reason: string): string {
    const r = this.row(id);
    if (!r) return 'Opfyldningen findes ikke.';
    if (!TRANSITIONS[r.status].includes('cancelled')) return `Opfyldning #${id} kan ikke annulleres (status: ${REPLENISHMENT_STATUS_LABELS[r.status]}).`;
    this.transition(id, 'cancelled', by, { reason });
    if (['awaiting_driver', 'en_route', 'awaiting_pickup'].includes(r.status)) this.ctx.telegram.sendToDriver(r.driver_id, `Lagerbesøg #${id} er annulleret.`, `rep_cancel_driver:${id}`);
    return `Opfyldning #${id} annulleret.`;
  }

  // ---------------- Lagermelding fra chauffør ----------------

  /**
   * Chaufføren melder faktisk antal af en vare i bilen. Ordrer, der ikke
   * længere kan dækkes fra bilen (i rutens rækkefølge), får deres reservation
   * flyttet til centrallageret, og bilens tal rettes. Derefter genberegnes behovet.
   */
  async reconcileVehicleStock(driverId: number, productId: number, reported: number): Promise<{ movedOrders: number[]; failedOrders: number[] }> {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId)!;
    const vehicle = driver.vehicleLocationId;
    if (!vehicle) return { movedOrders: [], failedOrders: [] };
    const central = ctx.inventory.centralLocation();
    const stops = this.routing.stops(driverId);
    const moved: number[] = [];
    const failed: number[] = [];
    let cum = 0;
    for (const st of stops) {
      if (st.stockLocationId !== vehicle) continue;
      const q = this.needsOf(st.orderId)[productId] ?? 0;
      if (!q) continue;
      if (cum + q <= reported) {
        cum += q;
        continue;
      }
      try {
        if (!central) throw new InsufficientStockError([]);
        ctx.inventory.moveReservation(st.orderId, central.id);
        moved.push(st.orderId);
      } catch {
        failed.push(st.orderId);
        ctx.orders.flag(st.orderId, 'Varer mangler i bilen og på lageret');
      }
    }
    const lvl = ctx.inventory.levels().find((l) => l.locationId === vehicle && l.productId === productId);
    const target = Math.max(reported, lvl?.reserved ?? 0);
    const delta = target - (lvl?.quantity ?? 0);
    if (delta !== 0) {
      if (delta > 0) ctx.inventory.adjust(vehicle, productId, delta, 'Chaufførens lagermelding', 'driver');
      else ctx.inventory.adjust(vehicle, productId, delta, 'Chaufførens lagermelding', 'driver');
    }
    ctx.events.log('warn', 'replenishment', 'vehicle_stock_reported', `${driver.name} melder ${reported} stk. ${ctx.catalog.get(productId)?.name} i bilen${moved.length ? ` – ordrer ${moved.map((x) => '#' + x).join(', ')} skal dækkes fra lager` : ''}`, {
      requiresAction: failed.length > 0,
      data: { driverId, productId, reported, moved, failed },
    });
    await this.evaluate(driverId, 'chaufførens lagermelding');
    return { movedOrders: moved, failedOrders: failed };
  }

  // ---------------- Påmindelser og eskalering ----------------

  async tick(): Promise<void> {
    const { ctx } = this;
    const s = ctx.settings.get().replenishment;
    const now = Date.now();
    const rows = ctx.db.prepare(`SELECT * FROM replenishments WHERE status IN ('awaiting_management','awaiting_driver')`).all() as Row[];
    for (const r of rows) {
      const deadline = r.deadline_at ? new Date(r.deadline_at).getTime() : null;
      const ref = r.status === 'awaiting_driver' ? r.approved_at : r.sent_at;
      const since = ref ? now - new Date(ref).getTime() : 0;
      const who = r.status === 'awaiting_management' ? 'ledelsen' : 'chaufføren';
      if (deadline && now > deadline) {
        this.transition(r.id, 'expired', 'system', { reason: `Ingen beslutning fra ${who} før sidste sikre opfyldningspunkt` });
        const covers = parseJson<number[]>(r.covers_orders, []);
        for (const id of covers) ctx.orders.flag(id, 'Opfyldning ikke godkendt i tide');
        ctx.events.log('critical', 'replenishment', 'expired', `Opfyldning #${r.id} udløb uden beslutning fra ${who} – nyt forslag beregnes`, { requiresAction: true, data: { replenishmentId: r.id } });
        await this.propose(r.driver_id, covers, 'tidligere forslag udløb', [], `⏰ Opfyldning #${r.id} udløb uden svar. Nyt forslag`);
        continue;
      }
      if (deadline && deadline - now <= s.escalateLeadMinutes * 60000 && !r.escalated_at) {
        ctx.db.prepare(`UPDATE replenishments SET escalated_at = ? WHERE id = ?`).run(new Date(now).toISOString(), r.id);
        ctx.events.log('critical', 'replenishment', 'escalated', `HASTER: Opfyldning #${r.id} mangler svar fra ${who} – sidste sikre tidspunkt kl. ${formatTime(r.deadline_at!)}`, {
          requiresAction: true,
          data: { replenishmentId: r.id, driverId: r.driver_id },
        });
        this.notifyGroup(
          `🚨 HASTER: Opfyldning #${r.id} (${ctx.drivers.get(r.driver_id)?.name}) mangler svar fra ${who}. Sidste sikre tidspunkt kl. ${formatTime(r.deadline_at!)}.`,
          `rep_escalate:${r.id}`,
          r.status === 'awaiting_management' ? [[{ text: '✅ Godkend', data: `rep:${r.id}:approve` }, { text: '❌ Afvis', data: `rep:${r.id}:reject` }]] : undefined,
        );
        continue;
      }
      if (since >= s.reminderAfterMinutes * 60000 && !r.reminder_sent_at) {
        ctx.db.prepare(`UPDATE replenishments SET reminder_sent_at = ? WHERE id = ?`).run(new Date(now).toISOString(), r.id);
        if (r.status === 'awaiting_management') {
          this.notifyGroup(`⏰ Påmindelse: Opfyldning #${r.id} til ${ctx.drivers.get(r.driver_id)?.name} afventer godkendelse.`, `rep_reminder:${r.id}`, [
            [{ text: '✅ Godkend', data: `rep:${r.id}:approve` }, { text: '🔍 Vis alternativer', data: `rep:${r.id}:alts` }, { text: '❌ Afvis', data: `rep:${r.id}:reject` }],
          ]);
        } else {
          ctx.telegram.sendToDriver(r.driver_id, `⏰ Påmindelse: Svar venligst på lagerbesøg #${r.id}.`, `rep_reminder_driver:${r.id}`, {
            buttons: [[{ text: '✅ Accepter', data: `rep:${r.id}:driver_accept` }, { text: '❌ Kan ikke', data: `rep:${r.id}:driver_reject` }]],
          });
        }
      }
    }
  }
}
