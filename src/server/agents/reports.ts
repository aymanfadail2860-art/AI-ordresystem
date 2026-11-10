import type { Ctx } from '../context';
import type { RoutingService } from './routing';
import type { ReplenishmentService } from './replenishment';
import { clock } from '../clock';
import { nowIso, parseJson } from '../db/database';
import { formatDkk } from '../../core/money';
import { isOpen } from '../../core/openingHours';
import { DEFAULT_TZ, formatClock, formatLocalDate, startOfHour, startOfLocalDay } from '../../core/time';
import type { ManagementReport, ReportMetrics } from '../../shared/types';

const HOUR = 3_600_000;
const ACTIVE = ['confirmed', 'awaiting_driver', 'driver_assigned', 'out_for_delivery'];

/**
 * Ledelsesrapporter. Alle tal beregnes deterministisk fra databasen – Claude
 * bruges ikke, så rapporter kan sendes uden API-nøgle.
 *
 * Timerapporter: et job kører lige efter hver hele time (UTC-timegrænser er
 * også hele timer i Europe/Copenhagen, også ved sommer-/vintertid). Er
 * virksomheden åben i den forløbne time, oprettes én rapport for perioden
 * (unikt indeks på period_start) og lægges i Telegram-udbakken med en
 * idempotensnøgle. Et nedbrud kan derfor aldrig give dobbeltrapporter; en
 * afsendelse, der var i gang under et nedbrud, markeres "usikker" og gensendes
 * ikke. Efter længere nedetid sendes kun den seneste periode – de mellemliggende
 * registreres som "sprunget over".
 */
export class ReportService {
  constructor(
    private ctx: Ctx,
    private routing: RoutingService,
    private replenishment: ReplenishmentService,
  ) {
    ctx.jobs.register('report_tick', async () => {
      try {
        this.runDue();
      } finally {
        this.scheduleNext();
      }
    });
  }

  start(): void {
    this.ctx.jobs.enqueue('report_tick', {}, { delayMs: 5_000, dedupeKey: 'report_tick' });
  }

  private scheduleNext(): void {
    const next = startOfHour(clock.now()) + HOUR + 10_000;
    this.ctx.jobs.enqueue('report_tick', {}, { runAt: new Date(next), dedupeKey: 'report_tick' });
  }

  private tz(): string {
    return this.ctx.settings.get().company.timezone || DEFAULT_TZ;
  }

  /** Var virksomheden åben i (en del af) perioden? */
  openDuring(startMs: number, endMs: number): boolean {
    const s = this.ctx.settings.get();
    for (let t = startMs; t < endMs; t += 15 * 60_000) if (isOpen(s.openingHours, new Date(t), this.tz())) return true;
    return isOpen(s.openingHours, new Date(endMs - 60_000), this.tz());
  }

