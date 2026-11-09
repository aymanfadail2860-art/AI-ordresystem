import type { Ctx } from '../context';
import { fillTemplate } from './replies';

/**
 * Kundeopdateringer om ETA. Konfigurerbare grænser forhindrer gentagne
 * beskeder om små ændringer; alle afsendelser er idempotente og registreres
 * i ordrehistorikken.
 */
export class CustomerNotifier {
  constructor(private ctx: Ctx) {}

  private enabled(orderId: number): { conv: number } | null {
    const { ctx } = this;
    const s = ctx.settings.get();
    if (!s.installation.automationEnabled || !s.automation.customerEtaUpdates) return null;
    const o = ctx.db.prepare(`SELECT conversation_id, status FROM orders WHERE id = ?`).get(orderId) as { conversation_id: number | null; status: string } | undefined;
    if (!o?.conversation_id || !['driver_assigned', 'out_for_delivery'].includes(o.status)) return null;
    return { conv: o.conversation_id };
  }

  private fmt(ms: number): string {
    return new Date(ms).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  }

  /** Første ETA til kunden (ved tildeling) – kun hvis den kan kommunikeres forsvarligt. */
  initial(orderId: number, driverFirstName: string, etaMs: number | null, communicable: boolean): void {
    const { ctx } = this;
    const o = ctx.db.prepare(`SELECT conversation_id FROM orders WHERE id = ?`).get(orderId) as { conversation_id: number | null };
    if (!o?.conversation_id) return;
    const rounded = etaMs ? Math.ceil(etaMs / 300000) * 300000 : null;
    const eta = communicable && rounded ? ` Forventet levering ca. kl. ${this.fmt(rounded)}.` : ' Vi giver besked, når chaufføren er tæt på.';
    ctx.sms.queue(o.conversation_id, `${driverFirstName} kører med din ordre #${orderId}.${eta}`, 'system', `assigned_notice:${orderId}`, orderId);
    if (communicable && rounded) {
      // Første oplyste tid tæller ikke med i spam-grænsen for senere opdateringer
      ctx.orders.updateFields(orderId, { etaCommunicated: new Date(rounded).toISOString() }, 'system');
    }
  }

  /** Chaufføren melder N minutter til ankomst → "stå klar"-besked (én gang pr. ordre). */
  arrivalSoon(orderId: number, minutes: number): boolean {
    const { ctx } = this;
    const s = ctx.settings.get().notifications;
    const en = this.enabled(orderId);
    if (!en || minutes > s.arrivalSoonMaxMinutes) return false;
    const row = ctx.db.prepare(`SELECT arrival_soon_sent FROM orders WHERE id = ?`).get(orderId) as { arrival_soon_sent: number };
    if (row.arrival_soon_sent) return false;
    const m = Math.max(1, Math.round(minutes));
    ctx.sms.queue(en.conv, fillTemplate(s.arrivalSoonTemplate, { minutes: m, orderId }), 'system', `arrival_soon:${orderId}`, orderId);
    const eta = new Date(Date.now() + m * 60000).toISOString();
    ctx.db.prepare(`UPDATE orders SET arrival_soon_sent = 1, eta_notified_at = ?, eta_communicated = ? WHERE id = ?`).run(new Date().toISOString(), eta, orderId);
    ctx.orders.addEvent(orderId, 'customer_notified', 'system', { kind: 'arrival_soon', minutes: m });
    return true;
  }

  /**
   * Sammenlign ny ETA med den kunden har fået oplyst. Send kun besked ved
   * væsentlig ændring, med minimumsinterval og maks. antal pr. ordre.
   * Returnerer true hvis kunden blev opdateret.
   */
  evaluate(orderId: number, etaMs: number, communicable: boolean): boolean {
    const { ctx } = this;
    const s = ctx.settings.get().notifications;
    const en = this.enabled(orderId);
    if (!en) return false;
    const row = ctx.db.prepare(`SELECT eta_communicated, eta_notified_at, eta_updates_sent FROM orders WHERE id = ?`).get(orderId) as {
      eta_communicated: string | null;
      eta_notified_at: string | null;
      eta_updates_sent: number;
    };
    if (!row.eta_communicated) return false; // kunden har ikke fået et tidspunkt – intet at rette
    const promised = new Date(row.eta_communicated).getTime();
    const deltaMin = (etaMs - promised) / 60000;
    const later = deltaMin >= s.lateThresholdMinutes;
    const earlier = -deltaMin >= s.earlyThresholdMinutes;
    if (!later && !earlier) return false;
    if (row.eta_updates_sent >= s.maxUpdatesPerOrder) {
      ctx.events.log('warn', 'notifier', 'eta_update_limit', `Ordre #${orderId}: ETA ændret ${Math.round(deltaMin)} min, men maks. antal kundeopdateringer er nået`, {
        requiresAction: true,
        dedupeKey: `eta_update_limit:${orderId}`,
        data: { orderId },
      });
      return false;
    }
    if (row.eta_notified_at && Date.now() - new Date(row.eta_notified_at).getTime() < s.minMinutesBetweenUpdates * 60000) return false;
    // Uden pålidelig ETA siges kun at det er forsinket – aldrig et opdigtet tidspunkt
    if (!communicable && !later) return false;
    const rounded = Math.ceil(etaMs / 300000) * 300000;
    const text = !communicable
      ? fillTemplate(s.delayNoTimeTemplate, { orderId })
      : earlier
        ? `Godt nyt: Din levering (ordre #${orderId}) forventes nu allerede ca. kl. ${this.fmt(rounded)}.`
        : fillTemplate(s.delayTemplate, { orderId, time: this.fmt(rounded) });
    ctx.sms.queue(en.conv, text, 'system', `eta_update:${orderId}:${row.eta_updates_sent + 1}`, orderId);
    ctx.db
      .prepare(`UPDATE orders SET eta_communicated = ?, eta_notified_at = ?, eta_updates_sent = eta_updates_sent + 1 WHERE id = ?`)
      .run(new Date(communicable ? rounded : etaMs).toISOString(), new Date().toISOString(), orderId);
    ctx.orders.addEvent(orderId, 'customer_notified', 'system', {
      kind: communicable ? 'eta_update' : 'delay_no_time',
      previous: row.eta_communicated,
      next: communicable ? new Date(rounded).toISOString() : null,
      deltaMinutes: Math.round(deltaMin),
    });
    return true;
  }
}
