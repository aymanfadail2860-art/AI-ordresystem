import { computeRouteEtas, type EtaAnchor, type EtaParams } from './eta';
import type { EconomicsSettings, PlanningStop } from './routePlanning';
import { formatDkk } from './money';

/**
 * Lagerprognose og valg af opfyldningspunkt (deterministisk).
 *
 * Prognosen går ruten igennem stop for stop: bilens fysiske lager minus hver
 * ordres varebehov, plus planlagte afhentninger. Bliver beholdningen negativ,
 * er der et underskud ved det stop.
 */
export type Qty = Record<number, number>;

export interface ForecastStopInput {
  orderId: number;
  needs: Qty;
}

export interface ForecastResult {
  after: Qty[];
  /** Pr. produkt: manglende antal og første stop-indeks med underskud. */
  shortages: { productId: number; missing: number; firstStopIndex: number }[];
}

export function forecastVehicleStock(start: Qty, stops: ForecastStopInput[], pickups: { afterIndex: number; items: Qty }[]): ForecastResult {
  const stock: Qty = { ...start };
  const after: Qty[] = [];
  const firstShort = new Map<number, number>();
  const missing = new Map<number, number>();
  const add = (items: Qty) => {
    for (const [pid, q] of Object.entries(items)) stock[Number(pid)] = (stock[Number(pid)] ?? 0) + q;
  };
  for (const p of pickups.filter((x) => x.afterIndex < 0)) add(p.items);
  stops.forEach((s, i) => {
    for (const [pidS, need] of Object.entries(s.needs)) {
      const pid = Number(pidS);
      const have = stock[pid] ?? 0;
      if (have < need) {
        if (!firstShort.has(pid)) firstShort.set(pid, i);
        missing.set(pid, (missing.get(pid) ?? 0) + (need - Math.max(0, have)));
      }
      stock[pid] = Math.max(0, have - need);
    }
    after.push({ ...stock });
    for (const p of pickups.filter((x) => x.afterIndex === i)) add(p.items);
  });
  return {
    after,
    shortages: [...missing.entries()].map(([productId, m]) => ({ productId, missing: m, firstStopIndex: firstShort.get(productId)! })),
  };
}

export interface LocationCandidate {
  id: number;
  name: string;
  /** Knudeindeks i køretidsfunktionen. */
  node: number;
  available: Qty;
}

export interface ReplenishmentArgs {
  nowMs: number;
  anchor: EtaAnchor;
  stops: PlanningStop[];
  lockedCount: number;
  /** Afhentning skal ske før dette stop-indeks (første underskud). */
  mustBeBeforeIndex: number;
  need: Qty;
  /** Ordrer der afhænger af opfyldningen – deres løfter kan ikke holdes uden den. */
  coveredOrderIds: number[];
  locations: LocationCandidate[];
  /** Køretid (sek) mellem knuder: -1 = ankerpunkt, 0..n-1 = stop, location.node = lager. */
  travel: (from: number, to: number) => number;
  pickupMinutes: number;
  eta: EtaParams;
  econ: EconomicsSettings;
}

export interface ReplenishmentOptionResult {
  locationId: number;
  locationName: string;
  afterIndex: number;
  afterOrderId: number | null;
  feasible: boolean;
  violations: string[];
  extraDriveMinutes: number;
  pickupMinutes: number;
  maxDelayMinutes: number;
  delays: { orderId: number; minutes: number }[];
  costOre: number;
  lateRiskMinutes: number;
  deliveriesPerHour: number;
  /** Tidspunkt hvor chaufføren senest forlader stoppet før lagerbesøget. */
  safeUntilMs: number;
  explanation: string[];
}

const weight = (c: number, e: EconomicsSettings) => 1 + Math.max(0, c) / Math.max(1, e.valueWeightScaleOre);

/**
 * Vurdér alle mulige opfyldningspunkter (efter stop k) og lagerlokationer.
 * Hård begrænsning: afhentningen skal ske før første underskud, lageret skal
 * have varerne, og givne leveringsløfter må ikke brydes ud over tolerancen.
 */
