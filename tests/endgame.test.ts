import test from 'node:test';
import assert from 'node:assert/strict';
import { WordEngine } from '../src/engine.js';
import { EndgameBot } from '../src/endgame.js';
import { MathBot as MathV2 } from '../src/math-v2.js';
import type { BotPolicy, DecisionContext, PublicInformation, Rack } from '../src/types.js';

const rack=(letters:string):Map<string,number>=>{const r=new Map<string,number>();for(const l of letters)r.set(l,(r.get(l)??0)+1);return r;};
const base:BotPolicy={decideBid:()=>0,chooseWord:()=>null};
function ctx(letters:string, overrides:Partial<DecisionContext>={}):DecisionContext {
 return {myRack:rack(letters),myBalance:80,myScore:100,tilesRemaining:1,auctionType:'Vickrey',letter:'S',opponents:[{botId:'p',balance:30,score:80}],...overrides};
}
function info(remaining:number, opponent:string, weight=1):PublicInformation {
 const bag=rack('E'.repeat(remaining)),hand=rack(opponent);
 return {consistent:true,completeHistory:true,knownOwnInitial:true,bagCount:remaining,observedAuctionCount:68-remaining,expectedBag:bag,bagMinimum:bag,bagMaximum:bag,
  opponents:[{botId:'p',rackSize:opponent.length,initialMinimum:new Map(),rackMinimum:hand,rackMaximum:hand,rackMean:hand}],samples:[{weight,bag,opponentRacks:new Map([['p',hand]])}],effectiveSampleSize:1,market:{medianPayment:12,p75Payment:16,samples:20}};
}
test('a leader spends terminal cash to block a pivotal rival despite no own tile gain',()=>{
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS']),base);
 const state=ctx('',{myScore:110,opponents:[{botId:'p',balance:30,score:80}],information:info(1,'QUIET')});
 assert.equal(bot.decideBid(state),80);
 const explanation=bot.explainEndgameDecision(state);
 assert.equal(explanation.ownGain,0);
 assert.equal(explanation.blockWinDelta,1);
 assert.deepEqual(explanation.pivotalBots,['p']);
});
test('the same hand and cash do not buy a tile for an irrelevant trailing opponent',()=>{
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS']),base);
 const state=ctx('',{myScore:160,opponents:[{botId:'p',balance:30,score:20}],information:info(1,'QUIET')});
 assert.equal(bot.decideBid(state),0);
 assert.equal(bot.explainEndgameDecision(state).blockWinDelta,0);
 assert.equal(bot.explainEndgameDecision(state).opponentLockedScore,48);
});
test('a trailing player funds a winning completion without treating the loose recovery upper bound as certainty',()=>{
 const bot=new EndgameBot(new WordEngine(['QI']),base);
 const state=ctx('Q',{myScore:100,letter:'I',tilesRemaining:2,opponents:[{botId:'p',balance:30,score:110}],information:info(2,'')});
 assert.equal(bot.decideBid(state),31);
 assert.equal(bot.explainEndgameDecision(state).acquireWinDelta,1);
 assert.equal(bot.explainEndgameDecision(state).forcedWinDelta,0);
});

