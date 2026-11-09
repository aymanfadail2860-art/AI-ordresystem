import type { Ctx } from '../context';
import type { JobRow } from '../jobs/jobQueue';
import { RetryLaterError } from '../jobs/jobQueue';
import type { Driver, Order } from '../../shared/types';
import type { RoutingService } from './routing';
import { InsufficientStockError } from '../services/inventory';
import { formatDkk } from '../../core/money';
import { etaIsCommunicable, formatTime } from './replies';

export type StockPlan = 'own_vehicle' | 'move_to_vehicle' | 'central_pickup' | 'move_to_central';

export interface Candidate {
  driver: Driver;
  stockPlan: StockPlan;
  etaMs: number | null;
  score: number;
  positionFresh: boolean;
  quality: string;
}

/**
 * Dispatch Agent – deterministisk chaufførvalg.
 * Vægter forventet leveringstid, lager i bilen, arbejdsbyrde og
 * påvirkning af eksisterende leveringsløfter. Ingen sprogmodel nødvendig.
 */
export class DispatchAgent {
  constructor(
    private ctx: Ctx,
    private routing: RoutingService,
  ) {
    ctx.jobs.register('dispatch_order', (job) => this.handleDispatch(job));
    ctx.jobs.register('offer_timeout', (job) => this.handleOfferTimeout(job));
  }

  private async handleDispatch(job: JobRow): Promise<void> {
    await this.dispatch(job.payload.orderId as number);
  }

