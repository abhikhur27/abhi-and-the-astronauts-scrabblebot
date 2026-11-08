import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WordEngine } from "../src/engine.js";
import { LearningBot, createModel, loadModel, saveModel, modelProfile, type ResidualLearnedModel } from "../src/model.js";
import { MathBot as MathBotV2 } from "../src/math-v2.js";
import { simulateMatch } from "../src/simulator.js";
import type { PublicInformation } from "../src/types.js";

const context = { myRack: new Map([["A", 1], ["T", 1]]), myBalance: 20, myScore: 0, tilesRemaining: 20, auctionType: "Vickrey" as const, letter: "E" };
test("learner never spends past balance or bids on unusable final tile", () => {
  const bot = new LearningBot(new WordEngine(["AT", "ATE", "TEA"]));
  assert.equal(bot.decideBid({ ...context, tilesRemaining: 0 }), 0);
  assert.equal(bot.decideBid({ ...context, myBalance: 0 }), 0);
  const bid = bot.decideBid(context);
  assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= 20);
});
test("training episode updates parameters while frozen inference leaves model untouched", () => {
  const engine = new WordEngine(["AT", "ATE", "TEA"]);
  const model = createModel();
  const before = JSON.stringify(model);
  const frozen = new LearningBot(engine, model);
  frozen.decideBid(context);
  frozen.chooseWord(context);
  frozen.finishEpisode(20);
  assert.equal(JSON.stringify(model), before);
  const learner = new LearningBot(engine, model, { training: true, epsilon: 0, seed: 7 });
  learner.beginEpisode();
  learner.decideBid({...context,tilesRemaining:10});
  learner.chooseWord({...context,tilesRemaining:10});
  learner.finishEpisode(20);
  assert.ok(model.updates > 0);
  assert.equal(model.trainedGames, 1);
  assert.notEqual(JSON.stringify(model.bidWeights), JSON.stringify(createModel().bidWeights));
});
test("checkpoint roundtrip preserves predictions and rejects malformed nonfinite weights", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrabble-model-"));
  const path = join(dir, "model.json");
  const model = createModel();
  saveModel(path, model);
  const loaded = loadModel(path);
  assert.deepEqual(loaded, model);
  assert.equal(new LearningBot(new WordEngine(["AT", "ATE"]), loaded).decideBid(context), new LearningBot(new WordEngine(["AT", "ATE"]), model).decideBid(context));
  const bad = JSON.parse(readFileSync(path, "utf8"));
  bad.bidWeights[0][0] = null;
  writeFileSync(path, JSON.stringify(bad));
  assert.throws(() => loadModel(path), /checkpoint|weight/i);
});
test("repeated live pump of unchanged state records one decision rather than artificial experience", () => {
  const model = createModel();
  const bot = new LearningBot(new WordEngine(["AT", "ATE"]), model, { training: true, epsilon: 0, seed: 1 });
  bot.beginEpisode();
  for (let repeat = 0; repeat < 10; repeat++) bot.decideBid({...context,tilesRemaining:10});
  bot.finishEpisode(10);
  assert.equal(model.updates, 1);
});

test("learner cannot skip a profitable last usable tile to preserve worthless terminal cash", () => {
  const model = createModel("legacy-mc");
  model.bidWeights[0]![0] = 10; // Force the learned skip action unless the terminal guard intervenes.
  const bot = new LearningBot(new WordEngine(["AT", "ATE"]), model);
  assert.equal(bot.decideBid({ ...context, myBalance: 150, tilesRemaining: 1 }), 150);
});

test("learner terminal liquidation preserves the best sequence of disjoint words", () => {
  const bot = new LearningBot(new WordEngine(["QAT", "QI", "AT"]));
  const rack = new Map([["Q", 1], ["A", 1], ["T", 1], ["I", 1]]);
  assert.equal(bot.chooseWord({ ...context, myRack: rack, tilesRemaining: 1 }), "QI");
});

test("learner cannot force early short-word liquidation while a viable completion remains", () => {
  const model = createModel("legacy-mc");
  model.wordWeights[2]![0] = 10;
  const bot = new LearningBot(new WordEngine(["AT", "CAT", "CATS"]), model);
  assert.equal(bot.chooseWord({...context,myRack:new Map([["C",1],["A",1],["T",1]]),myBalance:100,tilesRemaining:50}), null);
});

test("a learned greedy action preserves an affordable six-letter target for the seven-letter multiplier", () => {
  const model=createModel("legacy-mc");model.wordWeights[2]![0]=10;
  const bot=new LearningBot(new WordEngine(["RETAIN","RETAINS"]),model);
  const myRack=new Map([..."RETAIN"].map(letter=>[letter,1]));
  assert.equal(bot.chooseWord({...context,myRack,myBalance:100,tilesRemaining:40}),null);
});

