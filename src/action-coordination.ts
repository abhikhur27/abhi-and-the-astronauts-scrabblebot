import { canSpell,withTile,withoutWord,wordReward,type WordEngine } from './engine.js';
import type { DecisionContext } from './types.js';

export type CoordinationReason = 'invalid-state'|'invalid-bid'|'unusable-final-tile'|'invalid-word'
  |'uncompetitive-commitment'|'liquidity-needs-cashout'|'approximate-plan'
  |'no-value-conflict'|'preserve-committed-completion';
export interface CommittedWordDecision {
  defer:boolean;
  reason:CoordinationReason;
  committedBid:number;
  wordReward:number;
  holdIfWon?:number;
  sellFirstIfWon?:number;
  benefit?:number;
  marketPaymentMedian?:number;
}

/**
 * Compare two coherent own-hand plans for the current, still-open auction.
 * The caller supplies an actual submitted commitment, never a proposed bid.
 * No auction state is retained here: callers stop deferring at settlement.
 */
export function explainCommittedWord(engine:WordEngine,ctx:DecisionContext,word:string,committedBid:number):CommittedWordDecision {
  const decision:CommittedWordDecision={defer:false,reason:'invalid-state',committedBid:Number.isSafeInteger(committedBid)?committedBid:0,wordReward:wordReward(word)};
  if(!Number.isSafeInteger(ctx.tilesRemaining)||ctx.tilesRemaining<0||!Number.isSafeInteger(ctx.myBalance)||ctx.myBalance<0||!/^[A-Z]$/.test(ctx.letter)||[...ctx.myRack].some(([letter,count])=>!/^[A-Z]$/.test(letter)||!Number.isSafeInteger(count)||count<0))return decision;
  if(ctx.tilesRemaining===0)return {...decision,reason:'unusable-final-tile'};
  if(!Number.isSafeInteger(committedBid)||committedBid<=0||committedBid>ctx.myBalance)return {...decision,reason:'invalid-bid'};
  if(typeof word!=='string'||!/^[A-Z]{2,}$/.test(word)||!canSpell(word,ctx.myRack)||!engine.playable(ctx.myRack).some(candidate=>candidate.word===word))return {...decision,reason:'invalid-word'};

  const info=ctx.information;
  const observedMedian=info?.consistent&&info.completeHistory&&info.market.samples>=3&&Number.isFinite(info.market.medianPayment)&&info.market.medianPayment>0?info.market.medianPayment:undefined;
  if(observedMedian!==undefined) {
    decision.marketPaymentMedian=observedMedian;
    // Payment is only a weak-commitment check. A Vickrey payment does not
    // reveal the winning bid or certify that our own commitment will win.
    if(committedBid<observedMedian)return {...decision,reason:'uncompetitive-commitment'};
  }else if(ctx.myBalance<12)return {...decision,reason:'liquidity-needs-cashout'};

  const held=engine.redemptionPlan(withTile(ctx.myRack,ctx.letter));
  const sold=engine.redemptionPlan(withTile(withoutWord(ctx.myRack,word),ctx.letter));
  decision.holdIfWon=held.value;
  decision.sellFirstIfWon=decision.wordReward+sold.value;
  decision.benefit=decision.holdIfWon-decision.sellFirstIfWon;
  if(!held.exact||!sold.exact)return {...decision,reason:'approximate-plan'};
  if(decision.benefit<=0)return {...decision,reason:'no-value-conflict'};
  return {...decision,defer:true,reason:'preserve-committed-completion'};
}

export function shouldDeferCommittedWord(engine:WordEngine,ctx:DecisionContext,word:string,committedBid:number):boolean {
  return explainCommittedWord(engine,ctx,word,committedBid).defer;
}
