import { useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Empty, PageHeader } from '../components/ui';
import type { Driver, IntegrationStatus, Product, Settings } from '../../shared/types';
import { CompanyTab, DeliveryTab, IntegrationsTab } from './Settings';
import type { Nav } from '../App';

const STEPS = [
  'Virksomhed',
  'Apple Messages',
  'Claude API',
  'Telegram',
  'Google Maps',
  'Chauffører',
  'Produkter',
  'Lager',
  'Leveringsområde',
  'Test',
  'Aktivér',
] as const;

/** Opsætningsguide til ny installation (virksomhed A, B, C …) – ingen kodeændringer. */
export function SetupWizard({ nav }: { nav: Nav }) {
  const [step, setStep] = useState(0);
  const { data: s } = useQuery<Settings>('settings.get', {}, ['settings']);
  const { data: ints } = useQuery<IntegrationStatus[]>('integrations.list', {}, ['integrations']);
  const { data: drivers } = useQuery<Driver[]>('drivers.list', {}, ['drivers']);
  const { data: products } = useQuery<Product[]>('products.list', {}, ['products']);
  const { data: info } = useQuery<{ mode: string }>('system.info', {}, ['settings']);
  if (!s) return <Empty>Indlæser…</Empty>;
  const st = (n: string) => ints?.find((i) => i.name === n)?.state;

  return (
    <>
      <PageHeader title="Opsætningsguide" subtitle="Konfigurér AI Dispatch til denne virksomhed. Hver installation har sin egen database, egne nøgler og egne indstillinger." />
      {info?.mode === 'demo' && <div className="callout warn" style={{ marginBottom: 12 }}>Du er i Demo Mode. Skift til produktion under Indstillinger → System for at opsætte rigtige integrationer.</div>}
      <div className="steps">
        {STEPS.map((label, i) => (
          <button key={label} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`} onClick={() => setStep(i)}>
            {i + 1}. {label}
          </button>
        ))}
      </div>
      {step === 0 && <CompanyTab s={s} />}
      {step >= 1 && step <= 4 && (
        <div className="stack">
          <Card title={STEPS[step]}>
            {step === 1 && (
              <ol>
                <li>På virksomhedens iPhone: Indstillinger → Beskeder → Videresendelse af SMS → slå denne Mac til.</li>
                <li>Log ind på samme Apple-konto i Beskeder på denne Mac, og kontroller at SMS'er vises.</li>
                <li>Installer imsg (medfølger i installationspakken eller via Homebrew) og angiv stien nedenfor.</li>
                <li>Systemindstillinger → Anonymitet og sikkerhed → Fuld diskadgang → slå AI Dispatch til.</li>
                <li>Første afsendelse beder om tilladelse til at styre Beskeder → Tillad.</li>
                <li>Gennemfør Proof of Concept-testen (INTEGRATIONS.md) før systemet aktiveres.</li>
              </ol>
            )}
            {step === 2 && <p>Indtast virksomhedens egen Claude API-nøgle. Programmet bruger aldrig udviklerens konto under drift. Sæt et månedsbudget i AI Control Center.</p>}
            {step === 3 && <p>Opret en bot hos @BotFather i Telegram, indsæt token, og forbind derefter hver chauffør med deres engangskode (Chauffører-siden).</p>}
            {step === 4 && <p>Opret en Google Cloud API-nøgle med Geocoding API og Routes API aktiveret. Begræns nøglen til disse to API'er.</p>}
          </Card>
          <IntegrationsTab s={s} />
        </div>
      )}
      {step === 5 && (
        <Card title="Chauffører" actions={<button className="primary" onClick={() => nav.go('drivers')}>Gå til chauffører</button>}>
          <p>{drivers?.length ?? 0} chauffører oprettet · {drivers?.filter((d) => d.telegramUserId).length ?? 0} forbundet til Telegram.</p>
        </Card>
      )}
      {step === 6 && (
        <Card title="Produkter og priser" actions={<button className="primary" onClick={() => nav.go('products')}>Gå til produkter</button>}>
          <p>{products?.filter((p) => p.active).length ?? 0} aktive produkter.</p>
        </Card>
      )}
      {step === 7 && (
        <Card title="Lagerlokationer" actions={<><button onClick={() => void act(() => call('inventory.createLocation', { name: 'Centrallager' })).then((ok) => ok && toast('Centrallager oprettet'))}>+ Opret centrallager</button><button className="primary" onClick={() => nav.go('products')}>Gå til lager</button></>}>
          <p>Hver chauffør har automatisk en lagerlokation for bilen. Opret et centrallager, hvis varer hentes centralt, og registrér beholdningen.</p>
        </Card>
      )}
      {step === 8 && <DeliveryTab s={s} />}
      {step === 9 && (
        <Card title="Test integrationerne">
          {(['sms', 'telegram', 'maps', 'ai'] as const).map((n) => (
            <div key={n} className="row between" style={{ padding: '6px 0' }}>
              <span>{{ sms: 'Apple Messages (SMS)', telegram: 'Telegram', maps: 'Google Maps', ai: 'Claude API' }[n]} – {st(n) ?? 'ukendt'}</span>
              <button onClick={() => void call<{ ok: boolean; message: string }>('integrations.test', { name: n }).then((r) => toast(r.message, r.ok ? 'info' : 'error'))}>Test</button>
            </div>
          ))}
        </Card>
      )}
      {step === 10 && (
        <Card title="Aktivér systemet">
          <p>Kontrollér at alle integrationer er testet, at der er sat en administrator-PIN, og at SMS Proof of Concept er gennemført på rigtig hardware.</p>
          <div className="row">
            <button onClick={() => void act(() => call('setup.complete')).then((ok) => ok && toast('Opsætning markeret som færdig'))}>Markér opsætning færdig</button>
            <button className="primary" onClick={() => void act(() => call('system.setAutomation', { enabled: true })).then((ok) => ok && toast('Automatik aktiveret'))}>Aktivér automatik</button>
          </div>
        </Card>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>← Forrige</button>
        <button className="primary" disabled={step === STEPS.length - 1} onClick={() => setStep(step + 1)}>Næste →</button>
      </div>
    </>
  );
}
