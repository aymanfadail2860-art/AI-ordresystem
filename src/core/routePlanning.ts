import { computeRouteEtas, type EtaAnchor, type EtaParams, type StopEta } from './eta';
import { formatDkk } from './money';
import type { DecisionAnalysis, Settings } from '../shared/types';

/**
 * Økonomisk beslutningsmodel for ruteplanlægning (deterministisk).
 *
 * Mål (højere er bedre), alle beløb i øre:
 *   score = dækningsbidrag(ny ordre)
 *         − kørselsomkostning × ekstra køretid
 *         − ventetidsomkostning × værdivægt × ventetid (ny ordre)
 *         − Σ ventetidsomkostning × værdivægt × ekstra ventetid (eksisterende kunder)
 *         − forstyrrelsesomkostning pr. eksisterende kunde, der rykkes
 *         − forsinkelsesstraf × minutter over givne løfter (inden for tolerance)
 *         − risikostraf × ETA-usikkerhed
 *         − omfordelingsomkostning (hvis ordren flyttes fra en anden chauffør)
 *         + nærhedsbonus (ny ordre ligger tæt på et eksisterende stop)
 *
 * HÅRDE begrænsninger (gør en løsning ugyldig – overstyres aldrig af omsætning):
 *   - et eksisterende leveringsløfte må ikke overskrides med mere end tolerancen
 *     (og en allerede sen levering må ikke blive yderligere forsinket)
 *   - den nye ordre skal kunne leveres inden for maks. leveringstid
 *   - stop, chaufføren allerede er på vej til, kan ikke flyttes (låste stop)
 * Lager og kapacitet kontrolleres af kalderen, før en chauffør overhovedet vurderes.
 */
export type EconomicsSettings = Settings['economics'];

export interface OrderValue {
  revenueOre: number;
  contributionOre: number;
  contributionEstimated: boolean;
}

/** Omsætning og dækningsbidrag. Bruger registreret vareomkostning; ellers standard-avance. */
export function orderValue(
  lines: { quantity: number; unitPriceOre: number; costOre: number | null }[],
  deliveryFeeOre: number,
  defaultMarginPct: number,
): OrderValue {
  let contribution = deliveryFeeOre;
  let revenue = deliveryFeeOre;
  let estimated = false;
  for (const l of lines) {
    revenue += l.quantity * l.unitPriceOre;
    if (l.costOre != null) contribution += l.quantity * (l.unitPriceOre - l.costOre);
    else {
      estimated = true;
      contribution += Math.round((l.quantity * l.unitPriceOre * defaultMarginPct) / 100);
    }
  }
  return { revenueOre: revenue, contributionOre: contribution, contributionEstimated: estimated };
}

export interface PlanningStop {
  orderId: number;
  promisedMs: number | null;
  extraDelayMs: number;
  value: OrderValue;
  /** > 0 = prioriteret af ledelsen (højere ventetidsvægt). */
  priority?: number;
}

export interface InsertionArgs {
  nowMs: number;
  anchor: EtaAnchor;
  existing: PlanningStop[];
  /** Antal stop forrest i ruten, der ikke må flyttes (fx stop chaufføren er på vej til). */
  lockedCount: number;
  newOrder: { orderId: number; value: OrderValue; priority?: number };
  /**
   * Køretid i sekunder mellem knuder: -1 = ankerpunkt, 0..n-1 = eksisterende stop,
   * n = den nye ordre. Kalderen indregner fx afhentning på centrallager i ben til n.
   */
  travel: (from: number, to: number) => number;
  eta: EtaParams;
  econ: EconomicsSettings;
  reassignment: boolean;
}

export interface InsertionResult {
  insertIndex: number;
  feasible: boolean;
  violations: string[];
  /** Ordre-id'er i ny rækkefølge. */
  sequence: number[];
  etas: StopEta[];
  baseline: StopEta[];
  analysis: DecisionAnalysis;
}

function sequenceEtas(args: InsertionArgs, nodes: number[]): StopEta[] {
  const n = args.existing.length;
  const stops = nodes.map((node) =>
    node === n ? { orderId: args.newOrder.orderId, extraDelayMs: 0 } : { orderId: args.existing[node].orderId, extraDelayMs: args.existing[node].extraDelayMs },
  );
  return computeRouteEtas(args.nowMs, args.anchor, stops, (i) => args.travel(i === 0 ? -1 : nodes[i - 1], nodes[i]), args.eta);
}

const weight = (v: OrderValue, e: EconomicsSettings, priority = 0) =>
  (1 + Math.max(0, v.contributionOre) / Math.max(1, e.valueWeightScaleOre)) * (priority > 0 ? e.priorityWeight || 1 : 1);

