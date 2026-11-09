import type { Db } from '../db/database';
import { nowIso } from '../db/database';
import type { Bus } from '../infra';
import type { StockLevel, StockLocation, StockMovement } from '../../shared/types';

export interface Need {
  productId: number;
  quantity: number;
}

export class InsufficientStockError extends Error {
  constructor(
    public readonly shortages: { productId: number; needed: number; available: number }[],
  ) {
    super('Utilstrækkeligt lager');
    this.name = 'InsufficientStockError';
  }
}

/**
 * Lagerstyring med reservationer.
 * Invarianter (håndhæves også af CHECK-constraints i databasen):
 *   0 ≤ reserved ≤ quantity
 * Ordrens `stock_state` sikrer at reservation/frigivelse/fradrag kun sker én gang.
 * Alle metoder, der ændrer lager, skal kaldes inden for en transaktion
 * (de åbner selv en, og better-sqlite3 tillader indlejring via savepoints).
 */
export class InventoryService {
  constructor(
    private db: Db,
    private bus: Bus,
  ) {}

  locations(includeInactive = false): StockLocation[] {
    return (
      this.db
        .prepare(`SELECT * FROM stock_locations ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY type, name`)
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      name: r.name as string,
      type: r.type as 'central' | 'vehicle',
      driverId: (r.driver_id as number) ?? null,
      active: !!r.active,
    }));
  }

  centralLocation(): { id: number; lat: number | null; lng: number | null } | null {
    return (
      (this.db.prepare(`SELECT id, lat, lng FROM stock_locations WHERE type = 'central' AND active = 1 ORDER BY id LIMIT 1`).get() as
        | { id: number; lat: number | null; lng: number | null }
        | undefined) ?? null
    );
  }

  location(id: number): { id: number; name: string; type: 'central' | 'vehicle'; lat: number | null; lng: number | null; driverId: number | null } | null {
    const r = this.db.prepare(`SELECT id, name, type, lat, lng, driver_id FROM stock_locations WHERE id = ?`).get(id) as
      | { id: number; name: string; type: 'central' | 'vehicle'; lat: number | null; lng: number | null; driver_id: number | null }
      | undefined;
    return r ? { id: r.id, name: r.name, type: r.type, lat: r.lat, lng: r.lng, driverId: r.driver_id } : null;
  }

  vehicleLocationForDriver(driverId: number): number | null {
    const r = this.db.prepare(`SELECT id FROM stock_locations WHERE driver_id = ? AND active = 1`).get(driverId) as
      | { id: number }
      | undefined;
    return r?.id ?? null;
  }

  createLocation(name: string, type: 'central' | 'vehicle', driverId: number | null, lat?: number | null, lng?: number | null): number {
    if (!name.trim()) throw new Error('Navn mangler');
    const r = this.db
      .prepare(`INSERT INTO stock_locations (name, type, driver_id, lat, lng) VALUES (?, ?, ?, ?, ?)`)
      .run(name.trim(), type, driverId, lat ?? null, lng ?? null);
    this.bus.touch('inventory');
    return Number(r.lastInsertRowid);
  }

  levels(): StockLevel[] {
    return (this.db.prepare(`SELECT * FROM stock_levels`).all() as Record<string, number>[]).map((r) => ({
      locationId: r.location_id,
      productId: r.product_id,
      quantity: r.quantity,
      reserved: r.reserved,
    }));
  }

  available(locationId: number, productId: number): number {
    const r = this.db
      .prepare(`SELECT quantity - reserved AS a FROM stock_levels WHERE location_id = ? AND product_id = ?`)
      .get(locationId, productId) as { a: number } | undefined;
    return r?.a ?? 0;
  }

  /** Samlet ledigt antal pr. produkt på tværs af aktive lokationer. */
  totalAvailable(): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT sl.product_id AS p, SUM(sl.quantity - sl.reserved) AS a
         FROM stock_levels sl JOIN stock_locations l ON l.id = sl.location_id AND l.active = 1
         GROUP BY sl.product_id`,
      )
      .all() as { p: number; a: number }[];
    return new Map(rows.map((r) => [r.p, r.a]));
  }

  canFulfil(locationId: number, needs: Need[]): boolean {
    return needs.every((n) => this.available(locationId, n.productId) >= n.quantity);
  }

  shortages(locationId: number, needs: Need[]) {
    return needs
      .map((n) => ({ productId: n.productId, needed: n.quantity, available: this.available(locationId, n.productId) }))
      .filter((s) => s.available < s.needed);
  }

  private move(
    locationId: number,
    productId: number,
    dQty: number,
    dRes: number,
    reason: string,
    orderId: number | null,
    note: string | null,
    actor: string,
  ) {
    this.db
      .prepare(`INSERT INTO stock_levels (location_id, product_id, quantity, reserved) VALUES (?, ?, 0, 0) ON CONFLICT DO NOTHING`)
      .run(locationId, productId);
    // CHECK-constraints afviser negative beholdninger og reserved > quantity
    this.db
      .prepare(`UPDATE stock_levels SET quantity = quantity + ?, reserved = reserved + ? WHERE location_id = ? AND product_id = ?`)
      .run(dQty, dRes, locationId, productId);
    this.db
      .prepare(
        `INSERT INTO stock_movements (location_id, product_id, delta_quantity, delta_reserved, reason, order_id, note, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(locationId, productId, dQty, dRes, reason, orderId, note, actor, nowIso());
  }

  private orderNeeds(orderId: number): Need[] {
    return (
      this.db
        .prepare(`SELECT product_id AS productId, SUM(quantity) AS quantity FROM order_lines WHERE order_id = ? GROUP BY product_id`)
        .all(orderId) as Need[]
    ).filter((n) => n.quantity > 0);
  }

  /** Reservér ordrens varer på en lokation. Atomisk: alt eller intet. */
  reserveForOrder(orderId: number, locationId: number): void {
    this.db.transaction(() => {
      const o = this.db.prepare(`SELECT stock_state FROM orders WHERE id = ?`).get(orderId) as { stock_state: string } | undefined;
      if (!o) throw new Error(`Ordre ${orderId} findes ikke`);
      if (o.stock_state === 'reserved') throw new Error(`Ordre ${orderId} har allerede en reservation`);
      if (o.stock_state === 'deducted') throw new Error(`Ordre ${orderId} er allerede fradraget lageret`);
      const needs = this.orderNeeds(orderId);
      if (needs.length === 0) throw new Error('Ordren har ingen varer');
      const short = this.shortages(locationId, needs);
      if (short.length) throw new InsufficientStockError(short);
      for (const n of needs) this.move(locationId, n.productId, 0, n.quantity, 'reserve', orderId, null, 'system');
      this.db.prepare(`UPDATE orders SET stock_state = 'reserved', stock_location_id = ? WHERE id = ?`).run(locationId, orderId);
    })();
    this.bus.touch('inventory');
  }

  /** Frigiv ordrens reservation (ved annullering eller ændring). Idempotent. */
  releaseForOrder(orderId: number, note = 'frigivet'): boolean {
    const changed = this.db.transaction(() => {
      const o = this.db.prepare(`SELECT stock_state, stock_location_id FROM orders WHERE id = ?`).get(orderId) as
        | { stock_state: string; stock_location_id: number | null }
        | undefined;
      if (!o || o.stock_state !== 'reserved' || o.stock_location_id == null) return false;
      for (const n of this.orderNeeds(orderId)) this.move(o.stock_location_id, n.productId, 0, -n.quantity, 'release', orderId, note, 'system');
      this.db.prepare(`UPDATE orders SET stock_state = 'released' WHERE id = ?`).run(orderId);
      return true;
    })();
    if (changed) this.bus.touch('inventory');
    return changed;
  }

  /** Flyt en reservation til en anden lokation (fx anden chaufførs bil). Atomisk. */
  moveReservation(orderId: number, toLocationId: number): void {
    this.db.transaction(() => {
      const o = this.db.prepare(`SELECT stock_state, stock_location_id FROM orders WHERE id = ?`).get(orderId) as
        | { stock_state: string; stock_location_id: number | null }
        | undefined;
      if (!o || o.stock_state !== 'reserved') throw new Error('Ordren har ingen aktiv reservation');
      if (o.stock_location_id === toLocationId) return;
      const needs = this.orderNeeds(orderId);
      const short = this.shortages(toLocationId, needs);
      if (short.length) throw new InsufficientStockError(short);
      for (const n of needs) {
        this.move(o.stock_location_id!, n.productId, 0, -n.quantity, 'release', orderId, 'flyttet', 'system');
        this.move(toLocationId, n.productId, 0, n.quantity, 'reserve', orderId, 'flyttet', 'system');
      }
      this.db.prepare(`UPDATE orders SET stock_location_id = ? WHERE id = ?`).run(toLocationId, orderId);
    })();
    this.bus.touch('inventory');
  }

  /** Træk varerne fra lageret ved levering. Idempotent. */
  deductForOrder(orderId: number): boolean {
    const changed = this.db.transaction(() => {
      const o = this.db.prepare(`SELECT stock_state, stock_location_id FROM orders WHERE id = ?`).get(orderId) as
        | { stock_state: string; stock_location_id: number | null }
        | undefined;
      if (!o || o.stock_state === 'deducted') return false;
      if (o.stock_state !== 'reserved' || o.stock_location_id == null) {
        throw new Error(`Ordre ${orderId} har ingen reservation at fradrage`);
      }
      for (const n of this.orderNeeds(orderId))
        this.move(o.stock_location_id, n.productId, -n.quantity, -n.quantity, 'deduct', orderId, 'leveret', 'system');
      this.db.prepare(`UPDATE orders SET stock_state = 'deducted' WHERE id = ?`).run(orderId);
      return true;
    })();
    if (changed) this.bus.touch('inventory');
    return changed;
  }

  /**
   * Bekræftet fysisk afhentning ved lageropfyldning: varerne til de dækkede
   * ordrer flyttes fra lagerlokationen til bilen (beholdning OG reservation).
   * Bilens beholdning øges først her – aldrig ved godkendelse. Atomisk.
   */
  pickupForOrders(orderIds: number[], fromLocationId: number, vehicleLocationId: number, replenishmentId: number): { productId: number; quantity: number }[] {
    const moved = new Map<number, number>();
    this.db.transaction(() => {
      for (const orderId of orderIds) {
        const o = this.db.prepare(`SELECT stock_state, stock_location_id FROM orders WHERE id = ?`).get(orderId) as
          | { stock_state: string; stock_location_id: number | null }
          | undefined;
        if (!o || o.stock_state !== 'reserved' || o.stock_location_id !== fromLocationId) continue; // allerede flyttet/annulleret
        for (const n of this.orderNeeds(orderId)) {
          this.move(fromLocationId, n.productId, -n.quantity, -n.quantity, 'replenish', orderId, `opfyldning #${replenishmentId} → bil`, 'driver');
          this.move(vehicleLocationId, n.productId, n.quantity, n.quantity, 'replenish', orderId, `opfyldning #${replenishmentId} fra lager`, 'driver');
          moved.set(n.productId, (moved.get(n.productId) ?? 0) + n.quantity);
        }
        this.db.prepare(`UPDATE orders SET stock_location_id = ? WHERE id = ?`).run(vehicleLocationId, orderId);
      }
    })();
    this.bus.touch('inventory');
    return [...moved.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  }

  /** Manuel lagerregulering (optælling, ny levering). */
  adjust(locationId: number, productId: number, delta: number, note: string, actor = 'staff'): void {
    if (!Number.isInteger(delta) || delta === 0) throw new Error('Ugyldig regulering');
    this.db.transaction(() => {
      if (delta < 0) {
        const avail = this.available(locationId, productId);
        if (avail + delta < 0) throw new Error(`Kan ikke fjerne ${-delta} – kun ${avail} ledige (resten er reserveret)`);
      }
      this.move(locationId, productId, delta, 0, delta > 0 ? 'restock' : 'adjust', null, note, actor);
    })();
    this.bus.touch('inventory');
  }

  /** Overførsel mellem lokationer (fx centrallager → bil). */
  transfer(fromId: number, toId: number, productId: number, qty: number, actor = 'staff'): void {
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Ugyldigt antal');
    if (fromId === toId) throw new Error('Samme lokation');
    this.db.transaction(() => {
      if (this.available(fromId, productId) < qty) throw new Error('Ikke nok ledigt lager på afsenderlokationen');
      this.move(fromId, productId, -qty, 0, 'transfer', null, `til lokation ${toId}`, actor);
      this.move(toId, productId, qty, 0, 'transfer', null, `fra lokation ${fromId}`, actor);
    })();
    this.bus.touch('inventory');
  }

  movements(limit = 200): StockMovement[] {
    return (
      this.db
        .prepare(
          `SELECT m.*, l.name AS location_name, p.name AS product_name FROM stock_movements m
           JOIN stock_locations l ON l.id = m.location_id JOIN products p ON p.id = m.product_id
           ORDER BY m.id DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      locationId: r.location_id as number,
      locationName: r.location_name as string,
      productId: r.product_id as number,
      productName: r.product_name as string,
      deltaQuantity: r.delta_quantity as number,
      deltaReserved: r.delta_reserved as number,
      reason: r.reason as string,
      orderId: (r.order_id as number) ?? null,
      note: (r.note as string) ?? null,
      createdAt: r.created_at as string,
    }));
  }
}
