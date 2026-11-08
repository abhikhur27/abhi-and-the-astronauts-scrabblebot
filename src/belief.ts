import { BAG_COUNTS } from "./engine.js";
import type { BeliefSample, OpponentEstimate, PublicInformation, Rack } from "./types.js";

export interface BeliefAuction {
  id: string;
  letter: string;
  opensAtMicros: bigint;
  closesAtMicros?: bigint;
  winnerBotId?: string;
  paid?: number;
  closedAtMicros?: bigint;
}
export interface BeliefWord { id: string; botId: string; word: string; playedAtMicros: bigint; }
export interface BeliefObservation {
  myRack: Rack;
  bagCount: number;
  currentAuction?: { id: string; letter: string; opensAtMicros: bigint };
  auctions: readonly BeliefAuction[];
  words: readonly BeliefWord[];
  completeHistory: boolean;
}
export interface BeliefTrackerOptions {
  myBotId: string;
  playerIds: readonly string[];
  startingRackSize: number;
  particles?: number;
  seed?: number;
  initialBag?: Rack;
}

const empty = () => Array<number>(26).fill(0);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const code = (letter: string) => letter.charCodeAt(0) - 65;
const letterAt = (index: number) => String.fromCharCode(index + 65);
function asRack(values: readonly number[]): Map<string, number> {
  return new Map(values.flatMap((amount, index) => amount > 0 ? [[letterAt(index), amount] as const] : []));
}
function counts(rack: Rack): number[] | null {
  const result = empty();
  for (const [letter, amount] of rack) {
    if (!Number.isInteger(amount) || amount < 0 || !/^[A-Z]$/.test(letter)) return null;
    result[code(letter)] = amount;
  }
  return result;
}
function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const position = (values.length - 1) * fraction;
  const index = Math.floor(position);
  return values[index]! + (values[Math.ceil(position)]! - values[index]!) * (position - index);
}
function signatureHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function randomSource(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
function draw(pool: number[], total: number, random: () => number): number {
  let offset = Math.floor(random() * total);
  for (let i = 0; i < 26; i++) {
    if (offset < pool[i]!) { pool[i]!--; return i; }
    offset -= pool[i]!;
  }
  throw new Error("Unreachable: conserved belief pool is empty");
}

// The posterior conditions on public tile conservation and word feasibility.
// It does not pretend to know opponents' decision-making likelihoods or tiles.
export class PublicBeliefTracker {
  private readonly options: BeliefTrackerOptions;
  private readonly inventory: number[];
  private readonly opponents: readonly string[];
  private readonly participantIds: ReadonlySet<string>;
  private readonly particleCount: number;
  private lastKey = "";
  private lastResult?: PublicInformation;

  constructor(options: BeliefTrackerOptions) {
    this.options = options;
    const inventory = counts(options.initialBag ?? new Map(Object.entries(BAG_COUNTS)));
    if (!inventory || !Number.isInteger(options.startingRackSize) || options.startingRackSize < 0) {
      throw new Error("Invalid public initial tile distribution or rack size");
    }
    this.inventory = inventory;
    this.opponents = [...new Set(options.playerIds)].filter(id => id !== options.myBotId).sort();
    this.participantIds = new Set([options.myBotId, ...this.opponents]);
    this.particleCount = Math.max(1, Math.min(2048, Math.floor(options.particles ?? 128)));
  }

  observe(observation: BeliefObservation): PublicInformation {
    let valid = true;
    const auctionMap = new Map<string, BeliefAuction>();
    const sourceAuctions: readonly BeliefAuction[] = observation.currentAuction ? [...observation.auctions, observation.currentAuction] : observation.auctions;
    for (const row of sourceAuctions) {
      if (!/^[A-Z]$/.test(row.letter) || typeof row.opensAtMicros !== "bigint" ||
        (row.closesAtMicros !== undefined && typeof row.closesAtMicros !== "bigint") ||
        (row.closedAtMicros !== undefined && typeof row.closedAtMicros !== "bigint")) valid = false;
      const previous = auctionMap.get(row.id);
      if (previous && (previous.letter !== row.letter || previous.opensAtMicros !== row.opensAtMicros ||
        (previous.winnerBotId !== undefined && row.winnerBotId !== undefined && previous.winnerBotId !== row.winnerBotId))) valid = false;
      auctionMap.set(row.id, {
        ...previous, ...row,
        winnerBotId: row.winnerBotId ?? previous?.winnerBotId,
        paid: row.paid ?? previous?.paid,
        closesAtMicros: row.closesAtMicros ?? previous?.closesAtMicros,
        closedAtMicros: row.closedAtMicros ?? previous?.closedAtMicros,
      });
    }
    const wordMap = new Map<string, BeliefWord>();
    for (const row of observation.words) {
      if (!/^[A-Z]{2,}$/.test(row.word) || typeof row.playedAtMicros !== "bigint") valid = false;
      const previous = wordMap.get(row.id);
      if (previous && (previous.word !== row.word || previous.botId !== row.botId || previous.playedAtMicros !== row.playedAtMicros)) valid = false;
      wordMap.set(row.id, row);
    }
    const auctions = [...auctionMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const words = [...wordMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const key = JSON.stringify([valid, observation.completeHistory, observation.bagCount,
      [...observation.myRack].sort(([a], [b]) => a.localeCompare(b)), observation.currentAuction?.id,
      auctions.map(a => [a.id, a.letter, String(a.opensAtMicros), String(a.closesAtMicros), a.winnerBotId, a.paid, String(a.closedAtMicros)]),
      words.map(w => [w.id, w.botId, w.word, String(w.playedAtMicros)])]);
    if (key === this.lastKey && this.lastResult) return this.lastResult;

    const payments = auctions.filter(a => a.id !== observation.currentAuction?.id && Number.isFinite(a.paid) && a.paid! > 0)
      .map(a => a.paid!).sort((a, b) => a - b);
    const market = {medianPayment: percentile(payments, 0.5), p75Payment: percentile(payments, 0.75), samples: payments.length};
    const fallback: PublicInformation = {consistent: false, completeHistory: observation.completeHistory, knownOwnInitial: false,
      bagCount: observation.bagCount, observedAuctionCount: auctions.length, expectedBag: new Map(), bagMinimum: new Map(),
      bagMaximum: new Map(), opponents: [], samples: [], effectiveSampleSize: 0, market};
    const finish = (result: PublicInformation): PublicInformation => {
      this.lastKey = key; this.lastResult = result; return result;
    };
    const own = counts(observation.myRack);
    if (!valid || !own || !observation.completeHistory || !Number.isInteger(observation.bagCount) || observation.bagCount < 0) return finish(fallback);

    // Prefix minima retain evidence of initial letters even if later purchases
    // replace them. Sorting only final net counts would lose that evidence.
    const deltas = new Map([...this.participantIds].map(id => [id, empty()]));
    const minima = new Map([...this.participantIds].map(id => [id, empty()]));
    const events: {at: bigint; order: number; id: string; botId: string; letters: string; direction: number}[] = [];
    const revealed = empty();
    for (const row of auctions) {
      revealed[code(row.letter)]!++;
      if (row.winnerBotId !== undefined && row.id !== observation.currentAuction?.id) {
        events.push({at: row.closedAtMicros ?? row.closesAtMicros ?? row.opensAtMicros,
          order: 0, id: row.id, botId: row.winnerBotId, letters: row.letter, direction: 1});
      }
    }
    for (const row of words) events.push({at: row.playedAtMicros, order: 1, id: row.id, botId: row.botId, letters: row.word, direction: -1});
    events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id.localeCompare(b.id));
    for (const event of events) {
      const delta = deltas.get(event.botId);
      const minimum = minima.get(event.botId);
      if (!delta || !minimum) return finish(fallback);
      for (const letter of event.letters) {
        const index = code(letter);
        delta[index]! += event.direction;
        minimum[index] = Math.max(minimum[index]!, -delta[index]!);
      }
    }
    const ownDelta = deltas.get(this.options.myBotId)!;
    const ownMinimum = minima.get(this.options.myBotId)!;
    const ownInitial = own.map((amount, index) => amount - ownDelta[index]!);
    if (sum(ownInitial) !== this.options.startingRackSize || ownInitial.some((amount, i) => amount < ownMinimum[i]!)) return finish(fallback);
    fallback.knownOwnInitial = true;
    const unseen = this.inventory.map((amount, index) => amount - ownInitial[index]! - revealed[index]!);
    if (unseen.some(amount => amount < 0) || sum(unseen) !== this.opponents.length * this.options.startingRackSize + observation.bagCount) return finish(fallback);
    const residual = [...unseen];
    const slots: number[] = [];
    for (const id of this.opponents) {
      const minimum = minima.get(id)!;
      const remaining = this.options.startingRackSize - sum(minimum);
      if (remaining < 0) return finish(fallback);
      slots.push(remaining);
      for (let i = 0; i < 26; i++) residual[i]! -= minimum[i]!;
    }
    if (residual.some(amount => amount < 0)) return finish(fallback);
    const residualTotal = sum(residual);
    if (residualTotal !== sum(slots) + observation.bagCount) return finish(fallback);

    // Each remaining initial-hand slot and bag slot can contain any residual
    // physical tile. These are exact marginal feasible bounds, independent of
    // whether a finite particle sample happened to include an extreme.
    const bounds = (count: number) => ({
      low: residual.map(amount => Math.max(0, count - (residualTotal - amount))),
      high: residual.map(amount => Math.min(count, amount)),
    });
    const bagBounds = bounds(observation.bagCount);
    const estimates: OpponentEstimate[] = this.opponents.map((id, j) => {
      const minimum = minima.get(id)!;
      const delta = deltas.get(id)!;
      const bound = bounds(slots[j]!);
      return {botId: id, rackSize: this.options.startingRackSize + sum(delta),
        initialMinimum: asRack(minimum.map((amount, i) => amount + bound.low[i]!)),
        rackMinimum: asRack(minimum.map((amount, i) => amount + bound.low[i]! + delta[i]!)),
        rackMaximum: asRack(minimum.map((amount, i) => amount + bound.high[i]! + delta[i]!)),
        rackMean: new Map()};
    });

    const random = randomSource((this.options.seed ?? 0xc0ffee) ^ signatureHash(key));
    const logFactorial = [0];
    for (let n = 1; n <= this.options.startingRackSize; n++) logFactorial[n] = logFactorial[n - 1]! + Math.log(n);
    const provisional: {bag: number[]; hands: number[][]; logWeight: number}[] = [];
    for (let particle = 0; particle < this.particleCount; particle++) {
      const pool = [...residual];
      let total = residualTotal;
      let logWeight = 0;
      const hands = this.opponents.map((id, j) => {
        const minimum = minima.get(id)!;
        const extra = empty();
        for (let tile = 0; tile < slots[j]!; tile++) extra[draw(pool, total--, random)]!++;
        // Proposal allocates mandatory minimum tiles first. Correct its bias:
        // target/proposal ∝ product ((H-L)! / H!), over opponents and letters.
        for (let i = 0; i < 26; i++) logWeight += logFactorial[extra[i]!]! - logFactorial[extra[i]! + minimum[i]!]!;
        const delta = deltas.get(id)!;
        return extra.map((amount, i) => amount + minimum[i]! + delta[i]!);
      });
      provisional.push({bag: pool, hands, logWeight});
    }
    const maxLog = Math.max(...provisional.map(sample => sample.logWeight));
    const denominator = provisional.reduce((total, sample) => total + Math.exp(sample.logWeight - maxLog), 0);
    const bagMean = empty();
    const handMeans = this.opponents.map(() => empty());
    let squaredWeights = 0;
    const samples: BeliefSample[] = provisional.map(sample => {
      const weight = Math.exp(sample.logWeight - maxLog) / denominator;
      squaredWeights += weight * weight;
      for (let i = 0; i < 26; i++) bagMean[i]! += weight * sample.bag[i]!;
      for (let j = 0; j < this.opponents.length; j++) for (let i = 0; i < 26; i++) handMeans[j]![i]! += weight * sample.hands[j]![i]!;
      return {weight, bag: asRack(sample.bag), opponentRacks: new Map(this.opponents.map((id, j) => [id, asRack(sample.hands[j]!)]))};
    });
    for (let j = 0; j < estimates.length; j++) estimates[j]!.rackMean = asRack(handMeans[j]!);
    return finish({consistent: true, completeHistory: true, knownOwnInitial: true, bagCount: observation.bagCount,
      observedAuctionCount: auctions.length, expectedBag: asRack(bagMean), bagMinimum: asRack(bagBounds.low),
      bagMaximum: asRack(bagBounds.high), opponents: estimates, samples, effectiveSampleSize: 1 / squaredWeights, market});
  }
}
