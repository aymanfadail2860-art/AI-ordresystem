import type { AiGateway } from './gateway';
import {
  CustomerInterpretationSchema,
  DriverInterpretationSchema,
  sanitizeCustomerInterpretation,
  sanitizeDriverInterpretation,
  type CustomerInterpretation,
  type DriverInterpretation,
} from './schemas';

export interface CatalogEntry {
  sku: string;
  name: string;
  category: string;
  variant: string | null;
  available: boolean;
  synonyms: string[];
  description: string | null;
}

export interface CustomerTurnContext {
  companyName: string;
  catalog: CatalogEntry[];
  history: { from: 'customer' | 'business'; text: string }[];
  newMessages: string[];
  currentOrder: {
    id: number;
    status: string;
    items: { sku: string; name: string; quantity: number }[];
    address: string | null;
    instructions: string | null;
  } | null;
  conversationId: number;
}

export interface DriverTurnContext {
  driverName: string;
  text: string;
  activeOrders: { id: number; address: string | null; status: string; items: string }[];
  pendingOfferOrderIds: number[];
  catalog: { sku: string; name: string; synonyms: string[] }[];
}

export interface InterpretResult<T> {
  result: T;
  model: string;
  simulated: boolean;
  escalated: boolean;
}

export interface CustomerInterpreter {
  readonly simulated: boolean;
  interpret(ctx: CustomerTurnContext): Promise<InterpretResult<CustomerInterpretation>>;
}

export interface DriverInterpreter {
  readonly simulated: boolean;
  interpret(ctx: DriverTurnContext): Promise<InterpretResult<DriverInterpretation>>;
}

// ---------------------------------------------------------------------------
// Claude-baserede fortolkere (produktion)
// ---------------------------------------------------------------------------

function customerSystemPrompt(ctx: CustomerTurnContext): string {
  const catalog = ctx.catalog
    .map((c) => `- ${c.sku}: ${c.name}${c.variant ? ` (${c.variant})` : ''} [${c.category}]${c.available ? '' : ' – UDSOLGT'}${c.synonyms.length ? ` | også kaldet: ${c.synonyms.join(', ')}` : ''}${c.description ? ` | ${c.description}` : ''}`)
    .join('\n');
  return `You interpret Danish SMS messages sent by private customers to ${ctx.companyName}, a business that delivers drinks and snacks.
You never talk to the customer directly and you never take actions. You only return a structured interpretation; the business system decides what happens and writes the reply.

Rules:
- Map every product the customer wants to a SKU from the catalog below. Never invent SKUs. Put product requests you cannot map in unknownProducts (in the customer's words).
- items is the list of products and quantities mentioned in the NEW messages. itemsMode: "replace" if this is the customer's whole order (or they change their order), "add" if they want to add to the current order, "remove" if they want items removed, "none" if no products are mentioned.
- address: the delivery address exactly as written (street, number, floor/door, postal code, city) or null.
- deliveryInstructions: e.g. door code, floor, "ring på" – or null.
- requestedTime: the customer's wish for delivery time in their own words, or null.
- intent "confirm" only when the customer clearly accepts the proposed order (e.g. "ja", "ok bekræft"). "decline" when they reject the proposal without cancelling.
- questionAnswer: if the customer asks a question about products, answer briefly in Danish using ONLY facts from the catalog. Never state prices, amounts, delivery times or promises – the system adds prices itself. Put the relevant SKUs in mentionedSkus. Otherwise null.
- needsHuman = true for complaints, payment disputes, refunds, abuse, safety issues, age/legal questions, or anything unrelated to ordering. Explain in needsHumanReason.
- confidence: 0..1, how sure you are of the interpretation.

Catalog:
${catalog}`;
}

function customerUserContent(ctx: CustomerTurnContext): string {
  return JSON.stringify({
    current_order: ctx.currentOrder
      ? { status: ctx.currentOrder.status, items: ctx.currentOrder.items, address: ctx.currentOrder.address, instructions: ctx.currentOrder.instructions }
      : null,
    recent_conversation: ctx.history,
    new_customer_messages: ctx.newMessages,
  });
}

export class ClaudeCustomerInterpreter implements CustomerInterpreter {
  readonly simulated = false;
  constructor(
    private gateway: AiGateway,
    private escalateBelow: () => number,
  ) {}

