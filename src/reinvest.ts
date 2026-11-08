import { BAG_COUNTS,canSpell,withTile,wordReward,type WordEngine,type AcquisitionSupply } from './engine.js';
import { explainCommittedWord } from './action-coordination.js';
import type { BotPolicy, DecisionContext,Rack,PublicInformation,BeliefSample } from './types.js';
export const REINVEST_POLICY_VERSION='v2-value-guard';
export interface ReinvestmentOptions { strength?:'balanced'|'aggressive'; closingTiles?:number; mode?:'both'|'completions'|'rebuild'; }
export function normalizedReinvestmentOptions(options:ReinvestmentOptions={}):Required<ReinvestmentOptions>{
 if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Invalid reinvestment options');
 const strength=options.strength??'balanced',closingTiles=options.closingTiles??36,mode=options.mode??'both';
 if(Object.keys(options).some(k=>!['strength','closingTiles','mode'].includes(k))||!['balanced','aggressive'].includes(strength)||!['both','completions','rebuild'].includes(mode)||!Number.isSafeInteger(closingTiles)||closingTiles<1||closingTiles>68)throw new Error('Invalid reinvestment options');
 return {strength,closingTiles,mode};
}
export interface ReinvestmentDecision {
 bid:number;baseBid:number;reason:string;ownGain:number;reserve:number|null;
 cashoutWord:string|null;cashoutProceeds:number;reserveAfterPurchase:number|null;
 marketTarget:number|null;futurePurchases:number;optionBefore:number|null;optionAfter:number|null;
 optionGain:number|null;scenarios:number;duplicateDiscount:number;cashShadow:number|null;requiredOptionGain:number|null;
}
const keyOf=(rack:Rack)=>[...rack].filter(([,n])=>n>0).sort(([a],[b])=>a.localeCompare(b)).map(([c,n])=>`${c}${n}`).join('');
const size=(rack:Rack)=>[...rack.values()].reduce((n,c)=>n+c,0);
const validRack=(rack:Rack)=>[...rack].every(([c,n])=>/^[A-Z]$/.test(c)&&Number.isSafeInteger(n)&&n>=0);
const cash=(n:number)=>Number.isFinite(n)?Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(n))):0;
const clip=(n:number,balance:number)=>Number.isFinite(n)?Math.max(0,Math.min(balance,Math.floor(n))):0;
const share=(own:number,others:number[])=>{const top=Math.max(own,...others);return own===top?1/(1+others.filter(n=>n===top).length):0;};
export class ReinvestmentBot implements BotPolicy {
 readonly options:Required<ReinvestmentOptions>;
 private readonly informationIds=new WeakMap<PublicInformation,number>();
 private informationSequence=0;
 private lastKey='';private lastDecision?:ReinvestmentDecision;
 private promises:{remaining:number;word:string;rackKey:string;reserve:number}[]=[];
 constructor(private readonly engine:WordEngine,readonly base:BotPolicy,options:ReinvestmentOptions={}){this.options=normalizedReinvestmentOptions(options);}
 beginEpisode():void{this.promises=[];this.lastKey='';this.lastDecision=undefined;(this.base as BotPolicy&{beginEpisode?:()=>void}).beginEpisode?.();}
 finishEpisode(score:number):void{(this.base as BotPolicy&{finishEpisode?:(value:number)=>void}).finishEpisode?.(score);this.promises=[];this.lastKey='';this.lastDecision=undefined;}
 private confirmed(ctx:DecisionContext){
  this.promises=this.promises.filter(p=>p.remaining>=ctx.tilesRemaining-1&&p.remaining<=ctx.tilesRemaining);
  const promised=this.promises.find(p=>p.remaining===ctx.tilesRemaining&&p.rackKey===keyOf(ctx.myRack)&&canSpell(p.word,ctx.myRack));
  // A Vickrey winner can pay less than our submitted cap. Its actual cash,
  // rather than that cap, determines whether the pledged refund is needed.
  if(promised&&cash(ctx.myBalance)>=promised.reserve){this.promises=this.promises.filter(p=>p!==promised);return undefined;}
  return promised;
 }
 private contextKey(ctx:DecisionContext):string{
  let id=0;if(ctx.information){id=this.informationIds.get(ctx.information)??++this.informationSequence;this.informationIds.set(ctx.information,id);}
  return JSON.stringify([keyOf(ctx.myRack),ctx.myBalance,ctx.myScore,ctx.letter,ctx.tilesRemaining,ctx.auctionType,ctx.committedBid,ctx.opponents,id]);
 }
 private physicalSamples(ctx:DecisionContext):{sample:BeliefSample;weight:number}[]{
  const info=ctx.information,rivals=ctx.opponents;
  if(!info?.consistent||!info.completeHistory||!info.knownOwnInitial||info.bagCount!==ctx.tilesRemaining||!rivals?.length||rivals.some(p=>!p.botId))return [];
  const samples=info.samples.filter(s=>{
   if(!Number.isFinite(s.weight)||s.weight<=0||!validRack(s.bag)||size(s.bag)!==ctx.tilesRemaining)return false;
   const allocated=withTile(ctx.myRack,ctx.letter);
   for(const p of rivals){const hand=s.opponentRacks.get(p.botId!),estimate=info.opponents.find(e=>e.botId===p.botId);
    if(!hand||!validRack(hand)||!estimate||size(hand)!==estimate.rackSize)return false;
    for(const [c,n] of hand)allocated.set(c,(allocated.get(c)??0)+n);
   }
   for(const [c,n] of s.bag)allocated.set(c,(allocated.get(c)??0)+n);
   return [...allocated].every(([c,n])=>n<=(BAG_COUNTS[c]??0));
  });
  const mass=samples.reduce((n,s)=>n+s.weight,0);if(!mass)return [];
  // Weighted quantiles bound work without constructing fractional legal racks.
  const count=Math.min(4,samples.length),selected=new Map<BeliefSample,number>();
  for(let i=0;i<count;i++){let cumulative=0;const threshold=(i+.5)*mass/count;
   const sample=samples.find(s=>(cumulative+=s.weight)>=threshold)??samples[samples.length-1]!;
   selected.set(sample,(selected.get(sample)??0)+1/count);
  }
  return [...selected].map(([sample,weight])=>({sample,weight}));
 }
 private terminalDenial(ctx:DecisionContext,ownValue:number):boolean{
  const info=ctx.information,rivals=ctx.opponents;
  if(!info?.consistent||!info.completeHistory||!info.knownOwnInitial||!rivals?.length||this.physicalSamples(ctx).length===0)return false;
  const hands=rivals.map(p=>info.opponents.find(e=>e.botId===p.botId));
  if(hands.some(h=>!h||keyOf(h.rackMinimum)!==keyOf(h.rackMaximum)||!validRack(h.rackMinimum)))return false;
  const before=hands.map(h=>this.engine.redemptionPlan(h!.rackMinimum));if(before.some(p=>!p.exact))return false;
  const totals=rivals.map((p,i)=>p.score+before[i]!.value),own=ctx.myScore+ownValue,standing=share(own,totals);
  if(standing===0)return false;
  return rivals.some((p,i)=>{if(cash(p.balance)<1)return false;const after=this.engine.redemptionPlan(withTile(hands[i]!.rackMinimum,ctx.letter));if(!after.exact)return false;
   const allocated=[...totals];allocated[i]=p.score+after.value;return share(own,allocated)<standing;
  });
 }
 private decisiveSmallCompletion(ctx:DecisionContext,currentValue:number,gain:number):boolean{
  if(ctx.tilesRemaining>4||gain<=0)return false;
  const info=ctx.information,rivals=ctx.opponents;if(!info||!rivals?.length||this.physicalSamples(ctx).length===0)return false;
  const totals:number[]=[];
  for(const p of rivals){
   const h=info.opponents.find(e=>e.botId===p.botId);
   if(!h||!validRack(h.rackMinimum)||keyOf(h.rackMinimum)!==keyOf(h.rackMaximum)||size(h.rackMinimum)!==h.rackSize)return false;
   const plan=this.engine.redemptionPlan(h.rackMinimum);if(!plan.exact)return false;totals.push(p.score+plan.value);
  }
  const own=ctx.myScore+currentValue;return share(own+gain,totals)>share(own,totals);
 }
 explainReinvestmentDecision(ctx:DecisionContext):ReinvestmentDecision{
  const key=this.contextKey(ctx);if(key===this.lastKey&&this.lastDecision)return {...this.lastDecision};
  const balance=cash(ctx.myBalance),baseBid=clip(this.base.decideBid(ctx),balance);
  const out:ReinvestmentDecision={bid:baseBid,baseBid,reason:'base',ownGain:0,reserve:null,cashoutWord:null,cashoutProceeds:0,reserveAfterPurchase:null,marketTarget:null,futurePurchases:0,optionBefore:null,optionAfter:null,optionGain:null,scenarios:0,duplicateDiscount:1,cashShadow:null,requiredOptionGain:null};
  const done=()=>{this.lastKey=key;this.lastDecision=out;return {...out};};
  if(!Number.isSafeInteger(ctx.tilesRemaining)||ctx.tilesRemaining<0||!validRack(ctx.myRack)||!/^[A-Z]$/.test(ctx.letter)){out.bid=0;out.reason='invalid-state';return done();}
  if(ctx.tilesRemaining===0){out.bid=0;out.reason='unredeemable-final-tile';return done();}
  const promised=this.confirmed(ctx);if(promised){out.bid=0;out.reason='funded-completion-cashout';out.cashoutWord=promised.word;out.cashoutProceeds=wordReward(promised.word);return done();}
  if(!balance||ctx.tilesRemaining>this.options.closingTiles)return done();
  const current=this.engine.redemptionPlan(ctx.myRack),afterRack=withTile(ctx.myRack,ctx.letter),after=this.engine.redemptionPlan(afterRack);
  out.ownGain=Math.max(0,after.value-current.value);
  if(ctx.tilesRemaining===1){
   if(this.options.mode!=='rebuild'){
    if(current.exact&&after.exact&&out.ownGain>0){out.bid=balance;out.reason='last-usable-own-completion';}
    else if(current.exact&&this.terminalDenial(ctx,current.value)){out.bid=balance;out.reason='last-usable-proven-denial';}
   }
   return done();
  }
  const info=ctx.information,market=info?.market,samples=this.physicalSamples(ctx);out.scenarios=samples.length;
  if(!samples.length||!market||!Number.isSafeInteger(market.samples)||market.samples<3||!Number.isFinite(market.medianPayment)||market.medianPayment<=0||!Number.isFinite(market.p75Payment)||market.p75Payment<market.medianPayment)return done();
  const median=market.medianPayment,p75=market.p75Payment,players=Math.max(2,(ctx.opponents?.length??5)+1);
  // This is a budgeting heuristic, not a promise to win an equal share of offers.
  const opportunities=Math.max(0,(ctx.tilesRemaining-1)/players);
  const minimumGain=this.options.strength==='aggressive'?5:8;
  const decisiveSmall=this.options.mode!=='rebuild'&&current.exact&&after.exact&&this.decisiveSmallCompletion(ctx,current.value,out.ownGain);
  if(this.options.mode!=='rebuild'&&current.exact&&after.exact&&(out.ownGain>=minimumGain||decisiveSmall)&&after.firstWord&&!canSpell(after.firstWord,ctx.myRack)){
   const proceeds=wordReward(after.firstWord),reserve=Math.min(balance+proceeds,Math.max(8,median*opportunities));
   const cap=clip(balance+proceeds-reserve,balance);
   const target=ctx.auctionType==='FirstPrice'&&this.options.strength==='balanced'?Math.ceil(p75+1+out.ownGain):cap;
   out.reserve=reserve;out.futurePurchases=opportunities;out.marketTarget=target;
   const amount=Math.max(baseBid,Math.min(cap,target));
   if(amount>baseBid&&amount>=median){
    out.bid=amount;out.reason='funded-own-completion';out.cashoutWord=after.firstWord;out.cashoutProceeds=proceeds;out.reserveAfterPurchase=balance-amount+proceeds;
    const promise={remaining:ctx.tilesRemaining-1,word:after.firstWord,rackKey:keyOf(afterRack),reserve};
    const prior=this.promises.findIndex(p=>p.remaining===promise.remaining&&p.word===promise.word&&p.rackKey===promise.rackKey);
    if(prior<0)this.promises.push(promise);else this.promises[prior]=promise;
   }
   return done();
  }
  if(this.options.mode==='completions'||size(ctx.myRack)>=5||ctx.tilesRemaining<=4)return done();
  const duplicate=ctx.myRack.get(ctx.letter)??0,discount=1/(1+.75*duplicate);out.duplicateDiscount=discount;
  const target=Math.ceil(((this.options.strength==='aggressive'?p75:median)+1)*discount);
  // Rebuilding cannot borrow a hoped-for word payout. Two further median-price
  // acquisitions remain funded even if the current tile costs our entire bid.
  const reserve=2*median,cap=clip(balance-reserve,balance);out.reserve=reserve;out.marketTarget=target;
  if(target<=baseBid||target>cap)return done();
  const draws=Math.min(opportunities,Math.floor((balance-target)/median));out.futurePurchases=draws;if(draws<1)return done();
  const supplies:AcquisitionSupply[]=samples.map(({sample,weight})=>({weight,bag:sample.bag,draws}));
  const horizon=Math.max(0,ctx.tilesRemaining-1);
  out.optionBefore=this.engine.potential(ctx.myRack,horizon,supplies);out.optionAfter=this.engine.potential(afterRack,horizon,supplies);
  out.optionGain=out.optionAfter-out.optionBefore;
  const aggressive=this.options.strength==='aggressive',absoluteFloor=aggressive?.1:.25,kappa=aggressive?.33:.5;
  out.cashShadow=5*Math.min(opportunities,balance/median)/Math.max(1,balance);
  out.requiredOptionGain=Math.max(absoluteFloor,kappa*target*out.cashShadow);
  if(out.optionGain>=out.requiredOptionGain&&out.optionAfter>after.value){out.bid=target;out.reason='finite-supply-rebuild';out.reserveAfterPurchase=balance-target;}
  return done();
 }
 decideBid(ctx:DecisionContext):number{return this.explainReinvestmentDecision(ctx).bid;}
 chooseWord(ctx:DecisionContext):string|null{
  const promised=this.confirmed(ctx);if(promised)return promised.word;
  const word=this.base.chooseWord(ctx);if(!word)return null;
  return explainCommittedWord(this.engine,ctx,word,ctx.committedBid??0).defer?null:word;
 }
}