test('thirty remaining offers reserve the full expected purchase horizon using actual cashout proceeds',()=>{
 const engine=new WordEngine(['WORN','FROWN','HO']),bot=new EndgameBot(engine,base,{closingTiles:30});
 const belief=info(30,'HO'),future=rack('E'.repeat(12)+'A'.repeat(9)+'I'.repeat(9));
 belief.expectedBag=future;belief.bagMinimum=future;belief.bagMaximum=future;belief.samples[0]!.bag=future;
 const opponents=[{botId:'p',balance:150,score:96},...['q','r','s','t'].map(botId=>({botId,balance:10,score:20}))];
 for(const rival of opponents.slice(1)){belief.opponents=[...belief.opponents,{botId:rival.botId,rackSize:0,initialMinimum:new Map(),rackMinimum:new Map(),rackMaximum:new Map(),rackMean:new Map()}];(belief.samples[0]!.opponentRacks as Map<string,Rack>).set(rival.botId,new Map());}
 const state=ctx('NORW',{myScore:84,myBalance:100,tilesRemaining:30,letter:'F',opponents,information:belief});
 for(const auctionType of ['Vickrey','FirstPrice'] as const){
  bot.beginEpisode();
  const decision=bot.explainEndgameDecision({...state,auctionType});
  assert.equal(decision.bid,64);assert.equal(decision.cashoutProceeds,22);assert.equal(decision.reserveAfterPurchase,58);
  assert.equal(state.myBalance-decision.bid+decision.cashoutProceeds,58);
  assert.ok(decision.bid<=state.myBalance);
  const awarded={...state,auctionType,myRack:rack('FROWN'),myBalance:36,tilesRemaining:29,letter:'A'};
  assert.equal(bot.decideBid(awarded),0);assert.equal(bot.chooseWord(awarded),'FROWN');
 }
 // An expensive observed market cannot manufacture capital beyond cash plus
 // the exact word. A reserve that uses all42 leaves no new discretionary bid.
 const scarce={...state,myBalance:20,information:{...belief,market:{medianPayment:100,p75Payment:120,samples:20}}};
 bot.beginEpisode();assert.equal(bot.decideBid(scarce),0);
 const anchored=new EndgameBot(engine,{decideBid:()=>8,chooseWord:()=>null},{closingTiles:30});
 assert.equal(anchored.decideBid(scarce),8);
});
test('an exact rank-changing FROWN completion uses post-redemption capital instead of the old spend cap',()=>{
 const engine=new WordEngine(['WORN','FROWN','FROWNS','HO','AD','AS']),anchor=new MathV2(engine),bot=new EndgameBot(engine,anchor,{closingTiles:18});
 const belief=info(13,'HO'),future=rack('F'+'E'.repeat(12));
 belief.expectedBag=future;belief.bagMinimum=future;belief.bagMaximum=future;belief.samples[0]!.bag=future;
 const opponents=[{botId:'p',balance:50,score:96},...['q','r','s','t'].map(botId=>({botId,balance:10,score:20}))];
 for(const rival of opponents.slice(1)){belief.opponents=[...belief.opponents,{botId:rival.botId,rackSize:0,initialMinimum:new Map(),rackMinimum:new Map(),rackMaximum:new Map(),rackMean:new Map()}];(belief.samples[0]!.opponentRacks as Map<string,Rack>).set(rival.botId,new Map());}
 const state=ctx('NORW',{myScore:84,myBalance:36,tilesRemaining:13,letter:'F',opponents,information:belief});
 assert.equal(anchor.decideBid(state),21);
 assert.equal(bot.decideBid(state),34);
 const explanation=bot.explainEndgameDecision(state);
 assert.equal(explanation.acquireWinDelta,1);assert.equal(explanation.forcedWinDelta,0);
 assert.equal(explanation.cashoutWord,'FROWN');assert.equal(explanation.cashoutProceeds,22);assert.equal(explanation.reserveAfterPurchase,24);
 assert.equal(bot.chooseWord({...state,myRack:rack('NORWF'),myBalance:2,tilesRemaining:12,letter:'E'}),'FROWN');
 assert.ok(bot.decideBid({...state,auctionType:'FirstPrice'})>=33);
 // The refund is an action commitment, even if the underlying policy holds.
 const holding=new EndgameBot(engine,{decideBid:state=>anchor.decideBid(state),chooseWord:()=>null},{closingTiles:18});
 assert.equal(holding.decideBid(state),34);
 assert.equal(holding.chooseWord({...state,committedBid:34}),null);
 const funded={...state,myRack:rack('NORWF'),myBalance:32,tilesRemaining:12,letter:'S',information:info(12,'HO'),committedBid:1};
 assert.equal(holding.decideBid(funded),0);
 assert.equal(holding.explainEndgameDecision(funded).reason,'funded-completion-cashout');
 assert.equal(holding.chooseWord(funded),'FROWN');
 const afterCashout={...funded,myRack:new Map(),myBalance:54,myScore:106,committedBid:0};
 assert.ok(anchor.decideBid(afterCashout)>0);
 assert.equal(holding.decideBid(afterCashout),anchor.decideBid(afterCashout));
 holding.beginEpisode();
 assert.equal(holding.chooseWord({...state,myRack:rack('NORWF'),myBalance:32,tilesRemaining:12,letter:'E'}),null);
});
test('cached explanation does not repeat a base action and changed rival scores invalidate it',()=>{
 let decisions=0;const policy:BotPolicy={decideBid:()=>{decisions++;return 0;},chooseWord:()=>null};
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS']),policy),belief=info(1,'QUIET');
 const state=ctx('',{myScore:110,information:belief});
 assert.equal(bot.decideBid(state),80);bot.explainEndgameDecision(state);assert.equal(decisions,1);
 assert.equal(bot.decideBid({...state,opponents:[{botId:'p',balance:30,score:20}]}),0);assert.equal(decisions,2);
});

