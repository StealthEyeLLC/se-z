// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Authentication and replay errors. */

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class IdempotentReplay extends AuthError {
  constructor(public readonly cachedResponse: unknown) {
    super('idempotent_replay', JSON.stringify(cachedResponse), false);
  }
}