  /**
   * Opret og send forfaldne timerapporter. Idempotent – kan kaldes vilkårligt
   * ofte (også efter genstart). Returnerer id for en ny rapport, hvis der blev sendt en.
   */
  runDue(): number | null {
    const { ctx } = this;
    this.syncStatuses();
    this.resumePending();
    const now = clock.now();
    const boundary = startOfHour(now);
    const latestStart = boundary - HOUR;
    const lastChecked = ctx.kv.get<number | null>('reports:last_boundary', null);
    ctx.kv.set('reports:last_boundary', boundary);
    // Perioder der blev misset under nedetid (højst et døgn tilbage) registreres som sprunget over
    if (lastChecked != null && lastChecked < boundary) {
      for (let p = Math.max(lastChecked - HOUR, boundary - 24 * HOUR); p < latestStart; p += HOUR) {
        if (!this.openDuring(p, p + HOUR)) continue;
        ctx.db
          .prepare(
            `INSERT INTO management_reports (kind, period_start, period_end, status, error, created_at, updated_at) VALUES ('hourly', ?, ?, 'skipped', ?, ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(new Date(p).toISOString(), new Date(p + HOUR).toISOString(), 'Ikke sendt – systemet var ikke kørende ved timeskiftet', nowIso(), nowIso());
      }
    }
    if (!ctx.settings.get().management.hourlyReports) return null;
    if (!this.openDuring(latestStart, boundary)) return null;
    // Rapporten for en time sendes kun inden for den efterfølgende time (ellers er den forældet)
    if (now - boundary > 55 * 60_000) return null;
    const startIso = new Date(latestStart).toISOString();
    const created = ctx.db
      .prepare(
        `INSERT INTO management_reports (kind, period_start, period_end, status, requested_by, created_at, updated_at) VALUES ('hourly', ?, ?, 'pending', 'system', ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(startIso, new Date(boundary).toISOString(), nowIso(), nowIso());
    if (created.changes === 0) return null;
    const id = Number(created.lastInsertRowid);
    this.deliver(id);
    return id;
  }

  /** Rapporter der blev oprettet, men ikke nåede udbakken før et nedbrud. */
  private resumePending(): void {
    const rows = this.ctx.db.prepare(`SELECT id FROM management_reports WHERE status = 'pending' AND kind = 'hourly'`).all() as { id: number }[];
    for (const r of rows) this.deliver(r.id);
  }

  /** Byg rapporten og læg den i udbakken – i én transaktion. */
  private deliver(id: number): void {
    const { ctx } = this;
    const row = ctx.db.prepare(`SELECT * FROM management_reports WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'pending') return;
    const start = new Date(row.period_start as string).getTime();
    const end = new Date(row.period_end as string).getTime();
    const metrics = this.compute(start, end);
    const body = this.format(metrics, row.kind as 'hourly' | 'on_demand');
    const chatId = ctx.settings.get().management.groupChatId;
    const key = `report:${row.kind}:${row.kind === 'hourly' ? row.period_start : id}`;
    ctx.db.transaction(() => {
      if (!chatId) {
        ctx.db
          .prepare(`UPDATE management_reports SET status = 'skipped', body = ?, metrics = ?, error = ?, updated_at = ? WHERE id = ?`)
          .run(body, JSON.stringify(metrics), 'Ledelsesgruppen er ikke konfigureret', nowIso(), id);
        return;
      }
      ctx.telegram.sendToChat(chatId, body, key);
      ctx.db
        .prepare(`UPDATE management_reports SET status = 'queued', chat_id = ?, body = ?, metrics = ?, message_key = ?, updated_at = ? WHERE id = ?`)
        .run(chatId, body, JSON.stringify(metrics), key, nowIso(), id);
    })();
    ctx.bus.touch('reports');
  }

  /** Opdatér rapportstatus ud fra udbakkens faktiske afsendelsesresultat. */
  syncStatuses(): void {
    const { ctx } = this;
    const rows = ctx.db.prepare(`SELECT id, message_key FROM management_reports WHERE status = 'queued'`).all() as { id: number; message_key: string }[];
    for (const r of rows) {
      const st = ctx.telegram.chatMessageStatus(r.message_key);
      const map: Record<string, string> = { sent: 'sent', uncertain: 'uncertain', failed: 'failed' };
      if (st && map[st]) {
        ctx.db
          .prepare(`UPDATE management_reports SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, error = CASE WHEN ? = 'sent' THEN NULL ELSE ? END, updated_at = ? WHERE id = ?`)
          .run(map[st], map[st], nowIso(), map[st], st === 'uncertain' ? 'Afsendelse afbrudt – ukendt om den nåede frem (gensendes ikke)' : 'Telegram-afsendelse fejlede', nowIso(), r.id);
        ctx.bus.touch('reports');
      }
    }
  }

  /** Rapport på forespørgsel (ledelsesgruppen eller kontrolpanelet). */
  sendOnDemand(chatId: string, requestedBy: string): { id: number; body: string } {
    const { ctx } = this;
    const now = clock.now();
    const r = ctx.db
      .prepare(
        `INSERT INTO management_reports (kind, period_start, period_end, status, requested_by, created_at, updated_at) VALUES ('on_demand', ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(new Date(now - HOUR).toISOString(), new Date(now).toISOString(), requestedBy, nowIso(), nowIso());
    const id = Number(r.lastInsertRowid);
    const metrics = this.compute(now - HOUR, now);
    const body = this.format(metrics, 'on_demand');
    const key = `report:on_demand:${id}`;
    ctx.db.transaction(() => {
      ctx.telegram.sendToChat(chatId, body, key);
      ctx.db
        .prepare(`UPDATE management_reports SET status = 'queued', chat_id = ?, body = ?, metrics = ?, message_key = ?, updated_at = ? WHERE id = ?`)
        .run(chatId, body, JSON.stringify(metrics), key, nowIso(), id);
    })();
    ctx.bus.touch('reports');
    return { id, body };
  }

  /** Forhåndsvisning uden at sende eller gemme. */
  preview(): { metrics: ReportMetrics; body: string } {
    const now = clock.now();
    const metrics = this.compute(now - HOUR, now);
    return { metrics, body: this.format(metrics, 'on_demand') };
  }

  list(limit = 100): ManagementReport[] {
    this.syncStatuses();
    return (this.ctx.db.prepare(`SELECT * FROM management_reports ORDER BY period_end DESC, id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      kind: r.kind as ManagementReport['kind'],
      periodStart: r.period_start as string,
      periodEnd: r.period_end as string,
      status: r.status as ManagementReport['status'],
      body: (r.body as string) ?? null,
      metrics: parseJson<ReportMetrics | null>(r.metrics as string | null, null),
      requestedBy: (r.requested_by as string) ?? null,
      error: (r.error as string) ?? null,
      createdAt: r.created_at as string,
      sentAt: (r.sent_at as string) ?? null,
    }));
  }

  // ---------------- Nøgletal ----------------

  private value(ids: { id: number; delivery_fee_ore: number }[]): number {
    const margin = this.ctx.settings.get().economics.defaultMarginPct;
    return ids.reduce((s, o) => s + this.routing.valueOf(o.id, o.delivery_fee_ore, margin).contributionOre, 0);
  }

  private delivered(fromMs: number, toMs: number) {
    const rows = this.ctx.db
      .prepare(`SELECT id, total_ore, delivery_fee_ore, confirmed_at, delivered_at, eta_communicated FROM orders WHERE status = 'delivered' AND delivered_at >= ? AND delivered_at < ?`)
      .all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as {
      id: number;
      total_ore: number;
      delivery_fee_ore: number;
      confirmed_at: string | null;
      delivered_at: string;
      eta_communicated: string | null;
    }[];
    return { rows, revenue: rows.reduce((s, r) => s + r.total_ore, 0), contribution: this.value(rows) };
  }

  private countConfirmed(fromMs: number, toMs: number): number {
    return (
      this.ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE confirmed_at >= ? AND confirmed_at < ?`).get(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as {
        c: number;
      }
    ).c;
  }

  compute(periodStartMs: number, periodEndMs: number): ReportMetrics {
    const { ctx } = this;
    const s = ctx.settings.get();
    const tz = this.tz();
    const now = clock.now();
    const dayStart = startOfLocalDay(periodEndMs - 1, tz);
    const tol = s.economics.promiseToleranceMinutes;

    const hour = this.delivered(periodStartMs, periodEndMs);
    const day = this.delivered(dayStart, periodEndMs);
    const cancelledToday = (
      ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = 'cancelled' AND confirmed_at IS NOT NULL AND cancelled_at >= ? AND cancelled_at < ?`).get(new Date(dayStart).toISOString(), new Date(periodEndMs).toISOString()) as {
        c: number;
      }
    ).c;
    const durations = day.rows.filter((r) => r.confirmed_at).map((r) => (new Date(r.delivered_at).getTime() - new Date(r.confirmed_at!).getTime()) / 60000);
    const promised = day.rows.filter((r) => r.eta_communicated);
    const onTime = promised.filter((r) => new Date(r.delivered_at).getTime() <= new Date(r.eta_communicated!).getTime() + tol * 60000).length;

    const active = ctx.db
      .prepare(`SELECT id, status, eta, eta_communicated, eta_confidence, confirmed_at FROM orders WHERE status IN (${ACTIVE.map(() => '?').join(',')})`)
      .all(...ACTIVE) as { id: number; status: string; eta: string | null; eta_communicated: string | null; eta_confidence: string | null; confirmed_at: string | null }[];
    const late = active
      .filter((o) => o.eta_communicated)
      .map((o) => {
        const promisedMs = new Date(o.eta_communicated!).getTime();
        const expected = Math.max(now, o.eta ? new Date(o.eta).getTime() : now);
        return { orderId: o.id, minutes: Math.round((expected - promisedMs) / 60000) };
      })
      .filter((x) => x.minutes > tol)
      .sort((a, b) => b.minutes - a.minutes);
    const waiting = active.filter((o) => o.status === 'confirmed' || o.status === 'awaiting_driver');
    const longestWait = waiting.reduce((m, o) => Math.max(m, o.confirmed_at ? (now - new Date(o.confirmed_at).getTime()) / 60000 : 0), 0);
    const needsManual = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = 'needs_manual'`).get() as { c: number }).c;

    const drivers = ctx.drivers.list();
    const activeDrivers = drivers.filter((d) => d.status === 'available' || d.status === 'busy');
    const staleLimit = now - s.logistics.statusStaleMinutes * 60000;
    const staleDrivers = drivers.filter((d) => d.activeOrderCount > 0 && (!d.lastStatusAt || new Date(d.lastStatusAt).getTime() < staleLimit)).length;

    // Chaufførtimer i dag ≈ aktive chauffører pr. tidligere timerapport i dag + denne time
    const earlier = ctx.db
      .prepare(`SELECT metrics FROM management_reports WHERE kind = 'hourly' AND metrics IS NOT NULL AND period_start >= ? AND period_end <= ?`)
      .all(new Date(dayStart).toISOString(), new Date(periodStartMs).toISOString()) as { metrics: string }[];
    const driverHoursDay = earlier.reduce((sum, r) => sum + (parseJson<ReportMetrics | null>(r.metrics, null)?.drivers.active ?? 0), 0) + activeDrivers.length;

    const shortages: ReportMetrics['stock']['shortages'] = [];
    for (const d of drivers.filter((x) => x.activeOrderCount > 0)) {
      try {
        const f = this.replenishment.forecast(d.id);
        for (const x of f.shortages) shortages.push({ driverName: d.name, productName: x.productName, missing: x.missing, covered: f.activeReplenishmentId != null });
      } catch {
        /* prognose er best effort i rapporten */
      }
    }
    const reps = this.replenishment.list({ activeOnly: true });
    const pendingCommands = (
      ctx.db.prepare(`SELECT COUNT(*) AS c FROM management_commands WHERE decision = 'needs_confirmation' AND (confirm_expires_at IS NULL OR confirm_expires_at > ?)`).get(nowIso()) as { c: number }
    ).c;
    const openSuggestions = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM reassignment_suggestions WHERE status = 'open'`).get() as { c: number }).c;
    const ai = ctx.ai.summary();
    const aiCallsHour = (
      ctx.db.prepare(`SELECT COUNT(*) AS c FROM ai_calls WHERE created_at >= ? AND created_at < ?`).get(new Date(periodStartMs).toISOString(), new Date(periodEndMs).toISOString()) as { c: number }
    ).c;
    const integrations = ctx.integrations.list().filter((i) => i.state === 'error' || i.state === 'degraded').map((i) => ({ name: i.name, state: i.state, message: i.message }));

    const m: ReportMetrics = {
      periodStart: new Date(periodStartMs).toISOString(),
      periodEnd: new Date(periodEndMs).toISOString(),
      dayStart: new Date(dayStart).toISOString(),
      generatedAt: new Date(now).toISOString(),
      simulated: s.installation.mode === 'demo',
      hour: { revenueOre: hour.revenue, contributionOre: hour.contribution, delivered: hour.rows.length, newOrders: this.countConfirmed(periodStartMs, periodEndMs) },
      day: {
        revenueOre: day.revenue,
        contributionOre: day.contribution,
        delivered: day.rows.length,
        newOrders: this.countConfirmed(dayStart, periodEndMs),
        cancelled: cancelledToday,
        avgOrderValueOre: day.rows.length ? Math.round(day.revenue / day.rows.length) : null,
        avgDeliveryMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
        onTimePct: promised.length ? Math.round((onTime / promised.length) * 100) : null,
      },
      orders: { active: active.length, awaitingDriver: waiting.length, longestWaitMinutes: Math.round(longestWait), needsManual },
      drivers: {
        active: activeDrivers.length,
        staleStatus: staleDrivers,
        deliveriesPerDriverHour: activeDrivers.length ? Math.round((hour.rows.length / activeDrivers.length) * 10) / 10 : null,
        deliveriesPerDriverHourDay: driverHoursDay ? Math.round((day.rows.length / driverHoursDay) * 10) / 10 : null,
      },
      late: { count: late.length, worst: late.slice(0, 3), lowConfidence: active.filter((o) => o.eta_confidence === 'low').length },
      stock: {
        shortages,
        replenishments: reps.map((r) => ({ id: r.id, driverName: r.driverName, status: r.status, locationName: r.locationName })),
      },
      approvals: { replenishments: reps.filter((r) => r.status === 'awaiting_management').length, commands: pendingCommands, reassignments: openSuggestions },
      ai: {
        monthCostUsd: Math.round(ai.monthCostUsd * 100) / 100,
        budgetUsd: ai.budgetUsd,
        budgetUsedPct: Math.round(ai.budgetUsedPct),
        blocked: ai.budgetBlocked,
        callsInPeriod: aiCallsHour,
        live: ctx.ai.configured && s.installation.mode !== 'demo',
      },
      integrations,
      assessment: [],
    };
    m.assessment = this.assess(m);
    return m;
  }

  /** Kort, konkret driftsvurdering ud fra nøgletallene (regelbaseret). */
  assess(m: ReportMetrics): string[] {
    const s = this.ctx.settings.get();
    const out: string[] = [];
    if (m.integrations.some((i) => i.state === 'error')) out.push(`Integrationsfejl: ${m.integrations.filter((i) => i.state === 'error').map((i) => i.name).join(', ')} – kontrollér forbindelsen.`);
    if (m.late.count) out.push(`${m.late.count} ordre${m.late.count > 1 ? 'r' : ''} er bagud i forhold til løftet (værst #${m.late.worst[0].orderId} +${m.late.worst[0].minutes} min).`);
    if (m.orders.awaitingDriver && m.orders.longestWaitMinutes >= s.monitoring.capacityWaitMinutes)
      out.push(`Kapacitet: ${m.orders.awaitingDriver} ordre${m.orders.awaitingDriver > 1 ? 'r' : ''} venter på chauffør (længst ${m.orders.longestWaitMinutes} min) – overvej en ekstra chauffør.`);
    const uncovered = m.stock.shortages.filter((x) => !x.covered);
    if (uncovered.length) out.push(`Lager: ${uncovered.map((x) => `${x.driverName} mangler ${x.missing}× ${x.productName}`).join(', ')} uden aftalt opfyldning.`);
    const approvals = m.approvals.replenishments + m.approvals.commands + m.approvals.reassignments;
    if (approvals) out.push(`${approvals} beslutning${approvals > 1 ? 'er' : ''} afventer ledelsen.`);
    if (m.day.onTimePct != null && m.day.onTimePct < 85 && m.day.delivered >= 5) out.push(`Kun ${m.day.onTimePct} % leveret til tiden i dag.`);
    if (m.ai.blocked) out.push('AI-budgettet er opbrugt – kundesamtaler går til medarbejder.');
    else if (m.ai.budgetUsd > 0 && m.ai.budgetUsedPct >= s.ai.warnAtPct) out.push(`AI-forbrug: ${m.ai.budgetUsedPct} % af månedsbudgettet.`);
    if (m.orders.needsManual) out.push(`${m.orders.needsManual} ordre${m.orders.needsManual > 1 ? 'r' : ''} kræver manuel behandling.`);
    if (!out.length) {
      out.push(
        m.drivers.active
          ? `Driften kører normalt${m.drivers.deliveriesPerDriverHour != null ? ` (${m.drivers.deliveriesPerDriverHour.toLocaleString('da-DK')} lev. pr. chaufførtime)` : ''}.`
          : 'Ingen aktive chauffører og intet der kræver handling.',
      );
    }
    return out.slice(0, 4);
  }

  format(m: ReportMetrics, kind: 'hourly' | 'on_demand'): string {
    const tz = this.tz();
    const start = new Date(m.periodStart).getTime();
    const end = new Date(m.periodEnd).getTime();
    const title = kind === 'hourly' ? `📊 Timerapport ${formatClock(start, tz)}–${formatClock(end, tz)}` : `📊 Rapport kl. ${formatClock(end, tz)} (seneste time)`;
    const pct = (x: number | null) => (x == null ? '–' : `${x} %`);
    const lines = [
      `${title}, ${formatLocalDate(end - 1, tz)}${m.simulated ? ' – DEMO: simulerede data' : ''}`,
      `Seneste time: ${formatDkk(m.hour.revenueOre)} omsætning · DB ${formatDkk(m.hour.contributionOre)} · ${m.hour.delivered} leveret · ${m.hour.newOrders} nye`,
      `I dag: ${formatDkk(m.day.revenueOre)} · DB ${formatDkk(m.day.contributionOre)} · ${m.day.delivered} leveret · ${m.day.newOrders} nye · ${m.day.cancelled} annulleret${m.day.avgOrderValueOre != null ? ` · gns. ordre ${formatDkk(m.day.avgOrderValueOre)}` : ''}`,
      `Ordrer nu: ${m.orders.active} aktive · ${m.orders.awaitingDriver} afventer chauffør${m.orders.needsManual ? ` · ${m.orders.needsManual} kræver manuel behandling` : ''}`,
      `Chauffører: ${m.drivers.active} aktive · ${m.drivers.deliveriesPerDriverHour != null ? m.drivers.deliveriesPerDriverHour.toLocaleString('da-DK') : '–'} lev./chaufførtime (i dag ${m.drivers.deliveriesPerDriverHourDay != null ? m.drivers.deliveriesPerDriverHourDay.toLocaleString('da-DK') : '–'}) · gns. leveringstid ${m.day.avgDeliveryMinutes != null ? `${m.day.avgDeliveryMinutes} min` : '–'} · til tiden ${pct(m.day.onTimePct)}`,
      `Forsinket: ${m.late.count}${m.late.worst.length ? ` (${m.late.worst.map((x) => `#${x.orderId} +${x.minutes} min`).join(', ')})` : ''} · usikre ETA'er: ${m.late.lowConfidence}${m.drivers.staleStatus ? ` · ${m.drivers.staleStatus} chauffør(er) uden frisk status` : ''}`,
      `Lager: ${m.stock.shortages.length ? m.stock.shortages.map((x) => `${x.driverName} mangler ${x.missing}× ${x.productName}${x.covered ? ' (opfyldning planlagt)' : ''}`).join(', ') : 'ingen forventede underskud'}${m.stock.replenishments.length ? ` · ${m.stock.replenishments.length} opfyldning(er) i gang` : ''}`,
      `Godkendelser: ${m.approvals.replenishments} opfyldning · ${m.approvals.reassignments} omfordeling · ${m.approvals.commands} instruktion`,
      `AI: ${m.ai.live ? `${m.ai.monthCostUsd.toLocaleString('da-DK')} USD denne måned${m.ai.budgetUsd ? ` (${m.ai.budgetUsedPct} % af ${m.ai.budgetUsd} USD)` : ''} · ${m.ai.callsInPeriod} kald i perioden` : 'ingen Claude API-kald (demo/ikke konfigureret)'}`,
      `Vurdering: ${m.assessment.join(' ')}`,
    ];
    return lines.join('\n');
  }
}
