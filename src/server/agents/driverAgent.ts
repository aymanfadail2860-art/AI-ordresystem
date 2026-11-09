import type { Ctx } from '../context';
import type { TelegramUpdate } from '../adapters/telegram/types';
import type { DispatchAgent } from './dispatchAgent';
import type { RoutingService } from './routing';
import type { CustomerNotifier } from './notifier';
import { emptyDriverInterpretation } from '../ai/interpreters';
import type { DriverInterpretation } from '../ai/schemas';
import type { Driver } from '../../shared/types';
import { fillTemplate, formatTime } from './replies';
import { AiDisabledError, BudgetExceededError } from '../ai/gateway';
import type { ReplenishmentService } from './replenishment';

/**
 * Driver Communication Agent – uden live-GPS.
 *
 * Chaufførens Telegram-beskeder er systemets kilde til status og ETA.
 * Knapper og kommandoer håndteres deterministisk; fritekst fortolkes (AI eller
 * regelbaseret i demo) og valideres altid mod chaufførens faktiske rute.
 * Ordrenumre gættes aldrig – ved uklarhed stilles et opklarende spørgsmål.
 */
export class DriverAgent {
  /** Sættes efter konstruktion (lageropfyldning). */
  replenishment: ReplenishmentService | null = null;

  constructor(
    private ctx: Ctx,
    private dispatch: DispatchAgent,
    private routing: RoutingService,
    private notifier: CustomerNotifier,
  ) {
    ctx.jobs.register('driver_update', async (job) => {
      await this.handle(job.payload.update as TelegramUpdate, (job.payload.driverId as number) ?? null);
    });
    ctx.bus.on('telegram_update', ({ update, driverId }: { update: TelegramUpdate; driverId: number | null }) => {
      ctx.jobs.enqueue('driver_update', { update, driverId }, { lane: `driver:${driverId ?? update.fromUserId}`, maxAttempts: 3 });
    });
    ctx.bus.on('order_cancelled_for_driver', ({ orderId, driverId }: { orderId: number; driverId: number }) => {
      ctx.telegram.sendToDriver(driverId, `⚠️ Ordre #${orderId} er annulleret af kunden. Kør ikke ud med den.`, `cancelled:${orderId}`, { orderId });
      ctx.db.prepare(`UPDATE drivers SET route_version = route_version + 1, current_order_id = CASE WHEN current_order_id = ? THEN NULL ELSE current_order_id END WHERE id = ?`).run(orderId, driverId);
      ctx.jobs.enqueue('refresh_route', { driverId, reason: 'ordre annulleret' }, { dedupeKey: `refresh_route:${driverId}` });
    });
    ctx.jobs.register('refresh_route', async (job) => {
      await this.routing.refreshEtas(job.payload.driverId as number, (job.payload.reason as string) ?? 'genberegning');
    });
  }

  private reply(driverId: number, text: string, key: string): void {
    this.ctx.telegram.sendToDriver(driverId, text, key);
  }