  private needs(order: Order) {
    return order.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }));
  }

  /** Find og rangér mulige chauffører for en ordre. */
  async rankCandidates(order: Order, exclude: number[] = []): Promise<Candidate[]> {
    const { ctx } = this;
    const s = ctx.settings.get();
    if (order.addressLat == null) return [];
    const central = ctx.inventory.centralLocation();
    const needs = this.needs(order);
    const drivers = ctx.drivers
      .list()
      .filter((d) => (d.status === 'available' || d.status === 'busy') && !exclude.includes(d.id))
      .filter((d) => d.activeOrderCount < d.maxActiveOrders || d.id === order.driverId)
      .filter((d) => !!d.telegramChatId || ctx.telegram.current?.simulated);
    const out: Candidate[] = [];
    for (const d of drivers) {
      let plan: StockPlan | null = null;
      if (order.stockLocationId && order.stockLocationId === d.vehicleLocationId) plan = 'own_vehicle';
      else if (d.vehicleLocationId && ctx.inventory.canFulfil(d.vehicleLocationId, needs)) plan = 'move_to_vehicle';
      else if (s.delivery.allowCentralPickup && central && order.stockLocationId === central.id) plan = 'central_pickup';
      else if (s.delivery.allowCentralPickup && central && ctx.inventory.canFulfil(central.id, needs)) plan = 'move_to_central';
      if (!plan) continue; // chaufføren kan ikke få varerne → må ikke tildeles
      const route = await this.routing.plan(d, {
        orderId: order.id,
        point: { lat: order.addressLat, lng: order.addressLng! },
        needsCentralPickup: plan === 'central_pickup' || plan === 'move_to_central',
      });
      if (!route) continue;
      const stop = route.stops.find((x) => x.orderId === order.id);
      const etaMs = stop?.etaMs ?? null;
      const etaMin = etaMs ? (etaMs - Date.now()) / 60000 : 120;
      const score =
        etaMin +
        d.activeOrderCount * 4 +
        (plan === 'own_vehicle' ? 0 : plan === 'move_to_vehicle' ? 1 : 3) +
        (route.positionFresh ? 0 : 6) +
        (d.status === 'available' ? 0 : 2);
      out.push({ driver: d, stockPlan: plan, etaMs, score, positionFresh: route.positionFresh, quality: route.quality });
    }
    return out.sort((a, b) => a.score - b.score);
  }

  async dispatch(orderId: number): Promise<void> {
    const { ctx } = this;
    const s = ctx.settings.get();
    let order = ctx.orders.get(orderId);
    if (!order) return;
    if (order.status === 'confirmed') order = ctx.orders.transition(orderId, 'awaiting_driver', 'system');
    if (order.status !== 'awaiting_driver') return;
    const pending = ctx.drivers.offers(orderId).find((o) => o.status === 'pending');
    if (pending) return; // et tilbud er allerede ude
    if (!s.installation.automationEnabled || !s.automation.autoDispatch) {
      ctx.orders.flag(orderId, 'Afventer manuel tildeling af chauffør');
      return;
    }
    const declined = ctx.drivers
      .offers(orderId)
      .filter((o) => o.status === 'rejected' || o.status === 'expired')
      .map((o) => o.driverId);
    const candidates = await this.rankCandidates(order, declined);
    if (!candidates.length) {
      const waited = order.confirmedAt ? (Date.now() - new Date(order.confirmedAt).getTime()) / 60000 : 0;
      ctx.orders.flag(orderId, 'Ingen ledig chauffør med de nødvendige varer');
      ctx.events.log('warn', 'dispatch', 'no_driver', `Ingen ledig chauffør til ordre #${orderId}`, {
        requiresAction: true,
        dedupeKey: `no_driver:${orderId}`,
        dedupeMinutes: 30,
        data: { orderId },
      });
      if (waited > 20) {
        ctx.orders.transition(orderId, 'needs_manual', 'system', { reason: 'Ingen chauffør inden for 20 minutter' });
        return;
      }
      throw new RetryLaterError('Ingen chauffør – prøver igen', 60_000);
    }
    const best = candidates[0];
    if (!s.delivery.requireDriverAcceptance) {
      await this.assign(orderId, best.driver.id, 'system');
      return;
    }
    this.sendOffer(order, best);
  }

  private sendOffer(order: Order, c: Candidate): void {
    const { ctx } = this;
    const s = ctx.settings.get();
    const expiresAt = new Date(Date.now() + s.delivery.offerTimeoutSeconds * 1000).toISOString();
    const offerId = ctx.db.transaction(() => {
      const r = ctx.db
        .prepare(`INSERT INTO dispatch_offers (order_id, driver_id, status, score, sent_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?)`)
        .run(order.id, c.driver.id, c.score, new Date().toISOString(), expiresAt);
      const id = Number(r.lastInsertRowid);
      ctx.orders.addEvent(order.id, 'offer_sent', 'system', { driverId: c.driver.id, driverName: c.driver.name, offerId: id, stockPlan: c.stockPlan });
      const items = order.lines.map((l) => `${l.quantity}× ${l.productName}`).join(', ');
      const pickup = c.stockPlan === 'central_pickup' || c.stockPlan === 'move_to_central' ? '\n📦 Afhentes på centrallageret' : '';
      const eta = c.etaMs ? `\nEstimeret levering: ca. ${formatTime(new Date(c.etaMs).toISOString())}` : '';
      ctx.telegram.sendToDriver(
        c.driver.id,
        `Ny ordre #${order.id}\n${items}\nTil: ${order.addressText}${pickup}${eta}\nBeløb: ${formatDkk(order.totalOre)}\n\nKan du tage den?`,
        `offer:${id}`,
        { orderId: order.id, buttons: [[{ text: '✅ Accepter', data: `offer:${id}:accept` }, { text: '❌ Afvis', data: `offer:${id}:reject` }]] },
      );
      ctx.jobs.enqueue('offer_timeout', { offerId: id }, { delayMs: s.delivery.offerTimeoutSeconds * 1000, dedupeKey: `offer_timeout:${id}` });
      return id;
    })();
    ctx.bus.touch('logistics', 'orders');
    ctx.bus.emit('offer_sent', { offerId, orderId: order.id, driverId: c.driver.id });
  }

  private async handleOfferTimeout(job: JobRow): Promise<void> {
    const offerId = job.payload.offerId as number;
    const offer = this.ctx.db.prepare(`SELECT * FROM dispatch_offers WHERE id = ?`).get(offerId) as { status: string; order_id: number; driver_id: number } | undefined;
    if (!offer || offer.status !== 'pending') return;
    this.ctx.db.prepare(`UPDATE dispatch_offers SET status = 'expired', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
    this.ctx.orders.addEvent(offer.order_id, 'offer_expired', 'system', { driverId: offer.driver_id });
    this.ctx.telegram.sendToDriver(offer.driver_id, `Tilbuddet på ordre #${offer.order_id} er udløbet.`, `offer_expired:${offerId}`);
    await this.dispatch(offer.order_id);
  }

  /** Chaufførens svar på et tilbud (knap eller tekst). */
  async respondToOffer(offerId: number, driverId: number, accept: boolean): Promise<string> {
    const { ctx } = this;
    const offer = ctx.db.prepare(`SELECT * FROM dispatch_offers WHERE id = ?`).get(offerId) as
      | { id: number; status: string; order_id: number; driver_id: number; expires_at: string }
      | undefined;
    if (!offer || offer.driver_id !== driverId) return 'Tilbuddet blev ikke fundet.';
    if (offer.status !== 'pending') return `Tilbuddet på ordre #${offer.order_id} er ikke længere aktivt.`;
    if (new Date(offer.expires_at).getTime() < Date.now()) return `Tilbuddet på ordre #${offer.order_id} er udløbet.`;
    ctx.jobs.cancelByDedupeKey(`offer_timeout:${offerId}`);
    if (!accept) {
      ctx.db.prepare(`UPDATE dispatch_offers SET status = 'rejected', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
      ctx.orders.addEvent(offer.order_id, 'offer_rejected', 'driver', { driverId });
      ctx.jobs.enqueue('dispatch_order', { orderId: offer.order_id }, { dedupeKey: `dispatch:${offer.order_id}`, lane: `order:${offer.order_id}` });
      return `Ok, ordre #${offer.order_id} er afvist.`;
    }
    ctx.db.prepare(`UPDATE dispatch_offers SET status = 'accepted', responded_at = ? WHERE id = ?`).run(new Date().toISOString(), offerId);
    try {
      await this.assign(offer.order_id, driverId, 'driver');
      return `Tak! Ordre #${offer.order_id} er din.`;
    } catch (e) {
      ctx.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled' WHERE id = ?`).run(offerId);
      ctx.jobs.enqueue('dispatch_order', { orderId: offer.order_id }, { dedupeKey: `dispatch:${offer.order_id}`, lane: `order:${offer.order_id}` });
      return `Ordre #${offer.order_id} kunne ikke tildeles dig: ${(e as Error).message}`;
    }
  }

  /**
   * Tildel ordre til chauffør. Lagerreservationen flyttes atomisk til den
   * relevante lokation – fejler det, tildeles ordren ikke.
   */
  async assign(orderId: number, driverId: number, actor: 'system' | 'staff' | 'driver'): Promise<void> {
    const { ctx } = this;
    const s = ctx.settings.get();
    const driver = ctx.drivers.get(driverId);
    if (!driver || !driver.active) throw new Error('Chauffør findes ikke eller er inaktiv');
    ctx.db.transaction(() => {
      const order = ctx.orders.get(orderId);
      if (!order) throw new Error('Ordre findes ikke');
      if (order.status !== 'awaiting_driver') throw new Error(`Ordren har status ${order.status}`);
      const needs = this.needs(order);
      const central = ctx.inventory.centralLocation();
      if (order.stockLocationId !== driver.vehicleLocationId) {
        if (driver.vehicleLocationId && ctx.inventory.canFulfil(driver.vehicleLocationId, needs)) {
          ctx.inventory.moveReservation(orderId, driver.vehicleLocationId);
        } else if (central && s.delivery.allowCentralPickup) {
          if (order.stockLocationId !== central.id) ctx.inventory.moveReservation(orderId, central.id);
        } else {
          throw new InsufficientStockError([]);
        }
      }
      ctx.orders.updateFields(orderId, { driverId, needsAttention: false, attentionReason: null }, actor);
      ctx.orders.transition(orderId, 'driver_assigned', actor, { driverId, driverName: driver.name });
      ctx.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).run(orderId);
      if (driver.status === 'available') ctx.drivers.setStatus(driverId, 'busy');
    })();
    await this.routing.recompute(driverId);
    const order = ctx.orders.get(orderId)!;
    const items = order.lines.map((l) => `${l.quantity}× ${l.productName}`).join('\n');
    const central = ctx.inventory.centralLocation();
    const pickup = central && order.stockLocationId === central.id ? '\n📦 Hent varerne på centrallageret først.' : '';
    ctx.telegram.sendToDriver(
      driverId,
      `Ordre #${order.id} er tildelt dig.\n${items}\nAdresse: ${order.addressText}${order.deliveryInstructions ? `\nBemærkning: ${order.deliveryInstructions}` : ''}\nKunde: ${order.customerName ?? ''} ${order.customerPhone}\nAt opkræve: ${formatDkk(order.totalOre)}${pickup}`,
      `assigned:${order.id}:${driverId}`,
      {
        orderId: order.id,
        buttons: [
          [{ text: '🚗 Kører nu', data: `ord:${order.id}:pickup` }, { text: '📍 Fremme', data: `ord:${order.id}:arrived` }],
          [{ text: '✅ Leveret', data: `ord:${order.id}:delivered` }, { text: '📵 Kunden svarer ikke', data: `ord:${order.id}:unreachable` }],
          [{ text: '⏱ +15 min forsinket', data: `ord:${order.id}:delay15` }],
        ],
      },
    );
    if (order.conversationId) {
      const firstName = driver.name.split(' ')[0];
      const eta = etaIsCommunicable(order, s.installation.mode) ? ` Forventet levering ca. kl. ${formatTime(order.eta!)}.` : '';
      ctx.sms.queue(order.conversationId, `${firstName} kører med din ordre #${order.id}.${eta}`, 'system', `assigned_notice:${order.id}:${driverId}`, order.id);
      if (eta) ctx.orders.updateFields(order.id, { etaCommunicated: order.eta }, 'system');
    }
  }

  /** Fjern ordre fra chauffør og send den til ny dispatch (fx ved omfordeling). */
  async unassign(orderId: number, reason: string, actor: 'staff' | 'system'): Promise<void> {
    const { ctx } = this;
    const order = ctx.orders.get(orderId);
    if (!order?.driverId) throw new Error('Ordren har ingen chauffør');
    const driverId = order.driverId;
    ctx.orders.transition(orderId, 'awaiting_driver', actor, { reason, previousDriverId: driverId });
    ctx.telegram.sendToDriver(driverId, `Ordre #${orderId} er taget fra dig (${reason}).`, `unassigned:${orderId}:${Date.now()}`);
    await this.routing.recompute(driverId);
  }

  /** Anvend et omfordelingsforslag (medarbejderhandling). */
  async applySuggestion(id: number): Promise<void> {
    const { ctx } = this;
    const sug = ctx.db.prepare(`SELECT * FROM reassignment_suggestions WHERE id = ? AND status = 'open'`).get(id) as
      | { order_id: number; to_driver_id: number }
      | undefined;
    if (!sug) throw new Error('Forslaget er ikke længere aktivt');
    const order = ctx.orders.get(sug.order_id);
    if (!order || order.status !== 'driver_assigned') throw new Error('Ordren kan ikke længere omfordeles');
    await this.unassign(sug.order_id, 'omfordelt af kontoret', 'staff');
    await this.assign(sug.order_id, sug.to_driver_id, 'staff');
    ctx.db.prepare(`UPDATE reassignment_suggestions SET status = 'applied' WHERE id = ?`).run(id);
    ctx.audit.record('staff', 'apply_reassignment', 'order', sug.order_id, { toDriverId: sug.to_driver_id });
    ctx.bus.touch('logistics');
  }
}
