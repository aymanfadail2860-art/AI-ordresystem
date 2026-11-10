import os from 'node:os';
import path from 'node:path';
import { clock } from '../clock';
import { createApp, type App } from '../app';
import { MemorySecretStore } from '../secrets';
import { SimulatedSmsAdapter } from '../adapters/sms/simulator';
import { SimulatedTelegramAdapter } from '../adapters/telegram/simulator';
import { SimulatedMapsAdapter, simulatedTravel } from '../adapters/maps/simulator';
import type { LatLng } from '../../core/geo';
import { DEFAULT_TZ, localToUtc, zonedParts } from '../../core/time';
import { DEFAULT_ADAPTIVE, type AdaptiveSettings } from '../../core/routePlanning';
import { DISPATCH_STRATEGY_LABELS, type DispatchStrategy, type SimulationMetrics } from '../../shared/types';

/**
 * DRIFTSSIMULERING – en hel arbejdsdag i Demo Mode.
 *
 * Kører hele AI Dispatch (samme agenter, jobkø, database og regler som i drift)
 * i en isoleret in-memory-installation med simulerede adaptere og et virtuelt
 * ur. Kunder (SMS), chauffører (Telegram) og ledere (Telegram-gruppe) er
 * deterministiske bots styret af et fast random seed. Der sendes ALDRIG rigtige
 * beskeder eller API-kald, og resultaterne er simulerede – de beviser ikke
 * ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.
 *
 * Fair sammenligning af strategier: alle tilfældige valg er nøglet til faste
 * enheder (ordre, chauffør+ordre, opfyldning), ikke til rækkefølgen af
 * hændelser, så den samme ordre/chauffør opfører sig ens i alle strategier.
 */

export interface SimConfig {
  seed: number;
  orders: number;
  drivers: number;
  strategy: DispatchStrategy;
  /** Lokal dato (YYYY-MM-DD) i Europe/Copenhagen. */
  date?: string;
  openHour?: number;
  closeHour?: number;
  /** Midlertidige integrationsfejl og en chauffør der ikke svarer. */
  failures?: boolean;
  stepSeconds?: number;
  /**
   * Ordreprofil: 'standard' (som v0.4.0), 'large' (flere og større ordrelinjer, flere dyre varer),
   * 'spread' (større leveringsområde, ca. ±5,5 km), 'central' (flere varer der kun findes på centrallageret).
   */
  profile?: SimProfile;
  /**
   * Kør med v0.4.0-forretningsreglerne (ingen påfyldning ved lagerbesøg, overvågning der tæller
   * samme beslutning flere gange) – bruges til før/efter-sammenligningen.
   */
  legacyRules?: boolean;
  /**
   * Kør som v0.4.1: ingen alternative leveringstider og ingen fysisk kapacitet i bilerne
   * (alle varer fylder ens og ubegrænset) – til før/efter-sammenligningen i Etape 5.
   */
  v041?: boolean;
  /** Fysisk kapacitet som v0.5, men uden alternative leveringstider (isolerer effekten). */
  alternativesOff?: boolean;
  /** Eksperiment: alle varer i bilerne fra start (ingen varer kun på centrallageret). */
  fullVehicleAssortment?: boolean;
  /** Afvig fra standardindstillingerne for den adaptive strategi (kalibrering). */
  adaptive?: Partial<AdaptiveSettings>;
  onProgress?: (pct: number) => void;
  /** Fejlfinding: undersøg simuleringens database før den lukkes. */
  inspect?: (app: App) => void;
}

// ---------------- Deterministisk tilfældighed ----------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tilfældighed nøglet til en enhed – uafhængig af hændelsesrækkefølge. */
function keyed(seed: number, ...parts: (string | number)[]): () => number {
  return mulberry32(hash(seed, ...parts));
}

// ---------------- Testdata ----------------

const PRODUCTS = [
  { sku: 'RB', volume: 1, name: 'Red Bull', category: 'Energidrik', price: 2500, cost: 1250, weight: 14, syn: ['redbull'] },
  { sku: 'MON', volume: 1, name: 'Monster', category: 'Energidrik', price: 2500, cost: 1300, weight: 9, syn: [] },
  { sku: 'COLA', volume: 1, name: 'Coca-Cola', category: 'Sodavand', price: 2000, cost: 800, weight: 14, syn: ['cola'] },
  { sku: 'FAXE', volume: 1, name: 'Faxe Kondi', category: 'Sodavand', price: 1800, cost: 700, weight: 8, syn: ['faxe'] },
  { sku: 'VAND', volume: 2, name: 'Danskvand', category: 'Vand', price: 1200, cost: 300, weight: 7, syn: [] },
  { sku: 'CHIPS', volume: 3, name: 'Kartoffelchips', category: 'Snacks', price: 3000, cost: 1400, weight: 12, syn: ['chips'] },
  { sku: 'POP', volume: 3, name: 'Popcorn', category: 'Snacks', price: 2500, cost: 900, weight: 5, syn: [] },
  { sku: 'VING', volume: 1, name: 'Vingummi', category: 'Slik', price: 2200, cost: 800, weight: 8, syn: [] },
  { sku: 'CHOK', volume: 1, name: 'Chokoladebar', category: 'Slik', price: 2000, cost: 1000, weight: 7, syn: ['chokolade'] },
  { sku: 'IS', volume: 2, name: 'Isbæger', category: 'Is', price: 4500, cost: 2200, weight: 5, syn: ['is'] },
  { sku: 'KAFFE', volume: 1, name: 'Iskaffe', category: 'Kaffe', price: 3500, cost: 1000, weight: 5, syn: [] },
  { sku: 'MAELK', volume: 2, name: 'Letmælk', category: 'Dagligvarer', price: 1800, cost: 1100, weight: 3, syn: ['mælk'] },
  { sku: 'BATT', volume: 1, name: 'Batterier', category: 'Husholdning', price: 7900, cost: 3500, weight: 2, syn: [] },
  { sku: 'TOILET', volume: 8, name: 'Toiletpapir', category: 'Husholdning', price: 5000, cost: 3000, weight: 2, syn: [] },
  { sku: 'OPLADER', volume: 1, name: 'Telefonoplader', category: 'Elektronik', price: 14900, cost: 6000, weight: 1, syn: ['oplader'] },
];
/** Varer der starter i bilerne (resten ligger kun på centrallageret). */
const VEHICLE_SKUS = ['RB', 'MON', 'COLA', 'FAXE', 'VAND', 'CHIPS', 'VING', 'CHOK'];
const STREETS = ['Lærkevej', 'Birkegade', 'Egeallé', 'Solsikkevej', 'Havnegade', 'Skovvej', 'Rosenvænget', 'Kastanjevej', 'Mølleparken', 'Strandvej', 'Bøgevej', 'Engvej'];
const POSTS = ['2200 København N', '2100 København Ø', '2300 København S', '2000 Frederiksberg', '2400 København NV', '2500 Valby'];
/** Relativ efterspørgsel pr. lokal time (frokost- og aftenspids). */
const DEMAND: Record<number, number> = { 10: 3, 11: 6, 12: 8, 13: 6, 14: 4, 15: 4, 16: 6, 17: 9, 18: 10, 19: 9, 20: 8, 21: 5 };

