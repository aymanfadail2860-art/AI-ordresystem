import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context';
import type { TelegramButton, TelegramUpdate } from '../adapters/telegram/types';
import type { ManagementService } from '../services/management';
import { ROLE_RANK } from '../services/management';
import type { ManagementInterpreter } from '../ai/managementInterpreter';
import type { ManagementInterpretation, ManagementIntent, RuleKey } from '../ai/schemas';
import type { DispatchAgent } from './dispatchAgent';
import type { RoutingService } from './routing';
import type { ReplenishmentService } from './replenishment';
import { AiDisabledError, BudgetExceededError } from '../ai/gateway';
import { TransientAiError, PermanentAiError } from '../adapters/ai/types';
import { formatDkk } from '../../core/money';
import { formatTime } from './replies';
import { startOfToday } from '../services/orders';
import { DRAFT_STATUSES } from '../../core/orderStateMachine';
import type { Driver, ManagementRole, ManagementUser, Order, OrderStatus } from '../../shared/types';
import { DRIVER_STATUS_LABELS, MANAGEMENT_ROLE_LABELS, ORDER_STATUS_LABELS, REPLENISHMENT_STATUS_LABELS } from '../../shared/types';

/** Mindste rolle pr. intention. Observatører må kun se. */
const REQUIRED_ROLE: Record<ManagementIntent, ManagementRole> = {
  revenue_today: 'observer',
  orders_outstanding: 'observer',
  driver_status: 'observer',
  most_delayed: 'observer',
  driver_stock: 'observer',
  all_driver_stock: 'observer',
  orders_awaiting_delivery: 'observer',
  explain_assignment: 'observer',
  stock_problems: 'observer',
  report: 'observer',
  route_economics: 'observer',
  help: 'observer',
  unknown: 'observer',
  reassign_order: 'manager',
  prioritize_order: 'manager',
  request_route_plan: 'manager',
  pause_order: 'manager',
  resume_order: 'manager',
  manual_handling: 'manager',
  approve_replenishment: 'manager',
  reject_replenishment: 'manager',
  set_automation: 'admin',
  change_rule: 'admin',
};

/** Handlinger der kræver eksplicit bekræftelse, før de udføres. */
const NEEDS_CONFIRMATION: ManagementIntent[] = [
  'reassign_order',
  'prioritize_order',
  'request_route_plan',
  'pause_order',
  'resume_order',
  'manual_handling',
  'approve_replenishment',
  'reject_replenishment',
  'set_automation',
  'change_rule',
];

const RULE_LIMITS: Record<RuleKey, { min: number; max: number; label: string; section: 'economics' | 'notifications' | 'logistics' }> = {
  promiseToleranceMinutes: { min: 0, max: 30, label: 'tolerance på leveringsløfter', section: 'economics' },
  maxDeliveryMinutes: { min: 20, max: 300, label: 'maks. leveringstid', section: 'economics' },
  significantChangeMinutes: { min: 1, max: 30, label: 'grænse for væsentlig ruteændring', section: 'economics' },
  lateThresholdMinutes: { min: 3, max: 60, label: 'grænse for kundeopdatering ved forsinkelse', section: 'notifications' },
  statusStaleMinutes: { min: 5, max: 120, label: 'grænse for forældet chaufførstatus', section: 'logistics' },
};

interface Resolved {
  driver: Driver | null;
  order: Order | null;
  productId: number | null;
}

/**
 * Ledelsesagent: ledelsesgruppen i Telegram som kontrolcenter.
 *
 * - Både chat-ID og bruger-ID verificeres; roller: administrator, leder, observatør.
 * - AI'en fortolker kun instruktionen. Alle tal hentes fra databasen, og alle
 *   handlinger udføres via de eksisterende forretningsservices.
 * - Følsomme handlinger kræver eksplicit bekræftelse fra et menneske; ændringer
 *   i en chaufførs accepterede rute kræver stadig chaufførens accept.
 * - Alt logges: bruger, tidspunkt, instruktion, berørte ordrer, beslutning, resultat.
 */
export class ManagementAgent {
  constructor(
    private ctx: Ctx,
    private mgmt: ManagementService,
    private interpreter: ManagementInterpreter,
    private dispatch: DispatchAgent,
    private routing: RoutingService,
    private replenishment: ReplenishmentService,
  ) {
    ctx.jobs.register('management_update', async (job) => this.handle(job.payload.update as TelegramUpdate));
    ctx.bus.on('management_update', ({ update }: { update: TelegramUpdate }) => {
      ctx.jobs.enqueue('management_update', { update }, { lane: `mgmt:${update.chatId}`, maxAttempts: 3 });
    });
  }

  private reply(chatId: string, text: string, key: string, buttons?: TelegramButton[][]): void {
    this.ctx.telegram.sendToChat(chatId, text, key, buttons);
  }

  private now(): string {
    return formatTime(new Date().toISOString());
  }

