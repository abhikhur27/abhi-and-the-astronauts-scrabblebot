import { LETTER_VALUES, WordEngine } from "./engine.js";
import { MathBot as MathV2, MATH_POLICY_VERSION as V2_VERSION } from "./math-v2.js";
import type { DecisionContext, Rack } from "./types.js";

export type DilutePhase = "early" | "middle" | "late";
export interface BidObservation {
  matchId: number;
  botId: number;
  letter: string;
  rack: Readonly<Record<string, number>>;
  balance: number;
  remainingAuctions: number;
  paid: number;
  bidLabel: { type: string; amount: number };
  wordDuringAuction: boolean;
  teacher?: string;
  score?: number;
  auctionType?: "Vickrey" | "FirstPrice";
  round?: number;
  totalAuctions?: number;
  opponentCount?: number;
  split?: "train" | "validation";
}
export interface PhasePrior {
  count: number;
  bid: number;
  vowelBid: number;
  consonantBid: number;
  cash: number;
  payment: number;
  bidFraction: number;
}
export interface DiluteBidProfile {
  schema: "dilute-winner-conditional-logbid-v1";
  weights: readonly number[];
  phases: Readonly<Record<DilutePhase, PhasePrior>>;
}

export function dilutePhase(remaining: number): DilutePhase {
  return remaining >= 45 ? "early" : remaining >= 22 ? "middle" : "late";
}

/** Causal at inference: only our own current rack, cash and public horizon. */
export function diluteBidFeatures(letter: string, rack: Rack, balance: number, remaining: number): number[] {
  let size = 0; let vowels = 0; let repeated = 0;
  for (const [tile, count] of rack) {
    if (!Number.isFinite(count) || count <= 0) continue;
    size += count;
    vowels += "AEIOU".includes(tile) ? count : 0;
    repeated += Math.max(0, count - 1);
  }
  const isVowel = "AEIOU".includes(letter) && letter.length === 1 ? 1 : 0;
  const fraction = vowels / Math.max(1, size);
  const phase = dilutePhase(remaining);
  return [1, (LETTER_VALUES[letter] ?? 0) / 10, isVowel,
    Math.sqrt(Math.max(0, Math.min(300, balance)) / 100),
    Math.min(20, size) / 10, Math.max(0, Math.min(1, 1 - remaining / 68)),
    fraction, Math.min(4, rack.get(letter) ?? 0) / 3,
    isVowel * Math.max(0, 0.35 - fraction), repeated / Math.max(1, size),
    phase === "middle" ? 1 : 0, phase === "late" ? 1 : 0];
}

export function predictDiluteWinningBid(profile: DiluteBidProfile, letter: string, rack: Rack, balance: number, remaining: number): number {
  const features = diluteBidFeatures(letter, rack, balance, remaining);
  const fitted = Math.expm1(Math.max(0, Math.min(5, profile.weights.reduce((sum, w, i) => sum + w * features[i]!, 0))));
  const prior = profile.phases[dilutePhase(remaining)];
  const group = "AEIOU".includes(letter) ? prior.vowelBid : prior.consonantBid;
  return 0.75 * fitted + 0.25 * group;
}

function median(values: readonly number[], fallback = 0): number {
  if (!values.length) return fallback;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Offline calibration only. Whole match IDs divisible by five are excluded. */
export function fitDiluteBidProfile(rows: readonly BidObservation[]): DiluteBidProfile {
  const train = rows.filter(row => [114, 171].includes(row.botId)
    && row.matchId % 5 !== 0 && !row.wordDuringAuction
    && row.bidLabel.type === "exact-winner-bid" && Number.isFinite(row.bidLabel.amount)
    && row.bidLabel.amount > 0 && row.bidLabel.amount <= row.balance);
  if (!train.length) throw new Error("No eligible training bids");
  const n = 12;
  const system = Array.from({ length: n }, () => Array<number>(n + 1).fill(0));
  for (const row of train) {
    const x = diluteBidFeatures(row.letter, new Map(Object.entries(row.rack)), row.balance, row.remainingAuctions);
    const target = Math.log1p(row.bidLabel.amount);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) system[i]![j]! += x[i]! * x[j]!;
      system[i]![n]! += x[i]! * target;
    }
  }
  for (let i = 1; i < n; i++) system[i]![i]! += 2;
  // Ridge with an unpenalized intercept; partial pivoting keeps small fits stable.
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(system[j]![i]!) > Math.abs(system[pivot]![i]!)) pivot = j;
    [system[i], system[pivot]] = [system[pivot]!, system[i]!];
    const divisor = system[i]![i]!;
    if (Math.abs(divisor) < 1e-10) throw new Error("Singular teacher calibration");
    for (let j = i; j <= n; j++) system[i]![j]! /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === i) continue;
      const factor = system[row]![i]!;
      for (let j = i; j <= n; j++) system[row]![j]! -= factor * system[i]![j]!;
    }
  }
  const phases = {} as Record<DilutePhase, PhasePrior>;
  for (const phase of ["early", "middle", "late"] as const) {
    const group = train.filter(row => dilutePhase(row.remainingAuctions) === phase);
    const bids = group.map(row => row.bidLabel.amount);
    const allBid = median(bids, median(train.map(row => row.bidLabel.amount)));
    phases[phase] = {
      count: group.length, bid: allBid,
      vowelBid: median(group.filter(row => "AEIOU".includes(row.letter)).map(row => row.bidLabel.amount), allBid),
      consonantBid: median(group.filter(row => !"AEIOU".includes(row.letter)).map(row => row.bidLabel.amount), allBid),
      cash: median(group.map(row => row.balance), 50),
      payment: median(group.map(row => row.paid), 10),
      bidFraction: median(group.map(row => row.bidLabel.amount / Math.max(1, row.balance)), 0.3),
    };
  }
  return { schema: "dilute-winner-conditional-logbid-v1", weights: system.map(row => row[n]!), phases };
}