  async interpret(ctx: CustomerTurnContext): Promise<InterpretResult<CustomerInterpretation>> {
    const known = new Set(ctx.catalog.map((c) => c.sku.toUpperCase()));
    const req = {
      system: customerSystemPrompt(ctx),
      userContent: customerUserContent(ctx),
      schema: CustomerInterpretationSchema,
      maxTokens: 2048,
      effort: 'low' as const,
    };
    const first = await this.gateway.structured('customer_interpret', 'customer_agent', req, { conversationId: ctx.conversationId });
    let out = first.output ? sanitizeCustomerInterpretation(first.output, known) : null;
    let model = first.model;
    let escalated = false;
    // Lav sikkerhed eller ugyldigt output → én eskalering til større model
    if (!first.refused && (!out || out.confidence < this.escalateBelow())) {
      const second = await this.gateway.structured('customer_escalation', 'customer_agent', { ...req, effort: 'medium' }, { conversationId: ctx.conversationId });
      if (second.output) {
        out = sanitizeCustomerInterpretation(second.output, known);
        model = second.model;
        escalated = true;
      }
    }
    if (!out) {
      out = handoff(first.refused ? 'AI-modellen afviste at behandle beskeden' : 'AI kunne ikke fortolke beskeden');
    }
    return { result: out, model, simulated: false, escalated };
  }
}

function handoff(reason: string): CustomerInterpretation {
  return {
    intent: 'other',
    items: [],
    itemsMode: 'none',
    unknownProducts: [],
    address: null,
    deliveryInstructions: null,
    requestedTime: null,
    customerName: null,
    mentionedSkus: [],
    questionAnswer: null,
    needsHuman: true,
    needsHumanReason: reason,
    confidence: 0,
  };
}

export function emptyDriverInterpretation(): DriverInterpretation {
  return {
    intent: 'other',
    orderId: null,
    nextOrderId: null,
    etaMinutes: null,
    delayMinutes: null,
    delayReason: null,
    productSku: null,
    quantity: null,
    note: null,
    ambiguous: false,
    clarificationQuestion: null,
    confidence: 0,
  };
}

export class ClaudeDriverInterpreter implements DriverInterpreter {
  readonly simulated = false;
  constructor(private gateway: AiGateway) {}

  async interpret(ctx: DriverTurnContext): Promise<InterpretResult<DriverInterpretation>> {
    const system = `You interpret Danish Telegram messages from delivery drivers working for a drinks delivery business.
Return only a structured interpretation; deterministic business code validates it and performs actions. You never calculate travel times, ETAs for other stops or money.
Intents:
- eta_report: driver states when they will arrive ("Ordre 142, jeg er der om 5 min") → etaMinutes
- arrived: driver is at the customer now
- delivered: an order is delivered
- completed_and_next: finished one order and driving to the next ("færdig med 142 og kører mod 143") → orderId=finished, nextOrderId=next
- heading_to: driving towards a specific order → nextOrderId
- delayed: delay in minutes ("10 min forsinket", "trafik, bliver 20 min senere") → delayMinutes, delayReason
- customer_unreachable, out_of_stock (productSku from catalog; quantity = how many the driver says are left, 0 if none), picked_up (has the goods and is driving)
- capacity_available: driver can take an extra order on the way
- accept_offer, reject_offer, go_online, go_offline, take_break, question, other
Rules:
- orderId / nextOrderId: ONLY numbers the driver explicitly wrote. Never infer from the list of active orders. Otherwise null.
- If the message is unclear or could refer to several orders, set ambiguous=true and write a short Danish clarificationQuestion to the driver.
- A delay without an order number is a delay for the driver's whole remaining route; that is not ambiguous.
Catalog SKUs: ${ctx.catalog.map((c) => `${c.sku}=${c.name}${c.synonyms.length ? ` (${c.synonyms.join(', ')})` : ''}`).join('; ')}`;
    const res = await this.gateway.structured('driver_interpret', 'driver_agent', {
      system,
      userContent: JSON.stringify({ driver_active_orders: ctx.activeOrders, pending_offers: ctx.pendingOfferOrderIds, message: ctx.text }),
      schema: DriverInterpretationSchema,
      maxTokens: 1024,
      effort: 'low',
    });
    const out = res.output ? sanitizeDriverInterpretation(res.output) : { ...emptyDriverInterpretation(), ambiguous: true };
    return { result: out, model: res.model, simulated: false, escalated: false };
  }
}

// ---------------------------------------------------------------------------
// Regelbaserede fortolkere (Demo Mode – ingen API-kald)
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  en: 1, et: 1, ét: 1, én: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, syv: 7, otte: 8, ni: 9, ti: 10, elleve: 11, tolv: 12,
  par: 2,
};

const STREET_HINT = /(vej|gade|allé|alle|plads|vænge|torv|stræde|boulevard|have|park|bakke|vang|sti|kaj|brygge|mark|toft|høj|dal)\b/i;

