import { WordEngine, withTile, withoutWord, wordReward } from "./engine.js";
import type { BotPolicy, DecisionContext } from "./types.js";

export class MathBot implements BotPolicy {
  constructor(private readonly engine: WordEngine) {}

  decideBid(ctx: DecisionContext): number {
    const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
    // A final auction award cannot be redeemed: closeAuction ends that match
    // in the same transaction. Do not buy that tile even if it completes a word.
    if (balance === 0 || ctx.tilesRemaining <= 0 || !/^[A-Z]$/.test(ctx.letter)) return 0;
    const horizon = Math.max(0, ctx.tilesRemaining - 1);
    const withLetter = withTile(ctx.myRack, ctx.letter);
    const current = this.engine.potential(ctx.myRack, horizon);
    const after = this.engine.potential(withLetter, horizon);
    const immediateGain = this.engine.redemptionPlan(withLetter).value - this.engine.redemptionPlan(ctx.myRack).value;
    const marginalScore = Math.max(0, after - current, immediateGain * 0.65);
    if (marginalScore <= 0.05) return 0;

    // Cash is working capital, not ranking score. These shadow-price and
    // reserve choices are fixed heuristics, not a claim of Vickrey truthfulness
    // in this repeated, complementary-value auction game.
    const cashFactor = Math.min(1.5, 0.75 + balance / 160);
    const reserve = ctx.tilesRemaining > 8 ? Math.min(12, Math.floor(balance * 0.12)) : 0;
    const perTileFraction = immediateGain >= 15 ? 0.55 : ctx.tilesRemaining > 15 ? 0.32 : 0.6;
    const spendCap = Math.min(balance - reserve, Math.max(1, Math.floor(balance * perTileFraction)));
    const auctionFactor = ctx.auctionType === "FirstPrice" ? 0.72 : 1;
    return Math.max(0, Math.min(spendCap, Math.floor(marginalScore * cashFactor * auctionFactor)));
  }

  chooseWord(ctx: DecisionContext): string | null {
    const plan = this.engine.redemptionPlan(ctx.myRack);
    if (!plan.firstWord) return null;
    if (ctx.tilesRemaining <= 2 || ctx.myBalance < 12) return plan.firstWord;
    const rackSize = [...ctx.myRack.values()].reduce((sum, count) => sum + count, 0);
    // At most four residual option searches for a large rack keeps the live
    // action callback inside its short auction window. Include the packing
    // plan even when it starts with a word outside the reward-ranked prefix.
    const legal = this.engine.playable(ctx.myRack, rackSize >= 15 ? 3 : 6);
    if (!legal.some(candidate => candidate.word === plan.firstWord)) {
      legal.push({word: plan.firstWord, reward: wordReward(plan.firstWord)});
    }
    const horizon = Math.max(0, ctx.tilesRemaining - 1);
    const holdValue = this.engine.potential(ctx.myRack, horizon);
    let bestWord = plan.firstWord;
    let bestRedeemValue = Number.NEGATIVE_INFINITY;
    for (const candidate of legal) {
      const remaining = withoutWord(ctx.myRack, candidate.word);
      const redeemValue = candidate.reward + 0.88 * this.engine.potential(remaining, horizon);
      if (redeemValue > bestRedeemValue) {
        bestRedeemValue = redeemValue;
        bestWord = candidate.word;
      }
    }
    // Seven tiles reaches the maximum multiplier. Otherwise wait only when a
    // near completion offers a meaningful gain and there is cash to bid for it.
    if (bestWord.length >= 7 || bestRedeemValue >= holdValue * 0.98) return bestWord;
    return null;
  }
}
