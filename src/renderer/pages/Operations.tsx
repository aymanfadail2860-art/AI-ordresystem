import { Fragment, useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Empty, Field, IntegrationBadge, PageHeader, SimTag, Stat, dateTime, kr, time } from '../components/ui';
import type { DispatchStrategy, IntegrationStatus, ManagementReport, MonitorAlert, ReportMetrics, SimulationMetrics, SimulationRun, SystemEvent } from '../../shared/types';
import { ALERT_CATEGORY_LABELS, ALERT_RULE_LABELS, DISPATCH_STRATEGY_LABELS, REPORT_STATUS_LABELS } from '../../shared/types';

interface Overview {
  integrations: IntegrationStatus[];
  mode: 'demo' | 'production';
  openAlerts: MonitorAlert[];
  criticalEvents: SystemEvent[];
  lastReport: ManagementReport | null;
  settings: { monitoring: { enabled: boolean; notifyGroup: boolean }; hourlyReports: boolean; groupConfigured: boolean };
}

interface Comparison {
  groupId: string;
  seed: number;
  config: { orders?: number; drivers?: number };
  runs: SimulationRun[];
  comparison: { results: SimulationMetrics[]; best: Record<string, DispatchStrategy[]>; economicNotBest: string[]; summary: string[] } | null;
}

const CAT_TONE: Record<string, string> = { auto: 'neutral', inform: 'info', approval: 'warn', takeover: 'danger' };
const REPORT_TONE: Record<string, string> = { sent: 'ok', queued: 'info', pending: 'info', uncertain: 'warn', failed: 'danger', skipped: 'neutral' };
const INTEGRATION_LABEL: Record<string, string> = { sms: 'SMS (Apple Messages)', telegram: 'Telegram', maps: 'Google Maps', ai: 'Claude API' };

const COMPARED: { key: keyof SimulationMetrics; label: string; better: 'higher' | 'lower'; money?: boolean }[] = [
  { key: 'delivered', label: 'Leverede ordrer', better: 'higher' },
  { key: 'revenueOre', label: 'Omsætning', better: 'higher', money: true },
  { key: 'contributionOre', label: 'Dækningsbidrag', better: 'higher', money: true },
  { key: 'deliveriesPerDriverHour', label: 'Leveringer pr. chaufførtime', better: 'higher' },
  { key: 'avgDeliveryMinutes', label: 'Gns. leveringstid (min)', better: 'lower' },
  { key: 'p90DeliveryMinutes', label: '90 %-fraktil (min)', better: 'lower' },
  { key: 'lateShare', label: 'Andel forsinkede (%)', better: 'lower' },
  { key: 'driveMinutesPerDelivery', label: 'Køretid pr. levering (min)', better: 'lower' },
  { key: 'depotDriveMinutes', label: 'Køretid til lager (min)', better: 'lower' },
  { key: 'stockProblems', label: 'Lagerproblemer', better: 'lower' },
  { key: 'managementInterventions', label: 'Ledelsesindgreb', better: 'lower' },
  { key: 'failedOrUnresolvedActions', label: 'Fejlede/uafklarede handlinger', better: 'lower' },
];

/** Drift og overvågning: timerapporter, proaktive advarsler, kritiske hændelser, simulering og integrationer. */
export function Operations() {
  const [tab, setTab] = useState<'overview' | 'reports' | 'alerts' | 'simulation'>('overview');
  const { data } = useQuery<Overview>('operations.overview', {}, ['monitoring', 'reports', 'events', 'integrations', 'settings']);
  if (!data) return <Empty>Indlæser…</Empty>;
  const urgent = data.openAlerts.filter((a) => a.category === 'takeover' || a.category === 'approval').length;
  return (
    <>
      <PageHeader
        title="Drift og overvågning"
        subtitle="Timerapporter og advarsler beregnes deterministisk fra databasen – uden AI. Simuleringer kører isoleret og påvirker ikke driften."
      />
      <div className="tabs">
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Oversigt</button>
        <button className={`tab ${tab === 'reports' ? 'active' : ''}`} onClick={() => setTab('reports')}>Timerapporter</button>
        <button className={`tab ${tab === 'alerts' ? 'active' : ''}`} onClick={() => setTab('alerts')}>
          Proaktive advarsler {urgent ? `(${urgent})` : ''}
        </button>
        <button className={`tab ${tab === 'simulation' ? 'active' : ''}`} onClick={() => setTab('simulation')}>Driftssimulering</button>
      </div>
      {tab === 'overview' && <OverviewTab data={data} go={setTab} />}
      {tab === 'reports' && <ReportsTab groupConfigured={data.settings.groupConfigured} />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'simulation' && <SimulationTab />}
    </>
  );
}