export type SimProfile = 'standard' | 'large' | 'spread' | 'central';
export const SIM_PROFILES: SimProfile[] = ['standard', 'large', 'spread', 'central'];

type CustomerKind = 'normal' | 'ignore_quote' | 'modify' | 'cancel_after' | 'decline';

interface PlannedOrder {
  i: number;
  at: number;
  phone: string;
  text: string;
  kind: CustomerKind;
  replyDelayS: number;
  addSku: string;
}

function planOrders(cfg: Required<Omit<SimConfig, 'onProgress' | 'inspect' | 'adaptive' | 'legacyRules' | 'fullVehicleAssortment' | 'v041' | 'alternativesOff'>>, openMs: number): PlannedOrder[] {
  const rng = mulberry32(cfg.seed);
  const hours: number[] = [];
  for (let h = cfg.openHour; h < cfg.closeHour; h++) hours.push(h);
  const weights = hours.map((h) => DEMAND[h] ?? 3);
  const total = weights.reduce((a, b) => a + b, 0);
  const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const profile = cfg.profile ?? 'standard';
  const weightOf = (p: (typeof PRODUCTS)[number]) =>
    profile === 'central' && !VEHICLE_SKUS.includes(p.sku) ? p.weight * 2.5 : profile === 'large' && p.price >= 5000 ? p.weight * 3 : p.weight;
  const pickProduct = () => {
    const sum = PRODUCTS.reduce((a, p) => a + weightOf(p), 0);
    let x = rng() * sum;
    for (const p of PRODUCTS) if ((x -= weightOf(p)) <= 0) return p;
    return PRODUCTS[0];
  };
  const maxLines = profile === 'large' ? 6 : 4;
  const maxQty = profile === 'large' ? 6 : 4;
  const out: PlannedOrder[] = [];
  for (let i = 0; i < cfg.orders; i++) {
    // Ankomsttid: vælg time efter efterspørgsel, derefter tilfældigt minut (undgå sidste 10 min)
    let x = rng() * total;
    let hi = 0;
    while ((x -= weights[hi]) > 0) hi++;
    const at = openMs + (hours[hi] - cfg.openHour) * 3_600_000 + Math.floor(rng() * 50 * 60_000);
    const n = 1 + Math.floor(rng() * rng() * maxLines);
    const items = new Map<string, number>();
    for (let k = 0; k < n; k++) {
      const p = pickProduct();
      items.set(p.name, (items.get(p.name) ?? 0) + 1 + Math.floor(rng() * rng() * maxQty));
    }
    const address = `${pick(STREETS)} ${1 + Math.floor(rng() * 140)}, ${pick(POSTS)}`;
    const list = [...items].map(([name, q]) => `${q} ${name}`);
    const itemsText = list.length > 1 ? `${list.slice(0, -1).join(', ')} og ${list.at(-1)}` : list[0];
    const greet = pick(['Hej! Kan jeg få', 'Hej, jeg vil gerne bestille', 'Kan I levere', 'Hej, må jeg få']);
    const r = rng();
    const kind: CustomerKind = r < 0.04 ? 'ignore_quote' : r < 0.07 ? 'decline' : r < 0.13 ? 'modify' : r < 0.17 ? 'cancel_after' : 'normal';
    out.push({
      i,
      at,
      phone: `+4561${String(100000 + i).slice(-6)}`,
      text: `${greet} ${itemsText} til ${address}?`,
      kind,
      replyDelayS: 20 + Math.floor(rng() * 120),
      addSku: pick(['Coca-Cola', 'Kartoffelchips', 'Red Bull', 'Vingummi']),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------- Simuleret kort med fejlvinduer ----------------

class SimMaps extends SimulatedMapsAdapter {
  failing = false;
  constructor(
    private c: LatLng,
    private scale = 0.5,
  ) {
    super(c);
  }
  /** Leveringsområde ca. ±3,5 km omkring centrum (en tæt bydel). */
  override async geocode(address: string) {
    if (this.failing) throw new Error('Simuleret kortfejl (HTTP 503)');
    const g = await super.geocode(address);
    if (!g.found || g.lat == null || g.lng == null) return g;
    return { ...g, lat: this.c.lat + (g.lat - this.c.lat) * this.scale, lng: this.c.lng + (g.lng - this.c.lng) * this.scale };
  }
  override async travelMatrix(o: LatLng[], d: LatLng[]) {
    if (this.failing) throw new Error('Simuleret kortfejl (HTTP 503)');
    return super.travelMatrix(o, d);
  }
}

// ---------------- Chauffør-bot ----------------

interface Step {
  at: number;
  act: () => void;
}

interface DriverBot {
  id: number;
  uid: string;
  name: string;
  vehicleLoc: number;
  pos: LatLng;
  shiftStart: number;
  shiftEnd: number;
  online: boolean;
  onlineSince: number | null;
  onlineMs: number;
  plan: Step[];
  busyWith: string | null;
  decided: Set<number>;
  repDecided: Set<number>;
  doneUnreported: Set<number>;
  waitingSince: number | null;
  silentFrom: number | null;
  silentTo: number | null;
}

export interface SimResult {
  metrics: SimulationMetrics;
  config: Omit<SimConfig, 'onProgress' | 'inspect'>;
  /** Hændelser undervejs (til fejlfinding og dokumentation). */
  log: string[];
}

export async function runDaySimulation(input: SimConfig): Promise<SimResult> {
  const cfg = {
    date: '2026-06-16',
    openHour: 10,
    closeHour: 22,
    failures: true,
    stepSeconds: 30,
    profile: 'standard',
    ...input,
  } as Required<SimConfig>;
  const wallStart = Date.now();
  const [Y, M, D] = cfg.date.split('-').map(Number);
  const openMs = localToUtc(Y, M, D, cfg.openHour, 0, DEFAULT_TZ);
  const closeMs = localToUtc(Y, M, D, cfg.closeHour, 0, DEFAULT_TZ);
  const at = (h: number, m = 0) => localToUtc(Y, M, D, h, m, DEFAULT_TZ);
  let now = openMs - 20 * 60_000;
  clock.set(() => now);
  const log: string[] = [];
  const note = (msg: string) => log.push(`${new Date(now).toISOString().slice(11, 16)}Z ${msg}`);

  const sms = new SimulatedSmsAdapter();
  const tg = new SimulatedTelegramAdapter();
  const maps = new SimMaps({ lat: 55.6761, lng: 12.5683 }, cfg.profile === 'spread' ? 0.8 : 0.5);
  let app: App | null = null;
  try {
    app = await createApp({
      mode: 'demo',
      dbFile: ':memory:',
      backupDir: path.join(os.tmpdir(), 'ai-dispatch-sim'),
      secrets: new MemorySecretStore(),
      manualJobs: true,
      skipSeed: true,
      now: () => now,
      overrides: { sms, telegram: tg, maps, llm: null },
    });
    await app.start();
    app.demo?.stop();
    const ctx = app.ctx;
    const GROUP = 'sim-mgmt-group';
    ctx.settings.update({
      company: { name: 'Simuleret Kiosk ApS (fiktiv)', phone: '+4570000000', timezone: DEFAULT_TZ },
      installation: { automationEnabled: true },
      openingHours: Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: `${String(cfg.openHour).padStart(2, '0')}:00`, close: `${String(cfg.closeHour).padStart(2, '0')}:00`, closed: false }]),
      ) as never,
      pricing: { deliveryFeeOre: 3900, freeDeliveryThresholdOre: 30000, minimumOrderOre: 0 },
      management: { groupChatId: GROUP, allowPrivateChats: false, hourlyReports: true },
      delivery: { requireDriverAcceptance: true, offerTimeoutSeconds: 120 },
      economics: { strategy: cfg.strategy, ...(cfg.adaptive ? { adaptive: { ...DEFAULT_ADAPTIVE, ...cfg.adaptive } } : {}) },
      demo: { autoTraffic: false },
      ...(cfg.legacyRules ? { replenishment: { topUpHorizonMinutes: 0 }, monitoring: { dedupeLinkedDecisions: false } } : {}),
      alternatives: { enabled: !cfg.v041 && !cfg.legacyRules && !cfg.alternativesOff, ...(process.env.SIM_QUEUE ? { queueWithinNormalTime: true } : {}) },
    });
    // Katalog og lager
    const products = new Map<string, number>();
    for (const p of PRODUCTS)
      products.set(p.sku, ctx.catalog.create({ sku: p.sku, name: p.name, category: p.category, priceOre: p.price, costOre: p.cost, synonyms: p.syn, unitVolume: cfg.v041 ? 1 : p.volume }).id);
    const depot = { lat: 55.6815, lng: 12.5545 };
    const central = ctx.inventory.createLocation('Centrallager (simuleret)', 'central', null, depot.lat, depot.lng);
    for (const id of products.values()) ctx.inventory.adjust(central, id, 600, 'simulering', 'system');
    // Ledelse
    const managers = [
      { name: 'Lise (admin, simuleret)', role: 'admin' as const, uid: 'sim-mgr-1' },
      { name: 'Omar (leder, simuleret)', role: 'manager' as const, uid: 'sim-mgr-2' },
    ];
    for (const m of managers) {
      const u = app.management.createUser(m.name, m.role, 'simulering');
      app.management.link(u.linkCode!, m.uid);
    }
    // Chauffører: de fleste hele dagen, to på spidsbelastningsvagter
    const bots: DriverBot[] = [];
    for (let k = 0; k < cfg.drivers; k++) {
      const d = ctx.drivers.create({ name: `Chauffør ${k + 1}`, vehicleName: `Bil ${k + 1}`, maxActiveOrders: 6 });
      const uid = `sim-driver-${d.id}`;
      ctx.db.prepare(`UPDATE drivers SET telegram_user_id = ?, telegram_chat_id = ? WHERE id = ?`).run(uid, uid, d.id);
      ctx.drivers.setStatus(d.id, 'offline');
      const vloc = ctx.drivers.get(d.id)!.vehicleLocationId!;
      for (const sku of cfg.fullVehicleAssortment ? PRODUCTS.map((p) => p.sku) : VEHICLE_SKUS) ctx.inventory.adjust(vloc, products.get(sku)!, 18, 'bil – startlager', 'system');
      if (!cfg.v041) {
        // Fysisk kapacitet (Etape 5): 240 lagerenheder, fryseboks og plads til husholdningsvarer, fast sortiment
        ctx.inventory.setCapacity(vloc, { capacityUnits: 240, categoryCaps: { Is: 12, Husholdning: 24 }, flexUnits: 40 });
        ctx.inventory.setAssortment(vloc, VEHICLE_SKUS.map((sku) => ({ productId: products.get(sku)!, parLevel: 18, maxQty: 24 })));
      }
      const peak = k >= Math.max(2, cfg.drivers - 2);
      const lunch = k % 2 === 0;
      bots.push({
        id: d.id,
        uid,
        name: d.name,
        vehicleLoc: vloc,
        pos: depot,
        shiftStart: peak ? (lunch ? at(11) : at(16, 30)) : openMs,
        shiftEnd: peak ? (lunch ? at(14, 30) : closeMs) : closeMs,
        online: false,
        onlineSince: null,
        onlineMs: 0,
        plan: [],
        busyWith: null,
        decided: new Set(),
        repDecided: new Set(),
        doneUnreported: new Set(),
        waitingSince: null,
        silentFrom: null,
        silentTo: null,
      });
    }
    if (cfg.failures && bots.length >= 3) {
      bots[2].silentFrom = at(18);
      bots[2].silentTo = at(18, 35);
    }
    const tgOutage = cfg.failures ? [at(13, 40), at(13, 52)] : null;
    const mapsOutage = cfg.failures ? [at(16, 10), at(16, 30)] : null;
    let integrationFailures = 0;

    app.agents.logistics.start();
    app.agents.replenishment.start();
    app.agents.reports.start();
    app.agents.monitor.start();

    // ---------------- Hjælpere ----------------
    const timed: Step[] = [];
    const later = (ms: number, act: () => void) => timed.push({ at: now + ms, act });
    const tgPending: (() => void)[] = [];
    const counters = { driveMs: 0, depotDriveMs: 0, mgmtActions: 0, offersIgnored: 0, stockReplies: 0, busyMs: 0, waitRepMs: 0, idleWithStopsMs: 0, revisits: 0, timeOffersSeen: 0 };
    /** Telegram-handling fra en chauffør/leder; under udfald afventer den forbindelsen. */
    const viaTelegram = (fn: () => void) => {
      if (tg.inOutage) tgPending.push(fn);
      else fn();
    };
    const travelMs = (a: LatLng, b: LatLng, r: () => number) => {
      const base = simulatedTravel(a, b, zonedParts(now).hour).durationS * 1000;
      return Math.round(base * (0.9 + r() * 0.3));
    };
    const runJobs = async () => {
      for (let i = 0; i < 30; i++) {
        await ctx.jobs.drain();
        await new Promise((r) => setImmediate(r));
        if (ctx.jobs.tick() === 0) break;
      }
      await ctx.jobs.drain();
    };

    // ---------------- Kunder ----------------
    const planned = planOrders(cfg as never, openMs);
    const byPhone = new Map(planned.map((p) => [p.phone, { p, modified: false, cancelled: false, confirmed: false, answeredQuote: 0, timeOffers: 0 as number | undefined }]));
    let nextOrder = 0;
    let smsIndex = 0;
    const handleSms = () => {
      while (smsIndex < sms.sentLog.length) {
        const m = sms.sentLog[smsIndex++];
        const c = byPhone.get(m.to);
        if (!c) continue;
        const r = keyed(cfg.seed, 'cust', c.p.i, smsIndex);
        if (/Svar JA/i.test(m.text) && !/Passer det dig\?|Passer levering ca\./i.test(m.text)) {
          c.answeredQuote++;
          if (c.p.kind === 'ignore_quote') continue;
          if (c.p.kind === 'decline') {
            later(c.p.replyDelayS * 1000, () => sms.injectInbound(m.to, 'Nej tak, det er for dyrt. Glem det'));
            continue;
          }
          if (c.p.kind === 'modify' && !c.modified) {
            c.modified = true;
            later(c.p.replyDelayS * 1000, () => sms.injectInbound(m.to, `Tilføj også 1 ${c.p.addSku}`));
            continue;
          }
          if (c.answeredQuote > 3) continue;
          later(c.p.replyDelayS * 1000, () => sms.injectInbound(m.to, 'Ja tak'));
        } else if (/Passer det dig\?|Passer levering ca\./i.test(m.text)) {
          // Forslag om senere levering (Etape 5)
          c.timeOffers = (c.timeOffers ?? 0) + 1;
          counters.timeOffersSeen++;
          const rr = keyed(cfg.seed, 'timeoffer', c.p.i, c.timeOffers);
          const x = rr();
          const delay = (30 + Math.floor(rr() * 150)) * 1000;
          const win = m.text.match(/kl\. (\d{2})\.(\d{2})–(\d{2})\.(\d{2})/);
          if (/Passer levering ca\./i.test(m.text)) {
            later(delay, () => sms.injectInbound(m.to, 'Ja'));
          } else if (c.timeOffers >= 2) {
            later(delay, () => sms.injectInbound(m.to, x < 0.8 ? 'Ja, det er fint' : 'Nej, det er for sent'));
          } else if (x < 0.63) {
            later(delay, () => sms.injectInbound(m.to, x < 0.3 ? 'Ja' : 'Det er fint'));
          } else if (x < 0.75 && win) {
            // Ønsker et senere tidspunkt: 30–60 min efter forslaget, på et kvarter
            let h = Number(win[3]);
            let mi = Number(win[4]) + 30 + Math.floor(rr() * 3) * 15;
            h += Math.floor(mi / 60);
            mi %= 60;
            later(delay, () => sms.injectInbound(m.to, `Kan I komme kl. ${String(h % 24).padStart(2, '0')}.${String(mi).padStart(2, '0')}?`));
          } else if (x < 0.83) {
            later(delay, () => sms.injectInbound(m.to, 'Hvad er det tidligste?'));
          } else if (x < 0.93) {
            later(delay, () => sms.injectInbound(m.to, 'Nej, det er for sent'));
          } // ellers svarer kunden ikke
        } else if (/ikke nok af|udsolgt/i.test(m.text)) {
          counters.stockReplies++;
          later(60_000, () => sms.injectInbound(m.to, 'Ok, så annuller'));
        } else if (/bekræftet/i.test(m.text) && !c.confirmed) {
          c.confirmed = true;
          if (c.p.kind === 'cancel_after' && !c.cancelled) {
            c.cancelled = true;
            later((60 + Math.floor(r() * 300)) * 1000, () => sms.injectInbound(m.to, 'Undskyld, annuller min ordre'));
          }
        }
      }
    };

    // ---------------- Ledelse ----------------
    const repHandled = new Set<number>();
    const handleManagement = () => {
      const reps = ctx.db.prepare(`SELECT id FROM replenishments WHERE status = 'awaiting_management'`).all() as { id: number }[];
      for (const { id } of reps) {
        if (repHandled.has(id)) continue;
        repHandled.add(id);
        const r = keyed(cfg.seed, 'rep', id);
        const x = r();
        const mgr = managers[Math.floor(r() * managers.length)];
        if (x < 0.1) {
          note(`Ledelsen reagerer ikke på opfyldning #${id}`);
          continue;
        }
        const action = x < 0.15 ? 'reject' : 'approve';
        later((2 + r() * 6) * 60_000, () =>
          viaTelegram(() => {
            const st = (ctx.db.prepare(`SELECT status FROM replenishments WHERE id = ?`).get(id) as { status: string }).status;
            if (st !== 'awaiting_management') return;
            counters.mgmtActions++;
            tg.injectGroupCallback(GROUP, mgr.uid, mgr.name, `rep:${id}:${action}`);
          }),
        );
      }
    };

    // ---------------- Chauffører ----------------
    const stepMsRef = { v: 30_000 };
    const press = (b: DriverBot, data: string) => viaTelegram(() => tg.injectCallback(b.uid, b.name, data));
    const text = (b: DriverBot, t: string) => viaTelegram(() => tg.injectText(b.uid, b.name, t));
    const silent = (b: DriverBot) => b.silentFrom != null && now >= b.silentFrom && now < b.silentTo!;

    const startDelivery = (b: DriverBot, orderId: number, viaDepot: boolean) => {
      const o = ctx.orders.get(orderId)!;
      if (b.doneUnreported.has(orderId) || o.status === 'delivered') counters.revisits++;
      const dest = { lat: o.addressLat!, lng: o.addressLng! };
      const r = keyed(cfg.seed, 'leg', b.id, orderId);
      let t = now;
      b.busyWith = `ordre #${orderId}`;
      b.plan.push({ at: t, act: () => press(b, `ord:${orderId}:pickup`) });
      if (viaDepot) {
        const toDepot = travelMs(b.pos, depot, r);
        counters.depotDriveMs += toDepot;
        counters.driveMs += toDepot;
        t += toDepot + 3 * 60_000;
        b.pos = depot;
      }
      let leg = travelMs(b.pos, dest, r);
      counters.driveMs += leg;
      if (r() < 0.08) {
        const extra = (8 + Math.floor(r() * 13)) * 60_000;
        if (r() < 0.7) b.plan.push({ at: t + leg / 2, act: () => text(b, `Jeg bliver ${Math.max(5, Math.round(extra / 300_000) * 5)} minutter forsinket`) });
        leg += extra;
      }
      if (leg > 7 * 60_000 && r() < 0.3) b.plan.push({ at: t + leg - 5 * 60_000, act: () => text(b, `Ordre ${orderId}, jeg er der om 5 min`) });
      t += leg;
      const arriveAt = t;
      b.plan.push({
        at: t,
        act: () => {
          arrivals.set(orderId, arriveAt);
          press(b, `ord:${orderId}:arrived`);
        },
      });
      let service = (2 + r() * 2) * 60_000;
      if (r() < 0.04) {
        b.plan.push({ at: t + 3 * 60_000, act: () => press(b, `ord:${orderId}:unreachable`) });
        service += 6 * 60_000;
      }
      t += service;
      b.plan.push({
        at: t,
        act: () => {
          // Fysisk leveret: botten må ikke køre til ordren igen, selv om systemet endnu
          // ikke har behandlet beskeden (rettet i v0.4.1 – botten genbesøgte ordren før)
          b.doneUnreported.add(orderId);
          viaTelegram(() => tg.injectCallback(b.uid, b.name, `ord:${orderId}:delivered`));
        },
      });
      b.plan.push({ at: t, act: () => (b.busyWith = null) });
      counters.busyMs += t - now;
      b.pos = dest;
    };

    const startDepot = (b: DriverBot, repId: number, locationId: number) => {
      const loc = ctx.inventory.location(locationId)!;
      const dest = { lat: loc.lat!, lng: loc.lng! };
      const r = keyed(cfg.seed, 'depot', repId);
      const leg = travelMs(b.pos, dest, r);
      counters.depotDriveMs += leg;
      counters.driveMs += leg;
      b.busyWith = `lager (opfyldning #${repId})`;
      b.plan.push({ at: now + leg, act: () => press(b, `rep:${repId}:arrived`) });
      const pickupMs = ctx.settings.get().replenishment.pickupMinutes * 60_000;
      b.plan.push({ at: now + leg + pickupMs, act: () => press(b, `rep:${repId}:picked_up`) });
      b.plan.push({ at: now + leg + pickupMs, act: () => (b.busyWith = null) });
      b.pos = dest;
    };

    const driverStep = (b: DriverBot) => {
      // Vagt
      if (!b.online && now >= b.shiftStart && now < b.shiftEnd) {
        b.online = true;
        b.onlineSince = now;
        text(b, '/online');
      }
      if (!b.online) return;
      if (silent(b)) return; // telefonen er død, chaufføren holder stille
      // Planlagte handlinger
      while (b.plan.length && b.plan[0].at <= now) b.plan.shift()!.act();
      // Tilbud
      const offers = ctx.db.prepare(`SELECT id, order_id FROM dispatch_offers WHERE driver_id = ? AND status = 'pending'`).all(b.id) as { id: number; order_id: number }[];
      for (const o of offers) {
        if (b.decided.has(o.id) || tg.inOutage) continue;
        b.decided.add(o.id);
        const r = keyed(cfg.seed, 'offer', b.id, o.order_id);
        const x = r();
        if (now >= b.shiftEnd) {
          later(20_000, () => press(b, `offer:${o.id}:reject`));
        } else if (x < 0.04) {
          counters.offersIgnored++;
        } else {
          const action = x < 0.1 ? 'reject' : 'accept';
          later((15 + r() * 75) * 1000, () => press(b, `offer:${o.id}:${action}`));
        }
      }
      // Lagerbesøg
      const reqs = ctx.db.prepare(`SELECT id FROM replenishments WHERE driver_id = ? AND status = 'awaiting_driver'`).all(b.id) as { id: number }[];
      for (const q of reqs) {
        if (b.repDecided.has(q.id) || tg.inOutage) continue;
        b.repDecided.add(q.id);
        const ok = keyed(cfg.seed, 'repdrv', q.id)() < 0.95;
        later(45_000, () => press(b, `rep:${q.id}:${ok ? 'driver_accept' : 'driver_reject'}`));
      }
      if (b.busyWith) return;
      // Næste opgave
      const reps = app!.agents.replenishment.list({ driverId: b.id, activeOnly: true });
      const rep = reps.find((x) => ['en_route', 'awaiting_pickup'].includes(x.status));
      if (rep) {
        const after = rep.afterOrderId ? ctx.orders.get(rep.afterOrderId) : null;
        if (!after || ['delivered', 'cancelled'].includes(after.status) || b.doneUnreported.has(after.id) || after.driverId !== b.id) {
          startDepot(b, rep.id, rep.locationId);
          return;
        }
      }
      const stops = ctx.drivers.routeStops(b.id).filter((s) => ['driver_assigned', 'out_for_delivery'].includes(s.status) && !b.doneUnreported.has(s.orderId));
      if (!stops.length) {
        b.waitingSince = null;
        if (now >= b.shiftEnd && !offers.length && !reps.length) {
          b.online = false;
          b.onlineMs += now - (b.onlineSince ?? now);
          text(b, '/offline');
        }
        return;
      }
      const first = ctx.orders.get(stops[0].orderId)!;
      if (first.stockLocationId === b.vehicleLoc) {
        b.waitingSince = null;
        startDelivery(b, first.id, false);
        return;
      }
      // Varerne ligger ikke i bilen: følg en aktiv opfyldning, ellers hent selv på centrallageret
      const covering = reps.find((x) => x.coversOrders.includes(first.id) && !['picked_up', 'completed'].includes(x.status));
      if (covering) {
        counters.waitRepMs += stepMsRef.v;
        b.waitingSince ??= now;
        if (now - b.waitingSince < 15 * 60_000) return;
        note(`${b.name} venter ikke længere på opfyldning #${covering.id} – henter selv ordre #${first.id} på lageret`);
      }
      b.waitingSince = null;
      startDelivery(b, first.id, true);
    };

    // Chauffører svarer på botten statusforespørgsler (undtagen når telefonen er død)
    tg.outbox.on('sent', (chatId: string, body: string) => {
      const b = bots.find((x) => x.uid === chatId);
      if (!b || !/hvordan går det/i.test(body)) return;
      const r = keyed(cfg.seed, 'status', b.id, Math.floor(now / 600_000));
      later((1 + r() * 3) * 60_000, () => {
        if (silent(b)) return;
        const current = b.busyWith?.match(/#(\d+)/)?.[1];
        const next = b.plan.find((p) => p.at > now);
        const mins = next ? Math.max(1, Math.round((next.at - now) / 60_000)) : 5;
        text(b, current ? `Ordre ${current}, der om ${mins} min` : 'Jeg er klar og venter på næste opgave');
      });
    });

    // ---------------- Hovedløkke ----------------
    const endMs = closeMs + 3 * 3_600_000;
    const stepMs = cfg.stepSeconds * 1000;
    stepMsRef.v = stepMs;
    const firstPromise = new Map<number, number>();
    const promiseKind = new Map<number, 'initial' | 'arrival'>();
    /** Faktisk ankomsttid hos kunden (løftet gælder ankomst, ikke afslutning af afleveringen). */
    const arrivals = new Map<number, number>();
    const promiseCtx = new Map<number, { pos: number; horizon: number; central: boolean }>();
    let lastPct = -1;
    while (now < endMs) {
      now += stepMs;
      // Fejlvinduer
      if (tgOutage) {
        const inside = now >= tgOutage[0] && now < tgOutage[1];
        if (inside !== tg.inOutage) {
          tg.setOutage(inside);
          note(inside ? 'Telegram-udfald starter' : 'Telegram-udfald slutter');
          if (inside) integrationFailures++;
          else while (tgPending.length) tgPending.shift()!();
        }
      }
      if (mapsOutage) {
        const inside = now >= mapsOutage[0] && now < mapsOutage[1];
        if (inside !== maps.failing) {
          maps.failing = inside;
          note(inside ? 'Google Maps-udfald starter' : 'Google Maps-udfald slutter');
          if (inside) integrationFailures++;
        }
      }
      while (nextOrder < planned.length && planned[nextOrder].at <= now) {
        const p = planned[nextOrder++];
        sms.injectInbound(p.phone, p.text);
      }
      timed.sort((a, b) => a.at - b.at);
      while (timed.length && timed[0].at <= now) timed.shift()!.act();
      await runJobs();
      handleSms();
      handleManagement();
      for (const b of bots) driverStep(b);
      await runJobs();
      handleSms();
      for (const r of ctx.db.prepare(`SELECT id, eta_communicated, arrival_soon_sent FROM orders WHERE eta_communicated IS NOT NULL`).all() as { id: number; eta_communicated: string; arrival_soon_sent: number }[]) {
        if (!firstPromise.has(r.id)) {
          firstPromise.set(r.id, new Date(r.eta_communicated).getTime());
          // Løfte givet ved tildeling (planlagt ETA) eller først når chaufføren melder "der om 5 min"
          promiseKind.set(r.id, r.arrival_soon_sent ? 'arrival' : 'initial');
          if (!r.arrival_soon_sent) {
            const o = ctx.orders.get(r.id)!;
            const bot = bots.find((b) => b.id === o.driverId);
            const pos = o.driverId ? ctx.drivers.routeStops(o.driverId).findIndex((x) => x.orderId === r.id) : -1;
            promiseCtx.set(r.id, { pos, horizon: (new Date(r.eta_communicated).getTime() - now) / 60000, central: !!bot && o.stockLocationId !== bot.vehicleLoc });
          }
        }
      }
      const pct = Math.floor(((now - openMs) / (closeMs - openMs)) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        cfg.onProgress?.(Math.min(100, Math.max(0, pct)));
      }
      if (now > closeMs && nextOrder >= planned.length) {
        const open = (
          ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('confirmed','awaiting_driver','driver_assigned','out_for_delivery')`).get() as { c: number }
        ).c;
        const pendingQuotes = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = 'awaiting_confirmation'`).get() as { c: number }).c;
        if (open === 0 && pendingQuotes === 0 && bots.every((b) => !b.busyWith)) break;
      }
    }
    for (const b of bots) if (b.online) b.onlineMs += now - (b.onlineSince ?? now);
    app.agents.reports.syncStatuses();
    const statusCounts = ctx.db.prepare(`SELECT status, COUNT(*) AS c FROM orders GROUP BY status`).all() as { status: string; c: number }[];
    note(`Udnyttelse: kørsel/levering ${Math.round(counters.busyMs / 60000)} min, venter på opfyldning ${Math.round(counters.waitRepMs / 60000)} min, online ${Math.round(bots.reduce((a, b) => a + b.onlineMs, 0) / 60000)} min`);
    note(`Ordrestatus ved dagens slutning: ${statusCounts.map((x) => `${x.status}=${x.c}`).join(', ')}`);
    if (process.env.SIM_DEBUG) {
      const unconfirmed = planned.filter((p) => !byPhone.get(p.phone)!.confirmed).slice(0, Number(process.env.SIM_DEBUG));
      for (const p of unconfirmed) {
        note(`Kunde ${p.phone} (${p.kind}): ${p.text}`);
        for (const m of sms.sentLog.filter((x) => x.to === p.phone)) note(`  → ${m.text.replace(/\n/g, ' | ').slice(0, 200)}`);
      }
    }

    // ---------------- Målinger (fra databasen) ----------------
    const s = ctx.settings.get();
    const tol = s.economics.promiseToleranceMinutes * 60_000;
    const delivered = ctx.db.prepare(`SELECT id, total_ore, delivery_fee_ore, confirmed_at, delivered_at FROM orders WHERE status = 'delivered'`).all() as {
      id: number;
      total_ore: number;
      delivery_fee_ore: number;
      confirmed_at: string;
      delivered_at: string;
    }[];
    const accepted = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE confirmed_at IS NOT NULL`).get() as { c: number }).c;
    const cancelled = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = 'cancelled' AND confirmed_at IS NOT NULL`).get() as { c: number }).c;
    const unresolved = (
      ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE confirmed_at IS NOT NULL AND status NOT IN ('delivered','cancelled')`).get() as { c: number }
    ).c;
    const margin = s.economics.defaultMarginPct;
    const contribution = delivered.reduce((sum, o) => sum + app!.agents.routing.valueOf(o.id, o.delivery_fee_ore, margin).contributionOre, 0);
    const durations = delivered.map((o) => (new Date(o.delivered_at).getTime() - new Date(o.confirmed_at).getTime()) / 60000).sort((a, b) => a - b);
    /** Ankomst hos kunden (løftet gælder ankomst); afleveringen afsluttes 2–4 min senere. */
    const arriveMs = (o: { id: number; delivered_at: string }) => arrivals.get(o.id) ?? new Date(o.delivered_at).getTime();
    const late = delivered.filter((o) => firstPromise.has(o.id) && arriveMs(o) > firstPromise.get(o.id)! + tol).length;
    const planned_extra = ctx.db.prepare(`SELECT plan FROM dispatch_offers WHERE status = 'accepted' AND kind = 'new_order'`).all() as { plan: string }[];
    const plannedExtra = planned_extra.reduce((sum, r) => sum + ((JSON.parse(r.plan)?.analysis?.extraDriveMinutes as number) ?? 0), 0);
    const reps = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM replenishments`).get() as { c: number }).c;
    const repsDone = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM replenishments WHERE status IN ('picked_up','completed')`).get() as { c: number }).c;
    const outOfStockEvents = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE source = 'replenishment' AND type IN ('no_solution','escalated')`).get() as { c: number }).c;
    const alerts = ctx.db.prepare(`SELECT category, COUNT(*) AS c FROM monitor_alerts GROUP BY category`).all() as { category: string; c: number }[];
    const alertCount = (cat: string) => alerts.find((a) => a.category === cat)?.c ?? 0;
    const deadJobs = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'dead'`).get() as { c: number }).c;
    const badSms = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE direction = 'out' AND status IN ('uncertain','failed')`).get() as { c: number }).c;
    const badTg =
      (ctx.db.prepare(`SELECT COUNT(*) AS c FROM driver_messages WHERE direction = 'out' AND status IN ('uncertain','failed')`).get() as { c: number }).c +
      (ctx.db.prepare(`SELECT COUNT(*) AS c FROM management_messages WHERE direction = 'out' AND status IN ('uncertain','failed')`).get() as { c: number }).c;
    const offersBad = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM dispatch_offers WHERE status IN ('rejected','expired')`).get() as { c: number }).c;
    const staffConversations = (
      ctx.db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE ai_mode IN ('ai_paused','manual','integration_error')`).get() as { c: number }
    ).c;
    const reportsSent = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM management_reports WHERE kind = 'hourly' AND status = 'sent'`).get() as { c: number }).c;
    const driverHours = bots.reduce((sum, b) => sum + b.onlineMs, 0) / 3_600_000;
    const hours = (closeMs - openMs) / 3_600_000;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    // ---- Etape 4.1: løfter, ruteændringer, indgreb og lager ----
    const promisedRows = delivered.filter((o) => firstPromise.has(o.id));
    const delayMin = promisedRows.map((o) => Math.max(0, (arriveMs(o) - firstPromise.get(o.id)!) / 60000)).sort((a, b) => a - b);
    const lateMinutes = promisedRows.reduce((sum, o) => sum + Math.max(0, (arriveMs(o) - firstPromise.get(o.id)! - tol) / 60000), 0);
    const slaLate = delivered.filter((o) => new Date(o.delivered_at).getTime() - new Date(o.confirmed_at).getTime() > 60 * 60_000).length;
    const etaChanges = (ctx.db.prepare(`SELECT COALESCE(SUM(eta_updates_sent), 0) AS c FROM orders`).get() as { c: number }).c;
    const acceptedPlans = ctx.db.prepare(`SELECT plan, kind FROM dispatch_offers WHERE status = 'accepted'`).all() as { plan: string; kind: string }[];
    let insertedAhead = 0;
    let disruptive = 0;
    let promisedMoved = 0;
    for (const r of acceptedPlans) {
      const plan = JSON.parse(r.plan) as { insertIndex?: number; sequence?: number[]; analysis?: { maxExistingDelayMinutes?: number; promisedStopsDelayed?: number } } | null;
      if (!plan) continue;
      promisedMoved += plan.analysis?.promisedStopsDelayed ?? 0;
      if (r.kind === 'new_order' && plan.sequence && plan.insertIndex != null && plan.insertIndex < plan.sequence.length - 1) insertedAhead++;
      if ((plan.analysis?.maxExistingDelayMinutes ?? 0) >= 1) disruptive++;
    }
    const routeChangeOffers = acceptedPlans.filter((r) => r.kind === 'route_change').length;
    // Store ordrer (øverste kvartil efter omsætning) mod resten
    const byValue = [...delivered].sort((a, b) => b.total_ore - a.total_ore);
    const topN = Math.max(1, Math.floor(byValue.length / 4));
    const isLate = (o: (typeof delivered)[number]) => firstPromise.has(o.id) && arriveMs(o) > firstPromise.get(o.id)! + tol;
    const share = (arr: typeof delivered) => r1((arr.filter(isLate).length / Math.max(1, arr.length)) * 100);
    // Ledelsesindgreb fordelt på årsag
    const alertRows = ctx.db.prepare(`SELECT rule, alert_key, category FROM monitor_alerts`).all() as { rule: string; alert_key: string; category: string }[];
    const human = alertRows.filter((a) => a.category === 'approval' || a.category === 'takeover');
    const cause = {
      replenishmentDecisions: counters.mgmtActions,
      duplicateOfReplenishment: human.filter((a) => a.rule === 'stock_shortage' || a.alert_key.startsWith('approval_expiring:rep')).length,
      reassignmentSuggestions: human.filter((a) => a.rule === 'promise_risk').length,
      delays: human.filter((a) => a.rule === 'critical_delay').length,
      driverNoResponse: human.filter((a) => a.rule === 'driver_unresponsive').length,
      capacity: human.filter((a) => a.rule === 'capacity_shortage').length,
      integration: human.filter((a) => a.rule === 'integration_failure').length,
      other: human.filter((a) => !['stock_shortage', 'promise_risk', 'critical_delay', 'driver_unresponsive', 'capacity_shortage', 'integration_failure'].includes(a.rule) && !a.alert_key.startsWith('approval_expiring:rep')).length,
    };
    // Reelle beslutninger, en person skal træffe (uden dubletter af samme opfyldningsbeslutning)
    const distinctInterventions = cause.replenishmentDecisions + cause.reassignmentSuggestions + cause.delays + cause.driverNoResponse + cause.capacity + cause.integration + cause.other;
    // Opfyldninger: hvorfor og hvor længe
    const repRows = ctx.db.prepare(`SELECT items, status, sent_at, approved_at FROM replenishments`).all() as { items: string; status: string; sent_at: string | null; approved_at: string | null }[];
    const vehicleIds = new Set(VEHICLE_SKUS.map((x) => products.get(x)!));
    const repCentralOnly = repRows.filter((r) => (JSON.parse(r.items) as { productId: number }[]).some((i) => !vehicleIds.has(i.productId))).length;
    const approvalWaits = repRows.filter((r) => r.sent_at && r.approved_at).map((r) => (new Date(r.approved_at!).getTime() - new Date(r.sent_at!).getTime()) / 60000);
    const openAtEnd = (
      ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE confirmed_at IS NOT NULL AND status IN ('confirmed','awaiting_driver','driver_assigned','out_for_delivery')`).get() as { c: number }
    ).c;
    const needsManual = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE confirmed_at IS NOT NULL AND status = 'needs_manual'`).get() as { c: number }).c;
    // ---- Etape 5: alternative leveringstider, manuelle sager og kapacitet ----
    const offerRows = ctx.db.prepare(`SELECT order_id, status, kind FROM delivery_time_offers`).all() as { order_id: number; status: string; kind: string }[];
    const windowRows = ctx.db
      .prepare(`SELECT id, window_end, status, delivered_at FROM orders WHERE window_end IS NOT NULL`)
      .all() as { id: number; window_end: string; status: string; delivered_at: string | null }[];
    const windowsDelivered = windowRows.filter((o) => o.status === 'delivered');
    const windowsMet = windowsDelivered.filter((o) => arriveMs({ id: o.id, delivered_at: o.delivered_at! }) <= new Date(o.window_end).getTime() + tol).length;
    const manualReasons: Record<string, number> = {};
    for (const r of ctx.db
      .prepare(
        `SELECT (SELECT data FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'needs_manual' ORDER BY e.id DESC LIMIT 1) AS d FROM orders o WHERE o.status = 'needs_manual' AND o.confirmed_at IS NOT NULL`,
      )
      .all() as { d: string | null }[]) {
      const reason = (JSON.parse(r.d ?? '{}') as { reason?: string }).reason ?? 'ukendt';
      manualReasons[reason] = (manualReasons[reason] ?? 0) + 1;
    }
    const capacityLimited = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'capacity_limited'`).get() as { c: number }).c;
    const repsWithDrops = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM replenishments WHERE analysis LIKE '%droppedForCapacity":["%'`).get() as { c: number }).c;
    const metrics: SimulationMetrics = {
      strategy: cfg.strategy,
      profile: cfg.profile,
      orders: cfg.orders,
      drivers: cfg.drivers,
      seed: cfg.seed,
      ordersGenerated: planned.length,
      ordersAccepted: accepted,
      delivered: delivered.length,
      cancelled,
      unresolved,
      revenueOre: delivered.reduce((sum, o) => sum + o.total_ore, 0),
      contributionOre: contribution,
      operatingHours: hours,
      deliveriesPerHour: r1(delivered.length / hours),
      deliveriesPerDriverHour: r1(delivered.length / Math.max(1, driverHours)),
      avgDeliveryMinutes: r1(durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length)),
      p90DeliveryMinutes: r1(durations[Math.floor(durations.length * 0.9)] ?? 0),
      lateShare: r1((late / Math.max(1, delivered.length)) * 100),
      lateCount: late,
      lateMinutes: Math.round(lateMinutes),
      p90DelayMinutes: r1(delayMin[Math.floor(delayMin.length * 0.9)] ?? 0),
      slaLateShare: r1((slaLate / Math.max(1, delivered.length)) * 100),
      etaChanges,
      insertedAhead,
      disruptiveInsertions: disruptive,
      routeChangeOffers,
      promisedStopsMoved: promisedMoved,
      botRevisits: counters.revisits,
      altOffers: offerRows.filter((o) => o.kind !== 'queued').length,
      altOrdersOffered: new Set(offerRows.filter((o) => o.kind !== 'queued').map((o) => o.order_id)).size,
      altAccepted: offerRows.filter((o) => (o.status === 'accepted' || o.status === 'fulfilled') && o.kind !== 'queued').length,
      altQueued: new Set(offerRows.filter((o) => o.kind === 'queued').map((o) => o.order_id)).size,
      altRequestedAccepted: offerRows.filter((o) => (o.status === 'accepted' || o.status === 'fulfilled') && o.kind === 'requested').length,
      altDeclined: offerRows.filter((o) => o.status === 'declined').length,
      altExpired: offerRows.filter((o) => o.status === 'expired').length,
      altSuperseded: offerRows.filter((o) => o.status === 'superseded').length,
      windowOrdersDelivered: windowsDelivered.length,
      windowsMet,
      manualByReason: manualReasons,
      capacityProblems: capacityLimited + repsWithDrops,
      initialPromiseShare: r1((delivered.filter((o) => promiseKind.get(o.id) === 'initial').length / Math.max(1, delivered.length)) * 100),
      lateShareInitialPromise: share(delivered.filter((o) => promiseKind.get(o.id) === 'initial')),
      lateShareHighValue: share(byValue.slice(0, topN)),
      lateShareOtherValue: share(byValue.slice(topN)),
      openAtEnd,
      needsManual,
      waitForReplenishmentMinutes: Math.round(counters.waitRepMs / 60000),
      replenishmentsCentralOnly: repCentralOnly,
      avgApprovalMinutes: r1(approvalWaits.reduce((a, b) => a + b, 0) / Math.max(1, approvalWaits.length)),
      interventionsByCause: cause,
      promiseDiagnostics: (() => {
        const rows = delivered.filter((o) => promiseCtx.has(o.id)).map((o) => ({ ...promiseCtx.get(o.id)!, err: (arriveMs(o) - firstPromise.get(o.id)!) / 60000 }));
        const grp = (f: (x: (typeof rows)[number]) => boolean) => {
          const g = rows.filter(f);
          return { n: g.length, late: r1((g.filter((x) => x.err > s.economics.promiseToleranceMinutes).length / Math.max(1, g.length)) * 100), meanErr: r1(g.reduce((a, x) => a + x.err, 0) / Math.max(1, g.length)) };
        };
        return {
          pos0: grp((x) => x.pos === 0),
          pos1: grp((x) => x.pos === 1),
          pos2plus: grp((x) => x.pos >= 2),
          central: grp((x) => x.central),
          vehicle: grp((x) => !x.central),
          horizonUnder20: grp((x) => x.horizon < 20),
          horizon20to40: grp((x) => x.horizon >= 20 && x.horizon < 40),
          horizon40plus: grp((x) => x.horizon >= 40),
        };
      })(),
      managementInterventionsDistinct: distinctInterventions,
      driveMinutes: Math.round(counters.driveMs / 60000),
      driveMinutesPerDelivery: r1(counters.driveMs / 60000 / Math.max(1, delivered.length)),
      extraDriveMinutes: Math.round(plannedExtra),
      depotDriveMinutes: Math.round(counters.depotDriveMs / 60000),
      stockProblems: reps + counters.stockReplies + outOfStockEvents,
      replenishments: reps,
      replenishmentsCompleted: repsDone,
      managementInterventions: counters.mgmtActions + alertCount('approval') + alertCount('takeover'),
      failedOrUnresolvedActions: deadJobs + badSms + badTg + unresolved,
      offersRejectedOrExpired: offersBad,
      conversationsNeedingStaff: staffConversations,
      integrationFailures,
      hourlyReportsSent: reportsSent,
      alertsRaised: alerts.reduce((a, x) => a + x.c, 0),
      alertsByCategory: { auto: alertCount('auto'), inform: alertCount('inform'), approval: alertCount('approval'), takeover: alertCount('takeover') },
      driverHours: r1(driverHours),
      simulatedEndAt: new Date(now).toISOString(),
      wallClockMs: Date.now() - wallStart,
    };
    cfg.onProgress?.(100);
    cfg.inspect?.(app);
    const { onProgress: _p, inspect: _i, ...config } = cfg;
    void _p;
    void _i;
    return { metrics, config, log };
  } finally {
    if (app) await app.stop();
    clock.reset();
  }
}

// ---------------- Sammenligning ----------------

export const STRATEGIES: DispatchStrategy[] = ['fifo', 'shortest_detour', 'economic', 'adaptive'];

/** Nøgletal der sammenlignes, og om højere eller lavere er bedst. */
export const COMPARED: { key: keyof SimulationMetrics; label: string; better: 'higher' | 'lower'; unit?: string }[] = [
  { key: 'delivered', label: 'Leverede ordrer', better: 'higher' },
  { key: 'revenueOre', label: 'Omsætning', better: 'higher', unit: 'øre' },
  { key: 'contributionOre', label: 'Dækningsbidrag', better: 'higher', unit: 'øre' },
  { key: 'deliveriesPerDriverHour', label: 'Leveringer pr. chaufførtime', better: 'higher' },
  { key: 'avgDeliveryMinutes', label: 'Gns. leveringstid (min)', better: 'lower' },
  { key: 'p90DeliveryMinutes', label: '90 %-fraktil leveringstid (min)', better: 'lower' },
  { key: 'lateShare', label: 'Andel forsinkede (%)', better: 'lower' },
  { key: 'lateMinutes', label: 'Forsinkelsesminutter', better: 'lower' },
  { key: 'p90DelayMinutes', label: 'P90 forsinkelse (min)', better: 'lower' },
  { key: 'etaChanges', label: 'ETA-ændringer til kunder', better: 'lower' },
  { key: 'openAtEnd', label: 'Åbne ved dagens slutning', better: 'lower' },
  { key: 'driveMinutesPerDelivery', label: 'Køretid pr. levering (min)', better: 'lower' },
  { key: 'depotDriveMinutes', label: 'Køretid til lager (min)', better: 'lower' },
  { key: 'stockProblems', label: 'Lagerproblemer', better: 'lower' },
  { key: 'managementInterventionsDistinct', label: 'Ledelsesindgreb', better: 'lower' },
  { key: 'failedOrUnresolvedActions', label: 'Fejlede/uafklarede handlinger', better: 'lower' },
];

export interface StrategyComparison {
  seed: number;
  results: SimulationMetrics[];
  /** Pr. nøgletal: strategi(er) med bedste værdi. */
  best: Record<string, DispatchStrategy[]>;
  /** Nøgletal hvor AI Dispatch (economic) IKKE er bedst. */
  economicNotBest: string[];
  summary: string[];
}

export function compareStrategies(results: SimulationMetrics[]): StrategyComparison {
  const best: Record<string, DispatchStrategy[]> = {};
  const notBest: string[] = [];
  for (const c of COMPARED) {
    const vals = results.map((r) => r[c.key] as number);
    const target = c.better === 'higher' ? Math.max(...vals) : Math.min(...vals);
    best[c.key] = results.filter((r) => (r[c.key] as number) === target).map((r) => r.strategy);
    if (!best[c.key].includes('economic')) notBest.push(c.label);
  }
  const eco = results.find((r) => r.strategy === 'economic');
  const summary: string[] = [];
  if (eco) {
    const n = (x: number) => x.toLocaleString('da-DK', { maximumFractionDigits: 1 });
    for (const other of results.filter((r) => r.strategy !== 'economic')) {
      const d = (eco.contributionOre - other.contributionOre) / 100;
      summary.push(
        `AI Dispatch mod ${DISPATCH_STRATEGY_LABELS[other.strategy]}: dækningsbidrag ${d >= 0 ? '+' : ''}${d.toLocaleString('da-DK', { maximumFractionDigits: 0 })} kr., ` +
          `leverede ${eco.delivered} mod ${other.delivered}, forsinkede ${n(eco.lateShare)} % mod ${n(other.lateShare)} %, gns. leveringstid ${n(eco.avgDeliveryMinutes)} mod ${n(other.avgDeliveryMinutes)} min.`,
      );
    }
    summary.push(notBest.length ? `AI Dispatch er IKKE bedst på: ${notBest.join(', ')}.` : 'AI Dispatch er bedst eller lige så god på alle sammenlignede nøgletal i dette scenarie.');
  }
  return { seed: results[0]?.seed ?? 0, results, best, economicNotBest: notBest, summary };
}

export async function runStrategyComparison(base: Omit<SimConfig, 'strategy'>, strategies = STRATEGIES): Promise<StrategyComparison & { runs: SimResult[] }> {
  const runs: SimResult[] = [];
  for (const strategy of strategies) runs.push(await runDaySimulation({ ...base, strategy }));
  return { ...compareStrategies(runs.map((r) => r.metrics)), runs };
}
