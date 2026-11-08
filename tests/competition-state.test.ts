import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCompetitionState, reserveCycleSeeds } from '../src/competition-state.js';
test('resumed cycles reserve disjoint training, tuning and evaluation seeds before work starts',()=>{
  const first=reserveCycleSeeds(initialCompetitionState(),40,2,6);
  const resumed=reserveCycleSeeds(JSON.parse(JSON.stringify(first.next)),40,2,6);
  assert.equal(first.training,300000000);
  assert.equal(resumed.training,300000040);
  assert.equal(first.tuning,500000000);
  assert.equal(resumed.tuning,500000008);
  assert.equal(first.evaluation,700000000);
  assert.equal(resumed.evaluation,700000006);
  assert.ok(resumed.next.nextTrainingSeed<first.tuning);
  assert.ok(resumed.next.nextTuningSeed<first.evaluation);
});
test('seed reservation fails closed at domain boundaries instead of wrapping into old seeds',()=>{
  const state=initialCompetitionState();state.nextEvaluationSeed=0x80000000-2;
  assert.throws(()=>reserveCycleSeeds(state,40,2,6),/seed/);
  assert.equal(state.cycle,0);
});