function OverviewTab({ data, go }: { data: Overview; go: (t: 'reports' | 'alerts' | 'simulation') => void }) {
  const by = (c: string) => data.openAlerts.filter((a) => a.category === c).length;
  return (
    <div className="stack">
      {data.mode === 'demo' && <div className="callout info">Demo Mode: alle tal, advarsler og integrationer nedenfor er simulerede.</div>}
      <div className="grid cols-4">
        <Stat label="Kræver overtagelse (D)" value={by('takeover')} tone={by('takeover') ? 'danger' : undefined} />
        <Stat label="Kræver godkendelse (C)" value={by('approval')} tone={by('approval') ? 'warn' : undefined} />
        <Stat label="Orienteringer (B)" value={by('inform')} />
        <Stat label="Håndteres automatisk (A)" value={by('auto')} />
      </div>
      <div className="grid cols-2">
        <Card title="Integrationsstatus">
          <table>
            <tbody>
              {data.integrations.map((i) => (
                <tr key={i.name}>
                  <td>{INTEGRATION_LABEL[i.name]}</td>
                  <td><IntegrationBadge state={i.state} /> {i.simulated && <SimTag />}</td>
                  <td className="muted small">{i.message}</td>
                  <td className="muted small">{i.lastOkAt ? `OK ${time(i.lastOkAt)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small" style={{ marginTop: 8 }}>
            {data.integrations.some((i) => i.simulated) ? 'SIM = simuleret forbindelse. Rigtige integrationer er ikke afprøvet herfra.' : 'Produktionsforbindelser.'}
          </p>
        </Card>
        <Card title="Seneste timerapport" actions={<button onClick={() => go('reports')}>Alle rapporter</button>}>
          {data.lastReport?.body ? <pre className="report">{data.lastReport.body}</pre> : <Empty>Ingen rapporter endnu.</Empty>}
          {!data.settings.groupConfigured && <p className="muted small">Ledelsesgruppen er ikke konfigureret – rapporter gemmes, men sendes ikke.</p>}
        </Card>
      </div>
      <Card title="Åbne advarsler" actions={<button onClick={() => go('alerts')}>Alle advarsler</button>}>
        {data.openAlerts.length ? <AlertTable alerts={data.openAlerts.slice(0, 12)} /> : <Empty>Ingen åbne advarsler.</Empty>}
      </Card>
      <Card title="Kritiske hændelser">
        {data.criticalEvents.length ? (
          <table>
            <thead><tr><th>Tid</th><th>Niveau</th><th>Kilde</th><th>Hændelse</th></tr></thead>
            <tbody>
              {data.criticalEvents.slice(0, 20).map((e) => (
                <tr key={e.id}>
                  <td className="muted small">{dateTime(e.createdAt)}</td>
                  <td><span className={`badge ${e.level === 'critical' ? 'danger' : 'warn'}`}>{e.level}</span></td>
                  <td>{e.source}</td>
                  <td>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Ingen fejl eller kritiske hændelser.</Empty>
        )}
      </Card>
    </div>
  );
}

function ReportsTab({ groupConfigured }: { groupConfigured: boolean }) {
  const { data } = useQuery<ManagementReport[]>('reports.list', {}, ['reports', 'management']);
  const [preview, setPreview] = useState<{ body: string; metrics: ReportMetrics } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="stack">
      <Card
        title="Timerapporter til ledelsesgruppen"
        actions={
          <>
            <button onClick={() => void act(() => call<{ body: string; metrics: ReportMetrics }>('reports.preview').then(setPreview))}>Forhåndsvis</button>
            <button className="primary" disabled={!groupConfigured} onClick={() => void act(() => call('reports.sendNow').then(() => toast('Rapport lagt i udbakken')))}>
              Send rapport nu
            </button>
          </>
        }
      >
        <p className="muted small">
          Sendes automatisk lige efter hver hele time i åbningstiden (Europe/Copenhagen, sommer-/vintertid håndteres). Én rapport pr. periode – også efter genstart. Ledelsen kan
          altid skrive "Rapport" i gruppen.
        </p>
        {preview && <pre className="report">{preview.body}</pre>}
      </Card>
      <Card title="Rapporthistorik">
        {data?.length ? (
          <table>
            <thead><tr><th>Periode</th><th>Type</th><th>Status</th><th className="num">Omsætning (time)</th><th className="num">Leveret (time)</th><th>Anmodet af</th><th>Sendt</th><th /></tr></thead>
            <tbody>
              {data.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td>{time(r.periodStart)}–{time(r.periodEnd)} <span className="muted small">{dateTime(r.periodEnd).split(' ')[0]}</span></td>
                    <td>{r.kind === 'hourly' ? 'Timerapport' : 'På forespørgsel'}</td>
                    <td><span className={`badge ${REPORT_TONE[r.status]}`} title={r.error ?? ''}>{REPORT_STATUS_LABELS[r.status]}</span></td>
                    <td className="num">{r.metrics ? kr(r.metrics.hour.revenueOre) : '–'}</td>
                    <td className="num">{r.metrics?.hour.delivered ?? '–'}</td>
                    <td>{r.requestedBy ?? '–'}</td>
                    <td className="muted small">{r.sentAt ? time(r.sentAt) : r.error ?? ''}</td>
                    <td>{r.body && <button onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Skjul' : 'Vis'}</button>}</td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={8}><pre className="report">{r.body}</pre></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Ingen rapporter endnu.</Empty>
        )}
      </Card>
    </div>
  );
}

function AlertTable({ alerts, onSelect }: { alerts: MonitorAlert[]; onSelect?: (a: MonitorAlert) => void }) {
  return (
    <table>
      <thead><tr><th>Sidst set</th><th>Kategori</th><th>Type</th><th>Hændelse</th><th>Handling</th><th className="num">Gentagelser</th><th>Status</th><th /></tr></thead>
      <tbody>
        {alerts.map((a) => (
          <tr key={a.id}>
            <td className="muted small">{time(a.lastSeenAt)}</td>
            <td><span className={`badge ${CAT_TONE[a.category]}`}>{ALERT_CATEGORY_LABELS[a.category]}</span></td>
            <td>{ALERT_RULE_LABELS[a.rule]}</td>
            <td>{a.message}</td>
            <td className="small">{a.actionTaken}</td>
            <td className="num">{a.occurrences}</td>
            <td>{a.status === 'open' ? 'Åben' : a.status === 'acknowledged' ? `Kvitteret${a.acknowledgedBy ? ` (${a.acknowledgedBy})` : ''}` : `Løst ${a.resolvedAt ? time(a.resolvedAt) : ''}`}</td>
            <td className="row">
              {onSelect && <button onClick={() => onSelect(a)}>Log</button>}
              {a.status === 'open' && <button onClick={() => void act(() => call('monitoring.acknowledge', { id: a.id }))}>Kvittér</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AlertsTab() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const { data } = useQuery<MonitorAlert[]>('monitoring.alerts', filter === 'open' ? { status: ['open', 'acknowledged'] } : {}, ['monitoring']);
  const [sel, setSel] = useState<MonitorAlert | null>(null);
  const { data: log } = useQuery<{ id: number; category: string; decision: string; action: string | null; createdAt: string }[]>(
    'monitoring.decisions',
    sel ? { alertId: sel.id } : {},
    ['monitoring'],
  );
  return (
    <div className="stack">
      <Card
        title="Proaktive advarsler"
        actions={
          <>
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')}>
              <option value="open">Åbne</option>
              <option value="all">Alle (inkl. løste)</option>
            </select>
            <button onClick={() => void act(() => call('monitoring.evaluate').then(() => toast('Driften er vurderet')))}>Vurdér nu</button>
          </>
        }
      >
        <p className="muted small">
          A håndteres automatisk inden for reglerne · B orientering · C kræver ledelsesgodkendelse · D kræver øjeblikkelig menneskelig overtagelse. Samme problem giver kun én
          advarsel; ledelsen får kun en ny besked, hvis det eskalerer.
        </p>
        {data?.length ? <AlertTable alerts={data} onSelect={setSel} /> : <Empty>Ingen advarsler.</Empty>}
      </Card>
      <Card title={sel ? `Beslutningslog – ${sel.title}` : 'Beslutningslog (seneste)'} actions={sel && <button onClick={() => setSel(null)}>Vis alle</button>}>
        {log?.length ? (
          <table>
            <thead><tr><th>Tid</th><th>Kategori</th><th>Beslutning</th><th>Handling</th></tr></thead>
            <tbody>
              {log.slice(0, 80).map((d) => (
                <tr key={d.id}>
                  <td className="muted small">{dateTime(d.createdAt)}</td>
                  <td>{ALERT_CATEGORY_LABELS[d.category as keyof typeof ALERT_CATEGORY_LABELS] ?? d.category}</td>
                  <td>{d.decision}</td>
                  <td className="small">{d.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Ingen beslutninger endnu.</Empty>
        )}
      </Card>
    </div>
  );
}

function SimulationTab() {
  const { data } = useQuery<{ status: { running: boolean; available: boolean; pct: number; strategy: DispatchStrategy | null }; groups: Comparison[] }>('simulation.list', {}, ['simulation']);
  const [seed, setSeed] = useState(42);
  const [orders, setOrders] = useState(300);
  const [drivers, setDrivers] = useState(8);
  if (!data) return <Empty>Indlæser…</Empty>;
  const st = data.status;
  const fmt = (m: (typeof COMPARED)[number], v: number) => (m.money ? kr(v) : v.toLocaleString('da-DK'));
  return (
    <div className="stack">
      <div className="callout warn">
        <strong>SIMULEREDE DATA.</strong> Simuleringen kører hele AI Dispatch i en isoleret kopi med simulerede kunder, chauffører, kort og Telegram og et virtuelt ur. Den sender
        aldrig rigtige beskeder og beviser ikke ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.
      </div>
      <Card title="Kør en hel arbejdsdag (kl. 10–22)">
        <div className="row wrap">
          <Field label="Seed"><input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></Field>
          <Field label="Kundeordrer"><input type="number" value={orders} onChange={(e) => setOrders(Number(e.target.value))} /></Field>
          <Field label="Chauffører"><input type="number" value={drivers} onChange={(e) => setDrivers(Number(e.target.value))} /></Field>
        </div>
        <p className="muted small">Samme dag køres med A. først-til-mølle, B. korteste ekstra køretid og C. AI Dispatchs økonomiske optimering. Med 300 ordrer tager det nogle minutter.</p>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={st.running || !st.available} onClick={() => void act(() => call('simulation.run', { seed, orders, drivers }).then(() => toast('Simulering startet')))}>
            {st.running ? `Kører… ${st.pct} % (${st.strategy ? DISPATCH_STRATEGY_LABELS[st.strategy] : ''})` : 'Start simulering'}
          </button>
          {!st.available && <span className="muted small">Simuleringsmotoren er ikke bygget i dette miljø (npm run build:main). Brug evt. npm run simulate.</span>}
        </div>
      </Card>
      {data.groups.length === 0 && <Card title="Resultater"><Empty>Ingen simuleringer endnu.</Empty></Card>}
      {data.groups.map((g) => (
        <Card key={g.groupId} title={<>Sammenligning – seed {g.seed}, {g.config.orders} ordrer, {g.config.drivers} chauffører <SimTag /></>}>
          {g.comparison ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Nøgletal</th>
                    {g.comparison.results.map((r) => <th key={r.strategy} className="num">{DISPATCH_STRATEGY_LABELS[r.strategy]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {COMPARED.map((m) => (
                    <tr key={m.key}>
                      <td>{m.label} <span className="muted small">({m.better === 'higher' ? 'højere' : 'lavere'} er bedst)</span></td>
                      {g.comparison!.results.map((r) => {
                        const best = g.comparison!.best[m.key]?.includes(r.strategy);
                        return <td key={r.strategy} className="num" style={best ? { fontWeight: 700, color: 'var(--ok)' } : undefined}>{fmt(m, r[m.key] as number)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="small" style={{ marginTop: 8 }}>{g.comparison.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          ) : (
            <p className="muted">
              {g.runs.map((r) => `${DISPATCH_STRATEGY_LABELS[r.strategy]}: ${r.status === 'running' ? 'kører' : r.status === 'failed' ? `fejlede (${r.error})` : 'færdig'}`).join(' · ')}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
