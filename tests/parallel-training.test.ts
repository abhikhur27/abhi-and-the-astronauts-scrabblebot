import test from 'node:test';
import assert from 'node:assert/strict';
import {createModel,LearningBot} from '../src/model.js';
import {WordEngine} from '../src/engine.js';
import {hydratePolicy} from '../src/policy-spec.js';
import {simulateMatch} from '../src/simulator.js';
import {runParallelTraining,type ParallelTrainingOptions} from '../src/parallel-training.js';
import {activeCpuWorkers} from '../src/cpu-pool.js';
import type {PolicySpec} from '../src/policy-spec.js';

function options():ParallelTrainingOptions {
  const frozen:PolicySpec={type:'coordinated',base:{type:'v2'}};
  return {dictionaryWords:['AT','ATE','TEA','QI','IT','TO','OR','ON','NO','AN','IN','AI'],initialModel:createModel(),
    replicas:2,gamesPerReplica:2,trainingSeed:300000000,cycleId:'parallel-training-fixture',anchor:frozen,
    opponents:[frozen,frozen,frozen,frozen,frozen],untilMs:Date.now()+30000,workers:2,beliefParticles:4};
}
test('independent training branches use unique games and actors without mutating or averaging the parent',async()=>{
  const input=options(),before=structuredClone(input.initialModel),opponents=structuredClone(input.opponents);
  const result=await runParallelTraining(input);
  assert.equal(result.replicas.length,2);
  assert.equal(result.completed,true);
  assert.equal(result.totalCompletedGames,4);
  assert.equal(result.execution.effectiveWorkers,2);
  assert.equal(result.execution.workerThreadIds.length,2);
  assert.equal(result.execution.workersTerminated,true);
  assert.equal(result.execution.stopReason,null);
  const seeds=result.replicas.flatMap(replica=>replica.episodes.map(episode=>episode.seed));
  assert.deepEqual(seeds,[300000000,300000001,300000002,300000003]);
  assert.equal(new Set(result.replicas.flatMap(replica=>replica.episodes.map(episode=>episode.actorSeed))).size,4);
  for(const replica of result.replicas){
    assert.equal(replica.complete,true);assert.equal(replica.completedGames,2);
    assert.equal(replica.model.trainedGames,before.trainedGames+2);
    assert.ok(replica.updatesAdded>0);assert.equal(replica.model.updates,before.updates+replica.updatesAdded);
    assert.equal(replica.episodes[0]!.auctionType,'Vickrey');assert.equal(replica.episodes[1]!.auctionType,'FirstPrice');
    assert.notDeepEqual(replica.model.bidWeights,before.bidWeights);
  }
  assert.notStrictEqual(result.replicas[0]!.model,result.replicas[1]!.model);
  assert.notStrictEqual(result.replicas[0]!.model,input.initialModel);
  assert.deepEqual(input.initialModel,before);assert.deepEqual(input.opponents,opponents);
  assert.deepEqual(result.fallbackModel,before);assert.notStrictEqual(result.fallbackModel,input.initialModel);
  const serial=await runParallelTraining({...input,workers:1});
  assert.equal(serial.completed,true);
  assert.deepEqual(serial.replicas,result.replicas,'worker scheduling must not change branch models or their games');
  const weights=result.replicas[0]!.model,frozenBefore=structuredClone(weights),engine=new WordEngine(input.dictionaryWords);
  const frozen=new LearningBot(engine,weights,{training:false,epsilon:0,anchorPolicy:hydratePolicy(engine,input.anchor)});
  simulateMatch({engine,policies:[frozen,...input.opponents.map(spec=>hydratePolicy(engine,spec))],seed:0x80000001,beliefParticles:4});
  assert.deepEqual(weights,frozenBefore,'held-out inference must not learn on the evaluated branch');
  assert.equal(activeCpuWorkers(),0);
});
test('an expired training deadline launches no workers and retains an explicit unchanged fallback',async()=>{
  const input=options();input.untilMs=Date.now()-1;
  const result=await runParallelTraining(input);
  assert.equal(result.completed,false);assert.equal(result.totalCompletedGames,0);
  assert.equal(result.replicas.length,0);assert.equal(result.execution.effectiveWorkers,0);
  assert.equal(result.execution.stopReason,'duration-limit');assert.equal(activeCpuWorkers(),0);
  assert.deepEqual(result.fallbackModel,input.initialModel);
});
test('cancellation terminates training workers and cannot produce an eligible completed experiment',async()=>{
  const input=options(),abort=new AbortController();input.signal=abort.signal;input.gamesPerReplica=40;
  const timer=setTimeout(()=>abort.abort(),40);
  try {
    const result=await runParallelTraining(input);
    assert.equal(result.completed,false);assert.equal(result.execution.stopReason,'aborted');
    assert.equal(result.execution.workersTerminated,true);assert.equal(activeCpuWorkers(),0);
    assert.deepEqual(input.initialModel,createModel());
  }finally{clearTimeout(timer);}
});
test('training refuses learning opponents or anchors and invalid replica seed reservations',async()=>{
  const input=options();input.opponents=[{type:'learner',model:createModel(),options:{training:true}},...input.opponents.slice(1)];
  await assert.rejects(runParallelTraining(input),/frozen/);
  const invalid=options();invalid.trainingSeed=499999999;
  await assert.rejects(runParallelTraining(invalid),/seed/);
  const legacy=options();legacy.initialModel=createModel('legacy-mc');
  await assert.rejects(runParallelTraining(legacy),/residual/);
});
