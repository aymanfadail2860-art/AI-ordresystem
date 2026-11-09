import { act, call, useQuery } from '../api';
import { Card, DriverStatusBadge, Empty, OrderStatusBadge, PageHeader, time } from '../components/ui';
import type { DispatchOffer, Driver, Order, ReassignmentSuggestion, RouteStop } from '../../shared/types';
import type { Nav } from '../App';

interface Overview {
  drivers: Driver[];
  stops: RouteStop[];
  orders: Order[];
  offers: DispatchOffer[];
  suggestions: ReassignmentSuggestion[];
  central: { id: number; lat: number | null; lng: number | null } | null;
  area: { lat: number; lng: number; radiusKm: number };
  mapsSimulated: boolean;
}

const COLORS = ['#0a66e4', '#e4590a', '#1f8a4c', '#8a1fbf', '#c4251c', '#00838f', '#a35b00'];

export function Logistics({ nav }: { nav: Nav }) {
  const { data } = useQuery<Overview>('logistics.overview', {}, ['logistics', 'drivers', 'orders']);
  if (!data) return <Empty>Indlæser…</Empty>;
  const late = data.orders.filter((o) => o.eta && new Date(o.eta).getTime() < Date.now() - 5 * 60000 && ['driver_assigned', 'out_for_delivery'].includes(o.status));
  return (
    <>
      <PageHeader
        title="Logistik"
        subtitle="Aktive leveringer, ruter og forventede ankomsttider."
        actions={<button onClick={() => void act(() => call('logistics.recompute'))}>Genberegn ruter</button>}
      />
      <div className="grid cols-3">
        <Card title="Kort" className="span-2" actions={<span className="muted small">Skematisk kort{data.mapsSimulated ? ' · simulerede positioner' : ''}</span>}>
          <SchematicMap data={data} nav={nav} />
          <div className="legend">
            {data.drivers.filter((d) => d.lastLat != null).map((d, i) => (
              <span key={d.id} style={{ ['--c' as string]: COLORS[i % COLORS.length] }}>{d.name}</span>
            ))}
            <span style={{ ['--c' as string]: '#888' }}>Ordre uden chauffør</span>
            <span style={{ ['--c' as string]: '#111' }}>Centrallager</span>
          </div>
        </Card>
        <div className="stack">
          <Card title="Forslag til omfordeling">
            {data.suggestions.length ? (
              data.suggestions.map((s) => (
                <div key={s.id} className="event-row">
                  <div style={{ flex: 1 }}>
                    <div>Ordre #{s.orderId} → {s.toDriverName}</div>
                    <div className="muted small">{s.reason}</div>
                  </div>
                  <button className="primary" onClick={() => void act(() => call('logistics.applySuggestion', { id: s.id }))}>Anvend</button>
                  <button onClick={() => void act(() => call('logistics.dismissSuggestion', { id: s.id }))}>Afvis</button>
                </div>
              ))
            ) : (
              <Empty>Ingen forslag.</Empty>
            )}
          </Card>
          <Card title={`Forsinkelser (${late.length})`}>
            {late.length ? (
              late.map((o) => (
                <div key={o.id} className="event-row clickable" onClick={() => nav.go('orders', o.id)}>
                  <span className="lvl warn" />
                  <div>#{o.id} · {o.driverName} · ETA {time(o.eta)}</div>
                </div>
              ))
            ) : (
              <Empty>Ingen forsinkelser.</Empty>
            )}
          </Card>
          <Card title="Åbne chaufførtilbud">
            {data.offers.length ? (
              data.offers.map((f) => (
                <div key={f.id} className="row between">
                  <span>#{f.orderId} → {f.driverName}</span>
                  <span className="muted small">udløber {time(f.expiresAt)}</span>
                </div>
              ))
            ) : (
              <Empty>Ingen.</Empty>
            )}
          </Card>
        </div>
      </div>
      <Card title="Ruter pr. chauffør" className="mt">
        <table>
          <thead><tr><th>Chauffør</th><th>Status</th><th>Stop (rækkefølge · ETA)</th></tr></thead>
          <tbody>
            {data.drivers.map((d) => {
              const stops = data.stops.filter((s) => s.driverId === d.id);
              return (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td><DriverStatusBadge status={d.status} /></td>
                  <td>
                    {stops.length ? (
                      <div className="row wrap">
                        {stops.map((s) => (
                          <button key={s.orderId} onClick={() => nav.go('orders', s.orderId)}>
                            {s.sequence}. #{s.orderId} · {time(s.eta)} <OrderStatusBadge status={s.status} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/** Enkel SVG-projektion af koordinater. Ikke et rigtigt kort – viser relative placeringer. */
function SchematicMap({ data, nav }: { data: Overview; nav: Nav }) {
  const W = 800;
  const H = 520;
  // Tilpas udsnittet til de viste punkter (med luft), ellers leveringsområdet
  const pts: [number, number][] = [
    ...data.drivers.filter((d) => d.lastLat != null).map((d) => [d.lastLat!, d.lastLng!] as [number, number]),
    ...data.orders.filter((o) => o.addressLat != null).map((o) => [o.addressLat!, o.addressLng!] as [number, number]),
    ...(data.central?.lat != null ? [[data.central.lat, data.central.lng!] as [number, number]] : []),
  ];
  const kmLat = 1 / 110.57;
  const kmLng = 1 / (111.32 * Math.cos((data.area.lat * Math.PI) / 180));
  let minLat: number, maxLat: number, minLng: number, maxLng: number;
  if (pts.length >= 2) {
    const lats = pts.map((p) => p[0]);
    const lngs = pts.map((p) => p[1]);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    // Bevar målestok (km) i begge retninger og tilpas billedformatet
    const spanKm = Math.max(2, ((Math.max(...lats) - Math.min(...lats)) / kmLat) * 1.3, ((Math.max(...lngs) - Math.min(...lngs)) / kmLng) * 1.3 * (H / W));
    minLat = cLat - (spanKm / 2) * kmLat;
    maxLat = cLat + (spanKm / 2) * kmLat;
    minLng = cLng - (spanKm / 2) * (W / H) * kmLng;
    maxLng = cLng + (spanKm / 2) * (W / H) * kmLng;
  } else {
    const r = data.area.radiusKm * 1.1;
    minLat = data.area.lat - r * kmLat;
    maxLat = data.area.lat + r * kmLat;
    minLng = data.area.lng - r * (W / H) * kmLng;
    maxLng = data.area.lng + r * (W / H) * kmLng;
  }
  const x = (lng: number) => ((lng - minLng) / (maxLng - minLng)) * W;
  const y = (lat: number) => H - ((lat - minLat) / (maxLat - minLat)) * H;
  const driverColor = new Map(data.drivers.filter((d) => d.lastLat != null).map((d, i) => [d.id, COLORS[i % COLORS.length]]));
  const radiusPx = ((data.area.radiusKm * kmLat) / (maxLat - minLat)) * H;

  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <circle cx={x(data.area.lng)} cy={y(data.area.lat)} r={radiusPx} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeDasharray="6 6" />
      {data.drivers.map((d) => {
        if (d.lastLat == null) return null;
        const stops = data.stops.filter((s) => s.driverId === d.id && s.lat != null);
        const pts = [[x(d.lastLng!), y(d.lastLat)], ...stops.map((s) => [x(s.lng!), y(s.lat!)])];
        return <polyline key={`r${d.id}`} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={driverColor.get(d.id)} strokeWidth={2} strokeOpacity={0.6} />;
      })}
      {data.central?.lat != null && <rect x={x(data.central.lng!) - 7} y={y(data.central.lat) - 7} width={14} height={14} fill="#111" rx={2}><title>Centrallager</title></rect>}
      {data.orders.filter((o) => o.addressLat != null).map((o) => (
        <g key={o.id} onClick={() => nav.go('orders', o.id)} style={{ cursor: 'pointer' }}>
          <circle cx={x(o.addressLng!)} cy={y(o.addressLat!)} r={7} fill={o.driverId ? driverColor.get(o.driverId) ?? '#888' : '#888'} stroke="#fff" strokeWidth={2} />
          <text x={x(o.addressLng!) + 9} y={y(o.addressLat!) + 4} fontSize={11} fill="currentColor">#{o.id}</text>
          <title>#{o.id} {o.addressText}</title>
        </g>
      ))}
      {data.drivers.map((d) =>
        d.lastLat == null ? null : (
          <g key={d.id}>
            <circle cx={x(d.lastLng!)} cy={y(d.lastLat)} r={10} fill={driverColor.get(d.id)} opacity={d.status === 'offline' ? 0.3 : 1} />
            <text x={x(d.lastLng!)} y={y(d.lastLat) + 4} fontSize={10} fill="#fff" textAnchor="middle">{d.name[0]}</text>
            <title>{d.name} ({d.status})</title>
          </g>
        ),
      )}
    </svg>
  );
}
