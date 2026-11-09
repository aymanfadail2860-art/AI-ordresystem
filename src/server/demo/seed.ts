import type { Ctx } from '../context';
import { nowIso } from '../db/database';

/**
 * Fiktive demodata. Alle navne, numre og adresser er opdigtede.
 * Telefonnumre bruger serien +45 99 99 xx xx, som ikke tildeles abonnenter i demo.
 */
export const DEMO_PRODUCTS = [
  { sku: 'RB25', name: 'Red Bull', variant: '25 cl', category: 'Energidrik', priceOre: 2500, synonyms: ['redbull', 'red bull', 'rb'] },
  { sku: 'RBSF25', name: 'Red Bull Sugarfree', variant: '25 cl', category: 'Energidrik', priceOre: 2500, synonyms: ['sugarfree', 'red bull sukkerfri'] },
  { sku: 'MON50', name: 'Monster Energy', variant: '50 cl', category: 'Energidrik', priceOre: 3000, synonyms: ['monster'] },
  { sku: 'COLA50', name: 'Coca-Cola', variant: '50 cl', category: 'Sodavand', priceOre: 2200, synonyms: ['cola', 'coke', 'coca cola'] },
  { sku: 'COLAZ50', name: 'Coca-Cola Zero', variant: '50 cl', category: 'Sodavand', priceOre: 2200, synonyms: ['cola zero', 'zero', 'coke zero'] },
  { sku: 'FAXE50', name: 'Faxe Kondi', variant: '50 cl', category: 'Sodavand', priceOre: 2000, synonyms: ['faxe', 'kondi'] },
  { sku: 'FANTA50', name: 'Fanta', variant: '50 cl', category: 'Sodavand', priceOre: 2000, synonyms: [] },
  { sku: 'VAND50', name: 'Kildevand', variant: '50 cl', category: 'Vand', priceOre: 1500, synonyms: ['vand', 'danskvand'] },
  { sku: 'ICE33', name: 'Iskaffe', variant: '33 cl', category: 'Kaffe', priceOre: 2800, synonyms: ['iskaffe', 'ice coffee'] },
  { sku: 'CHIPS', name: 'Kartoffelchips', variant: '175 g', category: 'Snacks', priceOre: 3000, synonyms: ['chips', 'pose chips'] },
  { sku: 'NACHO', name: 'Tortillachips', variant: '200 g', category: 'Snacks', priceOre: 3200, synonyms: ['nachos', 'tortilla'] },
  { sku: 'SLIK', name: 'Vingummi', variant: '250 g', category: 'Slik', priceOre: 2500, synonyms: ['slik', 'vingummi', 'matador mix'] },
  { sku: 'CHOKO', name: 'Chokoladebar', variant: null, category: 'Slik', priceOre: 1500, synonyms: ['chokolade', 'snickers', 'mars'] },
  { sku: 'IS', name: 'Is (pind)', variant: null, category: 'Is', priceOre: 2500, synonyms: ['is', 'ispind'] },
];

export const DEMO_DRIVERS = [
  { name: 'Ali Demo', vehicle: 'Kia e-Niro (demo)', lat: 55.6893, lng: 12.5537, status: 'available' as const },
  { name: 'Sara Demo', vehicle: 'VW ID.3 (demo)', lat: 55.6667, lng: 12.5413, status: 'available' as const },
  { name: 'Mikkel Demo', vehicle: 'Toyota Yaris (demo)', lat: 55.6995, lng: 12.5880, status: 'available' as const },
  { name: 'Nadia Demo', vehicle: 'Cargobike (demo)', lat: 55.6790, lng: 12.5900, status: 'offline' as const },
];