// Generated only from eligible training match IDs. Refit with the function above;
// no historical racks, event archives or large ignored files are read at runtime.
/** @deprecated Historical selected-winner price fit; never used by Dilute V2. */
export const DILUTE_BID_PROFILE: DiluteBidProfile = {
  schema: "dilute-winner-conditional-logbid-v1",
  weights: [2.0659484599330478, 0.7956924752698864, -0.016184815819337516,
    0.5507904555217544, 0.06039294447391056, 0.08937471586549747,
    0.06815711200733784, -0.26510872445633726, 0.08407101491997186,
    0.07312338136816116, 0.06887217719978644, 0.04125494815871396],
  phases: {
    early: { count: 88, bid: 16, vowelBid: 12, consonantBid: 19, cash: 87, payment: 13, bidFraction: 0.19 },
    middle: { count: 139, bid: 14, vowelBid: 14, consonantBid: 16, cash: 57, payment: 12, bidFraction: 0.2714285714285714 },
    late: { count: 173, bid: 13, vowelBid: 12, consonantBid: 14, cash: 28, payment: 9, bidFraction: 0.5714285714285714 },
  },
};

export interface DiluteResidualProfile {
  schema: "dilute-v2-bid-residual-v1";
  anchorVersion: "v2-cash-pacing";
  featureVersion: "phase-composition-v1";
  provenance: "public-completed-teacher-own-rack-winner-conditional";
  generatedAt: string;
  dictionaryHash: string;
  cutoffMatchId: number;
  teachers: readonly { botId: number; name: string; exactBids: number }[];
  trainMatchIds: readonly number[];
  validationMatchIds: readonly number[];
  trainRows: number;
  validationRows: number;
  skippedZeroAnchor: number;
  phaseSupport: readonly number[];
  weights: readonly number[];
  maxBidShift: number;
  validation: { anchorLogMae: number; residualLogMae: number; calibrated: boolean };
}

export interface DiluteFitOptions {
  dictionaryHash: string;
  generatedAt?: string;
  teacherIds?: readonly number[];
  cutoffMatchId?: number;
}

function residualPhase(progress: number): number { return progress < 1 / 3 ? 0 : progress < 2 / 3 ? 1 : 2; }

/** Fractional public progress; the fallback is a prior, never a play-time rule. */
export function diluteProgress(ctx: DecisionContext): number {
  const observed = ctx.information?.observedAuctionCount ?? 0;
  const total = observed > 0 ? observed + Math.max(0, ctx.tilesRemaining) : 68;
  return Math.max(0, Math.min(1, 1 - Math.max(0, ctx.tilesRemaining) / Math.max(1, total)));
}

export function diluteResidualFeatures(ctx: DecisionContext, anchorBid: number, progress = diluteProgress(ctx)): number[] {
  let size = 0; let vowels = 0; let repeated = 0;
  for (const [tile, count] of ctx.myRack) {
    if (!Number.isFinite(count) || count <= 0) continue;
    size += count; repeated += Math.max(0, count - 1);
    if ("AEIOU".includes(tile)) vowels += count;
  }
  const phase = residualPhase(progress);
  return [1, progress, phase === 1 ? 1 : 0, phase === 2 ? 1 : 0,
    (LETTER_VALUES[ctx.letter] ?? 0) / 10, "AEIOU".includes(ctx.letter) && ctx.letter.length === 1 ? 1 : 0,
    Math.sqrt(Math.max(0, Math.min(300, ctx.myBalance)) / 100), Math.min(20, size) / 10,
    vowels / Math.max(1, size), Math.min(4, ctx.myRack.get(ctx.letter) ?? 0) / 3,
    repeated / Math.max(1, size), anchorBid / Math.max(1, ctx.myBalance)];
}

