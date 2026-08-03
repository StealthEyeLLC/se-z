import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { canonical, identityNormalize, readJson, sourceSupervisor, target } from '../helpers/index.js';

let sourceDefinitions: any[];
let targetDefinitions: any[];

before(async () => {
  sourceDefinitions = (await sourceSupervisor('src/operations/definitions.ts')).OPERATION_DEFINITIONS;
  targetDefinitions = (await target('src/operations/definitions.ts')).OPERATION_DEFINITIONS;
});

test('all 48 core operation definitions are one-to-one mechanical extractions', () => {
  assert.equal(sourceDefinitions.length, 48);
  assert.equal(targetDefinitions.length, 48);
  for (let index = 0; index < sourceDefinitions.length; index += 1) {
    assert.equal(canonical(identityNormalize(sourceDefinitions[index])), canonical(targetDefinitions[index]), sourceDefinitions[index].operation);
  }
});

test('installed dynamic skill is mapped without being falsely activated', () => {
  const capability = readJson('contracts/phase1-capability-map.json');
  assert.equal(capability.installedOperationCount, 49);
  assert.equal(capability.operations.length, 49);
  assert.equal(capability.completeness.everyInstalledOperationMapped, true);
  assert.deepEqual(capability.completeness.silentDisappearances, []);
  const skill = capability.operations.find((operation: any) => operation.sourceOperation === 'baby.skill.proof.echo');
  assert.ok(skill);
  assert.equal(skill.targetOperation, 'sez.skill.proof.echo');
  assert.equal(skill.state, 'EXTRACTED_NOT_INTEGRATED');
  assert.equal(skill.integratedOperation, false);
  assert.equal(skill.productionSupportedOperation, false);
});

test('catalog metadata preserves family, mutation, idempotency, errors, limits, and deterministic order', () => {
  const sourceProjection = sourceDefinitions.map((definition) => identityNormalize({
    operation: definition.operation, family: definition.family, version: definition.version,
    mutation: definition.mutation, idempotency: definition.idempotency, errors: definition.errors,
    cancellation: definition.cancellation, restartBehavior: definition.restartBehavior,
    input: definition.input, output: definition.output,
  }));
  const targetProjection = targetDefinitions.map((definition) => JSON.parse(JSON.stringify({
    operation: definition.operation, family: definition.family, version: definition.version,
    mutation: definition.mutation, idempotency: definition.idempotency, errors: definition.errors,
    cancellation: definition.cancellation, restartBehavior: definition.restartBehavior,
    input: definition.input, output: definition.output,
  })));
  assert.deepEqual(sourceProjection, targetProjection);
  assert.equal(new Set(targetDefinitions.map((definition) => definition.operation)).size, 48);
});
