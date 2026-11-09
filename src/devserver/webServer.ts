/**
 * UDVIKLINGSSERVER (ikke en del af produktet).
 * Kører backend i Node og serverer UI'et i en almindelig browser på
 * http://127.0.0.1:5199 – bruges til udvikling og automatiske UI-tests på
 * maskiner uden Electron. Lytter kun på localhost. Nøgler gemmes kun i hukommelsen.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AppHostImpl } from '../server/host';
import { MemorySecretStore } from '../server/secrets';
import type { LiveTopic } from '../shared/types';

const port = Number(process.env.PORT ?? 5199);
const dataDir = process.env.AI_DISPATCH_DATA ?? path.resolve('data/dev');
const rendererDir = path.resolve('dist/renderer');
const clients = new Set<http.ServerResponse>();

const host = new AppHostImpl({
  dataDir,
  secrets: new MemorySecretStore(),
  version: 'dev',
  platform: process.platform,
  onLive: (topics: LiveTopic[]) => {
    for (const c of clients) c.write(`data: ${JSON.stringify(topics)}\n\n`);
  },
  onRestartRequested: () => console.log('[dev] Genstart påkrævet – genstart serveren manuelt'),
  log: (l, m) => console.log(`[${l}] ${m}`),
});

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/live') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let params: unknown = {};
    try {
      params = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      /* tom */
    }
    const out = await host.invoke(url.pathname.slice(5), params);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  const file = path.join(rendererDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(rendererDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('Ikke fundet');
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

host.start().then(() => {
  server.listen(port, '127.0.0.1', () => console.log(`AI Dispatch dev-server: http://127.0.0.1:${port}`));
});

process.on('SIGINT', () => void host.stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void host.stop().then(() => process.exit(0)));