export function predictDiluteResidual(profile: DiluteResidualProfile, ctx: DecisionContext, anchorBid: number): number {
  const phase = residualPhase(diluteProgress(ctx));
  if ((profile.phaseSupport[phase] ?? 0) < 8) return 0;
  const features = diluteResidualFeatures(ctx, anchorBid);
  const predicted = profile.weights.reduce((sum, weight, i) => sum + weight * features[i]!, 0);
  const bound = Math.log1p(profile.maxBidShift);
  return Math.max(-bound, Math.min(bound, predicted));
}

/** Fail closed. Calibration eligibility is not a game-strength promotion. */
export function validateDiluteResidualProfile(value: unknown, dictionaryHash?: string): DiluteResidualProfile | null {
  if (!value || typeof value !== "object") return null;
  const p = value as DiluteResidualProfile;
  if (p.schema !== "dilute-v2-bid-residual-v1" || p.anchorVersion !== V2_VERSION
    || p.featureVersion !== "phase-composition-v1"
    || p.provenance !== "public-completed-teacher-own-rack-winner-conditional"
    || !Number.isFinite(Date.parse(p.generatedAt)) || !/^[a-f0-9]{64}$/.test(p.dictionaryHash)
    || (dictionaryHash !== undefined && p.dictionaryHash !== dictionaryHash)
    || !Number.isSafeInteger(p.cutoffMatchId) || p.cutoffMatchId < 1
    || !Number.isSafeInteger(p.trainRows) || p.trainRows < 40
    || !Number.isSafeInteger(p.validationRows) || p.validationRows < 12
    || !Number.isSafeInteger(p.skippedZeroAnchor) || p.skippedZeroAnchor < 0
    || !Number.isFinite(p.maxBidShift) || p.maxBidShift <= 0 || p.maxBidShift > 0.15) return null;
  if (!Array.isArray(p.weights) || p.weights.length !== 12 || p.weights.some(w => !Number.isFinite(w) || Math.abs(w) > 2)
    || !Array.isArray(p.phaseSupport) || p.phaseSupport.length !== 3 || p.phaseSupport.some(n => !Number.isSafeInteger(n) || n < 0)
    || p.phaseSupport.reduce((sum, n) => sum + n, 0) !== p.trainRows) return null;
  if (!Array.isArray(p.trainMatchIds) || !Array.isArray(p.validationMatchIds)
    || new Set(p.trainMatchIds).size < 3 || new Set(p.validationMatchIds).size < 2
    || [...p.trainMatchIds, ...p.validationMatchIds].some(id => !Number.isSafeInteger(id) || id < 1 || id > p.cutoffMatchId)
    || p.validationMatchIds.some(id => p.trainMatchIds.includes(id))) return null;
  if (!Array.isArray(p.teachers) || !p.teachers.length || p.teachers.some(t => !t || !Number.isSafeInteger(t.botId)
    || typeof t.name !== "string" || t.name.length > 120 || !Number.isSafeInteger(t.exactBids) || t.exactBids < 1)) return null;
  const calibration = p.validation;
  if (!calibration || !calibration.calibrated || !Number.isFinite(calibration.anchorLogMae)
    || !Number.isFinite(calibration.residualLogMae) || calibration.residualLogMae < 0
    || calibration.residualLogMae > calibration.anchorLogMae) return null;
  return JSON.parse(JSON.stringify(p)) as DiluteResidualProfile;
}

