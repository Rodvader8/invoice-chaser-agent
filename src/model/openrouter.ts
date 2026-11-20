import { z } from "zod";
import type { SpendGuard } from "./spend.js";
import type { ChatModel, ChatRequest, ChatResponse } from "./types.js";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** USD per million tokens. Used for the worst-case estimate before each call. */
  priceInPerMTok: number;
  priceOutPerMTok: number;
  guard: SpendGuard;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const Completion = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      cost: z.number().optional(),
    })
    .optional(),
});

export class ModelCallError extends Error {}

/** OpenRouter chat completions behind the spend guard. Never called by the tests or the evaluation. */
export class OpenRouterModel implements ChatModel {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterOptions) {
    if (!options.apiKey) throw new ModelCallError("no API key");
    if (!(options.priceInPerMTok > 0) || !(options.priceOutPerMTok > 0)) {
      throw new ModelCallError("set the model's prices so the spend guard can estimate");
    }
    this.name = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Worst case: about 1 token per 3 characters of prompt, plus every allowed output token. */
  estimateUsd(request: ChatRequest): number {
    const chars = request.messages.reduce((n, m) => n + m.content.length, 0);
    const promptTokens = Math.ceil(chars / 3);
    return (
      (promptTokens * this.options.priceInPerMTok +
        request.maxTokens * this.options.priceOutPerMTok) /
      1_000_000
    );
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const estimate = this.estimateUsd(request);
    await this.options.guard.reserve(estimate);
    let charged = estimate;
    try {
      const res = await this.fetchImpl(
        `${this.options.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: request.messages,
            max_tokens: request.maxTokens,
            temperature: 0.2,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.jsonSchema.name,
                strict: true,
                schema: request.jsonSchema.schema,
              },
            },
            usage: { include: true },
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        },
      );
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) charged = 0;
        throw new ModelCallError(`OpenRouter answered ${res.status}`);
      }
      const body = Completion.parse(await res.json());
      const usage = body.usage ?? { prompt_tokens: 0, completion_tokens: request.maxTokens };
      charged =
        usage.cost ??
        (usage.prompt_tokens * this.options.priceInPerMTok +
          usage.completion_tokens * this.options.priceOutPerMTok) /
          1_000_000;
      return {
        text: body.choices[0]?.message.content ?? "",
        model: body.model ?? this.options.model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        costUsd: charged,
      };
    } finally {
      await this.options.guard.settle(estimate, charged, this.options.model, request.purpose);
    }
  }
}

/** Remaining OpenRouter credit, for the account floor. */
export async function openRouterBalanceUsd(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl("https://openrouter.ai/api/v1/credits", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ModelCallError(`credits check answered ${res.status}`);
  const body = z
    .object({ data: z.object({ total_credits: z.number(), total_usage: z.number() }) })
    .parse(await res.json());
  return body.data.total_credits - body.data.total_usage;
}
