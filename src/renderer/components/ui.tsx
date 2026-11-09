import { useEffect, useState, type ReactNode } from 'react';
import type { AiMode, DriverStatus, IntegrationState, OrderStatus } from '../../shared/types';
import { AI_MODE_LABELS, DRIVER_STATUS_LABELS, ORDER_STATUS_LABELS } from '../../shared/types';

export function kr(ore: number): string {
  const v = ore / 100;
  return v.toLocaleString('da-DK', { minimumFractionDigits: ore % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' kr.';
}

export function time(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? time(iso) : d.toLocaleString('da-DK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '–';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'lige nu';
  if (s < 3600) return `${Math.floor(s / 60)} min siden`;
  if (s < 86400) return `${Math.floor(s / 3600)} t siden`;
  return `${Math.floor(s / 86400)} d siden`;
}

export function usd(v: number): string {
  return v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

const statusTone: Record<OrderStatus, string> = {
  new_inquiry: 'neutral',
  awaiting_customer_info: 'info',
  awaiting_stock_check: 'info',
  awaiting_confirmation: 'info',
  confirmed: 'accent',
  awaiting_driver: 'warn',
  driver_assigned: 'accent',
  out_for_delivery: 'accent',
  delivered: 'ok',
  cancelled: 'neutral',
  needs_manual: 'danger',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge ${statusTone[status]}`}>{ORDER_STATUS_LABELS[status]}</span>;
}

const modeTone: Record<AiMode, string> = { ai_active: 'ok', manual: 'warn', ai_paused: 'info', integration_error: 'danger' };
export function AiModeBadge({ mode }: { mode: AiMode }) {
  return <span className={`badge ${modeTone[mode]}`}>{AI_MODE_LABELS[mode]}</span>;
}

const driverTone: Record<DriverStatus, string> = { available: 'ok', busy: 'accent', break: 'warn', offline: 'neutral' };
export function DriverStatusBadge({ status }: { status: DriverStatus }) {
  return <span className={`badge ${driverTone[status]}`}>{DRIVER_STATUS_LABELS[status]}</span>;
}

const intLabels: Record<IntegrationState, string> = {
  ok: 'Forbundet',
  simulated: 'Simuleret',
  degraded: 'Forringet',
  error: 'Fejl',
  not_configured: 'Ikke konfigureret',
  disabled: 'Slået fra',
};
const intTone: Record<IntegrationState, string> = { ok: 'ok', simulated: 'info', degraded: 'warn', error: 'danger', not_configured: 'neutral', disabled: 'neutral' };
export function IntegrationBadge({ state }: { state: IntegrationState }) {
  return <span className={`badge ${intTone[state]}`}>{intLabels[state]}</span>;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <h3>{title}</h3>
          <div className="card-actions">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Luk">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toasts() {
  const [items, setItems] = useState<{ id: number; kind: string; text: string }[]>([]);
  useEffect(() => {
    let n = 0;
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { kind: string; text: string };
      const id = ++n;
      setItems((x) => [...x, { id, ...d }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 5000);
    };
    window.addEventListener('toast', h);
    return () => window.removeEventListener('toast', h);
  }, []);
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function SimTag() {
  return <span className="sim-tag" title="Simuleret – ikke rigtige data/beskeder">SIM</span>;
}