export function seedDemo(ctx: Ctx): void {
  const existing = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM products`).get() as { c: number }).c;
  if (existing > 0) return;
  ctx.db.transaction(() => {
    ctx.settings.update({
      company: { name: 'Demo Drikkevarer ApS', phone: '+45 99 99 00 00', email: 'demo@example.invalid', address: 'Demovej 1, 2200 København N', cvr: '00000000' },
      installation: { mode: 'demo', setupCompleted: true, automationEnabled: true },
      pricing: { minimumOrderOre: 5000 },
      // Demo: døgnåbent, så demoen altid virker
      openingHours: Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '00:00', closed: false }]),
      ) as never,
    });
    const products = DEMO_PRODUCTS.map((p) => ctx.catalog.create(p));
    const central = ctx.inventory.createLocation('Centrallager (demo)', 'central', null, 55.6863, 12.5610);
    for (const p of products) ctx.inventory.adjust(central, p.id, 60 + Math.floor(Math.random() * 60), 'Demo-startlager', 'system');
    DEMO_DRIVERS.forEach((d, i) => {
      const driver = ctx.drivers.create({ name: d.name, phone: `+459999010${i}`, vehicleName: d.vehicle, maxActiveOrders: 4 });
      const uid = `sim-driver-${driver.id}`;
      ctx.db.prepare(`UPDATE drivers SET telegram_user_id = ?, telegram_chat_id = ?, telegram_link_code = NULL WHERE id = ?`).run(uid, uid, driver.id);
      ctx.drivers.setStatus(driver.id, d.status, 'system');
      ctx.drivers.setPosition(driver.id, d.lat, d.lng, 'demo');
      const loc = ctx.inventory.vehicleLocationForDriver(driver.id)!;
      for (const p of products) {
        const qty = p.category === 'Energidrik' || p.category === 'Sodavand' ? 6 + Math.floor(Math.random() * 10) : Math.floor(Math.random() * 6);
        if (qty > 0) ctx.inventory.adjust(loc, p.id, qty, 'Demo-billager', 'system');
      }
    });
    seedHistory(ctx);
  })();
  ctx.events.log('info', 'demo', 'seeded', 'Demodata oprettet (fiktive kunder, chauffører og produkter)');
}

/** Et par afsluttede ordrer fra tidligere i dag, så dashboardet har historik. */
function seedHistory(ctx: Ctx): void {
  const addrs = ['Fiktivgade 3, 2200 København N', 'Demoallé 18, 2100 København Ø', 'Testvej 7, 2300 København S'];
  const products = ctx.catalog.list();
  addrs.forEach((addr, i) => {
    const phone = `+459999200${i}`;
    const customer = ctx.conversations.upsertCustomer(phone);
    const convId = ctx.conversations.getOrCreateConversation(customer.id);
    const created = new Date(Date.now() - (3 - i) * 3600000);
    const p = products[i * 3];
    const subtotal = p.priceOre * (2 + i);
    const r = ctx.db
      .prepare(
        `INSERT INTO orders (customer_id, conversation_id, status, address_text, address_lat, address_lng, address_validated, subtotal_ore, delivery_fee_ore, total_ore,
           payment_status, created_at, updated_at, confirmed_at, delivered_at, stock_state, idempotency_key)
         VALUES (?, ?, 'delivered', ?, ?, ?, 1, ?, 3900, ?, 'paid', ?, ?, ?, ?, 'deducted', ?)`,
      )
      .run(
        customer.id,
        convId,
        addr,
        55.68 + i * 0.01,
        12.56 - i * 0.01,
        subtotal,
        subtotal + 3900,
        created.toISOString(),
        created.toISOString(),
        created.toISOString(),
        new Date(created.getTime() + 35 * 60000).toISOString(),
        `demo-history-${i}`,
      );
    const orderId = Number(r.lastInsertRowid);
    ctx.db
      .prepare(`INSERT INTO order_lines (order_id, product_id, product_name, sku, quantity, unit_price_ore, line_total_ore) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(orderId, p.id, p.name, p.sku, 2 + i, p.priceOre, subtotal);
    ctx.db
      .prepare(`INSERT INTO order_events (order_id, type, from_status, to_status, actor, created_at) VALUES (?, 'status', 'out_for_delivery', 'delivered', 'driver', ?)`)
      .run(orderId, nowIso());
    ctx.db
      .prepare(`INSERT INTO messages (conversation_id, direction, author, body, status, simulated, processed_at, created_at) VALUES (?, 'in', 'customer', ?, 'received', 1, ?, ?)`)
      .run(convId, `${2 + i} ${p.name} til ${addr} tak`, nowIso(), created.toISOString());
  });
}
