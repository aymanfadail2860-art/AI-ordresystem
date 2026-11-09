import type { Ctx } from '../context';
import type { JobRow } from '../jobs/jobQueue';
import { RetryLaterError } from '../jobs/jobQueue';
import type { Driver, Order, RoutePlanSummary } from '../../shared/types';
import type { RoutingService } from './routing';
import type { CustomerNotifier } from './notifier';
import type { InsertionResult } from '../../core/routePlanning';
import { etaCommunicable } from '../../core/eta';
import { InsufficientStockError } from '../services/inventory';
import { formatDkk } from '../../core/money';
import { formatTime } from './replies';

export type StockPlan = 'own_vehicle' | 'move_to_vehicle' | 'central_pickup' | 'move_to_central';

export interface Candidate {
  driver: Driver;
  stockPlan: StockPlan;
  best: InsertionResult | null;
  reason: string;
}

/**
 * Dispatch Agent – deterministisk, økonomisk tildeling.
 *
 * For hver ny ordre: find chauffører med relevant lager og kapacitet, beregn
 * den bedste indsættelse i hver chaufførs bindende rute (ekstra køretid,
 * påvirkning af eksisterende ETA'er og løfter, økonomi), vælg den bedste
 * gyldige løsning og send den som en konkret ruteplan til chaufførens accept.
 * Alle dispatch-beslutninger kører i én serialiseret kø (lane 'dispatch'),
 * så samtidige ordrer ikke kan dobbeltbooke kapacitet.
 */
export class DispatchAgent {
  constructor(
    private ctx: Ctx,
    private routing: RoutingService,
    private notifier: CustomerNotifier,
  ) {
    ctx.jobs.register('dispatch_order', (job) => this.handleDispatch(job));
    ctx.jobs.register('offer_timeout', (job) => this.handleOfferTimeout(job));
  }

  enqueue(orderId: number, delayMs = 0): void {
    this.ctx.jobs.enqueue('dispatch_order', { orderId }, { dedupeKey: `dispatch:${orderId}`, lane: 'dispatch', delayMs });
  }

  /**
   * Planlæg ventende ordrer igen, højeste dækningsbidrag først (med tillæg for
   * ventetid), fx når en chauffør har svaret på et tilbud eller fået plads.
   */
  dispatchWaiting(): void {
    const { ctx } = this;
    const margin = ctx.settings.get().economics.defaultMarginPct;
    const waiting = ctx.orders
      .list({ status: ['awaiting_driver'] })
      .filter((o) => !ctx.drivers.offers(o.id).some((x) => x.status === 'pending'))
      .map((o) => {
        const waitedMin = o.confirmedAt ? (Date.now() - new Date(o.confirmedAt).getTime()) / 60000 : 0;
        return { id: o.id, prio: this.routing.valueOf(o.id, o.deliveryFeeOre, margin).contributionOre + waitedMin * 500 };
      })
      .sort((a, b) => b.prio - a.prio);
    waiting.forEach((w, i) => this.enqueue(w.id, i * 5));
  }

  private async handleDispatch(job: JobRow): Promise<void> {
    await this.dispatch(job.payload.orderId as number);
  }

