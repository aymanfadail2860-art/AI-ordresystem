import { describe, it, expect } from 'vitest';
import { assertTransition, canTransition, InvalidTransitionError } from '../src/core/orderStateMachine';
import { calculatePrice } from '../src/core/pricing';
import { normalizePhone, maskPhone } from '../src/core/phone';
import { isOpen } from '../src/core/openingHours';
import { formatDkk } from '../src/core/money';
import { ORDER_STATUSES } from '../src/shared/types';

describe('Ordretilstandsmaskine', () => {
  it('tillader normalt flow', () => {
    const path = ['new_inquiry', 'awaiting_customer_info', 'awaiting_stock_check', 'awaiting_confirmation', 'confirmed', 'awaiting_driver', 'driver_assigned', 'out_for_delivery'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1], 'system')).toBe(true);
    expect(canTransition('out_for_delivery', 'delivered', 'driver')).toBe(true);
  });
  it('afviser ugyldige skift', () => {
    expect(() => assertTransition('new_inquiry', 'delivered', 'staff')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('awaiting_confirmation', 'driver_assigned', 'system')).toThrow();
    expect(() => assertTransition('delivered', 'cancelled', 'staff')).toThrow();
    expect(() => assertTransition('cancelled', 'confirmed', 'staff')).toThrow();
  });
  it('kun chauffør/medarbejder må markere leveret – aldrig AI eller system', () => {
    expect(canTransition('out_for_delivery', 'delivered', 'ai')).toBe(false);
    expect(canTransition('out_for_delivery', 'delivered', 'system')).toBe(false);
    expect(canTransition('out_for_delivery', 'delivered', 'customer')).toBe(false);
    expect(canTransition('out_for_delivery', 'delivered', 'staff')).toBe(true);
  });
  it('kun medarbejder kan løse "kræver manuel behandling"', () => {
    expect(canTransition('needs_manual', 'awaiting_driver', 'system')).toBe(false);
    expect(canTransition('needs_manual', 'awaiting_driver', 'staff')).toBe(true);
  });
  it('terminale statusser har ingen udgange', () => {
    for (const s of ORDER_STATUSES) {
      expect(canTransition('delivered', s, 'staff')).toBe(false);
      expect(canTransition('cancelled', s, 'staff')).toBe(false);
    }
  });
});

describe('Prisberegning', () => {
  const rules = { deliveryFeeOre: 3900, freeDeliveryThresholdOre: 30000, minimumOrderOre: 10000 };
  it('beregner linjer, gebyr og total i øre', () => {
    const r = calculatePrice([{ productId: 1, quantity: 2, unitPriceOre: 2500 }, { productId: 2, quantity: 1, unitPriceOre: 3000 }], rules);
    expect(r.subtotalOre).toBe(8000);
    expect(r.deliveryFeeOre).toBe(3900);
    expect(r.totalOre).toBe(11900);
    expect(r.belowMinimum).toBe(true);
  });
  it('gratis levering over grænsen', () => {
    const r = calculatePrice([{ productId: 1, quantity: 12, unitPriceOre: 2500 }], rules);
    expect(r.deliveryFeeOre).toBe(0);
    expect(r.totalOre).toBe(30000);
  });
  it('afviser ugyldige antal og priser', () => {
    expect(() => calculatePrice([{ productId: 1, quantity: 0, unitPriceOre: 100 }], rules)).toThrow();
    expect(() => calculatePrice([{ productId: 1, quantity: 1.5, unitPriceOre: 100 }], rules)).toThrow();
    expect(() => calculatePrice([{ productId: 1, quantity: 1000, unitPriceOre: 100 }], rules)).toThrow();
    expect(() => calculatePrice([{ productId: 1, quantity: 1, unitPriceOre: -5 }], rules)).toThrow();
  });
  it('formaterer kroner', () => {
    expect(formatDkk(2500)).toBe('25 kr.');
    expect(formatDkk(2550)).toBe('25,50 kr.');
  });
});

describe('Telefonnumre', () => {
  it('normaliserer danske numre til E.164', () => {
    expect(normalizePhone('12 34 56 78')).toBe('+4512345678');
    expect(normalizePhone('+45 1234 5678')).toBe('+4512345678');
    expect(normalizePhone('004512345678')).toBe('+4512345678');
    expect(normalizePhone('kunde@icloud.com')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(maskPhone('+4512345678')).toBe('+45 •••• 5678');
  });
});

describe('Åbningstider', () => {
  const day = (open: string, close: string, closed = false) => ({ open, close, closed });
  const hours = { mon: day('10:00', '02:00'), tue: day('10:00', '22:00'), wed: day('10:00', '22:00'), thu: day('10:00', '22:00'), fri: day('10:00', '22:00'), sat: day('10:00', '22:00'), sun: day('10:00', '22:00', true) };
  it('håndterer åbent over midnat', () => {
    expect(isOpen(hours, new Date('2026-11-09T23:30:00'))).toBe(true); // mandag aften
    expect(isOpen(hours, new Date('2026-11-10T01:30:00'))).toBe(true); // tirsdag nat (fra mandag)
    expect(isOpen(hours, new Date('2026-11-10T03:00:00'))).toBe(false);
    expect(isOpen(hours, new Date('2026-11-10T09:59:00'))).toBe(false);
    expect(isOpen(hours, new Date('2026-11-15T12:00:00'))).toBe(false); // søndag lukket
  });
});
