/** Formatér øre som dansk kronebeløb, fx 12950 → "129,50 kr." */
export function formatDkk(ore: number): string {
  const kr = ore / 100;
  const hasDecimals = ore % 100 !== 0;
  return (
    kr.toLocaleString('da-DK', {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2,
    }) + ' kr.'
  );
}

export function krToOre(kr: number): number {
  if (!Number.isFinite(kr)) throw new Error('Ugyldigt beløb');
  return Math.round(kr * 100);
}
