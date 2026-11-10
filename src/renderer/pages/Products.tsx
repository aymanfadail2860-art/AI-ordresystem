import { useState } from 'react';
import { act, call, useQuery } from '../api';
import { Card, Empty, Field, Modal, PageHeader, dateTime, kr } from '../components/ui';
import type { Product, StockLevel, StockLocation, StockMovement } from '../../shared/types';
import { VehicleStock } from './Replenishment';

interface Inv {
  locations: StockLocation[];
  levels: StockLevel[];
  products: Product[];
}

export function Products() {
  const [tab, setTab] = useState<'catalog' | 'stock' | 'vehicles' | 'movements'>('catalog');
  return (
    <>
      <PageHeader title="Produkter og lager" subtitle="Produktkatalog, priser, lagerlokationer (centrallager og biler) og lagerbevægelser." />
      <div className="tabs">
        <button className={`tab ${tab === 'catalog' ? 'active' : ''}`} onClick={() => setTab('catalog')}>Katalog og priser</button>
        <button className={`tab ${tab === 'stock' ? 'active' : ''}`} onClick={() => setTab('stock')}>Lagerbeholdning</button>
        <button className={`tab ${tab === 'vehicles' ? 'active' : ''}`} onClick={() => setTab('vehicles')}>Billager og opfyldning</button>
        <button className={`tab ${tab === 'movements' ? 'active' : ''}`} onClick={() => setTab('movements')}>Lagerbevægelser</button>
      </div>
      {tab === 'catalog' && <Catalog />}
      {tab === 'stock' && <Stock />}
      {tab === 'vehicles' && <VehicleStock embedded />}
      {tab === 'movements' && <Movements />}
    </>
  );
}

