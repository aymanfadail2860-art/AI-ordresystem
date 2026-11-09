import type { Actor, OrderStatus } from '../shared/types';

/**
 * Ordretilstandsmaskine. Alle statusskift i systemet SKAL gå gennem
 * `assertTransition`, så ugyldige skift afvises uanset om de kommer fra
 * AI, chauffør, medarbejder eller system.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new_inquiry: ['awaiting_customer_info', 'awaiting_stock_check', 'cancelled', 'needs_manual'],
  awaiting_customer_info: ['awaiting_stock_check', 'cancelled', 'needs_manual'],
  awaiting_stock_check: ['awaiting_confirmation', 'awaiting_customer_info', 'cancelled', 'needs_manual'],
  awaiting_confirmation: ['confirmed', 'awaiting_customer_info', 'awaiting_stock_check', 'cancelled', 'needs_manual'],
  confirmed: ['awaiting_driver', 'cancelled', 'needs_manual'],
  awaiting_driver: ['driver_assigned', 'cancelled', 'needs_manual'],
  driver_assigned: ['out_for_delivery', 'awaiting_driver', 'cancelled', 'needs_manual'],
  out_for_delivery: ['delivered', 'awaiting_driver', 'cancelled', 'needs_manual'],
  delivered: [],
  cancelled: [],
  needs_manual: [
    'awaiting_customer_info',
    'awaiting_stock_check',
    'awaiting_confirmation',
    'confirmed',
    'awaiting_driver',
    'driver_assigned',
    'out_for_delivery',
    'delivered',
    'cancelled',
  ],
};

/** Statusskift, som kun bestemte aktører må foretage. */
const ACTOR_RESTRICTIONS: Partial<Record<OrderStatus, Actor[]>> = {
  // En levering må kun markeres afsluttet af chaufføren (valideret) eller en medarbejder.
  delivered: ['driver', 'staff'],
};

/** Skift ud af "Kræver manuel behandling" kræver en medarbejder. */
const STAFF_ONLY_FROM: OrderStatus[] = ['needs_manual'];

export const TERMINAL_STATUSES: OrderStatus[] = ['delivered', 'cancelled'];
export const ACTIVE_STATUSES: OrderStatus[] = [
  'new_inquiry',
  'awaiting_customer_info',
  'awaiting_stock_check',
  'awaiting_confirmation',
  'confirmed',
  'awaiting_driver',
  'driver_assigned',
  'out_for_delivery',
  'needs_manual',
];
/** Statusser hvor lageret er reserveret til ordren. */
export const RESERVED_STATUSES: OrderStatus[] = [
  'awaiting_confirmation',
  'confirmed',
  'awaiting_driver',
  'driver_assigned',
  'out_for_delivery',
];
/** Statusser hvor ordren stadig er et udkast i kundedialogen. */
export const DRAFT_STATUSES: OrderStatus[] = [
  'new_inquiry',
  'awaiting_customer_info',
  'awaiting_stock_check',
  'awaiting_confirmation',
];

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
    public readonly actor: Actor,
    reason: string,
  ) {
    super(`Ugyldigt statusskift ${from} → ${to} (${actor}): ${reason}`);
    this.name = 'InvalidTransitionError';
  }
}

export function allowedTransitions(from: OrderStatus): OrderStatus[] {
  return [...TRANSITIONS[from]];
}

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  try {
    assertTransition(from, to, actor);
    return true;
  } catch {
    return false;
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus, actor: Actor): void {
  if (from === to) throw new InvalidTransitionError(from, to, actor, 'samme status');
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to, actor, 'ikke tilladt af tilstandsmaskinen');
  }
  const restricted = ACTOR_RESTRICTIONS[to];
  if (restricted && !restricted.includes(actor)) {
    throw new InvalidTransitionError(from, to, actor, `kun ${restricted.join('/')} må sætte denne status`);
  }
  if (STAFF_ONLY_FROM.includes(from) && actor !== 'staff') {
    throw new InvalidTransitionError(from, to, actor, 'kræver medarbejder');
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
