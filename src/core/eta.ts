import type { EtaConfidence } from '../shared/types';

/**
 * ETA-motor (deterministisk). Der bruges INGEN live-GPS.
 *
 * Udgangspunktet ("ankeret") for en chaufførs rute er den nyeste pålidelige
 * kendsgerning:
 *  - driver_report: chaufføren har meldt "jeg er ved ordre X om N min" → ankomsttid til X
 *  - delivered:     seneste bekræftede levering → afgang fra den adresse på det tidspunkt
 *  - start:         tildeling/afgang fra senest kendte stop eller centrallager
 *
 * Efterfølgende stop: forrige ETA + servicetid + køretid (kortleverandør) +
 * eventuelle meldte forsinkelser + historisk tillæg. Usikkerheden vokser med
 * antal stop og med tiden siden chaufførens seneste status.
 */
export interface EtaAnchor {
  kind: 'driver_report' | 'delivered' | 'start';
  /** driver_report: forventet ankomst til `orderId`. delivered/start: afgangstidspunkt. */
  atMs: number;
  /** Seneste tidspunkt med frisk information fra chaufføren/systemet. */
  reportedAtMs: number;
  orderId: number | null;
}

export interface EtaStopInput {
  orderId: number;
  /** Meldt ekstra forsinkelse ved dette stop (ms) – lægges til og forplanter sig. */
  extraDelayMs: number;
}

export interface EtaParams {
  serviceMinutes: number;
  /** Status ældre end dette → lav sikkerhed (må ikke loves til kunder). */
  staleMinutes: number;
  /** Historisk tillæg pr. kørselsben (minutter, ≥ 0). */
  biasMinutes: number;
}

export interface StopEta {
  orderId: number;
  etaMs: number;
  lowMs: number;
  highMs: number;
  /** ± usikkerhed i minutter (øvre). */
  uncertaintyMinutes: number;
  confidence: EtaConfidence;
  basis: string;
  overdue: boolean;
  driveSeconds: number;
}

/** Køretid i sekunder for benet frem til stop i (fra forrige stop eller ankerpunktet). */
export type LegFn = (stopIndex: number) => number;

const BASE_UNCERTAINTY: Record<EtaAnchor['kind'], number> = { driver_report: 2, delivered: 4, start: 8 };

export function computeRouteEtas(nowMs: number, anchor: EtaAnchor, stops: EtaStopInput[], leg: LegFn, p: EtaParams): StopEta[] {
  const ageMin = Math.max(0, (nowMs - anchor.reportedAtMs) / 60000);
  const stale = ageMin > p.staleMinutes;
  const out: StopEta[] = [];
  let prev = 0;
  let overdueSeen = false;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    let t: number;
    let basis: string;
    let driveS = 0;
    if (i === 0 && anchor.kind === 'driver_report' && anchor.orderId === s.orderId) {
      t = anchor.atMs + s.extraDelayMs;
      basis = 'Chaufførens melding';
    } else if (i === 0) {
      driveS = leg(0);
      t = anchor.atMs + driveS * 1000 + p.biasMinutes * 60000 + s.extraDelayMs;
      basis = anchor.kind === 'delivered' ? 'Seneste levering + køretid' : 'Planlagt afgang + køretid';
    } else {
      driveS = leg(i);
      t = prev + p.serviceMinutes * 60000 + driveS * 1000 + p.biasMinutes * 60000 + s.extraDelayMs;
      basis = 'Forrige stop + køretid';
    }
    // Er tidspunktet passeret uden levering, ved vi ikke hvor chaufføren er → opdigt ikke en tid
    let overdue = false;
    if (t < nowMs) {
      overdue = true;
      overdueSeen = true;
      t = nowMs;
      basis += ' (overskredet – afventer status)';
    }
    let unc = BASE_UNCERTAINTY[anchor.kind] + 2 * i;
    if (stale) unc += 5 + (ageMin - p.staleMinutes) / 2;
    if (overdue || overdueSeen) unc += 10;
    const confidence: EtaConfidence = stale || overdue || overdueSeen ? 'low' : unc <= 5 ? 'high' : unc <= 12 ? 'medium' : 'low';
    out.push({
      orderId: s.orderId,
      etaMs: t,
      lowMs: t - Math.round(unc * 0.5 * 60000),
      highMs: t + Math.round(unc * 60000),
      uncertaintyMinutes: Math.round(unc),
      confidence,
      basis: stale ? `${basis} · status forældet (${Math.round(ageMin)} min)` : basis,
      overdue,
      driveSeconds: driveS,
    });
    prev = t;
  }
  return out;
}

/**
 * Historisk tillæg: gennemsnitlig forsinkelse (min) for tidligere leveringer i
 * forhold til den ETA, kunden fik oplyst. Kun positive forsinkelser tæller;
 * resultatet begrænses til [0, max].
 */
export function historicalBias(samples: { promisedMs: number; deliveredMs: number }[], maxMinutes: number): number {
  if (samples.length < 5) return 0;
  const delays = samples.map((s) => (s.deliveredMs - s.promisedMs) / 60000);
  const avg = delays.reduce((a, b) => a + Math.max(0, b), 0) / delays.length;
  return Math.max(0, Math.min(maxMinutes, Math.round(avg * 10) / 10));
}

/** ETA må kun kommunikeres til kunder, hvis den bygger på friske og pålidelige data. */
export function etaCommunicable(confidence: EtaConfidence | null, quality: 'live' | 'simulated' | 'fallback', mode: 'demo' | 'production'): boolean {
  if (!confidence || confidence === 'low') return false;
  if (quality === 'fallback') return false;
  if (quality === 'simulated' && mode !== 'demo') return false;
  return true;
}
