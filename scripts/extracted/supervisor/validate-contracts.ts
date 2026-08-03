// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Contract validation script. */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '../../../src/operations/registry.js';
import {
  CANONICAL_SEZ_ACTION_DESCRIPTION,
  CANONICAL_SEZ_TOOL,
} from '../../../src/operations/definitions.js';
import { CONTRACT_VERSION } from '../../../src/supervisor/configuration/config.js';
import { RECEIPT_SCHEMA_VERSION } from '../../../src/protocol/receipts/receipt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function fail(message: string, details?: unknown): never {
  console.error(message, details ?? '');
  process.exit(1);
}

function main(): void {
  const contractPath = join(root, 'contracts', 'se-z-contracts-v1.json');
  const schemaPath = join(root, 'schemas', 'se-z-protocol-v1.schema.json');

  if (!existsSync(contractPath)) fail('Contract bundle not found');
  if (!existsSync(schemaPath)) fail('Protocol schema not found');

  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const contractOps = contract.operations.map((entry: { operation: string }) => entry.operation);

  if (new Set(contractOps).size !== contractOps.length) {
    fail('Contract operation list contains duplicates');
  }
  if (contractOps.length !== OPERATIONS.length) {
    fail('Contract and registry operation counts differ', {
      contract: contractOps.length,
      registry: OPERATIONS.length,
    });
  }
  if (contractOps.some((operation: string, index: number) => operation !== OPERATIONS[index])) {
    fail('Contract operation order or membership differs from executable registry', {
      contractOps,
      registryOps: OPERATIONS,
    });
  }
  if (contract.contractVersion !== CONTRACT_VERSION) {
    fail('Contract version differs from runtime constant', {
      contract: contract.contractVersion,
      runtime: CONTRACT_VERSION,
    });
  }
  if (contract.clientInvocation?.tool !== CANONICAL_SEZ_TOOL) {
    fail('Canonical se-z tool identity changed');
  }
  if (contract.clientInvocation?.actionDescription !== CANONICAL_SEZ_ACTION_DESCRIPTION) {
    fail('Canonical se-z action description changed');
  }
  if (contract.receipt?.emittedSchemaVersion !== RECEIPT_SCHEMA_VERSION) {
    fail('Receipt contract does not match emitted schema version');
  }
  const accepted = contract.receipt?.acceptedSchemaVersions;
  if (!Array.isArray(accepted) || !accepted.includes('1.0.0') || !accepted.includes('2.0.0')) {
    fail('Receipt contract must accept both v1 and v2 during migration');
  }
  const receiptRefs = schema.definitions?.receipt?.oneOf?.map(
    (entry: { $ref?: string }) => entry.$ref,
  );
  if (
    !Array.isArray(receiptRefs) ||
    !receiptRefs.includes('#/definitions/receiptV1') ||
    !receiptRefs.includes('#/definitions/receiptV2')
  ) {
    fail('Protocol schema must accept receipt v1 and v2');
  }
  if (schema.definitions?.request?.properties?.protocolVersion?.const !== '1.0.0') {
    fail('SEZ1 wire protocol version changed unexpectedly');
  }

  console.log(
    `Contract validation passed: ${contractOps.length} operations, contract ${CONTRACT_VERSION}, receipts v1+v2, schema ${schema.title}`,
  );
}

main();
