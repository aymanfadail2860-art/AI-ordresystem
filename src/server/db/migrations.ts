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
  {
    version: 2,
    name: 'telegram_eta_and_economics',
    sql: `
-- Vareomkostning (til dækningsbidrag). NULL = ukendt → standard-avance bruges.
ALTER TABLE products ADD COLUMN cost_ore INTEGER CHECK (cost_ore IS NULL OR cost_ore >= 0);

-- Chaufførstatus fra Telegram (ingen live-GPS). last_lat/last_lng betyder nu
-- "senest kendte stop" (leveret adresse, centrallager eller manuelt angivet startsted).
ALTER TABLE drivers ADD COLUMN last_status_text TEXT;
ALTER TABLE drivers ADD COLUMN last_status_at TEXT;
ALTER TABLE drivers ADD COLUMN current_order_id INTEGER;
ALTER TABLE drivers ADD COLUMN extra_capacity_until TEXT;
ALTER TABLE drivers ADD COLUMN route_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drivers ADD COLUMN status_request_sent_at TEXT;
UPDATE drivers SET last_position_source = 'manual' WHERE last_position_source IN ('telegram_live', 'demo');

-- Udgangspunkt for ETA-beregning pr. chauffør
CREATE TABLE eta_anchors (
  driver_id INTEGER PRIMARY KEY REFERENCES drivers(id),
  kind TEXT NOT NULL CHECK (kind IN ('driver_report','delivered','start')),
  at TEXT NOT NULL,
  lat REAL,
  lng REAL,
  order_id INTEGER,
  reported_at TEXT NOT NULL
);

CREATE TABLE driver_status_updates (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  kind TEXT NOT NULL,
  order_id INTEGER,
  eta_minutes INTEGER,
  delay_minutes INTEGER,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_driver_status_driver ON driver_status_updates(driver_id, id);

-- Ruten er nu bindende (rækkefølge ændres kun via accepteret plan)
ALTER TABLE route_stops ADD COLUMN eta_low TEXT;
ALTER TABLE route_stops ADD COLUMN eta_high TEXT;
ALTER TABLE route_stops ADD COLUMN eta_basis TEXT;
ALTER TABLE route_stops ADD COLUMN confidence TEXT;
ALTER TABLE route_stops ADD COLUMN extra_delay_s INTEGER NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN eta_low TEXT;
ALTER TABLE orders ADD COLUMN eta_high TEXT;
ALTER TABLE orders ADD COLUMN eta_confidence TEXT;
ALTER TABLE orders ADD COLUMN eta_updates_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN eta_notified_at TEXT;
ALTER TABLE orders ADD COLUMN arrival_soon_sent INTEGER NOT NULL DEFAULT 0;

-- Tilbud indeholder den konkrete ruteplan, chaufføren accepterer
ALTER TABLE dispatch_offers ADD COLUMN kind TEXT NOT NULL DEFAULT 'new_order';
ALTER TABLE dispatch_offers ADD COLUMN plan TEXT;
ALTER TABLE dispatch_offers ADD COLUMN route_version INTEGER;
ALTER TABLE dispatch_offers ADD COLUMN from_driver_id INTEGER;

ALTER TABLE reassignment_suggestions ADD COLUMN analysis TEXT;
`,
  },
  {
    version: 3,
    name: 'management_and_replenishment',
    sql: `
-- Ledelsesgruppe: autoriserede brugere med roller
CREATE TABLE management_users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','observer')),
  telegram_user_id TEXT UNIQUE,
  link_code TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Revisionsspor for alle instruktioner fra ledelsen
CREATE TABLE management_commands (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES management_users(id),
  user_name TEXT,
  telegram_user_id TEXT,
  chat_id TEXT,
  instruction TEXT NOT NULL,
  intent TEXT,
  params TEXT,
  affected_orders TEXT,
  decision TEXT NOT NULL,
  result TEXT,
  confirm_token TEXT UNIQUE,
  confirm_expires_at TEXT,
  confirmed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_mgmt_commands_created ON management_commands(created_at);

CREATE TABLE management_messages (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  user_name TEXT,
  body TEXT NOT NULL,
  external_update_id TEXT UNIQUE,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'received',
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Ordreprioritet og pause (ledelsesbeslutninger)
ALTER TABLE orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN paused_from_status TEXT;

-- Proaktiv lageropfyldning af chaufførbiler
CREATE TABLE replenishments (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  location_id INTEGER NOT NULL REFERENCES stock_locations(id),
  status TEXT NOT NULL CHECK (status IN ('proposed','awaiting_management','approved','awaiting_driver','en_route','awaiting_pickup','picked_up','completed','rejected','cancelled','expired')),
  after_order_id INTEGER,
  items TEXT NOT NULL,
  covers_orders TEXT NOT NULL,
  analysis TEXT,
  deadline_at TEXT,
  sent_at TEXT,
  reminder_sent_at TEXT,
  escalated_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  rejected_by TEXT,
  rejected_reason TEXT,
  driver_accepted_at TEXT,
  picked_up_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Højst én aktiv opfyldning pr. chauffør (forhindrer dobbeltopfyldning og modstridende planer)
CREATE UNIQUE INDEX idx_replenishment_active ON replenishments(driver_id)
  WHERE status IN ('proposed','awaiting_management','approved','awaiting_driver','en_route','awaiting_pickup','picked_up');

CREATE TABLE replenishment_events (
  id INTEGER PRIMARY KEY,
  replenishment_id INTEGER NOT NULL REFERENCES replenishments(id),
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`,
  },
  {
    version: 4,
    name: 'reports_monitoring_simulation',
    sql: `
-- Automatiske timerapporter og rapporter på forespørgsel. Én timerapport pr. periode.
CREATE TABLE management_reports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('hourly','on_demand')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','queued','sent','uncertain','failed','skipped')),
  chat_id TEXT,
  body TEXT,
  metrics TEXT,
  message_key TEXT,
  requested_by TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE UNIQUE INDEX idx_reports_hourly ON management_reports(period_start) WHERE kind = 'hourly';
CREATE INDEX idx_reports_created ON management_reports(created_at);

-- Proaktiv overvågning: én åben advarsel pr. problem (dedupe på alert_key).
CREATE TABLE monitor_alerts (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  category TEXT NOT NULL CHECK (category IN ('auto','inform','approval','takeover')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','acknowledged')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  action_taken TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  notified_category TEXT,
  notified_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  acknowledged_by TEXT
);
CREATE UNIQUE INDEX idx_monitor_alert_open ON monitor_alerts(alert_key) WHERE status IN ('open','acknowledged');
CREATE INDEX idx_monitor_alert_status ON monitor_alerts(status, last_seen_at);

-- Revisionsspor for overvågningens beslutninger og handlinger.
CREATE TABLE monitor_decisions (
  id INTEGER PRIMARY KEY,
  alert_id INTEGER NOT NULL REFERENCES monitor_alerts(id),
  category TEXT NOT NULL,
  decision TEXT NOT NULL,
  action TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_monitor_decisions_alert ON monitor_decisions(alert_id);

-- Driftssimuleringer (altid simulerede data).
CREATE TABLE simulation_runs (
  id INTEGER PRIMARY KEY,
  group_id TEXT,
  seed INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  config TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  metrics TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);
`,
  },
];
