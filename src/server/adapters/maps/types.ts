import type { LatLng } from '../../../core/geo';

export interface GeocodeResult {
  found: boolean;
  lat?: number;
  lng?: number;
  formatted?: string;
  postalCode?: string;
  /** Lav sikkerhed (delvist match / kun bynavn) – kræver bekræftelse. */
  approximate?: boolean;
}

export interface TravelEstimate {
  durationS: number;
  distanceM: number;
}

export interface MapsAdapter {
  readonly kind: 'simulator' | 'google';
  readonly simulated: boolean;
  geocode(address: string): Promise<GeocodeResult>;
  /** Køretidsmatrix origins × destinations (trafikbaseret hvor muligt). */
  travelMatrix(origins: LatLng[], destinations: LatLng[]): Promise<TravelEstimate[][]>;
  /** Billig sundhedstjek (fx test-geokodning). */
  test(): Promise<{ ok: boolean; message: string }>;
}
