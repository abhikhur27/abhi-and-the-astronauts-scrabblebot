import assert from "node:assert/strict";
import test from "node:test";
import { WordEngine } from "../src/engine.js";
import { MathBot } from "../src/math.js";
import { MathBot as MathBotV2 } from "../src/math-v2.js";
import type { DecisionContext, PublicInformation } from "../src/types.js";

function context(letters: string, overrides: Partial<DecisionContext> = {}): DecisionContext {
  const myRack = new Map<string, number>();
  for (const letter of letters) myRack.set(letter, (myRack.get(letter) ?? 0) + 1);
  return {myRack, myBalance: 100, myScore: 0, tilesRemaining: 30, auctionType: "Vickrey", letter: "E", ...overrides};
}

test("final auction tile is worthless because source ends immediately on close", () => {
  const bot = new MathBot(new WordEngine(["QI"]));
  assert.equal(bot.decideBid(context("Q", {letter: "I", tilesRemaining: 0})), 0);
  assert.equal(bot.chooseWord(context("QI", {tilesRemaining: 0})), "QI");
});

test("bids are finite integers inside spendable balance", () => {
  const bot = new MathBot(new WordEngine(["QI", "QUIET", "QUARTZ"]));
  for (const myBalance of [0, -1, 0.5, 1, 7.5, 100, Number.NaN]) {
    const amount = bot.decideBid(context("QUART", {letter: "Z", myBalance}));
    assert.ok(Number.isInteger(amount));
    assert.ok(amount >= 0);
    assert.ok(amount <= (Number.isFinite(myBalance) ? Math.max(0, Math.floor(myBalance)) : 0));
  }
});

test("completing a high reward word beats another duplicate dead letter", () => {
  const bot = new MathBot(new WordEngine(["QUARTZ", "QI", "AT", "ART"]));
  const complete = bot.decideBid(context("QUART", {letter: "Z"}));
  const duplicate = bot.decideBid(context("QUART", {letter: "Q"}));
  assert.ok(complete > duplicate);
  assert.ok(complete >= 10);
});

test("first-price policy shades a bid below its Vickrey bid", () => {
  const bot = new MathBot(new WordEngine(["QUARTZ", "QI", "AT", "ART"]));
  const secondPrice = bot.decideBid(context("QUART", {letter: "Z"}));
  const firstPrice = bot.decideBid(context("QUART", {letter: "Z", auctionType: "FirstPrice"}));
  assert.ok(firstPrice < secondPrice);
});

test("liquidity starvation cashes a legal short word instead of waiting forever", () => {
  const bot = new MathBot(new WordEngine(["QI", "QUIET"]));
  assert.equal(bot.chooseWord(context("QI", {myBalance: 0})), "QI");
});

test("ample capital preserves a promising short rack for the superlinear bonus", () => {
  const bot = new MathBot(new WordEngine(["AT", "CAT", "CATS"]));
  assert.equal(bot.chooseWord(context("CAT", {tilesRemaining: 50})), null);
  assert.equal(bot.chooseWord(context("CAT", {tilesRemaining: 0})), "CAT");
});

test("terminal choice accounts for a second disjoint word rather than greedy reward", () => {
  const bot = new MathBot(new WordEngine(["QI", "AT", "QAT"]));
  assert.equal(bot.chooseWord(context("QATI", {tilesRemaining: 0})), "QI");
});

test("the last usable completion spends cash that has no later scoring use", () => {
  const bot = new MathBot(new WordEngine(["QI"]));
  assert.equal(bot.decideBid(context("Q", {letter:"I", tilesRemaining:1, myBalance:120})), 120);
  assert.equal(bot.decideBid(context("Q", {letter:"I", tilesRemaining:1, myBalance:120, auctionType:"FirstPrice"})), 120);
  assert.equal(bot.decideBid(context("Q", {letter:"Z", tilesRemaining:1, myBalance:120})), 0);
});

test("a useful extra tile retains portfolio value when the best target is unchanged", () => {
  const engine = new WordEngine(["WIPED", "SWIPED", "WEED", "DEEP", "PIE"]);
  const bot = new MathBot(engine);
  // Captured live rack: an extra I does not improve the SWIPED envelope,
  // but I remains a useful component of a later PIE after WIPED is sold.
  assert.ok(bot.decideBid(context("DEEIPW", {letter:"I", tilesRemaining:40})) > 0);
});

