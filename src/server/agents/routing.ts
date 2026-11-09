import type { Ctx } from '../context';
import type { LatLng } from '../../core/geo';
import type { Driver } from '../../shared/types';
import type { TravelResult } from '../services/maps';

export const SERVICE_MINUTES_PER_STOP = 3;

export interface PlannedStop {
  orderId: number;
  etaMs: number;
  durationFromPrevS: number;
  distanceFromPrevM: number;
}

export interface RoutePlan {
  stops: PlannedStop[];
  startedFrom: 'position' | 'central' | 'unknown';
  quality: 'live' | 'simulated' | 'fallback';
  positionFresh: boolean;
  needsPickup: boolean;
}

interface StopInput {
  orderId: number;
  point: LatLng;
  promisedMs: number | null;
}

/**
 * Ruteplanlægning (Logistics). Rækkefølgen bestemmes lokalt med
 * billigste-indsættelse, der vægter samlet køretid OG overskridelse af
 * allerede givne leveringsløfter – ikke kun korteste afstand.
 */
export function cheapestInsertionOrder(
  start: number,
  stops: StopInput[],
  matrix: TravelResult[][],
  nowMs: number,
  pointIndex: (i: number) => number,
): number[] {
  const order: number[] = [];
  const remaining = stops.map((_, i) => i);
  const cost = (seq: number[]): number => {
    let t = nowMs;
    let prev = start;
    let total = 0;
    for (const i of seq) {
      const leg = matrix[prev][pointIndex(i)];
      t += leg.durationS * 1000;
      total += leg.durationS;
      const promised = stops[i].promisedMs;
      if (promised && t > promised) total += ((t - promised) / 1000) * 2; // forsinkelse vægtes dobbelt
      t += SERVICE_MINUTES_PER_STOP * 60000;
      prev = pointIndex(i);
    }
    return total;
  };
  while (remaining.length) {
    let best: { r: number; pos: number; c: number } | null = null;
    for (const r of remaining) {
      for (let pos = 0; pos <= order.length; pos++) {
        const seq = [...order.slice(0, pos), r, ...order.slice(pos)];
        const c = cost(seq);
        if (!best || c < best.c) best = { r, pos, c };
      }
    }
    order.splice(best!.pos, 0, best!.r);
    remaining.splice(remaining.indexOf(best!.r), 1);
  }
  return order;
}

export class RoutingService {
  constructor(private ctx: Ctx) {}

  driverStart(driver: Driver): { point: LatLng | null; source: RoutePlan['startedFrom']; fresh: boolean } {
    const s = this.ctx.settings.get();
    if (driver.lastLat != null && driver.lastPositionAt) {
      const age = Date.now() - new Date(driver.lastPositionAt).getTime();
      const fresh = age <= s.delivery.maxPositionAgeMinutes * 60000;
      if (fresh) return { point: { lat: driver.lastLat, lng: driver.lastLng! }, source: 'position', fresh: true };
    }
    const central = this.ctx.inventory.centralLocation();
    if (central?.lat != null) return { point: { lat: central.lat, lng: central.lng! }, source: 'central', fresh: false };
    if (driver.lastLat != null) return { point: { lat: driver.lastLat, lng: driver.lastLng! }, source: 'position', fresh: false };
    return { point: null, source: 'unknown', fresh: false };
  }

