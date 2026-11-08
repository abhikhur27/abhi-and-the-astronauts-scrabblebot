import { withTile,type WordEngine } from './engine.js';
import type { BotPolicy,DecisionContext } from './types.js';
import { explainCommittedWord,type CommittedWordDecision } from './action-coordination.js';
export const EXECUTION_PROTOCOL_VERSION='coordinated-auctions-v2';
export interface TerminalCashGuardDecision {reason:'terminal-cash-denial';baseBid:number;bid:number;}
export class CoordinatedBot implements BotPolicy {
 lastCoordination:(CommittedWordDecision&{word:string})|null=null;
 private lastContext?:DecisionContext;
 private lastBidContext?:DecisionContext;
 private lastTerminalCashGuard:TerminalCashGuardDecision|null=null;
 constructor(private readonly engine:WordEngine,readonly base:BotPolicy) {}
 beginEpisode():void{this.lastCoordination=null;this.lastContext=undefined;this.lastBidContext=undefined;this.lastTerminalCashGuard=null;(this.base as BotPolicy&{beginEpisode?:()=>void}).beginEpisode?.();}
 coordinationFor(ctx:DecisionContext){return this.lastContext===ctx?this.lastCoordination:null;}
 terminalCashGuardFor(ctx:DecisionContext):TerminalCashGuardDecision|null{return this.lastBidContext===ctx&&this.lastTerminalCashGuard?{...this.lastTerminalCashGuard}:null;}
 finishEpisode(score:number):void{(this.base as BotPolicy&{finishEpisode?:(score:number)=>void}).finishEpisode?.(score);this.lastCoordination=null;this.lastBidContext=undefined;this.lastTerminalCashGuard=null;}
 decideBid(ctx:DecisionContext):number {
  this.lastBidContext=ctx;this.lastTerminalCashGuard=null;
  const base=this.base.decideBid(ctx);
  if(ctx.tilesRemaining!==1||!Number.isSafeInteger(ctx.myBalance)||ctx.myBalance<=0||!/^[A-Z]$/.test(ctx.letter)
   ||!ctx.opponents?.length||!ctx.opponents.every(p=>p.isSimulated===false)
   ||[...ctx.myRack].some(([letter,count])=>!/^[A-Z]$/.test(letter)||!Number.isSafeInteger(count)||count<0))return base;
  const current=this.engine.redemptionPlan(ctx.myRack),after=this.engine.redemptionPlan(withTile(ctx.myRack,ctx.letter));
  // No own word can be delayed, and external clients cannot score the next
  // final award. Cash has no later scoring use, so it can deny this offer.
  if(current.exact&&after.exact&&current.value===0&&after.value===0){
   const bid=Math.max(base,ctx.myBalance);this.lastTerminalCashGuard={reason:'terminal-cash-denial',baseBid:base,bid};return bid;
  }
  return base;
 }
 chooseWord(ctx:DecisionContext):string|null {
  const word=this.base.chooseWord(ctx);this.lastContext=ctx;this.lastCoordination=null;if(!word)return null;
  const decision=explainCommittedWord(this.engine,ctx,word,ctx.committedBid??0);
  this.lastCoordination={...decision,word};return decision.defer?null:word;
 }
}
