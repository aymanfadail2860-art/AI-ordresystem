/**
 * Normalisering af telefonnumre til E.164. Standardregion er Danmark (+45).
 * Returnerer null, hvis nummeret ikke kan tolkes sikkert.
 */
export function normalizePhone(raw: string, defaultCountryCode = '45'): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return null; // e-mail (iMessage) – ikke et telefonnummer
  let digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (digits.startsWith('+')) {
    const rest = digits.slice(1).replace(/\D/g, '');
    if (rest.length < 8 || rest.length > 15) return null;
    return '+' + rest;
  }
  digits = digits.replace(/\D/g, '');
  if (defaultCountryCode === '45' && digits.length === 8) return '+45' + digits;
  if (digits.length >= 10 && digits.length <= 15) return '+' + digits;
  return null;
}

/** Maskér et telefonnummer til logs: +4512345678 → +45 •••• 5678 */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return '••••';
  return `${phone.slice(0, 3)} •••• ${phone.slice(-4)}`;
}
