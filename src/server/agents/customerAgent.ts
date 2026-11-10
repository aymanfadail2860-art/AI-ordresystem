import type { Ctx } from '../context';
import type { JobRow } from '../jobs/jobQueue';
import { RetryLaterError } from '../jobs/jobQueue';
import type { CustomerInterpretation } from '../ai/schemas';
import type { CustomerTurnContext } from '../ai/interpreters';
import type { GeocodeResult } from '../adapters/maps/types';
import { AiDisabledError, BudgetExceededError } from '../ai/gateway';
import { PermanentAiError, TransientAiError } from '../adapters/ai/types';
import { DRAFT_STATUSES } from '../../core/orderStateMachine';
import { InsufficientStockError } from '../services/inventory';
import { haversineMeters } from '../../core/geo';
import { isOpen } from '../../core/openingHours';
import type { Order, OrderStatus } from '../../shared/types';
import { fillTemplate, menuText, priceFacts, quoteText, statusText } from './replies';
import type { TimeOfferService } from './timeOffers';
import { clock } from '../clock';

/**
 * Customer Agent + Order Agent.
 *
 * Flow pr. kundetur:
 *  1. Saml alle ubehandlede indgående beskeder i samtalen (flere hurtige SMS = én tur).
 *  2. Asynkrone opslag: AI-fortolkning + geokodning af adresse.
 *  3. ÉN synkron databasetransaktion: anvend fortolkningen på ordren efter
 *     forretningsreglerne, læg svaret i outbox og markér beskederne behandlet.
 *     Går noget galt, rulles alt tilbage – ingen halve ordrer eller dobbeltsvar.
 */
export class CustomerAgent {
  /** Sættes af app.ts (alternative leveringstider). */
  timeOffers: TimeOfferService | null = null;

  constructor(private ctx: Ctx) {
    ctx.jobs.register('process_conversation', (job) => this.handleJob(job));
    ctx.bus.on('inbound_message', ({ conversationId }: { conversationId: number }) => {
      // Kort debounce, så flere SMS i træk behandles samlet
      ctx.jobs.enqueue('process_conversation', { conversationId }, {
        dedupeKey: `process_conversation:${conversationId}`,
        lane: `conv:${conversationId}`,
        delayMs: 1500,
        maxAttempts: 6,
      });
    });
  }

  private async handleJob(job: JobRow): Promise<void> {
    const conversationId = job.payload.conversationId as number;
    try {
      await this.processConversation(conversationId);
    } catch (err) {
      if (err instanceof TransientAiError) {
        if (job.attempts >= 3) {
          this.handoffForAiFailure(conversationId, `Claude API utilgængelig: ${err.message}`);
          return;
        }
        throw new RetryLaterError(err.message, err.retryAfterMs ?? 10_000 * job.attempts);
      }
      if (err instanceof AiDisabledError || err instanceof BudgetExceededError || err instanceof PermanentAiError) {
        this.handoffForAiFailure(conversationId, err.message);
        return;
      }
      throw err;
    }
  }

  private handoffForAiFailure(conversationId: number, reason: string): void {
    const { ctx } = this;
    const pending = ctx.conversations.unprocessedInbound(conversationId);
    if (!pending.length) return;
    const s = ctx.settings.get();
    ctx.db.transaction(() => {
      ctx.conversations.setMode(conversationId, 'ai_paused', `AI utilgængelig: ${reason}`, 'system');
      const last = pending[pending.length - 1];
      ctx.sms.queue(conversationId, s.messages.handoffToHuman, 'system', `handoff:${conversationId}:${last.id}`);
      ctx.conversations.markProcessed(pending.map((m) => m.id));
    })();
    ctx.events.log('error', 'customer_agent', 'ai_unavailable', `Kundesamtale sendt til medarbejder: ${reason}`, {
      requiresAction: true,
      data: { conversationId },
    });
  }

