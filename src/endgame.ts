import { BAG_COUNTS,LETTER_VALUES,canSpell,withTile,wordReward,type WordEngine } from './engine.js';
import { explainCommittedWord } from './action-coordination.js';
import type { BotPolicy,DecisionContext,PublicInformation,Rack,BeliefSample } from './types.js';

export const ENDGAME_POLICY_VERSION='v3-exact-packing';
export interface EndgameOptions {closingTiles?:number;liquidationTiles?:number;maxScenarios?:number;minimumWinDelta?:number;}
export interface EndgameDecision {
 bid:number;baseBid:number;ownGain:number;ownLockedScore:number;opponentLockedScore:number|null;
 projectedLead:number|null;blockWinDelta:number;acquireWinDelta:number;forcedWinDelta:number;
 pivotalBots:string[];reason:string;scenarios:number;
 cashoutWord:string|null;cashoutProceeds:number;reserveAfterPurchase:number|null;
}
const size=(rack:Rack)=>[...rack.values()].reduce((n,c)=>n+c,0);
const keyOf=(rack:Rack)=>[...rack].filter(([,c])=>c>0).sort(([a],[b])=>a.localeCompare(b)).map(([l,c])=>`${l}${c}`).join('');
const validRack=(rack:Rack)=>[...rack].every(([l,c])=>/^[A-Z]$/.test(l)&&Number.isSafeInteger(c)&&c>=0);
const cash=(value:number)=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
const clipBid=(value:number,balance:number)=>Number.isFinite(value)?Math.max(0,Math.min(balance,Math.floor(value))):0;
const faceValue=(rack:Rack)=>[...rack].reduce((n,[letter,count])=>n+(LETTER_VALUES[letter]??0)*count,0);
const winShare=(own:number,rivals:readonly number[])=>{const top=Math.max(own,...rivals);return own===top?1/(1+rivals.filter(n=>n===top).length):0;};