function normalize(t: string): string {
  return t.toLowerCase().replace(/[!?.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractAddress(text: string): string | null {
  // Fx "Nørrebrogade 12, 2. th, 2200 København N" eller "adressen er Vesterbrogade 5"
  const re = /([A-ZÆØÅ][a-zæøåé]+(?:[ -][A-ZÆØÅa-zæøåé]+){0,3}\s\d{1,4}[A-Za-z]?(?:,?\s*\d{1,2}\.?\s*(?:sal|tv|th|mf)\.?(?:\s*(?:tv|th|mf)\.?)?)?(?:,?\s*\d{4}(?:\s+[A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØ]\.?)?)?)?)/;
  const m = text.match(re);
  if (!m) return null;
  const candidate = m[1].trim().replace(/[.,]$/, '');
  if (!STREET_HINT.test(candidate) && !/\d{4}/.test(candidate)) return null;
  return candidate;
}

export function extractItems(text: string, catalog: CatalogEntry[]): { sku: string; quantity: number }[] {
  const lower = normalize(text);
  const found: { sku: string; quantity: number; index: number }[] = [];
  const taken: [number, number][] = [];
  // Længste navne først, så "coca-cola zero" matcher før "coca-cola"
  const terms = catalog
    .flatMap((c) => [c.name, ...c.synonyms].map((t) => ({ sku: c.sku, term: normalize(t) })))
    .filter((t) => t.term.length >= 3)
    .sort((a, b) => b.term.length - a.term.length);
  for (const { sku, term } of terms) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(term, from);
      if (idx < 0) break;
      from = idx + term.length;
      const end = idx + term.length;
      const before = lower[idx - 1];
      const after = lower[end];
      if ((before && /[a-zæøå]/.test(before)) || (after && /[a-zæøå]/.test(after))) continue;
      if (taken.some(([a, b]) => idx < b && end > a)) continue;
      taken.push([idx, end]);
      const prefix = lower.slice(Math.max(0, idx - 20), idx).trim().split(' ');
      let qty = 1;
      for (let i = prefix.length - 1; i >= Math.max(0, prefix.length - 3); i--) {
        const w = prefix[i];
        if (/^\d{1,3}$/.test(w)) {
          qty = parseInt(w, 10);
          break;
        }
        const x = w.replace(/x$/, '');
        if (/^\d{1,3}$/.test(x)) {
          qty = parseInt(x, 10);
          break;
        }
        if (NUMBER_WORDS[w] !== undefined) {
          qty = NUMBER_WORDS[w];
          break;
        }
      }
      found.push({ sku, quantity: qty, index: idx });
    }
  }
  const merged = new Map<string, number>();
  for (const f of found.sort((a, b) => a.index - b.index)) merged.set(f.sku, (merged.get(f.sku) ?? 0) + f.quantity);
  return [...merged.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}

export class RuleBasedCustomerInterpreter implements CustomerInterpreter {
  readonly simulated = true;
  constructor(private gateway: AiGateway | null) {}

  async interpret(ctx: CustomerTurnContext): Promise<InterpretResult<CustomerInterpretation>> {
    const raw = ctx.newMessages.join('\n');
    const t = normalize(raw);
    const items = extractItems(raw, ctx.catalog);
    const address = extractAddress(raw);
    const r: CustomerInterpretation = {
      intent: 'other',
      items,
      itemsMode: 'none',
      unknownProducts: [],
      address,
      deliveryInstructions: null,
      requestedTime: null,
      customerName: null,
      mentionedSkus: [],
      questionAnswer: null,
      needsHuman: false,
      needsHumanReason: null,
      confidence: 0.5,
    };
    const name = raw.match(/(?:jeg hedder|mit navn er)\s+([A-ZÆØÅ][a-zæøå]+(?:\s[A-ZÆØÅ][a-zæøå]+)?)/i);
    if (name) r.customerName = name[1];
    const instr = raw.match(/((?:ring på|koden er|kode|porten|bagdøren|bagdør|opgang|etage|ring til mig|bank på)[^.\n]*)/i);
    if (instr) r.deliveryInstructions = instr[1].trim();
    if (/så hurtigt som muligt|hurtigst muligt|asap|nu\b/.test(t)) r.requestedTime = 'Hurtigst muligt';
    const time = raw.match(/kl\.?\s*(\d{1,2}(?:[.:]\d{2})?)/i);
    if (time) r.requestedTime = `kl. ${time[1]}`;

    if (/(klage|snydt|forkert vare|mangler|refusion|penge tilbage|utilfreds|aldrig kom|kom aldrig)/.test(t)) {
      r.intent = 'complaint';
      r.needsHuman = true;
      r.needsHumanReason = 'Kunden har en klage';
      r.confidence = 0.9;
    } else if (/(annuller|afbestil|aflys|fortryd|glem det)/.test(t)) {
      r.intent = 'cancel_order';
      r.confidence = 0.9;
    } else if (/^(ja|jep|jo|yes|ok|okay|bekræft|bekræfter|det er fint|lyder godt|gerne|perfekt|super)\b/.test(t) && items.length === 0) {
      r.intent = 'confirm';
      r.confidence = 0.95;
    } else if (/^nej\b/.test(t) && items.length === 0) {
      r.intent = 'decline';
      r.confidence = 0.8;
    } else if (/(hvor er|hvornår kommer|status på|hvor lang tid|kommer den snart)/.test(t)) {
      r.intent = 'order_status';
      r.confidence = 0.85;
    } else if (items.length > 0) {
      const adding = /(også|tilføj|og så|plus|oveni|mere)/.test(t) && !!ctx.currentOrder?.items.length;
      const removing = /(fjern|uden|drop)/.test(t);
      r.intent = ctx.currentOrder?.items.length ? 'modify_order' : 'new_order';
      r.itemsMode = removing ? 'remove' : adding ? 'add' : 'replace';
      r.confidence = 0.85;
      if (/\?/.test(raw) && /(har i|hvad koster|pris)/.test(t)) {
        r.intent = 'question';
        r.itemsMode = 'none';
        r.mentionedSkus = items.map((i) => i.sku);
        r.items = [];
      }
    } else if (/(hvad har i|hvad sælger|menu|udvalg|hvad koster|pris|har i)/.test(t)) {
      r.intent = 'question';
      r.confidence = 0.7;
    } else if (address || r.deliveryInstructions || r.customerName) {
      r.intent = 'provide_info';
      r.confidence = 0.8;
    } else if (/^(hej|hejsa|hey|hallo|goddag|godaften|yo)\b/.test(t)) {
      r.intent = 'greeting';
      r.confidence = 0.9;
    } else {
      // Ukendt indhold – lav sikkerhed → medarbejder
      r.needsHuman = /\?/.test(raw);
      r.needsHumanReason = r.needsHuman ? 'Spørgsmål som demo-fortolkeren ikke forstår' : null;
      r.confidence = 0.3;
    }
    if (/(øl|vin|spiritus|vodka|alkohol)/.test(t) && !items.length) r.unknownProducts.push(raw.match(/(øl|vin|spiritus|vodka|alkohol)/i)?.[1] ?? '');
    this.gateway?.logSimulated('customer_agent', 'customer_interpret', raw.length + 1500, 300, { conversationId: ctx.conversationId });
    const known = new Set(ctx.catalog.map((c) => c.sku.toUpperCase()));
    return { result: sanitizeCustomerInterpretation(r, known), model: 'demo-regelbaseret', simulated: true, escalated: false };
  }
}

export class RuleBasedDriverInterpreter implements DriverInterpreter {
  readonly simulated = true;
  constructor(private gateway: AiGateway | null) {}

  async interpret(ctx: DriverTurnContext): Promise<InterpretResult<DriverInterpretation>> {
    const raw = ctx.text;
    const t = normalize(raw);
    const r = emptyDriverInterpretation();
    r.confidence = 0.4;
    const num = (re: RegExp) => {
      const m = raw.match(re);
      return m ? parseInt(m[1], 10) : null;
    };
    const ref = /(?:ordre|ordrer|order|#|nr\.?)\s*#?(\d{1,7})/i;
    r.orderId = num(ref);
    const completed = raw.match(/(?:færdig med|afleveret|leveret)\s*(?:ordre\s*)?#?(\d{1,7}).*?(?:kører mod|videre til|på vej til|kører til|tager)\s*(?:ordre\s*)?#?(\d{1,7})/i);
    const heading = raw.match(/(?:kører mod|på vej til|kører til|videre til)\s*(?:ordre\s*)?#?(\d{1,7})/i);
    const etaMin = num(/(?:der|fremme|hos (?:kunden|dem)|ankommer|ankomst)\s*(?:om|på)\s*(?:ca\.?\s*|cirka\s*)?(\d{1,3})\s*min/i) ?? num(/\bom\s*(?:ca\.?\s*)?(\d{1,3})\s*min/i);
    const delayMin =
      num(/(\d{1,3})\s*min(?:utter)?\.?\s*(?:forsinket|senere|bagud|forsinkelse)/i) ?? num(/forsinket\D{0,20}(\d{1,3})\s*min/i) ?? num(/bliver\s*(?:nok\s*)?(\d{1,3})\s*min/i);
    if (completed) {
      r.intent = 'completed_and_next';
      r.orderId = parseInt(completed[1], 10);
      r.nextOrderId = parseInt(completed[2], 10);
      r.confidence = 0.95;
    } else if (/(ikke flere|løbet tør|udsolgt|har ikke mere|ikke mere|mangler|tilbage i bilen|\d+\s+\S+.*tilbage)/.test(t) && !/(kører mod|på vej)/.test(t)) {
      r.intent = 'out_of_stock';
      const left = raw.match(/(?:har\s+(?:kun\s+)?|kun\s+)(\d{1,4})\s+(.+?)\s+tilbage/i);
      const name = left ? left[2] : raw;
      r.productSku = extractItems(name, ctx.catalog.map((c) => ({ ...c, category: '', variant: null, available: true, description: null })))[0]?.sku ?? null;
      r.quantity = left ? parseInt(left[1], 10) : /(ikke flere|løbet tør|udsolgt|har ikke mere|ikke mere)/.test(t) ? 0 : null;
      r.confidence = r.productSku ? 0.85 : 0.5;
    } else if (/(svarer ikke|åbner ikke|ingen åbner|tager ikke telefonen|ikke hjemme)/.test(t)) {
      r.intent = 'customer_unreachable';
      r.confidence = 0.9;
    } else if (/(ekstra ordre|en ordre mere|plads til (?:en )?(?:mere|ordre)|kan godt tage|kan tage en)/.test(t)) {
      r.intent = 'capacity_available';
      r.confidence = 0.9;
    } else if (delayMin != null || /forsink|trafik|kø på/.test(t)) {
      r.intent = 'delayed';
      r.delayMinutes = delayMin;
      r.delayReason = /trafik|kø/.test(t) ? 'trafik' : null;
      r.confidence = delayMin != null ? 0.9 : 0.4;
      if (delayMin == null) {
        r.ambiguous = true;
        r.clarificationQuestion = 'Hvor mange minutter forventer du at blive forsinket?';
      }
    } else if (etaMin != null) {
      r.intent = 'eta_report';
      r.etaMinutes = etaMin;
      r.confidence = 0.9;
    } else if (/(leveret|afleveret|overleveret)/.test(t)) {
      r.intent = 'delivered';
      if (!r.orderId) {
        const lone = t.match(/\b(\d{1,7})\b/);
        if (lone) r.orderId = parseInt(lone[1], 10);
      }
      r.confidence = 0.95;
    } else if (/(fremme|er ankommet|ankommet|står udenfor|er her)/.test(t)) {
      r.intent = 'arrived';
      r.confidence = 0.9;
    } else if (heading) {
      r.intent = 'heading_to';
      r.nextOrderId = parseInt(heading[1], 10);
      r.orderId = null;
      r.confidence = 0.9;
    } else if (/(hentet|kører nu|kører ud|afgang)/.test(t)) {
      r.intent = 'picked_up';
      r.confidence = 0.85;
    } else if (/^(ja|accepter|tager den|ok jeg tager)/.test(t)) {
      r.intent = 'accept_offer';
      r.confidence = 0.8;
    } else if (/^(nej|afvis|kan ikke)/.test(t)) {
      r.intent = 'reject_offer';
      r.confidence = 0.8;
    } else if (/(pause)/.test(t)) {
      r.intent = 'take_break';
      r.confidence = 0.8;
    } else if (/(offline|har fri|stopper for i dag|går hjem|logger af)/.test(t)) {
      r.intent = 'go_offline';
      r.confidence = 0.85;
    } else if (/(online|er klar|starter|møder ind)/.test(t)) {
      r.intent = 'go_online';
      r.confidence = 0.85;
    } else if (/\?/.test(raw)) {
      r.intent = 'question';
      r.note = raw.slice(0, 300);
      r.confidence = 0.6;
    } else {
      r.ambiguous = true;
      r.note = raw.slice(0, 300);
      r.clarificationQuestion = 'Jeg forstod ikke helt. Skriv fx "ordre 142, der om 5 min", "10 min forsinket" eller "ordre 142 leveret".';
      r.confidence = 0.3;
    }
    this.gateway?.logSimulated('driver_agent', 'driver_interpret', raw.length + 600, 80);
    return { result: sanitizeDriverInterpretation(r), model: 'demo-regelbaseret', simulated: true, escalated: false };
  }
}