test('a profitable completion can fund critical defense while already leading the locked scores',()=>{
 const bot=new EndgameBot(new WordEngine(['AS','QUIET','QUIETS','EE']),base);
 const state=ctx('A',{tilesRemaining:8,myScore:110,opponents:[{botId:'p',balance:70,score:80}],information:info(8,'QUIET')});
 const explanation=bot.explainEndgameDecision(state);
 assert.equal(explanation.acquireWinDelta,0);assert.equal(explanation.blockWinDelta,1);assert.equal(explanation.forcedWinDelta,0);
 assert.equal(explanation.bid,40);assert.equal(explanation.reason,'refund-backed-rank-completion');
 assert.equal(explanation.cashoutProceeds,2);assert.equal(explanation.reserveAfterPurchase,42);
});
test('already-lost scenarios do not masquerade as pivotal denial opportunities',()=>{
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS']),base);
 assert.equal(bot.decideBid(ctx('',{myScore:80,opponents:[{botId:'p',balance:30,score:80}],information:info(1,'QUIET')})),0);
});
test('last usable own completion spends cash and the unredeemable final tile is skipped',()=>{
 const bot=new EndgameBot(new WordEngine(['QI']),base);
 assert.equal(bot.decideBid(ctx('Q',{myScore:0,letter:'I',tilesRemaining:1,myBalance:31})),31);
 assert.equal(bot.decideBid(ctx('Q',{myScore:0,letter:'I',tilesRemaining:0,myBalance:31})),0);
});
test('earlier defense preserves working cash unless losing the tile is irrecoverable',()=>{
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS','EE']),base);
 const early=ctx('',{tilesRemaining:8,myScore:110,information:info(8,'QUIET')});
 const bid=bot.decideBid(early);
 assert.ok(bid>0&&bid<80,`paced defensive bid ${bid}`);
 const late=ctx('',{tilesRemaining:2,myScore:110,information:info(2,'QUIET')});
 assert.equal(bot.decideBid(late),80);
});
test('uncertain scenarios are weighted and fractional means never become a legal hand',()=>{
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS']),base);
 const belief=info(1,'QUIET');
 belief.opponents[0]!.rackMean=rack('QUIET');
 belief.samples=[{weight:.05,bag:rack('E'),opponentRacks:new Map([['p',rack('QUIET')]])},{weight:.95,bag:rack('E'),opponentRacks:new Map([['p',rack('AEIOU')]])}];
 const state=ctx('',{myScore:110,information:belief});
 assert.equal(bot.decideBid(state),0);
 assert.ok(bot.explainEndgameDecision(state).blockWinDelta<.15);
});
test('incomplete or inconsistent information cannot invent a defensive purchase',()=>{
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS']),base);
 const belief=info(1,'QUIET');belief.consistent=false;
 assert.equal(bot.decideBid(ctx('',{myScore:110,information:belief})),0);
});