/** A closing adapter for an unchanged base policy, not a calibrated win model. */
export class EndgameBot implements BotPolicy {
 private readonly closingTiles:number;
 private readonly liquidationTiles:number;
 private readonly maxScenarios:number;
 private readonly minimumWinDelta:number;
 private readonly informationIds=new WeakMap<PublicInformation,number>();
 private informationSequence=0;
 private lastKey='';
 private lastDecision?:EndgameDecision;
 private pendingCashouts:{rackKey:string;remaining:number;word:string}[]=[];
 constructor(private readonly engine:WordEngine,public readonly base:BotPolicy,options:EndgameOptions={}) {
  this.closingTiles=options.closingTiles??10;this.liquidationTiles=options.liquidationTiles??Math.min(4,this.closingTiles);
  this.maxScenarios=options.maxScenarios??4;this.minimumWinDelta=options.minimumWinDelta??.15;
  if(!Number.isSafeInteger(this.closingTiles)||this.closingTiles<1||this.closingTiles>30||!Number.isSafeInteger(this.liquidationTiles)||this.liquidationTiles<0||this.liquidationTiles>this.closingTiles||!Number.isSafeInteger(this.maxScenarios)||this.maxScenarios<1||this.maxScenarios>16||!Number.isFinite(this.minimumWinDelta)||this.minimumWinDelta<=0||this.minimumWinDelta>1)throw new Error('Invalid endgame options');
 }
 beginEpisode():void {this.lastKey='';this.lastDecision=undefined;this.pendingCashouts=[];(this.base as BotPolicy&{beginEpisode?:()=>void}).beginEpisode?.();}
 finishEpisode(score:number):void {(this.base as BotPolicy&{finishEpisode?:(score:number)=>void}).finishEpisode?.(score);this.lastKey='';this.lastDecision=undefined;this.pendingCashouts=[];}
 private decisionKey(ctx:DecisionContext):string {
  let informationId=0;
  if(ctx.information){informationId=this.informationIds.get(ctx.information)??++this.informationSequence;this.informationIds.set(ctx.information,informationId);}
  return JSON.stringify([keyOf(ctx.myRack),ctx.myScore,ctx.myBalance,ctx.tilesRemaining,ctx.letter,ctx.auctionType,ctx.opponents,ctx.committedBid,informationId]);
 }
 private confirmedCashout(ctx:DecisionContext):{rackKey:string;remaining:number;word:string}|undefined {
  this.pendingCashouts=this.pendingCashouts.filter(p=>p.remaining>=ctx.tilesRemaining-1&&p.remaining<=ctx.tilesRemaining);
  return this.pendingCashouts.find(p=>p.remaining===ctx.tilesRemaining&&p.rackKey===keyOf(ctx.myRack)&&canSpell(p.word,ctx.myRack));
 }
 private scenarios(ctx:DecisionContext):{sample:BeliefSample;weight:number}[] {
  const info=ctx.information,opponents=ctx.opponents;
  if(!info?.consistent||!info.completeHistory||!info.knownOwnInitial||info.bagCount!==ctx.tilesRemaining||!opponents?.length||opponents.some(p=>!p.botId))return [];
  const choices=info.samples.filter(sample=>{
   if(!(sample.weight>0&&Number.isFinite(sample.weight)&&validRack(sample.bag)&&size(sample.bag)===ctx.tilesRemaining&&opponents.every(p=>{
    const hand=sample.opponentRacks.get(p.botId!);const estimate=info.opponents.find(e=>e.botId===p.botId);
    return !!hand&&validRack(hand)&&(!estimate||size(hand)===estimate.rackSize);
   })))return false;
   // The tracker supplies joint scenarios. Recheck that its physical hands,
   // future bag, our rack and the already-revealed tile fit the public bag.
   const allocated=withTile(ctx.myRack,ctx.letter);
   for(const rack of [sample.bag,...opponents.map(p=>sample.opponentRacks.get(p.botId!)!)])for(const [letter,count] of rack)allocated.set(letter,(allocated.get(letter)??0)+count);
   return [...allocated].every(([letter,count])=>count<=(BAG_COUNTS[letter]??0));
  });
  const mass=choices.reduce((n,s)=>n+s.weight,0);if(mass<=0)return [];
  const count=Math.min(this.maxScenarios,choices.length),selected=new Map<string,{sample:BeliefSample;weight:number}>();
  for(let i=0;i<count;i++) {
   const threshold=(i+.5)/count*mass;let cumulative=0;
   const sample=choices.find(s=>(cumulative+=s.weight)>=threshold)??choices[choices.length-1]!;
   const key=[keyOf(sample.bag),...opponents.map(p=>`${p.botId}:${keyOf(sample.opponentRacks.get(p.botId!)!)}`)].join('|');
   const prior=selected.get(key);if(prior)prior.weight+=1/count;else selected.set(key,{sample,weight:1/count});
  }
  return [...selected.values()];
 }
 explainEndgameDecision(ctx:DecisionContext):EndgameDecision {
  const key=this.decisionKey(ctx);
  if(key===this.lastKey&&this.lastDecision)return {...this.lastDecision,pivotalBots:[...this.lastDecision.pivotalBots]};
  const balance=cash(ctx.myBalance),baseBid=clipBid(this.base.decideBid(ctx),balance);
  const current=ctx.tilesRemaining>this.closingTiles?this.engine.redemptionPlan(ctx.myRack):this.engine.exactRedemptionPlan(ctx.myRack),ownLockedScore=ctx.myScore+current.value;
  const output:EndgameDecision={bid:baseBid,baseBid,ownGain:0,ownLockedScore,opponentLockedScore:null,projectedLead:null,blockWinDelta:0,acquireWinDelta:0,forcedWinDelta:0,pivotalBots:[],reason:'base',scenarios:0,cashoutWord:null,cashoutProceeds:0,reserveAfterPurchase:null};
  const finish=()=>{this.lastKey=key;this.lastDecision=output;return {...output,pivotalBots:[...output.pivotalBots]};};
  if(ctx.tilesRemaining>this.closingTiles)return finish();
  if(ctx.tilesRemaining<=0){output.bid=0;output.reason='unredeemable-final-tile';return finish();}
  const promised=this.confirmedCashout(ctx);
  if(promised){output.bid=0;output.reason='funded-completion-cashout';output.cashoutWord=promised.word;output.cashoutProceeds=wordReward(promised.word);output.reserveAfterPurchase=balance+output.cashoutProceeds;return finish();}
  if(balance===0||!/^[A-Z]$/.test(ctx.letter)){output.bid=0;output.reason='no-spendable-cash';return finish();}
  const after=this.engine.exactRedemptionPlan(withTile(ctx.myRack,ctx.letter));
  output.ownGain=Math.max(0,after.value-current.value);
  const ownAfter=ownLockedScore+output.ownGain;
  // If a rival's already-public score beats even our completed offered-tile
  // rack, this one-step closing proxy cannot call a denial pivotal.
  const knownTop=Math.max(-Infinity,...(ctx.opponents??[]).map(p=>p.score));
  const scenarios=knownTop>ownAfter?[]:this.scenarios(ctx);
  output.scenarios=scenarios.length;
  const planCache=new Map<string,number>();
  const value=(rack:Rack)=>{const key=keyOf(rack),old=planCache.get(key);if(old!==undefined)return old;const n=this.engine.redemptionPlan(rack).value;planCache.set(key,n);return n;};
  const pivotal=new Map<string,number>();let maximumPivotalCash=0,meanMaxOpponent=0;
  for(const {sample,weight} of scenarios) {
   const rivals=ctx.opponents!;
   const totals=rivals.map(rival=>rival.score+value(sample.opponentRacks.get(rival.botId!)!));
   const holdShare=winShare(ownLockedScore,totals),acquireShare=winShare(ownAfter,totals);
   let worstShare=holdShare,forced=false;
   // Every redemption multiplier is at most3. This physical upper bound is
   // deliberately loose and takes O(26), without solving a whole future rack.
   const upperWithoutOffer=ctx.myScore+3*(faceValue(ctx.myRack)+faceValue(sample.bag));
   for(let index=0;index<rivals.length;index++) {
    const rival=rivals[index]!;if(cash(rival.balance)<1)continue;
    const hand=sample.opponentRacks.get(rival.botId!)!;
    const upper=rival.score+3*(faceValue(hand)+(LETTER_VALUES[ctx.letter]??0));
    // A face-sum upper bound removes harmless after-tile searches, while the
    // standing diagnostic still includes their currently redeemable inventory.
    if(upper<ownLockedScore)continue;
    const afterTotal=Math.max(totals[index]!,rival.score+value(withTile(hand,ctx.letter)));
    const allocation=[...totals];allocation[index]=afterTotal;
    const loseShare=winShare(ownLockedScore,allocation);worstShare=Math.min(worstShare,loseShare);
    const change=Math.max(0,holdShare-loseShare);
    if(change>0){pivotal.set(rival.botId!,(pivotal.get(rival.botId!)??0)+weight*change);maximumPivotalCash=Math.max(maximumPivotalCash,cash(rival.balance));}
    if(acquireShare>0&&loseShare===0&&upperWithoutOffer<Math.max(...allocation))forced=true;
   }
   output.blockWinDelta+=weight*Math.max(0,holdShare-worstShare);
   output.acquireWinDelta+=weight*Math.max(0,acquireShare-holdShare);
   output.forcedWinDelta+=weight*(forced?acquireShare:0);
   meanMaxOpponent+=weight*Math.max(...totals);
  }
  if(scenarios.length){output.opponentLockedScore=meanMaxOpponent;output.projectedLead=ownLockedScore-meanMaxOpponent;}
  output.pivotalBots=[...pivotal].filter(([,mass])=>mass>=this.minimumWinDelta/2).map(([id])=>id).sort();
  const relevant=output.blockWinDelta>=this.minimumWinDelta||output.acquireWinDelta>=this.minimumWinDelta;
  if(ctx.tilesRemaining===1&&(output.ownGain>0||relevant)){output.bid=balance;output.reason=output.ownGain>0?'last-usable-completion':'last-usable-pivotal-denial';return finish();}
  if(output.forcedWinDelta>=.5&&relevant){output.bid=balance;output.reason='irrecoverable-pivotal-allocation';return finish();}
  if(output.ownGain>0&&Math.max(output.acquireWinDelta,output.blockWinDelta)>=.5&&current.exact&&after.exact&&after.firstWord) {
   // A rank-changing completion repays working capital on the next auction.
   // Reserve against that executable single word, not a whole future plan,
   // rather than imposing V2's fixed fraction of the pre-purchase bankroll.
   const proceeds=wordReward(after.firstWord),players=Math.max(2,(ctx.opponents?.length??5)+1),market=ctx.information?.market;
   const median=market&&market.samples>=3&&Number.isFinite(market.medianPayment)?Math.max(1,market.medianPayment):12;
   // Keep working capital for all remaining expected purchase opportunities.
   // Only cash already held plus this one pledged word can back the reserve.
   const reserve=Math.min(balance+proceeds,Math.max(8,median*(ctx.tilesRemaining-1)/players));
   const cap=clipBid(balance+proceeds-reserve,balance);
   const rivalCash=Math.max(0,...(ctx.opponents??[]).map(p=>cash(p.balance)));
   const marketTarget=market&&market.samples>=3&&Number.isFinite(market.p75Payment)?Math.max(1,Math.ceil(market.p75Payment)+1):13;
   const bid=Math.max(baseBid,Math.min(cap,Math.max(marketTarget,rivalCash+1)));
   output.bid=bid;output.reason='completion-reserve-base-floor';
   if(bid>baseBid) {
    output.reason='refund-backed-rank-completion';output.cashoutWord=after.firstWord;output.cashoutProceeds=proceeds;output.reserveAfterPurchase=balance-bid+proceeds;
    // Exact own-rack confirmation, rather than a speculative award, activates
    // this one-window cashout. Preserve a preceding promise until its window.
    this.pendingCashouts=this.pendingCashouts.filter(p=>p.remaining>=ctx.tilesRemaining-1&&p.remaining<=ctx.tilesRemaining);
    const pending={rackKey:keyOf(withTile(ctx.myRack,ctx.letter)),remaining:ctx.tilesRemaining-1,word:after.firstWord};
    if(!this.pendingCashouts.some(p=>p.rackKey===pending.rackKey&&p.remaining===pending.remaining))this.pendingCashouts.push(pending);
   }
   // Do not bypass an exhausted reserve by falling through to generic pacing.
   // The unchanged base bid remains the only floor on this conservative cap.
   return finish();
  }
  if(relevant) {
   const urgency=.25+.75/Math.sqrt(ctx.tilesRemaining);
   const confidence=Math.max(.25,Math.min(1,Math.max(output.blockWinDelta,output.acquireWinDelta)*1.5));
   const cap=Math.max(1,Math.floor(balance*urgency*confidence));
   const market=ctx.information?.market;
   const ownTarget=Math.max(1,Math.ceil((market&&market.samples>=3?market.p75Payment:12)+1));
   const target=output.blockWinDelta>=this.minimumWinDelta?maximumPivotalCash+1:ownTarget;
   output.bid=Math.max(baseBid,Math.min(balance,cap,target));output.reason=output.blockWinDelta>=this.minimumWinDelta?'paced-pivotal-denial':'rank-changing-completion';
  }
  output.bid=clipBid(output.bid,balance);return finish();
 }
 decideBid(ctx:DecisionContext):number {return this.explainEndgameDecision(ctx).bid;}
 chooseWord(ctx:DecisionContext):string|null {
  if(ctx.tilesRemaining>this.closingTiles)return this.base.chooseWord(ctx);
  const promised=this.confirmedCashout(ctx);
  // Repay the proceeds pledged for the previous purchase before committing to
  // a new tile. The adapter can reprice after this word's confirmed own state.
  if(promised)return promised.word;
  const plan=this.engine.exactRedemptionPlan(ctx.myRack);if(!plan.firstWord)return null;
  if(ctx.tilesRemaining<=0)return plan.firstWord;
  const word=ctx.tilesRemaining<=this.liquidationTiles?plan.firstWord:this.base.chooseWord(ctx);
  if(!word)return null;
  return explainCommittedWord(this.engine,ctx,word,ctx.committedBid??0,rack=>this.engine.exactRedemptionPlan(rack)).defer?null:word;
 }
}
