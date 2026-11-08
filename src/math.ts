import { WordEngine, withTile, withoutWord, wordReward, type AcquisitionSupply } from "./engine.js";
import { MathBot as MathBotV2 } from "./math-v2.js";
import type { BotPolicy, DecisionContext } from "./types.js";

export const MATH_POLICY_VERSION = "v5-v2-anchor";

function rackSize(rack: DecisionContext["myRack"]): number {
  let size = 0; for (const count of rack.values()) size += count; return size;
}

/** Four weighted quantiles keep joint integer scenarios without rounding hands. */
function sampledScenarios(ctx: DecisionContext, count: number) {
  const info = ctx.information;
  if (!info?.consistent || !info.completeHistory || !info.samples.length) return [];
  const positive = info.samples.filter(sample => sample.weight > 0 && Number.isFinite(sample.weight));
  const mass = positive.reduce((sum,sample)=>sum+sample.weight,0);
  if (mass <= 0) return [];
  const result: typeof positive = [];
  for (let index = 0; index < Math.min(count,positive.length); index++) {
    const target = (index + 0.5) / Math.min(count,positive.length) * mass;
    let cumulative = 0;
    for (const sample of positive) {
      cumulative += sample.weight;
      if (cumulative >= target) { result.push(sample); break; }
    }
  }
  return result;
}

/** Optimistic public feasibility of targeted future completion opportunities.
 * The client observes every auction. Cash pacing stays in the bid rule; these
 * scenarios do not assume that a random equal-share basket is purchased.
 */
export function acquisitionSupplies(ctx: DecisionContext): readonly AcquisitionSupply[] | undefined {
  const scenarios = sampledScenarios(ctx,4);
  if (!scenarios.length) return undefined;
  const horizon = Math.max(0,ctx.tilesRemaining - 1);
  return scenarios.map(sample=>({weight:1 / scenarios.length,bag:sample.bag,draws:horizon}));
}

/** Expected largest affordable opposing single-word completion, from real racks. */
export function opponentTileThreat(engine: WordEngine, ctx: DecisionContext): number {
  const scenarios = sampledScenarios(ctx,2);
  if (!scenarios.length || !/^[A-Z]$/.test(ctx.letter)) return 0;
  let threat = 0;
  for (const sample of scenarios) {
    let highest = 0;
    for (const [botId,rack] of sample.opponentRacks) {
      const opponent = ctx.opponents?.find(other=>other.botId===botId);
      if (opponent && opponent.balance < 1) continue;
      const before = engine.playable(rack,1)[0]?.reward ?? 0;
      const after = engine.playable(withTile(rack,ctx.letter),1)[0]?.reward ?? 0;
      highest = Math.max(highest,after-before);
    }
    threat += highest / scenarios.length;
  }
  return threat;
}

export interface MathOptions {
  /** Disable all information modifiers for exact frozen V2 comparisons. */
  publicInformation?: boolean;
  /** Fixed per-match cash-pacing calibration; selected outside gameplay. */
  bidScale?: number;
  /** Optional patience calibration; 0.98 preserves V2 word timing. */
  holdThreshold?: number;
}

export class MathBot implements BotPolicy {
  private readonly baseline: MathBotV2;
  private readonly useInformation: boolean;
  private readonly bidScale: number;
  private readonly holdThreshold: number;

  constructor(private readonly engine: WordEngine, options: MathOptions = {}) {
    const scale=options.bidScale ?? 1;
    if (!Number.isFinite(scale) || scale<0.9 || scale>1.1) throw new RangeError("Math bid scale must be between 0.9 and 1.1");
    const threshold=options.holdThreshold ?? 0.98;
    if (!Number.isFinite(threshold) || threshold<0.98 || threshold>1.04) throw new RangeError("Math hold threshold must be between 0.98 and 1.04");
    this.bidScale=scale;
    this.holdThreshold=threshold;
    this.useInformation=options.publicInformation ?? true;
    this.baseline=new MathBotV2(engine);
  }

  /** Certify no possible gain only on a small complete hard inventory upper
   * bound. Adding every possible future letter is an optimistic upper bound;
   * if even that cannot improve an exact packing plan, no allocation can.
   * Ambiguous/large states retain V2. Sampled hands never serve as certainty.
   */
  private cannotImprove(ctx: DecisionContext, rack: DecisionContext["myRack"], value: number, includeOffered = false): boolean {
    const info=ctx.information;
    if (!this.useInformation || !info?.consistent || !info.completeHistory || info.bagCount!==ctx.tilesRemaining || info.bagCount>8) return false;
    let additional=0;
    const optimistic=new Map(rack);
    for(const [letter,count] of info.bagMaximum) {
      if(!/^[A-Z]$/.test(letter) || !Number.isInteger(count) || count<0) return false;
      additional+=count;
      optimistic.set(letter,(optimistic.get(letter)??0)+count);
    }
    // bagMaximum excludes the revealed open auction. While considering a
    // word, that offered tile may still be bought before the next cashout.
    // After-award simulator callbacks can overcount one tile here; this only
    // makes the upper bound more optimistic and preserves the V2 fallback.
    if(includeOffered && ctx.tilesRemaining>0 && /^[A-Z]$/.test(ctx.letter)) optimistic.set(ctx.letter,(optimistic.get(ctx.letter)??0)+1);
    if(additional>8 || rackSize(optimistic)>15) return false;
    const upper=this.engine.redemptionPlan(optimistic);
    return upper.exact && upper.value<=value;
  }

