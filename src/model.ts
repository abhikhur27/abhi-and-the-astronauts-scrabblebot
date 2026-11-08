import { readFileSync } from "node:fs";
import { atomicWriteJson } from "./atomic-json.js";
import { LETTER_VALUES, WordEngine } from "./engine.js";
import { MathBot, acquisitionSupplies, opponentTileThreat } from "./math.js";
import { MathBot as MathBotV2 } from "./math-v2.js";
import type { BotPolicy, DecisionContext } from "./types.js";

const LEGACY_FEATURE_COUNT = 12;
const FEATURE_COUNT = 20;
const BID_MULTIPLIERS = [0, 0.6, 0.85, 1, 1.2, 1.5] as const;
const RESIDUAL_BID_MULTIPLIERS = [0.9, 1, 1.1] as const;
const RESIDUAL_BASELINE_PRIOR = 2.5;
export type LearningProfile = "v2-residual" | "legacy-mc";
interface ModelParameters {
  featureCount: number;
  bidWeights: number[][];
  wordWeights: number[][];
  trainedGames: number;
  updates: number;
  dictionaryHash?: string;
  trainingSeed?: number;
}
export interface LegacyLearnedModel extends ModelParameters {
  schema: "scrabblebot-linear-mc-v1" | "scrabblebot-linear-mc-v2";
}
export interface ResidualLearnedModel extends ModelParameters {
  schema: "scrabblebot-v2-residual-v1";
  residual: {
    baseline: "v2-cash-pacing";
    featureRevision: "public20-v1";
    actionSemantics: "bounded-bid-safe-hold-v1";
    algorithm: "centered-actor-critic-v1";
    valueWeights: number[];
    valueUpdates: number;
    bidActionCounts: number[];
    wordActionCounts: number[];
  };
}
export type LearnedModel = LegacyLearnedModel | ResidualLearnedModel;

export function modelProfile(model: LearnedModel): LearningProfile {
  return model.schema === "scrabblebot-v2-residual-v1" ? "v2-residual" : "legacy-mc";
}

export function createModel(profile?: "v2-residual"): ResidualLearnedModel;
export function createModel(profile: "legacy-mc"): LegacyLearnedModel;
export function createModel(profile: LearningProfile): LearnedModel;
export function createModel(profile: LearningProfile = "v2-residual"): LearnedModel {
  if (profile === "v2-residual") return {
    schema: "scrabblebot-v2-residual-v1", featureCount: FEATURE_COUNT,
    bidWeights: Array.from({length: 3}, () => Array<number>(FEATURE_COUNT).fill(0)),
    wordWeights: Array.from({length: 2}, () => Array<number>(FEATURE_COUNT).fill(0)),
    trainedGames: 0, updates: 0,
    residual: {baseline: "v2-cash-pacing", featureRevision: "public20-v1", actionSemantics: "bounded-bid-safe-hold-v1",
      algorithm: "centered-actor-critic-v1", valueWeights: Array<number>(FEATURE_COUNT).fill(0), valueUpdates: 0,
      bidActionCounts: [0, 0, 0], wordActionCounts: [0, 0]},
  };
  if (profile !== "legacy-mc") throw new Error("Unknown learning profile");
  const bidWeights = BID_MULTIPLIERS.map(() => Array<number>(FEATURE_COUNT).fill(0));
  const wordWeights = Array.from({ length: 3 }, () => Array<number>(FEATURE_COUNT).fill(0));
  // Cold start follows the fixed policy; values thereafter are genuinely learned.
  bidWeights[3]![0] = 0.02;
  wordWeights[1]![0] = 0.02;
  return { schema: "scrabblebot-linear-mc-v2", featureCount: FEATURE_COUNT, bidWeights, wordWeights, trainedGames: 0, updates: 0 };
}