/** Offline only: reconstruct the teacher's V2 action, then fit a bounded ratio. */
export function fitDiluteResidualProfile(rows: readonly BidObservation[], engine: WordEngine, options: DiluteFitOptions): DiluteResidualProfile {
  if (!/^[a-f0-9]{64}$/.test(options.dictionaryHash)) throw new Error("A dictionary SHA-256 is required");
  const selected = rows.filter(row => !options.teacherIds || options.teacherIds.includes(row.botId));
  const matchSplits = new Map<number, "train" | "validation">();
  for (const row of selected) {
    const split = row.split ?? (row.matchId % 5 === 0 ? "validation" : "train");
    const prior = matchSplits.get(row.matchId);
    if (prior && prior !== split) throw new Error("One match crosses training and validation");
    matchSplits.set(row.matchId, split);
  }
  const anchor = new MathV2(engine);
  const samples: { row: BidObservation; features: number[]; target: number; phase: number; split: "train" | "validation" }[] = [];
  let skippedZeroAnchor = 0;
  for (const row of selected) {
    if (row.wordDuringAuction || row.bidLabel.type !== "exact-winner-bid"
      || !Number.isFinite(row.bidLabel.amount) || row.bidLabel.amount <= 0 || row.bidLabel.amount > row.balance
      || !Number.isFinite(row.remainingAuctions) || row.remainingAuctions <= 1) continue;
    const ctx: DecisionContext = { myRack: new Map(Object.entries(row.rack)), myBalance: row.balance,
      myScore: row.score ?? 0, letter: row.letter, tilesRemaining: row.remainingAuctions,
      auctionType: row.auctionType ?? "Vickrey",
      opponents: Array.from({ length: Math.max(0, Math.min(20, row.opponentCount ?? 5)) }, () => ({ balance: 100, score: 0 })) };
    const base = anchor.decideBid(ctx);
    if (base <= 0) { skippedZeroAnchor++; continue; }
    const total = row.totalAuctions ?? (row.round !== undefined ? row.round + row.remainingAuctions : 68);
    const progress = Math.max(0, Math.min(1, 1 - row.remainingAuctions / Math.max(1, total)));
    samples.push({ row, features: diluteResidualFeatures(ctx, base, progress),
      target: Math.log(row.bidLabel.amount / base), phase: residualPhase(progress), split: matchSplits.get(row.matchId)! });
  }
  const train = samples.filter(sample => sample.split === "train");
  if (!train.length) throw new Error("No positive V2 anchor training bids");
  const n = 12; const bound = Math.log1p(0.15);
  const system = Array.from({ length: n }, () => Array<number>(n + 1).fill(0));
  for (const sample of train) {
    const y = Math.max(-bound, Math.min(bound, sample.target));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) system[i]![j]! += sample.features[i]! * sample.features[j]!;
      system[i]![n]! += sample.features[i]! * y;
    }
  }
  // Penalize even the intercept: selected winning bids should not turn into a
  // universal permanent uplift merely because the losing sample is censored.
  for (let i = 0; i < n; i++) system[i]![i]! += 8;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(system[j]![i]!) > Math.abs(system[pivot]![i]!)) pivot = j;
    [system[i], system[pivot]] = [system[pivot]!, system[i]!];
    const divisor = system[i]![i]!;
    for (let j = i; j <= n; j++) system[i]![j]! /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === i) continue;
      const factor = system[row]![i]!;
      for (let j = i; j <= n; j++) system[row]![j]! -= factor * system[i]![j]!;
    }
  }
  const weights = system.map(row => row[n]!);
  const validation = samples.filter(sample => sample.split === "validation");
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const anchorLogMae = average(validation.map(sample => Math.abs(sample.target)));
  const residualLogMae = average(validation.map(sample => Math.abs(sample.target - Math.max(-bound, Math.min(bound,
    weights.reduce((sum, weight, i) => sum + weight * sample.features[i]!, 0))))));
  const phaseSupport = [0, 0, 0]; for (const sample of train) phaseSupport[sample.phase]!++;
  const teacherIds = [...new Set(samples.map(sample => sample.row.botId))];
  return { schema: "dilute-v2-bid-residual-v1", anchorVersion: V2_VERSION,
    featureVersion: "phase-composition-v1", provenance: "public-completed-teacher-own-rack-winner-conditional",
    generatedAt: options.generatedAt ?? new Date().toISOString(), dictionaryHash: options.dictionaryHash,
    cutoffMatchId: options.cutoffMatchId ?? Math.max(...selected.map(row => row.matchId)),
    teachers: teacherIds.map(botId => ({ botId, name: samples.find(sample => sample.row.botId === botId)?.row.teacher ?? String(botId),
      exactBids: samples.filter(sample => sample.row.botId === botId).length })),
    trainMatchIds: [...matchSplits].filter(([, split]) => split === "train").map(([id]) => id).sort((a, b) => a - b),
    validationMatchIds: [...matchSplits].filter(([, split]) => split === "validation").map(([id]) => id).sort((a, b) => a - b),
    trainRows: train.length, validationRows: validation.length, skippedZeroAnchor, phaseSupport, weights, maxBidShift: 0.15,
    validation: { anchorLogMae, residualLogMae, calibrated: validation.length >= 12 && residualLogMae <= anchorLogMae } };
}
