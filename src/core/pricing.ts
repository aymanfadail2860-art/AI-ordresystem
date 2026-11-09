/**
 * Deterministisk prisberegning. AI'en må aldrig selv fastsætte priser –
 * priser kommer altid fra produktkataloget og indstillingerne.
 */
export interface PricingRules {
  deliveryFeeOre: number;
  freeDeliveryThresholdOre: number; // 0 = aldrig gratis levering
  minimumOrderOre: number;
}

export interface PriceLineInput {
  productId: number;
  quantity: number;
  unitPriceOre: number;
}

export interface PriceResult {
  lines: (PriceLineInput & { lineTotalOre: number })[];
  subtotalOre: number;
  deliveryFeeOre: number;
  totalOre: number;
  belowMinimum: boolean;
}

export const MAX_QUANTITY_PER_LINE = 500;

export function validateQuantity(q: number): void {
  if (!Number.isInteger(q) || q <= 0) throw new Error(`Ugyldigt antal: ${q}`);
  if (q > MAX_QUANTITY_PER_LINE) throw new Error(`Antal overstiger maksimum (${MAX_QUANTITY_PER_LINE})`);
}

export function calculatePrice(lines: PriceLineInput[], rules: PricingRules): PriceResult {
  const priced = lines.map((l) => {
    validateQuantity(l.quantity);
    if (!Number.isInteger(l.unitPriceOre) || l.unitPriceOre < 0) {
      throw new Error(`Ugyldig enhedspris: ${l.unitPriceOre}`);
    }
    return { ...l, lineTotalOre: l.quantity * l.unitPriceOre };
  });
  const subtotalOre = priced.reduce((s, l) => s + l.lineTotalOre, 0);
  const free = rules.freeDeliveryThresholdOre > 0 && subtotalOre >= rules.freeDeliveryThresholdOre;
  const deliveryFeeOre = priced.length === 0 || free ? 0 : rules.deliveryFeeOre;
  return {
    lines: priced,
    subtotalOre,
    deliveryFeeOre,
    totalOre: subtotalOre + deliveryFeeOre,
    belowMinimum: subtotalOre < rules.minimumOrderOre,
  };
}