test("legacy twelve-feature checkpoints migrate without changing learned columns or counters", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrabble-legacy-"));
  const path = join(dir, "model.json");
  const legacy = {schema:"scrabblebot-linear-mc-v1",featureCount:12,
    bidWeights:Array.from({length:6},(_,i)=>Array.from({length:12},(_,j)=>i+j/20)),
    wordWeights:Array.from({length:3},()=>Array(12).fill(0.25)),trainedGames:42,updates:1234};
  writeFileSync(path,JSON.stringify(legacy));
  const loaded=loadModel(path);
  assert.ok(loaded.featureCount > 12);
  assert.deepEqual(loaded.bidWeights.map(row=>row.slice(0,12)), legacy.bidWeights);
  assert.ok(loaded.bidWeights.every(row=>row.slice(12).every(weight=>weight===0)));
  assert.equal(loaded.updates,1234);
  assert.equal(loaded.trainedGames,42);
  assert.equal(modelProfile(loaded),"legacy-mc");
  saveModel(path, loaded);
  assert.deepEqual(loadModel(path), loaded);
  assert.throws(()=>loadModel(path,"v2-residual"), /profile|separate candidate/i);
});

test("new public-inventory channels affect a learned bid and do not mutate frozen weights", () => {
  const model=createModel();
  support(model);
  model.bidWeights[2]![12]=1; // A learned confidence-dependent residual.
  const inventory:PublicInformation={consistent:true,completeHistory:true,knownOwnInitial:true,bagCount:10,
    observedAuctionCount:10,expectedBag:new Map([["Z",10]]),bagMinimum:new Map([["Z",10]]),bagMaximum:new Map([["Z",10]]),
    opponents:[],samples:[{weight:1,bag:new Map([["Z",10]]),opponentRacks:new Map()}],
    effectiveSampleSize:1,market:{medianPayment:12,p75Payment:14,samples:10}};
  const before=JSON.stringify(model);
  const engine=new WordEngine(["AT","ATE"]);
  const bot=new LearningBot(engine,model);
  const ctx={...context,myBalance:100,tilesRemaining:10};
  const baseline=new MathBotV2(engine).decideBid(ctx);
  assert.equal(bot.decideBid(ctx),baseline);
  assert.ok(bot.decideBid({...ctx,information:inventory})>baseline);
  assert.equal(JSON.stringify(model),before);
});

test("inconsistent snapshots fall back without trusting their impossible inventory", () => {
  const bot=new LearningBot(new WordEngine(["AT","ATE"]));
  const incomplete:PublicInformation={consistent:false,completeHistory:false,knownOwnInitial:false,bagCount:0,
    observedAuctionCount:1,expectedBag:new Map(),bagMinimum:new Map(),bagMaximum:new Map(),opponents:[],samples:[],
    effectiveSampleSize:0,market:{medianPayment:999,p75Payment:999,samples:100}};
  assert.equal(bot.decideBid({...context,information:incomplete}),bot.decideBid(context));
});

test("learner restores bidding capital even when learned hold has the highest value", () => {
  const model=createModel();support(model);model.wordWeights[1]![0]=10;
  const bot=new LearningBot(new WordEngine(["AT","ATE"]),model);
  assert.equal(bot.chooseWord({...context,myBalance:8}),"AT");
});

function support(model: ResidualLearnedModel): void {
  model.trainedGames=64;
  model.residual.valueUpdates=512;
  model.residual.bidActionCounts.fill(128);
  model.residual.wordActionCounts.fill(128);
}

test("unproven residual checkpoints follow frozen V2 even with large actor weights", () => {
  const engine=new WordEngine(["AT","ATE","RETAIN","RETAINS","QI","QAT"]);
  const model=createModel();
  model.bidWeights[2]!.fill(2);
  model.wordWeights[1]!.fill(2);
  const bot=new LearningBot(engine,model);
  const baseline=new MathBotV2(engine);
  const before=JSON.stringify(model);
  const states=[context,{...context,myBalance:100,tilesRemaining:50},
    {...context,myBalance:150,tilesRemaining:1},
    {...context,myRack:new Map([..."RETAIN"].map(letter=>[letter,1])),myBalance:100,tilesRemaining:40}];
  for(const ctx of states){
    assert.equal(bot.decideBid(ctx),baseline.decideBid(ctx));
    assert.equal(bot.chooseWord(ctx),baseline.chooseWord(ctx));
  }
  assert.equal(JSON.stringify(model),before);
});

test("supported residual bids remain close to V2 and preserve terminal/zero decisions", () => {
  const engine=new WordEngine(["AT","ATE","QI","QAT"]);
  const model=createModel();support(model);model.bidWeights[2]![0]=2;
  const bot=new LearningBot(engine,model), baseline=new MathBotV2(engine);
  for(const balance of [1,8,20,100,150]) for(const tilesRemaining of [0,1,2,10,40]){
    const ctx={...context,myBalance:balance,tilesRemaining};
    const expected=baseline.decideBid(ctx),actual=bot.decideBid(ctx);
    assert.ok(actual>=0&&actual<=balance&&Number.isInteger(actual));
    assert.ok(Math.abs(actual-expected)<=2);
    if(expected===0||tilesRemaining<=2||balance<12) assert.equal(actual,expected);
    else assert.ok(actual>=1);
  }
});

