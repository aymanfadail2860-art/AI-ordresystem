import { useEffect, useState } from 'react';
import { act, call, setLockHandler, useQuery } from './api';
import { Modal, Toasts } from './components/ui';
import type { DashboardStats } from '../shared/types';
import { Dashboard } from './pages/Dashboard';
import { Orders } from './pages/Orders';
import { Conversations } from './pages/Conversations';
import { Drivers } from './pages/Drivers';
import { Logistics } from './pages/Logistics';
import { Products } from './pages/Products';
import { AiCenter } from './pages/AiCenter';
import { Events } from './pages/Events';
import { SettingsPage } from './pages/Settings';
import { SetupWizard } from './pages/SetupWizard';
import { DemoConsole } from './pages/DemoConsole';
import { ManagementCenter } from './pages/ManagementCenter';

export type PageId =
  | 'dashboard'
  | 'orders'
  | 'conversations'
  | 'drivers'
  | 'logistics'
  | 'products'
  | 'ai'
  | 'events'
  | 'settings'
  | 'management'
  | 'setup'
  | 'demo';

export interface Nav {
  go(page: PageId, id?: number): void;
  selected: number | null;
}

const NAV: { id: PageId; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◧' },
  { id: 'orders', label: 'Ordrer', icon: '▤' },
  { id: 'conversations', label: 'Kundesamtaler', icon: '✉' },
  { id: 'drivers', label: 'Chauffører', icon: '⛟' },
  { id: 'logistics', label: 'Logistik', icon: '⌖' },
  { id: 'products', label: 'Produkter og lager', icon: '▦' },
  { id: 'ai', label: 'AI Control Center', icon: '✦' },
  { id: 'management', label: 'Ledelsescenter', icon: '♛' },
  { id: 'events', label: 'Hændelser', icon: '⚑' },
  { id: 'settings', label: 'Indstillinger', icon: '⚙' },
];

export function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const [selected, setSelected] = useState<number | null>(null);
  const [pinPrompt, setPinPrompt] = useState<((ok: boolean) => void) | null>(null);
  const { data: stats } = useQuery<DashboardStats>('dashboard.get', {}, ['orders', 'conversations', 'drivers', 'events', 'integrations', 'ai', 'settings']);
  const { data: info } = useQuery<{ mode: string; setupCompleted: boolean; version: string }>('system.info', {}, ['settings']);
  const { data: repData } = useQuery<{ active: { status: string }[] }>('replenishment.overview', {}, ['replenishment']);
  const pending = repData?.active.filter((r) => r.status === 'awaiting_management').length ?? 0;

  useEffect(() => {
    setLockHandler(() => new Promise<boolean>((resolve) => setPinPrompt(() => resolve)));
  }, []);

  useEffect(() => {
    if (info && info.mode === 'production' && !info.setupCompleted) setPage('setup');
  }, [info]);

  const nav: Nav = {
    go(p, id) {
      setPage(p);
      setSelected(id ?? null);
    },
    selected,
  };
  const isDemo = stats?.mode === 'demo';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">AD</div>
          <div>
            <div className="brand-name">AI Dispatch</div>
            <div className="brand-sub">{isDemo ? 'Demo Mode' : 'Produktion'}</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => nav.go(n.id)}>
              <span className="nav-icon">{n.icon}</span>
              <span>{n.label}</span>
              {n.id === 'conversations' && stats && stats.conversationsNeedingAttention > 0 && <span className="nav-count">{stats.conversationsNeedingAttention}</span>}
              {n.id === 'events' && stats && stats.openAlerts > 0 && <span className="nav-count danger">{stats.openAlerts}</span>}
              {n.id === 'orders' && stats && stats.needsManual > 0 && <span className="nav-count warn">{stats.needsManual}</span>}
              {n.id === 'management' && pending && pending > 0 ? <span className="nav-count warn">{pending}</span> : null}
            </button>
          ))}
          {isDemo && (
            <button className={`nav-item demo ${page === 'demo' ? 'active' : ''}`} onClick={() => nav.go('demo')}>
              <span className="nav-icon">▶</span>
              <span>Demo-konsol</span>
            </button>
          )}
          {!isDemo && (
            <button className={`nav-item ${page === 'setup' ? 'active' : ''}`} onClick={() => nav.go('setup')}>
              <span className="nav-icon">✓</span>
              <span>Opsætningsguide</span>
            </button>
          )}
        </nav>
        <div className="sidebar-foot">
          {stats && (
            <label className="automation-toggle" title="Hovedafbryder for automatiske svar og tildelinger">
              <input
                type="checkbox"
                checked={stats.automationEnabled}
                onChange={(e) => void act(() => call('system.setAutomation', { enabled: e.target.checked }))}
              />
              <span>Automatik {stats.automationEnabled ? 'TIL' : 'FRA'}</span>
            </label>
          )}
          <div className="integrations-mini">
            {stats?.integrations.map((i) => (
              <span key={i.name} className={`dot ${i.state}`} title={`${i.name}: ${i.message ?? i.state}`}>
                {{ sms: 'SMS', telegram: 'TG', maps: 'Kort', ai: 'AI' }[i.name]}
              </span>
            ))}
          </div>
          <div className="muted small">v{info?.version}</div>
        </div>
      </aside>
      <main className="main">
        {isDemo && (
          <div className="demo-banner">
            DEMO MODE – alle kunder, chauffører, SMS'er og Telegram-beskeder er simulerede. Intet sendes til rigtige personer.
          </div>
        )}
        {stats && !isDemo && !stats.automationEnabled && (
          <div className="warn-banner">Automatik er slået FRA – ingen automatiske kundesvar eller chaufførtildelinger.</div>
        )}
        <div className="page">
          {page === 'dashboard' && <Dashboard nav={nav} />}
          {page === 'orders' && <Orders nav={nav} />}
          {page === 'conversations' && <Conversations nav={nav} />}
          {page === 'drivers' && <Drivers nav={nav} />}
          {page === 'logistics' && <Logistics nav={nav} />}
          {page === 'products' && <Products />}
          {page === 'ai' && <AiCenter />}
          {page === 'events' && <Events nav={nav} />}
          {page === 'settings' && <SettingsPage />}
          {page === 'management' && <ManagementCenter />}
          {page === 'setup' && <SetupWizard nav={nav} />}
          {page === 'demo' && <DemoConsole nav={nav} />}
        </div>
      </main>
      {pinPrompt && (
        <PinModal
          onDone={(ok) => {
            pinPrompt(ok);
            setPinPrompt(null);
          }}
        />
      )}
      <Toasts />
    </div>
  );
}

function PinModal({ onDone }: { onDone: (ok: boolean) => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const r = await call<{ ok: boolean }>('auth.unlock', { pin });
    if (r.ok) onDone(true);
    else setErr('Forkert PIN');
  };
  return (
    <Modal
      title="Administrator-PIN påkrævet"
      onClose={() => onDone(false)}
      footer={
        <>
          <button onClick={() => onDone(false)}>Annullér</button>
          <button className="primary" onClick={() => void submit()}>
            Lås op
          </button>
        </>
      }
    >
      <p>Denne handling er følsom (API-nøgler, backup, persondata eller systemindstillinger).</p>
      <input
        autoFocus
        type="password"
        inputMode="numeric"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder="PIN"
      />
      {err && <p className="error-text">{err}</p>}
    </Modal>
  );
}
