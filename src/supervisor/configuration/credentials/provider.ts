// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Secret reference resolution for job environment variables. */

export interface SecretReference {
  name: string;
  secretReference: string;
  redacted: true;
}

export interface ResolvedSecret {
  name: string;
  value: string;
}

export interface SecretProvider {
  resolve(reference: string): Promise<string | undefined>;
}

const SECRET_LIKE_ENVIRONMENT_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)(?:_|$)/iu;

export function isSecretLikeEnvironmentName(name: string): boolean {
  return SECRET_LIKE_ENVIRONMENT_NAME.test(name);
}

function rejectSecretLikeLiteral(name: string): void {
  if (isSecretLikeEnvironmentName(name)) {
    throw new Error(`Environment variable ${name} must use secretReference`);
  }
}

export class MapSecretProvider implements SecretProvider {
  constructor(private readonly secrets: Map<string, string>) {}

  async resolve(reference: string): Promise<string | undefined> {
    return this.secrets.get(reference);
  }
}

export class ProcessEnvSecretProvider implements SecretProvider {
  async resolve(reference: string): Promise<string | undefined> {
    const match = /^github:(.+)$/.exec(reference);
    if (!match) return undefined;
    return process.env[match[1]];
  }
}

export function isSecretReferenceEntry(
  entry: unknown,
): entry is { name: string; secretReference: string } {
  if (!entry || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  return typeof obj.name === 'string' && typeof obj.secretReference === 'string';
}

export function toPersistedSecretReference(name: string, secretReference: string): SecretReference {
  return { name, secretReference, redacted: true };
}

export async function resolveEnvironment(
  environment: unknown,
  provider: SecretProvider,
): Promise<{ env: Record<string, string>; persisted: Array<SecretReference | { name: string; value: string }> }> {
  const env: Record<string, string> = {};
  const persisted: Array<SecretReference | { name: string; value: string }> = [];

  if (!Array.isArray(environment)) {
    return { env, persisted };
  }

  for (const entry of environment) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const name = String(obj.name ?? '');
    if (!name) continue;

    if (typeof obj.secretReference === 'string') {
      const value = await provider.resolve(obj.secretReference);
      if (value === undefined) {
        throw new Error(`Secret reference not resolved: ${obj.secretReference}`);
      }
      env[name] = value;
      persisted.push(toPersistedSecretReference(name, obj.secretReference));
    } else if (typeof obj.value === 'string') {
      rejectSecretLikeLiteral(name);
      env[name] = obj.value;
      persisted.push({ name, value: obj.value });
    }
  }

  return { env, persisted };
}

export function containsSecretValue(value: string, needle: string): boolean {
  return value.includes(needle);
}
