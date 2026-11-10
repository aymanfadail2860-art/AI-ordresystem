import type { Ctx } from '../context';
import type { RoutingService } from './routing';
import type { ReplenishmentService } from './replenishment';
import { clock } from '../clock';
import { nowIso, parseJson } from '../db/database';
import { formatTime } from './replies';
import type { AlertCategory, AlertRule, MonitorAlert } from '../../shared/types';
import { ALERT_CATEGORY_LABELS, ALERT_RULE_LABELS } from '../../shared/types';

const RANK: Record<AlertCategory, number> = { auto: 0, inform: 1, approval: 2, takeover: 3 };
const ASSIGNED = ['driver_assigned', 'out_for_delivery'];
/** Regler, der evalueres i hver kørsel (åbne advarsler for andre regler lukkes ikke). */
const RULES: AlertRule[] = [
  'critical_delay',
  'promise_risk',
  'driver_unresponsive',
  'capacity_shortage',
  'stock_shortage',
  'approval_expiring',
  'order_volume_change',
  'integration_failure',
];

interface Finding {
  rule: AlertRule;
  key: string;
  category: AlertCategory;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  data?: Record<string, unknown>;
  /** Beskrivelse af hvad systemet gør/har gjort (logges). */
  handling: string;
  /** Automatisk handling inden for reglerne (udføres én gang pr. advarsel/eskalering). */
  act?: () => void;
  /** false = en anden modul sender allerede beskeden til ledelsen. */
  notify?: boolean;
}

/**
 * Proaktiv ledelsesassistent (deterministisk, ingen AI-kald).
 *
 * Evaluerer driften hvert minut og ved integrationsændringer. Hver hændelse
 * klassificeres som:
 *   A  håndteres automatisk inden for reglerne (logges, ingen besked)
 *   B  orientering til ledelsen
 *   C  kræver ledelsesgodkendelse
 *   D  kræver øjeblikkelig menneskelig overtagelse
 * Samme problem giver kun én åben advarsel (unik alert_key; en kvitteret
 * advarsel forbliver tavs, indtil den eskalerer eller løses). Ledelsen får kun
 * en ny besked, hvis problemet eskalerer til en højere kategori. Når
 * tilstanden ophører, lukkes advarslen automatisk. Alle beslutninger logges i
 * monitor_decisions.
 */
export class MonitorService {
  constructor(
    private ctx: Ctx,
    private routing: RoutingService,
    private replenishment: ReplenishmentService,
  ) {
    ctx.jobs.registerRecurring('monitor_tick', 60_000, async () => {
      await this.evaluate();
    });
    ctx.jobs.register('monitor_eval', async () => {
      await this.evaluate();
    });
    ctx.bus.on('integration_state', () => {
      ctx.jobs.enqueue('monitor_eval', {}, { delayMs: 1000, dedupeKey: 'monitor_eval' });
    });
  }

  start(): void {
    this.ctx.jobs.enqueue('monitor_tick', {}, { delayMs: 15_000, dedupeKey: 'monitor_tick' });
  }

  // ---------------- Regler ----------------

