import type { Ctx } from '../context';
import type { TelegramUpdate } from '../adapters/telegram/types';
import type { DispatchAgent } from './dispatchAgent';
import type { RoutingService } from './routing';
import type { DriverInterpretation } from '../ai/schemas';
import type { Driver } from '../../shared/types';
import { fillTemplate } from './replies';
import { AiDisabledError, BudgetExceededError } from '../ai/gateway';

/**
 * Driver Communication Agent.
 * Knapper og kommandoer håndteres deterministisk. Fritekst fortolkes af AI
 * (eller regelbaseret i demo), og handlingen valideres altid mod chaufførens
 * faktiske ordrer. Ordrenummer gættes aldrig.
 */
export class DriverAgent {
  private lastRouteRecompute = new Map<number, number>();

  constructor(
    private ctx: Ctx,
    private dispatch: DispatchAgent,
    private routing: RoutingService,
  ) {
    ctx.jobs.register('driver_update', async (job) => {
      await this.handle(job.payload.update as TelegramUpdate, (job.payload.driverId as number) ?? null);
    });
    ctx.bus.on('telegram_update', ({ update, driverId }: { update: TelegramUpdate; driverId: number | null }) => {
      ctx.jobs.enqueue('driver_update', { update, driverId }, { lane: `driver:${driverId ?? update.fromUserId}`, maxAttempts: 3 });
    });
    ctx.bus.on('order_cancelled_for_driver', ({ orderId, driverId }: { orderId: number; driverId: number }) => {
      ctx.telegram.sendToDriver(driverId, `⚠️ Ordre #${orderId} er annulleret af kunden. Kør ikke ud med den.`, `cancelled:${orderId}`, { orderId });
      ctx.jobs.enqueue('recompute_route', { driverId }, { dedupeKey: `recompute_route:${driverId}` });
    });
    ctx.jobs.register('recompute_route', async (job) => {
      await this.routing.recompute(job.payload.driverId as number);
    });
  }

  private reply(driverId: number, text: string, key: string): void {
    this.ctx.telegram.sendToDriver(driverId, text, key);
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
      ctx.events.log('warn', 'telegram', 'unknown_user', `Besked fra ukendt Telegram-bruger ${u.fromName}`, {
        dedupeKey: `unknown_tg:${u.fromUserId}`,
        dedupeMinutes: 60,
      });
      if (ctx.telegram.current && u.kind === 'message') {
        await ctx.telegram.current.sendMessage(u.chatId, 'Du er ikke registreret som chauffør. Bed kontoret om en kode og skriv /start KODE.');
      }
      return;
    }

    if (u.kind === 'location' && u.location) {
      ctx.drivers.setPosition(driver.id, u.location.lat, u.location.lng, 'telegram_live');
      const last = this.lastRouteRecompute.get(driver.id) ?? 0;
      if (driver.activeOrderCount > 0 && Date.now() - last > 120_000) {
        this.lastRouteRecompute.set(driver.id, Date.now());
        await this.routing.recompute(driver.id);
      }
      return;
    }

    if (u.kind === 'callback' && u.callbackData) {
      await ctx.telegram.answerCallback(u.callbackId);
      const offer = u.callbackData.match(/^offer:(\d+):(accept|reject)$/);
      if (offer) {
        const msg = await this.dispatch.respondToOffer(parseInt(offer[1], 10), driver.id, offer[2] === 'accept');
        this.reply(driver.id, msg, replyKey);
        return;
      }
      const act = u.callbackData.match(/^ord:(\d+):(pickup|arrived|delivered|unreachable|delay15)$/);
      if (act) {
        const map = { pickup: 'picked_up', arrived: 'arrived', delivered: 'delivered', unreachable: 'customer_unreachable', delay15: 'delayed' } as const;
        await this.applyIntent(driver, { intent: map[act[2] as keyof typeof map], orderId: parseInt(act[1], 10), delayMinutes: act[2] === 'delay15' ? 15 : null, productSku: null, note: null, confidence: 1 }, replyKey);
      }
      return;
    }

