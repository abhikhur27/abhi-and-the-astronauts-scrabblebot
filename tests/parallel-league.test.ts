import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WordEngine} from '../src/engine.js';
import {createModel} from '../src/model.js';
import {hydratePolicy,type PolicySpec} from '../src/policy-spec.js';
import {evaluateLeague,type LeagueEntry,type LeagueReport} from '../src/league.js';
import {activeCpuWorkers,runCpuJobs} from '../src/cpu-pool.js';

const words=['AT','TA','TO','QI','XI','ZA','AX','OX','IT','IN','NO','ON','AS','IS','OR','ATE','TEA','EAT','RAT','TAR','ART'];
function entries():LeagueEntry[] {
  const model=createModel();
  const specs:PolicySpec[]=[{type:'coordinated',base:{type:'v2'}},{type:'coordinated',base:{type:'math',options:{bidScale:1.05}}},
    {type:'coordinated',base:{type:'dilute'}},{type:'learner',model,options:{training:false,epsilon:0},anchor:{type:'coordinated',base:{type:'v2'}}},
    {type:'reinvestment',options:{closingTiles:36},base:{type:'coordinated',base:{type:'v2'}}},
    {type:'endgame',options:{closingTiles:18},base:{type:'coordinated',base:{type:'v2'}}}];
  const engine=new WordEngine(words);
  return specs.map((spec,index)=>({name:['v2','math','dilute','rl','reinvest','endgame'][index]!,spec,create:()=>hydratePolicy(engine,spec)}));
}
function config(policies:LeagueEntry[]){return {engine:new WordEngine(words),entries:policies,dictionaryWords:words,seedBlock:9300,seedCount:1,baselineName:'v2',championName:'v2',candidateNames:['math','rl','dilute'],beliefParticles:1,decisionBudgetMs:10000,snapshots:{fixed:()=>true}};}
function decisions(report:LeagueReport){return report.games.map(game=>({...game,players:game.players.map(({actions,...player})=>({...player,actions:{bidDecisions:actions.bidDecisions,wordDecisions:actions.wordDecisions,invalidBids:actions.invalidBids,invalidWords:actions.invalidWords,exceptions:actions.exceptions}}))}));}

test('two CPU workers reproduce serial seeded outcomes and paired statistics with immutable inputs',async()=>{
  const policies=entries(),before=JSON.stringify(policies.map(entry=>entry.spec));
  const serial=await evaluateLeague({...config(policies),workers:1});
  const parallel=await evaluateLeague({...config(policies),workers:2});
  assert.equal(parallel.completed,true,parallel.stopReason??'');
  assert.deepEqual(decisions(parallel),decisions(serial));
  assert.deepEqual(parallel.modes.map(mode=>mode.comparisons),serial.modes.map(mode=>mode.comparisons));
  assert.equal(JSON.stringify(policies.map(entry=>entry.spec)),before);
  assert.equal(parallel.execution.workerThreadIds.length,2);
  assert.equal(parallel.execution.effectiveWorkers,2);
  assert.equal(parallel.execution.workersTerminated,true);
  assert.equal(activeCpuWorkers(),0);
});

test('parallel league refuses missing recipes or learning/exploration rather than evaluating different behavior',async()=>{
  await assert.rejects(evaluateLeague({...config(entries().map(({spec,...entry})=>entry)),workers:2}),/explicit policy specs/);
  const policies=entries();policies[3]!.spec={type:'learner',model:createModel(),options:{training:true}};
  await assert.rejects(evaluateLeague({...config(policies),workers:2}),/frozen policy/);
  assert.equal(activeCpuWorkers(),0);
});

test('parent snapshot mutation cancels the pool and cannot recommend promotion',async()=>{
  const state={revision:0};const timer=setTimeout(()=>{state.revision++;},50);
  try {
    const report=await evaluateLeague({...config(entries()),workers:2,seedCount:3,snapshots:{model:()=>state}});
    assert.equal(report.completed,false);assert.equal(report.frozen.unchanged,false);
    assert.equal(report.stopReason,'frozen-mutation');
    assert.ok(report.gates.every(gate=>!gate.eligible));assert.equal(activeCpuWorkers(),0);
  }finally{clearTimeout(timer);}
});

test('cancellation and worker failure return incomplete jobs and terminate every owned thread',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'scrabble-cpu-pool-'));
  const module=join(directory,'job.mts');
  writeFileSync(module,"export function createJobHandler(init:{fail?:boolean}){return (job:number)=>{if(init.fail)throw Error('fixture');return job*job;};}");
  const controller=new AbortController();
  const cancelled=await runCpuJobs<number,number>({moduleURL:pathToFileURL(module),initData:{},jobs:Array.from({length:100},(_,i)=>i),workers:2,signal:controller.signal,onResult:()=>controller.abort()});
  assert.equal(cancelled.stopReason,'aborted');assert.ok(cancelled.results.length<100);assert.equal(activeCpuWorkers(),0);
  const failed=await runCpuJobs<number,number>({moduleURL:pathToFileURL(module),initData:{fail:true},jobs:[1,2,3],workers:2});
  assert.equal(failed.stopReason,'worker-error');assert.equal(failed.workersTerminated,true);assert.equal(activeCpuWorkers(),0);
  const expired=await runCpuJobs<number,number>({moduleURL:pathToFileURL(module),initData:{},jobs:[1,2],workers:2,maxDurationMs:0});
  assert.equal(expired.stopReason,'duration-limit');assert.equal(expired.results.length,0);assert.equal(activeCpuWorkers(),0);
});

test('releasing derived caches preserves dictionary legality and deterministic packing',()=>{
  const engine=new WordEngine(words),rack=new Map([['Q',1],['I',1],['A',1],['T',1]]);
  const before={plan:engine.redemptionPlan(rack),exact:engine.exactRedemptionPlan(rack),playable:engine.playable(rack).map(candidate=>candidate.word),potential:engine.potential(rack,10)};
  engine.releaseCaches();
  assert.deepEqual({plan:engine.redemptionPlan(rack),exact:engine.exactRedemptionPlan(rack),playable:engine.playable(rack).map(candidate=>candidate.word),potential:engine.potential(rack,10)},before);
});