export function evaluateInsertions(args: InsertionArgs): InsertionResult[] {
  const e = args.econ;
  const n = args.existing.length;
  const locked = Math.min(n, Math.max(args.lockedCount, args.anchor.kind === 'driver_report' && n > 0 ? 1 : 0));
  const baseNodes = args.existing.map((_, i) => i);
  const baseline = sequenceEtas(args, baseNodes);
  const baseDriveS = baseline.reduce((s, x) => s + x.driveSeconds, 0);
  const results: InsertionResult[] = [];

  for (let k = locked; k <= n; k++) {
    const nodes = [...baseNodes.slice(0, k), n, ...baseNodes.slice(k)];
    const etas = sequenceEtas(args, nodes);
    const driveS = etas.reduce((s, x) => s + x.driveSeconds, 0);
    const extraDriveMin = Math.max(0, (driveS - baseDriveS) / 60);
    const newEta = etas[k];
    const newEtaMin = (newEta.etaMs - args.nowMs) / 60000;
    const violations: string[] = [];
    const explanation: string[] = [];

    let existingWaitCost = 0;
    let lateMinutes = 0;
    let maxDelay = 0;
    let disrupted = 0;
    for (let i = 0; i < n; i++) {
      const stop = args.existing[i];
      const before = baseline[i].etaMs;
      const after = etas[i < k ? i : i + 1].etaMs;
      const delayMin = (after - before) / 60000;
      if (delayMin > 0.5) {
        disrupted++;
        maxDelay = Math.max(maxDelay, delayMin);
        existingWaitCost += e.waitCostPerMinuteOre * weight(stop.value, e, stop.priority) * delayMin;
      }
      if (stop.promisedMs) {
        const overMin = (after - stop.promisedMs) / 60000;
        if (overMin > 0) lateMinutes += overMin;
        if (overMin > e.promiseToleranceMinutes && delayMin > 0.5) {
          violations.push(`Ordre #${stop.orderId} ville blive leveret ${Math.round(overMin)} min efter det lovede tidspunkt`);
        }
      }
    }
    if (newEtaMin > e.maxDeliveryMinutes) violations.push(`Ny ordre kan først leveres om ${Math.round(newEtaMin)} min (maks. ${e.maxDeliveryMinutes})`);

    // Nærhed: ligger den nye ordre tæt på et eksisterende stop i ruten?
    const prevNode = k === 0 ? -1 : nodes[k - 1];
    const nextNode = k < n ? nodes[k + 1] : null;
    const nearMin = Math.min(prevNode >= 0 ? args.travel(prevNode, n) / 60 : Infinity, nextNode !== null ? args.travel(n, nextNode) / 60 : Infinity);
    const nearby = nearMin <= e.nearbyThresholdMinutes;

    const v = args.newOrder.value;
    const contribution = v.contributionOre;
    const driveCost = e.driveCostPerMinuteOre * extraDriveMin;
    const newWaitCost = e.waitCostPerMinuteOre * weight(v, e, args.newOrder.priority) * Math.max(0, newEtaMin);
    const latePenalty = e.latePenaltyPerMinuteOre * lateMinutes;
    const riskPenalty = e.riskPenaltyPerMinuteOre * newEta.uncertaintyMinutes;
    const disruption = e.disruptionCostOre * disrupted;
    const reassign = args.reassignment ? e.reassignmentCostOre : 0;
    const bonus = nearby ? e.nearbyBonusOre : 0;
    const score = Math.round(contribution - driveCost - newWaitCost - existingWaitCost - disruption - latePenalty - riskPenalty - reassign + bonus);

    const routeRevenue = args.existing.reduce((s, x) => s + x.value.revenueOre, 0) + v.revenueOre;
    const routeContribution = args.existing.reduce((s, x) => s + x.value.contributionOre, 0) + v.contributionOre;
    const lastEta = etas[etas.length - 1].etaMs;
    const routeHours = Math.max(0.25, (lastEta - args.nowMs) / 3600000);

    explanation.push(
      `Dækningsbidrag ${formatDkk(contribution)}${v.contributionEstimated ? ' (estimeret)' : ''} af omsætning ${formatDkk(v.revenueOre)}`,
      `Ekstra køretid ${extraDriveMin.toFixed(1)} min (≈ ${formatDkk(Math.round(driveCost))})`,
      `Levering om ca. ${Math.round(newEtaMin)} min (±${newEta.uncertaintyMinutes} min)`,
    );
    if (disrupted) explanation.push(`${disrupted} eksisterende levering(er) rykkes op til ${Math.round(maxDelay)} min`);
    if (nearby) explanation.push(`Ligger ${nearMin.toFixed(0)} min fra et eksisterende stop – effektiv indsættelse`);
    if (args.reassignment) explanation.push(`Omfordelingsomkostning ${formatDkk(reassign)}`);
    if (lateMinutes > 0) explanation.push(`${Math.round(lateMinutes)} min samlet over givne løfter`);

    results.push({
      insertIndex: k,
      feasible: violations.length === 0,
      violations,
      sequence: nodes.map((node) => (node === n ? args.newOrder.orderId : args.existing[node].orderId)),
      etas,
      baseline,
      analysis: {
        score,
        revenueOre: v.revenueOre,
        contributionOre: contribution,
        contributionEstimated: v.contributionEstimated,
        extraDriveMinutes: Math.round(extraDriveMin * 10) / 10,
        newOrderEtaMinutes: Math.round(newEtaMin),
        routeRevenueOre: routeRevenue,
        routeContributionOre: routeContribution,
        routeDriveMinutes: Math.round(driveS / 60),
        deliveriesPerHour: Math.round(((n + 1) / routeHours) * 10) / 10,
        maxExistingDelayMinutes: Math.round(maxDelay),
        lateRiskMinutes: Math.round(lateMinutes + newEta.uncertaintyMinutes),
        reassignmentCostOre: reassign,
        nearby,
        significantChange: k < n && maxDelay >= e.significantChangeMinutes,
        explanation: [...explanation, ...violations.map((x) => `Afvist: ${x}`)],
      },
    });
  }
  return results.sort((a, b) => Number(b.feasible) - Number(a.feasible) || b.analysis.score - a.analysis.score);
}

