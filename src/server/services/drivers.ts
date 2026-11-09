import { randomBytes } from 'node:crypto';
import type { Db } from '../db/database';
import { nowIso, parseJson } from '../db/database';
import type { AuditLog, Bus } from '../infra';
import type { Driver, DriverMessage, DriverStatus, DispatchOffer, RouteStop, OrderStatus, ReassignmentSuggestion } from '../../shared/types';
import type { InventoryService } from './inventory';

const DRIVER_SELECT = `
SELECT d.*, sl.id AS vehicle_location_id,
  (SELECT COUNT(*) FROM orders o WHERE o.driver_id = d.id AND o.status IN ('driver_assigned','out_for_delivery')) AS active_count,
  (SELECT COUNT(*) FROM dispatch_offers f WHERE f.driver_id = d.id AND f.status = 'pending') AS pending_offers
FROM drivers d LEFT JOIN stock_locations sl ON sl.driver_id = d.id AND sl.active = 1`;

export function mapDriver(r: Record<string, unknown>): Driver {
  return {
    id: r.id as number,
    name: r.name as string,
    phone: (r.phone as string) ?? null,
    telegramUserId: (r.telegram_user_id as string) ?? null,
    telegramChatId: (r.telegram_chat_id as string) ?? null,
    telegramLinkCode: (r.telegram_link_code as string) ?? null,
    status: r.status as DriverStatus,
    vehicleName: (r.vehicle_name as string) ?? null,
    vehicleLocationId: (r.vehicle_location_id as number) ?? null,
    maxActiveOrders: r.max_active_orders as number,
    lastLat: (r.last_lat as number) ?? null,
    lastLng: (r.last_lng as number) ?? null,
    lastPositionAt: (r.last_position_at as string) ?? null,
    lastPositionSource: (r.last_position_source as string) ?? null,
    lastStatusText: (r.last_status_text as string) ?? null,
    lastStatusAt: (r.last_status_at as string) ?? null,
    currentOrderId: (r.current_order_id as number) ?? null,
    extraCapacityUntil: (r.extra_capacity_until as string) ?? null,
    routeVersion: (r.route_version as number) ?? 0,
    active: !!r.active,
    activeOrderCount: (r.active_count as number) ?? 0,
    pendingOfferCount: (r.pending_offers as number) ?? 0,
  };
}

export class DriverService {
  constructor(
    private db: Db,
    private bus: Bus,
    private inventory: InventoryService,
    private audit: AuditLog,
  ) {}

  list(includeInactive = false): Driver[] {
    return (
      this.db.prepare(`${DRIVER_SELECT} ${includeInactive ? '' : 'WHERE d.active = 1'} ORDER BY d.name`).all() as Record<string, unknown>[]
    ).map(mapDriver);
  }