test("residual timing can defer only one auction and preserves V2 seven-letter/hold/endgame choices", () => {
  const engine=new WordEngine(["AT","ATE","RETAIN","RETAINS"]);
  const model=createModel();support(model);model.wordWeights[1]![0]=2;
  const bot=new LearningBot(engine,model), baseline=new MathBotV2(engine);
  const short={...context,myBalance:100,tilesRemaining:40,myRack:new Map([["A",1],["T",1]])};
  // With no longer word in this dictionary fixture, V2 immediately redeems AT.
  const shortBot=new LearningBot(new WordEngine(["AT"]),model);
  assert.equal(shortBot.chooseWord(short),null);
  assert.equal(shortBot.chooseWord(short),null);
  assert.equal(shortBot.chooseWord({...short,tilesRemaining:39}),"AT");
  for(const letters of ["RETAIN","RETAINS"]){
    const ctx={...short,myRack:new Map([...letters].map(letter=>[letter,1]))};
    assert.equal(bot.chooseWord(ctx),baseline.chooseWord(ctx));
  }
  assert.equal(bot.chooseWord({...short,tilesRemaining:2}),baseline.chooseWord({...short,tilesRemaining:2}));
  assert.equal(bot.chooseWord({...short,myBalance:8}),baseline.chooseWord({...short,myBalance:8}));
});

test("baseline-only live training records actual actions and critic updates without actor deviations", () => {
  const engine=new WordEngine(["AT","ATE"]);
  const model=createModel();support(model);model.bidWeights[2]![0]=2;model.wordWeights[1]![0]=2;
  const actorBefore=JSON.stringify([model.bidWeights,model.wordWeights]);
  const criticBefore=JSON.stringify(model.residual.valueWeights);
  const countsBefore=[...model.residual.bidActionCounts];
  const bot=new LearningBot(engine,model,{training:true,epsilon:1,allowDeviations:false,seed:1});
  const ctx={...context,myBalance:100};
  const baseline=new MathBotV2(engine);
  assert.equal(bot.decideBid(ctx),baseline.decideBid(ctx));
  assert.equal(bot.chooseWord(ctx),baseline.chooseWord(ctx));
  bot.finishEpisode(100);
  assert.equal(JSON.stringify([model.bidWeights,model.wordWeights]),actorBefore);
  assert.notEqual(JSON.stringify(model.residual.valueWeights),criticBefore);
  assert.equal(model.residual.bidActionCounts[1],countsBefore[1]!+1);
  assert.equal(model.residual.bidActionCounts[2],countsBefore[2]);
});

test("bounded exploration learns from games, saves its profile, and frozen evaluation changes no parameters", () => {
  const engine=new WordEngine(["AT","ATE","TEA","EAT","QI","QAT"]);
  const model=createModel();
  const before=JSON.stringify(model);
  for(let game=0;game<12;game++){
    const bot=new LearningBot(engine,model,{training:true,seed:game+1});
    simulateMatch({engine,policies:[bot,{chooseWord:()=>null,decideBid:()=>1}],seed:game+1,
      startingRacks:["AT","QI"],bag:["E","A","T","E","A","T"]});
  }
  assert.equal(model.trainedGames,12);
  assert.ok(model.updates>0&&model.residual.valueUpdates>0);
  assert.notEqual(JSON.stringify(model.bidWeights),JSON.stringify(createModel().bidWeights));
  assert.ok(model.bidWeights.some(row=>row.slice(12).some(weight=>weight!==0)),"game-driven gradients must reach the new public-state channels");
  assert.notEqual(JSON.stringify(model),before);
  const dir=mkdtempSync(join(tmpdir(),"scrabble-residual-")),path=join(dir,"model.json");
  saveModel(path,model);
  const loaded=loadModel(path,"v2-residual");
  assert.deepEqual(loaded,model);
  const frozenBefore=JSON.stringify(loaded);
  simulateMatch({engine,policies:[new LearningBot(engine,loaded),new MathBotV2(engine)],seed:0x80000001});
  assert.equal(JSON.stringify(loaded),frozenBefore);
});

test("legacy twenty-feature checkpoints keep their weights/counters and frozen inference leaves their input unchanged", () => {
  const legacy=createModel("legacy-mc");
  legacy.trainedGames=391;legacy.updates=35_681;
  legacy.bidWeights[0]![12]=0.75;legacy.wordWeights[2]![19]=-0.25;
  const before=JSON.stringify(legacy);
  const dir=mkdtempSync(join(tmpdir(),"scrabble-legacy20-")),path=join(dir,"model.json");
  saveModel(path,legacy);
  const loaded=loadModel(path,"legacy-mc");
  assert.deepEqual(loaded,legacy);
  const bot=new LearningBot(new WordEngine(["AT","ATE"]),legacy);
  bot.decideBid(context);bot.chooseWord(context);bot.finishEpisode(100);
  assert.equal(JSON.stringify(legacy),before);
});
