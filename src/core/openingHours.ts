import type { OpeningHoursDay } from '../shared/types';

const KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof KEYS)[number];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Afgør om virksomheden har åbent på et givent tidspunkt (lokal tid).
 * Understøtter åbningstider over midnat (fx 18:00–03:00).
 */
export function isOpen(hours: Record<DayKey, OpeningHoursDay>, at: Date): boolean {
  const day = KEYS[at.getDay()];
  const prevDay = KEYS[(at.getDay() + 6) % 7];
  const minutes = at.getHours() * 60 + at.getMinutes();
  const today = hours[day];
  if (today && !today.closed) {
    const o = toMinutes(today.open);
    const c = toMinutes(today.close);
    if (c > o) {
      if (minutes >= o && minutes < c) return true;
    } else if (minutes >= o) {
      return true; // åbnet i dag, lukker efter midnat
    }
  }
  const prev = hours[prevDay];
  if (prev && !prev.closed) {
    const o = toMinutes(prev.open);
    const c = toMinutes(prev.close);
    if (c <= o && minutes < c) return true; // fortsat fra i går
  }
  return false;
}
