import type { Ctx } from '../context';
import type { DispatchAgent } from './dispatchAgent';
import type { RoutingService } from './routing';
import { AI_MODE_LABELS } from '../../shared/types';

/**
 * Logistics Agent + Monitoring Agent.
 * Hændelsesdrevet + et let periodisk tjek (hvert minut) – helt deterministisk,
 * ingen AI-kald. Overvåger tilbud, forsinkelser, uafklarede ordrer og
 * integrationer, og laver omfordelingsforslag.
 */
export class LogisticsAgent {
  constructor(
    private ctx: Ctx,
    private dispatch: DispatchAgent,
    private routing: RoutingService,
  ) {
    ctx.jobs.register('expire_quote', async (job) => this.expireQuote(job.payload.orderId as number));
    ctx.jobs.register('logistics_tick', async () => {
      try {
        await this.tick();
      } finally {
        ctx.jobs.enqueue('logistics_tick', {}, { delayMs: 60_000, dedupeKey: 'logistics_tick' });
      }
    });
    ctx.bus.on('integration_state', ({ name, state }: { name: string; state: string }) => {
      if (state === 'error' && name === 'sms') {
        ctx.events.log('critical', 'monitoring', 'sms_down', 'SMS-forbindelsen er nede. Automatiske kundesvar er sat i bero, indtil forbindelsen er genoprettet.', {
          requiresAction: true,
          dedupeKey: 'sms_down',
        });
      }
    });
  }

  start(): void {
    this.ctx.jobs.enqueue('logistics_tick', {}, { delayMs: 5_000, dedupeKey: 'logistics_tick' });
  }

  private expireQuote(orderId: number): void {
    const { ctx } = this;
    const o = ctx.orders.get(orderId);
    if (!o || o.status !== 'awaiting_confirmation') return;
    const age = Date.now() - new Date(o.updatedAt).getTime();
    const limit = ctx.settings.get().delivery.quoteExpiryMinutes * 60000;
    if (age < limit - 5000) {
      ctx.jobs.enqueue('expire_quote', { orderId }, { delayMs: limit - age, dedupeKey: `expire_quote:${orderId}` });
      return;
    }
    ctx.db.transaction(() => {
      ctx.orders.cancel(orderId, 'Tilbud udløbet', 'system');
      if (o.conversationId)
        ctx.sms.queue(o.conversationId, `Dit tilbud (ordre #${orderId}) er udløbet, og varerne er frigivet. Skriv igen, hvis du stadig vil bestille.`, 'system', `quote_expired:${orderId}`, orderId);
    })();
  }

  async tick(): Promise<void> {
    const { ctx } = this;
    const s = ctx.settings.get();
    const now = Date.now();

    // Udløbne tilbud (sikkerhedsnet, hvis jobbet gik tabt)
    for (const o of ctx.orders.list({ status: ['awaiting_confirmation'] })) {
      if (now - new Date(o.updatedAt).getTime() > s.delivery.quoteExpiryMinutes * 60000) this.expireQuote(o.id);
    }

    // Ordrer uden chauffør
    for (const o of ctx.orders.list({ status: ['awaiting_driver', 'confirmed'] })) {
      const hasPending = ctx.drivers.offers(o.id).some((x) => x.status === 'pending');
      if (!hasPending && s.installation.automationEnabled && s.automation.autoDispatch) {
        ctx.jobs.enqueue('dispatch_order', { orderId: o.id }, { dedupeKey: `dispatch:${o.id}`, lane: `order:${o.id}` });
      }
    }

    // Forsinkelser
    for (const o of ctx.orders.list({ status: ['driver_assigned', 'out_for_delivery'] })) {
      if (o.eta && now - new Date(o.eta).getTime() > 5 * 60000) {
        if (!o.needsAttention) ctx.orders.flag(o.id, 'Forsinket i forhold til ETA');
        ctx.events.log('warn', 'logistics', 'order_late', `Ordre #${o.id} er forsinket (ETA ${new Date(o.eta).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })})`, {
          dedupeKey: `order_late:${o.id}`,
          dedupeMinutes: 30,
          data: { orderId: o.id },
        });
      }
    }

    // Genberegn ruter, der er mere end 5 minutter gamle
    const stale = ctx.db
      .prepare(`SELECT DISTINCT driver_id FROM route_stops WHERE computed_at < ?`)
      .all(new Date(now - 5 * 60000).toISOString()) as { driver_id: number }[];
    for (const r of stale) await this.routing.recompute(r.driver_id);

    // Forældede positioner for chauffører med aktive ordrer
    for (const d of ctx.drivers.list()) {
      if (d.activeOrderCount === 0) continue;
      const age = d.lastPositionAt ? (now - new Date(d.lastPositionAt).getTime()) / 60000 : Infinity;
      if (age > s.delivery.maxPositionAgeMinutes) {
        ctx.events.log('info', 'logistics', 'stale_position', `Ingen frisk position fra ${d.name} – ETA'er er usikre og loves ikke til kunder`, {
          dedupeKey: `stale_position:${d.id}`,
          dedupeMinutes: 60,
        });
      }
    }

    await this.suggestReassignments();
    this.monitor();
  }

