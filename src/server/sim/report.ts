import { COMPARED, type StrategyComparison } from './daySimulation';
import { DISPATCH_STRATEGY_LABELS, type SimulationMetrics } from '../../shared/types';

const fmt = (key: keyof SimulationMetrics, v: number) =>
  key === 'revenueOre' || key === 'contributionOre' ? `${Math.round(v / 100).toLocaleString('da-DK')} kr.` : v.toLocaleString('da-DK');

/** Markdown-rapport over en strategisammenligning (simulerede data). */
export function comparisonMarkdown(c: StrategyComparison, cfg: { orders: number; drivers: number; date?: string }): string {
  const rs = c.results;
  const head = `| Nøgletal | ${rs.map((r) => DISPATCH_STRATEGY_LABELS[r.strategy]).join(' | ')} | Bedst |`;
  const sep = `|---|${rs.map(() => '---:').join('|')}|---|`;
  const rows = COMPARED.map((m) => {
    const best = c.best[m.key as string] ?? [];
    return `| ${m.label} (${m.better === 'higher' ? 'højere' : 'lavere'} er bedst) | ${rs
      .map((r) => (best.includes(r.strategy) ? `**${fmt(m.key, r[m.key] as number)}**` : fmt(m.key, r[m.key] as number)))
      .join(' | ')} | ${best.map((b) => DISPATCH_STRATEGY_LABELS[b].split('.')[0]).join(', ')} |`;
  });
  const extra = (['ordersGenerated', 'ordersAccepted', 'cancelled', 'unresolved', 'lateCount', 'driveMinutes', 'extraDriveMinutes', 'replenishments', 'replenishmentsCompleted', 'offersRejectedOrExpired', 'conversationsNeedingStaff', 'integrationFailures', 'hourlyReportsSent', 'alertsRaised', 'driverHours', 'deliveriesPerHour'] as (keyof SimulationMetrics)[]).map(
    (k) => `| ${k} | ${rs.map((r) => fmt(k, r[k] as number)).join(' | ')} | |`,
  );
  return [
    `# Driftssimulering – sammenligning af dispatchstrategier`,
    '',
    `> **SIMULEREDE DATA.** Resultatet stammer fra Demo Mode med simulerede kunder, chauffører, kort og Telegram. Det beviser ikke ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.`,
    '',
    `Seed ${c.seed} · ${cfg.orders} kundehenvendelser · ${cfg.drivers} chauffører · ${cfg.date ?? '2026-06-16'} kl. 10–22 (Europe/Copenhagen) · midlertidige fejl: Telegram-udfald 12 min, Google Maps-udfald 20 min, én chauffør uden svar i 35 min.`,
    '',
    head,
    sep,
    ...rows,
    '',
    '## Øvrige tal',
    '',
    `| Felt | ${rs.map((r) => DISPATCH_STRATEGY_LABELS[r.strategy]).join(' | ')} | |`,
    sep,
    ...extra,
    '',
    '## Vurdering',
    '',
    ...c.summary.map((s) => `- ${s}`),
    '',
  ].join('\n');
}