  private rivalCompletion(ctx: DecisionContext): boolean {
    const info=ctx.information;
    if(!info?.consistent || !info.completeHistory) return false;
    for(const estimate of info.opponents) {
      const rival=ctx.opponents?.find(other=>other.botId===estimate.botId);
      if(!rival || rival.balance<1 || rackSize(estimate.rackMinimum)>10) continue;
      const before=this.engine.playable(estimate.rackMinimum,1)[0]?.reward??0;
      const after=this.engine.playable(withTile(estimate.rackMinimum,ctx.letter),1)[0]?.reward??0;
      if(after>=12 && after>before) return true;
    }
    return false;
  }

  /** A small complete letter-type bound can rule out the longer targets
   * modeled by V2's one/two-missing-letter search. This is only a veto of an
   * optional delay, never a replacement for V2's continuation values. Large
   * ambiguous bounds stay on the prior and avoid an expensive broad search.
   */
  private longerUpgradeExhausted(ctx: DecisionContext, word: string): boolean {
    const info=ctx.information;
    if(!this.useInformation || !info?.consistent || !info.completeHistory || info.bagCount!==ctx.tilesRemaining || rackSize(ctx.myRack)>10) return false;
    const future=new Map<string,number>();
    for(const [letter,count] of info.bagMaximum) {
      if(!/^[A-Z]$/.test(letter) || !Number.isInteger(count) || count<0) return false;
      if(count>0) future.set(letter,count);
    }
    if(future.size>4) return false;
    const optimistic=new Map(ctx.myRack);
    for(const [letter,count] of future) optimistic.set(letter,(optimistic.get(letter)??0)+count);
    // The open auction has already left the bag but can still be acquired.
    if(ctx.tilesRemaining>0 && /^[A-Z]$/.test(ctx.letter)) optimistic.set(ctx.letter,(optimistic.get(ctx.letter)??0)+1);
    const reward=wordReward(word);
    return !this.engine.playable(optimistic).some(candidate=>{
      if(candidate.word.length<=word.length || candidate.reward<=reward) return false;
      const needed=new Map<string,number>();for(const letter of candidate.word)needed.set(letter,(needed.get(letter)??0)+1);
      let missing=0,owned=0;
      for(const [letter,count] of needed) {const have=ctx.myRack.get(letter)??0;missing+=Math.max(0,count-have);owned+=Math.min(count,have);}
      return missing>0 && missing<=2 && owned>0;
    });
  }

  decideBid(ctx: DecisionContext): number {
    const base=this.baseline.decideBid(ctx);
    // Preserve source-verified final-auction behavior exactly; no scale or
    // opponent adjustment can skip a profitable last usable completion.
    if(ctx.tilesRemaining<=1 || base<=0) return base;
    const balance=Math.max(0,Math.floor(ctx.myBalance));
    let amount=Math.min(balance,Math.floor(base*this.bidScale));
    if(!this.useInformation || amount<=0) return amount;
    const before=this.engine.redemptionPlan(ctx.myRack);
    const afterRack=withTile(ctx.myRack,ctx.letter);
    const after=this.engine.redemptionPlan(afterRack);
    if(before.exact && after.value<=before.value && this.cannotImprove(ctx,afterRack,before.value)) return 0;
    // Compete one cash unit harder only when the tile immediately creates
    // substantial value for us and a known opposing subset also completes.
    // This never bids merely to deny a tile useful only to another player.
    if(after.value-before.value>=10 && this.rivalCompletion(ctx)) amount=Math.min(balance,amount+1);
    return amount;
  }

  chooseWord(ctx: DecisionContext): string | null {
    const word=this.baseline.chooseWord(ctx);
    if(word) {
      if(this.holdThreshold===0.98 || word.length>=7 || ctx.myBalance<24 || ctx.tilesRemaining<=16) return word;
      const plan=this.engine.redemptionPlan(ctx.myRack);
      const horizon=Math.max(0,ctx.tilesRemaining-1);
      const holdValue=this.engine.potential(ctx.myRack,horizon);
      // Patience needs an actual modeled improvement; it cannot invent an
      // extension or keep an already exhausted rack until the closing phase.
      if(holdValue<=plan.value*1.01 || this.longerUpgradeExhausted(ctx,word)) return word;
      const cashoutValue=wordReward(word)+0.88*this.engine.potential(withoutWord(ctx.myRack,word),horizon);
      return cashoutValue<holdValue*this.holdThreshold ? null : word;
    }
    if(!this.useInformation) return word;
    const plan=this.engine.redemptionPlan(ctx.myRack);
    return plan.firstWord && plan.exact && this.cannotImprove(ctx,ctx.myRack,plan.value,true) ? plan.firstWord : null;
  }
}
