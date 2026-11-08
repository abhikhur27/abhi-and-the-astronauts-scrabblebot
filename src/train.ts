import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson } from "./atomic-json.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LETTER_VALUES, WordEngine } from "./engine.js";
import { MathBot, MATH_POLICY_VERSION } from "./math.js";
import { MathBot as MathBotV2 } from "./math-v2.js";
import { DiluteBot } from "./dilute.js";
import { createModel, LearningBot, loadModel, saveModel, type LearnedModel } from "./model.js";
import { simulateMatch } from "./simulator.js";
import type { BotPolicy, DecisionContext } from "./types.js";

class Opponent implements BotPolicy {
  constructor(private readonly engine: WordEngine, private readonly style: "starter" | "cheap" | "hoarder") {}
  decideBid(ctx: DecisionContext): number {
    if (ctx.tilesRemaining <= 0) return 0;
    const value = LETTER_VALUES[ctx.letter] ?? 1;
    const desired = this.style === "cheap" ? 1 : this.style === "hoarder" ? Math.min(5, value + 1) : value + ((ctx.myRack.get(ctx.letter) ?? 0) ? 0 : 2);
    return Math.max(0, Math.min(desired, Math.floor(ctx.myBalance)));
  }
  chooseWord(ctx: DecisionContext): string | null {
    const words = this.engine.playable(ctx.myRack);
    if (!words.length) return null;
    if (this.style === "starter") return [...words].sort((a, b) => b.word.length - a.word.length || b.reward - a.reward)[0]!.word;
    if (this.style === "hoarder" && ctx.tilesRemaining > 4 && words[0]!.word.length < 7 && ctx.myBalance >= 10) return null;
    return words[0]!.word;
  }
}

