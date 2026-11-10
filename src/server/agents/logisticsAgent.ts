import { DEFAULT_TZ } from '../../core/time';
import type { Ctx } from '../context';
import type { DispatchAgent } from './dispatchAgent';
import type { RoutingService } from './routing';
import { AI_MODE_LABELS } from '../../shared/types';
import { clock } from '../clock';

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
    const age = clock.now() - new Date(o.updatedAt).getTime();
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
    const now = clock.now();

    // Udløbne tilbud (sikkerhedsnet, hvis jobbet gik tabt)
    for (const o of ctx.orders.list({ status: ['awaiting_confirmation'] })) {
      if (now - new Date(o.updatedAt).getTime() > s.delivery.quoteExpiryMinutes * 60000) this.expireQuote(o.id);
    }

    // Ordrer uden chauffør
    for (const o of ctx.orders.list({ status: ['awaiting_driver', 'confirmed'] })) {
      const hasPending = ctx.drivers.offers(o.id).some((x) => x.status === 'pending');
      if (!hasPending && s.installation.automationEnabled && s.automation.autoDispatch) this.dispatch.enqueue(o.id);
    }

    // Genberegn ETA'er for alle aktive ruter (status bliver forældet med tiden)
    const drivers = ctx.drivers.list();
    for (const d of drivers) {
      if (d.activeOrderCount > 0) await this.routing.refreshEtas(d.id, 'periodisk kontrol');
    }

    // Overskredne løfter
    for (const o of ctx.orders.list({ status: ['driver_assigned', 'out_for_delivery'] })) {
      const promised = ctx.db.prepare(`SELECT eta_communicated FROM orders WHERE id = ?`).get(o.id) as { eta_communicated: string | null };
      if (promised.eta_communicated && now - new Date(promised.eta_communicated).getTime() > 5 * 60000) {
        if (!o.needsAttention) ctx.orders.flag(o.id, 'Leveringsløftet er overskredet');
        ctx.events.log('warn', 'logistics', 'order_late', `Ordre #${o.id} er forsinket i forhold til det lovede tidspunkt (${new Date(promised.eta_communicated).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: DEFAULT_TZ })})`, {
          dedupeKey: `order_late:${o.id}`,
          dedupeMinutes: 30,
          data: { orderId: o.id },
        });
      }
    }

    // Chauffører uden status: bed om status, og eskalér hvis der ikke svares
    for (const d of drivers) {
      if (d.activeOrderCount === 0) continue;
      const anchor = this.routing.getAnchor(d.id);
      const lastInfo = Math.max(anchor?.reportedAtMs ?? 0, d.lastStatusAt ? new Date(d.lastStatusAt).getTime() : 0);
      const ageMin = (now - lastInfo) / 60000;
      const reqAt = (ctx.db.prepare(`SELECT status_request_sent_at FROM drivers WHERE id = ?`).get(d.id) as { status_request_sent_at: string | null }).status_request_sent_at;
      if (ageMin >= s.logistics.statusRequestAfterMinutes && !reqAt) {
        const next = ctx.drivers.routeStops(d.id)[0];
        ctx.telegram.sendToDriver(
          d.id,
          `Hej ${d.name.split(' ')[0]} – hvordan går det?${next ? ` Hvornår er du ved ordre #${next.orderId}?` : ''} Svar fx "ordre ${next?.orderId ?? 142}, der om 10 min".`,
          `status_request:${d.id}:${Math.floor(now / 600000)}`,
        );
        ctx.db.prepare(`UPDATE drivers SET status_request_sent_at = ? WHERE id = ?`).run(new Date(now).toISOString(), d.id);
      } else if (reqAt && ageMin >= s.logistics.escalateNoStatusMinutes) {
        ctx.events.log('warn', 'logistics', 'driver_no_status', `${d.name} har ikke givet status i ${Math.round(ageMin)} min – ETA'er er usikre og loves ikke til kunder`, {
          requiresAction: true,
          dedupeKey: `driver_no_status:${d.id}`,
          dedupeMinutes: 60,
          data: { driverId: d.id },
        });
      }
    }

    await this.suggestReassignments();
    this.monitor();
  }

  /**
   * Foreslå omfordeling, når en anden chauffør giver en klart bedre samlet
   * løsning (score inkl. omfordelingsomkostning). Forslag anvendes aldrig
   * automatisk – en medarbejder godkender, og den nye chauffør skal acceptere.
   */
  async suggestReassignments(): Promise<void> {
    const { ctx } = this;
    const econ = ctx.settings.get().economics;
    const candidates = ctx.orders.list({ status: ['driver_assigned'] }).slice(0, 10);
    for (const o of candidates) {
      if (!o.driverId || o.addressLat == null) continue;
      const open = ctx.db.prepare(`SELECT id FROM reassignment_suggestions WHERE order_id = ? AND status = 'open'`).get(o.id);
      if (open) continue;
      const current = ctx.drivers.get(o.driverId)!;
      if (current.currentOrderId === o.id) continue; // chaufføren er på vej – flyttes ikke
      const stops = this.routing.stops(current.id);
      const idx = stops.findIndex((x) => x.orderId === o.id);
      const plan = this.dispatch.stockPlanFor(current, o) ?? 'own_vehicle';
      const keepResults = await this.routing.planInsertion(
        current,
        { id: o.id, point: { lat: o.addressLat, lng: o.addressLng! }, needsPickup: plan === 'central_pickup' || plan === 'move_to_central', deliveryFeeOre: o.deliveryFeeOre },
        { reassignment: false },
      );
      const keep = keepResults.find((r) => r.insertIndex === Math.max(0, idx)) ?? keepResults[0];
      const { feasible } = await this.dispatch.evaluate(o, { exclude: [current.id], reassignment: true });
      const alt = feasible[0];
      if (!alt?.best || !keep) continue;
      const gain = alt.best.analysis.score - keep.analysis.score;
      if (gain < econ.minReassignmentGainOre) continue;
      const etaGain = keep.analysis.newOrderEtaMinutes - alt.best.analysis.newOrderEtaMinutes;
      const analysis = {
        ...alt.best.analysis,
        explanation: [
          `Samlet gevinst ${Math.round(gain / 100)} kr. (score ${alt.best.analysis.score} mod ${keep.analysis.score} hos ${current.name})`,
          `Levering ${etaGain >= 0 ? `ca. ${etaGain} min hurtigere` : `ca. ${-etaGain} min senere`} hos ${alt.driver.name}`,
          ...alt.best.analysis.explanation,
        ],
      };
      ctx.db
        .prepare(`INSERT INTO reassignment_suggestions (order_id, from_driver_id, to_driver_id, reason, eta_gain_minutes, analysis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(o.id, current.id, alt.driver.id, `${alt.driver.name} giver en bedre samlet løsning (+${Math.round(gain / 100)} kr.)`, etaGain, JSON.stringify(analysis), clock.iso());
      ctx.bus.touch('logistics');
    }
    ctx.db
      .prepare(`UPDATE reassignment_suggestions SET status = 'dismissed' WHERE status = 'open' AND order_id IN (SELECT id FROM orders WHERE status <> 'driver_assigned')`)
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
      if (clock.now() - new Date(w.last_in).getTime() > 5 * 60000) {
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