  async processConversation(conversationId: number): Promise<void> {
    const { ctx } = this;
    const conv = ctx.conversations.get(conversationId);
    if (!conv) return;
    const pending = ctx.conversations.unprocessedInbound(conversationId);
    if (!pending.length) return;
    const s = ctx.settings.get();

    // Ingen automatiske svar ved manuel overtagelse / pause / fejl – beskederne er registreret
    if (conv.aiMode !== 'ai_active') {
      ctx.conversations.markProcessed(pending.map((m) => m.id));
      return;
    }
    if (!s.installation.automationEnabled || !s.automation.customerReplies) {
      ctx.conversations.markProcessed(pending.map((m) => m.id));
      ctx.events.log('info', 'customer_agent', 'automation_off', `Ny kundebesked (${conv.customerPhone.slice(-4)}) – automatiske svar er slået fra`, {
        requiresAction: true,
        dedupeKey: `automation_off:${conversationId}`,
        data: { conversationId },
      });
      return;
    }
    const lastInbound = pending[pending.length - 1];
    const replyKey = `reply:${conversationId}:${lastInbound.id}`;

    if (!isOpen(s.openingHours, clock.date(), s.company.timezone || undefined)) {
      ctx.db.transaction(() => {
        const day = clock.date().toISOString().slice(0, 10);
        ctx.sms.queue(conversationId, fillTemplate(s.messages.closed, { company: s.company.name, nextOpen: 'i vores åbningstid' }), 'ai', `closed:${conversationId}:${day}`);
        ctx.conversations.markProcessed(pending.map((m) => m.id));
      })();
      return;
    }

    // ---- 1. Asynkrone opslag ----
    const orderId = ctx.conversations.activeOrderId(conversationId);
    const order = orderId ? ctx.orders.get(orderId) : null;
    const products = ctx.catalog.list();
    const availability = ctx.inventory.totalAvailable();
    const history = ctx.conversations
      .messages(conversationId, s.ai.maxContextMessages + pending.length)
      .filter((m) => !pending.some((p) => p.id === m.id) && m.status !== 'blocked' && m.status !== 'failed')
      .slice(-s.ai.maxContextMessages)
      .map((m) => ({ from: m.direction === 'in' ? ('customer' as const) : ('business' as const), text: m.body.slice(0, 500) }));
    const turn: CustomerTurnContext = {
      companyName: s.company.name || 'virksomheden',
      catalog: products.map((p) => ({
        sku: p.sku,
        name: p.name,
        category: p.category,
        variant: p.variant,
        available: (availability.get(p.id) ?? 0) > 0,
        synonyms: p.synonyms,
        description: p.description,
      })),
      history,
      newMessages: pending.map((m) => m.body),
      currentOrder: order && DRAFT_STATUSES.includes(order.status)
        ? {
            id: order.id,
            status: order.status,
            items: order.lines.map((l) => ({ sku: l.sku, name: l.productName, quantity: l.quantity })),
            address: order.addressText,
            instructions: order.deliveryInstructions,
          }
        : order
          ? { id: order.id, status: order.status, items: order.lines.map((l) => ({ sku: l.sku, name: l.productName, quantity: l.quantity })), address: order.addressText, instructions: order.deliveryInstructions }
          : null,
      conversationId,
    };
    const { result: interp } = await ctx.customerInterpreter.interpret(turn);

    let geo: GeocodeResult | null = null;
    let geoError: string | null = null;
    if (interp.address) {
      try {
        geo = await ctx.maps.geocode(interp.address);
      } catch (e) {
        geoError = (e as Error).message;
      }
    }

    // Samtalen kan være overtaget, mens vi ventede på AI
    const fresh = ctx.conversations.get(conversationId);
    if (!fresh || fresh.aiMode !== 'ai_active') {
      ctx.conversations.markProcessed(pending.map((m) => m.id));
      return;
    }

    // ---- 2. Synkron, transaktionssikker anvendelse ----
    ctx.db.transaction(() => {
      const reply = this.apply(conversationId, conv.customerId, interp, geo, geoError, pending[0].id, pending.map((m) => m.body).join('\n'));
      if (reply) ctx.sms.queue(conversationId, reply.text, 'ai', replyKey, reply.orderId);
      ctx.conversations.markProcessed(pending.map((m) => m.id));
    })();
  }

