/**
 * Hemmelighedslager (API-nøgler). Nøgler gemmes ALDRIG i SQLite-databasen.
 * I Electron-appen bruges `SafeStorageSecretStore` (krypteret med en nøgle,
 * som macOS opbevarer i Nøglering/Keychain). Tests bruger MemorySecretStore.
 */
export type SecretName = 'anthropic_api_key' | 'telegram_bot_token' | 'google_maps_api_key';
export const SECRET_NAMES: SecretName[] = ['anthropic_api_key', 'telegram_bot_token', 'google_maps_api_key'];

export interface SecretStore {
  /** true hvis lageret er krypteret af operativsystemet (Keychain). */
  readonly secure: boolean;
  get(name: SecretName): string | null;
  set(name: SecretName, value: string): void;
  delete(name: SecretName): void;
}

export class MemorySecretStore implements SecretStore {
  readonly secure = false;
  private m = new Map<SecretName, string>();
  get(name: SecretName): string | null {
    return this.m.get(name) ?? null;
  }
  set(name: SecretName, value: string): void {
    this.m.set(name, value);
  }
  delete(name: SecretName): void {
    this.m.delete(name);
  }
}

export function maskSecret(v: string | null): string | null {
  if (!v) return null;
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-4)}`;
}
