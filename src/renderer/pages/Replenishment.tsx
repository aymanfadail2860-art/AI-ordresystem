import { useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Empty, PageHeader, dateTime, kr, time } from '../components/ui';
import type { LocationCapacity, Product, Replenishment, StockForecast, StockLevel, StockLocation } from '../../shared/types';
import { REPLENISHMENT_STATUS_LABELS } from '../../shared/types';

interface Overview {
  forecasts: StockForecast[];
  active: Replenishment[];
  history: Replenishment[];
  locations: StockLocation[];
  levels: StockLevel[];
  products: Product[];
}

const TONE: Record<string, string> = {
  proposed: 'info',
  awaiting_management: 'warn',
  approved: 'accent',
  awaiting_driver: 'warn',
  en_route: 'accent',
  awaiting_pickup: 'accent',
  picked_up: 'ok',
  completed: 'ok',
  rejected: 'neutral',
  cancelled: 'neutral',
  expired: 'danger',
};

export function ReplenishmentStatus({ status }: { status: Replenishment['status'] }) {
  return <span className={`badge ${TONE[status]}`}>{REPLENISHMENT_STATUS_LABELS[status]}</span>;
}

/** Ét opfyldningsforslag med begrundelse, alternativer og handlinger. */
export function ReplenishmentCard({ rep }: { rep: Replenishment }) {
  const [showAlts, setShowAlts] = useState(false);
  const c = rep.analysis?.chosen;
  return (
    <Card
      title={<>Opfyldning #{rep.id} – {rep.driverName} <ReplenishmentStatus status={rep.status} /></>}
      actions={
        rep.status === 'awaiting_management' ? (
          <>
            <button className="primary" onClick={() => void act(() => call<{ message: string }>('replenishment.approve', { id: rep.id }).then((r) => toast(r.message)))}>Godkend</button>
            <button onClick={() => setShowAlts(!showAlts)}>Vis alternativer</button>
            <button className="danger" onClick={() => void act(() => call<{ message: string }>('replenishment.reject', { id: rep.id }).then((r) => toast(r.message)))}>Afvis</button>
          </>
        ) : !['completed', 'rejected', 'cancelled', 'expired'].includes(rep.status) ? (
          <button className="danger" onClick={() => void act(() => call('replenishment.cancel', { id: rep.id }))}>Annullér</button>
        ) : null
      }
    >
      <dl className="kv">
        <dt>Lager</dt><dd>{rep.locationName}</dd>
        <dt>Tidspunkt</dt><dd>{rep.afterOrderId ? `Efter ordre #${rep.afterOrderId}` : 'Før første stop'}{rep.deadlineAt ? ` · senest sikre beslutning kl. ${time(rep.deadlineAt)}` : ''}</dd>
        <dt>Afhentes</dt><dd>{rep.items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')}</dd>
        <dt>Dækker ordrer</dt><dd>{rep.coversOrders.map((x) => '#' + x).join(', ')}</dd>
        {c && (
          <>
            <dt>Ekstra tid</dt><dd>{c.extraDriveMinutes} min kørsel + {c.pickupMinutes} min afhentning</dd>
            <dt>Effekt</dt><dd>{c.delays.length ? c.delays.map((d) => `#${d.orderId} +${d.minutes} min`).join(', ') : 'Ingen leveringer rykkes'}</dd>
            <dt>Økonomisk effekt</dt><dd>Driftsomkostning ca. {kr(c.costOre)} · {c.deliveriesPerHour.toLocaleString('da-DK')} lev./time</dd>
          </>
        )}
        {rep.approvedBy && (<><dt>Godkendt</dt><dd>{rep.approvedBy} {dateTime(rep.approvedAt)}</dd></>)}
        {rep.rejectedBy && (<><dt>Afvist</dt><dd>{rep.rejectedBy}: {rep.rejectedReason}</dd></>)}
        {rep.pickedUpAt && (<><dt>Afhentet</dt><dd>{dateTime(rep.pickedUpAt)}</dd></>)}
      </dl>
      {rep.analysis?.reasoning && <ul className="muted small">{rep.analysis.reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {showAlts && rep.analysis && (
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Mulighed</th><th className="num">Ekstra kørsel</th><th className="num">Maks. forsinkelse</th><th className="num">Omkostning</th><th>Gyldig</th></tr></thead>
          <tbody>
            {[rep.analysis.chosen, ...rep.analysis.alternatives].map((a, i) => (
              <tr key={i}>
                <td>{i === 0 ? '★ ' : ''}{a.explanation[0]}</td>
                <td className="num">{a.extraDriveMinutes} min</td>
                <td className="num">{a.maxDelayMinutes} min</td>
                <td className="num">{kr(a.costOre)}</td>
                <td>{a.feasible ? <span className="badge ok">Ja</span> : <span className="badge danger" title={a.violations.join('; ')}>Nej</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Billager pr. chauffør: lager efter hvert planlagt stop, underskud og opfyldninger. */
export function VehicleStock({ embedded }: { embedded?: boolean }) {
  const { data } = useQuery<Overview>('replenishment.overview', {}, ['replenishment', 'inventory', 'logistics', 'orders']);
  if (!data) return <Empty>Indlæser…</Empty>;
  const pname = (id: number) => data.products.find((p) => p.id === id)?.name ?? `#${id}`;
  return (
    <div className="stack">
      {!embedded && <PageHeader title="Billager og opfyldning" />}
      {data.forecasts.map((f) => {
        // Vis varer som ruten bruger (eller hele billageret, hvis der ikke er en rute)
        const routePids = [...new Set([...f.stops.flatMap((s) => Object.keys(s.needs).map(Number)), ...f.shortages.map((x) => x.productId)])];
        const pids = routePids.length ? routePids : Object.keys(f.start).map(Number).filter((p) => (f.start[p] ?? 0) > 0);
        const rep = data.active.find((r) => r.driverId === f.driverId);
        return (
          <Card
            key={f.driverId}
            title={<>{f.driverName} {f.shortages.length ? <span className="badge danger">Underskud</span> : f.stops.length ? <span className="badge ok">Dækket</span> : null}</>}
            actions={<button onClick={() => void act(() => call('replenishment.recompute', { driverId: f.driverId }))}>Genberegn</button>}
          >
            {f.shortages.length > 0 && (
              <div className="callout danger" style={{ marginBottom: 8 }}>
                Forventet underskud: {f.shortages.map((s) => `${s.missing}× ${s.productName} fra ordre #${s.firstStopOrderId} (stop ${s.firstStopIndex + 1})`).join(', ')}
              </div>
            )}
            {rep && <p>🔄 Opfyldning #{rep.id}: <strong>{REPLENISHMENT_STATUS_LABELS[rep.status]}</strong> – {rep.items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')} på {rep.locationName}{rep.afterOrderId ? ` efter #${rep.afterOrderId}` : ''}</p>}
            {pids.length ? (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Vare</th>
                      <th className="num">Nu</th>
                      {f.stops.map((s, i) => (
                        <th key={s.orderId} className="num">
                          {s.pickupBefore && <span title="Lagerbesøg før dette stop">🔄 </span>}
                          {i + 1}. #{s.orderId}
                          <div className="muted small">{s.eta ? time(s.eta) : ''}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pids.map((pid) => (
                      <tr key={pid}>
                        <td>{pname(pid)}</td>
                        <td className="num">{Math.max(0, f.start[pid] ?? 0)}</td>
                        {f.stops.map((s) => {
                          const need = s.needs[pid] ?? 0;
                          const short = need > 0 && (s.after[pid] ?? 0) === 0 && f.shortages.some((x) => x.productId === pid && f.stops.findIndex((y) => y.orderId === s.orderId) >= x.firstStopIndex);
                          return (
                            <td key={s.orderId} className="num" style={{ color: short ? 'var(--danger)' : undefined }}>
                              {need ? <span className="muted small">−{need} → </span> : null}
                              {s.after[pid] ?? 0}
                              {s.uncovered && need ? ' ⚠️' : ''}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Intet lager og ingen planlagte stop.</p>
            )}
          </Card>
        );
      })}
      <Card title="Kommende og afventende opfyldninger">
        {data.active.length ? <div className="stack">{data.active.map((r) => <ReplenishmentCard key={r.id} rep={r} />)}</div> : <Empty>Ingen aktive opfyldninger.</Empty>}
      </Card>
      <VehicleCapacity />
      <Card title="Lagerlokationer">
        <table>
          <thead><tr><th>Lokation</th><th>Type</th><th className="num">Varer på lager</th><th className="num">Reserveret</th></tr></thead>
          <tbody>
            {data.locations.map((l) => {
              const lv = data.levels.filter((x) => x.locationId === l.id);
              return (
                <tr key={l.id}>
                  <td>{l.name}</td><td>{l.type === 'central' ? 'Centrallager' : 'Bil'}</td>
                  <td className="num">{lv.reduce((a, x) => a + x.quantity, 0)}</td>
                  <td className="num">{lv.reduce((a, x) => a + x.reserved, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Card title="Opfyldningshistorik">
        {data.history.length ? (
          <table>
            <thead><tr><th>#</th><th>Chauffør</th><th>Status</th><th>Varer</th><th>Lager</th><th>Afgjort af</th><th className="num">Omkostning</th><th>Oprettet</th></tr></thead>
            <tbody>
              {data.history.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td><td>{r.driverName}</td><td><ReplenishmentStatus status={r.status} /></td>
                  <td>{r.items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')}</td>
                  <td>{r.locationName}</td>
                  <td>{r.approvedBy ?? r.rejectedBy ?? '–'}</td>
                  <td className="num">{r.analysis ? kr(r.analysis.chosen.costOre) : '–'}</td>
                  <td>{dateTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Ingen afsluttede opfyldninger endnu.</Empty>
        )}
      </Card>
    </div>
  );
}

interface CapRow {
  id: number;
  name: string;
  capacity: LocationCapacity;
  config: { capacityUnits: number | null; categoryCaps: Record<string, number>; flexUnits: number | null };
}

/** Bilernes fysiske kapacitet (lagerenheder), pr. varetype og fast sortiment. */
function VehicleCapacity() {
  const { data } = useQuery<CapRow[]>('inventory.capacity', {}, ['inventory', 'products']);
  const [edit, setEdit] = useState<number | null>(null);
  const [form, setForm] = useState({ capacityUnits: '', flexUnits: '', caps: '' });
  if (!data?.length) return null;
  const open = (r: CapRow) => {
    setEdit(r.id);
    setForm({
      capacityUnits: r.config.capacityUnits == null ? '' : String(r.config.capacityUnits),
      flexUnits: r.config.flexUnits == null ? '' : String(r.config.flexUnits),
      caps: Object.entries(r.config.categoryCaps).map(([k, v]) => `${k}=${v}`).join('; '),
    });
  };
  const save = (id: number) => {
    const categoryCaps = Object.fromEntries(
      form.caps
        .split(/[;,]/)
        .map((x) => x.split('=').map((y) => y.trim()))
        .filter((x) => x.length === 2 && x[0] && x[1])
        .map(([k, v]) => [k, Number(v)]),
    );
    void act(() => call('inventory.setCapacity', { locationId: id, capacityUnits: form.capacityUnits, flexUnits: form.flexUnits, categoryCaps })).then((ok) => ok && setEdit(null));
  };
  return (
    <Card title="Bilernes kapacitet">
      <p className="muted small">Plads måles i lagerenheder (fx 1 = én dåse, 3 = en pose chips). Tom kapacitet = ubegrænset. Opfyldning og påfyldning holder sig inden for pladsen.</p>
      <table>
        <thead>
          <tr><th>Bil</th><th className="num">Brugt / kapacitet</th><th className="num">Fri</th><th className="num">Reserveret</th><th>Varetyper (brugt/maks.)</th><th>Fast sortiment</th><th /></tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="num">{r.capacity.usedUnits} / {r.capacity.capacityUnits ?? '∞'}</td>
              <td className="num" style={{ color: r.capacity.freeUnits != null && r.capacity.capacityUnits && r.capacity.freeUnits < r.capacity.capacityUnits * 0.1 ? 'var(--danger)' : undefined }}>{r.capacity.freeUnits ?? '–'}</td>
              <td className="num">{r.capacity.reservedUnits}</td>
              <td className="small">{r.capacity.byCategory.filter((c) => c.capUnits != null).map((c) => `${c.category} ${c.usedUnits}/${c.capUnits}`).join(', ') || '–'}</td>
              <td className="small">{r.capacity.assortment.length ? `${r.capacity.assortment.length} varer${r.capacity.flexUnits != null ? ` · flex ${r.capacity.flexUsedUnits}/${r.capacity.flexUnits}` : ''}` : '–'}</td>
              <td>
                {edit === r.id ? (
                  <div className="row wrap">
                    <input style={{ width: 80 }} placeholder="kapacitet" value={form.capacityUnits} onChange={(e) => setForm({ ...form, capacityUnits: e.target.value })} />
                    <input style={{ width: 70 }} placeholder="flex" value={form.flexUnits} onChange={(e) => setForm({ ...form, flexUnits: e.target.value })} />
                    <input style={{ width: 170 }} placeholder="Is=12; Husholdning=24" value={form.caps} onChange={(e) => setForm({ ...form, caps: e.target.value })} />
                    <button className="primary" onClick={() => save(r.id)}>Gem</button>
                  </div>
                ) : (
                  <button onClick={() => open(r)}>Redigér</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

