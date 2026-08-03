import assert from 'node:assert/strict'; import fs from 'node:fs'; import test from 'node:test';
const map=JSON.parse(fs.readFileSync('contracts/phase1-capability-map.json','utf8'));
test('all 49 installed operations are mapped exactly once',()=>{assert.equal(map.installedOperationCount,49);assert.equal(map.operations.length,49);assert.equal(new Set(map.operations.map((entry)=>entry.sourceOperation)).size,49);assert.equal(map.completeness.everyInstalledOperationMapped,true);
  assert.deepEqual(map.completeness.silentDisappearances,[]);});
test('no mapped capability disappears silently',()=>{const allowed=new Set(['PRESERVED_DIRECTLY','MECHANICALLY_RENAMED','EXTRACTED_NOT_INTEGRATED','SUPERSEDED_BY_CANONICAL_TARGET','DEFERRED_TO_0.1A','DEFERRED_TO_0.1B','DEFERRED_TO_0.1C','INTENTIONALLY_NOT_CARRIED','BLOCKED']);for(const entry of map.operations) assert.ok(allowed.has(entry.state),`${entry.sourceOperation}: ${entry.state}`);});