  private recordStatus(driver: Driver, kind: string, text: string, extra: { orderId?: number | null; etaMinutes?: number | null; delayMinutes?: number | null } = {}): void {
    const now = new Date().toISOString();
    this.ctx.db
      .prepare(`UPDATE drivers SET last_status_text = ?, last_status_at = ?, status_request_sent_at = NULL WHERE id = ?`)
      .run(text.slice(0, 200), now, driver.id);
    this.ctx.db
      .prepare(`INSERT INTO driver_status_updates (driver_id, kind, order_id, eta_minutes, delay_minutes, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(driver.id, kind, extra.orderId ?? null, extra.etaMinutes ?? null, extra.delayMinutes ?? null, text.slice(0, 300), now);
    this.ctx.bus.touch('drivers', 'logistics');
  }

  async handle(u: TelegramUpdate, driverId: number | null): Promise<void> {
    const { ctx } = this;
    const driver = driverId ? ctx.drivers.get(driverId) : null;
    const replyKey = `reply:${u.updateId}`;

    if (!driver) {
      const m = u.text?.trim().match(/^\/start\s+([A-Z0-9]{4,12})$/i);
      if (m) {
        const linked = ctx.drivers.linkTelegram(m[1], u.fromUserId, u.chatId);
        if (linked) {
          ctx.events.log('info', 'telegram', 'driver_linked', `${linked.name} er forbundet til Telegram`);
          this.reply(linked.id, `Hej ${linked.name}! Du er nu forbundet til ${ctx.settings.get().company.name || 'AI Dispatch'}.\nSkriv /online når du er klar til at køre.`, replyKey);
          return;
        }
      }
      ctx.events.log('warn', 'telegram', 'unknown_user', `Besked fra ukendt Telegram-bruger ${u.fromName}`, { dedupeKey: `unknown_tg:${u.fromUserId}`, dedupeMinutes: 60 });
      if (ctx.telegram.current && u.kind === 'message') {
        await ctx.telegram.current.sendMessage(u.chatId, 'Du er ikke registreret som chauffør. Bed kontoret om en kode og skriv /start KODE.');
      }
      return;
    }

    if (u.kind === 'location') {
      // AI Dispatch bruger bevidst ikke live-GPS. Positionen gemmes ikke.
      this.reply(driver.id, 'AI Dispatch bruger ikke live-position. Skriv i stedet din status, fx "ordre 142, der om 5 min" eller "10 min forsinket".', `nolocation:${driver.id}:${new Date().toISOString().slice(0, 13)}`);
      return;
    }

    const base = emptyDriverInterpretation();
    if (u.kind === 'callback' && u.callbackData) {
      await ctx.telegram.answerCallback(u.callbackId);
      const rep = u.callbackData.match(/^rep:(\d+):(driver_accept|driver_reject|arrived|picked_up)$/);
      if (rep && this.replenishment) {
        const id = parseInt(rep[1], 10);
        this.recordStatus(driver, 'replenishment', `[knap] lagerbesøg #${id} ${rep[2]}`);
        if (rep[2] === 'driver_accept' || rep[2] === 'driver_reject') {
          const msg = await this.replenishment.driverRespond(id, driver.id, rep[2] === 'driver_accept');
          ctx.telegram.sendToDriver(driver.id, msg, replyKey, rep[2] === 'driver_accept' ? { buttons: [[{ text: '🏬 Ved lageret', data: `rep:${id}:arrived` }, { text: '📦 Afhentet', data: `rep:${id}:picked_up` }]] } : {});
        } else if (rep[2] === 'arrived') {
          this.reply(driver.id, this.replenishment.driverArrived(id, driver.id), replyKey);
        } else {
          this.reply(driver.id, await this.replenishment.driverPickedUp(id, driver.id), replyKey);
        }
        return;
      }
      const offer = u.callbackData.match(/^offer:(\d+):(accept|reject)$/);
      if (offer) {
        const msg = await this.dispatch.respondToOffer(parseInt(offer[1], 10), driver.id, offer[2] === 'accept');
        this.reply(driver.id, msg, replyKey);
        return;
      }
      const act = u.callbackData.match(/^ord:(\d+):(pickup|arrived|delivered|unreachable|delay10|delay15|eta5)$/);
      if (act) {
        const id = parseInt(act[1], 10);
        const map: Record<string, Partial<DriverInterpretation>> = {
          pickup: { intent: 'heading_to', nextOrderId: id },
          arrived: { intent: 'arrived', orderId: id },
          delivered: { intent: 'delivered', orderId: id },
          unreachable: { intent: 'customer_unreachable', orderId: id },
          delay10: { intent: 'delayed', orderId: id, delayMinutes: 10 },
          delay15: { intent: 'delayed', orderId: id, delayMinutes: 15 },
          eta5: { intent: 'eta_report', orderId: id, etaMinutes: 5 },
        };
        await this.applyIntent(driver, { ...base, ...map[act[2]], confidence: 1 }, replyKey, `[knap] ${act[2]} #${id}`);
      }
      return;
    }

