import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { DiluteBot } from "../src/dilute.js";
import { fitDiluteResidualProfile, validateDiluteResidualProfile, type BidObservation, type DiluteResidualProfile } from "../src/dilute-profile.js";
import { canSpell, WordEngine } from "../src/engine.js";
import { MathBot as MathV2 } from "../src/math-v2.js";
import type { DecisionContext } from "../src/types.js";

const HASH = "a".repeat(64);
function context(letters: string, changes: Partial<DecisionContext> = {}): DecisionContext {
  const rack = new Map<string, number>();
  for (const letter of letters) rack.set(letter, (rack.get(letter) ?? 0) + 1);
  return { myRack: rack, myBalance: 100, myScore: 0, tilesRemaining: 20,
    auctionType: "Vickrey", letter: "Z", opponents: Array.from({ length: 5 }, () => ({ balance: 100, score: 0 })), ...changes };
}
function profile(residual = Math.log1p(0.15)): DiluteResidualProfile {
  return { schema: "dilute-v2-bid-residual-v1", anchorVersion: "v2-cash-pacing", featureVersion: "phase-composition-v1",
    provenance: "public-completed-teacher-own-rack-winner-conditional", generatedAt: "2026-11-07T22:00:00.000Z",
    dictionaryHash: HASH, cutoffMatchId: 5, teachers: [{ botId: 114, name: "FixtureTeacher", exactBids: 72 }],
    trainMatchIds: [1, 2, 3], validationMatchIds: [4, 5], trainRows: 60, validationRows: 12,
    skippedZeroAnchor: 0, phaseSupport: [20, 20, 20], weights: [residual, ...Array<number>(11).fill(0)], maxBidShift: 0.15,
    validation: { anchorLogMae: 0.3, residualLogMae: 0.2, calibrated: true } };
}

test("default Dilute actions exactly match frozen V2, regardless of absent or zero-confidence beliefs", () => {
  const engine = new WordEngine(["QI", "QUIZ", "AT", "CATER", "CARTERS"]);
  const bot = new DiluteBot(engine), anchor = new MathV2(engine);
  for (const letters of ["QI", "QUI", "AT", "CATER", "CARTERS", "QQAI", "A"]) {
    for (const tilesRemaining of [0, 1, 2, 20, 50]) {
      const ctx = context(letters, { tilesRemaining });
      assert.equal(bot.decideBid(ctx), anchor.decideBid(ctx));
      assert.equal(bot.chooseWord(ctx), anchor.chooseWord(ctx));
    }
  }
  const emptyBelief = { consistent: true, completeHistory: true, knownOwnInitial: true, bagCount: 20,
    observedAuctionCount: 48, expectedBag: new Map(), bagMinimum: new Map(), bagMaximum: new Map(), opponents: [],
    samples: [], effectiveSampleSize: 0, market: { medianPayment: 100, p75Payment: 100, samples: 10 } };
  const ctx = context("QUI", { information: emptyBelief });
  assert.equal(bot.decideBid(ctx), anchor.decideBid(ctx));
});

test("malformed, dictionary-mismatched and uncalibrated artifacts fall back to exact V2", () => {
  const engine = new WordEngine(["QI", "QUIZ"]), ctx = context("QUI");
  const expected = new MathV2(engine).decideBid(ctx);
  for (const bad of [null, {}, { ...profile(), maxBidShift: 0.5 }, { ...profile(), dictionaryHash: "b".repeat(64) },
    { ...profile(), trainMatchIds: [1, 4, 5] }, { ...profile(), weights: [Number.NaN] },
    { ...profile(), validation: { anchorLogMae: 0.1, residualLogMae: 0.2, calibrated: true } },
    { ...profile(), validation: { anchorLogMae: 0.3, residualLogMae: 0.2, calibrated: false } }]) {
    const bot = new DiluteBot(engine, { profile: bad, dictionaryHash: HASH });
    assert.equal(bot.decideBid(ctx), expected);
    assert.equal(bot.profileStatus.anchored, true);
  }
});

test("validated learned data changes decisions only within the fifteen-percent integer bound", () => {
  const engine = new WordEngine(["QI", "QUIZ"]), anchor = new MathV2(engine);
  const bot = new DiluteBot(engine, { profile: profile(), dictionaryHash: HASH });
  const ctx = context("QUI"), base = anchor.decideBid(ctx);
  assert.ok(bot.decideBid(ctx) > base);
  for (const myBalance of [0, 1, 5, 10, 17, 40, 100, 200]) {
    const state = { ...ctx, myBalance };
    const reference = anchor.decideBid(state), bid = bot.decideBid(state);
    assert.ok(Number.isSafeInteger(bid) && bid >= 0 && bid <= myBalance);
    if (reference > 0) assert.ok(bid >= Math.ceil(reference * 0.85) && bid <= Math.floor(reference * 1.15));
    else assert.equal(bid, 0);
  }
});

test("no residual can invent a rejected purchase or change final usable/terminal behavior", () => {
  const engine = new WordEngine(["QI", "AT", "QAT"]), bot = new DiluteBot(engine, { profile: profile() });
  assert.equal(bot.decideBid(context("Q", { letter: "Z" })), 0);
  assert.equal(bot.decideBid(context("Q", { letter: "I", tilesRemaining: 0 })), 0);
  assert.equal(bot.decideBid(context("Q", { letter: "I", tilesRemaining: 1, myBalance: 123 })), 123);
  assert.equal(bot.chooseWord(context("QATI", { tilesRemaining: 0 })), "QI");
});

