export interface LatLng {
  lat: number;
  lng: number;
}

/** Storcirkelafstand i meter. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function roundCoordKey(p: LatLng, decimals = 4): string {
  return `${p.lat.toFixed(decimals)},${p.lng.toFixed(decimals)}`;
}
