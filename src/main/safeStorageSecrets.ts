import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecretName, SecretStore } from '../server/secrets';

/**
 * API-nøgler krypteres med Electrons safeStorage. På macOS bruger safeStorage
 * en krypteringsnøgle, der opbevares i brugerens Nøglering (Keychain).
 * Den krypterede fil ligger i app-datamappen – aldrig i SQLite-databasen.
 */
export class SafeStorageSecretStore implements SecretStore {
  private file: string;
  private cache: Record<string, string> = {};

  constructor(dir: string) {
    this.file = path.join(dir, 'secrets.enc.json');
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  get secure(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  get(name: SecretName): string | null {
    const enc = this.cache[name];
    if (!enc || !this.secure) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  set(name: SecretName, value: string): void {
    if (!this.secure) throw new Error('Sikker nøglelagring (Keychain) er ikke tilgængelig – nøglen gemmes ikke');
    this.cache[name] = safeStorage.encryptString(value).toString('base64');
    this.persist();
  }

  delete(name: SecretName): void {
    delete this.cache[name];
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache), { mode: 0o600 });
  }
}
