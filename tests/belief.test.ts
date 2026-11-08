import assert from "node:assert/strict";
import test from "node:test";
import { PublicBeliefTracker, type BeliefObservation } from "../src/belief.js";
import type { PublicInformation, Rack } from "../src/types.js";

const rack = (letters: string): Map<string, number> => {
  const result = new Map<string, number>();
  for (const letter of letters) result.set(letter, (result.get(letter) ?? 0) + 1);
  return result;
};
const size = (counts: Rack) => [...counts.values()].reduce((a, b) => a + b, 0);
const at = (round: number) => BigInt(round * 10);
const base = (overrides: Partial<BeliefObservation> = {}): BeliefObservation => ({
  myRack: rack("AB"), bagCount: 6, auctions: [], words: [], completeHistory: true, ...overrides,
});
const tracker = (seed = 7) => new PublicBeliefTracker({
  myBotId: "self", playerIds: ["self", "op"], startingRackSize: 2,
  initialBag: rack("AAAABBBCCD"), particles: 512, seed,
});

function checkSamples(info: PublicInformation, inventory: Rack, ownInitial: Rack, revealed: Rack,
  deltas: ReadonlyMap<string, Rack> = new Map()): void {
  assert.equal(info.consistent, true);
  assert.ok(info.samples.length > 0);
  assert.ok(Math.abs(info.samples.reduce((total, sample) => total + sample.weight, 0) - 1) < 1e-10);
  for (const sample of info.samples) {
    assert.equal(size(sample.bag), info.bagCount);
    const total = new Map(ownInitial);
    for (const [letter, amount] of revealed) total.set(letter, (total.get(letter) ?? 0) + amount);
    for (const [letter, amount] of sample.bag) {
      assert.ok(Number.isInteger(amount) && amount >= 0);
      total.set(letter, (total.get(letter) ?? 0) + amount);
      assert.ok(amount >= (info.bagMinimum.get(letter) ?? 0));
      assert.ok(amount <= (info.bagMaximum.get(letter) ?? 0));
    }
    for (const opponent of info.opponents) {
      const hand = sample.opponentRacks.get(opponent.botId)!;
      assert.equal(size(hand), opponent.rackSize);
      for (const letter of inventory.keys()) {
        const amount = hand.get(letter) ?? 0;
        assert.ok(Number.isInteger(amount) && amount >= 0);
        assert.ok(amount >= (opponent.rackMinimum.get(letter) ?? 0));
        assert.ok(amount <= (opponent.rackMaximum.get(letter) ?? 0));
        total.set(letter, (total.get(letter) ?? 0) + amount - (deltas.get(opponent.botId)?.get(letter) ?? 0));
      }
    }
    for (const [letter, amount] of inventory) assert.equal(total.get(letter) ?? 0, amount, letter);
  }
}

test("hidden initial hands remain uncertain and every joint scenario conserves physical tiles", () => {
  const info = tracker().observe(base());
  checkSamples(info, rack("AAAABBBCCD"), rack("AB"), rack(""));
  assert.equal(info.knownOwnInitial, true);
  assert.equal(info.opponents[0]!.rackSize, 2);
  assert.ok(info.samples.some(s => (s.opponentRacks.get("op")!.get("C") ?? 0) > 0));
  assert.ok(info.samples.some(s => (s.opponentRacks.get("op")!.get("C") ?? 0) === 0));
  // Eight unseen tiles: three A's. Two hidden opposing tiles leave an expected 2.25 A's in the six-tile bag.
  assert.ok(Math.abs((info.expectedBag.get("A") ?? 0) - 2.25) < 0.12);
});

test("current and unsold auctions deplete the bag once without entering an opposing hand", () => {
  const info = tracker().observe(base({bagCount: 4,
    currentAuction: {id: "open", letter: "C", opensAtMicros: at(2)},
    auctions: [{id: "no-bids", letter: "A", opensAtMicros: at(0), closesAtMicros: at(1)},
      {id: "open", letter: "C", opensAtMicros: at(2)}],
  }));
  checkSamples(info, rack("AAAABBBCCD"), rack("AB"), rack("AC"));
  assert.equal(info.observedAuctionCount, 2);
  assert.equal(info.opponents[0]!.rackSize, 2);
});

test("prefix consumption proves initial letters even after a later purchase replaces them", () => {
  const observation = base({bagCount: 4,
    auctions: [
      {id: "one", letter: "A", opensAtMicros: at(0), closesAtMicros: at(1), winnerBotId: "op", paid: 3},
      {id: "two", letter: "C", opensAtMicros: at(3), closesAtMicros: at(4), winnerBotId: "op", paid: 9},
    ], words: [{id: "word", botId: "op", word: "AC", playedAtMicros: at(2)}],
  });
  const info = tracker().observe(observation);
  const op = info.opponents[0]!;
  assert.equal(op.initialMinimum.get("C"), 1);
  assert.equal(op.rackMinimum.get("C"), 1);
  assert.equal(op.rackSize, 2);
  checkSamples(info, rack("AAAABBBCCD"), rack("AB"), rack("AC"));
  assert.equal(info.market.medianPayment, 6);
  assert.equal(info.market.samples, 2);
});

test("own starting tiles reconstruct from current hand, awards and consumed words", () => {
  const info = tracker().observe(base({myRack: rack("BC"), bagCount: 4,
    auctions: [{id: "one", letter: "C", opensAtMicros: at(0), closesAtMicros: at(1), winnerBotId: "self", paid: 2},
      {id: "two", letter: "B", opensAtMicros: at(2), closesAtMicros: at(3), winnerBotId: "self", paid: 2}],
    words: [{id: "word", botId: "self", word: "AB", playedAtMicros: at(2)}],
  }));
  checkSamples(info, rack("AAAABBBCCD"), rack("AB"), rack("CB"));
});

