import { WordEngine } from "./engine.js";
import { MathBot as MathV2 } from "./math-v2.js";
import { predictDiluteResidual, validateDiluteResidualProfile, type DiluteResidualProfile } from "./dilute-profile.js";
import type { BotPolicy, DecisionContext } from "./types.js";

export const DILUTE_POLICY_VERSION = "v2-anchor-bounded-teacher-residual";
export interface DiluteOptions { profile?: unknown; dictionaryHash?: string; }

/** Exact frozen V2 core, with an optional offline-fitted, calibrated bid residual. */
export class DiluteBot implements BotPolicy {
  private readonly anchor: MathV2;
  private readonly dictionaryHash?: string;
  private activeProfile: DiluteResidualProfile | null;
  private pendingProfile: DiluteResidualProfile | null = null;
  private inEpisode = false;

  constructor(engine: WordEngine, options: DiluteOptions = {}) {
    this.anchor = new MathV2(engine);
    this.dictionaryHash = options.dictionaryHash;
    this.activeProfile = validateDiluteResidualProfile(options.profile, this.dictionaryHash);
  }

  /** Invalid artifacts fail closed without replacing the current good profile. */
  queueProfile(value: unknown): boolean {
    const profile = validateDiluteResidualProfile(value, this.dictionaryHash);
    if (!profile) return false;
    this.pendingProfile = profile;
    return true;
  }

  /** Repeated reconnect/initialization hooks cannot hot-swap an active match. */
  beginEpisode(): void {
    if (this.inEpisode) return;
    if (this.pendingProfile) { this.activeProfile = this.pendingProfile; this.pendingProfile = null; }
    this.inEpisode = true;
  }

  finishEpisode(_finalScore?: number): void { this.inEpisode = false; }

  get profileStatus(): { activeCutoff: number | null; pendingCutoff: number | null; anchored: boolean } {
    return { activeCutoff: this.activeProfile?.cutoffMatchId ?? null,
      pendingCutoff: this.pendingProfile?.cutoffMatchId ?? null, anchored: this.activeProfile === null };
  }

  decideBid(ctx: DecisionContext): number {
    const base = this.anchor.decideBid(ctx);
    const profile = this.activeProfile;
    // No price imitation can invent a purchase V2 rejected, change the final
    // unredeemable tile, or preserve cash at the final usable completion.
    if (!profile || base <= 0 || ctx.tilesRemaining <= 1) return base;
    let residual = predictDiluteResidual(profile, ctx, base);
    if (!Number.isFinite(residual)) return base;
    const market = ctx.information?.consistent ? ctx.information.market : undefined;
    if (residual > 0) {
      // Historical payments bound an extra liquidity commitment, never stand
      // in for a hidden winning bid. Keep the anchor when reserves are thin.
      if (ctx.myBalance - base < 12) return base;
      if (ctx.auctionType === "FirstPrice" && market && market.samples >= 5
        && Number.isFinite(market.p75Payment) && base > Math.max(1, market.p75Payment) * 1.25) residual = 0;
    }
    const shift = Math.min(0.15, profile.maxBidShift);
    // Integer rounding is inside the relative bound, including tiny bids.
    const minimum = Math.ceil(base * (1 - shift));
    const maximum = Math.min(Math.floor(ctx.myBalance), Math.floor(base * (1 + shift)));
    return Math.max(minimum, Math.min(maximum, Math.round(base * Math.exp(residual))));
  }

  chooseWord(ctx: DecisionContext): string | null {
    // Teacher long-word patterns may support a hold only when V2 already
    // values continuation. They never delay a V2 cashout or terminal packing.
    // No fixed historical round threshold is transferred to a new match config.
    return this.anchor.chooseWord(ctx);
  }
}
