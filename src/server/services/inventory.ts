import type { Db } from '../db/database';
import { nowIso } from '../db/database';
import type { Bus } from '../infra';
import type { LocationCapacity, StockLevel, StockLocation, StockMovement } from '../../shared/types';

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
/** Varerne kan ikke være i bilen (samlet plads, varetype eller plads uden for fast sortiment). */
export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

export interface CapacityConfig {
  capacityUnits: number | null;
  categoryCaps: Record<string, number>;
  flexUnits: number | null;
}

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

  // ---------------- Fysisk kapacitet (Etape 5) ----------------

  capacityConfig(locationId: number): CapacityConfig {
    const r = this.db.prepare(`SELECT capacity_units, category_caps, flex_units FROM stock_locations WHERE id = ?`).get(locationId) as
      | { capacity_units: number | null; category_caps: string | null; flex_units: number | null }
      | undefined;
    let caps: Record<string, number> = {};
    try {
      caps = r?.category_caps ? (JSON.parse(r.category_caps) as Record<string, number>) : {};
    } catch {
      caps = {};
    }
    return { capacityUnits: r?.capacity_units ?? null, categoryCaps: caps, flexUnits: r?.flex_units ?? null };
  }

  setCapacity(locationId: number, cfg: Partial<CapacityConfig>): void {
    const cur = this.capacityConfig(locationId);
    const next = { ...cur, ...cfg };
    if (next.capacityUnits != null && (!Number.isFinite(next.capacityUnits) || next.capacityUnits < 0)) throw new Error('Ugyldig kapacitet');
    for (const [k, v] of Object.entries(next.categoryCaps)) if (!k.trim() || !Number.isFinite(v) || v < 0) throw new Error(`Ugyldig kapacitet for ${k}`);
    this.db
      .prepare(`UPDATE stock_locations SET capacity_units = ?, category_caps = ?, flex_units = ? WHERE id = ?`)
      .run(next.capacityUnits, Object.keys(next.categoryCaps).length ? JSON.stringify(next.categoryCaps) : null, next.flexUnits, locationId);
    this.bus.touch('inventory');
  }

  assortment(locationId: number): { productId: number; parLevel: number; maxQty: number | null }[] {
    return (this.db.prepare(`SELECT product_id, par_level, max_qty FROM location_assortment WHERE location_id = ?`).all(locationId) as {
      product_id: number;
      par_level: number;
      max_qty: number | null;
    }[]).map((r) => ({ productId: r.product_id, parLevel: r.par_level, maxQty: r.max_qty }));
  }

  setAssortment(locationId: number, items: { productId: number; parLevel: number; maxQty?: number | null }[]): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM location_assortment WHERE location_id = ?`).run(locationId);
      const ins = this.db.prepare(`INSERT INTO location_assortment (location_id, product_id, par_level, max_qty) VALUES (?, ?, ?, ?)`);
      for (const i of items) {
        if (!Number.isInteger(i.parLevel) || i.parLevel < 0) throw new Error('Ugyldig normalbeholdning');
        ins.run(locationId, i.productId, i.parLevel, i.maxQty ?? null);
      }
    })();
    this.bus.touch('inventory');
  }

  private productInfo(): Map<number, { volume: number; category: string; name: string }> {
    return new Map(
      (this.db.prepare(`SELECT id, unit_volume, category, name FROM products`).all() as { id: number; unit_volume: number; category: string; name: string }[]).map((p) => [
        p.id,
        { volume: p.unit_volume ?? 1, category: p.category, name: p.name },
      ]),
    );
  }

  /** Plads (lagerenheder) for et sæt varer. */
  unitsFor(items: { productId: number; quantity: number }[]): number {
    const info = this.productInfo();
    return items.reduce((sum, i) => sum + i.quantity * (info.get(i.productId)?.volume ?? 1), 0);
  }

  /** Kapacitetsstatus: samlet, pr. varetype, fast sortiment og plads uden for sortimentet. */
  capacity(locationId: number, plannedPickupUnits = 0): LocationCapacity {
    const cfg = this.capacityConfig(locationId);
    const info = this.productInfo();
    const rows = this.db.prepare(`SELECT product_id, quantity, reserved FROM stock_levels WHERE location_id = ?`).all(locationId) as {
      product_id: number;
      quantity: number;
      reserved: number;
    }[];
    const assort = this.assortment(locationId);
    const inAssort = new Set(assort.map((a) => a.productId));
    let used = 0;
    let reserved = 0;
    let flexUsed = 0;
    const byCat = new Map<string, number>();
    for (const r of rows) {
      const p = info.get(r.product_id);
      const vol = p?.volume ?? 1;
      used += r.quantity * vol;
      reserved += r.reserved * vol;
      if (assort.length && !inAssort.has(r.product_id)) flexUsed += r.quantity * vol;
      const cat = p?.category ?? 'Andet';
      byCat.set(cat, (byCat.get(cat) ?? 0) + r.quantity * vol);
    }
    const cats = new Set([...byCat.keys(), ...Object.keys(cfg.categoryCaps)]);
    return {
      locationId,
      capacityUnits: cfg.capacityUnits,
      usedUnits: round1(used),
      reservedUnits: round1(reserved),
      freeUnits: cfg.capacityUnits == null ? null : round1(Math.max(0, cfg.capacityUnits - used)),
      flexUnits: cfg.flexUnits,
      flexUsedUnits: round1(flexUsed),
      byCategory: [...cats].map((c) => ({ category: c, usedUnits: round1(byCat.get(c) ?? 0), capUnits: cfg.categoryCaps[c] ?? null })),
      assortment: assort.map((a) => {
        const r = rows.find((x) => x.product_id === a.productId);
        return { productId: a.productId, productName: info.get(a.productId)?.name ?? `#${a.productId}`, parLevel: a.parLevel, maxQty: a.maxQty, quantity: r?.quantity ?? 0, reserved: r?.reserved ?? 0 };
      }),
      plannedPickupUnits: round1(plannedPickupUnits),
    };
  }

  /**
   * Kan varerne lægges i bilen? `freedUnits` er plads, der frigøres før (fx leveringer
   * før lagerbesøget). Returnerer null hvis ja, ellers en forklaring.
   */
  fitProblem(locationId: number, items: { productId: number; quantity: number }[], freedUnits = 0, freedByCategory: Record<string, number> = {}): string | null {
    const cfg = this.capacityConfig(locationId);
    if (cfg.capacityUnits == null && !Object.keys(cfg.categoryCaps).length && cfg.flexUnits == null) return null;
    const cap = this.capacity(locationId);
    const info = this.productInfo();
    const add = this.unitsFor(items);
    if (cfg.capacityUnits != null && cap.usedUnits - freedUnits + add > cfg.capacityUnits + 1e-9) {
      return `bilen har plads til ${round1(Math.max(0, cfg.capacityUnits - cap.usedUnits + freedUnits))} enheder, men varerne fylder ${round1(add)}`;
    }
    const addCat = new Map<string, number>();
    for (const i of items) {
      const p = info.get(i.productId);
      addCat.set(p?.category ?? 'Andet', (addCat.get(p?.category ?? 'Andet') ?? 0) + i.quantity * (p?.volume ?? 1));
    }
    for (const [cat, units] of addCat) {
      const capU = cfg.categoryCaps[cat];
      if (capU == null) continue;
      const usedCat = (cap.byCategory.find((c) => c.category === cat)?.usedUnits ?? 0) - (freedByCategory[cat] ?? 0);
      if (usedCat + units > capU + 1e-9) return `${cat}: plads til ${round1(Math.max(0, capU - usedCat))} enheder, men varerne fylder ${round1(units)}`;
    }
    if (cfg.flexUnits != null && cap.assortment.length) {
      const inAssort = new Set(cap.assortment.map((a) => a.productId));
      const flexAdd = items.filter((i) => !inAssort.has(i.productId)).reduce((a, i) => a + i.quantity * (info.get(i.productId)?.volume ?? 1), 0);
      if (flexAdd > 0 && cap.flexUsedUnits + flexAdd > cfg.flexUnits + 1e-9) return `varer uden for bilens faste sortiment: plads til ${round1(Math.max(0, cfg.flexUnits - cap.flexUsedUnits))} enheder`;
    }
    return null;
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
  pickupForOrders(orderIds: number[], fromLocationId: number, vehicleLocationId: number, replenishmentId: number, skipped?: number[]): { productId: number; quantity: number }[] {
    const moved = new Map<number, number>();
    this.db.transaction(() => {
      for (const orderId of orderIds) {
        const o = this.db.prepare(`SELECT stock_state, stock_location_id FROM orders WHERE id = ?`).get(orderId) as
          | { stock_state: string; stock_location_id: number | null }
          | undefined;
        if (!o || o.stock_state !== 'reserved' || o.stock_location_id !== fromLocationId) continue; // allerede flyttet/annulleret
        // Fysisk kapacitet: ordrer der ikke kan være i bilen, bliver på lageret til næste besøg
        if (this.fitProblem(vehicleLocationId, this.orderNeeds(orderId))) {
          skipped?.push(orderId);
          continue;
        }
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
      const problem = this.fitProblem(toId, [{ productId, quantity: qty }]);
      if (problem) throw new CapacityError(`Ikke plads: ${problem}`);
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

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
