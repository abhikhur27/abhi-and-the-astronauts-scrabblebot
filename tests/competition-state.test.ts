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
test('parallel replicas reserve their full training range and an independent fifth development family',()=>{
  const state=initialCompetitionState(),reserved=reserveCycleSeeds(state,160,4,12,5);
  assert.equal(reserved.next.nextTrainingSeed,300000160);
  assert.equal(reserved.next.nextTuningSeed,500000020);
  assert.equal(reserved.next.nextEvaluationSeed,700000012);
  assert.equal(state.nextTrainingSeed,300000000);
  const following=reserveCycleSeeds(reserved.next,160,4,12,5);
  assert.equal(following.training,300000160);
  assert.equal(following.tuning,500000020);
  assert.throws(()=>reserveCycleSeeds(state,160,4,12,0),/seed/);
  assert.throws(()=>reserveCycleSeeds(state,160,4,12,2.5),/seed/);
});