  /** Anvend fortolkningen deterministisk. Returnerer svartekst. Kører i transaktion. */
  private apply(
    conversationId: number,
    customerId: number,
    interp: CustomerInterpretation,
    geo: GeocodeResult | null,
    geoError: string | null,
    firstInboundId: number,
    rawText = '',
  ): { text: string; orderId: number | null } | null {
    const { ctx } = this;
    const s = ctx.settings.get();
    const products = ctx.catalog.list();
    const availability = ctx.inventory.totalAvailable();
    const parts: string[] = [];
    let orderId = ctx.conversations.activeOrderId(conversationId);
    let order = orderId ? ctx.orders.get(orderId) : null;
    const isDraft = (o: Order | null) => !!o && DRAFT_STATUSES.includes(o.status);

    if (interp.customerName) ctx.conversations.updateCustomer(customerId, { name: interp.customerName });

    // Svar på et foreslået leveringstidspunkt fortolkes deterministisk (før AI'ens vurdering)
    if (order && this.timeOffers?.handleReply(order, rawText, interp)) return null;

    if (interp.needsHuman) {
      ctx.conversations.setMode(conversationId, 'ai_paused', interp.needsHumanReason ?? 'Kræver medarbejder', 'ai');
      ctx.events.log('warn', 'customer_agent', 'handoff', `Samtale sendt til medarbejder: ${interp.needsHumanReason ?? 'ukendt årsag'}`, {
        requiresAction: true,
        data: { conversationId, orderId },
      });
      if (order && !isDraft(order)) ctx.orders.flag(order.id, interp.needsHumanReason ?? 'Kunden har brug for en medarbejder');
      // Svaret sendes som 'system' – AI er nu pauseret for samtalen
      ctx.sms.queue(conversationId, s.messages.handoffToHuman, 'system', `handoff:${conversationId}:${firstInboundId}`, orderId);
      return null;
    }

    switch (interp.intent) {
      case 'cancel_order': {
        if (!order) return { text: 'Du har ingen aktiv ordre at annullere.', orderId: null };
        if (order.status === 'out_for_delivery' || order.status === 'needs_manual') {
          ctx.orders.flag(order.id, 'Kunden ønsker at annullere en ordre under levering');
          ctx.conversations.setMode(conversationId, 'ai_paused', 'Annullering under levering', 'ai');
          ctx.events.log('warn', 'customer_agent', 'cancel_in_delivery', `Kunden vil annullere ordre #${order.id}, som er under levering`, {
            requiresAction: true,
            data: { orderId: order.id, conversationId },
          });
          return { text: `Din ordre #${order.id} er allerede på vej. En medarbejder kontakter dig om annulleringen.`, orderId: order.id };
        }
        const driverId = order.driverId;
        ctx.orders.cancel(order.id, 'Annulleret af kunden', 'customer');
        if (driverId) ctx.bus.emit('order_cancelled_for_driver', { orderId: order.id, driverId });
        return { text: `Din ordre #${order.id} er annulleret. Skriv endelig, hvis du vil bestille igen.`, orderId: order.id };
      }
      case 'order_status':
        return order
          ? { text: statusText(order, s), orderId: order.id }
          : { text: 'Vi kan ikke se nogen aktiv ordre. Skriv hvad du gerne vil bestille.', orderId: null };
      case 'confirm': {
        if (order?.status === 'awaiting_confirmation') return this.confirmOrder(order);
        if (order && isDraft(order)) return { text: this.missingInfoText(order) ?? statusText(order, s), orderId: order.id };
        return order ? { text: statusText(order, s), orderId: order.id } : { text: 'Hvad må vi bringe til dig?', orderId: null };
      }
      case 'decline':
        if (order?.status === 'awaiting_confirmation') return { text: 'Helt i orden – hvad vil du gerne ændre?', orderId: order.id };
        break;
      case 'greeting':
        if (!order || !isDraft(order)) {
          return {
            text: `${fillTemplate(s.messages.greeting, { company: s.company.name || 'os' })}\n\n${menuText(products, availability)}`,
            orderId: null,
          };
        }
        break;
      default:
        break;
    }

    // Spørgsmål om produkter (svar uden priser fra AI + priser fra systemet)
    if (interp.intent === 'question') {
      const mentioned = products.filter((p) => interp.mentionedSkus.includes(p.sku));
      if (interp.questionAnswer) parts.push(interp.questionAnswer);
      if (mentioned.length) parts.push(priceFacts(mentioned, availability));
      if (!interp.questionAnswer && !mentioned.length) parts.push(menuText(products, availability));
    }
    if (interp.unknownProducts.length) {
      parts.push(`Vi har desværre ikke: ${interp.unknownProducts.join(', ')}.`);
    }

    const hasOrderInfo = interp.items.length > 0 || interp.itemsMode === 'remove' || !!interp.address || !!interp.deliveryInstructions;
    if (hasOrderInfo) {
      if (order && !isDraft(order)) {
        if (interp.intent === 'new_order' && interp.items.length) {
          order = null; // ny, separat ordre
        } else {
          ctx.orders.flag(order.id, 'Kunden ønsker ændring af bekræftet ordre');
          ctx.conversations.setMode(conversationId, 'ai_paused', 'Ændring af bekræftet ordre', 'ai');
          ctx.events.log('warn', 'customer_agent', 'change_confirmed_order', `Kunden vil ændre bekræftet ordre #${order.id}`, {
            requiresAction: true,
            data: { orderId: order.id, conversationId },
          });
          return { text: `Din ordre #${order.id} er allerede bekræftet. En medarbejder vender tilbage angående ændringen.`, orderId: order.id };
        }
      }
      if (!order) {
        const { id } = ctx.orders.createDraft({ customerId, conversationId, idempotencyKey: `draft:${conversationId}:${firstInboundId}`, actor: 'ai' });
        order = ctx.orders.get(id)!;
        // Brug kundens kendte adresse som forslag, hvis ingen ny er angivet
        const cust = ctx.conversations.customer(customerId);
        if (!interp.address && cust?.defaultAddress) {
          const prev = ctx.db
            .prepare(`SELECT address_text, address_lat, address_lng FROM orders WHERE customer_id = ? AND address_validated = 1 AND id <> ? ORDER BY id DESC LIMIT 1`)
            .get(customerId, id) as { address_text: string; address_lat: number; address_lng: number } | undefined;
          if (prev) {
            ctx.orders.updateFields(id, { addressText: prev.address_text, addressLat: prev.address_lat, addressLng: prev.address_lng, addressValidated: true }, 'ai');
            parts.push(`Vi bruger din tidligere adresse: ${prev.address_text}. Skriv en ny adresse, hvis den skal ændres.`);
          }
        }
      }
      const current = ctx.orders.get(order.id)!;

      // Varer
      if (interp.items.length || interp.itemsMode === 'remove') {
        const bySku = new Map(products.map((p) => [p.sku, p]));
        const lines = new Map(current.lines.map((l) => [l.productId, l.quantity]));
        const mode = interp.itemsMode === 'none' ? 'replace' : interp.itemsMode;
        if (mode === 'replace') lines.clear();
        for (const it of interp.items) {
          const p = bySku.get(it.sku);
          if (!p) continue;
          if (mode === 'remove') lines.delete(p.id);
          else lines.set(p.id, (mode === 'add' ? lines.get(p.id) ?? 0 : 0) + it.quantity);
        }
        ctx.orders.setLines(current.id, [...lines.entries()].map(([productId, quantity]) => ({ productId, quantity })), s.pricing, 'ai');
      }

      // Adresse
      if (interp.address) {
        if (geoError) {
          ctx.orders.updateFields(current.id, { addressText: interp.address, addressValidated: false }, 'ai');
          ctx.orders.flag(current.id, 'Adressen kunne ikke valideres (kortfejl)');
          ctx.conversations.setMode(conversationId, 'ai_paused', 'Adressevalidering utilgængelig', 'system');
          ctx.events.log('error', 'customer_agent', 'geocode_failed', `Adresse kunne ikke valideres for ordre #${current.id}: ${geoError}`, {
            requiresAction: true,
            data: { orderId: current.id, conversationId },
          });
          return { text: s.messages.handoffToHuman, orderId: current.id };
        }
        if (!geo || !geo.found || geo.approximate) {
          parts.push('Vi kunne ikke finde adressen præcist. Skriv venligst vejnavn, husnummer og postnummer.');
        } else if (!this.inDeliveryArea(geo)) {
          ctx.orders.updateFields(current.id, { addressText: geo.formatted ?? interp.address, addressValidated: false }, 'ai');
          parts.push(s.messages.outsideArea);
        } else {
          ctx.orders.updateFields(
            current.id,
            { addressText: geo.formatted ?? interp.address, addressLat: geo.lat!, addressLng: geo.lng!, addressValidated: true },
            'ai',
          );
          ctx.conversations.updateCustomer(customerId, { defaultAddress: geo.formatted ?? interp.address });
        }
      }
      if (interp.deliveryInstructions) ctx.orders.updateFields(current.id, { deliveryInstructions: interp.deliveryInstructions }, 'ai');
      if (interp.requestedTime) ctx.orders.updateFields(current.id, { requestedTime: interp.requestedTime }, 'ai');

      const progressed = this.advanceDraft(current.id);
      if (progressed) parts.push(progressed);
      return { text: parts.join('\n\n'), orderId: current.id };
    }

    // Ingen ordreinfo – tilføj næste skridt for en åben kladde
    if (order && isDraft(order)) {
      const next = order.status === 'awaiting_confirmation' ? 'Svar JA for at bekræfte din ordre.' : this.missingInfoText(order);
      if (next) parts.push(next);
    }
    if (!parts.length) {
      ctx.events.log('info', 'customer_agent', 'unclear_message', 'Uklar kundebesked – bad kunden præcisere', { data: { conversationId } });
      parts.push('Undskyld, det forstod jeg ikke helt. Skriv hvad du vil bestille og din adresse, fx "2 Red Bull til Nørrebrogade 10, 2200".');
    }
    return { text: parts.join('\n\n'), orderId: order?.id ?? null };
  }