test('scenario validation rejects fractional, oversized and physically duplicated tile allocations',()=>{
 const bot=new EndgameBot(new WordEngine(['QUIET','QUIETS']),base);
 for(const corrupt of ['fractional','bag-size','duplicate-Q']){
  const belief=info(1,'QUIET');
  if(corrupt==='fractional')belief.samples[0]!.opponentRacks=new Map([['p',new Map([['Q',1],['U',1],['I',1],['E',.5],['T',1.5]])]]);
  if(corrupt==='bag-size')belief.samples[0]!.bag=rack('EE');
  const state=ctx(corrupt==='duplicate-Q'?'Q':'',{myScore:110,information:belief});
  assert.equal(bot.decideBid(state),0,corrupt);
  assert.equal(bot.explainEndgameDecision(state).scenarios,0,corrupt);
 }
});
test('late packing redeems disjoint words and never waits through the final close',()=>{
 const bot=new EndgameBot(new WordEngine(['QI','AT','QAT']),base);
 assert.equal(bot.chooseWord(ctx('QATI',{tilesRemaining:0,letter:'Z'})),'QI');
 assert.equal(bot.chooseWord(ctx('QATI',{tilesRemaining:3,letter:'Z'})),'QI');
});
test('only an actual committed bid can keep a short word for the offered completion',()=>{
 const bot=new EndgameBot(new WordEngine(['CAT','CATS']),{decideBid:()=>0,chooseWord:()=> 'CAT'});
 assert.equal(bot.chooseWord(Object.assign(ctx('CAT',{tilesRemaining:1,letter:'S'}),{committedBid:20})),null);
 assert.equal(bot.chooseWord(ctx('CAT',{tilesRemaining:1,letter:'S'})),'CAT');
 assert.equal(bot.chooseWord(ctx('CAT',{tilesRemaining:0,letter:'S'})),'CAT');
 assert.equal(bot.chooseWord(ctx('CATS',{tilesRemaining:0,letter:'E'})),'CATS');
 assert.equal(bot.chooseWord(ctx('CAT',{tilesRemaining:1,letter:'S',myBalance:0})),'CAT');
});

test('closing word protection respects the shared coordinator commitment credibility and liquidity rules',()=>{
 const bot=new EndgameBot(new WordEngine(['CAT','CATS']),{decideBid:()=>0,chooseWord:()=> 'CAT'});
 assert.equal(bot.chooseWord(ctx('CAT',{tilesRemaining:1,letter:'S',committedBid:1,information:info(1,'')})),'CAT');
 assert.equal(bot.chooseWord(ctx('CAT',{tilesRemaining:1,letter:'S',committedBid:1,myBalance:3})),'CAT');
 assert.equal(bot.chooseWord(ctx('CAT',{tilesRemaining:1,letter:'S',committedBid:20,information:info(1,'')})),null);
});
test('the WORN cashout cannot destroy an actually committed DROWN purchase at nine tiles',()=>{
 const bot=new EndgameBot(new WordEngine(['WORN','DROWN','AD']),{decideBid:()=>21,chooseWord:()=> 'WORN'});
 const state=Object.assign(ctx('NORW',{tilesRemaining:9,letter:'D',myBalance:36}),{committedBid:21});
 assert.equal(bot.chooseWord(state),null);
 assert.equal(bot.chooseWord(Object.assign({},state,{committedBid:0})),'WORN');
});
test('a committed eight-letter completion is protected and the final close still forces cashout',()=>{
 const bot=new EndgameBot(new WordEngine(['RETAINS','TRAINEES']),{decideBid:()=>20,chooseWord:()=> 'RETAINS'});
 const state=Object.assign(ctx('RETAINS',{tilesRemaining:1,letter:'E'}),{committedBid:20});
 assert.equal(bot.chooseWord(state),null);
 assert.equal(bot.chooseWord({...state,tilesRemaining:0}),'RETAINS');
 assert.equal(bot.chooseWord(Object.assign({},state,{committedBid:0})),'RETAINS');
});
test('bids stay affordable integers and observations remain unchanged',()=>{
 const bot=new EndgameBot(new WordEngine(['QI','QUIET','QUIETS']),base);
 const state=ctx('Q',{letter:'I',tilesRemaining:1});const before=[...state.myRack];
 for(const balance of [-1,0,.5,1,3.9,100,NaN,Infinity]){const bid=bot.decideBid({...state,myBalance:balance});assert.ok(Number.isSafeInteger(bid)&&bid>=0&&bid<=(Number.isFinite(balance)?Math.max(0,Math.floor(balance)):0));}
 bot.chooseWord(state);assert.deepEqual([...state.myRack],before);
});
test('endgame logic leaves the early policy untouched',()=>{
 const policy:BotPolicy={decideBid:()=>7,chooseWord:()=> 'AT'};
 const bot=new EndgameBot(new WordEngine(['AT']),policy);
 const state=ctx('AT',{tilesRemaining:30});assert.equal(bot.decideBid(state),7);assert.equal(bot.chooseWord(state),'AT');
});
