import { DEFAULT_TZ, localToUtc, zonedParts } from './time';

export type TimeReplyKind = 'accept' | 'decline' | 'request' | 'earliest' | 'unclear';

export interface TimeReply {
  kind: TimeReplyKind;
  /** Ønsket tidspunkt (ms), når kunden foreslår et klokkeslæt. */
  requestedMs?: number;
}

const normalize = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Deterministisk fortolkning af kundens svar på et foreslået leveringstidspunkt.
 * Bruges før (og uafhængigt af) AI-fortolkningen, så tider og ja/nej aldrig gættes
 * af en sprogmodel. Ukendt → 'unclear' (systemet spørger igen eller giver til en medarbejder).
 */
export function parseTimeReply(text: string, nowMs: number, tz = DEFAULT_TZ): TimeReply {
  const t = normalize(text);
  const time = parseClock(t, nowMs, tz);
  if (/(tidligst|tidligere|hurtigere|før det|hurtigst)/.test(t)) return { kind: 'earliest' };
  if (time !== undefined) {
    if (time === null) return { kind: 'unclear' };
    return { kind: 'request', requestedMs: time };
  }
  if (/\b(nej|nope|for sent|for sen|kan ikke|passer ikke|passer mig ikke|dur ikke|går ikke|glem det|annuller|ikke interesseret)\b/.test(t)) return { kind: 'decline' };
  if (/^(ja|jep|jo|yes|ok|okay|fint|det er fint|det passer|passer|perfekt|super|gerne|lyder godt|helt fint|fedt|top)\b/.test(t) || /\b(det er fint|det passer fint|det passer|helt i orden)\b/.test(t))
    return { kind: 'accept' };
  return { kind: 'unclear' };
}

/**
 * Find et klokkeslæt i teksten ("kl. 22", "kl 21.30", "21:45", "kl. 9" om aftenen).
 * undefined = intet klokkeslæt nævnt; null = nævnt men ikke brugbart (fx forbi).
 */
export function parseClock(t: string, nowMs: number, tz = DEFAULT_TZ): number | null | undefined {
  const m = t.match(/\bkl\.?\s*(\d{1,2})(?:[.:](\d{2}))?\b/) ?? t.match(/\b(\d{1,2})[.:](\d{2})\b/);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h > 23 || min > 59) return null;
  const p = zonedParts(nowMs, tz);
  const at = (hh: number) => localToUtc(p.year, p.month, p.day, hh, min, tz);
  let ms = at(h);
  // "kl. 9" om aftenen betyder kl. 21
  if (ms < nowMs - 5 * 60000 && h < 12) {
    h += 12;
    ms = at(h);
  }
  if (ms < nowMs - 5 * 60000) return null;
  return ms;
}

/** Afrund op til nærmeste kvarter. */
export function ceilToQuarter(ms: number): number {
  const q = 15 * 60000;
  return Math.ceil(ms / q) * q;
}
