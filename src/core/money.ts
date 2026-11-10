/** Formatér øre som dansk kronebeløb, fx 12950 → "129,50 kr." */
const FMT_INT = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const FMT_DEC = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatDkk(ore: number): string {
  const hasDecimals = ore % 100 !== 0;
  return (hasDecimals ? FMT_DEC : FMT_INT).format(ore / 100) + ' kr.';
}

export function krToOre(kr: number): number {
  if (!Number.isFinite(kr)) throw new Error('Ugyldigt beløb');
  return Math.round(kr * 100);
}
