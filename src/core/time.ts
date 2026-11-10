/**
 * Tidszonehjælpere (IANA, fx Europe/Copenhagen) uafhængigt af maskinens
 * egen tidszone. Håndterer sommer-/vintertid via Intl.
 */
export const DEFAULT_TZ = 'Europe/Copenhagen';

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = søndag … 6 = lørdag */
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(ms: number, tz = DEFAULT_TZ): ZonedParts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WD[p.weekday] };
}

/** Tidszonens forskydning fra UTC (ms) på et givent tidspunkt. */
export function tzOffsetMs(ms: number, tz = DEFAULT_TZ): number {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC-tidspunkt for en lokal vægur-tid (første forekomst ved tvetydighed). */
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number, tz = DEFAULT_TZ): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz);
  return ms;
}

/** Lokal midnat (start af døgnet) for tidspunktet. */
export function startOfLocalDay(ms: number, tz = DEFAULT_TZ): number {
  const p = zonedParts(ms, tz);
  return localToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** Starten af den hele (lokale) time, tidspunktet ligger i. */
export function startOfHour(ms: number): number {
  // Alle relevante tidszoner har hele-times-forskydning (inkl. Europe/Copenhagen)
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

export function formatClock(ms: number | string, tz = DEFAULT_TZ): string {
  const d = typeof ms === 'string' ? new Date(ms) : new Date(ms);
  return d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: tz });
}

export function formatLocalDate(ms: number, tz = DEFAULT_TZ): string {
  return new Date(ms).toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
}