test("replenished surplus cash raises bids before all remaining opportunities disappear", () => {
  const bot = new MathBot(new WordEngine(["AT", "CAT", "CATS"]));
  const early = bot.decideBid(context("CA", {letter:"T",myBalance:120,tilesRemaining:60}));
  const late = bot.decideBid(context("CA", {letter:"T",myBalance:120,tilesRemaining:15}));
  assert.ok(late > early, `late ${late} should exceed early ${early}`);
});

function information(bag: string, opponentRack = "ZZZZ"): PublicInformation {
  const counts = (letters: string) => context(letters).myRack;
  const future = counts(bag);
  return {consistent:true, completeHistory:true, knownOwnInitial:true, bagCount:bag.length,
    observedAuctionCount:10, expectedBag:future, bagMinimum:future, bagMaximum:future,
    opponents:[{botId:"p", rackSize:opponentRack.length, initialMinimum:new Map(), rackMinimum:counts(opponentRack), rackMaximum:counts(opponentRack), rackMean:counts(opponentRack)}],
    samples:[{weight:1,bag:future,opponentRacks:new Map([["p", counts(opponentRack)]])}],
    effectiveSampleSize:1, market:{medianPayment:12,p75Payment:16,samples:10}};
}

test("a complete hard bound on the late bag releases a word whose extension is exhausted", () => {
  const bot = new MathBot(new WordEngine(["AT", "CAT", "CATE"]));
  const state=context("CAT",{tilesRemaining:8,letter:"G"});
  assert.equal(bot.chooseWord(state),null);
  assert.equal(bot.chooseWord({...state,information:information("BBDDDDVV")}),"CAT");
});

test("the currently offered tile remains a possible extension when deciding whether to cash out", () => {
  const bot=new MathBot(new WordEngine(["CAT","CATE"]));
  assert.equal(bot.chooseWord(context("CAT",{tilesRemaining:8,letter:"E",information:information("BBDDDDVV")})),null);
});

test("an inferred affordable opposing completion changes a useful tile bid", () => {
  const bot = new MathBot(new WordEngine(["QI", "QUIET", "ZIT"]));
  const state = context("QUIE", {letter:"T", tilesRemaining:20, opponents:[{botId:"p",balance:100,score:10}]});
  const harmless = bot.decideBid({...state, information:information("ZZZZZZZZZZZZ", "ZZZZ")});
  const threat = bot.decideBid({...state, information:information("ZZZZZZZZZZZZ", "ZI")});
  assert.ok(threat > harmless, `${threat} should exceed ${harmless}`);
});

test("a large uncertain future inventory retains V2 timing instead of replacing its option values", () => {
  const bot=new MathBot(new WordEngine(["CAT","CATS"]));
  const junk="B".repeat(24)+"D".repeat(24);
  const state=context("CAT",{tilesRemaining:49,myBalance:100,opponents:Array.from({length:5},(_,i)=>({botId:String(i),balance:100,score:0}))});
  assert.equal(bot.chooseWord({...state,information:information(junk+"S")}),null);
  assert.equal(bot.chooseWord({...state,information:information(junk+"B")}),new MathBotV2(new WordEngine(["CAT","CATS"])).chooseWord(state));
});

test("disabling public adjustments exactly preserves V2 decisions", () => {
  const engine=new WordEngine(["AT","CAT","CATE","QI","QUIET","ZIT"]);
  const anchored=new MathBot(engine,{publicInformation:false,bidScale:1});
  const frozen=new MathBotV2(engine);
  for(const state of [context("CAT",{tilesRemaining:8,information:information("BBDDDDVV")}),context("QUIE",{letter:"T",information:information("BBDDDDVV","ZI"),opponents:[{botId:"p",balance:100,score:5}]})]) {
    assert.equal(anchored.decideBid(state),frozen.decideBid(state));
    assert.equal(anchored.chooseWord(state),frozen.chooseWord(state));
  }
});

test("hard bag bounds veto a late purchase that cannot improve any attainable redemption", () => {
  const engine=new WordEngine(["CAT"]);const state=context("C",{letter:"A",tilesRemaining:8});
  assert.ok(new MathBotV2(engine).decideBid(state)>0);
  assert.equal(new MathBot(engine).decideBid({...state,information:information("BBDDDDVV")}),0);
});

