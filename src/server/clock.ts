/**
 * Fælles ur for backend. I drift er det systemets ur. Driftssimuleringen
 * (kører i sin egen worker/proces) sætter et virtuelt ur, så en hel
 * arbejdsdag kan afvikles på få sekunder – deterministisk.
 */
let source: () => number = () => Date.now();

export const clock = {
  now(): number {
    return source();
  },
  date(): Date {
    return new Date(source());
  },
  iso(): string {
    return new Date(source()).toISOString();
  },
  /** Kun til simulering/tests. */
  set(fn: () => number): void {
    source = fn;
  },
  reset(): void {
    source = () => Date.now();
  },
};