  /** Foreslå omfordeling, hvis en anden chauffør kan levere markant hurtigere. */
  async suggestReassignments(): Promise<void> {
    const { ctx } = this;
    const candidates = ctx.orders.list({ status: ['driver_assigned'] }).slice(0, 10);
    for (const o of candidates) {
      const open = ctx.db.prepare(`SELECT id FROM reassignment_suggestions WHERE order_id = ? AND status = 'open'`).get(o.id);
      if (open || !o.eta || !o.driverId) continue;
      const ranked = await this.dispatch.rankCandidates(o, [o.driverId]);
      const best = ranked.find((c) => c.etaMs && c.driver.status === 'available');
      if (!best?.etaMs) continue;
      const gain = (new Date(o.eta).getTime() - best.etaMs) / 60000;
      if (gain >= 15) {
        ctx.db
          .prepare(`INSERT INTO reassignment_suggestions (order_id, from_driver_id, to_driver_id, reason, eta_gain_minutes) VALUES (?, ?, ?, ?, ?)`)
          .run(o.id, o.driverId, best.driver.id, `${best.driver.name} kan levere ca. ${Math.round(gain)} min hurtigere`, gain);
        ctx.bus.touch('logistics');
      }
    }
    // Luk forældede forslag
    ctx.db
      .prepare(
        `UPDATE reassignment_suggestions SET status = 'dismissed' WHERE status = 'open' AND order_id IN (SELECT id FROM orders WHERE status <> 'driver_assigned')`,
      )
      .run();
  }

  /** Monitoring: ting, der kræver menneskelig handling. */
  monitor(): void {
    const { ctx } = this;
    const waiting = ctx.db
      .prepare(
        `SELECT c.id, c.ai_mode, MAX(m.created_at) AS last_in FROM conversations c JOIN messages m ON m.conversation_id = c.id AND m.direction = 'in'
         WHERE c.ai_mode <> 'ai_active' AND c.unread_count > 0 GROUP BY c.id`,
      )
      .all() as { id: number; ai_mode: keyof typeof AI_MODE_LABELS; last_in: string }[];
    for (const w of waiting) {
      if (Date.now() - new Date(w.last_in).getTime() > 5 * 60000) {
        ctx.events.log('warn', 'monitoring', 'customer_waiting', `En kunde har ventet over 5 minutter på svar (${AI_MODE_LABELS[w.ai_mode]})`, {
          requiresAction: true,
          dedupeKey: `customer_waiting:${w.id}`,
          dedupeMinutes: 30,
          data: { conversationId: w.id },
        });
      }
    }
    const uncertain = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE status = 'uncertain'`).get() as { c: number }).c;
    if (uncertain > 0) {
      ctx.events.log('error', 'monitoring', 'uncertain_messages', `${uncertain} besked(er) har ukendt afsendelsesstatus og skal kontrolleres`, {
        requiresAction: true,
        dedupeKey: 'uncertain_messages',
        dedupeMinutes: 60,
      });
    }
    const manual = ctx.orders.list({ status: ['needs_manual'] }).length;
    if (manual > 0) {
      ctx.events.log('warn', 'monitoring', 'manual_orders', `${manual} ordre(r) kræver manuel behandling`, {
        requiresAction: true,
        dedupeKey: 'manual_orders',
        dedupeMinutes: 30,
      });
    }
    const dead = ctx.jobs.stats().dead;
    if (dead > 0) {
      ctx.events.log('warn', 'monitoring', 'dead_jobs', `${dead} baggrundsopgave(r) er fejlet permanent`, { dedupeKey: 'dead_jobs', dedupeMinutes: 120 });
    }
  }
}
