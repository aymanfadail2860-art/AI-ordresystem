import type { Ctx } from '../context';
import type { RoutingService } from './routing';
import type { DispatchAgent } from './dispatchAgent';
import type { JobRow } from '../jobs/jobQueue';
import { clock } from '../clock';
import { nowIso } from '../db/database';
import { isOpen } from '../../core/openingHours';
import { DEFAULT_TZ, formatClock } from '../../core/time';
import { ceilToQuarter, parseTimeReply, type TimeReply } from '../../core/timeReply';
import type { CustomerInterpretation } from '../ai/schemas';
import type { DeliveryTimeOffer, Order, TimeOfferStatus } from '../../shared/types';

interface OfferRow {
  id: number;
  order_id: number;
  driver_id: number | null;
  status: TimeOfferStatus;
  kind: 'earliest' | 'requested' | 'queued';
  window_start: string;
  window_end: string;
  est_eta: string | null;
  attempt: number;
  reason: string | null;
  expires_at: string;
  decision: string | null;
  customer_reply: string | null;
  created_at: string;
  responded_at: string | null;
}

export interface WindowSuggestion {
  driverId: number;
  etaMs: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * Alternative leveringstider (Etape 5).
 *
 * Kan en bekræftet ordre ikke leveres inden for den normale ramme, foreslås kunden
 * det tidligste realistiske tidsrum via SMS. Forslaget reserverer en plads i en
 * chaufførs kø (efter rutens sidste stop og efter andre reserverede pladser), så
 * samme ledige kapacitet ikke loves til flere kunder. Forslag udløber; ved accept
 * valideres tidspunktet igen, før det noteres. Kundens svar fortolkes
 * deterministisk (ja/nej/klokkeslæt/"tidligste"). Afviser kunden, svarer kunden
 * ikke, eller kan intet realistisk tidspunkt findes, overtager en medarbejder.
 * Systemet skriver aldrig, at leveringen er bekræftet, før en chauffør har accepteret.
 *
 * Al behandling, der ændrer reservationer, kører i dispatch-køen (serialiseret).
 */
export class TimeOfferService {
  dispatch: DispatchAgent | null = null;

  constructor(
    private ctx: Ctx,
    private routing: RoutingService,
  ) {
    ctx.jobs.register('time_offer_process', (job) => this.handleProcess(job));
    ctx.jobs.register('time_offer_expire', async (job) => this.expire(job.payload.offerId as number));
    ctx.jobs.registerRecurring('time_offer_tick', 60_000, async () => this.tick());
  }

  start(): void {
    this.ctx.jobs.ensureRecurring('time_offer_tick', 20_000);
  }

  private tz(): string {
    return this.ctx.settings.get().company.timezone || DEFAULT_TZ;
  }

  private fmtWindow(start: number | string, end: number | string): string {
    return `${formatClock(start, this.tz())}–${formatClock(end, this.tz())}`;
  }

  private row(id: number): OfferRow | null {
    return (this.ctx.db.prepare(`SELECT * FROM delivery_time_offers WHERE id = ?`).get(id) as OfferRow | undefined) ?? null;
  }

  pendingFor(orderId: number): OfferRow | null {
    return (this.ctx.db.prepare(`SELECT * FROM delivery_time_offers WHERE order_id = ? AND status = 'pending'`).get(orderId) as OfferRow | undefined) ?? null;
  }

