import test from 'node:test';
import assert from 'node:assert/strict';
import { WordEngine,canSpell } from '../src/engine.js';
import { MathBot as MathV2 } from '../src/math-v2.js';
import { CoordinatedBot } from '../src/coordinated-policy.js';
import { ReinvestmentBot,normalizedReinvestmentOptions } from '../src/reinvest.js';
import type { BotPolicy,DecisionContext,PublicInformation,Rack } from '../src/types.js';
const rack=(s:string)=>{const r=new Map<string,number>();for(const c of s)r.set(c,(r.get(c)??0)+1);return r;};
const base:BotPolicy={decideBid:()=>2,chooseWord:()=>null};
function context(letters:string,bag:string,overrides:Partial<DecisionContext>={}):DecisionContext{
 const future=rack(bag),hand=new Map<string,number>(),remaining=bag.length;
 const information:PublicInformation={consistent:true,completeHistory:true,knownOwnInitial:true,bagCount:remaining,observedAuctionCount:68-remaining,expectedBag:future,bagMinimum:future,bagMaximum:future,
 opponents:[{botId:'p',rackSize:0,initialMinimum:hand,rackMinimum:hand,rackMaximum:hand,rackMean:hand}],samples:[{weight:1,bag:future,opponentRacks:new Map([['p',hand]])}],effectiveSampleSize:1,market:{medianPayment:12,p75Payment:16,samples:20}};
 return {myRack:rack(letters),myBalance:60,myScore:70,tilesRemaining:remaining,letter:'A',auctionType:'Vickrey',opponents:[{botId:'p',balance:40,score:90}],information,...overrides};
}
test('a well-funded short hand can compete for a finite complementary rebuild',()=>{
 const state=context('','IIIIIIIIIAAAAAAAAA',{letter:'Q'}),bot=new ReinvestmentBot(new WordEngine(['QI']),base);
 assert.equal(bot.decideBid(state),13);
 assert.equal(bot.chooseWord(state),null);
});
test('a depleted offered Q gets no fabricated rebuild floor',()=>{
 const state=context('','EEEEEEEEEEEETTTTTT',{letter:'Q'}),bot=new ReinvestmentBot(new WordEngine(['QI']),base,{strength:'aggressive'});
 assert.equal(bot.decideBid(state),2);
});
test('a late exact FROWN completion can use one executable refund and preserve real working capital',()=>{
 const words=new WordEngine(['WORN','FROWN','HO']),anchor=new CoordinatedBot(words,new MathV2(words)),bot=new ReinvestmentBot(words,anchor,{strength:'aggressive'});
 const state=context('NORW','FEEEEEEEEEEEE',{myBalance:36,myScore:84,letter:'F',opponents:[{botId:'p',balance:50,score:106},...['q','r','s','t'].map(botId=>({botId,balance:10,score:0}))]});
 // Include each public rival in the physical joint scenario.
 const info=state.information!;for(const p of state.opponents!.slice(1)){
  info.opponents=[...info.opponents,{botId:p.botId!,rackSize:0,initialMinimum:new Map(),rackMinimum:new Map(),rackMaximum:new Map(),rackMean:new Map()}];
  (info.samples[0]!.opponentRacks as Map<string,Rack>).set(p.botId!,new Map());
 }
 for(const auctionType of ['Vickrey','FirstPrice'] as const){
  const before={...state,auctionType};assert.equal(bot.decideBid(before),34);
  assert.equal(bot.chooseWord({...before,committedBid:34}),null);
  const awarded={...before,myRack:rack('FROWN'),myBalance:2,tilesRemaining:12,letter:'S',committedBid:0};
  assert.equal(bot.decideBid(awarded),0);assert.equal(bot.chooseWord(awarded),'FROWN');
  assert.ok(canSpell(bot.chooseWord(awarded)!,awarded.myRack));bot.beginEpisode();
 }
});
test('cashouts release capital before a new commitment and episode reset clears the promise',()=>{
 const words=new WordEngine(['WORN','FROWN']),bot=new ReinvestmentBot(words,base,{strength:'aggressive'});
 const state=context('NORW','FEEEEEEEEEEEE',{letter:'F',myBalance:100});
 assert.ok(bot.decideBid(state)>2);
 const awarded={...state,myRack:rack('FROWN'),myBalance:50,tilesRemaining:12,letter:'E'};
 assert.equal(bot.decideBid(awarded),0);assert.equal(bot.chooseWord(awarded),'FROWN');
 const redeemed={...awarded,myRack:new Map<string,number>(),myBalance:72,myScore:state.myScore+22};
 assert.equal(bot.decideBid(redeemed),2);bot.beginEpisode();assert.equal(bot.chooseWord(awarded),null);
});
test('rebuilds reserve two real future purchases and do not spend anticipated later refunds',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['AT']),base,{strength:'aggressive'});
 assert.equal(bot.decideBid(context('','EEEEEEEEEEEETTTTTT',{myBalance:30})),2);
});
test('a weak low-reward continuation does not justify overpaying the public market',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['AT']),base),state=context('','EEEEEEEEEEEETTTTTT',{letter:'A'});
 assert.equal(bot.decideBid(state),2);
 const detail=bot.explainReinvestmentDecision(state);assert.ok(detail.optionGain!>0);assert.ok(detail.optionGain!<detail.requiredOptionGain!);
});
test('component modes isolate funded completions from replenishment floors',()=>{
 const words=new WordEngine(['QI','WORN','FROWN']);
 const completion=context('NORW','FEEEEEEEEEEEE',{letter:'F',myBalance:100}),rebuild=context('','IIIIIIIIIAAAAAAAAA',{letter:'Q'});
 for(const mode of ['both','completions','rebuild'] as const){
  const bot=new ReinvestmentBot(words,base,{mode,strength:'balanced'});
  assert.equal(bot.decideBid(completion)>2,mode!=='rebuild');
  assert.equal(bot.decideBid(rebuild)>2,mode!=='completions');
 }
});
test('a cheaper Vickrey award does not force a liquid winner to cash out early',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['WORN','FROWN','FROWNS']),base,{strength:'aggressive'}),state=context('NORW','FEEEEEEEEEEEE',{letter:'F',myBalance:100});
 assert.equal(bot.decideBid(state),50);
 const cheapAward={...state,myRack:rack('FROWN'),myBalance:80,tilesRemaining:12,letter:'S'};
 assert.equal(bot.decideBid(cheapAward),2);assert.equal(bot.chooseWord(cheapAward),null);
 // The satisfied promise is discarded, rather than reactivated by a later state.
 assert.equal(bot.chooseWord({...cheapAward,myBalance:50}),null);
});
test('a currently spellable first word cannot fabricate an award-dependent refund',()=>{
 const words=new WordEngine(['QAT','QI','AT','XI']),bot=new ReinvestmentBot(words,base,{strength:'aggressive'});
 const state=context('QATI','EEEEEEEEEEEETTTTTT',{letter:'X',myBalance:100});
 assert.equal(words.redemptionPlan(state.myRack).value,13);
 assert.equal(words.redemptionPlan(rack('QATIX')).firstWord,'QAT');
 assert.equal(bot.explainReinvestmentDecision(state).cashoutWord,null);
 assert.equal(bot.chooseWord({...state,tilesRemaining:17,letter:'E'}),null);
});
test('a pledged completion does not activate from a different next-auction hand or later window',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['WORN','FROWN']),base,{strength:'aggressive'}),state=context('NORW','FEEEEEEEEEEEE',{letter:'F',myBalance:100});
 assert.ok(bot.decideBid(state)>2);
 assert.equal(bot.chooseWord({...state,myRack:rack('FROWNA'),tilesRemaining:12}),null);
 assert.equal(bot.chooseWord({...state,myRack:rack('FROWN'),tilesRemaining:11}),null);
});
test('missing, stale or inconsistent public evidence leaves the base policy unchanged',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['AT']),base),state=context('','EEEEEEEEEEEETTTTTT');
 assert.equal(bot.decideBid({...state,information:undefined}),2);
 assert.equal(bot.decideBid({...state,information:{...state.information!,consistent:false}}),2);
 assert.equal(bot.decideBid({...state,information:{...state.information!,market:{medianPayment:12,p75Payment:16,samples:2}}}),2);
 assert.equal(bot.decideBid({...state,tilesRemaining:50}),2);
});
test('the last award is unusable while a last-usable own completion spends terminal cash',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['AT']),base),state=context('A','E',{letter:'T'});
 assert.equal(bot.decideBid(state),60);assert.equal(bot.decideBid({...state,tilesRemaining:0}),0);
});
test('known exact rival hands support a provable terminal denial without an own word',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['QUIET','QUIETS']),base),state=context('','E',{letter:'S',myScore:110});
 const hand=rack('QUIET'),info=state.information!;info.opponents=[{botId:'p',rackSize:5,initialMinimum:hand,rackMinimum:hand,rackMaximum:hand,rackMean:hand}];
 (info.samples[0]!.opponentRacks as Map<string,Rack>).set('p',hand);state.opponents=[{botId:'p',balance:30,score:80}];
 assert.equal(bot.decideBid(state),60);
 assert.equal(bot.decideBid({...state,myScore:160}),2);
});
test('a decisive small late completion can change the exact known standing',()=>{
 const bot=new ReinvestmentBot(new WordEngine(['AT']),base),state=context('A','EEE',{letter:'T',myScore:80,myBalance:30,auctionType:'FirstPrice',opponents:[{botId:'p',balance:20,score:81}]});
 assert.equal(bot.decideBid(state),19);
 assert.equal(bot.explainReinvestmentDecision(state).ownGain,2);
 const awarded={...state,myRack:rack('AT'),myBalance:11,tilesRemaining:2,letter:'E'};
 assert.equal(bot.decideBid(awarded),0);assert.equal(bot.chooseWord(awarded),'AT');
});
test('normalization rejects unsupported profile shapes and preserves explicit defaults',()=>{
 assert.deepEqual(normalizedReinvestmentOptions({}),{strength:'balanced',closingTiles:36,mode:'both'});
 assert.throws(()=>normalizedReinvestmentOptions({closingTiles:69}),/options/);
 assert.throws(()=>normalizedReinvestmentOptions({strength:'other' as 'balanced'}),/options/);
 assert.throws(()=>normalizedReinvestmentOptions({strength:'balanced',unknown:true} as {}),/options/);
 assert.throws(()=>normalizedReinvestmentOptions({mode:'other' as 'both'}),/options/);
});
