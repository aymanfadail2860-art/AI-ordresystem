import { useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Field, PageHeader } from '../components/ui';
import type { Driver } from '../../shared/types';
import type { Nav } from '../App';

interface DemoStatus {
  enabled: boolean;
  activeBots: number;
  autoTraffic: boolean;
  scenarios: { id: string; title: string }[];
}

/** Demo-konsol: styr simulerede kunder og chauffører. Sender aldrig rigtige beskeder. */
export function DemoConsole({ nav }: { nav: Nav }) {
  const { data: st, reload } = useQuery<DemoStatus>('demo.status', {}, ['settings', 'conversations']);
  const { data: drivers } = useQuery<Driver[]>('drivers.list', {}, ['drivers']);
  const [phone, setPhone] = useState('+4599995555');
  const [text, setText] = useState('Hej! Kan I levere 2 Red Bull og 1 Kartoffelchips til Demovej 22, 2200 København N?');
  const [staffText, setStaffText] = useState('Hej, det er Lise fra kontoret – jeg hjælper dig videre.');
  const [driverId, setDriverId] = useState<number | ''>('');
  const [driverText, setDriverText] = useState('Jeg bliver 15 minutter forsinket');
  if (!st) return null;

  return (
    <>
      <PageHeader title="Demo-konsol" subtitle="Simulér kunder, medarbejdere og chauffører. Alt foregår i den simulerede SMS- og Telegram-forbindelse." />
      <div className="grid cols-2">
        <Card title="Automatisk trafik">
          <label className="row">
            <input type="checkbox" checked={st.autoTraffic} onChange={(e) => void act(() => call('demo.setAutoTraffic', { enabled: e.target.checked })).then(reload)} />
            Generér løbende nye kundebestillinger ({st.activeBots} aktive simulerede kunder)
          </label>
          <p className="muted small" style={{ marginTop: 8 }}>Simulerede chauffører accepterer tilbud, kører ud, sender positioner, melder somme tider forsinkelse eller "kunden svarer ikke", og bekræfter levering.</p>
        </Card>
        <Card title="Start et scenarie">
          <div className="stack">
            {st.scenarios.map((s) => (
              <div key={s.id} className="row between">
                <span>{s.title}</span>
                <button onClick={() => void act(() => call<{ phone: string }>('demo.startScenario', { id: s.id }).then((r) => toast(`Scenarie startet fra ${r.phone}`)))}>Start</button>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Skriv som kunde (SMS)">
          <Field label="Kundens nummer"><input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Besked"><textarea value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => void act(() => call('demo.sendAsCustomer', { phone, text })).then((ok) => ok && toast('SMS modtaget (simuleret)'))}>Send SMS</button>
            <button onClick={() => nav.go('conversations')}>Se samtaler</button>
          </div>
        </Card>
        <Card title="Simulér manuelt svar fra virksomhedens iPhone">
          <p className="muted small">Tester Human Takeover: en udgående besked, som systemet ikke selv har sendt, sætter samtalen til manuel overtagelse.</p>
          <Field label="Til nummer"><input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Besked"><textarea value={staffText} onChange={(e) => setStaffText(e.target.value)} /></Field>
          <button style={{ marginTop: 8 }} onClick={() => void act(() => call('demo.sendAsStaffFromPhone', { phone, text: staffText })).then((ok) => ok && toast('Manuel besked registreret'))}>Send fra "iPhone"</button>
        </Card>
        <Card title="Skriv som chauffør (Telegram)">
          <Field label="Chauffør">
            <select value={driverId} onChange={(e) => setDriverId(Number(e.target.value))}>
              <option value="">Vælg…</option>
              {drivers?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Besked" hint='Prøv fx "Jeg er fremme", "Kunden svarer ikke", "Jeg har ikke flere Red Bull", "Ordre 12 er leveret"'>
            <input value={driverText} onChange={(e) => setDriverText(e.target.value)} />
          </Field>
          <button className="primary" style={{ marginTop: 8 }} disabled={!driverId} onClick={() => void act(() => call('demo.sendAsDriver', { driverId, text: driverText })).then((ok) => ok && toast('Telegram-besked modtaget (simuleret)'))}>Send</button>
        </Card>
      </div>
    </>
  );
}