export interface SequenceEvaluation {
  sequence: number[];
  feasible: boolean;
  violations: string[];
  /** Samlet omkostning (øre) – lavere er bedre. */
  costOre: number;
  driveMinutes: number;
  etas: Record<number, number>;
}

/**
 * Evaluér en bestemt rækkefølge af ruten (til "find en bedre rute" og
 * prioritering). Omkostning = kørsel + værdivægtet ventetid + forsinkelse ud
 * over løfter. Hårdt: et givet løfte må ikke brydes ud over tolerancen, hvis
 * stoppet bliver senere end i den nuværende plan.
 */
export function evaluateSequence(
  args: Omit<InsertionArgs, 'newOrder' | 'reassignment' | 'lockedCount'>,
  order: number[],
  baselineEtas?: Record<number, number>,
): SequenceEvaluation {
  const e = args.econ;
  const byId = new Map(args.existing.map((s, i) => [s.orderId, { s, node: i }]));
  const nodes = order.map((id) => byId.get(id)!.node);
  const stops = order.map((id) => ({ orderId: id, extraDelayMs: byId.get(id)!.s.extraDelayMs }));
  const etas = computeRouteEtas(args.nowMs, args.anchor, stops, (i) => args.travel(i === 0 ? -1 : nodes[i - 1], nodes[i]), args.eta);
  let cost = 0;
  let late = 0;
  const violations: string[] = [];
  const driveS = etas.reduce((a, x) => a + x.driveSeconds, 0);
  etas.forEach((x, i) => {
    const s = byId.get(order[i])!.s;
    const waitMin = Math.max(0, (x.etaMs - args.nowMs) / 60000);
    cost += e.waitCostPerMinuteOre * weight(s.value, e, s.priority) * waitMin;
    if (s.promisedMs) {
      const over = (x.etaMs - s.promisedMs) / 60000;
      if (over > 0) late += over;
      const before = baselineEtas?.[s.orderId];
      if (over > e.promiseToleranceMinutes && (before === undefined || x.etaMs > before + 30000)) {
        violations.push(`Ordre #${s.orderId} ville blive ${Math.round(over)} min senere end lovet`);
      }
    }
  });
  cost += e.driveCostPerMinuteOre * (driveS / 60) + e.latePenaltyPerMinuteOre * late;
  return {
    sequence: order,
    feasible: violations.length === 0,
    violations,
    costOre: Math.round(cost),
    driveMinutes: Math.round(driveS / 60),
    etas: Object.fromEntries(etas.map((x) => [x.orderId, x.etaMs])),
  };
}

/** Find den bedste rækkefølge af de ulåste stop (udtømmende op til 7 stop, ellers grådig + 2-opt). */
export function optimizeSequence(args: Omit<InsertionArgs, 'newOrder' | 'reassignment'>): { current: SequenceEvaluation; best: SequenceEvaluation } {
  const ids = args.existing.map((s) => s.orderId);
  const locked = ids.slice(0, Math.min(args.lockedCount, ids.length));
  const free = ids.slice(locked.length);
  const current = evaluateSequence(args, ids);
  let best = current;
  const consider = (seq: number[]) => {
    const ev = evaluateSequence(args, seq, current.etas);
    if (ev.feasible && (ev.costOre < best.costOre || !best.feasible)) best = ev;
  };
  if (free.length <= 7) {
    const permute = (arr: number[], prefix: number[] = []) => {
      if (!arr.length) return consider([...locked, ...prefix]);
      arr.forEach((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)], [...prefix, x]));
    };
    permute(free);
  } else {
    let seq = [...free];
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < seq.length - 1; i++) {
        for (let j = i + 1; j < seq.length; j++) {
          const cand = [...seq.slice(0, i), ...seq.slice(i, j + 1).reverse(), ...seq.slice(j + 1)];
          const before = best.costOre;
          consider([...locked, ...cand]);
          if (best.costOre < before) {
            seq = cand;
            improved = true;
          }
        }
      }
    }
  }
  return { current, best };
}