test("uncertain sample-only opponent completions cannot create a denial bid", () => {
  const engine=new WordEngine(["QI","QUIET","ZIT"]);
  const info=information("BBDDDDVV","ZI");info.opponents[0]!.rackMinimum=new Map();
  const state=context("QUIE",{letter:"T",information:info,opponents:[{botId:"p",balance:100,score:0}]});
  assert.equal(new MathBot(engine).decideBid(state),new MathBotV2(engine).decideBid(state));
});

test("bounded pacing scales preserve cash clipping and terminal all-in behavior", () => {
  const engine=new WordEngine(["QI","QUIET"]);
  const state=context("Q",{letter:"I",myBalance:101});
  const base=new MathBot(engine,{publicInformation:false,bidScale:1}).decideBid(state);
  assert.equal(new MathBot(engine,{publicInformation:false,bidScale:0.95}).decideBid(state),Math.floor(base*0.95));
  assert.equal(new MathBot(engine,{bidScale:1.05}).decideBid({...state,tilesRemaining:1}),101);
  assert.throws(()=>new MathBot(engine,{bidScale:1.5}),/scale/i);
});

test("optional patience retains a viable six-letter hand when V2 only narrowly favors cashing", () => {
  const engine=new WordEngine(["RETAIN","RETAINS"]);
  const state=context("RETAIN",{tilesRemaining:35,letter:"G"});
  assert.equal(new MathBot(engine).chooseWord(state),"RETAIN");
  assert.equal(new MathBot(engine,{holdThreshold:1.04}).chooseWord(state),null);
});

test("optional patience yields to a complete depleted upper bound and includes the current offer", () => {
  const engine=new WordEngine(["RETAIN","RETAINS"]),bot=new MathBot(engine,{holdThreshold:1.04});
  const remaining="A".repeat(8)+"E".repeat(11)+"I".repeat(8)+"O".repeat(8);
  const state=context("RETAIN",{tilesRemaining:35,letter:"G",information:information(remaining)});
  assert.equal(bot.chooseWord(state),"RETAIN");
  assert.equal(bot.chooseWord({...state,letter:"S"}),null);
});

test("patience cannot create an extension or delay liquidity, closing time, or a seven-letter cashout", () => {
  const lone=new MathBot(new WordEngine(["RETAIN"]),{holdThreshold:1.04});
  assert.equal(lone.chooseWord(context("RETAIN",{tilesRemaining:35})),"RETAIN");
  const engine=new WordEngine(["RETAIN","RETAINS"]),bot=new MathBot(engine,{holdThreshold:1.04});
  assert.equal(bot.chooseWord(context("RETAIN",{tilesRemaining:35,myBalance:23})),"RETAIN");
  assert.equal(bot.chooseWord(context("RETAIN",{tilesRemaining:35,myBalance:0})),"RETAIN");
  assert.equal(bot.chooseWord(context("RETAIN",{tilesRemaining:16})),"RETAIN");
  assert.equal(bot.chooseWord(context("RETAIN",{tilesRemaining:2})),"RETAIN");
  assert.equal(bot.chooseWord(context("RETAINS",{tilesRemaining:35})),"RETAINS");
});

test("the default hold threshold retains V2 timing and rejects unsupported calibrations", () => {
  const engine=new WordEngine(["RETAIN","RETAINS","AT","CAT","CATS","QI","QUIET"]);
  const defaultBot=new MathBot(engine,{publicInformation:false});
  const explicit=new MathBot(engine,{publicInformation:false,holdThreshold:.98});
  const frozen=new MathBotV2(engine);
  for(const state of [context("RETAIN",{tilesRemaining:35}),context("CAT",{tilesRemaining:50}),context("QI",{myBalance:0}),context("RETAINS")]) {
    assert.equal(defaultBot.chooseWord(state),frozen.chooseWord(state));
    assert.equal(explicit.chooseWord(state),frozen.chooseWord(state));
  }
  for(const threshold of [Number.NaN,.97,1.05])assert.throws(()=>new MathBot(engine,{holdThreshold:threshold}),/threshold/i);
});