test("word actions preserve V2 liquidity and continuation decisions without historical round rules", () => {
  const engine = new WordEngine(["AT", "CAT", "CATS", "QI", "QUIZ"]), anchor = new MathV2(engine);
  const bot = new DiluteBot(engine, { profile: profile() });
  for (const ctx of [context("CAT", { tilesRemaining: 70 }), context("CAT", { tilesRemaining: 8 }),
    context("AT", { myBalance: 0, tilesRemaining: 60 }), context("QUIZ", { tilesRemaining: 40 })]) {
    const actual = bot.chooseWord(ctx);
    assert.equal(actual, anchor.chooseWord(ctx));
    if (actual) assert.ok(canSpell(actual, ctx.myRack));
  }
});

test("profile updates commit only between episodes and are defensive copies", () => {
  const engine = new WordEngine(["QI", "QUIZ"]), bot = new DiluteBot(engine, { dictionaryHash: HASH });
  const ctx = context("QUI"), base = bot.decideBid(ctx);
  bot.beginEpisode();
  const next = profile();
  assert.equal(bot.queueProfile(next), true);
  next.weights = Array<number>(12).fill(0);
  assert.equal(bot.decideBid(ctx), base);
  bot.beginEpisode();
  assert.equal(bot.decideBid(ctx), base);
  bot.finishEpisode(); bot.beginEpisode();
  assert.ok(bot.decideBid(ctx) > base);
  assert.equal(bot.queueProfile({}), false);
  assert.equal(bot.profileStatus.anchored, false);
});

test("first-price extra bids respect a public payment guard without treating payments as winners", () => {
  const engine = new WordEngine(["QI", "QUIZ"]), anchor = new MathV2(engine);
  const bot = new DiluteBot(engine, { profile: profile() });
  const ctx = context("QUI", { auctionType: "FirstPrice", information: {
    consistent: true, completeHistory: true, knownOwnInitial: true, bagCount: 20, observedAuctionCount: 48,
    expectedBag: new Map(), bagMinimum: new Map(), bagMaximum: new Map(), opponents: [], samples: [],
    effectiveSampleSize: 0, market: { medianPayment: 5, p75Payment: 7, samples: 10 } } });
  assert.equal(bot.decideBid(ctx), anchor.decideBid(ctx));
});

function teacherRows(amount: number): BidObservation[] {
  return Array.from({ length: 70 }, (_, i) => ({ matchId: 1 + Math.floor(i / 10), botId: 114,
    teacher: "FixtureTeacher", letter: "Z", rack: { Q: 1, U: 1, I: 1 }, balance: 100, score: 0,
    remainingAuctions: 20, totalAuctions: 68, opponentCount: 5, auctionType: "Vickrey", paid: 10,
    bidLabel: { type: "exact-winner-bid", amount }, wordDuringAuction: false,
    split: i < 50 ? "train" : "validation" }));
}

test("offline teacher ratio fitting changes policy and honors whole-match/censored separation", () => {
  const engine = new WordEngine(["QI", "QUIZ"]);
  const options = { dictionaryHash: HASH, generatedAt: "2026-11-07T22:00:00.000Z" };
  const lower = fitDiluteResidualProfile(teacherRows(48), engine, options);
  const higher = fitDiluteResidualProfile(teacherRows(63), engine, options);
  assert.ok(validateDiluteResidualProfile(lower)); assert.ok(validateDiluteResidualProfile(higher));
  const ctx = context("QUI");
  assert.ok(new DiluteBot(engine, { profile: higher }).decideBid(ctx) > new DiluteBot(engine, { profile: lower }).decideBid(ctx));
  const rows = teacherRows(63);
  const modified = [...rows, { ...rows[0]!, bidLabel: { type: "censored-loser-upper-bound", amount: 99 } }];
  assert.deepEqual(fitDiluteResidualProfile(modified, engine, options), higher);
  const changedValidation = rows.map(row => row.split === "validation" ? { ...row, bidLabel: { type: "exact-winner-bid", amount: 99 } } : row);
  assert.deepEqual(fitDiluteResidualProfile(changedValidation, engine, options).weights, higher.weights);
  assert.throws(() => fitDiluteResidualProfile([...rows, { ...rows[0]!, split: "validation" }], engine, options), /crosses/);
});

test("full-dictionary anchored callback pairs stay inside the one-second auction", () => {
  const engine = new WordEngine(readFileSync(new URL("../data/enable1.txt", import.meta.url), "utf8").split(/\r?\n/));
  const bot = new DiluteBot(engine, { profile: profile() });
  const times: number[] = [];
  for (const letters of ["AEINRST", "CATER", "QUIZ", "AAEENRT", "CARTERS", "BLOWZED", "AEINRSTCDELOUQ"]) {
    const ctx = context(letters, { letter: "S" });
    const start = performance.now(); bot.decideBid(ctx); bot.chooseWord(ctx); times.push(performance.now() - start);
  }
  assert.ok(Math.max(...times) < 500, `callback pair ms: ${times.map(time => time.toFixed(1)).join(", ")}`);
});
