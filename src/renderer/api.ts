import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveTopic } from '../shared/types';

interface Bridge {
  invoke(method: string, params?: unknown): Promise<{ result?: unknown; error?: string }>;
  onLive(cb: (topics: string[]) => void): () => void;
}

declare global {
  interface Window {
    aiDispatch?: Bridge;
  }
}

/** I Electron bruges IPC-broen; i dev-browser bruges HTTP + server-sent events. */
const bridge: Bridge = window.aiDispatch ?? {
  async invoke(method, params) {
    const r = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params ?? {}) });
    return r.json();
  },
  onLive(cb) {
    const es = new EventSource('/api/live');
    es.onmessage = (e) => cb(JSON.parse(e.data));
    return () => es.close();
  },
};

export class ApiError extends Error {
  locked: boolean;
  constructor(message: string) {
    super(message.replace(/^LOCKED:\s*/, ''));
    this.locked = message.startsWith('LOCKED:');
  }
}

type LockHandler = () => Promise<boolean>;
let onLocked: LockHandler | null = null;
export function setLockHandler(h: LockHandler) {
  onLocked = h;
}

export async function call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
  const r = await bridge.invoke(method, params);
  if (r.error) {
    const err = new ApiError(r.error);
    if (err.locked && onLocked && (await onLocked())) return call<T>(method, params);
    throw err;
  }
  return r.result as T;
}

const listeners = new Set<(topics: string[]) => void>();
let started = false;
function ensureLive() {
  if (started) return;
  started = true;
  bridge.onLive((topics) => listeners.forEach((l) => l(topics)));
}

/** Hent data og genhent automatisk, når relevante emner ændres i backend. */
export function useQuery<T>(method: string, params: Record<string, unknown> | null, topics: LiveTopic[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(params);
  const keyRef = useRef(key);
  keyRef.current = key;
  const load = useCallback(async () => {
    if (params === null) return;
    try {
      const res = await call<T>(method, params);
      if (keyRef.current === key) {
        setData(res);
        setError(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, key]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    ensureLive();
    const l = (t: string[]) => {
      if (t.some((x) => topics.includes(x as LiveTopic))) void load();
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, topics.join(',')]);
  return { data, error, reload: load };
}

/** Kør en handling med fejlvisning. */
export async function act(fn: () => Promise<unknown>, onError?: (m: string) => void): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    (onError ?? ((m: string) => window.dispatchEvent(new CustomEvent('toast', { detail: { kind: 'error', text: m } }))))(msg);
    return false;
  }
}

export function toast(text: string, kind: 'info' | 'error' = 'info') {
  window.dispatchEvent(new CustomEvent('toast', { detail: { kind, text } }));
}
