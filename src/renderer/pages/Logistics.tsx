import { useState } from 'react';
import { act, call, useQuery } from '../api';
import { Card, DriverStatusBadge, Empty, Modal, OrderStatusBadge, PageHeader, Stat, ago, kr, time } from '../components/ui';
import type { DecisionAnalysis, DispatchOffer, Driver, EtaConfidence, Order, ReassignmentSuggestion, RouteStop } from '../../shared/types';
import type { Nav } from '../App';

interface DriverRoute {
  driver: Driver;
  stops: (RouteStop & { totalOre: number; contributionOre: number })[];
  statusAgeMin: number | null;
  statusStale: boolean;
  anchorKind: string | null;
  deliveredToday: number;
  revenueTodayOre: number;
  deliveriesPerHour: number;
  plannedRevenueOre: number;
  plannedContributionOre: number;
  contributionEstimated: boolean;
  extraCapacity: boolean;
}

interface Overview {
  drivers: DriverRoute[];
  orders: Order[];
  offers: DispatchOffer[];
  suggestions: ReassignmentSuggestion[];
  central: { id: number; lat: number | null; lng: number | null } | null;
  area: { lat: number; lng: number; radiusKm: number };
  mapsSimulated: boolean;
  totals: { deliveredToday: number; revenueTodayOre: number; deliveriesPerHour: number; plannedRevenueOre: number; awaitingDriver: number };
  statusStaleMinutes: number;
}

const COLORS = ['#0a66e4', '#e4590a', '#1f8a4c', '#8a1fbf', '#c4251c', '#00838f', '#a35b00'];
const CONF: Record<EtaConfidence, { label: string; tone: string }> = {
  high: { label: 'Sikker', tone: 'ok' },
  medium: { label: 'Middel', tone: 'info' },
  low: { label: 'Usikker', tone: 'warn' },
};

