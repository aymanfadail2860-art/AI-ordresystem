import { useEffect, useState } from 'react';
import { act, call, useQuery } from '../api';
import { Card, DriverStatusBadge, Empty, Field, Modal, OrderStatusBadge, PageHeader, SimTag, ago, dateTime, time } from '../components/ui';
import type { Driver, DriverMessage, Order, Product, RouteStop, StockLevel } from '../../shared/types';
import type { Nav } from '../App';

interface Detail {
  driver: Driver;
  messages: DriverMessage[];
  orders: Order[];
  stock: StockLevel[];
  route: RouteStop[];
}

export function Drivers({ nav }: { nav: Nav }) {
  const { data: drivers } = useQuery<Driver[]>('drivers.list', {}, ['drivers', 'orders']);
  const [selected, setSelected] = useState<number | null>(nav.selected);
  const [creating, setCreating] = useState(false);
  useEffect(() => setSelected(nav.selected), [nav.selected]);
  return (
    <>
      <PageHeader title="Chauffører" subtitle="Chauffører kommunikerer via Telegram. Forbind en chauffør med en engangskode." actions={<button className="primary" onClick={() => setCreating(true)}>+ Ny chauffør</button>} />
      <div className="split">
        <Card>
          {drivers?.length ? (
            <table>
              <thead>
                <tr><th>Navn</th><th>Status</th><th>Telegram</th><th className="num">Ordrer</th></tr>
              </thead>
              <tbody>
                {drivers.map((d) => (
                  <tr key={d.id} className={`clickable ${selected === d.id ? 'selected' : ''}`} onClick={() => setSelected(d.id)}>
                    <td>{d.name}{!d.active && <span className="muted"> (inaktiv)</span>}</td>
                    <td><DriverStatusBadge status={d.status} /></td>
                    <td>{d.telegramUserId ? <span className="badge ok">Forbundet</span> : <span className="badge neutral">Ikke forbundet</span>}</td>
                    <td className="num">{d.activeOrderCount}/{d.maxActiveOrders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Ingen chauffører endnu.</Empty>
          )}
        </Card>
        {selected ? <DriverDetail id={selected} nav={nav} /> : <Card><Empty>Vælg en chauffør.</Empty></Card>}
      </div>
      {creating && <CreateDriverModal onClose={() => setCreating(false)} />}
    </>
  );
}

function DriverDetail({ id, nav }: { id: number; nav: Nav }) {
  const { data } = useQuery<Detail>('drivers.get', { id }, ['drivers', 'orders', 'inventory', 'logistics']);
  const { data: products } = useQuery<Product[]>('products.list', {}, ['products']);
  const [msg, setMsg] = useState('');
  if (!data) return <Card><Empty>Indlæser…</Empty></Card>;
  const { driver: d, messages, orders, stock, route } = data;
  const pname = (pid: number) => products?.find((p) => p.id === pid)?.name ?? `#${pid}`;
  return (
    <div className="stack">
      <Card
        title={<>{d.name} <DriverStatusBadge status={d.status} /></>}
        actions={
          <select value={d.status} style={{ width: 'auto' }} onChange={(e) => void act(() => call('drivers.setStatus', { id: d.id, status: e.target.value }))}>
            <option value="available">Ledig</option>
            <option value="busy">Optaget</option>
            <option value="break">Pause</option>
            <option value="offline">Offline</option>
          </select>
        }
      >
        <dl className="kv">
          <dt>Telefon</dt><dd>{d.phone ?? '–'}</dd>
          <dt>Køretøj</dt><dd>{d.vehicleName ?? '–'}</dd>
          <dt>Maks. samtidige</dt><dd>{d.maxActiveOrders} ordrer</dd>
          <dt>Telegram</dt>
          <dd>
            {d.telegramUserId ? (
              <>Forbundet {d.telegramUserId.startsWith('sim-') && <SimTag />} <button className="link" onClick={() => void act(() => call('drivers.unlinkTelegram', { id: d.id }))}>Fjern forbindelse</button></>
            ) : (
              <>
                Engangskode: <code>{d.telegramLinkCode}</code> – chaufføren skriver <code>/start {d.telegramLinkCode}</code> til botten.{' '}
                <button className="link" onClick={() => void act(() => call('drivers.regenerateCode', { id: d.id }))}>Ny kode</button>
              </>
            )}
          </dd>
          <dt>Position</dt>
          <dd>
            {d.lastPositionAt ? `${d.lastLat?.toFixed(4)}, ${d.lastLng?.toFixed(4)} · ${ago(d.lastPositionAt)} (${d.lastPositionSource})` : 'Ingen position'}
            <div className="muted small">Positioner kommer kun fra chaufførens delte Telegram-live-position – der bruges aldrig fiktive GPS-data i drift.</div>
          </dd>
        </dl>
      </Card>
      <div className="grid cols-2">
        <Card title="Aktive leveringer og rute">
          {route.length ? (
            <table>
              <tbody>
                {route.map((r) => (
                  <tr key={r.orderId} className="clickable" onClick={() => nav.go('orders', r.orderId)}>
                    <td>{r.sequence}.</td><td>#{r.orderId}</td><td className="truncate">{r.address}</td><td>{time(r.eta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : orders.filter((o) => ['driver_assigned', 'out_for_delivery'].includes(o.status)).length ? (
            <Empty>Rute ikke beregnet endnu.</Empty>
          ) : (
            <Empty>Ingen aktive leveringer.</Empty>
          )}
        </Card>
        <Card title="Lager i bilen">
          {stock.length ? (
            <table>
              <thead><tr><th>Vare</th><th className="num">Beholdning</th><th className="num">Reserveret</th></tr></thead>
              <tbody>
                {stock.filter((s) => s.quantity > 0).map((s) => (
                  <tr key={s.productId}><td>{pname(s.productId)}</td><td className="num">{s.quantity}</td><td className="num">{s.reserved}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Intet lager registreret.</Empty>
          )}
        </Card>
      </div>
      <Card title="Telegram-beskeder">
        <div className="chat">
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.direction === 'in' ? 'in' : 'out system'}`}>
              {m.body}
              <div className="bubble-meta">{dateTime(m.createdAt)}{m.simulated && <SimTag />}</div>
            </div>
          ))}
          {!messages.length && <Empty>Ingen beskeder.</Empty>}
        </div>
        <div className="composer">
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Besked til chaufføren via Telegram…" />
          <button className="primary" onClick={() => void act(() => call('drivers.sendMessage', { id: d.id, text: msg })).then((ok) => ok && setMsg(''))}>Send</button>
        </div>
      </Card>
      <Card title="Seneste ordrer">
        <table>
          <tbody>
            {orders.slice(0, 10).map((o) => (
              <tr key={o.id} className="clickable" onClick={() => nav.go('orders', o.id)}>
                <td>#{o.id}</td><td><OrderStatusBadge status={o.status} /></td><td className="truncate">{o.addressText}</td><td>{dateTime(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function CreateDriverModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', vehicleName: '', maxActiveOrders: 4 });
  return (
    <Modal title="Ny chauffør" onClose={onClose} footer={<button className="primary" onClick={() => void act(() => call('drivers.create', f)).then((ok) => ok && onClose())}>Opret</button>}>
      <Field label="Navn"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Telefon"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label="Køretøj" hint="Der oprettes automatisk en lagerlokation for bilen."><input value={f.vehicleName} onChange={(e) => setF({ ...f, vehicleName: e.target.value })} /></Field>
      <Field label="Maks. samtidige ordrer"><input type="number" min={1} max={20} value={f.maxActiveOrders} onChange={(e) => setF({ ...f, maxActiveOrders: Number(e.target.value) })} /></Field>
    </Modal>
  );
}
