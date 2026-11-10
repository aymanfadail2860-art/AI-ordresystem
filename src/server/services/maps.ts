import type { Db } from '../db/database';
import { nowIso } from '../db/database';
import { haversineMeters, roundCoordKey, type LatLng } from '../../core/geo';
import type { IntegrationRegistry } from '../infra';
import type { GeocodeResult, MapsAdapter, TravelEstimate } from '../adapters/maps/types';
import { clock } from '../clock';

export interface TravelResult extends TravelEstimate {
  /** 'live' = kortleverandør, 'fallback' = luftlinjeestimat (må ikke loves til kunder). */
  quality: 'live' | 'simulated' | 'fallback';
}

/**
 * Kort-service: wrapper om den udskiftelige kortadapter med caching i SQLite,
 * så gentagne opslag ikke koster API-kald. Ved fejl falder vi tilbage til
 * luftlinjeestimater, som markeres 'fallback' og aldrig kommunikeres som løfter.
 */
export class MapsService {
  constructor(
    private db: Db,
    private adapter: MapsAdapter | null,
    private integrations: IntegrationRegistry,
    private opts: { geocodeTtlHours: number; travelTtlMinutes: number },
  ) {}

  setAdapter(a: MapsAdapter | null): void {
    this.adapter = a;
  }

  get available(): boolean {
    return !!this.adapter;
  }

  get simulated(): boolean {
    return !!this.adapter?.simulated;
  }

  async geocode(address: string): Promise<GeocodeResult & { cached?: boolean }> {
    const key = address.trim().toLowerCase().replace(/\s+/g, ' ');
    const cutoff = new Date(clock.now() - this.opts.geocodeTtlHours * 3600000).toISOString();
    const row = this.db.prepare(`SELECT * FROM geocode_cache WHERE query = ? AND created_at >= ?`).get(key, cutoff) as
      | Record<string, unknown>
      | undefined;
    if (row) {
      return {
        found: !!row.found,
        lat: (row.lat as number) ?? undefined,
        lng: (row.lng as number) ?? undefined,
        formatted: (row.formatted as string) ?? undefined,
        postalCode: (row.postal_code as string) ?? undefined,
        cached: true,
      };
    }
    if (!this.adapter) throw new Error('Kortintegration er ikke konfigureret');
    try {
      const r = await this.adapter.geocode(address);
      if (!r.approximate) {
        this.db
          .prepare(
            `INSERT INTO geocode_cache (query, lat, lng, formatted, postal_code, found, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(query) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, formatted=excluded.formatted,
               postal_code=excluded.postal_code, found=excluded.found, created_at=excluded.created_at`,
          )
          .run(key, r.lat ?? null, r.lng ?? null, r.formatted ?? null, r.postalCode ?? null, r.found ? 1 : 0, nowIso());
      }
      if (!this.adapter.simulated) this.integrations.set('maps', 'ok', 'Geokodning fungerer');
      return r;
    } catch (err) {
      this.integrations.set('maps', 'degraded', `Geokodning fejlede: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Køretider fra hvert origin til hver destination, med cache pr. par. */
  async matrix(origins: LatLng[], destinations: LatLng[]): Promise<TravelResult[][]> {
    const cutoff = new Date(clock.now() - this.opts.travelTtlMinutes * 60000).toISOString();
    const get = this.db.prepare(`SELECT duration_s, distance_m FROM travel_cache WHERE origin = ? AND destination = ? AND created_at >= ?`);
    const result: (TravelResult | null)[][] = origins.map((o) =>
      destinations.map((d) => {
        if (roundCoordKey(o) === roundCoordKey(d)) return { durationS: 0, distanceM: 0, quality: this.simulated ? 'simulated' : 'live' };
        const r = get.get(roundCoordKey(o), roundCoordKey(d), cutoff) as { duration_s: number; distance_m: number } | undefined;
        return r ? { durationS: r.duration_s, distanceM: r.distance_m, quality: this.simulated ? 'simulated' : 'live' } : null;
      }),
    );
    const missingOrigins = origins.filter((_, i) => result[i].some((x) => x === null));
    const missingDest = destinations.filter((_, j) => result.some((row) => row[j] === null));
    if (missingOrigins.length && missingDest.length) {
      let fetched: TravelEstimate[][] | null = null;
      if (this.adapter) {
        try {
          fetched = await this.adapter.travelMatrix(missingOrigins, missingDest);
          if (!this.adapter.simulated) this.integrations.set('maps', 'ok', 'Køretidsberegning fungerer');
        } catch (err) {
          this.integrations.set('maps', 'degraded', `Køretidsberegning fejlede – bruger estimater: ${(err as Error).message}`);
        }
      }
      const put = this.db.prepare(
        `INSERT INTO travel_cache (origin, destination, duration_s, distance_m, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(origin, destination) DO UPDATE SET duration_s=excluded.duration_s, distance_m=excluded.distance_m, created_at=excluded.created_at`,
      );
      origins.forEach((o, i) => {
        destinations.forEach((d, j) => {
          if (result[i][j]) return;
          const mi = missingOrigins.indexOf(o);
          const mj = missingDest.indexOf(d);
          const f = fetched?.[mi]?.[mj];
          if (f && Number.isFinite(f.durationS)) {
            put.run(roundCoordKey(o), roundCoordKey(d), f.durationS, f.distanceM, nowIso());
            result[i][j] = { ...f, quality: this.simulated ? 'simulated' : 'live' };
          } else {
            const m = haversineMeters(o, d) * 1.4;
            result[i][j] = { distanceM: Math.round(m), durationS: Math.round(m / (25 / 3.6) + 90), quality: 'fallback' };
          }
        });
      });
    }
    return result as TravelResult[][];
  }

  async travel(from: LatLng, to: LatLng): Promise<TravelResult> {
    return (await this.matrix([from], [to]))[0][0];
  }

  purgeCache(): void {
    const cutoff = new Date(clock.now() - 24 * 3600000).toISOString();
    this.db.prepare(`DELETE FROM travel_cache WHERE created_at < ?`).run(cutoff);
  }
}