  list(opts: { orderId?: number; limit?: number } = {}): DeliveryTimeOffer[] {
    const rows = (
      opts.orderId
        ? this.ctx.db.prepare(`SELECT * FROM delivery_time_offers WHERE order_id = ? ORDER BY id DESC`).all(opts.orderId)
        : this.ctx.db.prepare(`SELECT * FROM delivery_time_offers ORDER BY id DESC LIMIT ?`).all(opts.limit ?? 200)
    ) as OfferRow[];
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      driverId: r.driver_id,
      status: r.status,
      kind: r.kind,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      attempt: r.attempt,
      reason: r.reason,
      expiresAt: r.expires_at,
      decision: r.decision,
      customerReply: r.customer_reply,
      createdAt: r.created_at,
      respondedAt: r.responded_at,
    }));
  }

  // ---------------- Kapacitet ----------------

  /**
   * Tidligste realistiske tidsrum: for hver aktiv chauffør med varerne beregnes,
   * hvornår ordren kan leveres efter rutens sidste stop og efter de pladser, der
   * allerede er reserveret til andre kunder (afventende eller accepterede forslag).
   */
  async earliestWindow(order: Order, opts: { excludeOrderId?: number; notBeforeMs?: number; holdsBeforeMs?: number } = {}): Promise<WindowSuggestion | null> {
    const { ctx } = this;
    const s = ctx.settings.get();
    const a = s.alternatives;
    if (order.addressLat == null || order.addressLng == null || !this.dispatch) return null;
    const now = clock.now();
    const service = s.logistics.serviceMinutesPerStop * 60000;
    const target = { lat: order.addressLat, lng: order.addressLng };
    let best: WindowSuggestion | null = null;
    for (const d of ctx.drivers.list()) {
      if (d.status !== 'available' && d.status !== 'busy') continue;
      if (!d.telegramChatId && !ctx.telegram.current?.simulated) continue;
      const plan = this.dispatch.stockPlanFor(d, order);
      if (!plan) continue;
      const stops = ctx.drivers.routeStops(d.id).filter((x) => ['driver_assigned', 'out_for_delivery'].includes(x.status));
      const last = stops[stops.length - 1];
      const anchor = this.routing.ensureAnchor(d);
      let t = last?.eta ? Math.max(now, new Date(last.eta).getTime()) + service : now;
      let p = last?.lat != null ? { lat: last.lat, lng: last.lng! } : anchor.lat != null ? { lat: anchor.lat, lng: anchor.lng! } : null;
      const holds = ctx.db
        .prepare(
          `SELECT t.order_id, t.window_start, o.address_lat AS lat, o.address_lng AS lng FROM delivery_time_offers t JOIN orders o ON o.id = t.order_id
           WHERE t.driver_id = ? AND t.status IN ('pending','accepted') AND t.order_id <> ? AND o.status IN ('confirmed','awaiting_driver') ORDER BY t.window_start`,
        )
        .all(d.id, opts.excludeOrderId ?? order.id) as { order_id: number; window_start: string; lat: number | null; lng: number | null }[];
      for (const h of holds) {
        if (h.lat == null || p == null) continue;
        // Ved genvalidering tæller kun reservationer, der ligger før kundens eget tidsrum
        if (opts.holdsBeforeMs != null && new Date(h.window_start).getTime() > opts.holdsBeforeMs) continue;
        const tr = await ctx.maps.travel(p, { lat: h.lat, lng: h.lng! });
        t = Math.max(t + tr.durationS * 1000, new Date(h.window_start).getTime() - 30 * 60000) + service;
        p = { lat: h.lat, lng: h.lng! };
      }
      let eta = t;
      if (p) eta += (await ctx.maps.travel(p, target)).durationS * 1000;
      else eta += 15 * 60000;
      if (plan === 'central_pickup' || plan === 'move_to_central') eta += 10 * 60000; // omvej via lager
      if (opts.notBeforeMs && eta < opts.notBeforeMs) eta = opts.notBeforeMs;
      if (!best || eta < best.etaMs) {
        const start = ceilToQuarter(eta + a.safetyMinutes * 60000);
        best = { driverId: d.id, etaMs: eta, windowStart: start, windowEnd: start + a.windowMinutes * 60000 };
      }
    }
    if (!best) return null;
    if (best.windowStart - now > a.maxHorizonMinutes * 60000) return null;
    // Tidsrummet skal slutte i åbningstiden (+ evt. `latestAfterCloseMinutes`, hvis chaufførerne arbejder efter lukketid)
    if (!this.withinHours(best.windowEnd)) return null;
    return best;
  }

  /** Slutter tidsrummet i åbningstiden (+ tilladt tid efter lukning)? */
  private withinHours(endMs: number): boolean {
    const s = this.ctx.settings.get();
    return isOpen(s.openingHours, new Date(endMs - 60000 - s.alternatives.latestAfterCloseMinutes * 60000), this.tz());
  }

  /**
   * Ingen chauffør kan tage ordren nu (fx alle er ved loftet for aktive ordrer). Er der en
   * realistisk plads i en chaufførs kø inden for den normale leveringstid, reserveres den
   * internt (ingen kundekontakt) – ordren tildeles, når der bliver plads. Ellers tilbydes
   * kunden et senere tidspunkt. Returnerer 'queued', 'offered' eller 'none'.
   */
  async queueOrOffer(order: Order, waitedMinutes: number): Promise<'queued' | 'offered' | 'none'> {
    const { ctx } = this;
    const s = ctx.settings.get();
    const existing = ctx.db
      .prepare(`SELECT * FROM delivery_time_offers WHERE order_id = ? AND status = 'accepted' AND kind = 'queued'`)
      .get(order.id) as OfferRow | undefined;
    if (existing) {
      if (new Date(existing.window_end).getTime() > clock.now()) return 'queued';
      this.close(existing.id, 'superseded'); // køpladsen er forældet – beregn igen
    }
    const w = await this.earliestWindow(order);
    const withinNormal = !!w && !!order.confirmedAt && w.etaMs - new Date(order.confirmedAt).getTime() <= s.economics.maxDeliveryMinutes * 60000;
    if (withinNormal && !s.alternatives.queueWithinNormalTime) return 'none'; // normal dispatch prøver igen (manuel efter den normale grænse)
    if (w && withinNormal) {
      ctx.db
        .prepare(
          `INSERT INTO delivery_time_offers (order_id, driver_id, status, kind, window_start, window_end, est_eta, attempt, reason, expires_at, created_at, closed_at)
           VALUES (?, ?, 'accepted', 'queued', ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          order.id,
          w.driverId,
          new Date(w.etaMs - 15 * 60000).toISOString(),
          new Date(w.etaMs + 15 * 60000).toISOString(),
          new Date(w.etaMs).toISOString(),
          'kø: chaufførerne er ved loftet for aktive ordrer',
          new Date(w.etaMs + 15 * 60000).toISOString(),
          nowIso(),
          nowIso(),
        );
      ctx.orders.addEvent(order.id, 'queued', 'system', { driverId: w.driverId, eta: new Date(w.etaMs).toISOString() });
      ctx.bus.touch('alternatives');
      return 'queued';
    }
    if (!s.alternatives.enabled || waitedMinutes < s.alternatives.offerAfterMinutes) return 'none';
    const id = await this.propose(order.id, 'ingen chauffør kan levere inden for den normale leveringstid', undefined, { canWait: waitedMinutes <= 20 });
    return id || ctx.orders.get(order.id)?.status !== 'awaiting_driver' ? 'offered' : 'none';
  }

  // ---------------- Forslag ----------------

  private attempts(orderId: number): number {
    return (this.ctx.db.prepare(`SELECT COUNT(*) AS c FROM delivery_time_offers WHERE order_id = ?`).get(orderId) as { c: number }).c;
  }

  /** Foreslå kunden det tidligste realistiske tidsrum. Returnerer tilbudets id eller null (eskaleret). */
  async propose(orderId: number, reason: string, intro?: string, opts: { canWait?: boolean } = {}): Promise<number | null> {
    const { ctx } = this;
    const a = ctx.settings.get().alternatives;
    const order = ctx.orders.get(orderId);
    if (!order || !['confirmed', 'awaiting_driver'].includes(order.status) || !order.conversationId) return null;
    if (this.pendingFor(orderId)) return null;
    if (this.attempts(orderId) >= a.maxAttempts) {
      this.escalate(order, `Ingen accepteret leveringstid efter ${a.maxAttempts} forslag`, 'Vi kan desværre ikke finde et tidspunkt, der passer. En medarbejder kontakter dig hurtigst muligt.');
      return null;
    }
    const w = await this.earliestWindow(order);
    if (!w) {
      // Intet realistisk tidspunkt lige nu. Er det en ny ordre, kan kapaciteten stadig nå at blive ledig
      // (dispatch prøver igen og overdrager efter den normale grænse). Ellers overtager en medarbejder.
      if (opts.canWait) return null;
      this.escalate(order, 'Ingen realistisk leveringstid inden for åbningstiden', 'Vi har desværre ikke kapacitet til at levere din ordre i dag. En medarbejder kontakter dig hurtigst muligt.');
      return null;
    }
    let id = 0;
    ctx.db.transaction(() => {
      if (this.pendingFor(orderId)) return; // samtidighed
      const r = ctx.db
        .prepare(
          `INSERT INTO delivery_time_offers (order_id, driver_id, status, kind, window_start, window_end, est_eta, attempt, reason, expires_at, created_at)
           VALUES (?, ?, 'pending', 'earliest', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          orderId,
          w.driverId,
          new Date(w.windowStart).toISOString(),
          new Date(w.windowEnd).toISOString(),
          new Date(w.etaMs).toISOString(),
          this.attempts(orderId) + 1,
          reason,
          new Date(clock.now() + a.offerExpiryMinutes * 60000).toISOString(),
          nowIso(),
        );
      id = Number(r.lastInsertRowid);
      const text = `${intro ?? 'Vi har ekstra travlt lige nu.'} Vi kan levere din bestilling (ordre #${orderId}) omkring kl. ${this.fmtWindow(w.windowStart, w.windowEnd)}. Passer det dig? Svar JA, skriv et andet klokkeslæt (fx "kl. 22") eller svar NEJ.`;
      ctx.sms.queue(order.conversationId!, text, 'ai', `time_offer:${id}`, orderId);
      ctx.orders.addEvent(orderId, 'time_offer', 'system', { offerId: id, windowStart: new Date(w.windowStart).toISOString(), windowEnd: new Date(w.windowEnd).toISOString(), reason });
      ctx.jobs.enqueue('time_offer_expire', { offerId: id }, { runAt: new Date(clock.now() + a.offerExpiryMinutes * 60000), dedupeKey: `time_offer_expire:${id}` });
    })();
    if (!id) return null;
    ctx.events.log('info', 'alternatives', 'offered', `Ordre #${orderId}: kunden har fået tilbudt levering kl. ${this.fmtWindow(w.windowStart, w.windowEnd)} (${reason})`, { data: { orderId, offerId: id } });
    ctx.bus.touch('alternatives', 'orders');
    return id;
  }

  // ---------------- Kundens svar ----------------

  /**
   * Kaldes af kundeagenten (synkront i dens transaktion), når kunden skriver, mens et
   * forslag afventer. Returnerer true, hvis svaret håndteres her. Selve behandlingen
   * (genvalidering mod kapacitet) sker i dispatch-køen.
   */
  handleReply(order: Order, rawText: string, interp: CustomerInterpretation | null): boolean {
    const { ctx } = this;
    const offer = this.pendingFor(order.id);
    if (!offer) return false;
    if (interp?.intent === 'cancel_order') return false; // almindelig annullering
    const reply = parseTimeReply(rawText, clock.now(), this.tz());
    if (reply.kind === 'unclear' && interp?.intent === 'confirm') reply.kind = 'accept';
    if (reply.kind === 'unclear' && interp?.intent === 'decline') reply.kind = 'decline';
    const upd = ctx.db
      .prepare(`UPDATE delivery_time_offers SET decision = ?, customer_reply = ?, responded_at = ? WHERE id = ? AND status = 'pending'`)
      .run(reply.kind, rawText.slice(0, 500), nowIso(), offer.id);
    if (upd.changes === 0) return false;
    ctx.jobs.enqueue('time_offer_process', { offerId: offer.id, reply }, { lane: 'dispatch', dedupeKey: `time_offer_process:${offer.id}:${nowIso()}` });
    return true;
  }

  private async handleProcess(job: JobRow): Promise<void> {
    await this.process(job.payload.offerId as number, job.payload.reply as TimeReply);
  }

  async process(offerId: number, reply: TimeReply): Promise<void> {
    const { ctx } = this;
    const offer = this.row(offerId);
    if (!offer || offer.status !== 'pending') return;
    const order = ctx.orders.get(offer.order_id);
    if (!order || !['confirmed', 'awaiting_driver'].includes(order.status)) {
      this.close(offerId, 'cancelled');
      return;
    }
    const conv = order.conversationId!;
    const say = (text: string, tag: string) => ctx.sms.queue(conv, text, 'ai', `time_offer:${offerId}:${tag}`, order.id);
    const a = ctx.settings.get().alternatives;
    switch (reply.kind) {
      case 'accept': {
        // Genvalidér: kan tidsrummet stadig nås, når andres reservationer er talt med?
        const w = await this.earliestWindow(order, { excludeOrderId: order.id, holdsBeforeMs: new Date(offer.window_start).getTime() });
        if (w && w.etaMs <= new Date(offer.window_end).getTime()) {
          this.accept(offer, order, offer.kind === 'queued' ? 'earliest' : offer.kind, new Date(offer.window_start).getTime(), new Date(offer.window_end).getTime(), w.driverId);
          say(
            `Tak! Vi har noteret levering af ordre #${order.id} ca. kl. ${this.fmtWindow(offer.window_start, offer.window_end)}. Du får besked, når chaufføren er på vej.`,
            'accepted',
          );
          return;
        }
        this.close(offerId, 'superseded');
        await this.propose(order.id, 'kapaciteten ændrede sig før accept', 'Tidspunktet blev desværre optaget, mens vi ventede på dit svar.');
        return;
      }
      case 'request': {
        const req = reply.requestedMs!;
        const windowEnd = req + a.windowMinutes * 60000;
        const openOk = this.withinHours(windowEnd);
        const tooFar = req - clock.now() > a.maxHorizonMinutes * 60000;
        const w = openOk && !tooFar ? await this.earliestWindow(order, { excludeOrderId: order.id, notBeforeMs: req, holdsBeforeMs: req }) : null;
        if (w && w.etaMs <= windowEnd) {
          this.accept(offer, order, 'requested', req, windowEnd, w.driverId);
          say(`Det passer fint. Vi har noteret levering af ordre #${order.id} ca. kl. ${this.fmtWindow(req, windowEnd)}. Du får besked, når chaufføren er på vej.`, 'requested');
          return;
        }
        this.close(offerId, 'superseded');
        const why = !openOk || tooFar ? `Kl. ${formatClock(req, this.tz())} kan vi desværre ikke levere.` : `Kl. ${formatClock(req, this.tz())} kan vi desværre ikke nå.`;
        await this.propose(order.id, 'kundens ønskede tidspunkt kunne ikke nås', `${why} Det tidligste mulige er nu:`);
        return;
      }
      case 'earliest': {
        this.close(offerId, 'superseded');
        await this.propose(order.id, 'kunden spurgte om det tidligste', 'Det tidligste, vi kan nå lige nu:');
        return;
      }
      case 'decline': {
        this.close(offerId, 'declined');
        this.escalate(order, 'Kunden afviste foreslået leveringstid', `Det forstår vi. En medarbejder kontakter dig hurtigst muligt om ordre #${order.id}.`);
        return;
      }
      default: {
        const unclear = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM order_events WHERE order_id = ? AND type = 'time_offer_unclear'`).get(order.id) as { c: number }).c;
        if (unclear >= 1) {
          this.close(offerId, 'declined');
          this.escalate(order, 'Kundens svar på leveringstid var uklart', 'Tak for dit svar. En medarbejder kontakter dig om leveringstidspunktet.');
          return;
        }
        ctx.orders.addEvent(order.id, 'time_offer_unclear', 'system', { offerId });
        ctx.db.prepare(`UPDATE delivery_time_offers SET decision = NULL WHERE id = ?`).run(offerId);
        say(`Undskyld, det forstod vi ikke helt. Passer levering ca. kl. ${this.fmtWindow(offer.window_start, offer.window_end)}? Svar JA, skriv et andet klokkeslæt (fx "kl. 22") eller svar NEJ.`, 'clarify');
      }
    }
  }

  /** Notér det aftalte tidsrum (løftet = slutningen af tidsrummet) og planlæg tildeling af chauffør. */
  private accept(offer: OfferRow, order: Order, kind: 'earliest' | 'requested', start: number, end: number, driverId: number): void {
    const { ctx } = this;
    const a = ctx.settings.get().alternatives;
    ctx.db.transaction(() => {
      ctx.db
        .prepare(`UPDATE delivery_time_offers SET status = 'accepted', kind = ?, window_start = ?, window_end = ?, driver_id = ?, closed_at = ? WHERE id = ?`)
        .run(kind, new Date(start).toISOString(), new Date(end).toISOString(), driverId, nowIso(), offer.id);
      ctx.db
        .prepare(`UPDATE orders SET window_start = ?, window_end = ?, window_kind = ?, eta_communicated = ?, needs_attention = 0, updated_at = ? WHERE id = ?`)
        .run(new Date(start).toISOString(), new Date(end).toISOString(), kind, new Date(end).toISOString(), nowIso(), order.id);
      ctx.orders.addEvent(order.id, 'time_window_agreed', 'customer', { windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(), kind });
    })();
    ctx.events.log('info', 'alternatives', 'accepted', `Ordre #${order.id}: kunden har accepteret levering kl. ${this.fmtWindow(start, end)}`, { data: { orderId: order.id } });
    // Tildel chauffør i god tid før tidsrummet
    const delay = Math.max(0, start - a.dispatchLeadMinutes * 60000 - clock.now());
    this.dispatch?.enqueue(order.id, delay);
    ctx.bus.touch('alternatives', 'orders');
  }

  private close(offerId: number, status: TimeOfferStatus): void {
    this.ctx.db.prepare(`UPDATE delivery_time_offers SET status = ?, closed_at = ? WHERE id = ? AND status IN ('pending','accepted')`).run(status, nowIso(), offerId);
    this.ctx.jobs.cancelByDedupeKey(`time_offer_expire:${offerId}`);
    this.ctx.bus.touch('alternatives');
  }

  /** Overdrag til medarbejder. Skriver aldrig, at leveringen er bekræftet. */
  private escalate(order: Order, reason: string, customerText: string): void {
    const { ctx } = this;
    ctx.db.transaction(() => {
      for (const o of this.list({ orderId: order.id }).filter((x) => x.status === 'pending' || x.status === 'accepted')) this.close(o.id, o.status === 'pending' ? 'cancelled' : 'cancelled');
      const cur = ctx.orders.get(order.id)!;
      if (['confirmed', 'awaiting_driver'].includes(cur.status)) ctx.orders.transition(order.id, 'needs_manual', 'system', { reason });
      ctx.orders.flag(order.id, reason);
      if (cur.conversationId) {
        // Under manuel overtagelse sender systemet intet og ændrer ikke samtalens tilstand – medarbejderen har den
        const conv = ctx.conversations.get(cur.conversationId);
        if (conv?.aiMode === 'ai_active') {
          ctx.sms.queue(cur.conversationId, customerText, 'system', `handoff:time_offer:${order.id}`, order.id);
          ctx.conversations.setMode(cur.conversationId, 'ai_paused', reason, 'system');
        }
      }
    })();
    ctx.events.log('warn', 'alternatives', 'escalated', `Ordre #${order.id} overdraget til medarbejder: ${reason}`, { requiresAction: true, data: { orderId: order.id } });
    ctx.bus.touch('alternatives', 'orders');
  }

  /** Kunden svarede ikke i tide. */
  expire(offerId: number): void {
    const offer = this.row(offerId);
    if (!offer || offer.status !== 'pending' || offer.decision) return;
    if (new Date(offer.expires_at).getTime() > clock.now() + 1000) return;
    this.close(offerId, 'expired');
    const order = this.ctx.orders.get(offer.order_id);
    if (order && ['confirmed', 'awaiting_driver'].includes(order.status)) {
      this.escalate(order, 'Kunden svarede ikke på forslag om senere levering', `Vi har ikke hørt fra dig om leveringstidspunktet for ordre #${order.id}. En medarbejder kontakter dig.`);
    }
  }

  /** Chauffør tildelt: reservationen er brugt. */
  onAssigned(orderId: number): void {
    const r = this.ctx.db.prepare(`UPDATE delivery_time_offers SET status = 'fulfilled', closed_at = ? WHERE order_id = ? AND status = 'accepted'`).run(nowIso(), orderId);
    if (r.changes) this.ctx.bus.touch('alternatives');
  }

  /**
   * Et aftalt tidsrum kan ikke længere nås (kapaciteten er ændret). Nyt forslag eller
   * medarbejder. Kaldes fra dispatch.
   */
  async windowNoLongerFeasible(order: Order): Promise<void> {
    const { ctx } = this;
    for (const o of this.list({ orderId: order.id }).filter((x) => x.status === 'accepted')) this.close(o.id, 'superseded');
    ctx.db.prepare(`UPDATE orders SET window_start = NULL, window_end = NULL, window_kind = NULL WHERE id = ?`).run(order.id);
    ctx.events.log('warn', 'alternatives', 'window_lost', `Ordre #${order.id}: det aftalte tidsrum kan ikke længere nås`, { data: { orderId: order.id } });
    await this.propose(order.id, 'det aftalte tidsrum kan ikke længere nås', 'Vi beklager – vi kan alligevel ikke nå det aftalte tidspunkt.');
  }

  /** Sikkerhedsnet: udløb, annullerede ordrer og forældede reservationer. */
  tick(): void {
    const { ctx } = this;
    const due = ctx.db.prepare(`SELECT id FROM delivery_time_offers WHERE status = 'pending' AND decision IS NULL AND expires_at <= ?`).all(nowIso()) as { id: number }[];
    for (const d of due) this.expire(d.id);
    const stale = ctx.db
      .prepare(
        `SELECT t.id FROM delivery_time_offers t JOIN orders o ON o.id = t.order_id WHERE t.status IN ('pending','accepted') AND o.status NOT IN ('confirmed','awaiting_driver')`,
      )
      .all() as { id: number }[];
    for (const r of stale) {
      const o = ctx.db.prepare(`SELECT o.status FROM delivery_time_offers t JOIN orders o ON o.id = t.order_id WHERE t.id = ?`).get(r.id) as { status: string };
      this.close(r.id, o.status === 'driver_assigned' || o.status === 'out_for_delivery' || o.status === 'delivered' ? 'fulfilled' : 'cancelled');
    }
  }
}