    const text = (u.text ?? '').trim();
    if (!text) return;
    const cmd = text.toLowerCase().split(/\s+/)[0];
    const commands: Record<string, DriverInterpretation['intent']> = { '/online': 'go_online', '/offline': 'go_offline', '/pause': 'take_break', '/ekstra': 'capacity_available' };
    if (commands[cmd]) {
      await this.applyIntent(driver, { ...base, intent: commands[cmd], confidence: 1 }, replyKey, text);
      return;
    }
    if (cmd === '/status' || cmd === '/ordrer' || cmd === '/rute') {
      const stops = ctx.drivers.routeStops(driver.id);
      this.reply(
        driver.id,
        stops.length ? `Din rute:\n${stops.map((s) => `${s.sequence}. #${s.orderId} – ${s.address ?? ''} (ca. ${s.eta ? formatTime(s.eta) : '?'})`).join('\n')}` : 'Du har ingen aktive ordrer.',
        replyKey,
      );
      return;
    }
    if (cmd === '/start') {
      this.reply(driver.id, 'Du er allerede forbundet. Skriv /online for at blive klar.', replyKey);
      return;
    }

    // Lagerbesøg i gang: "afhentet" / "ved lageret" gælder opfyldningen
    if (this.replenishment) {
      const act = this.replenishment.active(driver.id);
      if (act && ['en_route', 'awaiting_pickup'].includes(act.status)) {
        if (/(afhentet|har hentet|varerne er i bilen|har varerne|læsset|lastet)/i.test(text)) {
          this.recordStatus(driver, 'replenishment', text);
          this.reply(driver.id, await this.replenishment.driverPickedUp(act.id, driver.id), replyKey);
          return;
        }
        if (/(ved lageret|på lageret|fremme ved lager)/i.test(text)) {
          this.recordStatus(driver, 'replenishment', text);
          this.reply(driver.id, this.replenishment.driverArrived(act.id, driver.id), replyKey);
          return;
        }
      }
    }

