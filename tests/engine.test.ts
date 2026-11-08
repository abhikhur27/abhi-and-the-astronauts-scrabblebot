import assert from "node:assert/strict";
import test from "node:test";
import { WordEngine, canSpell, wordReward } from "../src/engine.js";

const rack = (letters: string) => {
  const counts = new Map<string, number>();
  for (const letter of letters) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
};

test("word rewards use source integer division and length bonuses", () => {
  assert.equal(wordReward("QI"), 11);
  assert.equal(wordReward("JAZZ"), 43);
  assert.equal(wordReward("QUIET"), 28);
  assert.equal(wordReward("QUARTZ"), 60);
  assert.equal(wordReward("QUIZZES"), 102);
});

test("spelling consumes repeated letters rather than testing membership", () => {
  assert.equal(canSpell("TEETH", rack("TEEH")), false);
  assert.equal(canSpell("TEETH", rack("TEETH")), true);
  assert.equal(canSpell("Q?", rack("Q?")), false);
});

test("dictionary traversal returns every legal subanagram by reward", () => {
  const engine = new WordEngine(["AT", "QI", "QAT", "TAX", "AX", "ZZ", "AT", "A", "bad-word"]);
  assert.deepEqual(engine.playable(rack("QATXI")), [
    { word: "QAT", reward: 12 },
    { word: "QI", reward: 11 },
    { word: "TAX", reward: 10 },
    { word: "AX", reward: 9 },
    { word: "AT", reward: 2 },
  ]);
  assert.deepEqual(engine.playable(rack("QI"), 1), [{ word: "QI", reward: 11 }]);
  assert.deepEqual(engine.playable(rack("Z")), []);
});

test("rack search never consumes or mutates caller inventory", () => {
  const engine = new WordEngine(["TEETH", "THE", "TEE"]);
  const inventory = rack("TEETH");
  const before = Array.from(inventory);
  const result = engine.playable(inventory);
  assert.equal(result[0]?.word, "TEETH");
  result.pop();
  assert.equal(engine.playable(inventory).length, 3);
  assert.deepEqual(Array.from(inventory), before);
});

test("potential recognizes the option created by one missing complementary tile", () => {
  const engine = new WordEngine(["QUARTZ", "AT", "ART"]);
  assert.equal(engine.potential(rack("QUART"), 0), 3);
  assert.ok(engine.potential(rack("QUART"), 50) > engine.potential(rack("QUART"), 0));
  assert.ok(engine.potential(rack("QUARTZ"), 50) > engine.potential(rack("QUART"), 50));
  assert.equal(engine.potential(rack(""), 50), 0);
});

test("potential respects repeated missing letters and short horizons", () => {
  const engine = new WordEngine(["TEETH"]);
  assert.ok(engine.potential(rack("TEE"), 40) > engine.potential(rack("TEE"), 1));
  assert.ok(engine.potential(rack("TEET"), 40) > engine.potential(rack("TEE"), 40));
});

test("redemption planning preserves two disjoint words over a locally better word", () => {
  const engine = new WordEngine(["QI", "AT", "QAT"]);
  assert.deepEqual(engine.redemptionPlan(rack("QATI")), {value: 13, firstWord: "QI", exact: true});
  assert.deepEqual(engine.redemptionPlan(rack("QI")), {value: 11, firstWord: "QI", exact: true});
  assert.equal(engine.redemptionPlan(rack("QIQI")).value, 22);
});

test("finite bag completion uses without-replacement draws and depleted letters", () => {
  const engine = new WordEngine(["AT"]);
  const available = [{weight: 1, bag: rack("TZ"), draws: 1}];
  assert.ok(Math.abs(engine.potential(rack("A"), 50, available) - 0.96) < 1e-10);
  assert.equal(engine.potential(rack("A"), 50, [{weight: 1, bag: rack("ZZ"), draws: 1}]), 0);
});

test("two missing tiles require their joint hypergeometric event", () => {
  const engine = new WordEngine(["TEETH"]);
  // Of the six unordered pairs from EEZZ, exactly one contains both Es.
  assert.ok(Math.abs(engine.potential(rack("TTH"), 50, [{weight: 1, bag: rack("EEZZ"), draws: 2}]) - 16 * 0.96 ** 2 / 6) < 1e-10);
  // Of three pairs from THZ, only TH contains both distinct missing tiles.
  assert.ok(Math.abs(engine.potential(rack("TEE"), 50, [{weight: 1, bag: rack("THZ"), draws: 2}]) - 16 * 0.96 ** 2 / 3) < 1e-10);
});

test("a failed future completion retains the current legal redemption option", () => {
  const engine=new WordEngine(["CAT","CATS"]);
  // One draw has 1/4 chance of S. CAT remains redeemable when S is not won.
  assert.ok(Math.abs(engine.potential(rack("CAT"),4,[{weight:1,bag:rack("SZZZ"),draws:1}]) - 5.96)<1e-10);
});