test("awards precede words at the same timestamp and prefix observations use no future information", () => {
  const subject = tracker();
  const prefix = base({bagCount: 5, auctions: [
    {id: "one", letter: "C", opensAtMicros: at(0), closesAtMicros: at(1), winnerBotId: "op"}],
    words: [{id: "w", botId: "op", word: "AC", playedAtMicros: at(1)}]});
  const early = subject.observe(prefix);
  assert.equal(early.opponents[0]!.initialMinimum.get("C") ?? 0, 0);
  assert.equal(early.opponents[0]!.initialMinimum.get("A"), 1);
  const future = subject.observe({...prefix, bagCount: 4,
    auctions: [...prefix.auctions, {id: "two", letter: "D", opensAtMicros: at(3)}],
    words: [...prefix.words, {id: "later", botId: "op", word: "AB", playedAtMicros: at(2)}]});
  assert.equal(future.consistent, false); // Impossible later consumption is not silently accepted.
  const earlyAgain = tracker().observe(prefix);
  assert.deepEqual(earlyAgain, early);
});

test("replay deduplication, order changes and identical observations are deterministic and cached", () => {
  const subject = tracker();
  const observation = base({bagCount: 5, auctions: [
    {id: "one", letter: "C", opensAtMicros: at(0), closesAtMicros: at(1), winnerBotId: "op"}],
    words: []});
  const info = subject.observe(observation);
  assert.strictEqual(subject.observe(observation), info);
  const replay = tracker().observe({...observation, auctions: [...observation.auctions, ...observation.auctions]});
  assert.deepEqual(replay, info);
});

test("incomplete or inconsistent snapshots fail visibly without fabricated precise opponent hands", () => {
  for (const observation of [base({completeHistory: false}), base({bagCount: 7}), base({myRack: rack("ABC")}),
    base({words: [{id: "bad", botId: "op", word: "DD", playedAtMicros: at(0)}], bagCount: 6})]) {
    const info = tracker().observe(observation);
    assert.equal(info.consistent, false);
    assert.deepEqual(info.samples, []);
    assert.equal(info.opponents.length, 0);
  }
});

test("constrained importance weights match a small enumerable posterior", () => {
  const subject = new PublicBeliefTracker({myBotId: "self", playerIds: ["self", "op"], startingRackSize: 2,
    initialBag: rack("AABBCCDD"), particles: 2048, seed: 11});
  // Own initial DD. Opponent plays AB, so its initial is forced AB. Current hand is empty.
  const info = subject.observe({myRack: rack("DD"), bagCount: 4, completeHistory: true, auctions: [],
    words: [{id: "w", botId: "op", word: "AB", playedAtMicros: 0n}]});
  assert.equal(info.consistent, true);
  assert.equal(info.opponents[0]!.rackSize, 0);
  assert.equal(info.expectedBag.get("A"), 1);
  assert.equal(info.expectedBag.get("B"), 1);
  assert.equal(info.expectedBag.get("C"), 2);
  assert.equal(info.bagMinimum.get("C"), 2);
  assert.equal(info.bagMaximum.get("C"), 2);
});

test("mandatory-tile proposal is importance-corrected rather than biasing toward repeated letters", () => {
  const subject = new PublicBeliefTracker({myBotId: "self", playerIds: ["self", "op"], startingRackSize: 2,
    initialBag: rack("AAABBCCDD"), particles: 2048, seed: 12});
  const info = subject.observe({myRack: rack("DD"), bagCount: 4, completeHistory: true,
    auctions: [{id: "bought", letter: "B", opensAtMicros: 0n, closesAtMicros: 1n, winnerBotId: "op"}],
    words: [{id: "w", botId: "op", word: "AB", playedAtMicros: 2n}]});
  assert.equal(info.consistent, true);
  // Given initial A, feasible other tile is A/B/C with posterior 1/4,1/4,1/2.
  // Merely removing mandatory A and drawing gives the wrong probabilities 2/5,1/5,2/5.
  assert.ok(Math.abs((info.opponents[0]!.rackMean.get("A") ?? 0) - 0.25) < 0.035);
  assert.ok(Math.abs((info.expectedBag.get("A") ?? 0) - 1.75) < 0.035);
  assert.ok(info.effectiveSampleSize > 0 && info.effectiveSampleSize < 2048);
});

test("opponent estimates share one unseen pool instead of each claiming the same rare letters", () => {
  const inventory = rack("AAAABBBCCDDEE");
  const subject = new PublicBeliefTracker({myBotId: "self", playerIds: ["op2", "self", "op1"], startingRackSize: 2,
    initialBag: inventory, particles: 256, seed: 3});
  const info = subject.observe({myRack: rack("EE"), bagCount: 6, completeHistory: true,
    auctions: [{id: "bought", letter: "A", opensAtMicros: 0n, closesAtMicros: 1n, winnerBotId: "op1"}],
    words: [{id: "w1", botId: "op1", word: "AB", playedAtMicros: 2n},
      {id: "w2", botId: "op2", word: "CC", playedAtMicros: 2n}]});
  checkSamples(info, inventory, rack("EE"), rack("A"), new Map([
    ["op1", new Map([["B", -1]])], ["op2", new Map([["C", -2]])],
  ]));
  assert.equal(info.bagMaximum.get("C") ?? 0, 0);
  assert.equal(info.opponents.find(op => op.botId === "op2")!.rackSize, 0);
  assert.equal(info.opponents.find(op => op.botId === "op1")!.rackMaximum.get("C") ?? 0, 0);
});
