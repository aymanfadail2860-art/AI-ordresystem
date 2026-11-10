import { DEFAULT_TZ } from '../../core/time';
import { formatDkk } from '../../core/money';
import type { Order, Product, Settings } from '../../shared/types';

/**
 * Deterministiske svarskabeloner. Alle priser, totaler og tider i kundebeskeder
 * kommer herfra (fra systemets data) – aldrig fra sprogmodellen.
 */
export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: DEFAULT_TZ });
}

export function quoteText(order: Order, s: Settings): string {
  const lines = order.lines.map((l) => `${l.quantity} × ${l.productName} – ${formatDkk(l.lineTotalOre)}`);
  const fee = order.deliveryFeeOre > 0 ? `Levering: ${formatDkk(order.deliveryFeeOre)}` : 'Levering: gratis';
  return [
    'Din ordre:',
    ...lines,
    fee,
    `I alt: ${formatDkk(order.totalOre)}`,
    `Leveres til: ${order.addressText}`,
    order.deliveryInstructions ? `Bemærkning: ${order.deliveryInstructions}` : null,
    '',
    `Svar JA for at bekræfte, eller skriv hvad du vil ændre. Tilbuddet gælder i ${s.delivery.quoteExpiryMinutes} minutter.`,
  ]
    .filter((x) => x !== null)
    .join('\n');
}

export function menuText(products: Product[], availability: Map<number, number>, max = 8): string {
  const avail = products.filter((p) => (availability.get(p.id) ?? 0) > 0);
  const shown = avail.slice(0, max).map((p) => `• ${p.name}${p.variant ? ` ${p.variant}` : ''} – ${formatDkk(p.priceOre)}`);
  const more = avail.length > max ? `\n…og ${avail.length - max} andre varer.` : '';
  return shown.length ? `Vi har bl.a.:\n${shown.join('\n')}${more}` : 'Vi har desværre ingen varer på lager lige nu.';
}

export function priceFacts(products: Product[], availability: Map<number, number>): string {
  return products
    .map((p) => `${p.name}${p.variant ? ` ${p.variant}` : ''} koster ${formatDkk(p.priceOre)}${(availability.get(p.id) ?? 0) > 0 ? '' : ' (udsolgt lige nu)'}`)
    .join('\n');
}

/** ETA må kun kommunikeres til kunden, hvis den er beregnet ud fra verificerbare data. */
export function etaIsCommunicable(order: Pick<Order, 'eta' | 'etaSource'>, mode: Settings['installation']['mode']): boolean {
  if (!order.eta) return false;
  if (order.etaSource === 'route_live') return true;
  return mode === 'demo' && order.etaSource === 'route_simulated';
}

export function statusText(order: Order, s: Settings): string {
  const eta = etaIsCommunicable(order, s.installation.mode) ? ` Forventet levering ca. kl. ${formatTime(order.eta!)}.` : '';
  switch (order.status) {
    case 'new_inquiry':
    case 'awaiting_customer_info':
    case 'awaiting_stock_check':
      return `Din ordre #${order.id} er ikke bekræftet endnu.`;
    case 'awaiting_confirmation':
      return `Din ordre #${order.id} venter på din bekræftelse. Svar JA for at bekræfte.`;
    case 'confirmed':
    case 'awaiting_driver':
      return `Din ordre #${order.id} er bekræftet, og vi finder en chauffør til dig.`;
    case 'driver_assigned':
      return `Din ordre #${order.id} er tildelt en chauffør.${eta}`;
    case 'out_for_delivery':
      return `Din ordre #${order.id} er på vej.${eta}`;
    case 'delivered':
      return `Din ordre #${order.id} er leveret.`;
    case 'cancelled':
      return `Din ordre #${order.id} er annulleret.`;
    case 'needs_manual':
      return `Din ordre #${order.id} bliver behandlet af en medarbejder.`;
  }
}
