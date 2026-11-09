import type { Db } from './db/database';
import type { AuditLog, Bus, EventLog, IntegrationRegistry, KvState, SettingsService } from './infra';
import type { JobQueue } from './jobs/jobQueue';
import type { CatalogService } from './services/catalog';
import type { InventoryService } from './services/inventory';
import type { ConversationService } from './services/conversations';
import type { OrderService } from './services/orders';
import type { DriverService } from './services/drivers';
import type { MapsService } from './services/maps';
import type { AiGateway } from './ai/gateway';
import type { CustomerInterpreter, DriverInterpreter } from './ai/interpreters';
import type { SmsGateway } from './gateways/smsGateway';
import type { TelegramGateway } from './gateways/telegramGateway';

/** Samling af alle services – sendes til agenterne. */
export interface Ctx {
  db: Db;
  bus: Bus;
  settings: SettingsService;
  events: EventLog;
  integrations: IntegrationRegistry;
  kv: KvState;
  audit: AuditLog;
  jobs: JobQueue;
  catalog: CatalogService;
  inventory: InventoryService;
  conversations: ConversationService;
  orders: OrderService;
  drivers: DriverService;
  maps: MapsService;
  ai: AiGateway;
  customerInterpreter: CustomerInterpreter;
  driverInterpreter: DriverInterpreter;
  sms: SmsGateway;
  telegram: TelegramGateway;
}
