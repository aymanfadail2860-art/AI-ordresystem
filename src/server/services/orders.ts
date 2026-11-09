import type { Db } from '../db/database';
import { nowIso, parseJson } from '../db/database';
import type { AuditLog, Bus } from '../infra';
import type { Actor, Order, OrderEvent, OrderLine, OrderStatus } from '../../shared/types';
import { assertTransition, ACTIVE_STATUSES, RESERVED_STATUSES } from '../../core/orderStateMachine';
import { calculatePrice, type PricingRules } from '../../core/pricing';
import type { InventoryService } from './inventory';
import type { CatalogService } from './catalog';

export class ConcurrentModificationError extends Error {
  constructor(orderId: number) {
    super(`Ordre ${orderId} blev ændret samtidig – prøv igen`);
    this.name = 'ConcurrentModificationError';
  }
}

export interface LineInput {
  productId: number;
  quantity: number;
}

export interface OrderListFilter {
  status?: OrderStatus[];
  activeOnly?: boolean;
  today?: boolean;
  driverId?: number;
  limit?: number;
}

const ORDER_SELECT = `
SELECT o.*, cu.phone AS customer_phone, cu.name AS customer_name, d.name AS driver_name
FROM orders o JOIN customers cu ON cu.id = o.customer_id LEFT JOIN drivers d ON d.id = o.driver_id`;

export class OrderService {
  constructor(
    private db: Db,
    private bus: Bus,
    private inventory: InventoryService,
    private catalog: CatalogService,
    private audit: AuditLog,
  ) {}

  get(id: number): Order | null {
    const r = this.db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { ...mapOrder(r), lines: this.lines(id) };
  }

  lines(orderId: number): OrderLine[] {
    return (this.db.prepare(`SELECT * FROM order_lines WHERE order_id = ? ORDER BY id`).all(orderId) as Record<string, unknown>[]).map(
      (r) => ({
        id: r.id as number,
        productId: r.product_id as number,
        productName: r.product_name as string,
        sku: r.sku as string,
        quantity: r.quantity as number,
        unitPriceOre: r.unit_price_ore as number,
        lineTotalOre: r.line_total_ore as number,
      }),
    );
  }

