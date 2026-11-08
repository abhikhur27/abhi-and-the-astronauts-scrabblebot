import test from 'node:test';
import assert from 'node:assert/strict';
import { WordEngine } from '../src/engine.js';
import { MathBot as V2 } from '../src/math-v2.js';
import { CoordinatedBot } from '../src/coordinated-policy.js';
import { LearningBot,createModel } from '../src/model.js';
import { simulateMatch } from '../src/simulator.js';
import type { DecisionContext } from '../src/types.js';
const engine=new WordEngine(['WORN','DROWN','AD']);
const ctx:DecisionContext={myRack:new Map([['N',1],['O',1],['R',1],['W',1]]),myBalance:36,myScore:84,tilesRemaining:9,letter:'D',auctionType:'Vickrey',committedBid:21};
test('the actually committed purchase protects DROWN from an incompatible WORN cashout',()=>{
 const base=new V2(engine),bot=new CoordinatedBot(engine,base);
 assert.equal(base.chooseWord(ctx),'WORN');assert.equal(bot.chooseWord(ctx),null);
 assert.equal(bot.chooseWord({...ctx,committedBid:0}),'WORN');
 assert.equal(bot.chooseWord({...ctx,tilesRemaining:0}),'WORN');
});
test('after settlement the coordinated policy redeems the completed word from actual rack state',()=>{
 const bot=new CoordinatedBot(engine,new V2(engine));
 const awarded={...ctx,myRack:new Map([...ctx.myRack,['D',1] as [string,number]]),myBalance:16,tilesRemaining:8,letter:'E',committedBid:0};
 assert.equal(bot.chooseWord(awarded),'DROWN');
});
test('the learner sees the coordinated anchor before recording any word action',()=>{
 const bot=new LearningBot(engine,createModel(),{training:true,allowDeviations:false,anchorPolicy:new CoordinatedBot(engine,new V2(engine))});
 assert.equal(bot.chooseWord(ctx),null);
});
const terminalContext=(overrides:Partial<DecisionContext>={}):DecisionContext=>({myRack:new Map(),myBalance:60,myScore:11,tilesRemaining:1,letter:'T',auctionType:'Vickrey',opponents:[{botId:'18',balance:30,score:9,isSimulated:false}],...overrides});
test('otherwise unusable cash denies the last redeemable offer against verified external rivals',()=>{
 const words=new WordEngine(['QI','AT']),base=new V2(words),bot=new CoordinatedBot(words,base);
 const state=terminalContext();assert.equal(base.decideBid(state),0);assert.equal(bot.decideBid(state),60);
 assert.equal(bot.decideBid({...state,auctionType:'FirstPrice'}),60);
});
test('unknown or internal rivals preserve cash for an unmodeled final award instead of invoking the terminal guard',()=>{
 const words=new WordEngine(['AT']),bot=new CoordinatedBot(words,new V2(words)),state=terminalContext();
 for(const opponents of [undefined,[],[{botId:'18',balance:30,score:9}],[{botId:'18',balance:30,score:9,isSimulated:true}],[{botId:'18',balance:30,score:9,isSimulated:false},{botId:'19',balance:30,score:9}]]){
  assert.equal(bot.decideBid({...state,opponents}),0);
 }
});
test('the terminal guard never spends early, on the final unusable award, or with invalid cash',()=>{
 const words=new WordEngine(['AT']),bot=new CoordinatedBot(words,new V2(words)),state=terminalContext();
 assert.equal(bot.decideBid({...state,tilesRemaining:0}),0);
 assert.equal(bot.decideBid({...state,tilesRemaining:2}),2);
 for(const myBalance of [0,-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(bot.decideBid({...state,myBalance}),0);
});
test('existing words and profitable offered completions retain the delegated bid decision',()=>{
 const words=new WordEngine(['AT']),base={decideBid:()=>3,chooseWord:()=>null},bot=new CoordinatedBot(words,base),state=terminalContext();
 assert.equal(bot.decideBid({...state,myRack:new Map([['A',1],['T',1]]),letter:'Q'}),3);
 assert.equal(bot.decideBid({...state,myRack:new Map([['A',1]])}),3);
});
test('malformed offered letters or rack counts cannot enable the terminal cash guard',()=>{
 const bot=new CoordinatedBot(new WordEngine(['AT']),{decideBid:()=>0,chooseWord:()=>null}),state=terminalContext();
 assert.equal(bot.decideBid({...state,letter:'t'}),0);
 assert.equal(bot.decideBid({...state,myRack:new Map([['A',.5]])}),0);
 assert.equal(bot.decideBid({...state,myRack:new Map([['A',-1]])}),0);
});
test('terminal denial after a confirmed cashout converts the tied QI versus AX and AT fixture into a win',()=>{
 const words=new WordEngine(['QI','AX','AT']);
 const rival={decideBid:()=>1,chooseWord:(state:DecisionContext)=>words.playable(state.myRack)[0]?.word??null};
 const run=(coordinated:boolean)=>simulateMatch({engine:words,policies:[coordinated?new CoordinatedBot(words,new V2(words)):new V2(words),rival],seed:42,startingRacks:['QI','AAX'],bag:['T','E']});
 const before=run(false),after=run(true);
 assert.deepEqual(before.players.map(p=>p.score),[11,11]);
 assert.deepEqual(after.players.map(p=>p.score),[11,9]);
 assert.deepEqual(after.players[0]!.words,['QI']);
});
test('terminal diagnostic describes only the actual bid context and clears across lifecycle or a later base decision',()=>{
 const words=new WordEngine(['AT']),bot=new CoordinatedBot(words,new V2(words)),state=terminalContext();
 bot.decideBid(state);
 assert.deepEqual(bot.terminalCashGuardFor?.(state),{reason:'terminal-cash-denial',baseBid:0,bid:60});
 assert.equal(bot.terminalCashGuardFor({...state}),null);
 bot.decideBid({...state,tilesRemaining:0});assert.equal(bot.terminalCashGuardFor(state),null);
 bot.decideBid(state);bot.beginEpisode();assert.equal(bot.terminalCashGuardFor(state),null);
 bot.decideBid(state);bot.finishEpisode(11);assert.equal(bot.terminalCashGuardFor(state),null);
});
