import { useEffect, useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Empty, Field, IntegrationBadge, Modal, PageHeader, dateTime } from '../components/ui';
import type { BackupInfo, IntegrationStatus, Settings } from '../../shared/types';

type Tab = 'company' | 'integrations' | 'delivery' | 'logistics' | 'messages' | 'security' | 'system';

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('company');
  const { data: s, reload } = useQuery<Settings>('settings.get', {}, ['settings']);
  if (!s) return <Empty>Indlæser…</Empty>;
  const tabs: [Tab, string][] = [
    ['company', 'Virksomhed'],
    ['integrations', 'Integrationer'],
    ['delivery', 'Levering og priser'],
    ['logistics', 'Logistik og økonomi'],
    ['messages', 'Standardbeskeder'],
    ['security', 'Sikkerhed, backup og GDPR'],
    ['system', 'System'],
  ];
  return (
    <>
      <PageHeader title="Indstillinger" subtitle="Alle indstillinger er pr. installation – ingen kodeændringer nødvendige." />
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'company' && <CompanyTab s={s} onSaved={reload} />}
      {tab === 'integrations' && <IntegrationsTab s={s} />}
      {tab === 'delivery' && <DeliveryTab s={s} />}
      {tab === 'logistics' && <LogisticsTab s={s} />}
      {tab === 'messages' && <MessagesTab s={s} />}
      {tab === 'security' && <SecurityTab s={s} />}
      {tab === 'system' && <SystemTab />}
    </>
  );
}

function save(patch: Record<string, unknown>) {
  return act(() => call('settings.update', { patch })).then((ok) => ok && toast('Gemt'));
}

export function CompanyTab({ s, onSaved }: { s: Settings; onSaved?: () => void }) {
  const [c, setC] = useState(s.company);
  return (
    <Card title="Virksomhedsoplysninger" actions={<button className="primary" onClick={() => void save({ company: c }).then(() => onSaved?.())}>Gem</button>}>
      <div className="form-grid">
        <Field label="Virksomhedsnavn" hint="Bruges i beskeder til kunder"><input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
        <Field label="Telefon (kundeservice)" hint="Vises når en chauffør ikke kan få kontakt"><input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></Field>
        <Field label="E-mail"><input value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
        <Field label="CVR"><input value={c.cvr} onChange={(e) => setC({ ...c, cvr: e.target.value })} /></Field>
        <Field label="Adresse"><input value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} /></Field>
      </div>
    </Card>
  );
}

const SECRET_LABELS: Record<string, { label: string; integration: 'ai' | 'telegram' | 'maps'; help: string }> = {
  anthropic_api_key: { label: 'Claude API-nøgle', integration: 'ai', help: 'Opret på console.anthropic.com under virksomhedens egen konto.' },
  telegram_bot_token: { label: 'Telegram bot-token', integration: 'telegram', help: 'Opret en bot hos @BotFather i Telegram og indsæt token.' },
  google_maps_api_key: { label: 'Google Maps API-nøgle', integration: 'maps', help: 'Kræver Geocoding API og Routes API aktiveret i Google Cloud.' },
};