  private findings(): Finding[] {
    const { ctx } = this;
    const s = ctx.settings.get();
    const m = s.monitoring;
    const now = clock.now();
    const tol = s.economics.promiseToleranceMinutes;
    const out: Finding[] = [];
    const drivers = ctx.drivers.list();
    const driverName = (id: number | null) => drivers.find((d) => d.id === id)?.name ?? 'ukendt chauffør';

    // 1+8. Forsinkelser og risiko for brud på leveringsløfter
    const assigned = ctx.db
      .prepare(`SELECT id, driver_id, eta, eta_communicated, eta_confidence, needs_attention FROM orders WHERE status IN ('driver_assigned','out_for_delivery') AND eta_communicated IS NOT NULL`)
      .all() as { id: number; driver_id: number | null; eta: string | null; eta_communicated: string; eta_confidence: string | null; needs_attention: number }[];
    const suggestions = new Set((ctx.db.prepare(`SELECT order_id FROM reassignment_suggestions WHERE status = 'open'`).all() as { order_id: number }[]).map((r) => r.order_id));
    const riskByDriver = new Map<number, number[]>();
    for (const o of assigned) {
      const promised = new Date(o.eta_communicated).getTime();
      const expected = Math.max(now, o.eta ? new Date(o.eta).getTime() : now);
      const late = Math.round((expected - promised) / 60000);
      const who = driverName(o.driver_id);
      if (late > tol) {
        const category: AlertCategory = late >= m.takeoverDelayMinutes ? 'takeover' : late >= m.criticalDelayMinutes ? 'inform' : 'auto';
        out.push({
          rule: 'critical_delay',
          key: `critical_delay:order:${o.id}`,
          category,
          severity: category === 'takeover' ? 'critical' : category === 'inform' ? 'warn' : 'info',
          title: `Ordre #${o.id} er ${late} min bagud`,
          message: `Ordre #${o.id} (${who}) forventes ${late} min efter det lovede tidspunkt kl. ${formatTime(o.eta_communicated)}.`,
          data: { orderId: o.id, driverId: o.driver_id, lateMinutes: late },
          handling:
            category === 'takeover'
              ? 'Ordren er markeret til manuel opfølgning – ring til kunden og chaufføren.'
              : suggestions.has(o.id)
                ? 'Kunden får automatisk ETA-opdatering; et omfordelingsforslag ligger klar i Logistik.'
                : 'Kunden får automatisk ETA-opdatering efter de konfigurerede grænser.',
          act:
            category === 'takeover' && !o.needs_attention
              ? () => ctx.orders.flag(o.id, `Kritisk forsinkelse (${late} min) – kræver menneskelig opfølgning`)
              : undefined,
        });
      } else if (expected > promised && o.eta_confidence === 'low') {
        if (o.driver_id != null) riskByDriver.set(o.driver_id, [...(riskByDriver.get(o.driver_id) ?? []), o.id]);
        if (suggestions.has(o.id)) {
          out.push({
            rule: 'promise_risk',
            key: `promise_risk:order:${o.id}`,
            category: 'approval',
            severity: 'warn',
            title: `Risiko for brud på løftet for ordre #${o.id}`,
            message: `Ordre #${o.id} (${who}) har usikker ETA tæt på løftet. Et omfordelingsforslag afventer godkendelse i Logistik.`,
            data: { orderId: o.id, driverId: o.driver_id },
            handling: 'Afventer ledelsens godkendelse af omfordelingsforslaget (den nye chauffør skal acceptere).',
          });
        } else {
          out.push({
            rule: 'promise_risk',
            key: `promise_risk:order:${o.id}`,
            category: 'auto',
            severity: 'info',
            title: `Usikker ETA for ordre #${o.id}`,
            message: `Ordre #${o.id} (${who}) har usikker ETA tæt på løftet.`,
            data: { orderId: o.id, driverId: o.driver_id },
            handling: 'Overvåges; chaufføren bedes om status, og kunden informeres automatisk, hvis ETA rykker sig.',
          });
        }
      }
    }
    for (const [driverId, ids] of riskByDriver) {
      if (ids.length < 3) continue;
      out.push({
        rule: 'promise_risk',
        key: `promise_risk:driver:${driverId}`,
        category: 'inform',
        severity: 'warn',
        title: `${driverName(driverId)}: ${ids.length} løfter i fare`,
        message: `${driverName(driverId)} har ${ids.length} ordrer med usikker ETA tæt på løftet (${ids.map((x) => '#' + x).join(', ')}).`,
        data: { driverId, orderIds: ids },
        handling: 'Overvej at flytte en ordre til en anden chauffør ("Flyt ordre X til chauffør Y").',
      });
    }

    // 2. Chauffører der ikke svarer
    for (const d of drivers) {
      if (d.activeOrderCount === 0 || d.status === 'offline') continue;
      const last = d.lastStatusAt ? new Date(d.lastStatusAt).getTime() : null;
      if (last == null) continue;
      const silent = Math.round((now - last) / 60000);
      if (silent < m.unresponsiveMinutes) continue;
      const category: AlertCategory = silent >= m.unresponsiveMinutes * 2 ? 'takeover' : 'inform';
      out.push({
        rule: 'driver_unresponsive',
        key: `driver_unresponsive:${d.id}`,
        category,
        severity: category === 'takeover' ? 'critical' : 'warn',
        title: `${d.name} har ikke svaret i ${silent} min`,
        message: `${d.name} har ${d.activeOrderCount} aktive ordrer og har ikke givet status i ${silent} min. Botten har spurgt automatisk.`,
        data: { driverId: d.id, silentMinutes: silent },
        handling: category === 'takeover' ? 'Ring til chaufføren. Overvej at omfordele ordrerne.' : 'Statusforespørgsel er sendt automatisk; ledelsen orienteres.',
      });
    }

    // 3. Manglende chaufførkapacitet
    const waiting = ctx.db
      .prepare(`SELECT id, confirmed_at FROM orders WHERE status IN ('confirmed','awaiting_driver') AND confirmed_at IS NOT NULL`)
      .all() as { id: number; confirmed_at: string }[];
    const longWaits = waiting.map((o) => ({ id: o.id, min: Math.round((now - new Date(o.confirmed_at).getTime()) / 60000) })).filter((x) => x.min >= m.capacityWaitMinutes);
    if (longWaits.length) {
      const worst = Math.max(...longWaits.map((x) => x.min));
      const available = drivers.filter((d) => d.status === 'available' || d.status === 'busy').length;
      const category: AlertCategory = worst >= m.capacityWaitMinutes * 2 ? 'takeover' : 'inform';
      out.push({
        rule: 'capacity_shortage',
        key: 'capacity_shortage',
        category,
        severity: category === 'takeover' ? 'critical' : 'warn',
        title: `${longWaits.length} ordre${longWaits.length > 1 ? 'r' : ''} venter på chauffør`,
        message: `${longWaits.length} bekræftede ordrer har ventet over ${m.capacityWaitMinutes} min på en chauffør (længst ${worst} min). ${available} chauffører er aktive.`,
        data: { orderIds: longWaits.map((x) => x.id), worstMinutes: worst, activeDrivers: available },
        handling:
          category === 'takeover'
            ? 'Kald en ekstra chauffør ind eller kontakt kunderne – dispatch finder ingen forsvarlig løsning.'
            : 'Dispatch prøver automatisk igen hvert minut; overvej en ekstra chauffør.',
      });
    }

    // 4. Lagerunderskud
    for (const d of drivers.filter((x) => x.activeOrderCount > 0)) {
      let f;
      try {
        f = this.replenishment.forecast(d.id);
      } catch {
        continue;
      }
      if (!f.shortages.length) continue;
      const rep = f.activeReplenishmentId ? this.replenishment.get(f.activeReplenishmentId) : null;
      const what = f.shortages.map((x) => `${x.missing}× ${x.productName}`).join(', ');
      const key = `stock_shortage:driver:${d.id}`;
      const existing = this.openAlert(key);
      const ageMin = existing ? (now - new Date(existing.firstSeenAt).getTime()) / 60000 : 0;
      if (rep?.status === 'awaiting_management') {
        out.push({
          rule: 'stock_shortage',
          key,
          category: 'approval',
          severity: 'warn',
          title: `${d.name} mangler ${what}`,
          message: `${d.name} mangler ${what} fra ordre #${f.shortages[0].firstStopOrderId}. Opfyldning #${rep.id} afventer ledelsens godkendelse.`,
          data: { driverId: d.id, replenishmentId: rep.id },
          handling: `Godkend eller afvis opfyldning #${rep.id} (knapperne i gruppen eller Ledelsescenter).`,
          notify: false, // forslaget er allerede sendt til gruppen af opfyldningsmodulet
        });
      } else if (rep) {
        out.push({
          rule: 'stock_shortage',
          key,
          category: 'auto',
          severity: 'info',
          title: `${d.name} mangler ${what}`,
          message: `${d.name} mangler ${what}. Opfyldning #${rep.id} er i gang.`,
          data: { driverId: d.id, replenishmentId: rep.id },
          handling: `Håndteres af opfyldning #${rep.id}.`,
        });
      } else {
        const stuck = ageMin >= 5 || !ctx.settings.get().replenishment.enabled;
        out.push({
          rule: 'stock_shortage',
          key,
          category: stuck ? 'inform' : 'auto',
          severity: stuck ? 'warn' : 'info',
          title: `${d.name} mangler ${what}`,
          message: `${d.name} forventes at mangle ${what} fra ordre #${f.shortages[0].firstStopOrderId}${stuck ? ', og der er ingen opfyldning planlagt' : ''}.`,
          data: { driverId: d.id },
          handling: stuck ? 'Ingen forsvarlig opfyldning fundet – overvej omfordeling eller kontakt chaufføren.' : 'Opfyldningsforslag beregnes automatisk.',
          act: stuck ? undefined : () => this.replenishment.scheduleCheck(d.id, 'overvågning: lagerunderskud'),
        });
      }
    }

    // 5. Godkendelser der nærmer sig udløb
    const warnUntil = new Date(now + m.approvalWarnMinutes * 60000).toISOString();
    const reps = ctx.db
      .prepare(`SELECT id, driver_id, deadline_at FROM replenishments WHERE status = 'awaiting_management' AND deadline_at IS NOT NULL AND deadline_at <= ?`)
      .all(warnUntil) as { id: number; driver_id: number; deadline_at: string }[];
    for (const r of reps) {
      out.push({
        rule: 'approval_expiring',
        key: `approval_expiring:rep:${r.id}`,
        category: 'approval',
        severity: 'critical',
        title: `Opfyldning #${r.id} skal godkendes senest kl. ${formatTime(r.deadline_at)}`,
        message: `Opfyldning #${r.id} (${driverName(r.driver_id)}) skal afgøres senest kl. ${formatTime(r.deadline_at)}, ellers kan leveringer ikke dækkes.`,
        data: { replenishmentId: r.id },
        handling: 'Påmindelse og eskalering sendes af opfyldningsmodulet; udløber den, beregnes et nyt forslag.',
        notify: false,
      });
    }
    const cmds = ctx.db
      .prepare(`SELECT id, user_name, intent, confirm_expires_at FROM management_commands WHERE decision = 'needs_confirmation' AND confirm_expires_at > ? AND confirm_expires_at <= ?`)
      .all(nowIso(), warnUntil) as { id: number; user_name: string | null; intent: string; confirm_expires_at: string }[];
    for (const c of cmds) {
      out.push({
        rule: 'approval_expiring',
        key: `approval_expiring:cmd:${c.id}`,
        category: 'approval',
        severity: 'warn',
        title: `Instruktion #${c.id} mangler bekræftelse`,
        message: `${c.user_name ?? 'En leder'}s instruktion #${c.id} (${c.intent}) udløber kl. ${formatTime(c.confirm_expires_at)} uden bekræftelse.`,
        data: { commandId: c.id },
        handling: 'Bekræft eller annullér via knappen i gruppen. Udløber den, udføres intet.',
      });
    }

    // 6. Store ændringer i ordretilgang (seneste 30 min mod gennemsnit af de foregående 2 timer)
    const count = (from: number, to: number) =>
      (ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE confirmed_at >= ? AND confirmed_at < ?`).get(new Date(from).toISOString(), new Date(to).toISOString()) as { c: number }).c;
    const recent = count(now - 30 * 60000, now);
    const base = count(now - 150 * 60000, now - 30 * 60000) / 4;
    if (recent >= m.volumeMinOrders && recent >= m.volumeChangeFactor * Math.max(base, 1)) {
      out.push({
        rule: 'order_volume_change',
        key: 'order_volume_change:up',
        category: 'inform',
        severity: 'warn',
        title: `Ordretilgangen er steget kraftigt`,
        message: `${recent} nye ordrer de seneste 30 min mod normalt ${base.toLocaleString('da-DK', { maximumFractionDigits: 1 })}. Kapaciteten kan blive presset.`,
        data: { recent, base },
        handling: 'Overvej at kalde flere chauffører ind. Dispatch prioriterer automatisk.',
      });
    } else if (base >= m.volumeMinOrders && recent * m.volumeChangeFactor <= base) {
      out.push({
        rule: 'order_volume_change',
        key: 'order_volume_change:down',
        category: 'inform',
        severity: 'warn',
        title: `Ordretilgangen er faldet kraftigt`,
        message: `Kun ${recent} nye ordrer de seneste 30 min mod normalt ${base.toLocaleString('da-DK', { maximumFractionDigits: 1 })}.`,
        data: { recent, base },
        handling: 'Kontrollér at SMS-forbindelsen modtager beskeder.',
      });
    }

    // 7. Integrationer der fejler
    for (const i of ctx.integrations.list()) {
      if (i.state !== 'error' && i.state !== 'degraded') continue;
      if (i.state === 'degraded') {
        out.push({
          rule: 'integration_failure',
          key: `integration_failure:${i.name}`,
          category: 'auto',
          severity: 'info',
          title: `${i.name}: forringet`,
          message: i.message ?? 'Forringet forbindelse',
          data: { integration: i.name },
          handling: 'Systemet prøver igen automatisk med backoff.',
        });
        continue;
      }
      const critical = i.name === 'sms' || i.name === 'telegram';
      out.push({
        rule: 'integration_failure',
        key: `integration_failure:${i.name}`,
        category: critical ? 'takeover' : 'inform',
        severity: critical ? 'critical' : 'warn',
        title: `${{ sms: 'SMS', telegram: 'Telegram', maps: 'Google Maps', ai: 'Claude API' }[i.name]} fejler`,
        message: i.message ?? 'Integrationen svarer ikke',
        data: { integration: i.name },
        handling: {
          sms: 'Automatiske kundesvar er sat i bero; usikre beskeder gensendes aldrig. Kontrollér Mac/iPhone og besvar kunder manuelt.',
          telegram: 'Chauffører og ledelse kan ikke nås via Telegram – ring til chaufførerne. Beskeder sendes, når forbindelsen er tilbage.',
          maps: 'Køretider estimeres ud fra luftlinje og kommunikeres ikke som løfter.',
          ai: 'Kundesamtaler, som kræver fortolkning, overdrages til medarbejder.',
        }[i.name],
      });
    }
    return out;
  }

  // ---------------- Afstemning ----------------

  private openAlert(key: string): MonitorAlert | null {
    const r = this.ctx.db.prepare(`SELECT * FROM monitor_alerts WHERE alert_key = ? AND status IN ('open','acknowledged')`).get(key) as Record<string, unknown> | undefined;
    return r ? mapAlert(r) : null;
  }

  private decide(alertId: number, category: AlertCategory, decision: string, action: string | null): void {
    this.ctx.db.prepare(`INSERT INTO monitor_decisions (alert_id, category, decision, action, created_at) VALUES (?, ?, ?, ?, ?)`).run(alertId, category, decision, action, nowIso());
  }

  /** Kør alle regler og afstem med åbne advarsler. Returnerer antal nye/eskalerede. */
  async evaluate(): Promise<{ created: number; escalated: number; resolved: number }> {
    const { ctx } = this;
    const s = ctx.settings.get();
    const res = { created: 0, escalated: 0, resolved: 0 };
    if (!s.monitoring.enabled) return res;
    const findings = this.findings();
    const seen = new Set<string>();
    const now = nowIso();
    for (const f of findings) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      const existing = this.openAlert(f.key);
      if (existing) {
        const escalate = RANK[f.category] > RANK[existing.category];
        ctx.db
          .prepare(`UPDATE monitor_alerts SET last_seen_at = ?, occurrences = occurrences + 1, message = ?, title = ?, data = ?, category = ?, severity = ?, status = ? WHERE id = ?`)
          .run(now, f.message, f.title, f.data ? JSON.stringify(f.data) : null, escalate ? f.category : existing.category, escalate ? f.severity : existing.severity, escalate ? 'open' : existing.status, existing.id);
        if (escalate) {
          res.escalated++;
          this.decide(existing.id, f.category, `Eskaleret fra ${ALERT_CATEGORY_LABELS[existing.category]} til ${ALERT_CATEGORY_LABELS[f.category]}`, f.handling);
          this.handle(existing.id, f);
        }
        continue;
      }
      // Gen-åbn en nyligt løst advarsel i stedet for at sende en ny (undgår blafren)
      const recent = ctx.db
        .prepare(`SELECT * FROM monitor_alerts WHERE alert_key = ? AND status = 'resolved' AND resolved_at >= ? ORDER BY id DESC LIMIT 1`)
        .get(f.key, new Date(clock.now() - 15 * 60000).toISOString()) as Record<string, unknown> | undefined;
      if (recent) {
        const prev = mapAlert(recent);
        ctx.db
          .prepare(`UPDATE monitor_alerts SET status = 'open', resolved_at = NULL, last_seen_at = ?, occurrences = occurrences + 1, message = ?, title = ?, category = ?, severity = ? WHERE id = ?`)
          .run(now, f.message, f.title, RANK[f.category] > RANK[prev.category] ? f.category : prev.category, f.severity, prev.id);
        this.decide(prev.id, f.category, 'Genopstået kort efter løsning', null);
        if (RANK[f.category] > RANK[prev.category]) {
          res.escalated++;
          this.handle(prev.id, f);
        }
        continue;
      }
      const r = ctx.db
        .prepare(
          `INSERT INTO monitor_alerts (rule, alert_key, severity, category, status, title, message, data, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(f.rule, f.key, f.severity, f.category, f.title, f.message, f.data ? JSON.stringify(f.data) : null, now, now);
      const id = Number(r.lastInsertRowid);
      res.created++;
      this.decide(id, f.category, `Ny hændelse: ${ALERT_RULE_LABELS[f.rule]} → ${ALERT_CATEGORY_LABELS[f.category]}`, f.handling);
      this.handle(id, f);
    }
    // Luk advarsler, hvis tilstand er ophørt
    const open = ctx.db.prepare(`SELECT * FROM monitor_alerts WHERE status IN ('open','acknowledged')`).all() as Record<string, unknown>[];
    for (const row of open) {
      const a = mapAlert(row);
      if (!RULES.includes(a.rule) || seen.has(a.key)) continue;
      ctx.db.prepare(`UPDATE monitor_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(now, a.id);
      this.decide(a.id, a.category, 'Løst – tilstanden er ophørt', null);
      res.resolved++;
      if (a.category === 'takeover' && a.notifiedAt) this.notify(a.id, 'resolved', `✅ Løst: ${a.title}`);
    }
    if (res.created || res.escalated || res.resolved) ctx.bus.touch('monitoring');
    return res;
  }

  /** Udfør automatisk handling, log og orientér efter kategori. */
  private handle(id: number, f: Finding): void {
    const { ctx } = this;
    if (f.act) {
      try {
        f.act();
        this.decide(id, f.category, 'Automatisk handling udført', f.handling);
      } catch (e) {
        this.decide(id, f.category, 'Automatisk handling fejlede', (e as Error).message);
      }
    }
    ctx.db.prepare(`UPDATE monitor_alerts SET action_taken = ? WHERE id = ?`).run(f.handling, id);
    const level = f.category === 'takeover' ? 'critical' : f.category === 'auto' ? 'info' : 'warn';
    ctx.events.log(level, 'monitoring', `alert_${f.rule}`, `${f.title}. ${f.handling}`, {
      requiresAction: f.category === 'approval' || f.category === 'takeover',
      dedupeKey: `alert:${f.key}:${f.category}`,
      dedupeMinutes: 60,
      data: { alertId: id, ...(f.data ?? {}) },
    });
    if (f.category === 'auto' || f.notify === false) return;
    const icon = f.category === 'takeover' ? '🚨 KRÆVER OVERTAGELSE' : f.category === 'approval' ? '🟠 Kræver godkendelse' : 'ℹ️ Orientering';
    this.notify(id, f.category, `${icon}: ${f.title}\n${f.message}\nHandling: ${f.handling}`);
  }

  private notify(id: number, tag: string, text: string): void {
    const { ctx } = this;
    const s = ctx.settings.get();
    if (!s.monitoring.notifyGroup || !s.management.groupChatId) return;
    const queued = ctx.telegram.sendToChat(s.management.groupChatId, text, `alert:${id}:${tag}`);
    if (queued) {
      ctx.db.prepare(`UPDATE monitor_alerts SET notified_category = ?, notified_at = ? WHERE id = ?`).run(tag, nowIso(), id);
      this.decide(id, tag as AlertCategory, 'Ledelsen orienteret i Telegram-gruppen', null);
    }
  }

  acknowledge(id: number, by: string): void {
    const a = this.ctx.db.prepare(`SELECT * FROM monitor_alerts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!a) throw new Error('Advarslen findes ikke');
    this.ctx.db.prepare(`UPDATE monitor_alerts SET status = 'acknowledged', acknowledged_by = ? WHERE id = ? AND status = 'open'`).run(by, id);
    this.decide(id, a.category as AlertCategory, `Kvitteret af ${by}`, null);
    this.ctx.bus.touch('monitoring');
  }

  list(opts: { status?: MonitorAlert['status'][]; limit?: number } = {}): MonitorAlert[] {
    const st = opts.status ?? ['open', 'resolved', 'acknowledged'];
    return (
      this.ctx.db
        .prepare(`SELECT * FROM monitor_alerts WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen_at DESC LIMIT ?`)
        .all(...st, opts.limit ?? 200) as Record<string, unknown>[]
    ).map(mapAlert);
  }

  decisions(alertId?: number, limit = 200) {
    return (
      (alertId
        ? this.ctx.db.prepare(`SELECT * FROM monitor_decisions WHERE alert_id = ? ORDER BY id DESC LIMIT ?`).all(alertId, limit)
        : this.ctx.db.prepare(`SELECT * FROM monitor_decisions ORDER BY id DESC LIMIT ?`).all(limit)) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      alertId: r.alert_id as number,
      category: r.category as string,
      decision: r.decision as string,
      action: (r.action as string) ?? null,
      createdAt: r.created_at as string,
    }));
  }
}

function mapAlert(r: Record<string, unknown>): MonitorAlert {
  return {
    id: r.id as number,
    rule: r.rule as AlertRule,
    key: r.alert_key as string,
    severity: r.severity as MonitorAlert['severity'],
    category: r.category as AlertCategory,
    status: r.status as MonitorAlert['status'],
    title: r.title as string,
    message: r.message as string,
    data: parseJson(r.data as string | null, null),
    actionTaken: (r.action_taken as string) ?? null,
    occurrences: r.occurrences as number,
    notifiedAt: (r.notified_at as string) ?? null,
    firstSeenAt: r.first_seen_at as string,
    lastSeenAt: r.last_seen_at as string,
    resolvedAt: (r.resolved_at as string) ?? null,
    acknowledgedBy: (r.acknowledged_by as string) ?? null,
  };
}
