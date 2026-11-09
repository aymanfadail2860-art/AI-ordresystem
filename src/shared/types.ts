// Delte domænetyper – bruges af både backend (server) og UI (renderer).
// Beløb gemmes altid i øre (heltal) for at undgå afrundingsfejl.

export const ORDER_STATUSES = [
  'new_inquiry',
  'awaiting_customer_info',
  'awaiting_stock_check',
  'awaiting_confirmation',
  'confirmed',
  'awaiting_driver',
  'driver_assigned',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'needs_manual',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new_inquiry: 'Ny henvendelse',
  awaiting_customer_info: 'Afventer kundeoplysninger',
  awaiting_stock_check: 'Afventer lagerkontrol',
  awaiting_confirmation: 'Afventer bekræftelse',
  confirmed: 'Bekræftet',
  awaiting_driver: 'Afventer chauffør',
  driver_assigned: 'Tildelt chauffør',
  out_for_delivery: 'Under levering',
  delivered: 'Leveret',
  cancelled: 'Annulleret',
  needs_manual: 'Kræver manuel behandling',
};

export type Actor = 'system' | 'ai' | 'staff' | 'driver' | 'customer';

export const AI_MODES = ['ai_active', 'manual', 'ai_paused', 'integration_error'] as const;
export type AiMode = (typeof AI_MODES)[number];
export const AI_MODE_LABELS: Record<AiMode, string> = {
  ai_active: 'AI aktiv',
  manual: 'Manuel overtagelse',
  ai_paused: 'AI pauseret',
  integration_error: 'Integrationsfejl',
};

export type InstallationMode = 'demo' | 'production';

export type MessageDirection = 'in' | 'out';
export type MessageAuthor = 'customer' | 'ai' | 'staff' | 'system';
/**
 * Status for udgående beskeder (outbox):
 * - queued: klar til afsendelse
 * - sending: overdraget til adapteren – udfald endnu ukendt
 * - sent: adapteren bekræftede afsendelse
 * - confirmed: genfundet i beskeddatabasen (fx chat.db) efter afsendelse
 * - uncertain: udfald ukendt – må ALDRIG gensendes automatisk
 * - failed: endeligt fejlet (sikkert ikke afsendt)
 * - blocked: ikke sendt pga. overtagelse/pause/fejltilstand
 * Indgående beskeder har status 'received'.
 */
export type MessageStatus =
  | 'received'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'confirmed'
  | 'uncertain'
  | 'failed'
  | 'blocked';

export interface Product {
  id: number;
  sku: string;
  name: string;
  category: string;
  variant: string | null;
  priceOre: number;
  /** Vareomkostning i øre (til dækningsbidrag). null = ukendt. */
  costOre: number | null;
  active: boolean;
  description: string | null;
  synonyms: string[];
}

export interface StockLocation {
  id: number;
  name: string;
  type: 'central' | 'vehicle';
  driverId: number | null;
  active: boolean;
}

export interface StockLevel {
  locationId: number;
  productId: number;
  quantity: number;
  reserved: number;
}

export interface StockMovement {
  id: number;
  locationId: number;
  locationName: string;
  productId: number;
  productName: string;
  deltaQuantity: number;
  deltaReserved: number;
  reason: string;
  orderId: number | null;
  note: string | null;
  createdAt: string;
}

