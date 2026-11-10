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
// Driftssimulering i egen worker-tråd (ved siden af main.js) og som kommandolinjeværktøj
await build({ ...common, entryPoints: ['src/server/sim/worker.ts'], outfile: 'dist/main/simWorker.js' });
await build({ ...common, entryPoints: ['src/server/sim/cli.ts'], outfile: 'dist/sim/cli.js' });
if (devserver) {
  await build({ ...common, entryPoints: ['src/devserver/webServer.ts'], outfile: 'dist/devserver/webServer.js' });
  await build({ ...common, entryPoints: ['src/server/sim/worker.ts'], outfile: 'dist/devserver/simWorker.js' });
}