function Catalog() {
  const { data: products } = useQuery<Product[]>('products.list', {}, ['products']);
  const [edit, setEdit] = useState<Partial<Product> | null>(null);
  return (
    <Card title="Produkter" actions={<button className="primary" onClick={() => setEdit({ active: true, synonyms: [] })}>+ Nyt produkt</button>}>
      <table>
        <thead><tr><th>SKU</th><th>Navn</th><th>Kategori</th><th className="num">Pris</th><th className="num">Dækningsbidrag</th><th>Aktiv</th><th /></tr></thead>
        <tbody>
          {products?.map((p) => (
            <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
              <td><code>{p.sku}</code></td>
              <td>{p.name} {p.variant && <span className="muted">{p.variant}</span>}</td>
              <td>{p.category}</td>
              <td className="num">{kr(p.priceOre)}</td>
              <td className="num">{p.costOre != null ? `${kr(p.priceOre - p.costOre)} (${Math.round(((p.priceOre - p.costOre) / Math.max(1, p.priceOre)) * 100)} %)` : <span className="muted">estimeret</span>}</td>
              <td><input type="checkbox" checked={p.active} onChange={(e) => void act(() => call('products.setActive', { id: p.id, active: e.target.checked }))} /></td>
              <td><button className="link" onClick={() => setEdit(p)}>Redigér</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <ProductModal p={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function ProductModal({ p, onClose }: { p: Partial<Product>; onClose: () => void }) {
  const [f, setF] = useState({
    id: p.id,
    sku: p.sku ?? '',
    name: p.name ?? '',
    category: p.category ?? '',
    variant: p.variant ?? '',
    priceKr: p.priceOre != null ? p.priceOre / 100 : 0,
    costKr: p.costOre != null ? String(p.costOre / 100) : '',
    unitVolume: p.unitVolume ?? 1,
    description: p.description ?? '',
    synonyms: (p.synonyms ?? []).join(', '),
    active: p.active ?? true,
  });
  const save = () =>
    act(() => call('products.save', { ...f, synonyms: f.synonyms.split(',').map((s) => s.trim()).filter(Boolean) })).then((ok) => ok && onClose());
  return (
    <Modal title={p.id ? 'Redigér produkt' : 'Nyt produkt'} onClose={onClose} footer={<button className="primary" onClick={() => void save()}>Gem</button>}>
      <div className="form-grid">
        <Field label="SKU (varenummer)"><input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label="Pris (kr.)"><input type="number" step="0.5" min={0} value={f.priceKr} onChange={(e) => setF({ ...f, priceKr: Number(e.target.value) })} /></Field>
        <Field label="Vareomkostning (kr.)" hint="Indkøbspris – bruges til dækningsbidrag. Tom = standard-avance."><input type="number" step="0.5" min={0} value={f.costKr} onChange={(e) => setF({ ...f, costKr: e.target.value })} /></Field>
        <Field label="Plads (lagerenheder pr. stk.)" hint="1 = én dåse. Fx pose chips 3, pakke toiletpapir 8. Bruges til bilernes kapacitet."><input type="number" step="0.5" min={0.1} value={f.unitVolume} onChange={(e) => setF({ ...f, unitVolume: Number(e.target.value) })} /></Field>
        <Field label="Navn"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Variant"><input value={f.variant} placeholder="fx 50 cl" onChange={(e) => setF({ ...f, variant: e.target.value })} /></Field>
        <Field label="Kategori"><input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></Field>
        <Field label="Aktiv"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /></Field>
      </div>
      <Field label="Andre navne kunder bruger" hint="Kommasepareret – hjælper AI'en med at genkende produktet (fx: cola, coke)">
        <input value={f.synonyms} onChange={(e) => setF({ ...f, synonyms: e.target.value })} />
      </Field>
      <Field label="Beskrivelse" hint="Bruges til at besvare kundespørgsmål. Skriv ikke priser her – de tages fra prisfeltet.">
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
    </Modal>
  );
}

function Stock() {
  const { data } = useQuery<Inv>('inventory.overview', {}, ['inventory', 'products']);
  const [adjust, setAdjust] = useState<{ locationId: number; productId: number } | null>(null);
  const [transfer, setTransfer] = useState(false);
  if (!data) return <Empty>Indlæser…</Empty>;
  const lvl = (l: number, p: number) => data.levels.find((x) => x.locationId === l && x.productId === p);
  return (
    <Card title="Beholdning pr. lokation" actions={<button onClick={() => setTransfer(true)}>Overfør varer</button>}>
      <p className="muted small">Format: ledigt (reserveret). Klik på en celle for at regulere beholdningen.</p>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Produkt</th>
              {data.locations.map((l) => <th key={l.id} className="num">{l.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                {data.locations.map((l) => {
                  const v = lvl(l.id, p.id);
                  const free = (v?.quantity ?? 0) - (v?.reserved ?? 0);
                  return (
                    <td key={l.id} className="num clickable" style={{ cursor: 'pointer', color: free <= 0 ? 'var(--danger)' : undefined }} onClick={() => setAdjust({ locationId: l.id, productId: p.id })}>
                      {free}{v?.reserved ? <span className="muted"> ({v.reserved})</span> : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adjust && <AdjustModal {...adjust} data={data} onClose={() => setAdjust(null)} />}
      {transfer && <TransferModal data={data} onClose={() => setTransfer(false)} />}
    </Card>
  );
}

function AdjustModal({ locationId, productId, data, onClose }: { locationId: number; productId: number; data: Inv; onClose: () => void }) {
  const [delta, setDelta] = useState(0);
  const [note, setNote] = useState('');
  const loc = data.locations.find((l) => l.id === locationId)!;
  const prod = data.products.find((p) => p.id === productId)!;
  return (
    <Modal title={`Regulér ${prod.name} – ${loc.name}`} onClose={onClose} footer={<button className="primary" disabled={!delta} onClick={() => void act(() => call('inventory.adjust', { locationId, productId, delta, note })).then((ok) => ok && onClose())}>Gem</button>}>
      <Field label="Ændring (+ tilgang / − afgang)"><input type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} /></Field>
      <Field label="Note"><input value={note} placeholder="fx optælling, ny levering" onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

function TransferModal({ data, onClose }: { data: Inv; onClose: () => void }) {
  const [f, setF] = useState({ fromId: data.locations[0]?.id, toId: data.locations[1]?.id, productId: data.products[0]?.id, quantity: 1 });
  return (
    <Modal title="Overfør varer" onClose={onClose} footer={<button className="primary" onClick={() => void act(() => call('inventory.transfer', f)).then((ok) => ok && onClose())}>Overfør</button>}>
      <Field label="Fra"><select value={f.fromId} onChange={(e) => setF({ ...f, fromId: Number(e.target.value) })}>{data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      <Field label="Til"><select value={f.toId} onChange={(e) => setF({ ...f, toId: Number(e.target.value) })}>{data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      <Field label="Produkt"><select value={f.productId} onChange={(e) => setF({ ...f, productId: Number(e.target.value) })}>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Antal"><input type="number" min={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: Number(e.target.value) })} /></Field>
    </Modal>
  );
}

function Movements() {
  const { data } = useQuery<StockMovement[]>('inventory.movements', {}, ['inventory']);
  const reason: Record<string, string> = { reserve: 'Reservation', release: 'Frigivelse', deduct: 'Leveret', adjust: 'Regulering', restock: 'Tilgang', transfer: 'Overførsel' };
  return (
    <Card title="Lagerbevægelser">
      <table>
        <thead><tr><th>Tid</th><th>Lokation</th><th>Produkt</th><th>Type</th><th className="num">Antal</th><th className="num">Reserveret</th><th>Ordre</th><th>Note</th></tr></thead>
        <tbody>
          {data?.map((m) => (
            <tr key={m.id}>
              <td>{dateTime(m.createdAt)}</td><td>{m.locationName}</td><td>{m.productName}</td><td>{reason[m.reason] ?? m.reason}</td>
              <td className="num">{m.deltaQuantity || ''}</td><td className="num">{m.deltaReserved || ''}</td><td>{m.orderId ? `#${m.orderId}` : ''}</td><td className="muted">{m.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
