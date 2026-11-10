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
  const [mgr, setMgr] = useState('sim-mgr-leder');
  const [mgrText, setMgrText] = useState('Hvad har vi omsat for i dag?');
  const askAs = (text: string, who = mgr) => void act(() => call('demo.sendAsManager', { who, text })).then((ok) => ok && toast('Sendt til ledelsesgruppen (simuleret)'));
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
        <Card title="Ledelsesgruppe (Telegram, simuleret)" actions={<button onClick={() => nav.go('management')}>Åbn Ledelsescenter</button>}>
          <Field label="Skriv som">
            <select value={mgr} onChange={(e) => setMgr(e.target.value)}>
              <option value="sim-mgr-admin">Lise – administrator</option>
              <option value="sim-mgr-leder">Omar – leder</option>
              <option value="sim-mgr-obs">Jonas – observatør</option>
            </select>
          </Field>
          <Field label="Besked"><input value={mgrText} onChange={(e) => setMgrText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && askAs(mgrText)} /></Field>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => askAs(mgrText)}>Send</button>
            {['Hvad har vi omsat for i dag?', 'Hvor mange ordrer mangler vi?', 'Hvem er mest forsinket?', 'Vis mig alle lagerproblemer', 'Rapport'].map((q) => (
              <button key={q} onClick={() => askAs(q)}>{q}</button>
            ))}
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            {drivers?.slice(0, 3).map((d) => (
              <button key={d.id} onClick={() => askAs(`Hvordan går det med chauffør ${d.id}?`)}>Status chauffør {d.id}</button>
            ))}
            <button onClick={() => askAs('Flyt ordre 4 til chauffør 2', 'sim-mgr-obs')}>Observatør forsøger handling</button>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>Handlinger kræver bekræftelse via knappen, som vises i gruppechatten under Ledelsescenter → Gruppechat. I demo kan du bekræfte ved at skrive her som samme leder og trykke i Ledelsescenteret.</p>
        </Card>
        <Card title="Lageropfyldning (scenarie)">
          <p>Opretter 7 fiktive ordrer til én chauffør, som kun har cola nok til 5 stop. Systemet beregner lager efter hvert stop, finder det bedste opfyldningspunkt og sender et forslag til ledelsesgruppen.</p>
          <ol className="small">
            <li>Godkend forslaget (Ledelsescenter → Godkendelser, eller i Lageret).</li>
            <li>Den simulerede chauffør accepterer, kører til lageret efter det valgte stop og bekræfter afhentningen.</li>
            <li>Bilens lager øges først ved bekræftet afhentning (se Produkter og lager → Billager og opfyldning).</li>
          </ol>
          <button className="primary" style={{ marginTop: 8 }} onClick={() => void act(() => call<{ driverName: string; orderIds: number[] }>('demo.replenishmentScenario').then((r) => toast(`Scenarie startet for ${r.driverName}: ordrer ${r.orderIds.map((x) => '#' + x).join(', ')}`)))}>
            Start opfyldningsscenarie
          </button>
        </Card>
        <Card title="Alternative leveringstider (scenarie)" actions={<button onClick={() => nav.go('operations')}>Se forslag</button>}>
          <p className="muted small">
            Opretter en bekræftet ordre og sender – som når alle chauffører er fuldt booket – et forslag om senere levering via SMS. Den simulerede kunde svarer efter den valgte variant. Følg
            samtalen under Kundesamtaler.
          </p>
          <div className="row wrap" style={{ marginTop: 8 }}>
            {(
              [
                ['accept', 'Kunden accepterer'],
                ['other_time', 'Ønsker et andet tidspunkt'],
                ['earliest', 'Spørger om det tidligste'],
                ['decline', 'Afviser'],
                ['no_reply', 'Svarer ikke (udløber efter 10 min)'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} onClick={() => void act(() => call<{ phone: string; offerId: number | null }>('demo.altTimeScenario', { variant: v }).then((r) => toast(r.offerId ? `Forslag sendt til ${r.phone}` : 'Intet realistisk tidspunkt – sendt til medarbejder')))}>
                {label}
              </button>
            ))}
          </div>
        </Card>
        <Card title="Bilens kapacitet (scenarie)">
          <p className="muted small">Gør en bil næsten fuld og beregner opfyldning: kun de ordrer, der kan være i bilen, dækkes, og påfyldning vælges efter dækningsbidrag pr. lagerenhed. Begrundelsen ses i ledelsesgruppen.</p>
          <button style={{ marginTop: 8 }} onClick={() => void act(() => call<{ driverName: string; capacityUnits: number }>('demo.vehicleCapacityScenario').then((r) => toast(`${r.driverName}s bil har nu plads til ${r.capacityUnits} lagerenheder`)))}>
            Start kapacitetsscenarie
          </button>
        </Card>
        <Card title="Rapporter og proaktiv overvågning" actions={<button onClick={() => nav.go('operations')}>Åbn Drift og overvågning</button>}>
          <p className="muted small">Timerapporter sendes automatisk hver hele time i åbningstiden. Overvågningen klassificerer hændelser som A (automatisk), B (orientering), C (godkendelse) eller D (overtagelse).</p>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button onClick={() => askAs('Rapport')}>Bed om rapport i gruppen</button>
            <button onClick={() => void act(() => call('reports.sendNow')).then((ok) => ok && toast('Rapport sendt til ledelsesgruppen (simuleret)'))}>Send timerapport nu</button>
            <button onClick={() => void act(() => call('demo.telegramOutage', { on: true }).then(() => call('monitoring.evaluate'))).then((ok) => ok && toast('Telegram-udfald simuleret'))}>Simulér Telegram-udfald</button>
            <button onClick={() => void act(() => call('demo.telegramOutage', { on: false }).then(() => call('monitoring.evaluate'))).then((ok) => ok && toast('Telegram er tilbage'))}>Afslut udfald</button>
          </div>
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
