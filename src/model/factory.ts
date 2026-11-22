import type { Store } from "../storage/types.js";
import { OpenRouterModel, openRouterBalanceUsd } from "./openrouter.js";
import { ScriptedModel } from "./scripted.js";
import { SpendGuard } from "./spend.js";
import type { ChatModel } from "./types.js";

function numberFrom(
  env: Record<string, string | undefined>,
  name: string,
  fallback?: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`set ${name}`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/**
 * The scripted model unless `live` is true. A live model needs an OpenRouter key (passed in by
 * the caller: from the environment locally, from Parameter Store on Lambda), INVOICE_CHASER_MODEL
 * and the model's prices, and runs under hard spend caps.
 */
export function makeModel(
  store: Store,
  options: { live: boolean; apiKey: string; env: Record<string, string | undefined> },
): ChatModel {
  if (!options.live) return new ScriptedModel("faithful");
  const model = options.env.INVOICE_CHASER_MODEL ?? "";
  if (!options.apiKey || !model)
    throw new Error("a live run needs an OpenRouter key and INVOICE_CHASER_MODEL");
  const { apiKey, env } = options;
  const guard = new SpendGuard(
    {
      runCapUsd: numberFrom(env, "INVOICE_CHASER_RUN_CAP_USD", 0.05),
      projectCapUsd: numberFrom(env, "INVOICE_CHASER_PROJECT_CAP_USD", 0.5),
      accountFloorUsd: numberFrom(env, "INVOICE_CHASER_ACCOUNT_FLOOR_USD", 1),
    },
    store,
    () => openRouterBalanceUsd(apiKey),
  );
  return new OpenRouterModel({
    apiKey,
    model,
    priceInPerMTok: numberFrom(env, "INVOICE_CHASER_PRICE_IN_PER_MTOK"),
    priceOutPerMTok: numberFrom(env, "INVOICE_CHASER_PRICE_OUT_PER_MTOK"),
    guard,
  });
}
