import { GetParametersCommand, type SSMClient } from "@aws-sdk/client-ssm";

export interface Secrets {
  openrouterKey: string;
  apiToken: string;
}

/** Where the two secrets come from. Tests use a fake; on Lambda it's Parameter Store. */
export interface SecretSource {
  load(): Promise<Secrets>;
}

/**
 * Reads the two SecureString parameters in one call. Only the parameter names come from the
 * environment; the values never touch environment variables, files or logs.
 * Not exercised against real SSM: that needs an AWS account (see AWS_PLAN.md).
 */
export class SsmSecretSource implements SecretSource {
  constructor(
    private readonly ssm: SSMClient,
    private readonly names: { openrouterKey: string | undefined; apiToken: string | undefined },
  ) {}

  async load(): Promise<Secrets> {
    const { openrouterKey, apiToken } = this.names;
    if (!openrouterKey || !apiToken)
      throw new Error("set OPENROUTER_KEY_PARAM and API_TOKEN_PARAM");
    const out = await this.ssm.send(
      new GetParametersCommand({ Names: [openrouterKey, apiToken], WithDecryption: true }),
    );
    if (out.InvalidParameters?.length) {
      throw new Error(`missing parameters: ${out.InvalidParameters.join(", ")}`);
    }
    const value = (name: string) => out.Parameters?.find((p) => p.Name === name)?.Value ?? "";
    return { openrouterKey: value(openrouterKey), apiToken: value(apiToken) };
  }
}