  private inDeliveryArea(geo: GeocodeResult): boolean {
    const s = this.ctx.settings.get();
    if (s.delivery.postalCodes.length && geo.postalCode && !s.delivery.postalCodes.includes(geo.postalCode)) return false;
    const d = haversineMeters({ lat: s.delivery.centerLat, lng: s.delivery.centerLng }, { lat: geo.lat!, lng: geo.lng! });
    return d <= s.delivery.radiusKm * 1000;
  }

  private missingInfoText(order: Order): string | null {
    const s = this.ctx.settings.get();
    if (!order.lines.length) return 'Hvad vil du gerne bestille?';
    if (!order.addressValidated) return 'Hvilken adresse skal vi levere til? (vejnavn, husnummer og postnummer)';
    if (order.subtotalOre < s.pricing.minimumOrderOre) {
      return `Mindstekøbet er ${(s.pricing.minimumOrderOre / 100).toFixed(0)} kr. Vil du tilføje noget mere?`;
    }
    return null;
  }

  private setDraftStatus(orderId: number, to: OrderStatus): void {
    const o = this.ctx.orders.get(orderId)!;
    if (o.status !== to) this.ctx.orders.transition(orderId, to, 'ai');
  }

  /**
   * Flyt kladden frem: mangler der info → spørg; ellers lagerkontrol,
   * reservation og tilbud til kunden. Kører i transaktion.
   */
  private advanceDraft(orderId: number): string | null {
    const { ctx } = this;
    const s = ctx.settings.get();
    const order = ctx.orders.get(orderId)!;
    const missing = this.missingInfoText(order);
    if (missing) {
      if (order.status !== 'awaiting_customer_info') {
        if (order.status === 'awaiting_confirmation') ctx.inventory.releaseForOrder(orderId, 'mangler info');
        this.setDraftStatus(orderId, 'awaiting_customer_info');
      }
      return missing;
    }
    if (order.status === 'awaiting_confirmation') {
      const st = ctx.db.prepare(`SELECT stock_state FROM orders WHERE id = ?`).get(orderId) as { stock_state: string };
      if (st.stock_state === 'reserved') return quoteText(order, s); // uændret – gentag tilbud
    }
    this.setDraftStatus(orderId, 'awaiting_stock_check');
    const location = this.chooseReservationLocation(order);
    if (location === null) {
      const totals = ctx.inventory.totalAvailable();
      const short = order.lines
        .filter((l) => (totals.get(l.productId) ?? 0) < l.quantity)
        .map((l) => `${l.productName} (kun ${Math.max(0, totals.get(l.productId) ?? 0)} på lager)`);
      this.setDraftStatus(orderId, 'awaiting_customer_info');
      return short.length
        ? `Vi har desværre ikke nok af: ${short.join(', ')}. Vil du ændre din ordre?`
        : 'Vi kan ikke samle hele ordren fra ét lager lige nu. Vil du ændre antallet?';
    }
    try {
      ctx.inventory.reserveForOrder(orderId, location);
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        this.setDraftStatus(orderId, 'awaiting_customer_info');
        return 'Varerne blev desværre udsolgt lige nu. Vil du ændre din ordre?';
      }
      throw e;
    }
    this.setDraftStatus(orderId, 'awaiting_confirmation');
    ctx.jobs.enqueue('expire_quote', { orderId }, { delayMs: s.delivery.quoteExpiryMinutes * 60000, dedupeKey: `expire_quote:${orderId}` });
    return quoteText(ctx.orders.get(orderId)!, s);
  }

  /**
   * Vælg lagerlokation til reservation: nærmeste bil hos en aktiv chauffør med
   * alle varer, ellers centrallager (hvis afhentning er tilladt), ellers anden lokation.
   */
  private chooseReservationLocation(order: Order): number | null {
    const { ctx } = this;
    const s = ctx.settings.get();
    const needs = order.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }));
    const target = order.addressLat != null ? { lat: order.addressLat, lng: order.addressLng! } : null;
    const vehicles = ctx.drivers
      .list()
      .filter((d) => d.vehicleLocationId && (d.status === 'available' || d.status === 'busy') && d.activeOrderCount < d.maxActiveOrders)
      .filter((d) => ctx.inventory.canFulfil(d.vehicleLocationId!, needs))
      .map((d) => ({
        loc: d.vehicleLocationId!,
        dist: target && d.lastLat != null ? haversineMeters(target, { lat: d.lastLat, lng: d.lastLng! }) : 1e9,
      }))
      .sort((a, b) => a.dist - b.dist);
    if (vehicles.length) return vehicles[0].loc;
    const central = ctx.inventory.centralLocation();
    if (central && s.delivery.allowCentralPickup && ctx.inventory.canFulfil(central.id, needs)) return central.id;
    return null;
  }

  private confirmOrder(order: Order): { text: string; orderId: number } {
    const { ctx } = this;
    const s = ctx.settings.get();
    const st = ctx.db.prepare(`SELECT stock_state FROM orders WHERE id = ?`).get(order.id) as { stock_state: string };
    if (st.stock_state !== 'reserved') {
      const text = this.advanceDraft(order.id);
      return { text: text ?? statusText(ctx.orders.get(order.id)!, s), orderId: order.id };
    }
    ctx.orders.transition(order.id, 'confirmed', 'customer');
    ctx.jobs.cancelByDedupeKey(`expire_quote:${order.id}`);
    ctx.orders.transition(order.id, 'awaiting_driver', 'system');
    ctx.jobs.enqueue('dispatch_order', { orderId: order.id }, { dedupeKey: `dispatch:${order.id}`, lane: 'dispatch' });
    return { text: fillTemplate(s.messages.orderConfirmed, { orderId: order.id, company: s.company.name }), orderId: order.id };
  }
}
