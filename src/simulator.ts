import { canSpell, WordEngine, wordReward } from "./engine.js";
import { PublicBeliefTracker, type BeliefAuction, type BeliefWord } from "./belief.js";
import type { AuctionType, BotPolicy, DecisionContext } from "./types.js";

export const TILE_DISTRIBUTION: readonly (readonly [string, number])[] = [["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3], ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6], ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4], ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1]];

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
}

export function resolveAuction(bids: readonly number[], balances: readonly number[], auctionType: AuctionType, random: () => number): { winner: number | null; paid: number } {
  const valid = bids.map((amount, index) => ({ amount, index })).filter(({ amount, index }) => Number.isSafeInteger(amount) && amount > 0 && amount <= (balances[index] ?? 0));
  if (!valid.length) return { winner: null, paid: 0 };
  valid.sort((a, b) => b.amount - a.amount);
  const tied = valid.filter((bid) => bid.amount === valid[0]!.amount);
  const winner = tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]!;
  const others = valid.filter((bid) => bid.index !== winner.index);
  const paid = auctionType === "FirstPrice" ? winner.amount : others[0]?.amount ?? Math.min(1, winner.amount);
  return { winner: winner.index, paid };
}

export interface SimPlayer { rack: Map<string, number>; balance: number; score: number; spent: number; words: string[]; }
export interface MatchResult { players: SimPlayer[]; auctions: number; auctionType: AuctionType; seed: number; }
export interface SimulationOptions {
  engine: WordEngine;
  policies: readonly BotPolicy[];
  seed: number;
  auctionType?: AuctionType;
  startingRackSize?: number;
  startingRacks?: readonly string[];
  /** Explicit bag order for fixtures; default uses a seeded shuffled standard bag. */
  bag?: readonly string[];
  /** Posterior scenarios per observer; bounded default keeps offline training practical. */
  beliefParticles?: number;
}

