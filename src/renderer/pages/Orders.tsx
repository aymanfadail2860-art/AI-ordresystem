import { useEffect, useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Empty, Field, Modal, OrderStatusBadge, PageHeader, dateTime, kr, time } from '../components/ui';
import type { DispatchOffer, Driver, Order, OrderEvent, OrderStatus, Product, RouteStop } from '../../shared/types';
import { ORDER_STATUS_LABELS } from '../../shared/types';
import { allowedTransitions } from '../../core/orderStateMachine';
import type { Nav } from '../App';

const FILTERS: { id: string; label: string; status?: OrderStatus[]; activeOnly?: boolean; today?: boolean }[] = [
  { id: 'active', label: 'Aktive', activeOnly: true },
  { id: 'drafts', label: 'I dialog', status: ['new_inquiry', 'awaiting_customer_info', 'awaiting_stock_check', 'awaiting_confirmation'] },
  { id: 'delivery', label: 'Under levering', status: ['awaiting_driver', 'driver_assigned', 'out_for_delivery'] },
  { id: 'manual', label: 'Manuel', status: ['needs_manual'] },
  { id: 'today', label: 'I dag', today: true },
  { id: 'all', label: 'Alle' },
];

export function Orders({ nav }: { nav: Nav }) {
  const [filter, setFilter] = useState('active');
  const [selected, setSelected] = useState<number | null>(nav.selected);
  useEffect(() => setSelected(nav.selected), [nav.selected]);
  const f = FILTERS.find((x) => x.id === filter)!;
  const { data: orders } = useQuery<Order[]>('orders.list', { status: f.status, activeOnly: f.activeOnly, today: f.today, limit: 300 }, ['orders']);

  return (
    <>
      <PageHeader title="Ordrer" subtitle="Live-ordreliste. Klik på en ordre for detaljer, historik og manuelle handlinger." />
      <div className="tabs">
        {FILTERS.map((x) => (
          <button key={x.id} className={`tab ${filter === x.id ? 'active' : ''}`} onClick={() => setFilter(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="split">
        <Card>
          {orders?.length ? (
            <div className="list">
              {orders.map((o) => (
                <div key={o.id} className={`list-item ${selected === o.id ? 'active' : ''}`} onClick={() => setSelected(o.id)}>
                  <div className="row between">
                    <strong>#{o.id} {o.needsAttention && <span title={o.attentionReason ?? ''}>⚠️</span>}</strong>
                    <OrderStatusBadge status={o.status} />
                  </div>
                  <div className="row between muted">
                    <span className="truncate">{o.customerName ?? o.customerPhone} · {o.lines.map((l) => `${l.quantity}× ${l.productName}`).join(', ') || 'ingen varer endnu'}</span>
                    <span>{kr(o.totalOre)}</span>
                  </div>
                  <div className="muted small">
                    {dateTime(o.createdAt)}
                    {o.driverName ? ` · ${o.driverName}` : ''}
                    {o.eta ? ` · ETA ${time(o.eta)}` : ''}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Ingen ordrer i denne visning.</Empty>
          )}
        </Card>
        {selected ? <OrderDetail id={selected} nav={nav} /> : <Card><Empty>Vælg en ordre.</Empty></Card>}
      </div>
    </>
  );
}

interface Detail {
  order: Order;
  events: OrderEvent[];
  offers: DispatchOffer[];
  route: RouteStop[];
}

export function OrderDetail({ id, nav }: { id: number; nav: Nav }) {
  const { data } = useQuery<Detail>('orders.get', { id }, ['orders', 'logistics']);
  const [modal, setModal] = useState<null | 'assign' | 'edit' | 'cancel' | 'status'>(null);
  if (!data) return <Card><Empty>Indlæser…</Empty></Card>;
  const { order: o, events, offers } = data;
  const terminal = o.status === 'delivered' || o.status === 'cancelled';

  return (
    <div className="stack">
      <Card
        title={<>Ordre #{o.id} <OrderStatusBadge status={o.status} /></>}
        actions={
          !terminal && (
            <>
              <button onClick={() => setModal('assign')}>Tildel chauffør</button>
              <button onClick={() => setModal('edit')}>Ret varer</button>
              <button onClick={() => setModal('status')}>Skift status</button>
              <button className="danger" onClick={() => setModal('cancel')}>Annullér</button>
            </>
          )
        }
      >
        {o.needsAttention && (
          <div className="callout warn row between">
            <span>⚠️ {o.attentionReason}</span>
            <button onClick={() => void act(() => call('orders.clearFlag', { id: o.id }))}>Markér løst</button>
          </div>
        )}
        <dl className="kv">
          <dt>Kunde</dt>
          <dd>
            {o.customerName ?? '–'} · {o.customerPhone}{' '}
            {o.conversationId && <button className="link" onClick={() => nav.go('conversations', o.conversationId!)}>Åbn samtale</button>}
          </dd>
          <dt>Adresse</dt>
          <dd>{o.addressText ?? '–'} {o.addressText && !o.addressValidated && <span className="badge warn">ikke valideret</span>}</dd>
          <dt>Bemærkning</dt>
          <dd>{o.deliveryInstructions ?? '–'}</dd>
          <dt>Ønsket tid</dt>
          <dd>{o.requestedTime ?? 'Hurtigst muligt'}</dd>
          {o.windowEnd && (
            <>
              <dt>Aftalt tidsrum</dt>
              <dd>
                {time(o.windowStart)}–{time(o.windowEnd)} <span className="muted small">({o.windowKind === 'requested' ? 'kundens ønske' : 'tidligst muligt, accepteret af kunden'})</span>
              </dd>
            </>
          )}
          <dt>Chauffør</dt>
          <dd>{o.driverName ?? '–'}</dd>
          <dt>ETA</dt>
          <dd>
            {time(o.eta)}{o.etaLow && o.etaHigh ? ` (${time(o.etaLow)}–${time(o.etaHigh)})` : ''}{' '}
            {o.etaConfidence && <span className={`badge ${o.etaConfidence === 'high' ? 'ok' : o.etaConfidence === 'medium' ? 'info' : 'warn'}`}>{{ high: 'sikker', medium: 'middel', low: 'usikker' }[o.etaConfidence]}</span>}{' '}
            {o.etaSource && <span className="muted small">({{ route_live: 'trafikdata', route_simulated: 'simuleret', estimate: 'estimat – loves ikke til kunden' }[o.etaSource] ?? o.etaSource})</span>}
          </dd>
          <dt>Bestilt</dt>
          <dd>{dateTime(o.createdAt)}</dd>
          <dt>Betaling</dt>
          <dd>
            <select value={o.paymentStatus} onChange={(e) => void act(() => call('orders.updateFields', { id: o.id, paymentStatus: e.target.value }))} style={{ width: 'auto' }}>
              <option value="pending">Afventer (betales ved levering)</option>
              <option value="paid">Betalt</option>
              <option value="not_applicable">Ikke relevant</option>
            </select>
          </dd>
        </dl>
      </Card>
      <Card title="Varer">
        <table>
          <thead>
            <tr><th>Vare</th><th className="num">Antal</th><th className="num">Stk.pris</th><th className="num">I alt</th></tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id}><td>{l.productName}</td><td className="num">{l.quantity}</td><td className="num">{kr(l.unitPriceOre)}</td><td className="num">{kr(l.lineTotalOre)}</td></tr>
            ))}
            <tr><td colSpan={3}>Levering</td><td className="num">{kr(o.deliveryFeeOre)}</td></tr>
            <tr><td colSpan={3}><strong>Total</strong></td><td className="num"><strong>{kr(o.totalOre)}</strong></td></tr>
          </tbody>
        </table>
      </Card>
      <div className="grid cols-2">
        <Card title="Statushistorik og hændelser">
          <ul className="timeline">
            {events.map((e) => (
              <li key={e.id}>
                <div>
                  {e.type === 'status' ? <>{e.fromStatus ? ORDER_STATUS_LABELS[e.fromStatus] : 'Oprettet'} → <strong>{e.toStatus ? ORDER_STATUS_LABELS[e.toStatus] : ''}</strong></> : eventLabel(e)}
                </div>
                <div className="muted small">{dateTime(e.createdAt)} · {actorLabel(e.actor)}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Chaufførtilbud">
          {offers.length ? (
            <table>
              <tbody>
                {offers.map((f) => (
                  <tr key={f.id}><td>{f.driverName}</td><td><span className={`badge ${f.status === 'accepted' ? 'ok' : f.status === 'pending' ? 'info' : 'neutral'}`}>{offerLabel(f.status)}</span></td><td className="muted">{time(f.sentAt)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Ingen tilbud sendt.</Empty>
          )}
        </Card>
      </div>
      {modal === 'assign' && <AssignModal order={o} onClose={() => setModal(null)} />}
      {modal === 'edit' && <EditLinesModal order={o} onClose={() => setModal(null)} />}
      {modal === 'cancel' && <CancelModal order={o} onClose={() => setModal(null)} />}
      {modal === 'status' && <StatusModal order={o} onClose={() => setModal(null)} />}
    </div>
  );
}

function eventLabel(e: OrderEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case 'created': return 'Ordre oprettet';
    case 'lines_updated': return `Varer opdateret (total ${kr(Number(d.totalOre ?? 0))})`;
    case 'offer_sent': return `Tilbud sendt til ${d.driverName ?? 'chauffør'}`;
    case 'offer_rejected': return 'Chaufføren afviste';
    case 'offer_expired': return 'Tilbud udløb';
    case 'driver_arrived': return 'Chauffør fremme';
    case 'driver_delay': return `Chauffør melder ${d.minutes} min forsinkelse${d.reason ? ` (${d.reason})` : ''}`;
    case 'driver_eta': return `Chauffør: fremme om ca. ${d.minutes} min`;
    case 'eta_changed': return `ETA ændret ${time(String(d.from))} → ${time(String(d.to))} (${d.reason ?? ''})`;
    case 'customer_notified': return d.kind === 'arrival_soon' ? `Kunden fik "stå klar"-besked (${d.minutes} min)` : `Kunden fik ETA-opdatering (${Number(d.deltaMinutes) > 0 ? '+' : ''}${d.deltaMinutes} min)`;
    case 'plan_revalidated': return 'Ruteplan genberegnet før accept';
    case 'time_offer': return `Kunden fik tilbudt senere levering ${time(String(d.windowStart))}–${time(String(d.windowEnd))}`;
    case 'time_window_agreed': return `Kunden accepterede levering ${time(String(d.windowStart))}–${time(String(d.windowEnd))}`;
    case 'time_offer_unclear': return 'Kundens svar på leveringstid var uklart – spurgt igen';
    case 'queued': return `Sat i kø hos chauffør (forventet ca. ${time(String(d.eta))})`;
    case 'updated': {
      const names: Record<string, string> = { addressText: 'adresse', deliveryInstructions: 'bemærkning', requestedTime: 'ønsket tid', driverId: 'chauffør', paymentStatus: 'betaling', needsAttention: 'opmærksomhed', eta: 'ETA' };
      const keys = [...new Set(Object.keys(d).map((k) => names[k]).filter(Boolean))];
      return keys.length ? `Opdateret: ${keys.join(', ')}` : 'Opdateret';
    }
    default: return e.type;
  }
}
function actorLabel(a: string) {
  return { system: 'System', ai: 'AI', staff: 'Medarbejder', driver: 'Chauffør', customer: 'Kunde' }[a] ?? a;
}
function offerLabel(s: string) {
  return { pending: 'Afventer svar', accepted: 'Accepteret', rejected: 'Afvist', expired: 'Udløbet', cancelled: 'Annulleret' }[s] ?? s;
}

function AssignModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const { data: drivers } = useQuery<Driver[]>('drivers.list', {}, ['drivers']);
  const [driverId, setDriverId] = useState<number | ''>('');
  return (
    <Modal
      title={`Tildel chauffør – ordre #${order.id}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={() => void act(() => call('orders.redispatch', { id: order.id })).then((ok) => ok && (toast('Automatisk dispatch startet'), onClose()))}>Lad systemet vælge</button>
          <button className="primary" disabled={!driverId} onClick={() => void act(() => call('orders.assign', { id: order.id, driverId })).then((ok) => ok && onClose())}>Tildel</button>
        </>
      }
    >
      <p className="muted">Lagerreservationen flyttes automatisk til chaufførens bil, hvis bilen har varerne. Ellers skal varerne hentes på centrallageret.</p>
      <Field label="Chauffør">
        <select value={driverId} onChange={(e) => setDriverId(Number(e.target.value))}>
          <option value="">Vælg…</option>
          {drivers?.filter((d) => d.active).map((d) => (
            <option key={d.id} value={d.id}>{d.name} ({d.status}, {d.activeOrderCount}/{d.maxActiveOrders} ordrer)</option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function EditLinesModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const { data: products } = useQuery<Product[]>('products.list', {}, ['products']);
  const [lines, setLines] = useState(order.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })));
  return (
    <Modal
      title={`Ret varer – ordre #${order.id}`}
      onClose={onClose}
      footer={<button className="primary" onClick={() => void act(() => call('orders.editLines', { id: order.id, lines: lines.filter((l) => l.quantity > 0) })).then((ok) => ok && onClose())}>Gem</button>}
    >
      <p className="muted">Priser hentes fra kataloget. Lagerreservationen genberegnes atomisk – mangler der varer, gemmes intet.</p>
      {lines.map((l, i) => (
        <div key={i} className="row">
          <select value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: Number(e.target.value) } : x)))}>
            {products?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} – {kr(p.priceOre)}</option>)}
          </select>
          <input type="number" min={0} style={{ width: 80 }} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
        </div>
      ))}
      <button onClick={() => products?.[0] && setLines([...lines, { productId: products[0].id, quantity: 1 }])}>+ Tilføj vare</button>
    </Modal>
  );
}

function CancelModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  return (
    <Modal
      title={`Annullér ordre #${order.id}`}
      onClose={onClose}
      footer={<button className="danger solid" onClick={() => void act(() => call('orders.cancel', { id: order.id, reason, notifyCustomer: notify })).then((ok) => ok && onClose())}>Annullér ordre</button>}
    >
      <p>Lagerreservationen frigives. {order.driverName ? `${order.driverName} får besked via Telegram.` : ''}</p>
      <Field label="Årsag"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <label className="row"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Send SMS til kunden</label>
    </Modal>
  );
}

function StatusModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const options = allowedTransitions(order.status).filter((s) => s !== 'cancelled');
  const [to, setTo] = useState<OrderStatus | ''>('');
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={`Skift status – ordre #${order.id}`}
      onClose={onClose}
      footer={<button className="primary" disabled={!to} onClick={() => void act(() => call('orders.transition', { id: order.id, to, reason })).then((ok) => ok && onClose())}>Skift</button>}
    >
      <p className="muted">Kun statusskift, som ordretilstandsmaskinen tillader, kan vælges.</p>
      <Field label="Ny status">
        <select value={to} onChange={(e) => setTo(e.target.value as OrderStatus)}>
          <option value="">Vælg…</option>
          {options.map((s) => <option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>)}
        </select>
      </Field>
      <Field label="Begrundelse"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