    const text = (u.text ?? '').trim();
    if (!text) return;
    const cmd = text.toLowerCase().split(/\s+/)[0];
    const commands: Record<string, DriverInterpretation['intent']> = {
      '/online': 'go_online',
      '/offline': 'go_offline',
      '/pause': 'take_break',
    };
    if (commands[cmd]) {
      await this.applyIntent(driver, { intent: commands[cmd], orderId: null, delayMinutes: null, productSku: null, note: null, confidence: 1 }, replyKey);
      return;
    }
    if (cmd === '/status' || cmd === '/ordrer') {
      const orders = ctx.drivers.activeOrderIds(driver.id).map((id) => ctx.orders.get(id)!);
      this.reply(
        driver.id,
        orders.length ? `Dine aktive ordrer:\n${orders.map((o) => `#${o.id} – ${o.addressText} (${o.status === 'out_for_delivery' ? 'på vej' : 'tildelt'})`).join('\n')}` : 'Du har ingen aktive ordrer.',
        replyKey,
      );
      return;
    }
    if (cmd === '/start') {
      this.reply(driver.id, 'Du er allerede forbundet. Skriv /online for at blive klar.', replyKey);
      return;
    }

    const products = ctx.catalog.list();
    let interp: DriverInterpretation;
    try {
      const active = ctx.drivers.activeOrderIds(driver.id).map((id) => ctx.orders.get(id)!);
      const res = await ctx.driverInterpreter.interpret({
        driverName: driver.name,
        text,
        activeOrders: active.map((o) => ({ id: o.id, address: o.addressText, status: o.status, items: o.lines.map((l) => `${l.quantity}× ${l.productName}`).join(', ') })),
        pendingOfferOrderIds: ctx.drivers.offers().filter((o) => o.driverId === driver.id).map((o) => o.orderId),
        catalog: products.map((p) => ({ sku: p.sku, name: p.name, synonyms: p.synonyms })),
      });
      interp = res.result;
    } catch (e) {
      if (e instanceof AiDisabledError || e instanceof BudgetExceededError) {
        this.forwardToOffice(driver, text, replyKey, 'AI er ikke tilgængelig');
        return;
      }
      throw e;
    }
    if (interp.confidence < 0.5) {
      this.reply(driver.id, 'Jeg forstod ikke helt. Brug knapperne eller skriv fx "ordre 142 leveret" eller "15 min forsinket".', replyKey);
      return;
    }
    await this.applyIntent(driver, interp, replyKey);
  }

  private forwardToOffice(driver: Driver, text: string, replyKey: string, why: string): void {
    this.ctx.events.log('info', 'driver_agent', 'driver_message', `Besked fra ${driver.name}: "${text.slice(0, 200)}" (${why})`, {
      requiresAction: true,
      data: { driverId: driver.id },
    });
    this.reply(driver.id, 'Din besked er videresendt til kontoret.', replyKey);
  }

  /** Find ordren handlingen gælder. Kræver entydighed – ellers spørges chaufføren. */
  private resolveOrder(driver: Driver, orderId: number | null): { id: number } | { error: string } {
    const active = this.ctx.drivers.activeOrderIds(driver.id);
    if (orderId != null) {
      if (!active.includes(orderId)) return { error: `Ordre #${orderId} er ikke tildelt dig. Dine ordrer: ${active.map((x) => '#' + x).join(', ') || 'ingen'}.` };
      return { id: orderId };
    }
    if (active.length === 1) return { id: active[0] };
    if (active.length === 0) return { error: 'Du har ingen aktive ordrer.' };
    return { error: `Hvilken ordre? Skriv fx "ordre ${active[0]} leveret". Dine ordrer: ${active.map((x) => '#' + x).join(', ')}.` };
  }

  async applyIntent(driver: Driver, interp: DriverInterpretation, replyKey: string): Promise<void> {
    const { ctx } = this;
    const s = ctx.settings.get();
    switch (interp.intent) {
      case 'go_online':
        ctx.drivers.setStatus(driver.id, driver.activeOrderCount > 0 ? 'busy' : 'available', 'driver');
        this.reply(driver.id, 'Du er online. Del gerne din live-position i Telegram, så ETA bliver præcis.', replyKey);
        return;
      case 'go_offline':
        if (driver.activeOrderCount > 0) {
          this.reply(driver.id, `Du har stadig ${driver.activeOrderCount} aktive ordrer. Aflever dem først, eller kontakt kontoret.`, replyKey);
          return;
        }
        ctx.drivers.setStatus(driver.id, 'offline', 'driver');
        this.reply(driver.id, 'Du er nu offline. Tak for i dag!', replyKey);
        return;
      case 'take_break':
        ctx.drivers.setStatus(driver.id, 'break', 'driver');
        this.reply(driver.id, 'Pause registreret. Skriv /online når du er tilbage.', replyKey);
        return;
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
        this.reply(driver.id, `Noteret – kontoret er informeret${affected.length ? ` (berørte ordrer: ${affected.map((o) => '#' + o.id).join(', ')})` : ''}.`, replyKey);
        return;
      }
      case 'question':
      case 'other':
        this.forwardToOffice(driver, interp.note ?? 'besked', replyKey, 'fritekst');
        return;
      default:
        break;
    }

    const resolved = this.resolveOrder(driver, interp.orderId);
    if ('error' in resolved) {
      this.reply(driver.id, resolved.error, replyKey);
      return;
    }
    const order = ctx.orders.get(resolved.id)!;
    const conv = order.conversationId;
    switch (interp.intent) {
      case 'picked_up': {
        if (order.status === 'driver_assigned') ctx.orders.transition(order.id, 'out_for_delivery', 'driver');
        await this.routing.recompute(driver.id);
        const o = ctx.orders.get(order.id)!;
        this.reply(driver.id, `Ordre #${order.id} er markeret som på vej.`, replyKey);
        if (conv) ctx.sms.queue(conv, `Din ordre #${order.id} er på vej! Vi giver besked, når chaufføren er fremme.`, 'system', `on_the_way:${order.id}`, order.id);
        void o;
        return;
      }
      case 'arrived':
        ctx.orders.addEvent(order.id, 'driver_arrived', 'driver');
        if (order.status === 'driver_assigned') ctx.orders.transition(order.id, 'out_for_delivery', 'driver');
        if (conv) ctx.sms.queue(conv, `Din chauffør er fremme med ordre #${order.id}.`, 'system', `arrived:${order.id}`, order.id);
        this.reply(driver.id, 'Kunden har fået besked om, at du er fremme.', replyKey);
        return;
      case 'delivered': {
        ctx.db.transaction(() => {
          if (order.status === 'driver_assigned') ctx.orders.transition(order.id, 'out_for_delivery', 'driver');
          ctx.orders.transition(order.id, 'delivered', 'driver', { via: 'telegram' });
          if (conv) ctx.sms.queue(conv, fillTemplate(s.messages.delivered, { orderId: order.id, company: s.company.name }), 'system', `delivered:${order.id}`, order.id);
        })();
        await this.routing.recompute(driver.id);
        const remaining = ctx.drivers.activeOrderIds(driver.id).length;
        if (remaining === 0 && ctx.drivers.get(driver.id)?.status === 'busy') ctx.drivers.setStatus(driver.id, 'available');
        this.reply(driver.id, `✅ Ordre #${order.id} er registreret som leveret.${remaining ? ` Du har ${remaining} ordre(r) tilbage.` : ''}`, replyKey);
        return;
      }
      case 'delayed': {
        const minutes = interp.delayMinutes ?? 10;
        const base = order.eta ? new Date(order.eta).getTime() : Date.now();
        ctx.orders.updateFields(order.id, { eta: new Date(base + minutes * 60000).toISOString() }, 'driver');
        ctx.orders.addEvent(order.id, 'driver_delay', 'driver', { minutes });
        if (minutes >= 20) ctx.orders.flag(order.id, `Chaufføren melder ${minutes} min forsinkelse`, 'driver');
        if (conv) ctx.sms.queue(conv, `Din chauffør er desværre ca. ${minutes} minutter forsinket med ordre #${order.id}. Beklager ventetiden.`, 'system', `driver_delay:${order.id}:${replyKey}`, order.id);
        this.reply(driver.id, `Forsinkelse på ${minutes} min registreret. Kunden har fået besked.`, replyKey);
        return;
      }
      case 'customer_unreachable':
        ctx.orders.flag(order.id, 'Chaufføren kan ikke få kontakt med kunden', 'driver');
        ctx.events.log('warn', 'driver_agent', 'customer_unreachable', `Chaufføren kan ikke få kontakt med kunden på ordre #${order.id}`, {
          requiresAction: true,
          data: { orderId: order.id, driverId: driver.id },
        });
        if (conv)
          ctx.sms.queue(
            conv,
            `Din chauffør er fremme med ordre #${order.id}, men kan ikke komme i kontakt med dig.${s.company.phone ? ` Ring venligst på ${s.company.phone}.` : ' Svar venligst på denne besked.'}`,
            'system',
            `unreachable:${order.id}`,
            order.id,
          );
        this.reply(driver.id, 'Kunden har fået en SMS, og kontoret er informeret. Vent et par minutter.', replyKey);
        return;
      default:
        this.forwardToOffice(driver, interp.note ?? 'ukendt', replyKey, 'ukendt handling');
    }
  }
}