  /**
   * Planlæg ruten for en chauffør med eventuelt en ekstra (hypotetisk) ordre.
   * Bruges både til tildeling (simulering) og til at gemme den faktiske rute.
   */
  async plan(driver: Driver, extra?: { orderId: number; point: LatLng; needsCentralPickup: boolean }): Promise<RoutePlan | null> {
    const { ctx } = this;
    const start = this.driverStart(driver);
    if (!start.point) return null;
    const rows = ctx.db
      .prepare(
        `SELECT id, address_lat, address_lng, eta_communicated, status, stock_location_id FROM orders
         WHERE driver_id = ? AND status IN ('driver_assigned','out_for_delivery') AND address_lat IS NOT NULL`,
      )
      .all(driver.id) as { id: number; address_lat: number; address_lng: number; eta_communicated: string | null; status: string; stock_location_id: number | null }[];
    const central = ctx.inventory.centralLocation();
    const stops: StopInput[] = rows.map((r) => ({
      orderId: r.id,
      point: { lat: r.address_lat, lng: r.address_lng },
      promisedMs: r.eta_communicated ? new Date(r.eta_communicated).getTime() : null,
    }));
    let needsPickup = rows.some((r) => r.status === 'driver_assigned' && central && r.stock_location_id === central.id);
    if (extra) {
      stops.push({ orderId: extra.orderId, point: extra.point, promisedMs: null });
      needsPickup = needsPickup || extra.needsCentralPickup;
    }
    if (!stops.length) return { stops: [], startedFrom: start.source, quality: 'live', positionFresh: start.fresh, needsPickup: false };

    // Punkter: 0 = start, (1 = centrallager ved afhentning), derefter stop
    const points: LatLng[] = [start.point];
    const pickupIdx = needsPickup && central?.lat != null ? points.push({ lat: central.lat, lng: central.lng! }) - 1 : -1;
    const base = points.length;
    for (const st of stops) points.push(st.point);
    const matrix = await ctx.maps.matrix(points, points);
    const quality: RoutePlan['quality'] = matrix.flat().some((m) => m.quality === 'fallback')
      ? 'fallback'
      : matrix.flat().some((m) => m.quality === 'simulated')
        ? 'simulated'
        : 'live';

    let now = Date.now();
    let first = 0;
    if (pickupIdx >= 0) {
      now += matrix[0][pickupIdx].durationS * 1000 + ctx.settings.get().delivery.defaultPrepMinutes * 60000;
      first = pickupIdx;
    }
    const seq = cheapestInsertionOrder(first, stops, matrix, now, (i) => base + i);
    const planned: PlannedStop[] = [];
    let t = now;
    let prev = first;
    for (const i of seq) {
      const leg = matrix[prev][base + i];
      t += leg.durationS * 1000;
      planned.push({ orderId: stops[i].orderId, etaMs: t, durationFromPrevS: leg.durationS, distanceFromPrevM: leg.distanceM });
      t += SERVICE_MINUTES_PER_STOP * 60000;
      prev = base + i;
    }
    return { stops: planned, startedFrom: start.source, quality, positionFresh: start.fresh, needsPickup };
  }

  /** Genberegn og gem chaufførens rute + ETA'er. Advarer kunder ved væsentlig forsinkelse. */
  async recompute(driverId: number): Promise<RoutePlan | null> {
    const { ctx } = this;
    const driver = ctx.drivers.get(driverId);
    if (!driver) return null;
    const plan = await this.plan(driver);
    const s = ctx.settings.get();
    ctx.db.transaction(() => {
      ctx.db.prepare(`DELETE FROM route_stops WHERE driver_id = ?`).run(driverId);
      if (!plan) return;
      const ins = ctx.db.prepare(
        `INSERT INTO route_stops (driver_id, order_id, sequence, eta, duration_from_prev_s, distance_from_prev_m, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // ETA-kilde: kun 'route_live' (rigtige kortdata + frisk position) må loves til kunder i drift
      const etaSource =
        plan.quality === 'live' && plan.positionFresh ? 'route_live' : plan.quality === 'simulated' ? 'route_simulated' : 'estimate';
      plan.stops.forEach((st, i) => {
        const eta = new Date(st.etaMs).toISOString();
        ins.run(driverId, st.orderId, i + 1, eta, st.durationFromPrevS, st.distanceFromPrevM, new Date().toISOString());
        ctx.orders.updateFields(st.orderId, { eta, etaSource }, 'system');
        this.maybeNotifyDelay(st.orderId, st.etaMs, s);
      });
    })();
    ctx.bus.touch('logistics', 'orders');
    return plan;
  }

  private maybeNotifyDelay(orderId: number, etaMs: number, s: ReturnType<Ctx['settings']['get']>): void {
    const { ctx } = this;
    const o = ctx.orders.get(orderId);
    if (!o?.conversationId || !s.automation.customerEtaUpdates || !s.installation.automationEnabled) return;
    const row = ctx.db.prepare(`SELECT eta_communicated, eta_source FROM orders WHERE id = ?`).get(orderId) as { eta_communicated: string | null; eta_source: string | null };
    if (!row.eta_communicated) return;
    const promised = new Date(row.eta_communicated).getTime();
    if (etaMs - promised < 10 * 60000) return;
    const communicable = row.eta_source === 'route_live' || (s.installation.mode === 'demo' && row.eta_source === 'route_simulated');
    const rounded = Math.ceil(etaMs / 300000) * 300000;
    const text = communicable
      ? `Din levering (ordre #${orderId}) er desværre forsinket. Ny forventet tid er ca. kl. ${new Date(rounded).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}.`
      : `Din levering (ordre #${orderId}) er desværre forsinket. Vi giver besked, når chaufføren er tæt på.`;
    ctx.sms.queue(o.conversationId, text, 'system', `eta_delay:${orderId}:${rounded}`, orderId);
    ctx.orders.updateFields(orderId, { etaCommunicated: new Date(rounded).toISOString() }, 'system');
  }
}
