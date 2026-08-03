// New se-z Phase 1 differential parity test. It exercises pure release-state mechanics only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityNormalize, sourceSupervisor, target } from '../helpers/index.js';

async function modules() {
  return {
    sourceState: await sourceSupervisor('src/deployment/state-machine.ts'),
    sourceTypes: await sourceSupervisor('src/deployment/types.ts'),
    targetState: await target('src/releases/deployment/state-machine.ts'),
    targetTypes: await target('src/releases/deployment/types.ts'),
  };
}

test('all release states, products, transition rules, mutation classes, and evidence declarations normalize exactly', async () => {
  const { sourceState, sourceTypes, targetState, targetTypes } = await modules();
  assert.deepEqual(identityNormalize(sourceTypes.DEPLOYMENT_STATES), targetTypes.DEPLOYMENT_STATES);
  assert.deepEqual(identityNormalize(sourceTypes.DEPLOYMENT_PRODUCTS), targetTypes.DEPLOYMENT_PRODUCTS);
  assert.deepEqual(identityNormalize(sourceState.TRANSITION_RULES), targetState.TRANSITION_RULES);
  assert.deepEqual(identityNormalize([...sourceState.ACTIVE_MUTATION_STATES]), [...targetState.ACTIVE_MUTATION_STATES]);
  assert.deepEqual(identityNormalize([...sourceState.POST_ARM_STATES]), [...targetState.POST_ARM_STATES]);
  assert.deepEqual(identityNormalize([...sourceState.TERMINAL_STATES]), [...targetState.TERMINAL_STATES]);
  assert.ok(targetState.TRANSITION_RULES.length >= 40);
  for (const [index, sourceRule] of sourceState.TRANSITION_RULES.entries()) {
    const targetRule = targetState.TRANSITION_RULES[index];
    assert.deepEqual(identityNormalize(sourceState.getTransitionRule(sourceRule.from, sourceRule.to)), targetState.getTransitionRule(targetRule.from, targetRule.to));
  }
});

test('allowed transition, forbidden transition, and missing evidence have equivalent typed behavior', async () => {
  const { sourceState, targetState } = await modules();
  const sourceRule = sourceState.TRANSITION_RULES.find((rule: any) => rule.from === 'requested' && rule.to === 'source_resolving');
  const targetRule = targetState.TRANSITION_RULES.find((rule: any) => rule.from === 'requested' && rule.to === 'source_resolving');
  assert.ok(sourceRule); assert.ok(targetRule);
  const sourceInput = {
    deploymentId: 'deployment-1', generation: 1, stateSequence: 0,
    priorState: sourceRule.from, expectedState: sourceRule.from, nextState: sourceRule.to,
    evidence: sourceRule.requiredEvidence.map((kind: string) => ({ kind })),
  };
  const targetInput = identityNormalize(sourceInput);
  assert.doesNotThrow(() => sourceState.assertTransitionAllowed(false, sourceInput));
  assert.doesNotThrow(() => targetState.assertTransitionAllowed(false, targetInput));
  const capture = (fn: () => unknown) => {
    try { fn(); return { ok: true }; }
    catch (error: any) { return { ok: false, name: error.name, code: error.code, message: String(error.message) }; }
  };
  const sourceMissing = capture(() => sourceState.assertTransitionAllowed(false, { ...sourceInput, evidence: [] }));
  const targetMissing = capture(() => targetState.assertTransitionAllowed(false, { ...targetInput, evidence: [] }));
  assert.deepEqual(identityNormalize(sourceMissing), targetMissing);
  const sourceForbidden = capture(() => sourceState.assertTransitionAllowed(false, { ...sourceInput, expectedState: 'failed' }));
  const targetForbidden = capture(() => targetState.assertTransitionAllowed(false, { ...targetInput, expectedState: 'failed' }));
  assert.deepEqual(identityNormalize(sourceForbidden), targetForbidden);
  assert.equal(sourceMissing.ok, false);
  assert.equal(sourceForbidden.ok, false);
  assert.equal(sourceMissing.code, 'deployment_evidence_missing');
  assert.equal(sourceForbidden.code, 'deployment_terminal');
});