export interface Customer {
  id: number;
  phone: string;
  name: string | null;
  defaultAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface Conversation {
  id: number;
  customerId: number;
  customerPhone: string;
  customerName: string | null;
  channel: 'sms';
  externalChatId: string | null;
  aiMode: AiMode;
  modeReason: string | null;
  modeChangedAt: string | null;
  modeChangedBy: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  activeOrderId: number | null;
  activeOrderStatus: OrderStatus | null;
}

export interface Message {
  id: number;
  conversationId: number;
  direction: MessageDirection;
  author: MessageAuthor;
  body: string;
  status: MessageStatus;
  externalGuid: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  orderId: number | null;
  simulated: boolean;
}

export interface OrderLine {
  id: number;
  productId: number;
  productName: string;
  sku: string;
  quantity: number;
  unitPriceOre: number;
  lineTotalOre: number;
}

export interface Order {
  id: number;
  customerId: number;
  customerPhone: string;
  customerName: string | null;
  conversationId: number | null;
  status: OrderStatus;
  addressText: string | null;
  addressLat: number | null;
  addressLng: number | null;
  addressValidated: boolean;
  deliveryInstructions: string | null;
  requestedTime: string | null;
  eta: string | null;
  etaSource: string | null;
  etaLow: string | null;
  etaHigh: string | null;
  etaConfidence: EtaConfidence | null;
  driverId: number | null;
  driverName: string | null;
  stockLocationId: number | null;
  subtotalOre: number;
  deliveryFeeOre: number;
  totalOre: number;
  paymentStatus: 'not_applicable' | 'pending' | 'paid';
  paymentMethod: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  priority: number;
  pausedFromStatus: OrderStatus | null;
  version: number;
  lines: OrderLine[];
}

export interface OrderEvent {
  id: number;
  orderId: number;
  type: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actor: Actor;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export type DriverStatus = 'offline' | 'available' | 'busy' | 'break';
export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  offline: 'Offline',
  available: 'Ledig',
  busy: 'Optaget',
  break: 'Pause',
};

export interface Driver {
  id: number;
  name: string;
  phone: string | null;
  telegramUserId: string | null;
  telegramChatId: string | null;
  telegramLinkCode: string | null;
  status: DriverStatus;
  vehicleName: string | null;
  vehicleLocationId: number | null;
  maxActiveOrders: number;
  /** Senest kendte stop (leveret adresse/centrallager/startsted) – IKKE live-GPS. */
  lastLat: number | null;
  lastLng: number | null;
  lastPositionAt: string | null;
  lastPositionSource: string | null;
  lastStatusText: string | null;
  lastStatusAt: string | null;
  currentOrderId: number | null;
  extraCapacityUntil: string | null;
  routeVersion: number;
  active: boolean;
  activeOrderCount: number;
  pendingOfferCount: number;
}

export type EtaConfidence = 'high' | 'medium' | 'low';

export interface DriverMessage {
  id: number;
  driverId: number;
  direction: MessageDirection;
  body: string;
  orderId: number | null;
  createdAt: string;
  simulated: boolean;
}

export interface DispatchOffer {
  id: number;
  orderId: number;
  driverId: number;
  driverName: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  kind: 'new_order' | 'reassignment' | 'route_change';
  plan: RoutePlanSummary | null;
  sentAt: string;
  respondedAt: string | null;
  expiresAt: string;
  score: number | null;
}

export interface RouteStop {
  driverId: number;
  orderId: number;
  sequence: number;
  eta: string | null;
  etaLow: string | null;
  etaHigh: string | null;
  etaBasis: string | null;
  confidence: EtaConfidence | null;
  durationFromPrevS: number | null;
  distanceFromPrevM: number | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  status: OrderStatus;
}

export interface ReassignmentSuggestion {
  id: number;
  orderId: number;
  fromDriverId: number | null;
  toDriverId: number;
  toDriverName: string;
  reason: string;
  etaGainMinutes: number | null;
  analysis: DecisionAnalysis | null;
  status: 'open' | 'applied' | 'dismissed';
  createdAt: string;
}

/** Økonomisk begrundelse for en tildeling/ruteændring (alle beløb i øre). */
export interface DecisionAnalysis {
  score: number;
  revenueOre: number;
  contributionOre: number;
  contributionEstimated: boolean;
  extraDriveMinutes: number;
  newOrderEtaMinutes: number;
  routeRevenueOre: number;
  routeContributionOre: number;
  routeDriveMinutes: number;
  deliveriesPerHour: number;
  maxExistingDelayMinutes: number;
  lateRiskMinutes: number;
  reassignmentCostOre: number;
  nearby: boolean;
  significantChange: boolean;
  explanation: string[];
}

export interface RoutePlanSummary {
  sequence: number[];
  insertIndex: number;
  newOrderId: number;
  etas: Record<string, string>;
  analysis: DecisionAnalysis;
  alternatives: { driverId: number; driverName: string; score: number; feasible: boolean; reason: string }[];
}

export type ManagementRole = 'admin' | 'manager' | 'observer';
export const MANAGEMENT_ROLE_LABELS: Record<ManagementRole, string> = { admin: 'Administrator', manager: 'Leder', observer: 'Observatør' };

export interface ManagementUser {
  id: number;
  name: string;
  role: ManagementRole;
  telegramUserId: string | null;
  linkCode: string | null;
  active: boolean;
  createdAt: string;
}

export interface ManagementCommand {
  id: number;
  userName: string | null;
  instruction: string;
  intent: string | null;
  params: Record<string, unknown> | null;
  affectedOrders: number[];
  decision: string;
  result: string | null;
  confirmedBy: string | null;
  createdAt: string;
}

export const REPLENISHMENT_STATUSES = [
  'proposed',
  'awaiting_management',
  'approved',
  'awaiting_driver',
  'en_route',
  'awaiting_pickup',
  'picked_up',
  'completed',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type ReplenishmentStatus = (typeof REPLENISHMENT_STATUSES)[number];
export const REPLENISHMENT_STATUS_LABELS: Record<ReplenishmentStatus, string> = {
  proposed: 'Opfyldning foreslået',
  awaiting_management: 'Afventer ledelsesgodkendelse',
  approved: 'Godkendt',
  awaiting_driver: 'Afventer chaufføraccept',
  en_route: 'På vej til lager',
  awaiting_pickup: 'Afventer fysisk afhentning',
  picked_up: 'Afhentning bekræftet',
  completed: 'Afsluttet',
  rejected: 'Afvist',
  cancelled: 'Annulleret',
  expired: 'Udløbet',
};

export interface ReplenishmentOption {
  locationId: number;
  locationName: string;
  afterOrderId: number | null;
  afterIndex: number;
  feasible: boolean;
  violations: string[];
  extraDriveMinutes: number;
  pickupMinutes: number;
  maxDelayMinutes: number;
  delays: { orderId: number; minutes: number }[];
  costOre: number;
  lateRiskMinutes: number;
  deliveriesPerHour: number;
  safeUntil: string | null;
  explanation: string[];
}

export interface Replenishment {
  id: number;
  driverId: number;
  driverName: string;
  locationId: number;
  locationName: string;
  status: ReplenishmentStatus;
  afterOrderId: number | null;
  items: { productId: number; productName: string; quantity: number }[];
  coversOrders: number[];
  analysis: { chosen: ReplenishmentOption; alternatives: ReplenishmentOption[]; reasoning: string[]; rejectedOptions?: string[] } | null;
  deadlineAt: string | null;
  sentAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedReason: string | null;
  driverAcceptedAt: string | null;
  pickedUpAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface StockForecast {
  driverId: number;
  driverName: string;
  vehicleLocationId: number | null;
  /** Fysisk lager i bilen nu (minus varer reserveret til ordrer uden for ruten). */
  start: Record<number, number>;
  stops: { orderId: number; sequence: number; eta: string | null; needs: Record<number, number>; after: Record<number, number>; pickupBefore: boolean; uncovered: boolean }[];
  shortages: { productId: number; productName: string; missing: number; firstStopOrderId: number; firstStopIndex: number }[];
  activeReplenishmentId: number | null;
}

export type EventLevel = 'info' | 'warn' | 'error' | 'critical';
export interface SystemEvent {
  id: number;
  level: EventLevel;
  source: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
  acknowledgedAt: string | null;
  requiresAction: boolean;
}

export type IntegrationName = 'sms' | 'telegram' | 'maps' | 'ai';
export type IntegrationState =
  | 'not_configured'
  | 'ok'
  | 'degraded'
  | 'error'
  | 'simulated'
  | 'disabled';
export interface IntegrationStatus {
  name: IntegrationName;
  state: IntegrationState;
  message: string | null;
  updatedAt: string;
  lastOkAt: string | null;
  /** Om integrationen er en simulation (demo) – må aldrig præsenteres som produktion. */
  simulated: boolean;
  /** Om integrationen er verificeret på rigtig hardware/konto. */
  productionVerified: boolean;
}

export interface AiCall {
  id: number;
  agent: string;
  taskType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  error: string | null;
  simulated: boolean;
  createdAt: string;
}

export interface AiUsageSummary {
  monthCostUsd: number;
  monthCalls: number;
  monthInputTokens: number;
  monthOutputTokens: number;
  todayCostUsd: number;
  todayCalls: number;
  budgetUsd: number;
  budgetUsedPct: number;
  budgetBlocked: boolean;
  byModel: { model: string; calls: number; costUsd: number; inputTokens: number; outputTokens: number }[];
  byAgent: { agent: string; calls: number; costUsd: number }[];
}

export interface ModelPricing {
  id: string;
  label: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd: number;
  cacheWritePerMTokUsd: number;
}

export type AiTaskType = 'customer_interpret' | 'customer_escalation' | 'driver_interpret' | 'management_interpret';

export interface OpeningHoursDay {
  open: string; // "HH:MM"
  close: string; // "HH:MM"; close < open betyder over midnat
  closed: boolean;
}

export interface Settings {
  company: {
    name: string;
    phone: string;
    email: string;
    address: string;
    cvr: string;
  };
  installation: {
    mode: InstallationMode;
    setupCompleted: boolean;
    /** Hovedafbryder for al automatik (kundesvar, dispatch, notifikationer). */
    automationEnabled: boolean;
  };
  automation: {
    customerReplies: boolean;
    autoDispatch: boolean;
    customerEtaUpdates: boolean;
  };
  pricing: {
    deliveryFeeOre: number;
    freeDeliveryThresholdOre: number;
    minimumOrderOre: number;
    currency: 'DKK';
  };
  delivery: {
    centerLat: number;
    centerLng: number;
    radiusKm: number;
    postalCodes: string[];
    defaultPrepMinutes: number;
    quoteExpiryMinutes: number;
    offerTimeoutSeconds: number;
    requireDriverAcceptance: boolean;
    allowCentralPickup: boolean;
  };
  logistics: {
    /** Minutter uden status fra chaufføren, før ETA'er betragtes som usikre. */
    statusStaleMinutes: number;
    /** Bed chaufføren om status efter så mange minutter uden opdatering. */
    statusRequestAfterMinutes: number;
    /** Eskalér til medarbejder, hvis chaufføren stadig ikke har svaret. */
    escalateNoStatusMinutes: number;
    serviceMinutesPerStop: number;
    /** Maks. historisk tillæg pr. stop (minutter) beregnet ud fra tidligere forsinkelser. */
    historicalBufferMaxMinutes: number;
    /** Hvor længe "jeg kan tage en ekstra ordre" gælder. */
    extraCapacityMinutes: number;
  };
  notifications: {
    lateThresholdMinutes: number;
    earlyThresholdMinutes: number;
    minMinutesBetweenUpdates: number;
    maxUpdatesPerOrder: number;
    arrivalSoonMaxMinutes: number;
    arrivalSoonTemplate: string;
    delayTemplate: string;
    delayNoTimeTemplate: string;
  };
  management: {
    /** Telegram-chat-ID for ledelsesgruppen. Kun beskeder fra denne chat (eller private chats, hvis tilladt) behandles. */
    groupChatId: string;
    allowPrivateChats: boolean;
    confirmTimeoutMinutes: number;
  };
  replenishment: {
    enabled: boolean;
    pickupMinutes: number;
    reminderAfterMinutes: number;
    /** Eskalér så mange minutter før sidste sikre opfyldningspunkt. */
    escalateLeadMinutes: number;
    /** Mindste forbedring (øre) før et ruteforslag sendes til chaufføren. */
    minRouteImprovementOre: number;
  };
  economics: {
    /** Vægt for ordrer, ledelsen har prioriteret. */
    priorityWeight: number;
    /** Avance (%) for varer uden registreret vareomkostning. */
    defaultMarginPct: number;
    driveCostPerMinuteOre: number;
    waitCostPerMinuteOre: number;
    /** Værdivægt: ordrens vægt = 1 + dækningsbidrag / denne skala. */
    valueWeightScaleOre: number;
    latePenaltyPerMinuteOre: number;
    riskPenaltyPerMinuteOre: number;
    /** Ekstra omkostning pr. eksisterende kunde, hvis levering rykkes (forstyrrelse). */
    disruptionCostOre: number;
    reassignmentCostOre: number;
    nearbyThresholdMinutes: number;
    nearbyBonusOre: number;
    /** HÅRD grænse: et givet leveringsløfte må højst overskrides så meget. */
    promiseToleranceMinutes: number;
    /** HÅRD grænse: maks. leveringstid for en ny ordre. */
    maxDeliveryMinutes: number;
    /** Ændringer i en accepteret rute over dette kræver chaufførens accept. */
    significantChangeMinutes: number;
    /** Mindste gevinst for at foreslå omfordeling. */
    minReassignmentGainOre: number;
  };
  openingHours: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', OpeningHoursDay>;
  messages: {
    greeting: string;
    closed: string;
    outsideArea: string;
    handoffToHuman: string;
    orderConfirmed: string;
    delivered: string;
  };
  ai: {
    enabled: boolean;
    monthlyBudgetUsd: number;
    warnAtPct: number;
    routing: Record<AiTaskType, string>;
    fallbackModels: string[];
    models: ModelPricing[];
    maxContextMessages: number;
    escalateBelowConfidence: number;
  };
  sms: {
    backend: 'imsg' | 'none';
    imsgPath: string;
    region: string;
    service: 'sms' | 'auto';
    /** Pausér AI, hvis der observeres en udgående besked, systemet ikke selv har sendt. */
    pauseOnUnknownOutgoing: boolean;
  };
  telegram: {
    botUsername: string;
    driverGroupChatId: string;
  };
  maps: {
    region: string;
    language: string;
    cacheTtlHours: number;
  };
  retention: {
    messageBodyDays: number;
    inactiveCustomerDays: number;
    eventLogDays: number;
  };
  backup: {
    enabled: boolean;
    intervalHours: number;
    keep: number;
  };
  demo: {
    autoTraffic: boolean;
    trafficIntervalSeconds: number;
    speedFactor: number;
  };
}

export interface DashboardStats {
  activeOrders: number;
  ordersToday: number;
  deliveredToday: number;
  pendingOrders: number;
  delayedOrders: number;
  needsManual: number;
  activeDrivers: number;
  onlineDrivers: number;
  revenueTodayOre: number;
  openAlerts: number;
  conversationsNeedingAttention: number;
  aiCostTodayUsd: number;
  aiCostMonthUsd: number;
  aiBudgetUsedPct: number;
  integrations: IntegrationStatus[];
  mode: InstallationMode;
  automationEnabled: boolean;
}

export interface BackupInfo {
  file: string;
  sizeBytes: number;
  createdAt: string;
}

/** Hændelser der pushes til UI'et, så skærmene kan opdatere live. */
export type LiveTopic =
  | 'orders'
  | 'conversations'
  | 'messages'
  | 'drivers'
  | 'inventory'
  | 'products'
  | 'events'
  | 'integrations'
  | 'ai'
  | 'settings'
  | 'logistics'
  | 'demo'
  | 'management'
  | 'replenishment';
