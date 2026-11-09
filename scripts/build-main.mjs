// Bygger Electron main-proces, preload og (valgfrit) dev-webserveren med esbuild.
// Native moduler (better-sqlite3) og electron holdes eksterne.
import { build } from 'esbuild';

const devserver = process.argv.includes('--devserver');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js' });
if (devserver) {
  await build({ ...common, entryPoints: ['src/devserver/webServer.ts'], outfile: 'dist/devserver/webServer.js' });
}
