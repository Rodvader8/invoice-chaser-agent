import { SSMClient } from "@aws-sdk/client-ssm";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { buildAwsRuntime, type Runtime } from "./runtime.js";
import { SsmSecretSource, type SecretSource, type Secrets } from "./secrets.js";

/** The function URL response shape this handler always returns. */
export interface UrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface HandlerDeps {
  secrets: SecretSource;
  runtime: (secrets: Secrets) => Promise<Runtime>;
  log?: (line: string) => void;
}

/**
 * Maps a Lambda function URL event onto the shared router. The secrets are read and the runtime
 * built once per cold start; a failure there isn't cached, so the next request tries again.
 * One log line per request: method, path, status, milliseconds. Never headers or bodies.
 */
export function createHandler(
  deps: HandlerDeps,
): (event: LambdaFunctionURLEvent) => Promise<UrlResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let ready: Promise<Runtime> | undefined;

  return async (event) => {
    const started = Date.now();
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const reply = (status: number, body: unknown): UrlResult => {
      log(JSON.stringify({ method, path, status, ms: Date.now() - started }));
      return {
        statusCode: status,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
    };

    let runtime: Runtime;
    try {
      ready ??= deps.secrets.load().then(deps.runtime);
      runtime = await ready;
    } catch (err) {
      ready = undefined;
      log(
        JSON.stringify({
          event: "cold_start_failed",
          error: err instanceof Error ? err.name : "unknown",
        }),
      );
      return reply(503, { error: "not ready" });
    }

    const body = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body
      : "";
    const out = await runtime.route({
      method,
      path,
      authorization: event.headers.authorization,
      body,
    });
    return reply(out.status, out.body);
  };
}

/** The deployed entry point. Parameter names come from the environment set by the CDK stack. */
export const handler = createHandler({
  secrets: new SsmSecretSource(new SSMClient({}), {
    openrouterKey: process.env.OPENROUTER_KEY_PARAM,
    apiToken: process.env.API_TOKEN_PARAM,
  }),
  runtime: (secrets) => buildAwsRuntime(secrets, process.env),
});
