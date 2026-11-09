import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ImsgRpcSmsAdapter, classifySendError, RpcError, serviceFromChatGuid } from '../src/server/adapters/sms/imsgRpc';
import type { InboundSms, OutgoingObserved } from '../src/server/adapters/sms/types';
import { TelegramBotApiAdapter, mapUpdate } from '../src/server/adapters/telegram/botApi';
import { GoogleMapsAdapter } from '../src/server/adapters/maps/google';

/** Falsk `imsg rpc`-proces, der taler JSON-RPC over stdin/stdout som dokumenteret. */
function fakeImsg(handler: (req: { id: number; method: string; params: Record<string, unknown> }, reply: (msg: unknown) => void) => void) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => proc.emit('exit', null, 'SIGTERM') });
  let buf = '';
  stdin.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handler(JSON.parse(line), (m) => stdout.write(JSON.stringify(m) + '\n'));
    }
  });
  return { proc: proc as unknown as ChildProcessWithoutNullStreams, notify: (m: unknown) => stdout.write(JSON.stringify(m) + '\n'), exit: () => proc.emit('exit', 1, null) };
}

function handlers() {
  const inbound: InboundSms[] = [];
  const outgoing: OutgoingObserved[] = [];
  const health: string[] = [];
  let cursor: number | null = null;
  return {
    inbound, outgoing, health,
    get cursor() { return cursor; },
    h: {
      onInbound: (m: InboundSms) => inbound.push(m),
      onOutgoingObserved: (m: OutgoingObserved) => outgoing.push(m),
      onHealth: (s: string, msg: string) => health.push(`${s}:${msg}`),
      loadCursor: () => 41,
      saveCursor: (c: number) => (cursor = c),
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('imsg RPC-adapter (falsk proces)', () => {
  it('starter, abonnerer fra gemt cursor og mapper indgående/udgående beskeder', async () => {
    let subscribeParams: Record<string, unknown> | null = null;
    const f = fakeImsg((req, reply) => {
      if (req.method === 'initialize') reply({ jsonrpc: '2.0', id: req.id, result: { version: '0.21.0', database: { ready: true } } });
      if (req.method === 'watch.subscribe') {
        subscribeParams = req.params;
        reply({ jsonrpc: '2.0', id: req.id, result: { subscription: 1 } });
      }
    });
    const a = new ImsgRpcSmsAdapter({ binaryPath: '/x/imsg', region: 'DK', service: 'sms', spawnFn: () => f.proc });
    const hs = handlers();
    await a.start(hs.h);
    expect(subscribeParams).toMatchObject({ since_rowid: 41 });
    expect(hs.health.at(-1)).toMatch(/^ok:/);
    f.notify({ jsonrpc: '2.0', method: 'message', params: { subscription: 1, message: { id: 42, guid: 'G1', chat_id: 3, chat_guid: 'SMS;-;+4512345678', sender: '+4512345678', is_from_me: false, text: 'Hej', created_at: '2026-11-09T10:00:00Z' } } });
    f.notify({ jsonrpc: '2.0', method: 'message', params: { subscription: 1, message: { id: 43, guid: 'G2', chat_id: 3, chat_guid: 'SMS;-;+4512345678', participants: ['+4512345678'], is_from_me: true, text: 'Svar', created_at: '2026-11-09T10:01:00Z' } } });
    f.notify({ jsonrpc: '2.0', method: 'message', params: { subscription: 1, message: { id: 44, guid: 'G3', chat_id: 9, is_group: true, chat_guid: 'iMessage;+;chat1', is_from_me: false, text: 'gruppe', created_at: '2026-11-09T10:02:00Z' } } });
    await tick();
    expect(hs.inbound).toHaveLength(1);
    expect(hs.inbound[0]).toMatchObject({ externalGuid: 'G1', from: '+4512345678', text: 'Hej', service: 'SMS' });
    expect(hs.outgoing).toHaveLength(1);
    expect(hs.outgoing[0]).toMatchObject({ externalGuid: 'G2', to: '+4512345678' });
    expect(hs.cursor).toBe(44);
    await a.stop();
  });

  it('afsendelse: ok → sent; may_have_completed → uncertain; retry_safe → not_started; procesnedbrud → uncertain', async () => {
    let mode = 'ok';
    let sendParams: Record<string, unknown> | null = null;
    const f = fakeImsg((req, reply) => {
      if (req.method === 'initialize') return reply({ jsonrpc: '2.0', id: req.id, result: { database: { ready: true } } });
      if (req.method === 'watch.subscribe') return reply({ jsonrpc: '2.0', id: req.id, result: { subscription: 1 } });
      if (req.method === 'send') {
        sendParams = req.params;
        if (mode === 'ok') reply({ jsonrpc: '2.0', id: req.id, result: { ok: true, id: 100, guid: 'OUT-1' } });
        if (mode === 'uncertain') reply({ jsonrpc: '2.0', id: req.id, error: { code: -32001, message: 'may have completed', data: { retry_safe: false, disposition: 'may_have_completed' } } });
        if (mode === 'safe') reply({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'not started', data: { retry_safe: true, disposition: 'not_started' } } });
        if (mode === 'crash') f.exit();
      }
    });
    const a = new ImsgRpcSmsAdapter({ binaryPath: '/x/imsg', region: 'DK', service: 'sms', spawnFn: () => f.proc });
    await a.start(handlers().h);
    expect(await a.send('+4512345678', 'Hej')).toMatchObject({ disposition: 'sent', externalGuid: 'OUT-1' });
    expect(sendParams).toMatchObject({ to: '+4512345678', text: 'Hej', service: 'sms', region: 'DK' });
    mode = 'uncertain';
    expect((await a.send('+4512345678', 'Hej')).disposition).toBe('uncertain');
    mode = 'safe';
    expect((await a.send('+4512345678', 'Hej')).disposition).toBe('not_started');
    mode = 'crash';
    expect((await a.send('+4512345678', 'Hej')).disposition).toBe('uncertain');
    await a.stop();
  });

  it('rapporterer fejl, hvis Messages-databasen ikke kan læses (manglende Fuld diskadgang)', async () => {
    const f = fakeImsg((req, reply) => reply({ jsonrpc: '2.0', id: req.id, result: { database: { ready: false, error: 'permission denied' } } }));
    const a = new ImsgRpcSmsAdapter({ binaryPath: '/x/imsg', region: 'DK', service: 'sms', spawnFn: () => f.proc });
    const hs = handlers();
    await a.start(hs.h);
    expect(hs.health.at(-1)).toMatch(/^error:.*Fuld diskadgang/);
    await a.stop();
  });

  it('klassificering af fejl er konservativ', () => {
    expect(classifySendError(new RpcError(-2, 'timeout', null, 'timeout')).disposition).toBe('uncertain');
    expect(classifySendError(new RpcError(-32602, 'bad params', null)).disposition).toBe('not_started');
    expect(classifySendError(new RpcError(-32603, 'intern fejl', null)).disposition).toBe('uncertain');
    expect(classifySendError(new Error('ukendt')).disposition).toBe('uncertain');
    expect(serviceFromChatGuid('RCS;-;+45123')).toBe('RCS');
  });
});

describe('Telegram Bot API-adapter (mocket HTTP)', () => {
  it('mapper beskeder, knapper og live-positioner', () => {
    expect(mapUpdate({ update_id: 5, message: { message_id: 1, from: { id: 7, first_name: 'Ali' }, chat: { id: 7, type: 'private' }, text: 'Jeg er fremme', date: 0 } })).toMatchObject({ updateId: '5', kind: 'message', fromUserId: '7', text: 'Jeg er fremme' });
    expect(mapUpdate({ update_id: 6, callback_query: { id: 'cb', from: { id: 7 }, data: 'offer:1:accept' } })).toMatchObject({ kind: 'callback', callbackData: 'offer:1:accept' });
    expect(mapUpdate({ update_id: 7, edited_message: { message_id: 1, from: { id: 7 }, chat: { id: 7, type: 'private' }, date: 0, location: { latitude: 55.1, longitude: 12.1, live_period: 60 } } })).toMatchObject({ kind: 'location', location: { lat: 55.1, lng: 12.1, live: true } });
    expect(mapUpdate({ update_id: 8, edited_message: { message_id: 1, from: { id: 7 }, chat: { id: 7, type: 'private' }, date: 0, text: 'rettet' } })).toBeNull();
  });

  it('sendMessage: API-fejl → not_started (retry), netværkstimeout → uncertain', async () => {
    let mode = 'ok';
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (mode === 'ok') return new Response(JSON.stringify({ ok: true, result: { message_id: 9, echo: body } }));
      if (mode === 'ratelimit') return new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } }), { status: 429 });
      throw new Error('The operation was aborted due to timeout');
    }) as unknown as typeof fetch;
    const a = new TelegramBotApiAdapter({ token: 'T', fetchFn });
    expect(await a.sendMessage('7', 'hej', [[{ text: 'OK', data: 'x' }]])).toMatchObject({ disposition: 'sent', messageId: '9' });
    mode = 'ratelimit';
    expect(await a.sendMessage('7', 'hej')).toMatchObject({ disposition: 'not_started', retryAfterMs: 3000 });
    mode = 'timeout';
    expect((await a.sendMessage('7', 'hej')).disposition).toBe('uncertain');
  });
});

