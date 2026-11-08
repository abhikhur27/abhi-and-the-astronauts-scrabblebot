import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {WordEngine,canSpell,withoutWord,wordReward} from '../src/engine.js';
import {EndgameBot} from '../src/endgame.js';
import {ReinvestmentBot} from '../src/reinvest.js';
import type {DecisionContext,Rack} from '../src/types.js';

const rack=(letters:string)=>{const counts=new Map<string,number>();for(const letter of letters)counts.set(letter,(counts.get(letter)??0)+1);return counts;};
const dictionary=readFileSync(new URL('../data/enable1.txt',import.meta.url),'utf8').split(/\r?\n/);

test('opt-in exact packing finds the audited disjoint words without changing baseline planning',()=>{
 const engine=new WordEngine(dictionary),before=rack('ACILRSTW'),after=rack('ACILRSTWY');
 assert.equal(typeof engine.exactRedemptionPlan,'function');
 assert.deepEqual(engine.redemptionPlan(before),{value:27,firstWord:'CITRALS',exact:false});
 assert.deepEqual(engine.redemptionPlan(after),{value:45,firstWord:'SCRAWLY',exact:false});
 assert.deepEqual(engine.exactRedemptionPlan(before),{value:29,firstWord:'CRAWLS',exact:true});
 assert.deepEqual(engine.exactRedemptionPlan(after),{value:47,firstWord:'SCRAWLY',exact:true});
 assert.equal(engine.exactRedemptionPlan(withoutWord(after,'SCRAWLY')).firstWord,'IT');
 // Opting in does not replace the legacy planner's separate cache.
 assert.equal(engine.redemptionPlan(before).value,27);
 assert.equal(engine.redemptionPlan(after).value,45);
});

test('exact small-rack packing agrees with exhaustive whole-word search and permits unused tiles',()=>{
 const words=['AT','TA','AA','AB','BA','BAT','TAB','BATS','STAB','AS','SAT','TAT','TT','BBB'];
 const engine=new WordEngine(words);
 const brute=(hand:Rack):number=>{
  let best=0;for(const word of words)if(canSpell(word,hand))best=Math.max(best,wordReward(word)+brute(withoutWord(hand,word)));
  return best;
 };
 for(let a=0;a<=3;a++)for(let b=0;b<=2;b++)for(let t=0;t<=2;t++)for(let s=0;s<=1;s++){
  const hand=rack('A'.repeat(a)+'B'.repeat(b)+'T'.repeat(t)+'S'.repeat(s)+'Q');
  const plan=engine.exactRedemptionPlan(hand);
  assert.equal(plan.exact,true);assert.equal(plan.value,brute(hand),JSON.stringify([...hand]));
  if(plan.firstWord){assert.ok(canSpell(plan.firstWord,hand));assert.equal(plan.value,wordReward(plan.firstWord)+brute(withoutWord(hand,plan.firstWord)));}
 }
 assert.equal(engine.exactRedemptionPlan(rack('ATAT')).value,4);
 assert.deepEqual(engine.exactRedemptionPlan(new Map()),{value:0,firstWord:null,exact:true});
});

test('exact-plan caching preserves caller inventory, independent results and its physical scope',()=>{
 const engine=new WordEngine(['QI','AT','QAT','ZZ']),hand=rack('QATI'),before=[...hand];
 const result=engine.exactRedemptionPlan(hand);result.value=-1;result.firstWord='ZZ';
 assert.deepEqual(engine.exactRedemptionPlan(new Map([...hand].reverse())),{value:13,firstWord:'QI',exact:true});
 assert.deepEqual([...hand],before);
 for(const invalid of [new Map([['A',1.5],['T',1]]),new Map([['?',1],['A',1],['T',1]]),rack('ZZZ'),rack('AAAAAAAAATT')]){
  const old=engine.redemptionPlan(invalid),fallback=engine.exactRedemptionPlan(invalid);
  assert.deepEqual(fallback,{...old,exact:false});
 }
});

test('candidate own-hand valuation uses exact packing while its base policy stays unchanged',()=>{
 const engine=new WordEngine(dictionary),base={decideBid:()=>1,chooseWord:()=>null};
 const state:DecisionContext={myRack:rack('ACILRSTW'),myBalance:41,myScore:57,tilesRemaining:1,letter:'Y',auctionType:'Vickrey'};
 const endgame=new EndgameBot(engine,base),reinvestment=new ReinvestmentBot(engine,base);
 assert.equal(endgame.explainEndgameDecision(state).ownLockedScore,86);
 assert.equal(endgame.explainEndgameDecision(state).ownGain,18);
 assert.equal(reinvestment.explainReinvestmentDecision(state).ownGain,18);
 assert.equal(reinvestment.decideBid(state),41);
 assert.equal(endgame.chooseWord({...state,myRack:rack('ACILRSTWY'),tilesRemaining:0}),'SCRAWLY');
 assert.equal(base.chooseWord(),null);
});

test('candidate cashout coordination protects the exact multiword purchase while the offer is outstanding',()=>{
 const engine=new WordEngine(dictionary),base={decideBid:()=>30,chooseWord:()=>'CITRALS'};
 const state:DecisionContext={myRack:rack('ACILRSTW'),myBalance:41,myScore:57,tilesRemaining:26,letter:'Y',auctionType:'Vickrey',committedBid:30};
 const endgame=new EndgameBot(engine,base,{closingTiles:30}),reinvestment=new ReinvestmentBot(engine,base);
 assert.equal(endgame.chooseWord(state),null);
 assert.equal(reinvestment.chooseWord(state),null);
 assert.equal(base.chooseWord(),'CITRALS');
 assert.equal(endgame.chooseWord({...state,committedBid:0}),'CITRALS');
 assert.equal(reinvestment.chooseWord({...state,committedBid:0}),'CITRALS');
});