  async handle(u: TelegramUpdate): Promise<void> {
    const { ctx, mgmt } = this;
    const s = ctx.settings.get().management;
    const key = `mgmt_reply:${u.updateId}`;
    const text = (u.text ?? '').trim();

    // Tilknytning: /leder KODE
    const link = text.match(/^\/leder\s+([A-Z0-9]{4,12})$/i);
    if (link) {
      const user = mgmt.link(link[1], u.fromUserId);
      this.reply(u.chatId, user ? `Velkommen ${user.name} – du er tilknyttet som ${MANAGEMENT_ROLE_LABELS[user.role].toLowerCase()}. Skriv "hjælp".` : 'Koden er ugyldig eller brugt.', key);
      return;
    }
    const inGroup = !!s.groupChatId && u.chatId === s.groupChatId;
    const inPrivate = s.allowPrivateChats && u.chatId === u.fromUserId;
    const user = mgmt.byTelegram(u.fromUserId);
    const instruction = u.kind === 'callback' ? `[knap] ${u.callbackData}` : text;
    if (!inGroup && !inPrivate) {
      mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction, intent: null, decision: 'denied', result: 'Ikke-autoriseret chat' });
      return;
    }
    if (!user) {
      mgmt.logCommand({ user: null, telegramUserId: u.fromUserId, chatId: u.chatId, instruction, intent: null, decision: 'denied', result: `Ukendt Telegram-bruger (${u.fromName})` });
      ctx.events.log('warn', 'management', 'unknown_user', `Ukendt bruger ${u.fromName} forsøgte at bruge ledelsesgruppen`, { dedupeKey: `mgmt_unknown:${u.fromUserId}`, dedupeMinutes: 60 });
      this.reply(u.chatId, `${u.fromName}: Du er ikke registreret som leder. Bed en administrator om en kode og skriv /leder KODE.`, key);
      return;
    }

    if (u.kind === 'callback' && u.callbackData) {
      await ctx.telegram.answerCallback(u.callbackId);
      await this.handleCallback(u, user, key);
      return;
    }
    if (!text) return;

    let interp: ManagementInterpretation;
    try {
      interp = await this.interpreter.interpret({
        text,
        drivers: ctx.drivers.list().map((d) => ({ id: d.id, name: d.name })),
        products: ctx.catalog.list().map((p) => ({ sku: p.sku, name: p.name, synonyms: p.synonyms })),
      });
    } catch (e) {
      if (e instanceof AiDisabledError || e instanceof BudgetExceededError || e instanceof TransientAiError || e instanceof PermanentAiError) {
        mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: text, intent: null, decision: 'failed', result: `AI utilgængelig: ${(e as Error).message}` });
        this.reply(u.chatId, 'AI-fortolkning er ikke tilgængelig lige nu. Brug kontrolpanelet, eller prøv igen om lidt.', key);
        return;
      }
      throw e;
    }
    if (interp.ambiguous || interp.confidence < 0.5 || interp.intent === 'unknown') {
      const q = interp.clarificationQuestion ?? 'Det forstod jeg ikke helt. Skriv "hjælp" for eksempler.';
      mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: text, intent: interp.intent, decision: 'clarify', result: q });
      this.reply(u.chatId, q, key);
      return;
    }
    const resolved = this.resolve(interp);
    if ('error' in resolved) {
      mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: text, intent: interp.intent, params: interp as never, decision: 'clarify', result: resolved.error });
      this.reply(u.chatId, resolved.error, key);
      return;
    }
    const affected = resolved.order ? [resolved.order.id] : [];
    const needed = REQUIRED_ROLE[interp.intent];
    if (ROLE_RANK[user.role] < ROLE_RANK[needed]) {
      const msg = `${user.name}: Din rolle (${MANAGEMENT_ROLE_LABELS[user.role].toLowerCase()}) må ikke ${needed === 'admin' ? 'ændre kritiske regler' : 'udføre handlinger'} – kun ${MANAGEMENT_ROLE_LABELS[needed].toLowerCase()} eller højere. Handlingen er ikke udført.`;
      mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: text, intent: interp.intent, params: interp as never, affectedOrders: affected, decision: 'denied', result: msg });
      this.reply(u.chatId, msg, key);
      return;
    }

    if (!NEEDS_CONFIRMATION.includes(interp.intent)) {
      const answer = await this.query(interp.intent, resolved);
      mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: text, intent: interp.intent, params: this.params(interp), affectedOrders: affected, decision: 'answered', result: answer });
      this.reply(u.chatId, answer, key);
      return;
    }
    // Følsom handling → eksplicit bekræftelse
    const preview = this.preview(interp, resolved);
    if ('error' in preview) {
      mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: text, intent: interp.intent, params: this.params(interp), affectedOrders: affected, decision: 'rejected', result: preview.error });
      this.reply(u.chatId, preview.error, key);
      return;
    }
    const expires = new Date(Date.now() + this.ctx.settings.get().management.confirmTimeoutMinutes * 60000).toISOString();
    const id = mgmt.logCommand({
      user,
      telegramUserId: u.fromUserId,
      chatId: u.chatId,
      instruction: text,
      intent: interp.intent,
      params: { ...this.params(interp), driverId: resolved.driver?.id ?? null },
      affectedOrders: affected,
      decision: 'needs_confirmation',
      result: preview.text,
      confirmToken: randomBytes(8).toString('hex'),
      confirmExpiresAt: expires,
    });
    this.reply(u.chatId, `${preview.text}\n\nBekræft inden kl. ${formatTime(expires)}.`, key, [
      [{ text: '✅ Bekræft', data: `mgmt:${id}:confirm` }, { text: '✖️ Annullér', data: `mgmt:${id}:cancel` }],
    ]);
  }

  private params(i: ManagementInterpretation): Record<string, unknown> {
    return Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== null && !['confidence', 'ambiguous', 'clarificationQuestion'].includes(k)));
  }

  // ---------------- Knapper ----------------

  private async handleCallback(u: TelegramUpdate, user: ManagementUser, key: string): Promise<void> {
    const { mgmt } = this;
    const data = u.callbackData!;
    const rep = data.match(/^rep:(\d+):(approve|reject|alts)$/);
    if (rep) {
      const id = parseInt(rep[1], 10);
      const action = rep[2];
      if (action !== 'alts' && ROLE_RANK[user.role] < ROLE_RANK.manager) {
        const msg = `${user.name}: Kun ledere og administratorer kan godkende eller afvise opfyldninger.`;
        mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: data, intent: `replenishment_${action}`, params: { replenishmentId: id }, decision: 'denied', result: msg });
        this.reply(u.chatId, msg, key);
        return;
      }
      const result =
        action === 'alts'
          ? this.replenishment.alternativesText(id)
          : action === 'approve'
            ? this.replenishment.approve(id, { name: user.name, source: 'telegram' })
            : await this.replenishment.reject(id, { name: user.name, source: 'telegram' }, `Afvist af ${user.name}`);
      const covers = this.replenishment.get(id)?.coversOrders ?? [];
      mgmt.logCommand({ user, telegramUserId: u.fromUserId, chatId: u.chatId, instruction: data, intent: `replenishment_${action}`, params: { replenishmentId: id }, affectedOrders: covers, decision: action === 'alts' ? 'answered' : 'executed', result });
      this.reply(u.chatId, result, key);
      return;
    }
    const conf = data.match(/^mgmt:(\d+):(confirm|cancel)$/);
    if (!conf) return;
    const id = parseInt(conf[1], 10);
    const row = mgmt.commandRow(id);
    if (!row || row.decision !== 'needs_confirmation') {
      this.reply(u.chatId, 'Denne handling er allerede afgjort eller findes ikke.', key);
      return;
    }
    // Kun den der gav instruktionen (eller en administrator) kan bekræfte
    if (row.user_id !== user.id && user.role !== 'admin') {
      this.reply(u.chatId, `${user.name}: Kun ${row.user_name} eller en administrator kan bekræfte denne handling.`, key);
      return;
    }
    if (conf[2] === 'cancel') {
      mgmt.updateCommand(id, { decision: 'cancelled', result: `Annulleret af ${user.name}`, confirmedBy: user.name });
      this.reply(u.chatId, 'Handlingen er annulleret.', key);
      return;
    }
    if (row.confirm_expires_at && new Date(row.confirm_expires_at as string).getTime() < Date.now()) {
      mgmt.updateCommand(id, { decision: 'expired', result: 'Bekræftelsen udløb' });
      this.reply(u.chatId, 'Bekræftelsen er udløbet – giv instruktionen igen.', key);
      return;
    }
    const intent = row.intent as ManagementIntent;
    if (ROLE_RANK[user.role] < ROLE_RANK[REQUIRED_ROLE[intent]]) {
      this.reply(u.chatId, `${user.name}: Din rolle må ikke udføre denne handling.`, key);
      return;
    }
    const params = JSON.parse((row.params as string) ?? '{}') as ManagementInterpretation & { driverId?: number | null };
    const res = await this.execute(intent, params, user);
    mgmt.updateCommand(id, { decision: res.ok ? 'executed' : 'failed', result: res.message, confirmedBy: user.name });
    this.ctx.audit.record(`telegram:${user.name}`, `management_${intent}`, 'management_command', id, { ok: res.ok });
    this.reply(u.chatId, res.message, key);
  }

  // ---------------- Opslag af parametre ----------------

  resolveDriver(ref: string | null): Driver | { error: string } | null {
    if (!ref) return null;
    const drivers = this.ctx.drivers.list(true);
    if (/^\d+$/.test(ref.trim())) {
      const d = drivers.find((x) => x.id === parseInt(ref, 10));
      return d ?? { error: `Chauffør #${ref} findes ikke. Chauffører: ${drivers.map((x) => `#${x.id} ${x.name}`).join(', ')}.` };
    }
    const q = ref.trim().toLowerCase();
    const hits = drivers.filter((d) => d.name.toLowerCase() === q || d.name.toLowerCase().split(' ').some((w) => w === q) || d.name.toLowerCase().startsWith(q));
    if (hits.length === 1) return hits[0];
    if (!hits.length) return { error: `Jeg kan ikke finde chaufføren "${ref}". Chauffører: ${drivers.map((x) => `#${x.id} ${x.name}`).join(', ')}.` };
    return { error: `"${ref}" passer på flere chauffører: ${hits.map((x) => `#${x.id} ${x.name}`).join(', ')}. Skriv nummeret.` };
  }

  private resolve(i: ManagementInterpretation): Resolved | { error: string } {
    const { ctx } = this;
    const needsDriver: ManagementIntent[] = ['driver_status', 'driver_stock', 'request_route_plan', 'route_economics', 'reassign_order'];
    const needsOrder: ManagementIntent[] = ['reassign_order', 'prioritize_order', 'pause_order', 'resume_order', 'manual_handling', 'explain_assignment'];
    const d = this.resolveDriver(i.driverRef);
    if (d && 'error' in d) return { error: d.error };
    if (needsDriver.includes(i.intent) && !d) return { error: 'Hvilken chauffør? Skriv fx "chauffør 2".' };
    let order: Order | null = null;
    if (needsOrder.includes(i.intent)) {
      if (!i.orderId) return { error: 'Hvilken ordre? Skriv fx "ordre 185".' };
      order = ctx.orders.get(i.orderId);
      if (!order) return { error: `Ordre #${i.orderId} findes ikke.` };
    }
    if ((i.intent === 'approve_replenishment' || i.intent === 'reject_replenishment') && !i.replenishmentId) {
      const pending = this.replenishment.list({ activeOnly: true }).filter((r) => r.status === 'awaiting_management');
      if (pending.length !== 1) return { error: pending.length ? `Hvilken opfyldning? Afventende: ${pending.map((r) => `#${r.id} (${r.driverName})`).join(', ')}.` : 'Der er ingen opfyldninger, der afventer godkendelse.' };
      i.replenishmentId = pending[0].id;
    }
    let productId: number | null = null;
    if (i.productRef) {
      const p = ctx.catalog.getBySku(i.productRef) ?? ctx.catalog.list().find((x) => [x.name, ...x.synonyms].some((n) => n.toLowerCase() === i.productRef!.toLowerCase()));
      productId = p?.id ?? null;
    }
    return { driver: (d as Driver | null) ?? null, order, productId };
  }

  // ---------------- Spørgsmål (kun data fra databasen) ----------------

  async query(intent: ManagementIntent, r: Resolved): Promise<string> {
    switch (intent) {
      case 'revenue_today':
        return this.revenueText();
      case 'orders_outstanding':
        return this.outstandingText();
      case 'driver_status':
        return this.driverStatusText(r.driver!);
      case 'most_delayed':
        return this.mostDelayedText();
      case 'driver_stock':
        return this.driverStockText(r.driver!, r.productId);
      case 'all_driver_stock':
        return this.ctx.drivers.list().filter((d) => d.vehicleLocationId).map((d) => this.driverStockText(d, null)).join('\n\n');
      case 'orders_awaiting_delivery':
        return this.awaitingDeliveryText();
      case 'explain_assignment':
        return this.explainText(r.order!);
      case 'stock_problems':
        return this.stockProblemsText();
      case 'report':
        return [this.revenueText(), this.outstandingText(), this.mostDelayedText(), this.stockProblemsText()].join('\n\n');
      case 'route_economics':
        return this.routeEconomicsText(r.driver!);
      case 'help':
      default:
        return this.helpText();
    }
  }

  private revenueText(): string {
    const { ctx } = this;
    const today = startOfToday();
    const d = ctx.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_ore),0) AS rev FROM orders WHERE delivered_at >= ?`).get(today) as { n: number; rev: number };
    const open = ctx.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_ore),0) AS rev FROM orders WHERE status IN ('confirmed','awaiting_driver','driver_assigned','out_for_delivery') AND created_at >= ?`)
      .get(today) as { n: number; rev: number };
    const margin = ctx.settings.get().economics.defaultMarginPct;
    const delivered = ctx.db.prepare(`SELECT id, delivery_fee_ore FROM orders WHERE delivered_at >= ?`).all(today) as { id: number; delivery_fee_ore: number }[];
    let contribution = 0;
    let estimated = false;
    for (const o of delivered) {
      const v = this.routing.valueOf(o.id, o.delivery_fee_ore, margin);
      contribution += v.contributionOre;
      estimated ||= v.contributionEstimated;
    }
    return `💰 Omsætning i dag (leveret): ${formatDkk(d.rev)} fra ${d.n} ordrer.\nDækningsbidrag: ${formatDkk(contribution)}${estimated ? ' (delvist estimeret – vareomkostning mangler på nogle varer)' : ''}.\nUnder levering/bekræftet: ${open.n} ordrer for ${formatDkk(open.rev)} (ikke medregnet).\n(data kl. ${this.now()})`;
  }

  private outstandingText(): string {
    const groups: [string, OrderStatus[]][] = [
      ['I kundedialog', [...DRAFT_STATUSES]],
      ['Afventer chauffør', ['confirmed', 'awaiting_driver']],
      ['Tildelt chauffør', ['driver_assigned']],
      ['Under levering', ['out_for_delivery']],
      ['Kræver manuel behandling', ['needs_manual']],
    ];
    const lines = groups.map(([label, st]) => {
      const list = this.ctx.orders.list({ status: st });
      return `${label}: ${list.length}${list.length ? ` (${list.slice(0, 8).map((o) => '#' + o.id).join(', ')}${list.length > 8 ? ' …' : ''})` : ''}`;
    });
    const total = this.ctx.orders.list({ activeOnly: true }).length;
    return `📦 ${total} ordrer er ikke afsluttet:\n${lines.join('\n')}\n(data kl. ${this.now()})`;
  }

  private driverStatusText(d: Driver): string {
    const { ctx } = this;
    const s = ctx.settings.get();
    const stops = ctx.drivers.routeStops(d.id);
    const anchor = this.routing.getAnchor(d.id);
    const lastInfo = Math.max(anchor?.reportedAtMs ?? 0, d.lastStatusAt ? new Date(d.lastStatusAt).getTime() : 0);
    const age = lastInfo ? Math.round((Date.now() - lastInfo) / 60000) : null;
    const stale = stops.length > 0 && (age === null || age > s.logistics.statusStaleMinutes);
    const delivered = ctx.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_ore),0) AS rev FROM orders WHERE driver_id = ? AND delivered_at >= ?`).get(d.id, startOfToday()) as { n: number; rev: number };
    const route = stops.length
      ? stops.map((x) => `${x.sequence}. #${x.orderId} ca. ${x.eta ? formatTime(x.eta) : '?'}${x.confidence === 'low' ? ' (usikker)' : ''}`).join('\n')
      : 'Ingen planlagte stop.';
    const rep = this.replenishment.active(d.id);
    return [
      `🚗 Chauffør #${d.id} ${d.name} – ${DRIVER_STATUS_LABELS[d.status]}`,
      `Seneste status: ${d.lastStatusText ? `"${d.lastStatusText}"` : 'ingen'}${age !== null ? ` (${age} min siden)` : ''}`,
      stale ? `⚠️ Status er forældet – ETA'erne er usikre og loves ikke til kunder.` : '',
      `Leveret i dag: ${delivered.n} ordrer, ${formatDkk(delivered.rev)}`,
      `Rute:\n${route}`,
      rep ? `Lageropfyldning #${rep.id}: ${REPLENISHMENT_STATUS_LABELS[rep.status]}` : '',
      `(data kl. ${this.now()}; ingen live-GPS – baseret på Telegram-status og ruteplan)`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private mostDelayedText(): string {
    const { ctx } = this;
    const rows = ctx.db
      .prepare(
        `SELECT o.id, o.eta, o.eta_communicated, o.eta_confidence, d.name AS driver FROM orders o LEFT JOIN drivers d ON d.id = o.driver_id
         WHERE o.status IN ('driver_assigned','out_for_delivery')`,
      )
      .all() as { id: number; eta: string | null; eta_communicated: string | null; eta_confidence: string | null; driver: string | null }[];
    const delays = rows
      .filter((r) => r.eta && r.eta_communicated)
      .map((r) => ({ ...r, delay: Math.round((new Date(r.eta!).getTime() - new Date(r.eta_communicated!).getTime()) / 60000) }))
      .filter((r) => r.delay >= 1)
      .sort((a, b) => b.delay - a.delay);
    const uncertain = rows.filter((r) => r.eta_confidence === 'low').length;
    if (!delays.length) return `⏱ Ingen ordrer er forsinket i forhold til det, kunderne har fået oplyst.${uncertain ? ` ${uncertain} ETA'er er dog usikre.` : ''} (data kl. ${this.now()})`;
    return `⏱ Mest forsinket:\n${delays
      .slice(0, 5)
      .map((r) => `#${r.id} (${r.driver ?? '–'}): ca. ${r.delay} min efter lovet tid${r.eta_confidence === 'low' ? ' – usikker' : ''}`)
      .join('\n')}${uncertain ? `\n${uncertain} ETA'er er usikre (forældet status eller afventer opfyldning).` : ''}\n(data kl. ${this.now()})`;
  }

  private driverStockText(d: Driver, productId: number | null): string {
    const { ctx } = this;
    if (!d.vehicleLocationId) return `${d.name} har ikke registreret lager i bilen.`;
    const f = this.replenishment.forecast(d.id);
    const levels = ctx.inventory.levels().filter((l) => l.locationId === d.vehicleLocationId && (productId ? l.productId === productId : l.quantity > 0));
    const pids = productId ? [productId] : levels.map((l) => l.productId);
    if (!pids.length) return `🚗 ${d.name} har intet på lager i bilen.`;
    const last = f.stops.length ? f.stops[f.stops.length - 1].after : f.start;
    const lines = pids.map((pid) => {
      const l = levels.find((x) => x.productId === pid);
      const name = ctx.catalog.get(pid)?.name ?? `#${pid}`;
      const need = f.stops.reduce((a, s) => a + (s.needs[pid] ?? 0), 0);
      const short = f.shortages.find((x) => x.productId === pid);
      return `${name}: ${l?.quantity ?? 0} i bilen (${l?.reserved ?? 0} reserveret), ruten kræver ${need}, forventet tilbage efter ruten: ${Math.max(0, last[pid] ?? 0)}${short ? ` ⚠️ mangler ${short.missing} fra ordre #${short.firstStopOrderId}` : ''}`;
    });
    return `📦 Chauffør #${d.id} ${d.name} – lager i bilen:\n${lines.join('\n')}\n(registreret lager kl. ${this.now()}; fysisk optælling bekræftes af chaufføren)`;
  }

  private awaitingDeliveryText(): string {
    const list = this.ctx.orders.list({ status: ['confirmed', 'awaiting_driver', 'driver_assigned', 'out_for_delivery'] });
    if (!list.length) return `Ingen ordrer afventer levering. (data kl. ${this.now()})`;
    return `🚚 ${list.length} ordrer afventer levering:\n${list
      .slice(0, 15)
      .map((o) => `#${o.id} ${ORDER_STATUS_LABELS[o.status]}${o.driverName ? ` – ${o.driverName}` : ''}${o.eta ? `, ca. ${formatTime(o.eta)}${o.etaConfidence === 'low' ? ' (usikker)' : ''}` : ''}`)
      .join('\n')}${list.length > 15 ? '\n…' : ''}\n(data kl. ${this.now()})`;
  }

  private explainText(o: Order): string {
    const offers = this.ctx.drivers.offers(o.id).filter((x) => x.status === 'accepted');
    const acc = offers[0];
    if (!acc?.plan) {
      if (o.driverId) return `Ordre #${o.id} blev tildelt ${o.driverName} uden registreret automatisk begrundelse (fx manuelt af en medarbejder).`;
      return `Ordre #${o.id} er ikke tildelt en chauffør endnu (status: ${ORDER_STATUS_LABELS[o.status]}).`;
    }
    const a = acc.plan.analysis;
    const alts = acc.plan.alternatives.filter((x) => x.driverId !== acc.driverId).slice(0, 3);
    return [
      `🧭 Ordre #${o.id} → ${acc.driverName} (stop ${acc.plan.insertIndex + 1} af ${acc.plan.sequence.length}):`,
      ...a.explanation.map((x) => `• ${x}`),
      `Score ${a.score} (højere er bedre).`,
      alts.length ? `Alternativer:\n${alts.map((x) => `• ${x.driverName}: ${x.feasible ? `score ${x.score}` : x.reason}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private stockProblemsText(): string {
    const { ctx } = this;
    const lines: string[] = [];
    for (const d of ctx.drivers.list()) {
      if (!d.activeOrderCount) continue;
      const f = this.replenishment.forecast(d.id);
      for (const s of f.shortages) lines.push(`• ${d.name}: mangler ${s.missing}× ${s.productName} fra ordre #${s.firstStopOrderId}`);
    }
    const reps = this.replenishment.list({ activeOnly: true });
    for (const r of reps) lines.push(`• Opfyldning #${r.id} (${r.driverName}): ${REPLENISHMENT_STATUS_LABELS[r.status]}`);
    for (const e of ctx.events.list({ onlyOpen: true }).filter((x) => ['vehicle_stock_discrepancy', 'vehicle_stock_reported', 'no_solution'].includes(x.type))) lines.push(`• ${e.message}`);
    const central = ctx.inventory.centralLocation();
    if (central) {
      for (const l of ctx.inventory.levels().filter((x) => x.locationId === central.id && x.quantity - x.reserved < 5)) {
        lines.push(`• Centrallager: kun ${l.quantity - l.reserved} ledige ${ctx.catalog.get(l.productId)?.name}`);
      }
    }
    return lines.length ? `⚠️ Lagerproblemer:\n${lines.join('\n')}\n(data kl. ${this.now()})` : `✅ Ingen kendte lagerproblemer. (data kl. ${this.now()})`;
  }

  private routeEconomicsText(d: Driver): string {
    const { ctx } = this;
    const stops = this.routing.stops(d.id);
    if (!stops.length) return `${d.name} har ingen planlagt rute.`;
    const rs = ctx.drivers.routeStops(d.id);
    const rev = stops.reduce((a, s) => a + s.value.revenueOre, 0);
    const con = stops.reduce((a, s) => a + s.value.contributionOre, 0);
    const est = stops.some((s) => s.value.contributionEstimated);
    const driveMin = Math.round(rs.reduce((a, s) => a + (s.durationFromPrevS ?? 0), 0) / 60);
    const lastEta = rs[rs.length - 1]?.eta;
    const hours = lastEta ? Math.max(0.25, (new Date(lastEta).getTime() - Date.now()) / 3600000) : 1;
    const cost = driveMin * ctx.settings.get().economics.driveCostPerMinuteOre;
    return [
      `📊 Rute for chauffør #${d.id} ${d.name}: ${stops.length} stop`,
      `Omsætning: ${formatDkk(rev)} · dækningsbidrag: ${formatDkk(con)}${est ? ' (delvist estimeret)' : ''}`,
      `Kørsel: ca. ${driveMin} min (≈ ${formatDkk(cost)} i kørselsomkostning)`,
      `Dækningsbidrag efter kørsel: ${formatDkk(con - cost)}`,
      `Leveringer pr. time (plan): ${(stops.length / hours).toFixed(1)}`,
      ...stops.map((s, i) => `${i + 1}. #${s.orderId}: ${formatDkk(s.value.revenueOre)}`),
      `(data kl. ${this.now()})`,
    ].join('\n');
  }

  private helpText(): string {
    return [
      'Jeg kan svare på fx:',
      '• "Hvad har vi omsat for i dag?" • "Hvor mange ordrer mangler vi?"',
      '• "Hvordan går det med chauffør 2?" • "Hvem er mest forsinket?"',
      '• "Hvor meget cola har chauffør 1 tilbage?" • "Vis mig alle lagerproblemer"',
      '• "Hvilke ordrer afventer levering?" • "Hvorfor valgte du chauffør 2 til ordre 190?"',
      '• "Rapport" • "Økonomisk analyse af chauffør 3"',
      'Handlinger (ledere): "Flyt ordre 185 til chauffør 3", "Prioritér ordre 220", "Find en bedre rute til chauffør 4", "Sæt ordre 12 på pause", "Genoptag ordre 12", "Manuel håndtering af ordre 12", "Godkend opfyldning 3"',
      'Administratorer: "Slå automatik fra", "Sæt tolerance til 10 min"',
    ].join('\n');
  }

  // ---------------- Handlinger ----------------

  private preview(i: ManagementInterpretation, r: Resolved): { text: string } | { error: string } {
    const o = r.order;
    switch (i.intent) {
      case 'reassign_order':
        if (o!.status === 'out_for_delivery') return { error: `Ordre #${o!.id} er under levering – chaufføren har varerne. Brug "manuel håndtering" og kontakt chaufføren.` };
        return { text: `Flyt ordre #${o!.id} til chauffør #${r.driver!.id} ${r.driver!.name}${i.force ? ' (SÆRLIG BESLUTNING: også selv om det bryder en begrænsning)' : ''}?\nDer sendes et tilbud til chaufføren – ændringen gælder først, når chaufføren accepterer.` };
      case 'prioritize_order':
        return { text: `Prioritér ordre #${o!.id}? Den rykkes kun frem, hvis det kan ske uden at bryde leveringsløfter. En ændret rute skal accepteres af chaufføren.` };
      case 'request_route_plan':
        return { text: `Beregn en bedre rute for chauffør #${r.driver!.id} ${r.driver!.name}? Et bedre forslag sendes til chaufføren, som skal acceptere det.` };
      case 'pause_order':
        if (o!.status === 'out_for_delivery') return { error: `Ordre #${o!.id} er under levering og kan ikke sættes på pause. Brug "manuel håndtering".` };
        if (o!.status === 'delivered' || o!.status === 'cancelled') return { error: `Ordre #${o!.id} er afsluttet.` };
        return { text: `Sæt ordre #${o!.id} på pause? Den fjernes fra automatisk behandling${o!.driverName ? `, og ${o!.driverName} får besked om ikke at køre ud med den` : ''}.` };
      case 'resume_order':
        if (!o!.pausedFromStatus) return { error: `Ordre #${o!.id} er ikke sat på pause.` };
        return { text: `Genoptag ordre #${o!.id}? Den sendes tilbage til automatisk behandling${['driver_assigned', 'awaiting_driver', 'confirmed'].includes(o!.pausedFromStatus) ? ' og skal tildeles en chauffør igen' : ''}.` };
      case 'manual_handling':
        return { text: `Overgå ordre #${o!.id} til manuel håndtering? AI'en stopper automatik for ordren og kundesamtalen.` };
      case 'approve_replenishment':
        return { text: `Godkend opfyldning #${i.replenishmentId}? Chaufføren bliver derefter bedt om at acceptere lagerbesøget.` };
      case 'reject_replenishment':
        return { text: `Afvis opfyldning #${i.replenishmentId}? Systemet forsøger at finde en anden forsvarlig løsning.` };
      case 'set_automation':
        if (i.enable === null) return { error: 'Skal automatik slås til eller fra?' };
        return { text: `Slå automatik ${i.enable ? 'TIL' : 'FRA'} for hele systemet?` };
      case 'change_rule': {
        if (!i.ruleKey || i.ruleValue === null) return { error: 'Hvilken regel og hvilken værdi? Fx "sæt tolerance til 10 min".' };
        const lim = RULE_LIMITS[i.ruleKey];
        if (i.ruleValue < lim.min || i.ruleValue > lim.max) return { error: `Værdien for ${lim.label} skal være mellem ${lim.min} og ${lim.max} minutter.` };
        return { text: `Sæt ${lim.label} til ${i.ruleValue} min?` };
      }
      default:
        return { error: 'Ukendt handling.' };
    }
  }

  async execute(intent: ManagementIntent, p: ManagementInterpretation & { driverId?: number | null }, user: ManagementUser): Promise<{ ok: boolean; message: string }> {
    const { ctx } = this;
    const order = p.orderId ? ctx.orders.get(p.orderId) : null;
    switch (intent) {
      case 'reassign_order': {
        const r = await this.dispatch.offerToDriver(p.orderId!, p.driverId!, { force: p.force });
        return { ok: r.ok, message: r.message };
      }
      case 'prioritize_order': {
        if (!order) return { ok: false, message: 'Ordren findes ikke.' };
        ctx.db.prepare(`UPDATE orders SET priority = 1 WHERE id = ?`).run(order.id);
        ctx.orders.addEvent(order.id, 'prioritized', 'staff', { by: user.name });
        if (['awaiting_driver', 'confirmed'].includes(order.status)) {
          this.dispatch.dispatchWaiting();
          return { ok: true, message: `Ordre #${order.id} er prioriteret og tildeles før andre ventende ordrer.` };
        }
        if (order.status === 'driver_assigned' || order.status === 'out_for_delivery') {
          const plan = await this.routing.prioritizePlan(order.driverId!, order.id);
          const stops = this.routing.stops(order.driverId!);
          const current = stops.findIndex((x) => x.orderId === order.id);
          if (current === 0) return { ok: true, message: `Ordre #${order.id} er allerede næste stop for ${order.driverName}.` };
          if (!plan) {
            const promised = stops.slice(0, current).filter((x) => x.promisedMs).map((x) => '#' + x.orderId);
            return { ok: false, message: `Ordre #${order.id} kan ikke rykkes frem uden at bryde leveringsløfter${promised.length ? ` (${promised.join(', ')})` : ''}. Den er markeret som prioriteret og vægtes højere ved næste planlægning.` };
          }
          const res = this.dispatch.createRouteChangeOffer(
            order.driverId!,
            order.id,
            plan.sequence,
            plan.analysis,
            Object.fromEntries(plan.etas.map((e) => [String(e.orderId), new Date(e.etaMs).toISOString()])),
          );
          return { ok: res.ok, message: res.ok ? `Ordre #${order.id} foreslås flyttet fra stop ${current + 1} til stop ${plan.insertIndex + 1}${plan.analysis.maxExistingDelayMinutes ? ` (andre rykkes højst ${plan.analysis.maxExistingDelayMinutes} min, alle løfter overholdes)` : ''}. ${res.message}` : res.message };
        }
        return { ok: false, message: `Ordre #${order.id} kan ikke prioriteres (status: ${ORDER_STATUS_LABELS[order.status]}).` };
      }
      case 'request_route_plan': {
        const d = ctx.drivers.get(p.driverId!);
        if (!d) return { ok: false, message: 'Chaufføren findes ikke.' };
        const r = await this.routing.optimizeRoute(d.id);
        if (!r) return { ok: true, message: `${d.name} har færre end 2 stop – intet at optimere.` };
        const gain = r.current.costOre - r.best.costOre;
        const minGain = ctx.settings.get().replenishment.minRouteImprovementOre;
        if (r.best.sequence.join() === r.current.sequence.join() || gain < minGain) {
          return { ok: true, message: `Den nuværende rute for ${d.name} er allerede den bedste gyldige (forbedring under ${formatDkk(minGain)}). Rute: ${r.current.sequence.map((x) => '#' + x).join(' → ')}.` };
        }
        const analysis = {
          score: -r.best.costOre,
          revenueOre: 0,
          contributionOre: 0,
          contributionEstimated: false,
          extraDriveMinutes: r.best.driveMinutes - r.current.driveMinutes,
          newOrderEtaMinutes: 0,
          routeRevenueOre: 0,
          routeContributionOre: 0,
          routeDriveMinutes: r.best.driveMinutes,
          deliveriesPerHour: 0,
          maxExistingDelayMinutes: Math.max(0, ...r.best.sequence.map((id) => Math.round((r.best.etas[id] - r.current.etas[id]) / 60000))),
          lateRiskMinutes: 0,
          reassignmentCostOre: 0,
          nearby: false,
          significantChange: true,
          explanation: [`Forbedring ca. ${formatDkk(gain)}`, `Kørsel ${r.current.driveMinutes} → ${r.best.driveMinutes} min`, 'Alle givne leveringsløfter overholdes'],
        };
        const res = this.dispatch.createRouteChangeOffer(
          d.id,
          r.best.sequence[0],
          r.best.sequence,
          analysis,
          Object.fromEntries(Object.entries(r.best.etas).map(([k, v]) => [k, new Date(v).toISOString()])),
        );
        return { ok: res.ok, message: res.ok ? `Bedre rute fundet for ${d.name}: ${r.current.sequence.map((x) => '#' + x).join(' → ')} ⇒ ${r.best.sequence.map((x) => '#' + x).join(' → ')} (≈ ${formatDkk(gain)} bedre, kørsel ${r.current.driveMinutes} → ${r.best.driveMinutes} min). ${res.message}` : res.message };
      }
      case 'pause_order': {
        if (!order) return { ok: false, message: 'Ordren findes ikke.' };
        if (order.status === 'out_for_delivery' || order.status === 'delivered' || order.status === 'cancelled' || order.status === 'needs_manual') {
          return { ok: false, message: `Ordre #${order.id} kan ikke sættes på pause (status: ${ORDER_STATUS_LABELS[order.status]}).` };
        }
        const driverId = order.driverId;
        ctx.db.transaction(() => {
          ctx.db.prepare(`UPDATE orders SET paused_from_status = ? WHERE id = ?`).run(order.status, order.id);
          ctx.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).run(order.id);
          ctx.orders.transition(order.id, 'needs_manual', 'staff', { reason: `Sat på pause af ${user.name}` });
          ctx.orders.flag(order.id, `Sat på pause af ${user.name}`, 'staff');
          if (driverId) ctx.db.prepare(`UPDATE drivers SET route_version = route_version + 1 WHERE id = ?`).run(driverId);
        })();
        if (driverId) {
          ctx.telegram.sendToDriver(driverId, `⏸ Ordre #${order.id} er sat på pause af kontoret – kør ikke ud med den.`, `paused:${order.id}:${Date.now()}`, { orderId: order.id });
          await this.routing.refreshEtas(driverId, 'ordre sat på pause');
        }
        return { ok: true, message: `⏸ Ordre #${order.id} er sat på pause.${driverId ? ' Chaufføren har fået besked.' : ''}` };
      }
      case 'resume_order': {
        if (!order || !order.pausedFromStatus || order.status !== 'needs_manual') return { ok: false, message: `Ordre #${p.orderId} er ikke sat på pause.` };
        const from = order.pausedFromStatus;
        const target: OrderStatus = ['confirmed', 'awaiting_driver', 'driver_assigned'].includes(from) ? 'awaiting_driver' : from;
        ctx.db.transaction(() => {
          ctx.db.prepare(`UPDATE orders SET paused_from_status = NULL WHERE id = ?`).run(order.id);
          ctx.orders.transition(order.id, target, 'staff', { reason: `Genoptaget af ${user.name}` });
          ctx.orders.updateFields(order.id, { needsAttention: false, attentionReason: null }, 'staff');
        })();
        if (target === 'awaiting_driver') this.dispatch.enqueue(order.id);
        return { ok: true, message: `▶️ Ordre #${order.id} er genoptaget (${ORDER_STATUS_LABELS[target]}).` };
      }
      case 'manual_handling': {
        if (!order) return { ok: false, message: 'Ordren findes ikke.' };
        if (order.status === 'needs_manual') return { ok: true, message: `Ordre #${order.id} er allerede i manuel behandling.` };
        if (order.status === 'delivered' || order.status === 'cancelled') return { ok: false, message: `Ordre #${order.id} er afsluttet.` };
        ctx.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).run(order.id);
        ctx.orders.transition(order.id, 'needs_manual', 'staff', { reason: `Manuel håndtering (${user.name})` });
        ctx.orders.flag(order.id, `Manuel håndtering besluttet af ${user.name}`, 'staff');
        if (order.conversationId) ctx.conversations.setMode(order.conversationId, 'manual', `Ledelsen: manuel håndtering af ordre #${order.id}`, `telegram:${user.name}`);
        if (order.driverId) ctx.telegram.sendToDriver(order.driverId, `ℹ️ Ordre #${order.id} håndteres nu manuelt af kontoret – afvent besked.`, `manual:${order.id}`, { orderId: order.id });
        return { ok: true, message: `Ordre #${order.id} håndteres nu manuelt. AI-automatik er stoppet for ordren og kundesamtalen.` };
      }
      case 'approve_replenishment':
        return { ok: true, message: this.replenishment.approve(p.replenishmentId!, { name: user.name, source: 'telegram' }) };
      case 'reject_replenishment':
        return { ok: true, message: await this.replenishment.reject(p.replenishmentId!, { name: user.name, source: 'telegram' }, `Afvist af ${user.name}`) };
      case 'set_automation':
        ctx.settings.update({ installation: { automationEnabled: !!p.enable } });
        ctx.events.log(p.enable ? 'info' : 'warn', 'management', 'automation', `Automatik slået ${p.enable ? 'TIL' : 'FRA'} af ${user.name} via Telegram`);
        return { ok: true, message: `Automatik er slået ${p.enable ? 'TIL' : 'FRA'}.` };
      case 'change_rule': {
        const lim = RULE_LIMITS[p.ruleKey!];
        ctx.settings.update({ [lim.section]: { [p.ruleKey!]: p.ruleValue } } as never);
        ctx.events.log('info', 'management', 'rule_changed', `${user.name} ændrede ${lim.label} til ${p.ruleValue} min via Telegram`);
        return { ok: true, message: `${lim.label[0].toUpperCase()}${lim.label.slice(1)} er sat til ${p.ruleValue} min.` };
      }
      default:
        return { ok: false, message: 'Ukendt handling.' };
    }
  }
}