/** External-client simulator: bids precede word actions, with bounded own-state revisions. */
export function simulateMatch(options: SimulationOptions): MatchResult {
  const { engine, policies, seed } = options;
  if (!policies.length) throw new Error("At least one policy is required");
  const auctionType = options.auctionType ?? "Vickrey";
  const random = seededRandom(seed);
  const bag: string[] = options.bag ? [...options.bag] : TILE_DISTRIBUTION.flatMap(([letter, count]) => Array<string>(count).fill(letter));
  // This is the declared distribution, not a peek at the future order. Custom
  // fixtures may supply nonstandard tiles; their aggregate is public game config.
  const initialBag = new Map<string, number>();
  for (const letter of [...bag, ...(options.startingRacks ?? []).join("")]) initialBag.set(letter, (initialBag.get(letter) ?? 0) + 1);
  if (!options.bag) {
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [bag[i], bag[j]] = [bag[j]!, bag[i]!]; }
  }
  const players = policies.map((policy, index): SimPlayer => {
    const rack = new Map<string, number>();
    const letters = options.startingRacks ? [...(options.startingRacks[index] ?? "")] : bag.splice(0, options.startingRackSize ?? 5);
    for (const letter of letters) rack.set(letter, (rack.get(letter) ?? 0) + 1);
    (policy as BotPolicy & { beginEpisode?: () => void }).beginEpisode?.();
    return { rack, balance: 100, score: 0, spent: 0, words: [] };
  });
  const playerIds = players.map((_, index) => String(index));
  const startingRackSize = options.startingRacks?.[0]?.length ?? options.startingRackSize ?? 5;
  const trackers = playerIds.map((myBotId, index) => new PublicBeliefTracker({
    myBotId, playerIds, startingRackSize, initialBag,
    // Observer randomness must be independent of the hidden deck/tie seed.
    // Public-prefix hashing inside the tracker supplies state-specific variety.
    particles: options.beliefParticles ?? 32, seed: ((index + 1) * 0x51ab73) >>> 0,
  }));
  const publicAuctions: BeliefAuction[] = [];
  const publicWords: BeliefWord[] = [];
  let currentAuction: { id: string; letter: string; opensAtMicros: bigint } | undefined;
  let wordTick = 0n;
  let currentBids: number[] = [];
  let bidDecisions: number[] = [];
  const context = (index: number, letter: string, remaining: number): DecisionContext => {
    const me = players[index]!;
    const myRack = new Map(me.rack);
    return { letter, myRack, myBalance: me.balance, myScore: me.score, tilesRemaining: remaining, auctionType,
      myBotId: String(index), committedBid: currentBids[index],
      // Every policy in this simulator has the external-client final cutoff.
      // This flag is public configuration, independent of racks or deck order.
      opponents: players.flatMap(({ balance, score }, other) => other === index ? [] : [{ botId: String(other), balance, score,isSimulated:false }]),
      information: trackers[index]!.observe({ myRack, bagCount: remaining, currentAuction,
        auctions: publicAuctions, words: publicWords, completeHistory: true }),
    };
  };
  const playWords = (letter: string, remaining: number) => {
    for (let index = 0; index < players.length; index++) {
      const me = players[index]!;
      // At most one success per tile owned; stops malicious endless policies.
      for (let attempt = 0; attempt < 98; attempt++) {
        const word = policies[index]!.chooseWord(context(index, letter, remaining));
        if (!word) break;
        const upper = word.toUpperCase();
        if (!/^[A-Z]{2,}$/.test(upper) || !canSpell(upper, me.rack) || !engine.playable(me.rack).some((candidate) => candidate.word === upper)) break;
        for (const char of upper) {
          const count = me.rack.get(char)! - 1;
          if (count) me.rack.set(char, count); else me.rack.delete(char);
        }
        const reward = wordReward(upper);
        me.balance += reward; me.score += reward; me.words.push(upper);
        publicWords.push({ id: String(publicWords.length + 1), botId: String(index), word: upper,
          playedAtMicros: currentAuction!.opensAtMicros + ++wordTick });
        // A confirmed own word changes both the rack and available cash. The
        // replacement decision sees the previous commitment, never rival bids.
        if (bidDecisions[index]! < 3) {
          const replacement = policies[index]!.decideBid(context(index, letter, remaining));
          bidDecisions[index] = bidDecisions[index]! + 1;
          currentBids[index] = replacement;
        }
      }
    }
  };
  let auctions = 0;
  while (bag.length) {
    const letter = bag.shift()!;
    const remaining = bag.length;
    currentAuction = { id: String(auctions + 1), letter, opensAtMicros: BigInt(auctions + 1) * 1_000_000n };
    wordTick = 0n;
    // Like the live adapter, submit the initial bids before considering cashouts.
    // The assignment happens after map completes, hiding every initial bid.
    currentBids = [];
    bidDecisions = policies.map(() => 1);
    currentBids = policies.map((policy, index) => policy.decideBid(context(index, letter, remaining)));
    // Initial racks and the previous award can be played while this auction is open.
    playWords(letter, remaining);
    const result = resolveAuction(currentBids, players.map(({ balance }) => balance), auctionType, random);
    if (result.winner !== null) {
      const player = players[result.winner]!;
      player.balance -= result.paid; player.spent += result.paid;
      player.rack.set(letter, (player.rack.get(letter) ?? 0) + 1);
    }
    publicAuctions.push({ ...currentAuction, closesAtMicros: currentAuction.opensAtMicros + 999_999n,
      closedAtMicros: currentAuction.opensAtMicros + 999_999n,
      ...(result.winner !== null ? { winnerBotId: String(result.winner) } : {}), paid: result.paid });
    auctions++;
    // No external client can play the final tile before the atomic Ended update.
  }
  policies.forEach((policy, index) => (policy as BotPolicy & { finishEpisode?: (score: number) => void }).finishEpisode?.(players[index]!.score));
  return { players, auctions, auctionType, seed };
}
