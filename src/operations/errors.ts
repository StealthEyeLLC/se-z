// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Stable operation-error contract returned inside signed se-z responses. */

export interface OperationErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  operation: string;
  requestId: string;
  partial: boolean;
  details?: Record<string, unknown>;
}

export class OperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
    public readonly partial = false,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

function inferCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('not found')) return 'not_found';
  if (normalized.includes('destination exists')) return 'destination_exists';
  if (normalized.includes('required')) return 'invalid_request';
  if (normalized.includes('invalid')) return 'invalid_request';
  if (normalized.includes('permission denied')) return 'permission_denied';
  if (normalized.includes('not active') || normalized.includes('lost')) return 'not_active';
  if (normalized.includes('timeout')) return 'timeout';
  return 'operation_failed';
}

export function normalizeOperationError(
  error: unknown,
  operation: string,
  requestId: string,
): { error: OperationErrorShape } {
  if (error instanceof OperationError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        operation,
        requestId,
        partial: error.partial,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  const message = error instanceof Error ? error.message : 'Operation failed';
  return {
    error: {
      code: inferCode(message),
      message,
      retryable: false,
      operation,
      requestId,
      partial: false,
    },
  };
}