export function evaluateReplenishmentOptions(a: ReplenishmentArgs): ReplenishmentOptionResult[] {
  const n = a.stops.length;
  const e = a.econ;
  const legBase = (i: number) => a.travel(i === 0 ? -1 : i - 1, i);
  const etaStops = a.stops.map((s) => ({ orderId: s.orderId, extraDelayMs: s.extraDelayMs }));
  const baseline = computeRouteEtas(a.nowMs, a.anchor, etaStops, legBase, a.eta);
  const results: ReplenishmentOptionResult[] = [];
  // k = -1: før første stop. Et låst stop kan kun springes over, hvis underskuddet er ved det.
  const firstK = a.lockedCount > 0 && a.mustBeBeforeIndex > 0 ? a.lockedCount - 1 : -1;
  for (const loc of a.locations) {
    const shortOf = Object.entries(a.need).filter(([pid, q]) => (loc.available[Number(pid)] ?? 0) < q);
    for (let k = firstK; k < Math.min(a.mustBeBeforeIndex, n); k++) {
      const prevNode = k;
      const nextIdx = k + 1;
      const leg = (i: number) => {
        if (i === nextIdx) return a.travel(prevNode === -1 ? -1 : prevNode, loc.node) + a.pickupMinutes * 60 + a.travel(loc.node, i);
        return legBase(i);
      };
      // Hvis driver_report-ankeret gælder stop 0 og k = -1, må tiden til stop 0 ikke bruge ankeret direkte
      const anchor = k === -1 && a.anchor.kind === 'driver_report' ? { ...a.anchor, kind: 'start' as const, atMs: a.nowMs } : a.anchor;
      const etas = computeRouteEtas(a.nowMs, anchor, etaStops, leg, a.eta);
      const directS = nextIdx < n ? a.travel(prevNode === -1 ? -1 : prevNode, nextIdx) : 0;
      const viaS = a.travel(prevNode === -1 ? -1 : prevNode, loc.node) + (nextIdx < n ? a.travel(loc.node, nextIdx) : 0);
      const extraDriveMin = Math.max(0, (viaS - directS) / 60);
      const violations: string[] = [];
      if (shortOf.length) violations.push(`${loc.name} har ikke nok på lager`);
      let waitCost = 0;
      let late = 0;
      let maxDelay = 0;
      let disrupted = 0;
      const delays: { orderId: number; minutes: number }[] = [];
      for (let i = 0; i < n; i++) {
        const d = (etas[i].etaMs - baseline[i].etaMs) / 60000;
        if (d > 0.5) {
          delays.push({ orderId: a.stops[i].orderId, minutes: Math.round(d) });
          disrupted++;
          maxDelay = Math.max(maxDelay, d);
          const w = weight(a.stops[i].value.contributionOre, e) * ((a.stops[i] as PlanningStop & { priority?: number }).priority ? e.priorityWeight : 1);
          waitCost += e.waitCostPerMinuteOre * w * d;
        }
        const p = a.stops[i].promisedMs;
        if (p) {
          const over = (etas[i].etaMs - p) / 60000;
          if (over > 0) late += over;
          if (over > e.promiseToleranceMinutes && d > 0.5 && !a.coveredOrderIds.includes(a.stops[i].orderId)) violations.push(`Ordre #${a.stops[i].orderId} ville blive ${Math.round(over)} min senere end lovet`);
        }
      }
      const pickupCost = e.driveCostPerMinuteOre * (extraDriveMin + a.pickupMinutes);
      const risk = e.riskPenaltyPerMinuteOre * (etas[n - 1]?.uncertaintyMinutes ?? 0);
      const cost = Math.round(pickupCost + waitCost + e.disruptionCostOre * disrupted + e.latePenaltyPerMinuteOre * late + risk);
      const hours = Math.max(0.25, ((etas[n - 1]?.etaMs ?? a.nowMs) - a.nowMs) / 3600000);
      // Sidste sikre beslutning: før første stop = når chaufføren skal køre mod stop 1; ellers når stop k er afsluttet
      const safeUntilMs = k === -1 ? Math.max(a.nowMs, n ? baseline[0].etaMs - a.travel(-1, 0) * 1000 : a.nowMs) : baseline[k].etaMs + a.eta.serviceMinutes * 60000;
      results.push({
        locationId: loc.id,
        locationName: loc.name,
        afterIndex: k,
        afterOrderId: k >= 0 ? a.stops[k].orderId : null,
        feasible: violations.length === 0,
        violations,
        extraDriveMinutes: Math.round(extraDriveMin * 10) / 10,
        pickupMinutes: a.pickupMinutes,
        maxDelayMinutes: Math.round(maxDelay),
        delays,
        costOre: cost,
        lateRiskMinutes: Math.round(late),
        deliveriesPerHour: Math.round((n / hours) * 10) / 10,
        safeUntilMs,
        explanation: [
          `${k === -1 ? 'Før første stop' : `Efter stop ${k + 1} (ordre #${a.stops[k].orderId})`} på ${loc.name}`,
          `Ekstra køretid ${extraDriveMin.toFixed(1)} min + afhentning ${a.pickupMinutes} min`,
          disrupted ? `${disrupted} levering(er) rykkes op til ${Math.round(maxDelay)} min` : 'Ingen leveringer rykkes',
          `Driftsomkostning ca. ${formatDkk(cost)}`,
          ...violations.map((v) => `Afvist: ${v}`),
        ],
      });
    }
  }
  return results.sort((x, y) => Number(y.feasible) - Number(x.feasible) || x.costOre - y.costOre);
}