    let interp: DriverInterpretation;
    try {
      const active = ctx.drivers.activeOrderIds(driver.id).map((id) => ctx.orders.get(id)!);
      const res = await ctx.driverInterpreter.interpret({
        driverName: driver.name,
        text,
        activeOrders: active.map((o) => ({ id: o.id, address: o.addressText, status: o.status, items: o.lines.map((l) => `${l.quantity}× ${l.productName}`).join(', ') })),
        pendingOfferOrderIds: ctx.drivers.offers().filter((o) => o.driverId === driver.id).map((o) => o.orderId),
        catalog: ctx.catalog.list().map((p) => ({ sku: p.sku, name: p.name, synonyms: p.synonyms })),
      });
      interp = res.result;
    } catch (e) {
      if (e instanceof AiDisabledError || e instanceof BudgetExceededError) {
        this.forwardToOffice(driver, text, replyKey, 'AI er ikke tilgængelig');
        return;
      }
      throw e;
    }
    // Ingen automatiske beslutninger på baggrund af uklare beskeder
    if (interp.ambiguous || interp.confidence < 0.5) {
      this.recordStatus(driver, 'unclear', text);
      this.reply(driver.id, interp.clarificationQuestion ?? 'Jeg forstod ikke helt. Skriv fx "ordre 142, der om 5 min", "10 min forsinket" eller "ordre 142 leveret".', replyKey);
      return;
    }
    await this.applyIntent(driver, interp, replyKey, text);
  }

  private forwardToOffice(driver: Driver, text: string, replyKey: string, why: string): void {
    this.ctx.events.log('info', 'driver_agent', 'driver_message', `Besked fra ${driver.name}: "${text.slice(0, 200)}" (${why})`, { requiresAction: true, data: { driverId: driver.id } });
    this.reply(driver.id, 'Din besked er videresendt til kontoret.', replyKey);
  }

  /**
   * Find den ordre, beskeden gælder. Eksplicit ordrenummer valideres mod
   * chaufførens rute. Uden nummer bruges kun kendte fakta: chaufføren har kun
   * én aktiv ordre, eller har selv meldt hvilken ordre han kører mod.
   */
  private resolveOrder(driver: Driver, orderId: number | null): { id: number } | { error: string } {
    const active = this.ctx.drivers.activeOrderIds(driver.id);
    if (orderId != null) {
      if (!active.includes(orderId)) return { error: `Ordre #${orderId} er ikke på din rute. Dine ordrer: ${active.map((x) => '#' + x).join(', ') || 'ingen'}.` };
      return { id: orderId };
    }
    if (active.length === 1) return { id: active[0] };
    if (active.length === 0) return { error: 'Du har ingen aktive ordrer.' };
    if (driver.currentOrderId && active.includes(driver.currentOrderId)) return { id: driver.currentOrderId };
    return { error: `Hvilken ordre gælder det? Skriv fx "ordre ${active[0]}, der om 5 min". Dine ordrer: ${active.map((x) => '#' + x).join(', ')}.` };
  }

  private setCurrent(driverId: number, orderId: number | null): void {
    this.ctx.db.prepare(`UPDATE drivers SET current_order_id = ? WHERE id = ?`).run(orderId, driverId);
  }

  private describeNotified(ids: number[]): string {
    return ids.length ? ` Kunder opdateret: ${ids.map((x) => '#' + x).join(', ')}.` : '';
  }

  async applyIntent(driver: Driver, interp: DriverInterpretation, replyKey: string, text: string): Promise<void> {
    const { ctx } = this;
    const s = ctx.settings.get();
    switch (interp.intent) {
      case 'go_online':
        ctx.drivers.setStatus(driver.id, driver.activeOrderCount > 0 ? 'busy' : 'available', 'driver');
        this.recordStatus(driver, 'online', text);
        this.reply(driver.id, 'Du er online. Skriv gerne din status undervejs, fx "ordre 142, der om 5 min".', replyKey);
        return;
      case 'go_offline':
        if (driver.activeOrderCount > 0) {
          this.reply(driver.id, `Du har stadig ${driver.activeOrderCount} aktive ordrer. Aflever dem først, eller kontakt kontoret.`, replyKey);
          return;
        }
        ctx.drivers.setStatus(driver.id, 'offline', 'driver');
        this.recordStatus(driver, 'offline', text);
        this.reply(driver.id, 'Du er nu offline. Tak for i dag!', replyKey);
        return;
      case 'take_break':
        ctx.drivers.setStatus(driver.id, 'break', 'driver');
        this.recordStatus(driver, 'break', text);
        this.reply(driver.id, 'Pause registreret. Skriv /online når du er tilbage.', replyKey);
        return;
      case 'capacity_available': {
        const until = new Date(Date.now() + s.logistics.extraCapacityMinutes * 60000).toISOString();
        ctx.db.prepare(`UPDATE drivers SET extra_capacity_until = ? WHERE id = ?`).run(until, driver.id);
        this.recordStatus(driver, 'capacity', text);
        this.routing.touchAnchor(driver.id);
        const waiting = ctx.orders.list({ status: ['awaiting_driver'] });
        this.dispatch.dispatchWaiting();
        this.reply(driver.id, waiting.length ? `Tak! Vi vurderer ${waiting.length} ventende ordre(r) til dig – du får et tilbud, hvis det passer på din rute.` : 'Tak! Du får et tilbud, hvis der kommer en ordre på din rute.', replyKey);
        return;
      }
      case 'accept_offer':
      case 'reject_offer': {
        const offers = ctx.drivers.offers().filter((o) => o.driverId === driver.id && (!interp.orderId || o.orderId === interp.orderId));
        if (offers.length !== 1) {
          this.reply(driver.id, offers.length ? 'Du har flere tilbud – brug knapperne.' : 'Du har ingen åbne tilbud.', replyKey);
          return;
        }
        this.reply(driver.id, await this.dispatch.respondToOffer(offers[0].id, driver.id, interp.intent === 'accept_offer'), replyKey);
        return;
      }
      case 'out_of_stock': {
        const p = interp.productSku ? ctx.catalog.getBySku(interp.productSku) : null;
        const affected = ctx.drivers
          .activeOrderIds(driver.id)
          .map((id) => ctx.orders.get(id)!)
          .filter((o) => !p || o.lines.some((l) => l.productId === p.id));
        for (const o of affected) ctx.orders.flag(o.id, `Chaufføren melder mangel på ${p?.name ?? 'en vare'}`);
        ctx.events.log('warn', 'driver_agent', 'vehicle_stock_discrepancy', `${driver.name} melder: ingen ${p?.name ?? 'vare (ukendt)'} i bilen. Kontrollér billagerets optælling.`, {
          requiresAction: true,
          data: { driverId: driver.id, productId: p?.id ?? null, affectedOrders: affected.map((o) => o.id) },
        });
        this.recordStatus(driver, 'out_of_stock', text);
        let extra = '';
        if (p && this.replenishment && interp.quantity != null) {
          const r = await this.replenishment.reconcileVehicleStock(driver.id, p.id, interp.quantity);
          if (r.movedOrders.length) extra = ` Ordrer ${r.movedOrders.map((x) => '#' + x).join(', ')} dækkes nu fra lageret – du får besked om lagerbesøg.`;
          if (r.failedOrders.length) extra += ` Ordrer ${r.failedOrders.map((x) => '#' + x).join(', ')} kan ikke dækkes – kontoret håndterer dem.`;
        }
        this.reply(driver.id, `Noteret – kontoret er informeret${affected.length ? ` (berørte ordrer: ${affected.map((o) => '#' + o.id).join(', ')})` : ''}.${extra}`, replyKey);
        return;
      }
      case 'question':
      case 'other':
        this.recordStatus(driver, 'message', text);
        this.forwardToOffice(driver, text, replyKey, 'fritekst');
        return;
      case 'delayed': {
        if (!interp.delayMinutes) {
          this.reply(driver.id, 'Hvor mange minutter forventer du at blive forsinket?', replyKey);
          return;
        }
        // Uden ordrenummer gælder forsinkelsen hele den resterende rute (fra næste stop)
        let target: number;
        if (interp.orderId != null) {
          const r = this.resolveOrder(driver, interp.orderId);
          if ('error' in r) {
            this.reply(driver.id, r.error, replyKey);
            return;
          }
          target = r.id;
        } else {
          const stops = this.routing.stops(driver.id);
          if (!stops.length) {
            this.reply(driver.id, 'Du har ingen aktive ordrer.', replyKey);
            return;
          }
          target = stops[0].orderId;
        }
        this.routing.addStopDelay(driver.id, target, interp.delayMinutes);
        this.routing.touchAnchor(driver.id);
        this.recordStatus(driver, 'delay', text, { orderId: interp.orderId, delayMinutes: interp.delayMinutes });
        const affected = this.routing.stops(driver.id);
        const fromIdx = affected.findIndex((x) => x.orderId === target);
        const ids = affected.slice(fromIdx).map((x) => x.orderId);
        for (const id of ids) ctx.orders.addEvent(id, 'driver_delay', 'driver', { minutes: interp.delayMinutes, reason: interp.delayReason, reportedFor: target });
        if (interp.delayMinutes >= 20) for (const id of ids) ctx.orders.flag(id, `Chaufføren melder ${interp.delayMinutes} min forsinkelse`, 'driver');
        const res = await this.routing.refreshEtas(driver.id, `chauffør melder +${interp.delayMinutes} min`);
        this.reply(driver.id, `Forsinkelse på ${interp.delayMinutes} min registreret. Berørte stop: ${ids.map((x) => '#' + x).join(', ')}.${this.describeNotified(res.notifiedOrderIds)}`, replyKey);
        return;
      }
      default:
        break;
    }

    // Handlinger der kræver en bestemt ordre
    if (interp.intent === 'heading_to' || interp.intent === 'completed_and_next') {
      const next = interp.nextOrderId != null ? this.resolveOrder(driver, interp.nextOrderId) : null;
      if (next && 'error' in next) {
        this.reply(driver.id, next.error, replyKey);
        return;
      }
      if (interp.intent === 'completed_and_next') {
        if (interp.orderId == null) {
          this.reply(driver.id, 'Hvilken ordre er du færdig med? Skriv fx "færdig med 142, kører mod 143".', replyKey);
          return;
        }
        const done = this.resolveOrder(driver, interp.orderId);
        if ('error' in done) {
          this.reply(driver.id, done.error, replyKey);
          return;
        }
        this.markDelivered(driver, done.id);
      }
      if (next) {
        this.setCurrent(driver.id, next.id);
        this.routing.moveToFront(driver.id, next.id, 'chaufføren kører mod denne');
        const o = ctx.orders.get(next.id)!;
        if (o.status === 'driver_assigned') ctx.orders.transition(next.id, 'out_for_delivery', 'driver');
      }
      this.routing.touchAnchor(driver.id);
      this.recordStatus(driver, interp.intent, text, { orderId: next?.id ?? interp.orderId });
      const res = await this.routing.refreshEtas(driver.id, 'chaufførstatus');
      const nextEta = next ? ctx.orders.get(next.id)?.eta : null;
      this.reply(
        driver.id,
        `${interp.intent === 'completed_and_next' ? `✅ #${interp.orderId} registreret som leveret. ` : ''}${next ? `Kører mod #${next.id}${nextEta ? ` (forventet ca. ${formatTime(nextEta)})` : ''}.` : ''}${this.describeNotified(res.notifiedOrderIds)}`,
        replyKey,
      );
      this.afterRouteChange(driver.id);
      return;
    }

    const resolved = this.resolveOrder(driver, interp.orderId);
    if ('error' in resolved) {
      this.recordStatus(driver, 'unclear', text);
      this.reply(driver.id, resolved.error, replyKey);
      return;
    }
    const order = ctx.orders.get(resolved.id)!;
    const conv = order.conversationId;
    switch (interp.intent) {
      case 'eta_report': {
        const minutes = interp.etaMinutes ?? 0;
        this.setCurrent(driver.id, order.id);
        this.routing.moveToFront(driver.id, order.id, 'chaufførens ETA-melding');
        if (order.status === 'driver_assigned') ctx.orders.transition(order.id, 'out_for_delivery', 'driver');
        this.routing.clearStopDelay(driver.id, order.id);
        this.routing.setAnchor(driver.id, { kind: 'driver_report', atMs: Date.now() + minutes * 60000, orderId: order.id });
        this.recordStatus(driver, 'eta', text, { orderId: order.id, etaMinutes: minutes });
        ctx.orders.addEvent(order.id, 'driver_eta', 'driver', { minutes });
        const soon = this.notifier.arrivalSoon(order.id, minutes);
        const res = await this.routing.refreshEtas(driver.id, `chaufføren: #${order.id} om ${minutes} min`);
        const notified = [...new Set([...(soon ? [order.id] : []), ...res.notifiedOrderIds])];
        this.reply(driver.id, `Noteret: #${order.id} om ca. ${minutes} min.${this.describeNotified(notified)}`, replyKey);
        return;
      }
      case 'picked_up': {
        if (order.status === 'driver_assigned') ctx.orders.transition(order.id, 'out_for_delivery', 'driver');
        this.routing.touchAnchor(driver.id);
        this.recordStatus(driver, 'picked_up', text, { orderId: order.id });
        await this.routing.refreshEtas(driver.id, 'varer hentet');
        this.reply(driver.id, `Ordre #${order.id} er markeret som på vej.`, replyKey);
        if (conv) ctx.sms.queue(conv, `Din ordre #${order.id} er på vej! Vi giver besked, når chaufføren er tæt på.`, 'system', `on_the_way:${order.id}`, order.id);
        return;
      }
      case 'arrived':
        ctx.orders.addEvent(order.id, 'driver_arrived', 'driver');
        if (order.status === 'driver_assigned') ctx.orders.transition(order.id, 'out_for_delivery', 'driver');
        this.setCurrent(driver.id, order.id);
        this.routing.moveToFront(driver.id, order.id, 'chaufføren er fremme');
        this.routing.clearStopDelay(driver.id, order.id);
        this.routing.setAnchor(driver.id, { kind: 'driver_report', atMs: Date.now(), orderId: order.id });
        this.recordStatus(driver, 'arrived', text, { orderId: order.id, etaMinutes: 0 });
        if (conv) ctx.sms.queue(conv, `Din chauffør er fremme med ordre #${order.id}.`, 'system', `arrived:${order.id}`, order.id);
        await this.routing.refreshEtas(driver.id, 'chauffør fremme');
        this.reply(driver.id, 'Kunden har fået besked om, at du er fremme.', replyKey);
        return;
      case 'delivered': {
        this.markDelivered(driver, order.id);
        this.recordStatus(driver, 'delivered', text, { orderId: order.id });
        const res = await this.routing.refreshEtas(driver.id, `#${order.id} leveret`);
        const remaining = ctx.drivers.activeOrderIds(driver.id).length;
        if (remaining === 0 && ctx.drivers.get(driver.id)?.status === 'busy') ctx.drivers.setStatus(driver.id, 'available');
        this.reply(driver.id, `✅ Ordre #${order.id} er registreret som leveret.${remaining ? ` Du har ${remaining} ordre(r) tilbage.` : ''}${this.describeNotified(res.notifiedOrderIds)}`, replyKey);
        this.afterRouteChange(driver.id);
        return;
      }
      case 'customer_unreachable':
        ctx.orders.flag(order.id, 'Chaufføren kan ikke få kontakt med kunden', 'driver');
        ctx.events.log('warn', 'driver_agent', 'customer_unreachable', `Chaufføren kan ikke få kontakt med kunden på ordre #${order.id}`, { requiresAction: true, data: { orderId: order.id, driverId: driver.id } });
        this.recordStatus(driver, 'customer_unreachable', text, { orderId: order.id });
        if (conv)
          ctx.sms.queue(conv, `Din chauffør er fremme med ordre #${order.id}, men kan ikke komme i kontakt med dig.${s.company.phone ? ` Ring venligst på ${s.company.phone}.` : ' Svar venligst på denne besked.'}`, 'system', `unreachable:${order.id}`, order.id);
        this.reply(driver.id, 'Kunden har fået en SMS, og kontoret er informeret. Vent et par minutter.', replyKey);
        return;
      default:
        this.forwardToOffice(driver, interp.note ?? text, replyKey, 'ukendt handling');
    }
  }

  /** Levering bekræftet af chaufføren: afslut ordren og gør adressen til senest kendte stop. */
  private markDelivered(driver: Driver, orderId: number): void {
    const { ctx } = this;
    const s = ctx.settings.get();
    const order = ctx.orders.get(orderId)!;
    ctx.db.transaction(() => {
      if (order.status === 'driver_assigned') ctx.orders.transition(order.id, 'out_for_delivery', 'driver');
      ctx.orders.transition(order.id, 'delivered', 'driver', { via: 'telegram' });
      if (order.addressLat != null) {
        ctx.drivers.setPosition(driver.id, order.addressLat, order.addressLng!, 'delivered_stop');
        this.routing.setAnchor(driver.id, { kind: 'delivered', atMs: Date.now(), point: { lat: order.addressLat, lng: order.addressLng! } });
      }
      ctx.db.prepare(`UPDATE drivers SET current_order_id = CASE WHEN current_order_id = ? THEN NULL ELSE current_order_id END, route_version = route_version + 1 WHERE id = ?`).run(order.id, driver.id);
      if (order.conversationId) ctx.sms.queue(order.conversationId, fillTemplate(s.messages.delivered, { orderId: order.id, company: s.company.name }), 'system', `delivered:${order.id}`, order.id);
    })();
  }

  /** Efter en ruteændring: ventende ordrer kan nu passe ind. */
  private afterRouteChange(driverId: number): void {
    void driverId;
    this.dispatch.dispatchWaiting();
  }
}