  get(id: number): Driver | null {
    const r = this.db.prepare(`${DRIVER_SELECT} WHERE d.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapDriver(r) : null;
  }

  byTelegramUser(userId: string): Driver | null {
    const r = this.db.prepare(`${DRIVER_SELECT} WHERE d.telegram_user_id = ?`).get(userId) as Record<string, unknown> | undefined;
    return r ? mapDriver(r) : null;
  }

  create(input: { name: string; phone?: string | null; vehicleName?: string | null; maxActiveOrders?: number; createVehicleStock?: boolean }): Driver {
    if (!input.name?.trim()) throw new Error('Navn mangler');
    const id = this.db.transaction(() => {
      const r = this.db
        .prepare(`INSERT INTO drivers (name, phone, vehicle_name, max_active_orders, telegram_link_code) VALUES (?, ?, ?, ?, ?)`)
        .run(input.name.trim(), input.phone ?? null, input.vehicleName ?? null, input.maxActiveOrders ?? 4, newLinkCode());
      const id = Number(r.lastInsertRowid);
      if (input.createVehicleStock !== false) {
        this.inventory.createLocation(`Bil – ${input.vehicleName || input.name.trim()}`, 'vehicle', id);
      }
      return id;
    })();
    this.audit.record('staff', 'driver_create', 'driver', id);
    this.bus.touch('drivers', 'inventory');
    return this.get(id)!;
  }

  update(id: number, patch: { name?: string; phone?: string | null; vehicleName?: string | null; maxActiveOrders?: number; active?: boolean }): Driver {
    const d = this.get(id);
    if (!d) throw new Error('Chauffør findes ikke');
    this.db
      .prepare(`UPDATE drivers SET name = ?, phone = ?, vehicle_name = ?, max_active_orders = ?, active = ? WHERE id = ?`)
      .run(
        patch.name?.trim() || d.name,
        patch.phone !== undefined ? patch.phone : d.phone,
        patch.vehicleName !== undefined ? patch.vehicleName : d.vehicleName,
        patch.maxActiveOrders ?? d.maxActiveOrders,
        patch.active === undefined ? (d.active ? 1 : 0) : patch.active ? 1 : 0,
        id,
      );
    this.bus.touch('drivers');
    return this.get(id)!;
  }

  setStatus(id: number, status: DriverStatus, actor = 'system'): void {
    this.db.prepare(`UPDATE drivers SET status = ? WHERE id = ?`).run(status, id);
    this.audit.record(actor, 'driver_status', 'driver', id, { status });
    this.bus.touch('drivers');
    this.bus.emit('driver_status', { driverId: id, status });
  }

  /** Registrér chaufførens senest kendte stop (ikke live-position). */
  setPosition(id: number, lat: number, lng: number, source: 'delivered_stop' | 'central' | 'manual'): void {
    this.db
      .prepare(`UPDATE drivers SET last_lat = ?, last_lng = ?, last_position_at = ?, last_position_source = ? WHERE id = ?`)
      .run(lat, lng, nowIso(), source, id);
    this.bus.touch('drivers', 'logistics');
  }

  regenerateLinkCode(id: number): string {
    const code = newLinkCode();
    this.db.prepare(`UPDATE drivers SET telegram_link_code = ? WHERE id = ?`).run(code, id);
    this.bus.touch('drivers');
    return code;
  }

  /** Knyt en Telegram-bruger til en chaufførprofil via engangskode (/start KODE). */
  linkTelegram(code: string, telegramUserId: string, chatId: string): Driver | null {
    const r = this.db.prepare(`SELECT id FROM drivers WHERE telegram_link_code = ? AND active = 1`).get(code.trim().toUpperCase()) as
      | { id: number }
      | undefined;
    if (!r) return null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE drivers SET telegram_user_id = NULL, telegram_chat_id = NULL WHERE telegram_user_id = ?`).run(telegramUserId);
      this.db
        .prepare(`UPDATE drivers SET telegram_user_id = ?, telegram_chat_id = ?, telegram_link_code = NULL WHERE id = ?`)
        .run(telegramUserId, chatId, r.id);
    })();
    this.audit.record('driver', 'telegram_linked', 'driver', r.id, { telegramUserId });
    this.bus.touch('drivers');
    return this.get(r.id);
  }

  unlinkTelegram(id: number): void {
    this.db.prepare(`UPDATE drivers SET telegram_user_id = NULL, telegram_chat_id = NULL, telegram_link_code = ? WHERE id = ?`).run(newLinkCode(), id);
    this.audit.record('staff', 'telegram_unlinked', 'driver', id);
    this.bus.touch('drivers');
  }

  logMessage(input: {
    driverId: number | null;
    direction: 'in' | 'out';
    body: string;
    updateId?: string | null;
    idempotencyKey?: string | null;
    orderId?: number | null;
    status?: string;
    simulated: boolean;
  }): number | null {
    const r = this.db
      .prepare(
        `INSERT INTO driver_messages (driver_id, direction, body, external_update_id, idempotency_key, order_id, status, simulated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        input.driverId,
        input.direction,
        input.body,
        input.updateId ?? null,
        input.idempotencyKey ?? null,
        input.orderId ?? null,
        input.status ?? (input.direction === 'in' ? 'received' : 'queued'),
        input.simulated ? 1 : 0,
        nowIso(),
      );
    if (r.changes === 0) return null;
    this.bus.touch('drivers');
    return Number(r.lastInsertRowid);
  }

  setMessageStatus(id: number, status: string): void {
    this.db.prepare(`UPDATE driver_messages SET status = ? WHERE id = ?`).run(status, id);
  }

  messages(driverId: number, limit = 100): DriverMessage[] {
    return (
      this.db
        .prepare(`SELECT * FROM (SELECT * FROM driver_messages WHERE driver_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
        .all(driverId, limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      driverId: r.driver_id as number,
      direction: r.direction as 'in' | 'out',
      body: r.body as string,
      orderId: (r.order_id as number) ?? null,
      createdAt: r.created_at as string,
      simulated: !!r.simulated,
    }));
  }

  activeOrderIds(driverId: number): number[] {
    return (
      this.db
        .prepare(`SELECT id FROM orders WHERE driver_id = ? AND status IN ('driver_assigned','out_for_delivery') ORDER BY id`)
        .all(driverId) as { id: number }[]
    ).map((r) => r.id);
  }

  offers(orderId?: number): DispatchOffer[] {
    const rows = this.db
      .prepare(
        `SELECT o.*, d.name AS driver_name FROM dispatch_offers o JOIN drivers d ON d.id = o.driver_id
         ${orderId ? 'WHERE o.order_id = ?' : `WHERE o.status = 'pending'`} ORDER BY o.id DESC LIMIT 200`,
      )
      .all(...(orderId ? [orderId] : [])) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      orderId: r.order_id as number,
      driverId: r.driver_id as number,
      driverName: r.driver_name as string,
      status: r.status as DispatchOffer['status'],
      kind: ((r.kind as string) ?? 'new_order') as DispatchOffer['kind'],
      plan: parseJson(r.plan as string | null, null),
      sentAt: r.sent_at as string,
      respondedAt: (r.responded_at as string) ?? null,
      expiresAt: r.expires_at as string,
      score: (r.score as number) ?? null,
    }));
  }

  routeStops(driverId?: number): RouteStop[] {
    const rows = this.db
      .prepare(
        `SELECT rs.*, o.address_lat, o.address_lng, o.address_text, o.status FROM route_stops rs JOIN orders o ON o.id = rs.order_id
         ${driverId ? 'WHERE rs.driver_id = ?' : ''} ORDER BY rs.driver_id, rs.sequence`,
      )
      .all(...(driverId ? [driverId] : [])) as Record<string, unknown>[];
    return rows.map((r) => ({
      driverId: r.driver_id as number,
      orderId: r.order_id as number,
      sequence: r.sequence as number,
      eta: (r.eta as string) ?? null,
      etaLow: (r.eta_low as string) ?? null,
      etaHigh: (r.eta_high as string) ?? null,
      etaBasis: (r.eta_basis as string) ?? null,
      confidence: (r.confidence as RouteStop['confidence']) ?? null,
      durationFromPrevS: (r.duration_from_prev_s as number) ?? null,
      distanceFromPrevM: (r.distance_from_prev_m as number) ?? null,
      lat: (r.address_lat as number) ?? null,
      lng: (r.address_lng as number) ?? null,
      address: (r.address_text as string) ?? null,
      status: r.status as OrderStatus,
    }));
  }

  suggestions(onlyOpen = true): ReassignmentSuggestion[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, d.name AS to_name FROM reassignment_suggestions s JOIN drivers d ON d.id = s.to_driver_id
           ${onlyOpen ? `WHERE s.status = 'open'` : ''} ORDER BY s.id DESC LIMIT 100`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      orderId: r.order_id as number,
      fromDriverId: (r.from_driver_id as number) ?? null,
      toDriverId: r.to_driver_id as number,
      toDriverName: r.to_name as string,
      reason: r.reason as string,
      etaGainMinutes: (r.eta_gain_minutes as number) ?? null,
      analysis: parseJson(r.analysis as string | null, null),
      status: r.status as ReassignmentSuggestion['status'],
      createdAt: r.created_at as string,
    }));
  }
}

function newLinkCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
