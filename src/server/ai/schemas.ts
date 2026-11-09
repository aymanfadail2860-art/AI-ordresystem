import { z } from 'zod';

/**
 * Strukturerede outputskemaer for AI-fortolkning. AI'en returnerer KUN
 * fortolkninger – alle handlinger (priser, lager, statusskift) udføres af
 * deterministisk kode efter validering mod forretningsreglerne.
 */
export const CUSTOMER_INTENTS = [
  'new_order',
  'modify_order',
  'confirm',
  'decline',
  'cancel_order',
  'question',
  'order_status',
  'greeting',
  'provide_info',
  'complaint',
  'other',
] as const;

export const CustomerInterpretationSchema = z.object({
  intent: z.enum(CUSTOMER_INTENTS),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int() })),
  itemsMode: z.enum(['none', 'replace', 'add', 'remove']),
  unknownProducts: z.array(z.string()),
  address: z.string().nullable(),
  deliveryInstructions: z.string().nullable(),
  requestedTime: z.string().nullable(),
  customerName: z.string().nullable(),
  mentionedSkus: z.array(z.string()),
  questionAnswer: z.string().nullable(),
  needsHuman: z.boolean(),
  needsHumanReason: z.string().nullable(),
  confidence: z.number(),
});
export type CustomerInterpretation = z.infer<typeof CustomerInterpretationSchema>;

export const DRIVER_INTENTS = [
  'eta_report',
  'arrived',
  'delivered',
  'completed_and_next',
  'heading_to',
  'delayed',
  'customer_unreachable',
  'out_of_stock',
  'picked_up',
  'capacity_available',
  'accept_offer',
  'reject_offer',
  'go_online',
  'go_offline',
  'take_break',
  'question',
  'other',
] as const;

/**
 * Chaufførbesked → struktureret fortolkning. AI'en må ALDRIG gætte et
 * ordrenummer: står det ikke i beskeden, er orderId null, og uklarhed
 * markeres med ambiguous + et opklarende spørgsmål.
 */
export const DriverInterpretationSchema = z.object({
  intent: z.enum(DRIVER_INTENTS),
  orderId: z.number().int().nullable(),
  nextOrderId: z.number().int().nullable(),
  etaMinutes: z.number().int().nullable(),
  delayMinutes: z.number().int().nullable(),
  delayReason: z.string().nullable(),
  productSku: z.string().nullable(),
  /** Antal chaufføren melder at have tilbage af en vare (lagermelding). */
  quantity: z.number().int().nullable(),
  note: z.string().nullable(),
  ambiguous: z.boolean(),
  clarificationQuestion: z.string().nullable(),
  confidence: z.number(),
});
export type DriverInterpretation = z.infer<typeof DriverInterpretationSchema>;

/** Ekstra validering ud over skemaet (værdiområder, kendte SKU'er). */
export function sanitizeCustomerInterpretation(x: CustomerInterpretation, knownSkus: Set<string>): CustomerInterpretation {
  const items = x.items
    .map((i) => ({ sku: i.sku.trim().toUpperCase(), quantity: Math.trunc(i.quantity) }))
    .filter((i) => i.quantity > 0 && i.quantity <= 500);
  const unknown = [...x.unknownProducts];
  const valid = items.filter((i) => {
    if (knownSkus.has(i.sku)) return true;
    unknown.push(i.sku);
    return false;
  });
  // Et AI-svar må aldrig selv angive priser – fjern svar der nævner beløb
  let answer = x.questionAnswer?.trim() || null;
  if (answer && /\d+([.,]\d+)?\s*(kr|dkk|,-)/i.test(answer)) answer = null;
  if (answer && answer.length > 400) answer = answer.slice(0, 400);
  return {
    ...x,
    items: valid,
    itemsMode: valid.length === 0 && x.itemsMode !== 'remove' ? 'none' : x.itemsMode,
    unknownProducts: [...new Set(unknown)].slice(0, 10),
    address: x.address?.trim() || null,
    deliveryInstructions: x.deliveryInstructions?.trim().slice(0, 300) || null,
    requestedTime: x.requestedTime?.trim().slice(0, 100) || null,
    customerName: x.customerName?.trim().slice(0, 80) || null,
    mentionedSkus: x.mentionedSkus.map((s) => s.toUpperCase()).filter((s) => knownSkus.has(s)),
    questionAnswer: answer,
    confidence: Math.max(0, Math.min(1, x.confidence)),
  };
}

export function sanitizeDriverInterpretation(x: DriverInterpretation): DriverInterpretation {
  return {
    ...x,
    orderId: x.orderId != null && x.orderId > 0 ? x.orderId : null,
    nextOrderId: x.nextOrderId != null && x.nextOrderId > 0 ? x.nextOrderId : null,
    etaMinutes: x.etaMinutes != null ? Math.max(0, Math.min(240, Math.trunc(x.etaMinutes))) : null,
    delayMinutes: x.delayMinutes != null ? Math.max(1, Math.min(240, Math.trunc(x.delayMinutes))) : null,
    delayReason: x.delayReason?.trim().slice(0, 100) || null,
    clarificationQuestion: x.clarificationQuestion?.trim().slice(0, 300) || null,
    productSku: x.productSku?.trim().toUpperCase() || null,
    quantity: x.quantity != null ? Math.max(0, Math.min(10000, Math.trunc(x.quantity))) : null,
    note: x.note?.trim().slice(0, 300) || null,
    confidence: Math.max(0, Math.min(1, x.confidence)),
  };
}

// ---------------------------------------------------------------------------
// Ledelsesgruppen
// ---------------------------------------------------------------------------

export const MANAGEMENT_INTENTS = [
  'revenue_today',
  'orders_outstanding',
  'driver_status',
  'most_delayed',
  'driver_stock',
  'all_driver_stock',
  'orders_awaiting_delivery',
  'explain_assignment',
  'stock_problems',
  'report',
  'route_economics',
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
  'help',
  'unknown',
] as const;
export type ManagementIntent = (typeof MANAGEMENT_INTENTS)[number];

export const RULE_KEYS = ['promiseToleranceMinutes', 'maxDeliveryMinutes', 'significantChangeMinutes', 'lateThresholdMinutes', 'statusStaleMinutes'] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

/**
 * Ledelsesinstruktion → struktureret fortolkning. AI'en vælger kun intention
 * og parametre; tal og svar hentes altid fra databasen af deterministisk kode.
 */
export const ManagementInterpretationSchema = z.object({
  intent: z.enum(MANAGEMENT_INTENTS),
  orderId: z.number().int().nullable(),
  driverRef: z.string().nullable(),
  productRef: z.string().nullable(),
  replenishmentId: z.number().int().nullable(),
  ruleKey: z.enum(RULE_KEYS).nullable(),
  ruleValue: z.number().nullable(),
  enable: z.boolean().nullable(),
  force: z.boolean(),
  ambiguous: z.boolean(),
  clarificationQuestion: z.string().nullable(),
  confidence: z.number(),
});
export type ManagementInterpretation = z.infer<typeof ManagementInterpretationSchema>;

export function emptyManagementInterpretation(): ManagementInterpretation {
  return {
    intent: 'unknown',
    orderId: null,
    driverRef: null,
    productRef: null,
    replenishmentId: null,
    ruleKey: null,
    ruleValue: null,
    enable: null,
    force: false,
    ambiguous: false,
    clarificationQuestion: null,
    confidence: 0,
  };
}
