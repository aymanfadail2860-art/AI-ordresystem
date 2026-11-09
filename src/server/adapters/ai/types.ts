import type { z } from 'zod';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredRequest<T> {
  model: string;
  system: string;
  userContent: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
}

export interface StructuredResponse<T> {
  output: T | null;
  usage: AiUsage;
  model: string;
  stopReason: string | null;
  refused: boolean;
}

/** Model findes ikke / er ikke tilgængelig for kontoen. */
export class ModelUnavailableError extends Error {
  constructor(public readonly model: string, message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/** Midlertidig fejl (rate limit, overbelastning, netværk) – kan prøves igen senere. */
export class TransientAiError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TransientAiError';
  }
}

/** Permanent fejl (ugyldig nøgle, ugyldig forespørgsel). */
export class PermanentAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentAiError';
  }
}

export interface LlmProvider {
  readonly kind: 'claude';
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>>;
  listModels(): Promise<string[]>;
}