  private needs(order: Order) {
    return order.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }));
  }

  /** Lagerplan for en chauffør. null = chaufføren kan ikke få varerne → må ikke tildeles. */
  stockPlanFor(driver: Driver, order: Order): StockPlan | null {
    const { ctx } = this;
    const s = ctx.settings.get();
    const central = ctx.inventory.centralLocation();
    const needs = this.needs(order);
    if (order.stockLocationId && order.stockLocationId === driver.vehicleLocationId) return 'own_vehicle';
    if (driver.vehicleLocationId && ctx.inventory.canFulfil(driver.vehicleLocationId, needs)) return 'move_to_vehicle';
    if (s.delivery.allowCentralPickup && central && order.stockLocationId === central.id) return 'central_pickup';
    if (s.delivery.allowCentralPickup && central && ctx.inventory.canFulfil(central.id, needs)) return 'move_to_central';
    return null;
  }

  capacityLeft(driver: Driver): number {
    const extra = driver.extraCapacityUntil && new Date(driver.extraCapacityUntil).getTime() > Date.now() ? 1 : 0;
    return driver.maxActiveOrders + extra - driver.activeOrderCount - driver.pendingOfferCount;
  }

  /** Vurdér alle chauffører for en ordre. Returnerer gyldige kandidater sorteret efter score. */
  async evaluate(order: Order, opts: { exclude?: number[]; reassignment?: boolean } = {}): Promise<{ feasible: Candidate[]; rejected: Candidate[] }> {
    const { ctx } = this;
    const feasible: Candidate[] = [];
    const rejected: Candidate[] = [];
    if (order.addressLat == null) return { feasible, rejected };
    const drivers = ctx.drivers.list().filter((d) => !(opts.exclude ?? []).includes(d.id));
    for (const d of drivers) {
      const reject = (reason: string) => rejected.push({ driver: d, stockPlan: 'own_vehicle', best: null, reason });
      if (d.status !== 'available' && d.status !== 'busy') {
        reject(d.status === 'offline' ? 'Offline' : 'På pause');
        continue;
      }
      if (!d.telegramChatId && !ctx.telegram.current?.simulated) {
        reject('Ikke forbundet til Telegram');
        continue;
      }
      if (this.capacityLeft(d) <= 0 && d.id !== order.driverId) {
        reject('Ingen ledig kapacitet');
        continue;
      }
      // Ét ventende tilbud ad gangen pr. chauffør – så ruteplaner ikke modsiger hinanden
      if (d.pendingOfferCount > 0) {
        reject('Har allerede et ubesvaret tilbud');
        continue;
      }
      const plan = this.stockPlanFor(d, order);
      if (!plan) {
        reject('Mangler varer i bilen');
        continue;
      }
      const results = await this.routing.planInsertion(
        d,
        { id: order.id, point: { lat: order.addressLat, lng: order.addressLng! }, needsPickup: plan === 'central_pickup' || plan === 'move_to_central', deliveryFeeOre: order.deliveryFeeOre },
        { reassignment: !!opts.reassignment },
      );
      const best = results.find((r) => r.feasible) ?? null;
      if (!best) {
        reject(results[0]?.violations[0] ?? 'Ingen gyldig placering i ruten');
        continue;
      }
      feasible.push({ driver: d, stockPlan: plan, best, reason: best.analysis.explanation[0] });
    }
    feasible.sort((a, b) => b.best!.analysis.score - a.best!.analysis.score);
    return { feasible, rejected };
  }

  async dispatch(orderId: number): Promise<void> {
    const { ctx } = this;
    const s = ctx.settings.get();
    let order = ctx.orders.get(orderId);
    if (!order) return;
    if (order.status === 'confirmed') order = ctx.orders.transition(orderId, 'awaiting_driver', 'system');
    if (order.status !== 'awaiting_driver') return;
    if (ctx.drivers.offers(orderId).some((o) => o.status === 'pending')) return;
    if (!s.installation.automationEnabled || !s.automation.autoDispatch) {
      ctx.orders.flag(orderId, 'Afventer manuel tildeling af chauffør');
      return;
    }
    const tried = ctx.drivers
      .offers(orderId)
      .filter((o) => ['rejected', 'expired', 'cancelled'].includes(o.status))
      .map((o) => o.driverId);
    const { feasible, rejected } = await this.evaluate(order, { exclude: tried });
    if (!feasible.length) {
      const waited = order.confirmedAt ? (Date.now() - new Date(order.confirmedAt).getTime()) / 60000 : 0;
      const why = rejected.map((r) => `${r.driver.name}: ${r.reason}`).join('; ') || 'ingen chauffører';
      ctx.orders.flag(orderId, 'Ingen forsvarlig løsning – kræver medarbejder');
      ctx.events.log('warn', 'dispatch', 'no_driver', `Ingen forsvarlig tildeling af ordre #${orderId} (${why})`, {
        requiresAction: true,
        dedupeKey: `no_driver:${orderId}`,
        dedupeMinutes: 30,
        data: { orderId },
      });
      if (waited > 20) {
        ctx.orders.transition(orderId, 'needs_manual', 'system', { reason: 'Ingen forsvarlig chaufførtildeling inden for 20 minutter' });
        return;
      }
      throw new RetryLaterError('Ingen chauffør – prøver igen', 60_000);
    }
    const best = feasible[0];
    const alternatives = [...feasible, ...rejected].map((c) => ({
      driverId: c.driver.id,
      driverName: c.driver.name,
      score: c.best?.analysis.score ?? 0,
      feasible: !!c.best,
      reason: c.best ? `Score ${c.best.analysis.score}, levering om ${c.best.analysis.newOrderEtaMinutes} min` : c.reason,
    }));
    if (!s.delivery.requireDriverAcceptance && !best.best!.analysis.significantChange) {
      const offerId = this.createOffer(order, best, alternatives, 'new_order', null, false);
      await this.acceptOffer(offerId, best.driver.id);
      if (ctx.orders.get(orderId)?.status === 'awaiting_driver') throw new RetryLaterError('Tildeling ikke gennemført – prøver igen', 5000);
      return;
    }
    this.createOffer(order, best, alternatives, 'new_order', null, true);
  }

  /** Opret et tilbud med den konkrete ruteplan. Gemmes i databasen (overlever genstart). */
  createOffer(order: Order, c: Candidate, alternatives: RoutePlanSummary['alternatives'], kind: 'new_order' | 'reassignment' | 'route_change', fromDriverId: number | null, send: boolean): number {
    const { ctx } = this;
    const s = ctx.settings.get();
    const r = c.best!;
    const plan: RoutePlanSummary = {
      sequence: r.sequence,
      insertIndex: r.insertIndex,
      newOrderId: order.id,
      etas: Object.fromEntries(r.etas.map((e) => [String(e.orderId), new Date(e.etaMs).toISOString()])),
      analysis: r.analysis,
      alternatives,
    };
    const expiresAt = new Date(Date.now() + s.delivery.offerTimeoutSeconds * 1000).toISOString();
    return ctx.db.transaction(() => {
      const ins = ctx.db
        .prepare(
          `INSERT INTO dispatch_offers (order_id, driver_id, status, score, sent_at, expires_at, kind, plan, route_version, from_driver_id)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(order.id, c.driver.id, r.analysis.score, new Date().toISOString(), expiresAt, kind, JSON.stringify(plan), c.driver.routeVersion, fromDriverId);
      const id = Number(ins.lastInsertRowid);
      ctx.orders.addEvent(order.id, 'offer_sent', 'system', {
        driverId: c.driver.id,
        driverName: c.driver.name,
        offerId: id,
        kind,
        stockPlan: c.stockPlan,
        score: r.analysis.score,
        explanation: r.analysis.explanation,
      });
      if (send) {
        ctx.telegram.sendToDriver(c.driver.id, this.offerText(order, c, kind), `offer:${id}`, {
          orderId: order.id,
          buttons: [[{ text: '✅ Accepter', data: `offer:${id}:accept` }, { text: '❌ Afvis', data: `offer:${id}:reject` }]],
        });
        ctx.jobs.enqueue('offer_timeout', { offerId: id }, { delayMs: s.delivery.offerTimeoutSeconds * 1000, dedupeKey: `offer_timeout:${id}`, lane: 'dispatch' });
      }
      ctx.bus.touch('logistics', 'orders', 'drivers');
      return id;
    })();
  }

  private offerText(order: Order, c: Candidate, kind: 'new_order' | 'reassignment' | 'route_change'): string {
    const r = c.best!;
    const items = order.lines.map((l) => `${l.quantity}× ${l.productName}`).join(', ');
    const pickup = c.stockPlan === 'central_pickup' || c.stockPlan === 'move_to_central' ? '\n📦 Afhentes på centrallageret' : '';
    const newEta = r.etas[r.insertIndex];
    const pos = `Stop ${r.insertIndex + 1} af ${r.sequence.length}`;
    const lines = [
      `${kind === 'reassignment' ? 'Overtag ordre' : kind === 'route_change' ? 'Ændret rækkefølge – ordre' : 'Ny ordre'} #${order.id}`,
      items,
      `Til: ${order.addressText}${pickup}`,
      `${pos} · ca. kl. ${formatTime(new Date(newEta.etaMs).toISOString())}`,
      `Beløb: ${formatDkk(order.totalOre)}`,
    ];
    const delayed = r.etas
      .filter((e) => e.orderId !== order.id)
      .map((e) => {
        const before = r.baseline.find((b) => b.orderId === e.orderId)!;
        return { id: e.orderId, d: Math.round((e.etaMs - before.etaMs) / 60000) };
      })
      .filter((x) => x.d >= 1);
    if (delayed.length) {
      lines.push(`⚠️ Ruteændring: ${delayed.map((x) => `#${x.id} ca. +${x.d} min`).join(', ')}`);
      lines.push(`Ny rækkefølge: ${r.sequence.map((x) => '#' + x).join(' → ')}`);
    }
    lines.push('', 'Accepterer du?');
    return lines.join('\n');
  }

  private async handleOfferTimeout(job: JobRow): Promise<void> {
    const offerId = job.payload.offerId as number;
    const offer = this.ctx.db.prepare(`SELECT * FROM dispatch_offers WHERE id = ?`).get(offerId) as
      | { status: string; order_id: number; driver_id: number; kind: string }
      | undefined;
    if (!offer || offer.status !== 'pending') return;
    this.ctx.db.prepare(`UPDATE dispatch_offers SET status = 'expired', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
    this.ctx.orders.addEvent(offer.order_id, 'offer_expired', 'system', { driverId: offer.driver_id, kind: offer.kind });
    this.ctx.telegram.sendToDriver(offer.driver_id, `Tilbuddet på ordre #${offer.order_id} er udløbet – din rute er uændret.`, `offer_expired:${offerId}`);
    this.ctx.bus.touch('logistics', 'drivers');
    if (offer.kind === 'route_change') {
      this.ctx.events.log('info', 'dispatch', 'route_change_expired', `Ruteændring for ordre #${offer.order_id} blev ikke accepteret – ruten er uændret`);
      return;
    }
    if (offer.kind === 'reassignment') {
      this.ctx.events.log('info', 'dispatch', 'reassignment_expired', `Omfordeling af ordre #${offer.order_id} blev ikke accepteret – ordren bliver hos nuværende chauffør`);
      return;
    }
    await this.dispatch(offer.order_id);
    this.dispatchWaiting();
  }

  /** Chaufførens svar på et tilbud (knap eller tekst). */
  async respondToOffer(offerId: number, driverId: number, accept: boolean): Promise<string> {
    const { ctx } = this;
    const offer = ctx.db.prepare(`SELECT * FROM dispatch_offers WHERE id = ?`).get(offerId) as
      | { id: number; status: string; order_id: number; driver_id: number; expires_at: string; kind: string }
      | undefined;
    if (!offer || offer.driver_id !== driverId) return 'Tilbuddet blev ikke fundet.';
    if (offer.status !== 'pending') return `Tilbuddet på ordre #${offer.order_id} er ikke længere aktivt.`;
    if (new Date(offer.expires_at).getTime() < Date.now()) return `Tilbuddet på ordre #${offer.order_id} er udløbet.`;
    ctx.jobs.cancelByDedupeKey(`offer_timeout:${offerId}`);
    this.routing.touchAnchor(driverId);
    if (!accept) {
      ctx.db.prepare(`UPDATE dispatch_offers SET status = 'rejected', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
      ctx.orders.addEvent(offer.order_id, 'offer_rejected', 'driver', { driverId, kind: offer.kind });
      ctx.bus.touch('logistics', 'drivers');
      this.dispatchWaiting();
      return `Ok, ordre #${offer.order_id} er afvist. Din rute er uændret.`;
    }
    return this.acceptOffer(offerId, driverId);
  }

  /**
   * Anvend et accepteret tilbud. Er chaufførens rute ændret siden planen blev
   * lavet (ruteversion), planlægges der igen; ændres løsningen væsentligt,
   * sendes et nyt tilbud i stedet for at gennemtvinge en ikke-accepteret plan.
   */
  async acceptOffer(offerId: number, driverId: number): Promise<string> {
    const { ctx } = this;
    const s = ctx.settings.get();
    const offer = ctx.db.prepare(`SELECT * FROM dispatch_offers WHERE id = ?`).get(offerId) as {
      order_id: number;
      kind: string;
      plan: string;
      route_version: number;
      from_driver_id: number | null;
    };
    const plan = JSON.parse(offer.plan) as RoutePlanSummary;
    let driver = ctx.drivers.get(driverId)!;
    let order = ctx.orders.get(offer.order_id)!;
    let sequence = plan.sequence;
    const cancelAndRedispatch = (msg: string) => {
      ctx.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
      if (offer.kind !== 'reassignment') this.enqueue(order.id);
      ctx.bus.touch('logistics', 'drivers');
      return msg;
    };
    if (offer.kind === 'route_change') {
      // Ændret rækkefølge i chaufførens egen rute – gælder kun hvis ruten er uændret siden forslaget
      const cancel = (msg: string) => {
        ctx.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
        ctx.bus.touch('logistics', 'drivers');
        return msg;
      };
      if (order.driverId !== driverId || !['driver_assigned', 'out_for_delivery'].includes(order.status)) return cancel(`Ruteændringen for ordre #${order.id} er ikke længere aktuel.`);
      if (driver.routeVersion !== offer.route_version) return cancel('Din rute er ændret siden forslaget – ruteændringen er annulleret. Kontoret kan bede om et nyt forslag.');
      ctx.db.transaction(() => {
        ctx.db.prepare(`UPDATE dispatch_offers SET status = 'accepted', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
        this.routing.applySequence(driverId, sequence.filter((id) => this.isActiveFor(id, driverId)), `ruteændring accepteret (#${order.id})`);
        ctx.orders.addEvent(order.id, 'route_change_accepted', 'driver', { sequence });
      })();
      await this.routing.refreshEtas(driverId, 'ruteændring accepteret');
      return `Tak! Ny rækkefølge: ${ctx.drivers.routeStops(driverId).map((x) => '#' + x.orderId).join(' → ')}.`;
    }
    const validStatus = offer.kind === 'reassignment' ? order.status === 'driver_assigned' && order.driverId === offer.from_driver_id : order.status === 'awaiting_driver';
    if (!validStatus) return cancelAndRedispatch(`Ordre #${order.id} kan ikke længere tildeles (status ændret).`);

    if (driver.routeVersion !== offer.route_version) {
      // Ruten er ændret siden tilbuddet – planlæg igen for samme chauffør
      const stockPlan = this.stockPlanFor(driver, order);
      const results = stockPlan
        ? await this.routing.planInsertion(
            driver,
            { id: order.id, point: { lat: order.addressLat!, lng: order.addressLng! }, needsPickup: stockPlan === 'central_pickup' || stockPlan === 'move_to_central', deliveryFeeOre: order.deliveryFeeOre },
            { reassignment: offer.kind === 'reassignment' },
          )
        : [];
      const best = results.find((r) => r.feasible);
      const offeredEta = new Date(plan.etas[String(order.id)]).getTime();
      const newEta = best ? best.etas[best.insertIndex].etaMs : Infinity;
      if (!best || best.analysis.significantChange || newEta - offeredEta > s.economics.significantChangeMinutes * 60000) {
        return cancelAndRedispatch(`Din rute er ændret siden tilbuddet på ordre #${order.id}. Der sendes et opdateret tilbud.`);
      }
      sequence = best.sequence;
      ctx.orders.addEvent(order.id, 'plan_revalidated', 'system', { previousVersion: offer.route_version, currentVersion: driver.routeVersion });
    }

    const wasIdle = this.routing.stops(driverId).length === 0;
    try {
      ctx.db.transaction(() => {
        order = ctx.orders.get(order.id)!;
        if (offer.kind === 'reassignment') {
          ctx.orders.transition(order.id, 'awaiting_driver', 'staff', { reason: 'Omfordeling accepteret', previousDriverId: offer.from_driver_id });
          ctx.db
            .prepare(`UPDATE drivers SET route_version = route_version + 1, current_order_id = CASE WHEN current_order_id = ? THEN NULL ELSE current_order_id END WHERE id = ?`)
            .run(order.id, offer.from_driver_id);
          order = ctx.orders.get(order.id)!;
        }
        this.moveStock(order, driver);
        ctx.orders.updateFields(order.id, { driverId, needsAttention: false, attentionReason: null }, 'system');
        ctx.orders.transition(order.id, 'driver_assigned', offer.kind === 'reassignment' ? 'staff' : 'driver', { driverId, driverName: driver.name, offerId });
        ctx.db.prepare(`UPDATE dispatch_offers SET status = 'accepted', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
        ctx.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled' WHERE order_id = ? AND status = 'pending' AND id <> ?`).run(order.id, offerId);
        if (wasIdle) {
          const prev = this.routing.getAnchor(driverId);
          const point = prev?.lat != null ? { lat: prev.lat, lng: prev.lng! } : driver.lastLat != null ? { lat: driver.lastLat, lng: driver.lastLng! } : null;
          this.routing.setAnchor(driverId, { kind: 'start', atMs: Date.now(), point });
        }
        this.routing.applySequence(driverId, sequence.filter((id) => id === order.id || this.isActiveFor(id, driverId)), `ordre #${order.id} accepteret`);
        if (driver.status === 'available') ctx.drivers.setStatus(driverId, 'busy');
      })();
    } catch (e) {
      if (e instanceof InsufficientStockError) return cancelAndRedispatch(`Ordre #${order.id} kunne ikke tildeles: varerne er ikke længere tilgængelige.`);
      throw e;
    }
    if (offer.kind === 'reassignment' && offer.from_driver_id) {
      ctx.telegram.sendToDriver(offer.from_driver_id, `Ordre #${order.id} er flyttet til en kollega. Din rute er opdateret.`, `reassigned_away:${order.id}:${offerId}`, { orderId: order.id });
      await this.routing.refreshEtas(offer.from_driver_id, 'omfordeling');
    }
    await this.afterAssignment(order.id, driverId);
    this.dispatchWaiting();
    return `Tak! Ordre #${order.id} er din.`;
  }

  private isActiveFor(orderId: number, driverId: number): boolean {
    const r = this.ctx.db.prepare(`SELECT 1 FROM orders WHERE id = ? AND driver_id = ? AND status IN ('driver_assigned','out_for_delivery')`).get(orderId, driverId);
    return !!r;
  }

  private moveStock(order: Order, driver: Driver): void {
    const { ctx } = this;
    const s = ctx.settings.get();
    const central = ctx.inventory.centralLocation();
    if (order.stockLocationId === driver.vehicleLocationId) return;
    if (driver.vehicleLocationId && ctx.inventory.canFulfil(driver.vehicleLocationId, this.needs(order))) {
      ctx.inventory.moveReservation(order.id, driver.vehicleLocationId);
    } else if (central && s.delivery.allowCentralPickup) {
      if (order.stockLocationId !== central.id) ctx.inventory.moveReservation(order.id, central.id);
    } else {
      throw new InsufficientStockError([]);
    }
  }

  private async afterAssignment(orderId: number, driverId: number): Promise<void> {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId)!;
    const refreshed = await this.routing.refreshEtas(driverId, `ordre #${orderId} tildelt`);
    const order = ctx.orders.get(orderId)!;
    const items = order.lines.map((l) => `${l.quantity}× ${l.productName}`).join('\n');
    const central = ctx.inventory.centralLocation();
    const pickup = central && order.stockLocationId === central.id ? '\n📦 Hent varerne på centrallageret først.' : '';
    const route = ctx.drivers.routeStops(driverId).map((r) => `#${r.orderId}`).join(' → ');
    ctx.telegram.sendToDriver(
      driverId,
      `Ordre #${order.id} er tildelt dig.\n${items}\nAdresse: ${order.addressText}${order.deliveryInstructions ? `\nBemærkning: ${order.deliveryInstructions}` : ''}\nKunde: ${order.customerName ?? ''} ${order.customerPhone}\nAt opkræve: ${formatDkk(order.totalOre)}${pickup}\nDin rute: ${route}\n\nSkriv gerne fx "ordre ${order.id}, der om 10 min" undervejs.`,
      `assigned:${order.id}:${driverId}`,
      {
        orderId: order.id,
        buttons: [
          [{ text: '🚗 Kører mod denne', data: `ord:${order.id}:pickup` }, { text: '⏱ Der om 5 min', data: `ord:${order.id}:eta5` }],
          [{ text: '📍 Fremme', data: `ord:${order.id}:arrived` }, { text: '✅ Leveret', data: `ord:${order.id}:delivered` }],
          [{ text: '📵 Kunden svarer ikke', data: `ord:${order.id}:unreachable` }, { text: '⏳ +10 min', data: `ord:${order.id}:delay10` }],
        ],
      },
    );
    const e = refreshed.etas.find((x) => x.orderId === orderId);
    const mode = ctx.settings.get().installation.mode;
    this.notifier.initial(orderId, driver.name.split(' ')[0], e?.etaMs ?? null, !!e && etaCommunicable(e.confidence, refreshed.quality, mode));
  }

  /** Medarbejder tildeler manuelt (bedste gyldige placering; ellers bagerst med advarsel). */
  async assign(orderId: number, driverId: number, actor: 'staff' | 'system'): Promise<void> {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId);
    if (!driver || !driver.active) throw new Error('Chauffør findes ikke eller er inaktiv');
    const order = ctx.orders.get(orderId);
    if (!order) throw new Error('Ordre findes ikke');
    if (order.status !== 'awaiting_driver') throw new Error(`Ordren har status ${order.status}`);
    const stockPlan = this.stockPlanFor(driver, order);
    if (!stockPlan) throw new Error(`${driver.name} har ikke de nødvendige varer, og centrallager-afhentning er ikke mulig`);
    const results = await this.routing.planInsertion(
      driver,
      { id: order.id, point: { lat: order.addressLat!, lng: order.addressLng! }, needsPickup: stockPlan === 'central_pickup' || stockPlan === 'move_to_central', deliveryFeeOre: order.deliveryFeeOre },
      { reassignment: false },
    );
    const best = results.find((r) => r.feasible) ?? results.find((r) => r.insertIndex === r.sequence.length - 1) ?? results[0];
    if (!best.feasible) {
      ctx.events.log('warn', 'dispatch', 'manual_override', `Manuel tildeling af ordre #${orderId} til ${driver.name} bryder: ${best.violations.join('; ')}`, {
        requiresAction: true,
        data: { orderId, driverId },
      });
    }
    const id = this.createOffer(order, { driver, stockPlan, best, reason: 'manuel' }, [], 'new_order', null, false);
    const msg = await this.acceptOffer(id, driverId);
    ctx.audit.record(actor, 'order_assign', 'order', orderId, { driverId, msg });
    if (!this.isActiveFor(orderId, driverId)) throw new Error(msg);
  }

  /** Fjern ordre fra chauffør og send den til ny dispatch. */
  async unassign(orderId: number, reason: string, actor: 'staff' | 'system'): Promise<void> {
    const { ctx } = this;
    const order = ctx.orders.get(orderId);
    if (!order?.driverId) throw new Error('Ordren har ingen chauffør');
    const driverId = order.driverId;
    ctx.orders.transition(orderId, 'awaiting_driver', actor, { reason, previousDriverId: driverId });
    ctx.db.prepare(`UPDATE drivers SET route_version = route_version + 1, current_order_id = CASE WHEN current_order_id = ? THEN NULL ELSE current_order_id END WHERE id = ?`).run(orderId, driverId);
    ctx.telegram.sendToDriver(driverId, `Ordre #${orderId} er taget fra dig (${reason}).`, `unassigned:${orderId}:${Date.now()}`);
    await this.routing.refreshEtas(driverId, 'ordre fjernet');
  }

  /**
   * Send et tilbud om en bestemt ordre til en bestemt chauffør (ledelsens
   * instruktion). Uden `force` kræves en gyldig løsning; med `force` (særlig
   * ledelsesbeslutning) bruges den bedste placering, selv om den bryder en
   * begrænsning – chaufføren skal stadig acceptere.
   */
  async offerToDriver(orderId: number, driverId: number, opts: { force?: boolean } = {}): Promise<{ ok: boolean; message: string; offerId?: number }> {
    const { ctx } = this;
    const order = ctx.orders.get(orderId);
    const driver = ctx.drivers.get(driverId);
    if (!order) return { ok: false, message: `Ordre #${orderId} findes ikke.` };
    if (!driver || !driver.active) return { ok: false, message: `Chauffør #${driverId} findes ikke.` };
    if (!['awaiting_driver', 'driver_assigned', 'confirmed'].includes(order.status)) return { ok: false, message: `Ordre #${orderId} kan ikke flyttes (status: ${order.status}).` };
    if (order.driverId === driverId) return { ok: false, message: `Ordre #${orderId} ligger allerede hos ${driver.name}.` };
    if (driver.pendingOfferCount > 0) return { ok: false, message: `${driver.name} har allerede et ubesvaret tilbud. Prøv igen om lidt.` };
    if (ctx.drivers.offers(orderId).some((o) => o.status === 'pending')) return { ok: false, message: `Ordre #${orderId} har allerede et ubesvaret tilbud.` };
    const reassignment = order.status === 'driver_assigned';
    if (order.status === 'confirmed') ctx.orders.transition(orderId, 'awaiting_driver', 'staff');
    const fresh = ctx.orders.get(orderId)!;
    const { feasible, rejected } = await this.evaluate(fresh, { reassignment });
    let cand = feasible.find((c) => c.driver.id === driverId) ?? null;
    if (!cand) {
      const why = rejected.find((r) => r.driver.id === driverId)?.reason ?? 'ingen gyldig placering';
      const plan = this.stockPlanFor(driver, fresh);
      if (!opts.force || !plan) {
        const alt = feasible[0];
        return {
          ok: false,
          message: `Kan ikke flytte ordre #${orderId} til ${driver.name}: ${why}.${alt ? ` Forslag: ${alt.driver.name} kan tage den (levering om ca. ${alt.best!.analysis.newOrderEtaMinutes} min).` : ''}${plan && !opts.force ? ' Skriv "flyt ordre ' + orderId + ' til chauffør ' + driverId + ' alligevel" for en særlig beslutning.' : ''}`,
        };
      }
      const results = await this.routing.planInsertion(
        driver,
        { id: fresh.id, point: { lat: fresh.addressLat!, lng: fresh.addressLng! }, needsPickup: plan === 'central_pickup' || plan === 'move_to_central', deliveryFeeOre: fresh.deliveryFeeOre },
        { reassignment },
      );
      const best = [...results].sort((a, b) => b.analysis.score - a.analysis.score)[0];
      best.analysis.explanation.push('Særlig ledelsesbeslutning: tildelt trods begrænsning');
      cand = { driver, stockPlan: plan, best, reason: 'ledelsesbeslutning' };
      ctx.events.log('warn', 'dispatch', 'management_override', `Ledelsen tildeler ordre #${orderId} til ${driver.name} trods: ${best.violations.join('; ') || why}`, { data: { orderId, driverId } });
    }
    const offerId = this.createOffer(fresh, cand, [], reassignment ? 'reassignment' : 'new_order', reassignment ? fresh.driverId : null, true);
    return { ok: true, offerId, message: `Tilbud sendt til ${driver.name} (ordre #${orderId}, stop ${cand.best!.insertIndex + 1} af ${cand.best!.sequence.length}). Ændringen gælder, når chaufføren accepterer.` };
  }

  /** Send en ændret rækkefølge til chaufføren (kræver altid chaufførens accept). */
  createRouteChangeOffer(driverId: number, orderId: number, sequence: number[], analysis: RoutePlanSummary['analysis'], etas: Record<string, string>): { ok: boolean; message: string; offerId?: number } {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId)!;
    if (driver.pendingOfferCount > 0) return { ok: false, message: `${driver.name} har allerede et ubesvaret tilbud. Prøv igen om lidt.` };
    const order = ctx.orders.get(orderId)!;
    const plan: RoutePlanSummary = { sequence, insertIndex: sequence.indexOf(orderId), newOrderId: orderId, etas, analysis, alternatives: [] };
    const s = ctx.settings.get();
    const expiresAt = new Date(Date.now() + s.delivery.offerTimeoutSeconds * 1000).toISOString();
    const id = ctx.db.transaction(() => {
      const r = ctx.db
        .prepare(`INSERT INTO dispatch_offers (order_id, driver_id, status, score, sent_at, expires_at, kind, plan, route_version) VALUES (?, ?, 'pending', ?, ?, ?, 'route_change', ?, ?)`)
        .run(orderId, driverId, analysis.score, new Date().toISOString(), expiresAt, JSON.stringify(plan), driver.routeVersion);
      const offerId = Number(r.lastInsertRowid);
      ctx.orders.addEvent(orderId, 'route_change_proposed', 'system', { driverId, sequence, explanation: analysis.explanation });
      ctx.telegram.sendToDriver(
        driverId,
        `Forslag til ny rækkefølge:\n${sequence.map((x, i) => `${i + 1}. #${x}${etas[String(x)] ? ` (ca. ${formatTime(etas[String(x)])})` : ''}`).join('\n')}\n${analysis.explanation.slice(0, 3).join('\n')}\n\nAccepterer du?`,
        `offer:${offerId}`,
        { orderId: order.id, buttons: [[{ text: '✅ Accepter', data: `offer:${offerId}:accept` }, { text: '❌ Afvis', data: `offer:${offerId}:reject` }]] },
      );
      ctx.jobs.enqueue('offer_timeout', { offerId }, { delayMs: s.delivery.offerTimeoutSeconds * 1000, dedupeKey: `offer_timeout:${offerId}`, lane: 'dispatch' });
      return offerId;
    })();
    ctx.bus.touch('logistics', 'drivers');
    return { ok: true, offerId: id, message: `Ruteændring sendt til ${driver.name} – gælder, når chaufføren accepterer.` };
  }

  /** Medarbejder anvender et omfordelingsforslag → tilbud til den nye chauffør (kræver accept). */
  async applySuggestion(id: number): Promise<void> {
    const { ctx } = this;
    const sug = ctx.db.prepare(`SELECT * FROM reassignment_suggestions WHERE id = ? AND status = 'open'`).get(id) as
      | { order_id: number; to_driver_id: number; from_driver_id: number }
      | undefined;
    if (!sug) throw new Error('Forslaget er ikke længere aktivt');
    const order = ctx.orders.get(sug.order_id);
    if (!order || order.status !== 'driver_assigned') throw new Error('Ordren kan ikke længere omfordeles');
    const driver = ctx.drivers.get(sug.to_driver_id)!;
    const { feasible } = await this.evaluate(order, { reassignment: true });
    const c = feasible.find((x) => x.driver.id === driver.id);
    if (!c) throw new Error(`${driver.name} kan ikke længere tage ordren forsvarligt`);
    this.createOffer(order, c, [], 'reassignment', sug.from_driver_id, true);
    ctx.db.prepare(`UPDATE reassignment_suggestions SET status = 'applied' WHERE id = ?`).run(id);
    ctx.audit.record('staff', 'apply_reassignment', 'order', sug.order_id, { toDriverId: sug.to_driver_id });
    ctx.bus.touch('logistics');
  }
}