  list(f: OrderListFilter = {}): Order[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.status?.length) {
      where.push(`o.status IN (${f.status.map(() => '?').join(',')})`);
      args.push(...f.status);
    }
    if (f.activeOnly) where.push(`o.status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(',')})`);
    if (f.today) {
      where.push(`o.created_at >= ?`);
      args.push(startOfToday());
    }
    if (f.driverId) {
      where.push(`o.driver_id = ?`);
      args.push(f.driverId);
    }
    const rows = this.db
      .prepare(`${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT ?`)
      .all(...args, f.limit ?? 300) as Record<string, unknown>[];
    const orders = rows.map(mapOrder);
    if (orders.length === 0) return [];
    const lineRows = this.db
      .prepare(`SELECT * FROM order_lines WHERE order_id IN (${orders.map(() => '?').join(',')}) ORDER BY id`)
      .all(...orders.map((o) => o.id)) as Record<string, unknown>[];
    const byOrder = new Map<number, OrderLine[]>();
    for (const r of lineRows) {
      const list = byOrder.get(r.order_id as number) ?? [];
      list.push({
        id: r.id as number,
        productId: r.product_id as number,
        productName: r.product_name as string,
        sku: r.sku as string,
        quantity: r.quantity as number,
        unitPriceOre: r.unit_price_ore as number,
        lineTotalOre: r.line_total_ore as number,
      });
      byOrder.set(r.order_id as number, list);
    }
    return orders.map((o) => ({ ...o, lines: byOrder.get(o.id) ?? [] }));
  }

  events(orderId: number): OrderEvent[] {
    return (this.db.prepare(`SELECT * FROM order_events WHERE order_id = ? ORDER BY id`).all(orderId) as Record<string, unknown>[]).map(
      (r) => ({
        id: r.id as number,
        orderId: r.order_id as number,
        type: r.type as string,
        fromStatus: (r.from_status as OrderStatus) ?? null,
        toStatus: (r.to_status as OrderStatus) ?? null,
        actor: r.actor as Actor,
        data: parseJson(r.data as string | null, null),
        createdAt: r.created_at as string,
      }),
    );
  }

  addEvent(orderId: number, type: string, actor: Actor, data?: Record<string, unknown>, from?: OrderStatus | null, to?: OrderStatus | null): void {
    this.db
      .prepare(`INSERT INTO order_events (order_id, type, from_status, to_status, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(orderId, type, from ?? null, to ?? null, actor, data ? JSON.stringify(data) : null, nowIso());
    this.bus.touch('orders');
  }

  /**
   * Opret en ordrekladde. `idempotencyKey` forhindrer dobbeltoprettelse ved
   * gentagne beskeder eller tekniske retries.
   */
  createDraft(input: { customerId: number; conversationId: number | null; idempotencyKey: string; actor: Actor }): { id: number; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT id FROM orders WHERE idempotency_key = ?`).get(input.idempotencyKey) as { id: number } | undefined;
      if (existing) return { id: existing.id, created: false };
      const r = this.db
        .prepare(`INSERT INTO orders (customer_id, conversation_id, status, idempotency_key, created_at, updated_at) VALUES (?, ?, 'new_inquiry', ?, ?, ?)`)
        .run(input.customerId, input.conversationId, input.idempotencyKey, nowIso(), nowIso());
      const id = Number(r.lastInsertRowid);
      this.addEvent(id, 'created', input.actor, undefined, null, 'new_inquiry');
      return { id, created: true };
    })();
  }

  /** Udfør et statusskift valideret af tilstandsmaskinen, med optimistisk låsning. */
  transition(orderId: number, to: OrderStatus, actor: Actor, data?: Record<string, unknown>, expectedVersion?: number): Order {
    this.db.transaction(() => {
      const cur = this.db.prepare(`SELECT status, version FROM orders WHERE id = ?`).get(orderId) as
        | { status: OrderStatus; version: number }
        | undefined;
      if (!cur) throw new Error(`Ordre ${orderId} findes ikke`);
      if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new ConcurrentModificationError(orderId);
      assertTransition(cur.status, to, actor);
      const extra: string[] = [];
      if (to === 'confirmed') extra.push(`confirmed_at = '${nowIso()}'`);
      if (to === 'delivered') extra.push(`delivered_at = '${nowIso()}'`, `needs_attention = 0`, `attention_reason = NULL`);
      if (to === 'cancelled') extra.push(`cancelled_at = '${nowIso()}'`, `needs_attention = 0`);
      if (to === 'awaiting_driver') extra.push(`driver_id = NULL`, `eta = NULL`, `eta_source = NULL`);
      const r = this.db
        .prepare(
          `UPDATE orders SET status = ?, version = version + 1, updated_at = ? ${extra.length ? ', ' + extra.join(', ') : ''}
           WHERE id = ? AND version = ?`,
        )
        .run(to, nowIso(), orderId, cur.version);
      if (r.changes === 0) throw new ConcurrentModificationError(orderId);
      // Lagerkonsekvenser af statusskiftet
      if (to === 'cancelled') this.inventory.releaseForOrder(orderId, 'annulleret');
      if (to === 'delivered') this.inventory.deductForOrder(orderId);
      if (to === 'awaiting_driver') this.db.prepare(`DELETE FROM route_stops WHERE order_id = ?`).run(orderId);
      if (to === 'cancelled' || to === 'delivered') {
        this.db.prepare(`DELETE FROM route_stops WHERE order_id = ?`).run(orderId);
        this.db.prepare(`UPDATE dispatch_offers SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).run(orderId);
      }
      this.addEvent(orderId, 'status', actor, data, cur.status, to);
    })();
    this.bus.touch('orders', 'logistics');
    this.bus.emit('order_status', { orderId, to, actor });
    return this.get(orderId)!;
  }

  /** Erstat ordrelinjer i en kladde og genberegn pris. Priser hentes fra kataloget. */
  setLines(orderId: number, lines: LineInput[], rules: PricingRules, actor: Actor): void {
    this.db.transaction(() => {
      const o = this.db.prepare(`SELECT status, stock_state FROM orders WHERE id = ?`).get(orderId) as
        | { status: OrderStatus; stock_state: string }
        | undefined;
      if (!o) throw new Error('Ordre findes ikke');
      if (RESERVED_STATUSES.includes(o.status) && o.status !== 'awaiting_confirmation') {
        throw new Error('Ordren er bekræftet – linjer kan kun ændres af en medarbejder via "Ret ordre"');
      }
      if (o.stock_state === 'reserved') this.inventory.releaseForOrder(orderId, 'ordreændring');
      this.writeLines(orderId, lines, rules, actor);
    })();
    this.bus.touch('orders');
  }

  /** Medarbejder-redigering af en bekræftet ordre: frigiv, ret, reservér igen – atomisk. */
  staffEditLines(orderId: number, lines: LineInput[], rules: PricingRules): void {
    this.db.transaction(() => {
      const o = this.db.prepare(`SELECT status, stock_state, stock_location_id FROM orders WHERE id = ?`).get(orderId) as
        | { status: OrderStatus; stock_state: string; stock_location_id: number | null }
        | undefined;
      if (!o) throw new Error('Ordre findes ikke');
      if (o.status === 'delivered' || o.status === 'cancelled') throw new Error('Afsluttede ordrer kan ikke ændres');
      const wasReserved = o.stock_state === 'reserved';
      if (wasReserved) this.inventory.releaseForOrder(orderId, 'medarbejderændring');
      this.writeLines(orderId, lines, rules, 'staff');
      // Kaster InsufficientStockError → hele transaktionen rulles tilbage
      if (wasReserved && o.stock_location_id != null) this.inventory.reserveForOrder(orderId, o.stock_location_id);
    })();
    this.audit.record('staff', 'order_edit_lines', 'order', orderId, { lines });
    this.bus.touch('orders', 'inventory');
  }

  private writeLines(orderId: number, lines: LineInput[], rules: PricingRules, actor: Actor): void {
    const merged = new Map<number, number>();
    for (const l of lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.quantity);
    const priced = calculatePrice(
      [...merged.entries()].map(([productId, quantity]) => {
        const p = this.catalog.get(productId);
        if (!p || !p.active) throw new Error(`Produkt ${productId} findes ikke eller er deaktiveret`);
        return { productId, quantity, unitPriceOre: p.priceOre };
      }),
      rules,
    );
    this.db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).run(orderId);
    const ins = this.db.prepare(
      `INSERT INTO order_lines (order_id, product_id, product_name, sku, quantity, unit_price_ore, line_total_ore) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of priced.lines) {
      const p = this.catalog.get(l.productId)!;
      ins.run(orderId, l.productId, p.name, p.sku, l.quantity, l.unitPriceOre, l.lineTotalOre);
    }
    this.db
      .prepare(`UPDATE orders SET subtotal_ore = ?, delivery_fee_ore = ?, total_ore = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(priced.subtotalOre, priced.deliveryFeeOre, priced.totalOre, nowIso(), orderId);
    this.addEvent(orderId, 'lines_updated', actor, {
      lines: priced.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      totalOre: priced.totalOre,
    });
  }

  updateFields(
    orderId: number,
    patch: Partial<{
      addressText: string | null;
      addressLat: number | null;
      addressLng: number | null;
      addressValidated: boolean;
      deliveryInstructions: string | null;
      requestedTime: string | null;
      eta: string | null;
      etaSource: string | null;
      etaCommunicated: string | null;
      driverId: number | null;
      paymentStatus: string;
      needsAttention: boolean;
      attentionReason: string | null;
    }>,
    actor: Actor,
  ): void {
    const map: Record<string, string> = {
      addressText: 'address_text',
      addressLat: 'address_lat',
      addressLng: 'address_lng',
      addressValidated: 'address_validated',
      deliveryInstructions: 'delivery_instructions',
      requestedTime: 'requested_time',
      eta: 'eta',
      etaSource: 'eta_source',
      etaCommunicated: 'eta_communicated',
      driverId: 'driver_id',
      paymentStatus: 'payment_status',
      needsAttention: 'needs_attention',
      attentionReason: 'attention_reason',
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]} = ?`);
      args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE orders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowIso(), orderId);
    const quiet = Object.keys(patch).every((k) => ['eta', 'etaSource', 'etaCommunicated'].includes(k));
    if (!quiet) this.addEvent(orderId, 'updated', actor, patch as Record<string, unknown>);
    this.bus.touch('orders');
  }

  flag(orderId: number, reason: string, actor: Actor = 'system'): void {
    this.updateFields(orderId, { needsAttention: true, attentionReason: reason }, actor);
  }

  cancel(orderId: number, reason: string, actor: Actor): Order {
    this.db.prepare(`UPDATE orders SET cancel_reason = ? WHERE id = ?`).run(reason, orderId);
    const o = this.transition(orderId, 'cancelled', actor, { reason });
    this.audit.record(actor, 'order_cancel', 'order', orderId, { reason });
    return o;
  }

  activeCountForDriver(driverId: number): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM orders WHERE driver_id = ? AND status IN ('driver_assigned','out_for_delivery')`)
        .get(driverId) as { c: number }
    ).c;
  }
}

export function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function mapOrder(r: Record<string, unknown>): Order {
  return {
    id: r.id as number,
    customerId: r.customer_id as number,
    customerPhone: r.customer_phone as string,
    customerName: (r.customer_name as string) ?? null,
    conversationId: (r.conversation_id as number) ?? null,
    status: r.status as OrderStatus,
    addressText: (r.address_text as string) ?? null,
    addressLat: (r.address_lat as number) ?? null,
    addressLng: (r.address_lng as number) ?? null,
    addressValidated: !!r.address_validated,
    deliveryInstructions: (r.delivery_instructions as string) ?? null,
    requestedTime: (r.requested_time as string) ?? null,
    eta: (r.eta as string) ?? null,
    etaSource: (r.eta_source as string) ?? null,
    driverId: (r.driver_id as number) ?? null,
    driverName: (r.driver_name as string) ?? null,
    stockLocationId: (r.stock_location_id as number) ?? null,
    subtotalOre: r.subtotal_ore as number,
    deliveryFeeOre: r.delivery_fee_ore as number,
    totalOre: r.total_ore as number,
    paymentStatus: r.payment_status as Order['paymentStatus'],
    paymentMethod: (r.payment_method as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    confirmedAt: (r.confirmed_at as string) ?? null,
    deliveredAt: (r.delivered_at as string) ?? null,
    cancelledAt: (r.cancelled_at as string) ?? null,
    cancelReason: (r.cancel_reason as string) ?? null,
    needsAttention: !!r.needs_attention,
    attentionReason: (r.attention_reason as string) ?? null,
    version: r.version as number,
    lines: [],
  };
}
