import type { LatLng } from '../../../core/geo';
import type { GeocodeResult, MapsAdapter, TravelEstimate } from './types';

/**
 * Google Maps Platform-adapter.
 * - Geocoding API til adressevalidering/geokodning.
 * - Routes API (computeRouteMatrix, TRAFFIC_AWARE) til trafikbaserede køretider.
 *
 * Ruteoptimering (rækkefølge af stop) foretages lokalt af systemets egen
 * indsættelsesheuristik ud fra køretidsmatricen – det holder API-forbruget nede.
 *
 * STATUS: Implementeret efter Googles dokumentation, testet med mockede svar.
 * Kræver verificering med en rigtig API-nøgle.
 */
export interface GoogleMapsOptions {
  apiKey: string;
  region: string;
  language: string;
  fetchFn?: typeof fetch;
}

export class GoogleMapsAdapter implements MapsAdapter {
  readonly kind = 'google' as const;
  readonly simulated = false;
  constructor(private opts: GoogleMapsOptions) {}

  private get fetchFn(): typeof fetch {
    return this.opts.fetchFn ?? fetch;
  }

  async geocode(address: string): Promise<GeocodeResult> {
    const params = new URLSearchParams({
      address,
      region: this.opts.region,
      language: this.opts.language,
      components: `country:${this.opts.region.toUpperCase()}`,
      key: this.opts.apiKey,
    });
    const res = await this.fetchFn(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    const json = (await res.json()) as {
      status: string;
      error_message?: string;
      results: {
        formatted_address: string;
        partial_match?: boolean;
        types: string[];
        geometry: { location: { lat: number; lng: number }; location_type: string };
        address_components: { long_name: string; types: string[] }[];
      }[];
    };
    if (json.status === 'ZERO_RESULTS') return { found: false };
    if (json.status !== 'OK') throw new Error(`Geocoding fejlede: ${json.status} ${json.error_message ?? ''}`.trim());
    const r = json.results[0];
    const hasStreetNumber = r.address_components.some((c) => c.types.includes('street_number'));
    const precise = ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(r.geometry.location_type);
    return {
      found: true,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formatted: r.formatted_address,
      postalCode: r.address_components.find((c) => c.types.includes('postal_code'))?.long_name,
      approximate: !hasStreetNumber || !precise || !!r.partial_match,
    };
  }

  async travelMatrix(origins: LatLng[], destinations: LatLng[]): Promise<TravelEstimate[][]> {
    if (origins.length === 0 || destinations.length === 0) return [];
    const wp = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const res = await this.fetchFn('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': this.opts.apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,status,condition',
      },
      body: JSON.stringify({
        origins: origins.map(wp),
        destinations: destinations.map(wp),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        languageCode: this.opts.language,
        regionCode: this.opts.region,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Routes API fejlede: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const elements = (await res.json()) as {
      originIndex: number;
      destinationIndex: number;
      duration?: string;
      distanceMeters?: number;
      condition?: string;
    }[];
    const out: TravelEstimate[][] = origins.map(() => destinations.map(() => ({ durationS: NaN, distanceM: NaN })));
    for (const e of elements) {
      if (e.condition && e.condition !== 'ROUTE_EXISTS') continue;
      out[e.originIndex][e.destinationIndex] = {
        durationS: parseInt((e.duration ?? '0s').replace('s', ''), 10),
        distanceM: e.distanceMeters ?? 0,
      };
    }
    return out;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await this.geocode('Rådhuspladsen 1, 1550 København');
      return r.found ? { ok: true, message: 'Geocoding API svarer' } : { ok: false, message: 'Testadresse ikke fundet' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