export function Logistics({ nav }: { nav: Nav }) {
  const { data } = useQuery<Overview>('logistics.overview', {}, ['logistics', 'drivers', 'orders']);
  const [why, setWhy] = useState<{ title: string; analysis: DecisionAnalysis } | null>(null);
  if (!data) return <Empty>Indlæser…</Empty>;
  const active = data.drivers.filter((d) => d.stops.length || d.driver.status !== 'offline');
  const late = data.orders.filter((o) => o.eta && o.etaConfidence === 'low' && ['driver_assigned', 'out_for_delivery'].includes(o.status));
  const pendingOffers = data.offers.filter((o) => o.status === 'pending');

  return (
    <>
      <PageHeader
        title="Logistik"
        subtitle="Ruter og ETA'er beregnes ud fra chaufførernes Telegram-status, bekræftede stop og køretider – ikke live-GPS."
        actions={<button onClick={() => void act(() => call('logistics.recompute'))}>Genberegn ETA'er</button>}
      />
      <div className="stats">
        <Stat label="Leveret i dag" value={data.totals.deliveredToday} sub={kr(data.totals.revenueTodayOre)} tone="ok" />
        <Stat label="Leveringer pr. time" value={data.totals.deliveriesPerHour.toLocaleString('da-DK')} />
        <Stat label="Planlagt omsætning" value={kr(data.totals.plannedRevenueOre)} sub="på aktive ruter" />
        <Stat label="Afventer chauffør" value={data.totals.awaitingDriver} tone={data.totals.awaitingDriver ? 'warn' : ''} />
        <Stat label="Usikre ETA'er" value={late.length} tone={late.length ? 'warn' : ''} sub={`status ældre end ${data.statusStaleMinutes} min eller overskredet`} />
      </div>

      <div className="stack">
        {active.length === 0 && <Card><Empty>Ingen chauffører er online.</Empty></Card>}
        {active.map((r, i) => (
          <Card
            key={r.driver.id}
            title={
              <span className="row">
                <span className="color-dot" style={{ background: COLORS[i % COLORS.length] }} />
                {r.driver.name} <DriverStatusBadge status={r.driver.status} />
                {r.extraCapacity && <span className="badge info">Kan tage ekstra ordre</span>}
              </span>
            }
            actions={
              <span className="muted small">
                {r.deliveredToday} leveret · {kr(r.revenueTodayOre)} i dag · {r.deliveriesPerHour.toLocaleString('da-DK')} lev./time
              </span>
            }
          >
            <div className={`status-line ${r.statusStale ? 'stale' : ''}`}>
              <span className="status-icon">💬</span>
              <div>
                <div>{r.driver.lastStatusText ? `“${r.driver.lastStatusText}”` : <span className="muted">Ingen Telegram-status endnu</span>}</div>
                <div className="muted small">
                  {r.driver.lastStatusAt ? `Seneste status ${ago(r.driver.lastStatusAt)}` : 'Ingen status'}
                  {r.statusStale && ' · ⚠️ Status forældet – ETA\'er er usikre og loves ikke til kunder'}
                </div>
              </div>
            </div>
            {r.stops.length ? (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Ordre</th>
                    <th>Adresse</th>
                    <th>Forventet ankomst</th>
                    <th>Sikkerhed</th>
                    <th>Grundlag</th>
                    <th className="num">Omsætning</th>
                  </tr>
                </thead>
                <tbody>
                  {r.stops.map((s) => (
                    <tr key={s.orderId} className="clickable" onClick={() => nav.go('orders', s.orderId)}>
                      <td>{s.sequence}</td>
                      <td>
                        #{s.orderId} {r.driver.currentOrderId === s.orderId && <span className="badge accent">på vej hertil</span>} <OrderStatusBadge status={s.status} />
                      </td>
                      <td className="truncate" style={{ maxWidth: 220 }}>{s.address}</td>
                      <td>
                        <strong>{time(s.eta)}</strong> <span className="muted small">({time(s.etaLow)}–{time(s.etaHigh)})</span>
                      </td>
                      <td>{s.confidence ? <span className={`badge ${CONF[s.confidence].tone}`}>{CONF[s.confidence].label}</span> : '–'}</td>
                      <td className="muted small">{s.etaBasis}</td>
                      <td className="num">{kr(s.totalOre)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={6} className="muted">
                      Planlagt rute: {r.stops.length} stop · dækningsbidrag {kr(r.plannedContributionOre)}
                      {r.contributionEstimated ? ' (delvist estimeret)' : ''}
                    </td>
                    <td className="num"><strong>{kr(r.plannedRevenueOre)}</strong></td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="muted">Ingen planlagte stop.</p>
            )}
            {pendingOffers
              .filter((o) => o.driverId === r.driver.id)
              .map((o) => (
                <div key={o.id} className="callout" style={{ marginTop: 8 }}>
                  <div className="row between">
                    <span>
                      Afventer svar: {o.kind === 'reassignment' ? 'overtagelse af' : 'ny'} ordre #{o.orderId}
                      {o.plan && ` som stop ${o.plan.insertIndex + 1} af ${o.plan.sequence.length}`}
                      {o.plan?.analysis.significantChange && ' · ruteændring'} · udløber {time(o.expiresAt)}
                    </span>
                    {o.plan && <button onClick={() => setWhy({ title: `Begrundelse – ordre #${o.orderId} til ${o.driverName}`, analysis: o.plan!.analysis })}>Begrundelse</button>}
                  </div>
                </div>
              ))}
          </Card>
        ))}
      </div>

      <div className="grid cols-2 mt">
        <Card title="Foreslåede ruteændringer">
          {data.suggestions.length ? (
            data.suggestions.map((s) => (
              <div key={s.id} className="event-row">
                <div style={{ flex: 1 }}>
                  <div>Ordre #{s.orderId} → {s.toDriverName}</div>
                  <div className="muted small">{s.reason}</div>
                </div>
                {s.analysis && <button onClick={() => setWhy({ title: `Omfordeling af ordre #${s.orderId}`, analysis: s.analysis! })}>Begrundelse</button>}
                <button className="primary" title="Sender et tilbud til den nye chauffør – ændringen gælder først, når chaufføren accepterer" onClick={() => void act(() => call('logistics.applySuggestion', { id: s.id }))}>
                  Send tilbud
                </button>
                <button onClick={() => void act(() => call('logistics.dismissSuggestion', { id: s.id }))}>Afvis</button>
              </div>
            ))
          ) : (
            <Empty>Ingen forslag lige nu.</Empty>
          )}
        </Card>
        <Card title="Stopoversigt" actions={<span className="muted small">Skematisk · senest kendte stop, ikke live-position{data.mapsSimulated ? ' · simulerede køretider' : ''}</span>}>
          <SchematicMap data={data} nav={nav} />
        </Card>
      </div>
      {why && <AnalysisModal {...why} onClose={() => setWhy(null)} />}
    </>
  );
}

function AnalysisModal({ title, analysis: a, onClose }: { title: string; analysis: DecisionAnalysis; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <dl className="kv">
        <dt>Omsætning</dt>
        <dd>{kr(a.revenueOre)}</dd>
        <dt>Dækningsbidrag</dt>
        <dd>{kr(a.contributionOre)}{a.contributionEstimated ? ' (estimeret – vareomkostning mangler)' : ''}</dd>
        <dt>Ekstra køretid</dt>
        <dd>{a.extraDriveMinutes.toLocaleString('da-DK')} min</dd>
        <dt>Levering om</dt>
        <dd>ca. {a.newOrderEtaMinutes} min</dd>
        <dt>Påvirkning af andre</dt>
        <dd>{a.maxExistingDelayMinutes ? `op til ${a.maxExistingDelayMinutes} min senere` : 'ingen'}</dd>
        <dt>Rute i alt</dt>
        <dd>{kr(a.routeRevenueOre)} · {a.routeDriveMinutes} min kørsel · {a.deliveriesPerHour.toLocaleString('da-DK')} lev./time</dd>
        <dt>Forsinkelsesrisiko</dt>
        <dd>{a.lateRiskMinutes} min</dd>
        {a.reassignmentCostOre > 0 && (
          <>
            <dt>Omfordeling</dt>
            <dd>{kr(a.reassignmentCostOre)}</dd>
          </>
        )}
        <dt>Samlet score</dt>
        <dd>{a.score.toLocaleString('da-DK')}</dd>
      </dl>
      <ul>
        {a.explanation.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      <p className="muted small">Scoren er beregnet deterministisk ud fra forretningsreglerne under Indstillinger → Logistik og økonomi.</p>
    </Modal>
  );
}

/** Skematisk visning af stop og senest kendte stop. Ikke et kort over live-positioner. */
function SchematicMap({ data, nav }: { data: Overview; nav: Nav }) {
  const W = 600;
  const H = 360;
  const pts: [number, number][] = [
    ...data.orders.filter((o) => o.addressLat != null).map((o) => [o.addressLat!, o.addressLng!] as [number, number]),
    ...data.drivers.filter((d) => d.driver.lastLat != null && (d.stops.length || d.driver.status !== 'offline')).map((d) => [d.driver.lastLat!, d.driver.lastLng!] as [number, number]),
  ];
  if (pts.length === 0) return <Empty>Ingen stop at vise.</Empty>;
  const kmLat = 1 / 110.57;
  const kmLng = 1 / (111.32 * Math.cos((data.area.lat * Math.PI) / 180));
  const lats = pts.map((p) => p[0]);
  const lngs = pts.map((p) => p[1]);
  const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const spanKm = Math.max(2, ((Math.max(...lats) - Math.min(...lats)) / kmLat) * 1.3, ((Math.max(...lngs) - Math.min(...lngs)) / kmLng) * 1.3 * (H / W));
  const minLat = cLat - (spanKm / 2) * kmLat;
  const maxLat = cLat + (spanKm / 2) * kmLat;
  const minLng = cLng - (spanKm / 2) * (W / H) * kmLng;
  const maxLng = cLng + (spanKm / 2) * (W / H) * kmLng;
  const x = (lng: number) => ((lng - minLng) / (maxLng - minLng)) * W;
  const y = (lat: number) => H - ((lat - minLat) / (maxLat - minLat)) * H;
  const colorOf = new Map(data.drivers.map((d, i) => [d.driver.id, COLORS[i % COLORS.length]]));
  return (
    <>
      <svg className="map" style={{ height: 360 }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {data.drivers.map((d) => {
          const stops = d.stops.filter((s) => s.lat != null);
          if (!stops.length || d.driver.lastLat == null) return null;
          const p = [[x(d.driver.lastLng!), y(d.driver.lastLat)], ...stops.map((s) => [x(s.lng!), y(s.lat!)])];
          return <polyline key={d.driver.id} points={p.map((q) => q.join(',')).join(' ')} fill="none" stroke={colorOf.get(d.driver.id)} strokeWidth={2} strokeDasharray="6 4" strokeOpacity={0.7} />;
        })}
        {data.orders.filter((o) => o.addressLat != null).map((o) => (
          <g key={o.id} onClick={() => nav.go('orders', o.id)} style={{ cursor: 'pointer' }}>
            <circle cx={x(o.addressLng!)} cy={y(o.addressLat!)} r={7} fill={o.driverId ? colorOf.get(o.driverId) : '#888'} stroke="#fff" strokeWidth={2} />
            <text x={x(o.addressLng!) + 9} y={y(o.addressLat!) + 4} fontSize={11} fill="currentColor">#{o.id}</text>
          </g>
        ))}
        {data.drivers.map((d) =>
          d.driver.lastLat == null || (!d.stops.length && d.driver.status === 'offline') ? null : (
            <g key={`d${d.driver.id}`}>
              <rect x={x(d.driver.lastLng!) - 7} y={y(d.driver.lastLat) - 7} width={14} height={14} fill="none" stroke={colorOf.get(d.driver.id)} strokeWidth={2.5} rx={3} />
              <title>{d.driver.name}: senest kendte stop ({d.driver.lastPositionAt ? ago(d.driver.lastPositionAt) : 'ukendt'}) – ikke live-position</title>
            </g>
          ),
        )}
      </svg>
      <div className="legend">
        <span style={{ ['--c' as string]: '#888' }}>Ordre uden chauffør</span>
        <span style={{ ['--c' as string]: 'transparent' }}>□ = chaufførens senest kendte stop</span>
      </div>
    </>
  );
}