export function IntegrationsTab({ s }: { s: Settings }) {
  const { data: secrets } = useQuery<{ secure: boolean; keys: Record<string, string | null> }>('secrets.status', {}, ['settings', 'integrations']);
  const { data: ints } = useQuery<IntegrationStatus[]>('integrations.list', {}, ['integrations']);
  const { data: info } = useQuery<{ mode: string }>('system.info', {}, ['settings']);
  const [editing, setEditing] = useState<string | null>(null);
  const [sms, setSms] = useState(s.sms);
  const st = (n: string) => ints?.find((i) => i.name === n);
  const test = (name: string) => void call<{ ok: boolean; message: string }>('integrations.test', { name }).then((r) => toast(r.message, r.ok ? 'info' : 'error'));
  const isDemo = info?.mode === 'demo';

  return (
    <div className="stack">
      {isDemo && <div className="callout">Demo Mode bruger kun simulerede integrationer. Nøgler og forbindelser her bruges først, når der skiftes til produktion (Indstillinger → System).</div>}
      {secrets && !secrets.secure && <div className="callout warn">Sikker nøglelagring (macOS Keychain) er ikke tilgængelig i dette miljø. Nøgler gemmes kun midlertidigt.</div>}
      <Card title={<>Apple Messages (SMS) {st('sms') && <IntegrationBadge state={st('sms')!.state} />}</>} actions={<><button onClick={() => test('sms')}>Test</button><button className="primary" onClick={() => void save({ sms })}>Gem</button></>}>
        <p className="muted">{st('sms')?.message}</p>
        <div className="callout warn">
          SMS sendes og modtages via Beskeder på denne Mac med <strong>imsg</strong>. Kræver: Videresendelse af SMS slået til på virksomhedens iPhone, "Fuld diskadgang" og "Automatisering → Beskeder" for AI Dispatch. Integrationen er <strong>ikke produktionsverificeret</strong>, før Proof of Concept-testen i INTEGRATIONS.md er gennemført på rigtig hardware.
        </div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <Field label="Backend">
            <select value={sms.backend} onChange={(e) => setSms({ ...sms, backend: e.target.value as 'imsg' | 'none' })}>
              <option value="imsg">imsg (Apple Messages)</option>
              <option value="none">Ingen (kun manuel)</option>
            </select>
          </Field>
          <Field label="Sti til imsg" hint="fx /opt/homebrew/bin/imsg eller den medfølgende kopi"><input value={sms.imsgPath} onChange={(e) => setSms({ ...sms, imsgPath: e.target.value })} /></Field>
          <Field label="Tjeneste" hint="'sms' tvinger grøn SMS. 'auto' kan bruge iMessage, hvis kunden har det.">
            <select value={sms.service} onChange={(e) => setSms({ ...sms, service: e.target.value as 'sms' | 'auto' })}>
              <option value="sms">Kun SMS</option>
              <option value="auto">Automatisk (iMessage/SMS)</option>
            </select>
          </Field>
          <Field label="Region (telefonnumre)"><input value={sms.region} onChange={(e) => setSms({ ...sms, region: e.target.value })} /></Field>
        </div>
      </Card>
      {Object.entries(SECRET_LABELS).map(([name, meta]) => (
        <Card key={name} title={<>{meta.label} {st(meta.integration) && <IntegrationBadge state={st(meta.integration)!.state} />}</>} actions={<><button onClick={() => test(meta.integration)}>Test</button><button onClick={() => setEditing(name)}>{secrets?.keys[name] ? 'Udskift' : 'Indtast'}</button>{secrets?.keys[name] && <button className="danger" onClick={() => void act(() => call('secrets.delete', { name }))}>Slet</button>}</>}>
          <p>Gemt nøgle: {secrets?.keys[name] ? <code>{secrets.keys[name]}</code> : <span className="muted">ingen</span>}</p>
          <p className="muted small">{meta.help} Nøglen gemmes krypteret via macOS Keychain – aldrig i databasen.</p>
          <p className="muted small">{st(meta.integration)?.message}</p>
        </Card>
      ))}
      {editing && <SecretModal name={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SecretModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [v, setV] = useState('');
  return (
    <Modal title={SECRET_LABELS[name].label} onClose={onClose} footer={<button className="primary" onClick={() => void act(() => call('secrets.set', { name, value: v })).then((ok) => ok && (toast('Nøgle gemt'), onClose()))}>Gem sikkert</button>}>
      <Field label="Nøgle" hint={SECRET_LABELS[name].help}><input type="password" autoFocus value={v} onChange={(e) => setV(e.target.value)} /></Field>
    </Modal>
  );
}

export function DeliveryTab({ s }: { s: Settings }) {
  const [d, setD] = useState(s.delivery);
  const [p, setP] = useState(s.pricing);
  const [h, setH] = useState(s.openingHours);
  const days: [keyof Settings['openingHours'], string][] = [['mon', 'Mandag'], ['tue', 'Tirsdag'], ['wed', 'Onsdag'], ['thu', 'Torsdag'], ['fri', 'Fredag'], ['sat', 'Lørdag'], ['sun', 'Søndag']];
  return (
    <div className="stack">
      <Card title="Leveringsområde" actions={<button className="primary" onClick={() => void save({ delivery: { ...d, postalCodes: d.postalCodes } })}>Gem</button>}>
        <div className="form-grid">
          <Field label="Centrum – breddegrad"><input type="number" step="0.0001" value={d.centerLat} onChange={(e) => setD({ ...d, centerLat: Number(e.target.value) })} /></Field>
          <Field label="Centrum – længdegrad"><input type="number" step="0.0001" value={d.centerLng} onChange={(e) => setD({ ...d, centerLng: Number(e.target.value) })} /></Field>
          <Field label="Radius (km)"><input type="number" min={1} value={d.radiusKm} onChange={(e) => setD({ ...d, radiusKm: Number(e.target.value) })} /></Field>
          <Field label="Tilladte postnumre" hint="Kommasepareret. Tom = kun radius."><input value={d.postalCodes.join(', ')} onChange={(e) => setD({ ...d, postalCodes: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
          <Field label="Tilbud gælder (minutter)"><input type="number" min={5} value={d.quoteExpiryMinutes} onChange={(e) => setD({ ...d, quoteExpiryMinutes: Number(e.target.value) })} /></Field>
          <Field label="Chauffør skal svare inden (sek.)"><input type="number" min={30} value={d.offerTimeoutSeconds} onChange={(e) => setD({ ...d, offerTimeoutSeconds: Number(e.target.value) })} /></Field>
          <Field label="Pakketid på centrallager (min.)"><input type="number" min={0} value={d.defaultPrepMinutes} onChange={(e) => setD({ ...d, defaultPrepMinutes: Number(e.target.value) })} /></Field>
          <label className="row"><input type="checkbox" checked={d.allowCentralPickup} onChange={(e) => setD({ ...d, allowCentralPickup: e.target.checked })} /> Chauffører kan hente varer på centrallageret</label>
        </div>
      </Card>
      <Card title="Priser og gebyrer" actions={<button className="primary" onClick={() => void save({ pricing: p })}>Gem</button>}>
        <div className="form-grid">
          <Field label="Leveringsgebyr (kr.)"><input type="number" min={0} value={p.deliveryFeeOre / 100} onChange={(e) => setP({ ...p, deliveryFeeOre: Math.round(Number(e.target.value) * 100) })} /></Field>
          <Field label="Gratis levering fra (kr.)" hint="0 = aldrig gratis"><input type="number" min={0} value={p.freeDeliveryThresholdOre / 100} onChange={(e) => setP({ ...p, freeDeliveryThresholdOre: Math.round(Number(e.target.value) * 100) })} /></Field>
          <Field label="Mindstekøb (kr.)"><input type="number" min={0} value={p.minimumOrderOre / 100} onChange={(e) => setP({ ...p, minimumOrderOre: Math.round(Number(e.target.value) * 100) })} /></Field>
        </div>
      </Card>
      <Card title="Åbningstider" actions={<button className="primary" onClick={() => void save({ openingHours: h })}>Gem</button>}>
        <p className="muted small">Lukketid før åbningstid betyder åbent over midnat. 00:00–00:00 = døgnåbent. Uden for åbningstid sendes standardbeskeden "lukket".</p>
        <table>
          <tbody>
            {days.map(([k, label]) => (
              <tr key={k}>
                <td>{label}</td>
                <td><input type="time" value={h[k].open} disabled={h[k].closed} onChange={(e) => setH({ ...h, [k]: { ...h[k], open: e.target.value } })} /></td>
                <td><input type="time" value={h[k].close} disabled={h[k].closed} onChange={(e) => setH({ ...h, [k]: { ...h[k], close: e.target.value } })} /></td>
                <td><label className="row"><input type="checkbox" checked={h[k].closed} onChange={(e) => setH({ ...h, [k]: { ...h[k], closed: e.target.checked } })} /> Lukket</label></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function MessagesTab({ s }: { s: Settings }) {
  const [m, setM] = useState(s.messages);
  const labels: Record<keyof Settings['messages'], string> = {
    greeting: 'Velkomst',
    closed: 'Lukket',
    outsideArea: 'Uden for leveringsområde',
    handoffToHuman: 'Overdragelse til medarbejder',
    orderConfirmed: 'Ordre bekræftet',
    delivered: 'Leveret',
  };
  return (
    <Card title="Standardbeskeder" actions={<button className="primary" onClick={() => void save({ messages: m })}>Gem</button>}>
      <p className="muted small">Pladsholdere: {'{company}'}, {'{orderId}'}, {'{nextOpen}'}. Priser og totaler indsættes altid af systemet.</p>
      <div className="stack">
        {(Object.keys(labels) as (keyof Settings['messages'])[]).map((k) => (
          <Field key={k} label={labels[k]}><textarea value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} /></Field>
        ))}
      </div>
    </Card>
  );
}

function SecurityTab({ s }: { s: Settings }) {
  const { data: auth, reload } = useQuery<{ hasPin: boolean; unlocked: boolean }>('auth.status', {}, ['settings']);
  const { data: backups, reload: reloadBackups } = useQuery<BackupInfo[]>('backup.list', {}, ['settings']);
  const [pin, setPin] = useState({ pin: '', currentPin: '' });
  const [ret, setRet] = useState(s.retention);
  const [bk, setBk] = useState(s.backup);
  const [q, setQ] = useState('');
  const [customers, setCustomers] = useState<{ id: number; phone: string; name: string | null }[]>([]);
  useEffect(() => {
    void call<typeof customers>('gdpr.searchCustomers', { query: q }).then(setCustomers).catch(() => undefined);
  }, [q]);
  const exportCustomer = async (id: number) => {
    const data = await call('gdpr.exportCustomer', { id });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kunde-${id}-eksport.json`;
    a.click();
  };
  return (
    <div className="stack">
      <Card title="Administrator-PIN" actions={auth?.unlocked && auth.hasPin && <button onClick={() => void call('auth.lock').then(reload)}>Lås nu</button>}>
        <p className="muted">PIN kræves til API-nøgler, backup/gendannelse, persondata, auditlog og systemindstillinger. {auth?.hasPin ? 'PIN er sat.' : 'Ingen PIN sat endnu – sæt en før drift.'}</p>
        <div className="form-grid">
          {auth?.hasPin && <Field label="Nuværende PIN"><input type="password" value={pin.currentPin} onChange={(e) => setPin({ ...pin, currentPin: e.target.value })} /></Field>}
          <Field label="Ny PIN (4–8 cifre)"><input type="password" value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value })} /></Field>
        </div>
        <button className="primary" style={{ marginTop: 8 }} onClick={() => void act(() => call('auth.setPin', pin)).then((ok) => { if (ok) { toast('PIN gemt'); setPin({ pin: '', currentPin: '' }); void reload(); } })}>Gem PIN</button>
      </Card>
      <Card title="Backup og gendannelse" actions={<><button onClick={() => void act(() => call('backup.create')).then((ok) => { if (ok) { toast('Backup oprettet'); void reloadBackups(); } })}>Tag backup nu</button><button className="primary" onClick={() => void save({ backup: bk })}>Gem</button></>}>
        <div className="form-grid">
          <label className="row"><input type="checkbox" checked={bk.enabled} onChange={(e) => setBk({ ...bk, enabled: e.target.checked })} /> Automatisk backup</label>
          <Field label="Interval (timer)"><input type="number" min={1} value={bk.intervalHours} onChange={(e) => setBk({ ...bk, intervalHours: Number(e.target.value) })} /></Field>
          <Field label="Behold antal"><input type="number" min={1} value={bk.keep} onChange={(e) => setBk({ ...bk, keep: Number(e.target.value) })} /></Field>
        </div>
        <table style={{ marginTop: 10 }}>
          <tbody>
            {backups?.map((b) => (
              <tr key={b.file}>
                <td><code>{b.file}</code></td><td>{dateTime(b.createdAt)}</td><td className="num">{(b.sizeBytes / 1024).toFixed(0)} KB</td>
                <td><button onClick={() => confirm(`Gendan ${b.file}? Programmet genstarter, og nuværende data erstattes (der tages backup først).`) && void act(() => call('backup.restore', { file: b.file }))}>Gendan</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!backups?.length && <Empty>Ingen backups endnu.</Empty>}
      </Card>
      <Card title="Dataopbevaring (GDPR)" actions={<><button onClick={() => void act(() => call('retention.run')).then((ok) => ok && toast('Oprydning kørt'))}>Kør oprydning nu</button><button className="primary" onClick={() => void save({ retention: ret })}>Gem</button></>}>
        <div className="form-grid">
          <Field label="Slet beskedindhold efter (dage)"><input type="number" min={7} value={ret.messageBodyDays} onChange={(e) => setRet({ ...ret, messageBodyDays: Number(e.target.value) })} /></Field>
          <Field label="Anonymisér inaktive kunder efter (dage)"><input type="number" min={30} value={ret.inactiveCustomerDays} onChange={(e) => setRet({ ...ret, inactiveCustomerDays: Number(e.target.value) })} /></Field>
          <Field label="Slet hændelseslog efter (dage)"><input type="number" min={7} value={ret.eventLogDays} onChange={(e) => setRet({ ...ret, eventLogDays: Number(e.target.value) })} /></Field>
        </div>
      </Card>
      <Card title="Registreredes rettigheder (indsigt og sletning)">
        <Field label="Søg kunde (telefon eller navn)"><input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <table>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.phone}</td><td>{c.name ?? '–'}</td>
                <td><button onClick={() => void act(() => exportCustomer(c.id))}>Eksportér data</button></td>
                <td><button className="danger" onClick={() => confirm('Anonymisér kunden? Telefonnummer, navn, adresser og beskeder fjernes permanent.') && void act(() => call('gdpr.anonymizeCustomer', { id: c.id })).then(() => setQ(q + ''))}>Anonymisér</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <AuditCard />
    </div>
  );
}

function AuditCard() {
  const [rows, setRows] = useState<{ id: number; actor: string; action: string; entity: string | null; entityId: string | null; createdAt: string }[] | null>(null);
  return (
    <Card title="Auditlog (følsomme handlinger)" actions={<button onClick={() => void act(() => call<typeof rows>('audit.list').then(setRows))}>Vis</button>}>
      {rows ? (
        <table>
          <tbody>
            {rows.map((r) => <tr key={r.id}><td>{dateTime(r.createdAt)}</td><td>{r.actor}</td><td>{r.action}</td><td>{r.entity} {r.entityId}</td></tr>)}
          </tbody>
        </table>
      ) : (
        <p className="muted">Kræver PIN.</p>
      )}
    </Card>
  );
}

function SystemTab() {
  const { data: info } = useQuery<{ mode: string; version: string; platform: string; dataDir: string; schemaVersion: number; jobs: { pending: number; running: number; dead: number }; secretsSecure: boolean }>('system.info', {}, ['settings']);
  if (!info) return <Empty>Indlæser…</Empty>;
  const switchTo = info.mode === 'demo' ? 'production' : 'demo';
  return (
    <div className="stack">
      <Card title="Installationstilstand">
        <p>
          Aktuel tilstand: <strong>{info.mode === 'demo' ? 'Demo Mode' : 'Produktion'}</strong>. Demo og produktion har hver sin database – demodata blandes aldrig med rigtige data.
        </p>
        <button className={switchTo === 'production' ? 'primary' : ''} onClick={() => confirm(`Skift til ${switchTo === 'production' ? 'PRODUKTION (rigtige SMS og Telegram-beskeder)' : 'Demo Mode'}?`) && void act(() => call('system.setMode', { mode: switchTo }))}>
          Skift til {switchTo === 'production' ? 'produktion' : 'Demo Mode'}
        </button>
      </Card>
      <Card title="Systeminformation">
        <dl className="kv">
          <dt>Version</dt><dd>{info.version}</dd>
          <dt>Platform</dt><dd>{info.platform}</dd>
          <dt>Datamappe</dt><dd><code>{info.dataDir}</code></dd>
          <dt>Databaseskema</dt><dd>v{info.schemaVersion}</dd>
          <dt>Jobkø</dt><dd>{info.jobs.pending} ventende · {info.jobs.running} kører · {info.jobs.dead} fejlede</dd>
          <dt>Nøglelagring</dt><dd>{info.secretsSecure ? 'macOS Keychain (krypteret)' : 'Ikke sikker (kun hukommelse)'}</dd>
        </dl>
      </Card>
    </div>
  );
}

type NumField<T> = { key: keyof T; label: string; hint?: string; unit?: 'kr' | 'min' | 'pct' | 'n' };

function NumGrid<T extends Record<string, unknown>>({ value, fields, onChange }: { value: T; fields: NumField<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="form-grid">
      {fields.map((f) => {
        const raw = Number(value[f.key]);
        const shown = f.unit === 'kr' ? raw / 100 : raw;
        return (
          <Field key={String(f.key)} label={`${f.label}${f.unit === 'kr' ? ' (kr.)' : f.unit === 'min' ? ' (min)' : f.unit === 'pct' ? ' (%)' : ''}`} hint={f.hint}>
            <input
              type="number"
              step={f.unit === 'kr' ? 0.5 : 1}
              min={0}
              value={shown}
              onChange={(e) => onChange({ ...value, [f.key]: f.unit === 'kr' ? Math.round(Number(e.target.value) * 100) : Number(e.target.value) })}
            />
          </Field>
        );
      })}
    </div>
  );
}

function LogisticsTab({ s }: { s: Settings }) {
  const [l, setL] = useState(s.logistics);
  const [n, setN] = useState(s.notifications);
  const [e, setE] = useState(s.economics);
  return (
    <div className="stack">
      <div className="callout">
        AI Dispatch bruger ikke live-GPS. ETA'er beregnes ud fra chaufførernes Telegram-meldinger, bekræftede leveringer, planlagte ruter, køretider og tidligere forsinkelser.
        Beslutningsmodellen er deterministisk – Claude bruges kun til at forstå beskeder.
      </div>
      <Card title="Chaufførstatus og ETA" actions={<button className="primary" onClick={() => void save({ logistics: l })}>Gem</button>}>
        <NumGrid
          value={l}
          onChange={setL}
          fields={[
            { key: 'statusStaleMinutes', label: 'Status forældet efter', unit: 'min', hint: "Herefter er ETA'er usikre og loves ikke til kunder" },
            { key: 'statusRequestAfterMinutes', label: 'Bed om status efter', unit: 'min' },
            { key: 'escalateNoStatusMinutes', label: 'Eskalér til medarbejder efter', unit: 'min' },
            { key: 'serviceMinutesPerStop', label: 'Tid pr. aflevering', unit: 'min' },
            { key: 'historicalBufferMaxMinutes', label: 'Maks. historisk tillæg pr. stop', unit: 'min', hint: 'Beregnes af tidligere forsinkelser' },
            { key: 'extraCapacityMinutes', label: '"Kan tage ekstra ordre" gælder i', unit: 'min' },
          ]}
        />
      </Card>
      <Card title="Kundeopdateringer om ETA" actions={<button className="primary" onClick={() => void save({ notifications: n })}>Gem</button>}>
        <NumGrid
          value={n as unknown as Record<string, unknown>}
          onChange={(v) => setN(v as unknown as typeof n)}
          fields={[
            { key: 'lateThresholdMinutes', label: 'Opdatér kunden ved forsinkelse på mindst', unit: 'min' },
            { key: 'earlyThresholdMinutes', label: 'Opdatér kunden ved fremrykning på mindst', unit: 'min' },
            { key: 'minMinutesBetweenUpdates', label: 'Mindst tid mellem opdateringer', unit: 'min' },
            { key: 'maxUpdatesPerOrder', label: 'Maks. opdateringer pr. ordre', unit: 'n' },
            { key: 'arrivalSoonMaxMinutes', label: '"Stå klar"-besked når chaufføren melder højst', unit: 'min' },
          ]}
        />
        <Field label='"Stå klar"-besked' hint="{minutes} erstattes af antal minutter"><textarea value={n.arrivalSoonTemplate} onChange={(ev) => setN({ ...n, arrivalSoonTemplate: ev.target.value })} /></Field>
        <Field label="Forsinkelse med ny tid" hint="{orderId} og {time}"><textarea value={n.delayTemplate} onChange={(ev) => setN({ ...n, delayTemplate: ev.target.value })} /></Field>
        <Field label="Forsinkelse uden pålidelig tid" hint="Bruges når ETA er usikker – der opgives aldrig et opdigtet tidspunkt"><textarea value={n.delayNoTimeTemplate} onChange={(ev) => setN({ ...n, delayNoTimeTemplate: ev.target.value })} /></Field>
      </Card>
      <Card title="Økonomisk beslutningsmodel" actions={<button className="primary" onClick={() => void save({ economics: e })}>Gem</button>}>
        <p className="muted small">
          Score = dækningsbidrag − kørselsomkostning − ventetid (vægtet efter ordreværdi) − forsinkelse af andre kunder − risiko − omfordeling + nærhedsbonus.
          Hårde grænser (leveringsløfter, maks. leveringstid, lager, kapacitet) kan aldrig opvejes af omsætning.
        </p>
        <h4>Hårde begrænsninger</h4>
        <NumGrid
          value={e as unknown as Record<string, unknown>}
          onChange={(v) => setE(v as unknown as typeof e)}
          fields={[
            { key: 'promiseToleranceMinutes', label: 'Tolerance på givne løfter', unit: 'min', hint: 'En bekræftet levering må højst blive så meget senere end lovet' },
            { key: 'maxDeliveryMinutes', label: 'Maks. leveringstid for ny ordre', unit: 'min' },
            { key: 'significantChangeMinutes', label: 'Væsentlig ruteændring fra', unit: 'min', hint: 'Kræver altid chaufførens accept' },
          ]}
        />
        <h4>Vægte</h4>
        <NumGrid
          value={e as unknown as Record<string, unknown>}
          onChange={(v) => setE(v as unknown as typeof e)}
          fields={[
            { key: 'defaultMarginPct', label: 'Standard-avance uden vareomkostning', unit: 'pct' },
            { key: 'driveCostPerMinuteOre', label: 'Kørselsomkostning pr. minut', unit: 'kr' },
            { key: 'waitCostPerMinuteOre', label: 'Ventetidsomkostning pr. minut', unit: 'kr' },
            { key: 'valueWeightScaleOre', label: 'Værdiskala (højere = mindre prioritet til store ordrer)', unit: 'kr' },
            { key: 'latePenaltyPerMinuteOre', label: 'Straf pr. minut over løfte', unit: 'kr' },
            { key: 'riskPenaltyPerMinuteOre', label: 'Risikostraf pr. minuts usikkerhed', unit: 'kr' },
            { key: 'disruptionCostOre', label: 'Omkostning pr. kunde der rykkes', unit: 'kr' },
            { key: 'reassignmentCostOre', label: 'Omkostning ved omfordeling', unit: 'kr' },
            { key: 'nearbyThresholdMinutes', label: 'Nærhed: højst', unit: 'min', hint: 'fra et eksisterende stop' },
            { key: 'nearbyBonusOre', label: 'Nærhedsbonus', unit: 'kr' },
            { key: 'minReassignmentGainOre', label: 'Mindste gevinst for omfordelingsforslag', unit: 'kr' },
          ]}
        />
      </Card>
    </div>
  );
}
