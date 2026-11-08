import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { WordEngine } from '../src/engine.js';
import { explainCommittedWord, shouldDeferCommittedWord } from '../src/action-coordination.js';
import type { DecisionContext, PublicInformation } from '../src/types.js';

function context(letters='NROW', overrides:Partial<DecisionContext>={}):DecisionContext {
  const myRack=new Map<string,number>();for(const letter of letters)myRack.set(letter,(myRack.get(letter)??0)+1);
  return {myRack,myBalance:36,myScore:84,tilesRemaining:9,auctionType:'Vickrey',letter:'D',...overrides};
}
function market(medianPayment:number, overrides:Partial<PublicInformation>={}):PublicInformation {
  return {consistent:true,completeHistory:true,knownOwnInitial:true,bagCount:9,observedAuctionCount:59,
    expectedBag:new Map(),bagMinimum:new Map(),bagMaximum:new Map(),opponents:[],samples:[],effectiveSampleSize:0,
    market:{medianPayment,p75Payment:medianPayment,samples:5},...overrides};
}
const observedEngine=new WordEngine(['WORN','DROWN','AD']);

test('a committed D purchase preserves WORN letters for the confirmed DROWN regression',()=>{
  const decision=explainCommittedWord(observedEngine,context(),'WORN',21);
  assert.equal(decision.defer,true);
  assert.equal(decision.reason,'preserve-committed-completion');
  assert.equal(decision.holdIfWon,18);
  assert.equal(decision.sellFirstIfWon,10);
  assert.equal(decision.benefit,8);
});
test('a proposed or withdrawn bid cannot hold a cashout, and the final unredeemable tile never does',()=>{
  for(const bid of [0,-1,1.5,Number.NaN,Number.POSITIVE_INFINITY,37])assert.equal(shouldDeferCommittedWord(observedEngine,context(),'WORN',bid),false);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('',{tilesRemaining:0}),'WORN',21),false);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{tilesRemaining:0}),'WORN',21),false);
});
test('a current last-usable offer can preserve a completion, but a newly settled context has no old commitment',()=>{
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{tilesRemaining:1}),'WORN',21),true);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{letter:'A'}),'WORN',0),false);
});
test('selling a word is not delayed when it does not lower value after the tile arrives',()=>{
  const engine=new WordEngine(['WORN','AD']);
  const decision=explainCommittedWord(engine,context(),'WORN',21);
  assert.equal(decision.defer,false);
  assert.equal(decision.holdIfWon,10);
  assert.equal(decision.sellFirstIfWon,10);
});
test('repeated letters are consumed with exact multiplicities rather than membership',()=>{
  const engine=new WordEngine(['AA','AB','AABB']);
  const decision=explainCommittedWord(engine,context('AAB',{letter:'B'}),'AA',21);
  assert.equal(decision.defer,true);
  assert.equal(decision.holdIfWon,12);
  assert.equal(decision.sellFirstIfWon,2);
  assert.equal(shouldDeferCommittedWord(engine,context('AB',{letter:'B'}),'AA',21),false);
});
test('weak commitments do not suppress liquidity, and known affordable commitments may survive low cash',()=>{
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{information:market(20)}),'WORN',19),false);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{information:market(20)}),'WORN',21),true);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{myBalance:11}),'WORN',11),false);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{myBalance:12}),'WORN',11),true);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{myBalance:11,information:market(8)}),'WORN',11),true);
});
test('inconsistent price history and unrelated opposing scores do not fabricate certainty or change the own-rack conflict',()=>{
  const ctx=context('NROW',{information:market(999,{consistent:false}),opponents:[{botId:'1',score:1000,balance:1000}]});
  assert.equal(shouldDeferCommittedWord(observedEngine,ctx,'WORN',21),true);
  assert.equal(shouldDeferCommittedWord(observedEngine,{...ctx,opponents:[{botId:'2',score:0,balance:0}]},'WORN',21),true);
});
test('invalid or unavailable words cannot reserve a committed rack',()=>{
  assert.equal(shouldDeferCommittedWord(observedEngine,context(),'DROWN',21),false);
  assert.equal(shouldDeferCommittedWord(observedEngine,context(),'NROW',21),false);
  assert.equal(shouldDeferCommittedWord(observedEngine,context('NROW',{letter:'d'}),'WORN',21),false);
});
test('uncertified approximate packing cannot suppress a known cashout',()=>{
  const permutations=(text:string):string[]=>text.length<2?[text]:[...text].flatMap((c,i)=>permutations(text.slice(0,i)+text.slice(i+1)).map(rest=>c+rest));
  const engine=new WordEngine(['AB',...permutations('ABCDEF')]);
  const decision=explainCommittedWord(engine,context('ABCDE',{letter:'F'}),'AB',21);
  assert.equal(decision.defer,false);
  assert.equal(decision.reason,'approximate-plan');
});
test('coordination does not mutate rack, market or opponent observations',()=>{
  const ctx=context('NROW',{information:market(20)}),before=JSON.stringify({...ctx,myRack:[...ctx.myRack]});
  explainCommittedWord(observedEngine,ctx,'WORN',21);
  assert.equal(JSON.stringify({...ctx,myRack:[...ctx.myRack]}),before);
});

test('an opt-in exact planner preserves the committed SCRAWLY line without changing default coordination',()=>{
  const engine=new WordEngine(readFileSync(new URL('../data/enable1.txt',import.meta.url),'utf8').split(/\r?\n/));
  const ctx=context('ACILRSTW',{letter:'Y',myBalance:41,tilesRemaining:26});
  const legacy=explainCommittedWord(engine,ctx,'CITRALS',30);
  assert.equal(legacy.defer,false);assert.equal(legacy.reason,'approximate-plan');
  const exact=explainCommittedWord(engine,ctx,'CITRALS',30,hand=>engine.exactRedemptionPlan(hand));
  assert.equal(exact.defer,true);assert.equal(exact.holdIfWon,47);assert.equal(exact.sellFirstIfWon,27);
  assert.equal(explainCommittedWord(engine,ctx,'CITRALS',30).defer,false);
});
