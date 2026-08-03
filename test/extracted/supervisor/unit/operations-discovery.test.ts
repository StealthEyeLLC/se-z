// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/operations-discovery.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';
import {
  CANONICAL_SEZ_ACTION_DESCRIPTION,
  CANONICAL_SEZ_TOOL,
  OPERATION_DEFINITIONS,
  buildCapabilityDescription,
} from '../../../../src/operations/definitions.js';
import { normalizeOperationError, OperationError } from '../../../../src/operations/errors.js';
import { OperationRegistry, OPERATIONS } from '../../../../src/operations/registry.js';
import { ReplayStore } from '../../../../src/state/replay/store.js';
import { StateStore } from '../../../../src/state/store/store.js';
import type { AuthenticatedRequest } from '../../../../src/supervisor/dispatch/auth/authenticator.js';

const root = mkdtempSync(join(tmpdir(), 'se-z-discovery-'));
const config = loadRuntimeConfig({
  stateRoot: join(root, 'state'),
  configRoot: join(root, 'config'),
  skipPeerCredCheck: true,
  expectedHostname: 'test-host',
  expectedMachineIdSha256: 'test',
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('operation discovery', () => {
  it('publishes unique executable operation definitions', () => {
    const names = OPERATION_DEFINITIONS.map((definition) => definition.operation);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(OPERATIONS, names);
    assert.ok(names.includes('sez.describe'));
    assert.ok(names.includes('sez.health'));
    assert.equal(names.length, 48);
    assert.equal(names.filter((name) => name.startsWith('sez.release.')).length, 8);
    assert.equal(names.filter((name) => name.startsWith('sez.selfhost.')).length, 3);
  });

  it('locks the single-tool ChatGPT invocation wording', () => {
    assert.equal(CANONICAL_SEZ_TOOL, 'call_sez');
    assert.equal(
      CANONICAL_SEZ_ACTION_DESCRIPTION,
      'Run one authorized se-z operation through the single authenticated se-z interface and return its durable result with verified signed evidence.',
    );
  });

  it('returns limits, schemas, release identity, and invocation rules', () => {
    const description = buildCapabilityDescription(config) as {
      operations: Array<{ operation: string }>;
      invocation: { tool: string; actionDescription: string; variableFields: string[] };
      limits: Record<string, number>;
      release: Record<string, unknown>;
    };
    assert.equal(description.operations.length, OPERATION_DEFINITIONS.length);
    assert.equal(description.invocation.tool, CANONICAL_SEZ_TOOL);
    assert.equal(description.invocation.actionDescription, CANONICAL_SEZ_ACTION_DESCRIPTION);
    assert.deepEqual(description.invocation.variableFields, ['operation', 'payload', 'idempotencyKey']);
    assert.deepEqual((description.invocation as Record<string, unknown>).annotations, { idempotentHint: true });
    assert.deepEqual((description.invocation as Record<string, unknown>).securitySchemes, [{ type: 'oauth2', scopes: ['sez.root'] }]);
    assert.ok(description.limits.maxFrameSize > 0);
    assert.ok(description.release.status);
  });

  it('dispatches sez.describe through the unified registry', async () => {
    const replay = new ReplayStore(config);
    const registry = new OperationRegistry(config, new StateStore(config), replay);
    const auth: AuthenticatedRequest = {
      payload: {
        protocolVersion: '1.0.0',
        requestId: '00000000-0000-4000-8000-000000000001',
        operation: 'sez.describe',
        principal: {},
        authority: {},
        targetHost: 'test-host',
        timestamp: new Date().toISOString(),
        payload: {},
        binaryLength: 0,
      },
      signingDocument: '{}',
      hash: 'describe-request-hash',
      fingerprint: 'describe-request-fingerprint',
      subject: 'stealtheye-owner',
      authorityClass: 'unrestricted-owner',
    };
    const { response } = await registry.dispatch(auth);
    const result = response.result as { operations: Array<{ operation: string }> };
    assert.ok(result.operations.some((operation) => operation.operation === 'sez.describe'));
  });
});

describe('structured operation errors', () => {
  it('normalizes explicit operation errors', () => {
    assert.deepEqual(
      normalizeOperationError(
        new OperationError('precondition_failed', 'digest changed', false, { expected: 'a', actual: 'b' }),
        'sez.file.replace',
        'request-1',
      ),
      {
        error: {
          code: 'precondition_failed',
          message: 'digest changed',
          retryable: false,
          operation: 'sez.file.replace',
          requestId: 'request-1',
          partial: false,
          details: { expected: 'a', actual: 'b' },
        },
      },
    );
  });

  it('normalizes ordinary runtime errors without leaking stack data', () => {
    const normalized = normalizeOperationError(
      new Error('Destination exists'),
      'sez.file.copy',
      'request-2',
    );
    assert.deepEqual(normalized, {
      error: {
        code: 'destination_exists',
        message: 'Destination exists',
        retryable: false,
        operation: 'sez.file.copy',
        requestId: 'request-2',
        partial: false,
      },
    });
  });
});
