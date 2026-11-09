import { useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Empty, Field, PageHeader, SimTag, Stat, dateTime, usd } from '../components/ui';
import type { AiCall, AiTaskType, AiUsageSummary, Settings, SystemEvent } from '../../shared/types';

const TASKS: { id: AiTaskType; label: string; hint: string }[] = [
  { id: 'customer_interpret', label: 'Kundebeskeder (standard)', hint: 'Hyppigste opgave – brug en lille, billig model' },
  { id: 'customer_escalation', label: 'Kundebeskeder (eskalering)', hint: 'Bruges kun ved lav sikkerhed – større model' },
  { id: 'driver_interpret', label: 'Chaufførbeskeder', hint: 'Korte beskeder – lille model' },
];

export function AiCenter() {
  const { data: sum } = useQuery<AiUsageSummary>('ai.summary', {}, ['ai']);
  const { data: calls } = useQuery<AiCall[]>('ai.calls', {}, ['ai']);
  const { data: settings } = useQuery<Settings>('settings.get', {}, ['settings']);
  const { data: events } = useQuery<SystemEvent[]>('events.list', { limit: 200 }, ['events']);
  const aiEvents = events?.filter((e) => ['ai', 'customer_agent', 'driver_agent'].includes(e.source)).slice(0, 15);
  if (!sum || !settings) return <Empty>Indlæser…</Empty>;
  const pct = Math.min(100, sum.budgetUsedPct);

  return (
    <>
      <PageHeader title="AI Control Center" subtitle="Modelvalg, forbrug, omkostninger og automatisering. AI'en fortolker kun – priser, lager og statusskift styres af forretningsreglerne." />
      <div className="stats">
        <Stat label="Forbrug denne måned" value={usd(sum.monthCostUsd)} sub={`${sum.monthCalls} kald`} />
        <Stat label="I dag" value={usd(sum.todayCostUsd)} sub={`${sum.todayCalls} kald`} />
        <Stat label="Tokens (måned)" value={`${fmtK(sum.monthInputTokens)} / ${fmtK(sum.monthOutputTokens)}`} sub="input / output" />
        <Stat label="Budget" value={`${pct.toFixed(0)} %`} tone={sum.budgetBlocked ? 'danger' : pct >= settings.ai.warnAtPct ? 'warn' : ''} sub={`af ${usd(sum.budgetUsd)} / måned`} />
      </div>
      <Card title="Månedsbudget">
        <div className={`progress ${sum.budgetBlocked ? 'danger' : pct >= settings.ai.warnAtPct ? 'warn' : ''}`}><div style={{ width: `${pct}%` }} /></div>
        {sum.budgetBlocked && <p className="error-text" style={{ marginTop: 8 }}>Budgettet er opbrugt. AI-kald er stoppet, og nye kundesamtaler sendes til en medarbejder.</p>}
      </Card>
      <div className="grid cols-2 mt">
        <ModelSettings settings={settings} />
        <AutomationSettings settings={settings} />
      </div>
      <div className="grid cols-2 mt">
        <Card title="Forbrug pr. model (måned)">
          {sum.byModel.length ? (
            <table>
              <thead><tr><th>Model</th><th className="num">Kald</th><th className="num">Tokens ind/ud</th><th className="num">Pris</th></tr></thead>
              <tbody>
                {sum.byModel.map((m) => (
                  <tr key={m.model}><td><code>{m.model}</code></td><td className="num">{m.calls}</td><td className="num">{fmtK(m.inputTokens)} / {fmtK(m.outputTokens)}</td><td className="num">{usd(m.costUsd)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>Ingen AI-kald endnu.</Empty>}
        </Card>
        <Card title="Agenthændelser og advarsler">
          {aiEvents?.length ? aiEvents.map((e) => (
            <div key={e.id} className="event-row"><span className={`lvl ${e.level}`} /><div><div>{e.message}</div><div className="muted small">{dateTime(e.createdAt)} · {e.source}</div></div></div>
          )) : <Empty>Ingen hændelser.</Empty>}
        </Card>
      </div>
      <Card title="Seneste AI-kald" className="mt">
        <table>
          <thead><tr><th>Tid</th><th>Agent</th><th>Opgave</th><th>Model</th><th className="num">Tokens</th><th className="num">Pris</th><th className="num">Tid</th><th>Status</th></tr></thead>
          <tbody>
            {calls?.slice(0, 50).map((c) => (
              <tr key={c.id}>
                <td>{dateTime(c.createdAt)}</td><td>{c.agent}</td><td>{c.taskType}</td>
                <td><code>{c.model}</code>{c.simulated && <SimTag />}</td>
                <td className="num">{c.inputTokens}/{c.outputTokens}{c.cacheReadTokens ? ` (cache ${c.cacheReadTokens})` : ''}</td>
                <td className="num">{usd(c.costUsd)}</td><td className="num">{c.latencyMs} ms</td>
                <td>{c.success ? <span className="badge ok">OK</span> : <span className="badge danger" title={c.error ?? ''}>Fejl</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {calls?.some((c) => c.simulated) && <p className="muted small">SIM = Demo Mode: regelbaseret fortolkning, ingen API-kald, estimerede tokens og pris 0.</p>}
      </Card>
    </>
  );
}

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ModelSettings({ settings }: { settings: Settings }) {
  const [routing, setRouting] = useState(settings.ai.routing);
  const [budget, setBudget] = useState(settings.ai.monthlyBudgetUsd);
  const [warn, setWarn] = useState(settings.ai.warnAtPct);
  const [models, setModels] = useState(settings.ai.models);
  const [fallback, setFallback] = useState(settings.ai.fallbackModels.join(', '));
  const save = () =>
    act(() =>
      call('settings.update', {
        patch: { ai: { routing, monthlyBudgetUsd: budget, warnAtPct: warn, models, fallbackModels: fallback.split(',').map((s) => s.trim()).filter(Boolean) } },
      }),
    ).then((ok) => ok && toast('AI-indstillinger gemt'));
  return (
    <Card title="Modelvalg og priser" actions={<><button onClick={() => void call<string[]>('ai.listModels').then((m) => toast(`Tilgængelige modeller: ${m.join(', ')}`)).catch((e) => toast((e as Error).message, 'error'))}>Hent tilgængelige modeller</button><button className="primary" onClick={() => void save()}>Gem</button></>}>
      <div className="stack">
        {TASKS.map((t) => (
          <Field key={t.id} label={t.label} hint={t.hint}>
            <input value={routing[t.id]} onChange={(e) => setRouting({ ...routing, [t.id]: e.target.value })} />
          </Field>
        ))}
        <Field label="Fallback-modeller" hint="Bruges hvis en model ikke er tilgængelig (kommasepareret)"><input value={fallback} onChange={(e) => setFallback(e.target.value)} /></Field>
        <div className="form-grid">
          <Field label="Månedsbudget (USD)"><input type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></Field>
          <Field label="Advar ved (% af budget)"><input type="number" min={1} max={100} value={warn} onChange={(e) => setWarn(Number(e.target.value))} /></Field>
        </div>
        <table>
          <thead><tr><th>Model</th><th className="num">Input $/MTok</th><th className="num">Output $/MTok</th><th className="num">Cache-læs</th></tr></thead>
          <tbody>
            {models.map((m, i) => (
              <tr key={m.id}>
                <td><code>{m.id}</code></td>
                {(['inputPerMTokUsd', 'outputPerMTokUsd', 'cacheReadPerMTokUsd'] as const).map((k) => (
                  <td key={k} className="num"><input type="number" step="0.01" style={{ width: 80 }} value={m[k]} onChange={(e) => setModels(models.map((x, j) => (j === i ? { ...x, [k]: Number(e.target.value) } : x)))} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Priserne er konfiguration (standard: Anthropics prisliste pr. oktober 2026) og bruges til at beregne estimerede omkostninger ud fra faktisk tokenforbrug.</p>
      </div>
    </Card>
  );
}

function AutomationSettings({ settings }: { settings: Settings }) {
  const a = settings.automation;
  const d = settings.delivery;
  const set = (patch: Record<string, unknown>) => void act(() => call('settings.update', { patch }));
  return (
    <Card title="Automatiseringsindstillinger">
      <div className="stack">
        <label className="row"><input type="checkbox" checked={settings.ai.enabled} onChange={(e) => set({ ai: { enabled: e.target.checked } })} /> AI-fortolkning aktiv</label>
        <label className="row"><input type="checkbox" checked={a.customerReplies} onChange={(e) => set({ automation: { customerReplies: e.target.checked } })} /> Automatiske svar til kunder</label>
        <label className="row"><input type="checkbox" checked={a.autoDispatch} onChange={(e) => set({ automation: { autoDispatch: e.target.checked } })} /> Automatisk chaufførtildeling</label>
        <label className="row"><input type="checkbox" checked={a.customerEtaUpdates} onChange={(e) => set({ automation: { customerEtaUpdates: e.target.checked } })} /> SMS til kunder ved forsinkelser</label>
        <label className="row"><input type="checkbox" checked={d.requireDriverAcceptance} onChange={(e) => set({ delivery: { requireDriverAcceptance: e.target.checked } })} /> Chaufføren skal acceptere ordren</label>
        <label className="row"><input type="checkbox" checked={settings.sms.pauseOnUnknownOutgoing} onChange={(e) => set({ sms: { pauseOnUnknownOutgoing: e.target.checked } })} /> Sæt samtale til manuel, når en manuel besked fra iPhone registreres</label>
        <Field label="Eskalér til større model under sikkerhed" hint="0–1. Lavere = færre dyre kald.">
          <input type="number" step="0.05" min={0} max={1} defaultValue={settings.ai.escalateBelowConfidence} onBlur={(e) => set({ ai: { escalateBelowConfidence: Number(e.target.value) } })} />
        </Field>
        <Field label="Maks. beskeder i AI-kontekst" hint="Begrænser tokenforbrug pr. kald">
          <input type="number" min={2} max={40} defaultValue={settings.ai.maxContextMessages} onBlur={(e) => set({ ai: { maxContextMessages: Number(e.target.value) } })} />
        </Field>
      </div>
    </Card>
  );
}
