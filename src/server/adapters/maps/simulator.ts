import { createHash } from 'node:crypto';
import { zonedParts } from '../../../core/time';
import { haversineMeters, type LatLng } from '../../../core/geo';
import type { GeocodeResult, MapsAdapter, TravelEstimate } from './types';
import { clock } from '../../clock';

/** Simuleret køretid: luftlinje × 1,35, 28 km/t, myldretidstillæg (lokal time) + 1 min. */
export function simulatedTravel(o: LatLng, d: LatLng, localHour: number): TravelEstimate {
  const traffic = localHour >= 15 && localHour < 18 ? 1.35 : localHour >= 7 && localHour < 9 ? 1.25 : 1.0;
  const meters = haversineMeters(o, d) * 1.35;
  const speedMs = 28 / 3.6; // 28 km/t bykørsel
  return { distanceM: Math.round(meters), durationS: Math.round((meters / speedMs) * traffic + 60) };
}

/**
 * SIMULERET kortadapter til Demo Mode og tests.
 * Geokodning er deterministisk (hash af adressen → punkt i Storkøbenhavn).
 * Køretider estimeres ud fra luftlinje × vejfaktor. Ikke egnet til drift.
 */
export class SimulatedMapsAdapter implements MapsAdapter {
  readonly kind = 'simulator' as const;
  readonly simulated = true;
  constructor(private center: LatLng = { lat: 55.6761, lng: 12.5683 }) {}

  async geocode(address: string): Promise<GeocodeResult> {
    const clean = address.trim();
    // Kræver gadenavn + husnummer for at blive godkendt
    if (!/[a-zæøå]{3,}.*\d+/i.test(clean)) return { found: false };
    const h = createHash('sha256').update(clean.toLowerCase()).digest();
    const dLat = ((h[0] / 255) - 0.5) * 0.12; // ca. ±6,7 km
    const dLng = ((h[1] / 255) - 0.5) * 0.2; // ca. ±6,3 km
    const postal = clean.match(/\b(\d{4})\b/)?.[1] ?? String(1000 + (h[2] % 90) * 10 + 50);
    return {
      found: true,
      lat: this.center.lat + dLat,
      lng: this.center.lng + dLng,
      formatted: clean.replace(/\s+/g, ' '),
      postalCode: postal,
      approximate: false,
    };
  }

  async travelMatrix(origins: LatLng[], destinations: LatLng[]): Promise<TravelEstimate[][]> {
    const hour = zonedParts(clock.now()).hour;
    return origins.map((o) => destinations.map((d) => simulatedTravel(o, d, hour)));
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Simuleret kortadapter (Demo Mode)' };
  }
}
