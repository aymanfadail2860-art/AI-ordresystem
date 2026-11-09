import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ModelUnavailableError,
  PermanentAiError,
  TransientAiError,
  type LlmProvider,
  type StructuredRequest,
  type StructuredResponse,
} from './types';

/**
 * Claude API-provider (Anthropic SDK). Bruger strukturerede outputs
 * (`output_config.format` + Zod) så svaret altid valideres mod et skema.
 *
 * Nøglen leveres af installationens egen Keychain-lagring – programmet
 * afhænger ikke af udviklerens Claude-konto.
 */
export class ClaudeProvider implements LlmProvider {
  readonly kind = 'claude' as const;
  private client: Anthropic;

  constructor(apiKey: string, opts: { baseURL?: string; timeoutMs?: number } = {}) {
    this.client = new Anthropic({
      apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 60_000,
      maxRetries: 2, // SDK'et gentager 408/409/429/5xx + netværksfejl med backoff
    });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    try {
      const response = await this.client.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        // Stabilt systemprompt + katalog først → prompt caching af præfikset
        cache_control: { type: 'ephemeral' },
        system: req.system,
        messages: [{ role: 'user', content: req.userContent }],
        output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
      });
      const usage = response.usage;
      return {
        output: response.stop_reason === 'refusal' ? null : (response.parsed_output as T | null),
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
        model: response.model,
        stopReason: response.stop_reason,
        refused: response.stop_reason === 'refusal',
      };
    } catch (error) {
      throw mapError(error, req.model);
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list()) ids.push(m.id);
      return ids;
    } catch (error) {
      throw mapError(error, '');
    }
  }
}

function mapError(error: unknown, model: string): Error {
  if (error instanceof Anthropic.NotFoundError) {
    return new ModelUnavailableError(model, `Modellen ${model} er ikke tilgængelig: ${error.message}`);
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new PermanentAiError(`Claude API-nøglen blev afvist: ${error.message}`);
  }
  if (error instanceof Anthropic.RateLimitError) {
    const ra = Number(error.headers?.get?.('retry-after'));
    return new TransientAiError('Rate limit hos Claude API', Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000);
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new PermanentAiError(`Ugyldig forespørgsel til Claude: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new TransientAiError(`Ingen forbindelse til Claude API: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    return new TransientAiError(`Claude API-fejl ${error.status}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