function validateModel(value: unknown): asserts value is LearnedModel {
  const model = value as LearnedModel | null;
  if (!model || !["scrabblebot-linear-mc-v1", "scrabblebot-linear-mc-v2", "scrabblebot-v2-residual-v1"].includes(model.schema) || model.featureCount !== (model.schema === "scrabblebot-linear-mc-v1" ? LEGACY_FEATURE_COUNT : FEATURE_COUNT) || !Number.isSafeInteger(model.updates) || model.updates < 0 || !Number.isSafeInteger(model.trainedGames) || model.trainedGames < 0) throw new Error("Invalid checkpoint schema or counters");
  const residual = model.schema === "scrabblebot-v2-residual-v1";
  for (const [rows, expected] of [[model.bidWeights, residual ? 3 : BID_MULTIPLIERS.length], [model.wordWeights, residual ? 2 : 3]] as const) {
    if (!Array.isArray(rows) || rows.length !== expected || rows.some((row) => !Array.isArray(row) || row.length !== model.featureCount || row.some((weight) => typeof weight !== "number" || !Number.isFinite(weight) || Math.abs(weight) > 100))) throw new Error("Invalid checkpoint weights");
  }
  if (model.schema === "scrabblebot-v2-residual-v1") {
    const state = model.residual;
    if (!state || state.baseline !== "v2-cash-pacing" || state.featureRevision !== "public20-v1" || state.actionSemantics !== "bounded-bid-safe-hold-v1" || state.algorithm !== "centered-actor-critic-v1" ||
      !Number.isSafeInteger(state.valueUpdates) || state.valueUpdates < 0 ||
      !Array.isArray(state.valueWeights) || state.valueWeights.length !== FEATURE_COUNT || state.valueWeights.some(weight => !Number.isFinite(weight) || Math.abs(weight) > 100)) throw new Error("Invalid residual checkpoint metadata or value weights");
    for (const [counts, length] of [[state.bidActionCounts, 3], [state.wordActionCounts, 2]] as const) {
      if (!Array.isArray(counts) || counts.length !== length || counts.some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error("Invalid residual checkpoint action counters");
    }
  }
}

function upgradeModel(model: LearnedModel): LearnedModel {
  validateModel(model);
  if (model.schema !== "scrabblebot-linear-mc-v1") return model;
  // Preserve every learned old column/counter and initialize only the new
  // information channels. Clone a legacy input so frozen inference is pure.
  return {...model, schema:"scrabblebot-linear-mc-v2",featureCount:FEATURE_COUNT,
    bidWeights:model.bidWeights.map(row=>[...row,...Array<number>(FEATURE_COUNT-LEGACY_FEATURE_COUNT).fill(0)]),
    wordWeights:model.wordWeights.map(row=>[...row,...Array<number>(FEATURE_COUNT-LEGACY_FEATURE_COUNT).fill(0)])};
}

export function loadModel(path: string, expectedProfile?: LearningProfile): LearnedModel {
  const model: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateModel(model);
  const loaded = upgradeModel(model);
  if (expectedProfile !== undefined && modelProfile(loaded) !== expectedProfile) throw new Error(`Checkpoint profile is ${modelProfile(loaded)}, expected ${expectedProfile}; create a separate candidate instead of reinterpreting legacy actions`);
  return loaded;
}

export function saveModel(path: string, model: LearnedModel): void {
  validateModel(model);
  atomicWriteJson(path, upgradeModel(model));
}

interface Experience { kind: "bid" | "word"; features: number[]; action: number; score: number; softmax?: number[]; probabilities?: number[]; }
export interface LearningOptions { training?: boolean; epsilon?: number; seed?: number; allowDeviations?: boolean; anchorPolicy?:BotPolicy; protectedHorizon?:number; }

/** No training occurs unless explicitly enabled. Own rack/public state are the only features. */
export class LearningBot implements BotPolicy {
  readonly model: LearnedModel;
  private readonly baseline: BotPolicy;
  private readonly experiences: Experience[] = [];
  private readonly decisionActions = new Map<string, number>();
  private randomState: number;
  private readonly training: boolean;
  private readonly epsilon: number;
  private readonly allowDeviations: boolean;
  private readonly protectedHorizon:number;
  private deferredWord?: {remaining: number; letter: string};

  constructor(private readonly engine: WordEngine, model: LearnedModel = createModel(), options: LearningOptions = {}) {
    validateModel(model);
    this.model = upgradeModel(model);
    this.baseline = options.anchorPolicy??(this.model.schema === "scrabblebot-v2-residual-v1" ? new MathBotV2(engine) : new MathBot(engine));
    this.training = options.training ?? false;
    this.epsilon = Math.max(0, Math.min(1, options.epsilon ?? 0.12));
    this.allowDeviations = options.allowDeviations ?? true;
    this.protectedHorizon=options.protectedHorizon??2;
    if(!Number.isSafeInteger(this.protectedHorizon)||this.protectedHorizon<0||this.protectedHorizon>68)throw new Error('Invalid protected closing horizon');
    this.randomState = (options.seed ?? 1) >>> 0 || 1;
  }

  private random(): number {
    let state = this.randomState;
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    this.randomState = state >>> 0;
    return this.randomState / 0x100000000;
  }

  beginEpisode(): void { this.experiences.length = 0; this.decisionActions.clear(); this.deferredWord = undefined;(this.baseline as BotPolicy&{beginEpisode?:()=>void}).beginEpisode?.(); }

  private features(ctx: DecisionContext): number[] {
    let size = 0; let vowels = 0; let duplicates = 0;
    for (const [letter, count] of ctx.myRack) {
      size += count;
      if ("AEIOU".includes(letter)) vowels += count;
      duplicates += Math.max(0, count - 1);
    }
    const info = ctx.information?.consistent && ctx.information.completeHistory ? ctx.information : undefined;
    const bagCount = info?.bagCount ?? 0;
    let entropy = 0;
    if (info && bagCount > 0) for (const count of info.expectedBag.values()) {
      const probability = count / bagCount;
      if (probability > 0) entropy -= probability * Math.log(probability);
    }
    const supplies = acquisitionSupplies(ctx);
    // The original twelve channels keep their definitions for migrated
    // checkpoints. New channels use causal public inventory and uncertainty.
    return [1, Math.min(300, ctx.myBalance) / 100, Math.min(30, size) / 15, vowels / 8, duplicates / 8, (this.engine.playable(ctx.myRack, 1)[0]?.reward ?? 0) / 100, Math.min(200, this.engine.potential(ctx.myRack, ctx.tilesRemaining)) / 100, Math.min(98, Math.max(0, ctx.tilesRemaining)) / 68, "AEIOU".includes(ctx.letter) && ctx.letter.length === 1 ? 1 : 0, (ctx.myRack.get(ctx.letter) ?? 0) / 3, (LETTER_VALUES[ctx.letter] ?? 0) / 10, ctx.auctionType === "FirstPrice" ? 1 : 0,
      info ? 1 : 0,info ? (info.expectedBag.get(ctx.letter) ?? 0) / Math.max(1,bagCount) : 0,
      Math.min(100,opponentTileThreat(this.engine,ctx)) / 100,
      Math.max(-1,Math.min(1,(Math.max(ctx.myScore,...(ctx.opponents?.map(other=>other.score) ?? []))-ctx.myScore) / 100)),
      info ? Math.min(60,info.market.medianPayment) / 30 : 0,entropy / Math.log(26),
      info ? Math.min(1,info.effectiveSampleSize / Math.max(1,info.samples.length)) : 0,
      supplies ? Math.min(200,this.engine.potential(ctx.myRack,Math.max(0,ctx.tilesRemaining-1),supplies)) / 100 : 0];
  }

  private action(kind: "bid" | "word", ctx: DecisionContext): number {
    const features = this.features(ctx);
    const signature = `${kind}:${ctx.letter}:${ctx.myBalance}:${ctx.myScore}:${ctx.tilesRemaining}:${ctx.auctionType}:${[...ctx.myRack].sort(([a], [b]) => a.localeCompare(b)).map(([letter, count]) => `${letter}${count}`).join("")}:${features.slice(LEGACY_FEATURE_COUNT).map(value=>value.toFixed(5)).join(",")}`;
    const previous = this.decisionActions.get(signature);
    if (this.training && previous !== undefined) return previous;
    const weights = kind === "bid" ? this.model.bidWeights : this.model.wordWeights;
    if (this.model.schema === "scrabblebot-v2-residual-v1") {
      const baselineAction = kind === "bid" ? 1 : 0;
      if (!this.allowDeviations) {
        if (this.training) {
          const fixed = weights.map((_, index) => index === baselineAction ? 1 : 0);
          this.experiences.push({kind, features, action: baselineAction, score: ctx.myScore, softmax: fixed, probabilities: fixed});
          this.decisionActions.set(signature, baselineAction);
        }
        return baselineAction;
      }
      const scores = weights.map(row => row.reduce((sum, weight, j) => sum + weight * features[j]!, 0));
      let action = baselineAction;
      if (this.training) {
        // Exact sampling probabilities are retained for the policy-gradient
        // update. A fixed prior favors V2; epsilon adds uniform exploration.
        const logits = scores.map((score, index) => score + (index === baselineAction ? RESIDUAL_BASELINE_PRIOR : 0));
        const maximum = Math.max(...logits);
        const masses = logits.map(logit => Math.exp(logit - maximum));
        const total = masses.reduce((sum, mass) => sum + mass, 0);
        const softmax = masses.map(mass => mass / total);
        const probabilities = softmax.map(probability => (1 - this.epsilon) * probability + this.epsilon / weights.length);
        const selected = this.random();
        let cumulative = 0;
        action = weights.length - 1;
        for (let index = 0; index < probabilities.length; index++) {
          cumulative += probabilities[index]!;
          if (selected < cumulative) { action = index; break; }
        }
        this.experiences.push({kind, features, action, score: ctx.myScore, softmax, probabilities});
        this.decisionActions.set(signature, action);
      } else {
        const counts = kind === "bid" ? this.model.residual.bidActionCounts : this.model.residual.wordActionCounts;
        // This is a conservative support/margin gate, not a calibrated claim
        // of strength. League evaluation remains necessary for promotion.
        if (this.model.trainedGames >= 32 && this.model.residual.valueUpdates >= 128 && counts[baselineAction]! >= 64) {
          let best = scores[baselineAction]!;
          for (let index = 0; index < scores.length; index++) {
            const support = Math.min(counts[index]!, counts[baselineAction]!);
            const margin = 0.1 + 0.5 / Math.sqrt(Math.max(1, support));
            if (index !== baselineAction && support >= 32 && scores[index]! > scores[baselineAction]! + margin && scores[index]! > best) {
              best = scores[index]!; action = index;
            }
          }
        }
      }
      return action;
    }
    let action = 0; let best = -Infinity;
    for (let i = 0; i < weights.length; i++) {
      const value = weights[i]!.reduce((sum, weight, j) => sum + weight * features[j]!, 0);
      if (value > best) { best = value; action = i; }
    }
    if (this.training && this.random() < this.epsilon) action = Math.floor(this.random() * weights.length);
    if (this.training) {
      this.experiences.push({ kind, features, action, score: ctx.myScore });
      this.decisionActions.set(signature, action);
    }
    return action;
  }

  decideBid(ctx: DecisionContext): number {
    if (ctx.tilesRemaining <= 0 || ctx.myBalance < 1) return 0;
    const base = this.baseline.decideBid(ctx);
    if (this.model.schema === "scrabblebot-v2-residual-v1") {
      // Preserve V2's zero/terminal bids and bidding-capital decisions. An
      // actor may shade an ordinary positive bid, never skip or invent one.
      if (base === 0 || ctx.tilesRemaining <= this.protectedHorizon || ctx.myBalance < 12) return base;
      const multiplier = RESIDUAL_BID_MULTIPLIERS[this.action("bid", ctx)]!;
      const requested = Math.round(base * multiplier);
      const adjusted = Math.max(base - 2, Math.min(base + 2, requested));
      return Math.max(1, Math.min(Math.floor(ctx.myBalance), adjusted));
    }
    // No future usable auction remains; the model cannot preserve valueless
    // terminal cash by skipping or shading a score-increasing completion.
    if (ctx.tilesRemaining === 1) return base;
    const multiplier = BID_MULTIPLIERS[this.action("bid", ctx)]!;
    return Math.max(0, Math.min(Math.floor(ctx.myBalance), Math.floor(base * multiplier)));
  }

  chooseWord(ctx: DecisionContext): string | null {
    if (this.model.schema === "scrabblebot-v2-residual-v1") {
      const baselineWord = this.baseline.chooseWord(ctx);
      if (!baselineWord || baselineWord.length >= 7 || ctx.tilesRemaining <= Math.max(8,this.protectedHorizon) || ctx.myBalance < 24) {
        this.deferredWord = undefined;
        return baselineWord;
      }
      if (this.deferredWord) {
        if (this.deferredWord.remaining === ctx.tilesRemaining && this.deferredWord.letter === ctx.letter) return null;
        // One auction of delay is the entire timing action. Reconsider the
        // updated V2 plan before another residual may defer a later word.
        this.deferredWord = undefined;
        return baselineWord;
      }
      if (this.action("word", ctx) === 1) {
        this.deferredWord = {remaining: ctx.tilesRemaining, letter: ctx.letter};
        return null;
      }
      return baselineWord;
    }
    const best = this.engine.playable(ctx.myRack, 1)[0];
    if (!best) return null;
    // Guardrails cannot be overridden by a newly trained value function.
    if (ctx.tilesRemaining <= 2 || ctx.myBalance < 12) return this.baseline.chooseWord(ctx);
    const baselineWord = this.baseline.chooseWord(ctx);
    // A learned greedy action must not destroy the starting portfolio while
    // the baseline identifies an attainable extension and ample liquidity.
    if (best.word.length < 7 && ctx.tilesRemaining > 8 && ctx.myBalance >= 24 && baselineWord === null) return null;
    const action = this.action("word", ctx);
    if (action === 0) return null;
    if (action === 2) return best.word;
    return baselineWord;
  }

  finishEpisode(finalScore: number): void {
    if (!this.training) return;
    if (!Number.isFinite(finalScore)) throw new Error("Nonfinite episode score");
    if (this.model.schema === "scrabblebot-v2-residual-v1") {
      const state = this.model.residual;
      // Snapshot the state-value critic so an episode's later update order
      // cannot change its earlier advantage labels. Inputs are decision-time
      // own/public features; the completed score is used only as the label.
      const criticBefore = [...state.valueWeights];
      for (const experience of this.experiences) {
        const target = Math.max(0, Math.min(10, (finalScore - experience.score) / 100));
        const value = criticBefore.reduce((sum, weight, j) => sum + weight * experience.features[j]!, 0);
        const advantage = Math.max(-1, Math.min(1, target - value));
        const norm = Math.max(1, experience.features.reduce((sum, feature) => sum + feature * feature, 0));
        const rows = experience.kind === "bid" ? this.model.bidWeights : this.model.wordWeights;
        const softmax = experience.softmax!;
        const probabilities = experience.probabilities!;
        const mixtureGradient = (1 - this.epsilon) * softmax[experience.action]! / probabilities[experience.action]!;
        const rate = 0.025 / Math.sqrt(1 + this.model.updates / 100_000);
        for (let action = 0; action < rows.length; action++) {
          const gradient = mixtureGradient * ((action === experience.action ? 1 : 0) - softmax[action]!);
          for (let j = 0; j < FEATURE_COUNT; j++) rows[action]![j] = Math.max(-5, Math.min(5, rows[action]![j]! + rate * advantage * gradient * experience.features[j]! / norm));
        }
        const prediction = state.valueWeights.reduce((sum, weight, j) => sum + weight * experience.features[j]!, 0);
        const valueError = Math.max(-2, Math.min(2, target - prediction));
        for (let j = 0; j < FEATURE_COUNT; j++) state.valueWeights[j] = Math.max(-5, Math.min(5, state.valueWeights[j]! + 0.04 * valueError * experience.features[j]! / norm));
        const counts = experience.kind === "bid" ? state.bidActionCounts : state.wordActionCounts;
        counts[experience.action]!++;
        state.valueUpdates++; this.model.updates++;
      }
      this.model.trainedGames++;
      this.beginEpisode();
      return;
    }
    for (const experience of this.experiences) {
      const rows = experience.kind === "bid" ? this.model.bidWeights : this.model.wordWeights;
      const weights = rows[experience.action]!;
      const prediction = weights.reduce((sum, weight, j) => sum + weight * experience.features[j]!, 0);
      const target = Math.max(0, Math.min(10, (finalScore - experience.score) / 100));
      const error = Math.max(-2, Math.min(2, target - prediction));
      const norm = experience.features.reduce((sum, feature) => sum + feature * feature, 0);
      const rate = 0.04 / (1 + this.model.updates / 500_000);
      for (let j = 0; j < weights.length; j++) weights[j] = Math.max(-5, Math.min(5, weights[j]! + rate * error * experience.features[j]! / Math.max(1, norm)));
      this.model.updates++;
    }
    this.model.trainedGames++;
    this.experiences.length = 0;
    this.decisionActions.clear();
  }
}