describe('Google Maps-adapter (mocket HTTP)', () => {
  it('geokoder og markerer upræcise resultater', async () => {
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      const precise = u.searchParams.get('address')!.includes('12');
      return new Response(JSON.stringify({
        status: 'OK',
        results: [{
          formatted_address: 'Fiktivgade 12, 2200 København N',
          geometry: { location: { lat: 55.69, lng: 12.55 }, location_type: precise ? 'ROOFTOP' : 'APPROXIMATE' },
          address_components: [...(precise ? [{ long_name: '12', types: ['street_number'] }] : []), { long_name: '2200', types: ['postal_code'] }],
          types: ['street_address'],
        }],
      }));
    }) as unknown as typeof fetch;
    const g = new GoogleMapsAdapter({ apiKey: 'K', region: 'dk', language: 'da', fetchFn });
    expect(await g.geocode('Fiktivgade 12')).toMatchObject({ found: true, postalCode: '2200', approximate: false });
    expect((await g.geocode('Fiktivgade')).approximate).toBe(true);
  });

  it('parser Routes API computeRouteMatrix', async () => {
    let headers: Record<string, string> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify([
        { originIndex: 0, destinationIndex: 0, duration: '600s', distanceMeters: 4000, condition: 'ROUTE_EXISTS' },
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_NOT_FOUND' },
      ]));
    }) as unknown as typeof fetch;
    const g = new GoogleMapsAdapter({ apiKey: 'K', region: 'dk', language: 'da', fetchFn });
    const m = await g.travelMatrix([{ lat: 55, lng: 12 }], [{ lat: 55.1, lng: 12.1 }, { lat: 55.2, lng: 12.2 }]);
    expect(m[0][0]).toEqual({ durationS: 600, distanceM: 4000 });
    expect(Number.isNaN(m[0][1].durationS)).toBe(true);
    expect(headers['X-Goog-Api-Key']).toBe('K');
    expect(headers['X-Goog-FieldMask']).toContain('duration');
  });
});
