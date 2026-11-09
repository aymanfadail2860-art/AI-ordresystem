import { useQuery } from '../api';
import { Card, IntegrationBadge, OrderStatusBadge, PageHeader, Stat, Empty, kr, time, usd, ago } from '../components/ui';
import type { DashboardStats, Order, SystemEvent } from '../../shared/types';
import type { Nav } from '../App';

const INT_LABEL = { sms: 'SMS (Apple Messages)', telegram: 'Telegram', maps: 'Google Maps', ai: 'Claude API' } as const;

export function Dashboard({ nav }: { nav: Nav }) {
  const { data: s } = useQuery<DashboardStats>('dashboard.get', {}, ['orders', 'drivers', 'events', 'integrations', 'ai', 'conversations']);
  const { data: active } = useQuery<Order[]>('orders.list', { activeOnly: true, limit: 12 }, ['orders']);
  const { data: alerts } = useQuery<SystemEvent[]>('events.list', { onlyOpen: true, limit: 8 }, ['events']);
  const { data: timeline } = useQuery<{ hour: number; orders: number }[]>('dashboard.timeline', {}, ['orders']);

  if (!s) return <Empty>Indlæser…</Empty>;
  const hours = Array.from({ length: 24 }, (_, h) => timeline?.find((t) => t.hour === h)?.orders ?? 0);
  const max = Math.max(1, ...hours);

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Overblik ${new Date().toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' })}`} />
      <div className="stats">
        <Stat label="Aktive ordrer" value={s.activeOrders} />
        <Stat label="Ordrer i dag" value={s.ordersToday} />
        <Stat label="Leveret i dag" value={s.deliveredToday} tone="ok" sub={kr(s.revenueTodayOre)} />
        <Stat label="Afventende" value={s.pendingOrders} sub="kladder i kundedialog" />
        <Stat label="Forsinkelser" value={s.delayedOrders} tone={s.delayedOrders ? 'warn' : ''} />
        <Stat label="Kræver handling" value={s.needsManual + s.openAlerts} tone={s.needsManual + s.openAlerts ? 'danger' : ''} sub={`${s.needsManual} ordrer · ${s.openAlerts} advarsler`} />
        <Stat label="Chauffører" value={`${s.activeDrivers}/${s.onlineDrivers}`} sub="aktive / online" />
        <Stat label="AI-forbrug" value={usd(s.aiCostMonthUsd)} sub={`i dag ${usd(s.aiCostTodayUsd)} · ${s.aiBudgetUsedPct.toFixed(0)} % af budget`} />
      </div>
      <div className="grid cols-3">
        <Card title="Aktive ordrer" actions={<button className="link" onClick={() => nav.go('orders')}>Se alle</button>} className="span-2">
          {active?.length ? (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Status</th>
                  <th>Kunde</th>
                  <th>Chauffør</th>
                  <th>ETA</th>
                  <th className="num">Beløb</th>
                </tr>
              </thead>
              <tbody>
                {active.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => nav.go('orders', o.id)}>
                    <td>#{o.id}{o.needsAttention && <span title={o.attentionReason ?? ''}> ⚠️</span>}</td>
                    <td><OrderStatusBadge status={o.status} /></td>
                    <td className="truncate">{o.customerName ?? o.customerPhone}</td>
                    <td>{o.driverName ?? '–'}</td>
                    <td>{time(o.eta)}</td>
                    <td className="num">{kr(o.totalOre)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Ingen aktive ordrer lige nu.</Empty>
          )}
        </Card>
        <div className="stack">
          <Card title="Systemstatus">
            <div className="stack">
              {s.integrations.map((i) => (
                <div key={i.name} className="row between" title={i.message ?? ''}>
                  <span>{INT_LABEL[i.name]}</span>
                  <IntegrationBadge state={i.state} />
                </div>
              ))}
              <div className="row between">
                <span>Automatik</span>
                <span className={`badge ${s.automationEnabled ? 'ok' : 'warn'}`}>{s.automationEnabled ? 'Aktiv' : 'Slået fra'}</span>
              </div>
            </div>
          </Card>
          <Card title="Kræver opmærksomhed" actions={<button className="link" onClick={() => nav.go('events')}>Alle</button>}>
            {alerts?.length ? (
              alerts.map((e) => (
                <div key={e.id} className="event-row">
                  <span className={`lvl ${e.level}`} />
                  <div>
                    <div>{e.message}</div>
                    <div className="muted small">{ago(e.createdAt)}</div>
                  </div>
                </div>
              ))
            ) : (
              <Empty>Intet kræver handling 👍</Empty>
            )}
          </Card>
        </div>
      </div>
      <Card title="Ordrer pr. time i dag" className="mt">
        <div className="bar-chart">
          {hours.map((n, h) => (
            <div key={h} className="bar" style={{ height: `${(n / max) * 100}%`, opacity: n ? 1 : 0.15 }} title={`kl. ${h}: ${n} ordrer`} />
          ))}
        </div>
        <div className="bar-labels">
          {hours.map((_, h) => (
            <span key={h}>{h % 3 === 0 ? h : ''}</span>
          ))}
        </div>
      </Card>
    </>
  );
}
