/**
 * Databasemigrationer. Hver migration køres præcis én gang i en transaktion
 * og registreres i `schema_migrations`. Eksisterende migrationer må ALDRIG
 * ændres efter udgivelse – tilføj i stedet en ny.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  default_address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  anonymized_at TEXT
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  channel TEXT NOT NULL DEFAULT 'sms',
  external_chat_id TEXT,
  ai_mode TEXT NOT NULL DEFAULT 'ai_active'
    CHECK (ai_mode IN ('ai_active','manual','ai_paused','integration_error')),
  mode_reason TEXT,
  mode_changed_at TEXT,
  mode_changed_by TEXT,
  last_message_at TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (customer_id, channel)
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Andet',
  variant TEXT,
  price_ore INTEGER NOT NULL CHECK (price_ore >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  synonyms TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE drivers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  telegram_user_id TEXT UNIQUE,
  telegram_chat_id TEXT,
  telegram_link_code TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline','available','busy','break')),
  vehicle_name TEXT,
  max_active_orders INTEGER NOT NULL DEFAULT 4,
  last_lat REAL,
  last_lng REAL,
  last_position_at TEXT,
  last_position_source TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE stock_locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('central','vehicle')),
  driver_id INTEGER UNIQUE REFERENCES drivers(id),
  lat REAL,
  lng REAL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE stock_levels (
  location_id INTEGER NOT NULL REFERENCES stock_locations(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= quantity),
  PRIMARY KEY (location_id, product_id)
);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES stock_locations(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta_quantity INTEGER NOT NULL DEFAULT 0,
  delta_reserved INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  order_id INTEGER,
  note TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_stock_movements_created ON stock_movements(created_at);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  conversation_id INTEGER REFERENCES conversations(id),
  status TEXT NOT NULL,
  address_text TEXT,
  address_lat REAL,
  address_lng REAL,
  address_validated INTEGER NOT NULL DEFAULT 0,
  delivery_instructions TEXT,
  requested_time TEXT,
  eta TEXT,
  eta_source TEXT,
  eta_communicated TEXT,
  driver_id INTEGER REFERENCES drivers(id),
  stock_location_id INTEGER REFERENCES stock_locations(id),
  stock_state TEXT NOT NULL DEFAULT 'none' CHECK (stock_state IN ('none','reserved','deducted','released')),
  subtotal_ore INTEGER NOT NULL DEFAULT 0,
  delivery_fee_ore INTEGER NOT NULL DEFAULT 0,
  total_ore INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT DEFAULT 'cash_on_delivery',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  attention_reason TEXT,
  idempotency_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_driver ON orders(driver_id);
CREATE INDEX idx_orders_conversation ON orders(conversation_id);

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_ore INTEGER NOT NULL CHECK (unit_price_ore >= 0),
  line_total_ore INTEGER NOT NULL
);
CREATE INDEX idx_order_lines_order ON order_lines(order_id);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  author TEXT NOT NULL CHECK (author IN ('customer','ai','staff','system')),
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  external_guid TEXT UNIQUE,
  external_rowid INTEGER,
  idempotency_key TEXT UNIQUE,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  order_id INTEGER REFERENCES orders(id),
  simulated INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX idx_messages_status ON messages(status);

CREATE TABLE dispatch_offers (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','expired','cancelled')),
  score REAL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  responded_at TEXT
);
CREATE INDEX idx_offers_order ON dispatch_offers(order_id);

CREATE TABLE driver_messages (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER REFERENCES drivers(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body TEXT NOT NULL,
  external_update_id TEXT UNIQUE,
  telegram_message_id TEXT,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'received',
  order_id INTEGER REFERENCES orders(id),
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_driver_messages_driver ON driver_messages(driver_id, id);

CREATE TABLE route_stops (
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sequence INTEGER NOT NULL,
  eta TEXT,
  duration_from_prev_s INTEGER,
  distance_from_prev_m INTEGER,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (driver_id, order_id)
);

CREATE TABLE reassignment_suggestions (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  from_driver_id INTEGER,
  to_driver_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  eta_gain_minutes REAL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error','critical')),
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  requires_action INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged_at TEXT
);
CREATE INDEX idx_events_created ON events(created_at);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  lane TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','dead','cancelled')),
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_jobs_due ON jobs(status, run_at);
-- Kun ét aktivt job pr. dedupe-nøgle ad gangen
CREATE UNIQUE INDEX idx_jobs_dedupe_active ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

CREATE TABLE ai_calls (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  task_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL,
  error TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  conversation_id INTEGER,
  order_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_calls_created ON ai_calls(created_at);

CREATE TABLE integration_status (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  message TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  production_verified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_ok_at TEXT
);

CREATE TABLE kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE geocode_cache (
  query TEXT PRIMARY KEY,
  lat REAL,
  lng REAL,
  formatted TEXT,
  postal_code TEXT,
  found INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE travel_cache (
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  distance_m INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (origin, destination)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`,
  },
];
