import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, fixture, convFor, FakeLlm, type TestApp } from './helpers';
import { sanitizeCustomerInterpretation, CustomerInterpretationSchema, type CustomerInterpretation } from '../src/server/ai/schemas';
import { costUsd } from '../src/server/ai/gateway';
import { DEFAULT_MODEL_PRICING } from '../src/server/defaultSettings';
import { ModelUnavailableError, TransientAiError } from '../src/server/adapters/ai/types';

let t: TestApp;
afterEach(async () => t?.app.stop());
const PHONE = '+4566667777';

const base: CustomerInterpretation = {
  intent: 'new_order', items: [], itemsMode: 'replace', unknownProducts: [], address: null, deliveryInstructions: null,
  requestedTime: null, customerName: null, mentionedSkus: [], questionAnswer: null, needsHuman: false, needsHumanReason: null, confidence: 0.9,
};

describe('Validering af AI-output', () => {
  it('ukendte SKU\'er flyttes til unknownProducts, antal begrænses, AI-priser fjernes', () => {
    const out = sanitizeCustomerInterpretation(
      { ...base, items: [{ sku: 'rb25', quantity: 2 }, { sku: 'VODKA', quantity: 1 }, { sku: 'RB25', quantity: -3 }, { sku: 'CHIPS', quantity: 9999 }], questionAnswer: 'Red Bull koster 10 kr.', confidence: 7 },
      new Set(['RB25', 'CHIPS']),
    );
    expect(out.items).toEqual([{ sku: 'RB25', quantity: 2 }]);
    expect(out.unknownProducts).toContain('VODKA');
    expect(out.questionAnswer).toBeNull();
    expect(out.confidence).toBe(1);
  });
  it('skemaet afviser ugyldig struktur', () => {
    expect(CustomerInterpretationSchema.safeParse({ intent: 'hack', items: 'x' }).success).toBe(false);
    expect(CustomerInterpretationSchema.safeParse(base).success).toBe(true);
  });
  it('beregner pris ud fra konfigurerede modelpriser', () => {
    const c = costUsd('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, DEFAULT_MODEL_PRICING);
    expect(c).toBeCloseTo(0.6);
    expect(costUsd('ukendt-model', { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, DEFAULT_MODEL_PRICING)).toBe(0);
  });
});

describe('Claude-fortolkning i produktion (falsk LLM, ingen netværk)', () => {
  it('AI kan ikke sætte priser – totalen kommer fra kataloget', async () => {
    const llm = new FakeLlm(() => ({ ...base, items: [{ sku: 'RB25', quantity: 4 }], address: 'Fiktivgade 2, 2200 København N' }));
    t = await makeApp({ mode: 'production', seed: false, llm });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, 'fire red bulls til fiktivgade 2');
    await t.run();
    const o = t.app.ctx.orders.get(convFor(t.app.ctx, PHONE).activeOrderId!)!;
    expect(o.subtotalOre).toBe(4 * 2500);
    expect(llm.calls[0].model).toBe('claude-haiku-5-5');
    expect(llm.calls[0].system).toContain('RB25');
    expect(llm.calls[0].userContent).not.toContain(PHONE); // telefonnummer sendes ikke til AI
  });

  it('lav sikkerhed eskalerer til større model', async () => {
    const llm = new FakeLlm((req) => (req.model === 'claude-haiku-5-5' ? { ...base, confidence: 0.2 } : { ...base, intent: 'greeting', itemsMode: 'none', confidence: 0.95 }));
    t = await makeApp({ mode: 'production', seed: false, llm });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, 'hmm');
    await t.run();
    expect(llm.calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
  });

  it('utilgængelig model → fallback-model, og der advares', async () => {
    const llm = new FakeLlm((req) => (req.model === 'claude-haiku-5-5' ? new ModelUnavailableError(req.model, 'not found') : { ...base, intent: 'greeting', itemsMode: 'none' }));
    t = await makeApp({ mode: 'production', seed: false, llm });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    expect(llm.calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(t.app.ctx.events.list().some((e) => e.type === 'model_unavailable')).toBe(true);
  });

  it('vedvarende API-fejl → samtalen sendes til medarbejder', async () => {
    const llm = new FakeLlm(() => new TransientAiError('overloaded', 1000));
    t = await makeApp({ mode: 'production', seed: false, llm });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, 'hej');
    for (let i = 0; i < 5; i++) await t.run(30_000);
    const conv = convFor(t.app.ctx, PHONE);
    expect(conv.aiMode).toBe('ai_paused');
    expect(t.lastSmsTo(PHONE)).toContain('medarbejder');
  });

  it('opbrugt budget stopper AI-kald og sender til medarbejder', async () => {
    const llm = new FakeLlm(() => ({ ...base, intent: 'greeting', itemsMode: 'none' }));
    t = await makeApp({ mode: 'production', seed: false, llm });
    fixture(t.app.ctx);
    t.app.ctx.settings.update({ ai: { monthlyBudgetUsd: 0.0001 } });
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    const callsAfterFirst = llm.calls.length;
    t.sms.injectInbound('+4566668888', 'hej');
    await t.run();
    expect(llm.calls.length).toBe(callsAfterFirst);
    expect(t.app.ctx.ai.summary().budgetBlocked).toBe(true);
    expect(convFor(t.app.ctx, '+4566668888').aiMode).toBe('ai_paused');
  });

  it('uden Claude-nøgle i produktion svarer systemet ikke selv, men overdrager', async () => {
    t = await makeApp({ mode: 'production', seed: false, llm: null });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, '2 red bull');
    await t.run();
    expect(convFor(t.app.ctx, PHONE).aiMode).toBe('ai_paused');
    expect(t.app.ctx.orders.list({})).toHaveLength(0);
  });

  it('AI-kald logges med tokens og estimeret pris', async () => {
    const llm = new FakeLlm(() => ({ ...base, intent: 'greeting', itemsMode: 'none' }));
    t = await makeApp({ mode: 'production', seed: false, llm });
    fixture(t.app.ctx);
    t.sms.injectInbound(PHONE, 'hej');
    await t.run();
    const s = t.app.ctx.ai.summary();
    expect(s.monthCalls).toBe(1);
    expect(s.monthInputTokens).toBe(1000);
    expect(s.monthCostUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6);
  });
});