function lineup(engine: WordEngine, learner: LearningBot, swap = false): BotPolicy[] {
  const pair: BotPolicy[] = swap ? [new MathBot(engine), learner] : [learner, new MathBot(engine)];
  return [...pair, new DiluteBot(engine), new MathBotV2(engine), new Opponent(engine, "starter"), new Opponent(engine, "hoarder")];
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function meanInterval(values: readonly number[]): [number, number] | null {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return [average - margin, average + margin];
}

export function evaluateModel(engine: WordEngine, model: LearnedModel, games: number, seed: number) {
  const before = JSON.stringify(model);
  const learnerScores: number[] = []; const mathScores: number[] = []; const diluteScores: number[] = []; const v2Scores: number[] = []; const pairDifferences: number[] = [];
  let headToHeadWins = 0; let outrightWins = 0; let fractionalWins = 0;
  let pairSum = 0; let pairCount = 0;
  const started = Date.now();
  for (let game = 0; game < games; game++) {
    const swap = game % 2 === 1;
    // Training seeds are in the lower half; evaluation seeds in the upper half.
    const matchSeed = (0x80000000 | ((seed + Math.floor(game / 2)) & 0x7fffffff)) >>> 0;
    const learner = new LearningBot(engine, model);
    const result = simulateMatch({ engine, policies: lineup(engine, learner, swap), seed: matchSeed, auctionType: Math.floor(game / 2) % 2 ? "FirstPrice" : "Vickrey" });
    const own = result.players[swap ? 1 : 0]!.score;
    const fixed = result.players[swap ? 0 : 1]!.score;
    learnerScores.push(own); mathScores.push(fixed);
    diluteScores.push(result.players[2]!.score);
    v2Scores.push(result.players[3]!.score);
    headToHeadWins += own > fixed ? 1 : own === fixed ? 0.5 : 0;
    const top = Math.max(...result.players.map(({ score }) => score));
    const tied = result.players.filter(({ score }) => score === top).length;
    if (own === top) { fractionalWins += 1 / tied; if (tied === 1) outrightWins++; }
    pairSum += own - fixed; pairCount++;
    if (swap || game === games - 1) { pairDifferences.push(pairSum / pairCount); pairSum = 0; pairCount = 0; }
  }
  if (JSON.stringify(model) !== before) throw new Error("Frozen evaluation unexpectedly changed model");
  const ci = meanInterval(pairDifferences);
  return {
    schema: "scrabblebot-evaluation-v1", games, pairedSeeds: pairDifferences.length, seedDomain: "upper-31-bit-held-out", seed,
    modelTrainedGames: model.trainedGames, modelUpdates: model.updates,
    meanLearnerScore: mean(learnerScores), meanMathScore: mean(mathScores), meanScoreDifference: mean(learnerScores.map((score, index) => score - mathScores[index]!)),
    meanDiluteScore: mean(diluteScores), meanFrozenV2Score: mean(v2Scores), policyRevision: MATH_POLICY_VERSION, opponentMixture: [MATH_POLICY_VERSION, "AbhiRL", "AbhiDilute", "frozen-math-v2", "starter", "hoarder"],
    pairedMeanDifference95NormalCI: ci, headToHeadWinRateCountingTiesHalf: headToHeadWins / Math.max(1, games),
    outrightMatchWins: outrightWins, fractionalMatchWinRate: fractionalWins / Math.max(1, games), elapsedSeconds: (Date.now() - started) / 1000,
    promotionEligible: games >= 200 && ci !== null && ci[0] > 0,
    promotionApplied: false,
    limitations: ["External clients with zero network delay; not a full SpacetimeDB integration test", "Internal server padding bots' final-tile automatic word advantage is not modeled", "Mixed synthetic opponents and default5-tile initial racks; live opponents/configuration may differ", "Only learner/math swap seats; Dilute/V2 summaries use fixed seats and are descriptive", "Normal confidence interval over paired seed means is approximate; this evaluation set is not used for gradient updates", "Training return predicts future own score; delayed credit assignment and simulator overfitting can hurt live play"],
  };
}

function atomicJson(path: string, value: unknown): void {
  atomicWriteJson(path, value);
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function numberArgument(name: string, fallback: number, minimum = 1): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isFinite(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}

async function main(): Promise<void> {
  const dictionaryPath = resolve(argument("--dictionary", "data/enable1.txt")!);
  const dictionaryText = readFileSync(dictionaryPath, "utf8");
  const dictionaryHash = createHash("sha256").update(dictionaryText).digest("hex");
  const words = dictionaryText.split(/\r?\n/).map((word) => word.trim().toUpperCase()).filter((word) => /^[A-Z]{2,}$/.test(word));
  const engine = new WordEngine(words);
  const seed = Math.floor(numberArgument("--seed", 20261107, 0));
  const evaluationOnly = process.argv.includes("--evaluate");
  const games = Math.floor(numberArgument("--games", evaluationOnly ? 100 : 1000));
  const resumePath = argument(evaluationOnly ? "--model" : "--resume");
  if (evaluationOnly && !resumePath) throw new Error("--evaluate requires --model PATH");
  const model = resumePath ? loadModel(resolve(resumePath)) : createModel();
  if (model.dictionaryHash && model.dictionaryHash !== dictionaryHash) throw new Error("Checkpoint dictionary hash mismatch");
  if (evaluationOnly) {
    const output = evaluateModel(engine, model, games, seed);
    const path = resolve(argument("--eval-out", join(dirname(resolve(resumePath!)), "evaluation.json"))!);
    atomicJson(path, { ...output, dictionaryHash });
    console.log(JSON.stringify({ ...output, dictionaryHash, evaluationPath: path }));
    return;
  }
  if (model.trainingSeed !== undefined && model.trainingSeed !== seed) throw new Error("Resume seed differs from checkpoint training seed");
  model.dictionaryHash = dictionaryHash; model.trainingSeed = seed;
  const out = resolve(argument("--out", "models/candidate.json")!);
  const progressPath = join(dirname(out), "progress.json");
  const stopFile = resolve(argument("--stop-file", "runs/STOP")!);
  const hours = numberArgument("--hours", 24, 0.000001);
  const checkpointEvery = Math.floor(numberArgument("--checkpoint-every", 20));
  const evalGames = Math.floor(numberArgument("--eval-games", 20, 0));
  let codeSha = "uncommitted";
  try { codeSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* New workspace. */ }
  const started = Date.now(); const startingGames = model.trainedGames;
  let completed = 0; let stopping = false; let lastScore = 0;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  const save = (status: string) => {
    saveModel(out, model);
    const elapsedSeconds = (Date.now() - started) / 1000;
    atomicJson(progressPath, { schema: "scrabblebot-training-progress-v1", status, pid: process.pid, cwd: process.cwd(), startedAt: new Date(started).toISOString(), updatedAt: new Date().toISOString(), completedThisRun: completed, trainedGames: model.trainedGames, updates: model.updates, elapsedSeconds, gamesPerSecond: completed / Math.max(0.001, elapsedSeconds), lastLearnerScore: lastScore, modelPath: out, dictionaryHash, codeSha, trainingSeed: seed, trainingSeedDomain: "lower-31-bit", maximumGamesThisRun: games, maximumHours: hours, stopFile });
  };
  save("running");
  for (; completed < games && Date.now() - started < hours * 3_600_000 && !stopping && !existsSync(stopFile); completed++) {
    const episode = startingGames + completed;
    const matchSeed = (seed + episode) & 0x7fffffff;
    const learner = new LearningBot(engine, model, { training: true, epsilon: Math.max(0.04, 0.2 / Math.sqrt(1 + episode / 1000)), seed: matchSeed ^ 0x51ab73 });
    const result = simulateMatch({ engine, policies: lineup(engine, learner, episode % 2 === 1), seed: matchSeed, auctionType: episode % 2 ? "FirstPrice" : "Vickrey" });
    lastScore = result.players[episode % 2 ? 1 : 0]!.score;
    if ((completed + 1) % checkpointEvery === 0) { completed++; save("running"); completed--; }
    // Give signal handlers a turn between synchronous simulation episodes.
    await new Promise<void>((done) => setImmediate(done));
  }
  save(existsSync(stopFile) || stopping ? "stopped" : "complete");
  let evaluation: ReturnType<typeof evaluateModel> | undefined;
  if (evalGames > 0 && !stopping && !existsSync(stopFile)) {
    evaluation = evaluateModel(engine, model, evalGames, seed ^ 0x517c9);
    atomicJson(join(dirname(out), "evaluation.json"), { ...evaluation, dictionaryHash });
  }
  console.log(JSON.stringify({ status: existsSync(stopFile) || stopping ? "stopped" : "complete", completedThisRun: completed, trainedGames: model.trainedGames, updates: model.updates, modelPath: out, progressPath, evaluation }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
