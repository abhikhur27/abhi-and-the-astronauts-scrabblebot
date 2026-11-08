import test from "node:test";
import assert from "node:assert/strict";
import { WordEngine } from "../src/engine.js";
import { resolveAuction, simulateMatch, TILE_DISTRIBUTION } from "../src/simulator.js";
import type { BotPolicy, DecisionContext, PublicInformation } from "../src/types.js";
import { CoordinatedBot } from '../src/coordinated-policy.js';
import { MathBot as V2 } from '../src/math-v2.js';

test("Vickrey winner pays runner up or reserve; first price pays own bid", () => {
  assert.deepEqual(resolveAuction([12, 7, 0], [100, 100, 100], "Vickrey", () => 0), { winner: 0, paid: 7 });
  assert.deepEqual(resolveAuction([12, 0, 0], [100, 100, 100], "Vickrey", () => 0), { winner: 0, paid: 1 });
  assert.deepEqual(resolveAuction([12, 7, 0], [100, 100, 100], "FirstPrice", () => 0), { winner: 0, paid: 12 });
  assert.deepEqual(resolveAuction([0, 0], [100, 100], "Vickrey", () => 0), { winner: null, paid: 0 });
});
test("unfunded and noninteger bids are rejected and random ties have no seat priority", () => {
  assert.deepEqual(resolveAuction([101, 7], [100, 100], "Vickrey", () => 0), { winner: 1, paid: 1 });
  assert.deepEqual(resolveAuction([4.5, 3], [100, 100], "Vickrey", () => 0), { winner: 1, paid: 1 });
  assert.equal(resolveAuction([9, 9], [100, 100], "Vickrey", () => 0.99).winner, 1);
});
test("last awarded tile cannot be redeemed and no-bid tile is consumed", () => {
  const engine = new WordEngine(["AT"]);
  const bot: BotPolicy = { decideBid: () => 10, chooseWord: (ctx) => engine.playable(ctx.myRack)[0]?.word ?? null };
  const result = simulateMatch({ engine, policies: [bot, { decideBid: () => 0, chooseWord: () => null }], seed: 1, startingRacks: ["A", ""], bag: ["T"] });
  assert.equal(result.players[0]!.score, 0);
  assert.equal(result.players[0]!.rack.get("T"), 1);
  assert.equal(result.auctions, 1);
  const noBid = simulateMatch({ engine, policies: [{ decideBid: () => 0, chooseWord: () => null }], seed: 1, startingRacks: [""], bag: ["A", "T"] });
  assert.equal(noBid.auctions, 2);
});
test('submitted bids precede cashout and can be revised only after confirmed own word income',()=>{
 const frames:{balance:number;committed:number|undefined}[]=[];
 const engine=new WordEngine(['AT']);
 const own:BotPolicy={decideBid:ctx=>{frames.push({balance:ctx.myBalance,committed:ctx.committedBid});return ctx.tilesRemaining>0?(ctx.myBalance>=102?20:5):0;},chooseWord:ctx=>engine.playable(ctx.myRack,1)[0]?.word??null};
 const other:BotPolicy={decideBid:ctx=>ctx.tilesRemaining>0?10:0,chooseWord:()=>null};
 const result=simulateMatch({engine,policies:[own,other],seed:1,startingRacks:['AT','ZZ'],bag:['E','Q']});
 assert.deepEqual(frames.slice(0,2),[{balance:100,committed:undefined},{balance:102,committed:5}]);
 assert.equal(result.players[0]!.spent,10);assert.equal(result.players[0]!.rack.get('E'),1);
});
test('coordinated simulation preserves a committed last-usable DROWN completion',()=>{
 const engine=new WordEngine(['WORN','DROWN']);
 const result=simulateMatch({engine,policies:[new CoordinatedBot(engine,new V2(engine)),{decideBid:()=>0,chooseWord:()=>null}],seed:2,startingRacks:['NORW','ZZZZ'],bag:['D','E']});
 assert.deepEqual(result.players[0]!.words,['DROWN']);assert.equal(result.players[0]!.score,18);
});
test('a confirmed cashout can cancel an existing bid without revealing rival bids',()=>{
 const engine=new WordEngine(['AT']);
 const own:BotPolicy={decideBid:ctx=>ctx.myScore===0?20:0,chooseWord:ctx=>engine.playable(ctx.myRack,1)[0]?.word??null};
 const other:BotPolicy={decideBid:ctx=>ctx.tilesRemaining>0?10:0,chooseWord:()=>null};
 const result=simulateMatch({engine,policies:[own,other],seed:1,startingRacks:['AT','ZZ'],bag:['E','Q']});
 assert.equal(result.players[0]!.spent,0);
 assert.equal(result.players[0]!.rack.has('E'),false);
 assert.equal(result.players[1]!.rack.get('E'),1);
});
test('multiple confirmed words permit only two replacements in the same auction',()=>{
 const frames:{balance:number;committed:number|undefined}[]=[];
 const engine=new WordEngine(['AT']);
 const own:BotPolicy={decideBid:ctx=>{if(ctx.letter==='E')frames.push({balance:ctx.myBalance,committed:ctx.committedBid});return 10-ctx.myScore/2;},chooseWord:ctx=>engine.playable(ctx.myRack,1)[0]?.word??null};
 const result=simulateMatch({engine,policies:[own,{decideBid:()=>0,chooseWord:()=>null}],seed:1,startingRacks:['ATATATAT','ZZZZZZZZ'],bag:['E','Q']});
 assert.deepEqual(frames,[{balance:100,committed:undefined},{balance:102,committed:10},{balance:104,committed:9}]);
 assert.equal(result.players[0]!.words.length,4);
 assert.equal(result.players[0]!.score,8);
});
test("words consume repeated tiles, add currency and score, and fixed seeds reproduce", () => {
  const engine = new WordEngine(["AT", "AA"]);
  const policies: BotPolicy[] = [{ decideBid: () => 0, chooseWord: (ctx) => engine.playable(ctx.myRack)[0]?.word ?? null }, { decideBid: () => 0, chooseWord: () => null }];
  const options = { engine, policies, seed: 123, startingRacks: ["AAT", ""], bag: ["E", "E"] };
  const first = simulateMatch(options);
  assert.equal(first.players[0]!.score, 2);
  assert.equal(first.players[0]!.balance, 102);
  assert.equal([...first.players[0]!.rack.values()].reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(simulateMatch(options), first);
});

test("simulated policies receive conserved public beliefs after purchases and unbid reveals", () => {
  const seen: DecisionContext[] = [];
  const observer: BotPolicy = { decideBid: (ctx) => { seen.push(ctx); return 0; }, chooseWord: () => null };
  const buyer: BotPolicy = { decideBid: (ctx) => ctx.letter === "S" ? 10 : 0, chooseWord: () => null };
  simulateMatch({ engine: new WordEngine([]), policies: [observer, buyer], seed: 100,
    startingRacks: ["AT", "ER"], bag: ["S", "N", "O"] });
  assert.equal(seen.length, 3);
  for (let round = 0; round < seen.length; round++) {
    const ctx = seen[round]!;
    assert.equal(ctx.myBotId, "0");
    assert.equal(ctx.opponents?.[0]?.botId, "1");
    assert.equal(ctx.information?.consistent, true);
    assert.equal(ctx.information.bagCount, 2 - round);
    assert.equal(ctx.information.observedAuctionCount, round + 1);
    for (const sample of ctx.information.samples) {
      assert.equal([...sample.bag.values()].reduce((sum, value) => sum + value, 0), 2 - round);
      const other = sample.opponentRacks.get("1")!;
      assert.equal([...other.values()].reduce((sum, value) => sum + value, 0), round === 0 ? 2 : 3);
      if (round > 0) assert.ok((other.get("S") ?? 0) >= 1);
    }
  }
  const final = seen[2]!.information!;
  assert.equal(final.bagCount, 0);
  assert.equal(final.opponents[0]!.rackMinimum.get("S"), 1);
  assert.equal(final.opponents[0]!.rackMinimum.get("E"), 1);
  assert.equal(final.opponents[0]!.rackMinimum.get("R"), 1);
});

test("different hidden allocations with the same public prefix produce identical observer beliefs", () => {
  const firstObservation = (otherRack: string, hiddenBag: string[], seed = 123): PublicInformation | undefined => {
    let first: PublicInformation | undefined;
    const observer: BotPolicy = { decideBid: (ctx) => { first ??= ctx.information; return 0; }, chooseWord: () => null };
    simulateMatch({ engine: new WordEngine([]), policies: [observer, { decideBid: () => 0, chooseWord: () => null }],
      seed, startingRacks: ["AT", otherRack], bag: hiddenBag });
    return first;
  };
  const original = firstObservation("ER", ["S", "N", "O"]);
  assert.ok(original?.consistent);
  assert.deepEqual(original, firstObservation("EN", ["S", "R", "O"]));
  assert.deepEqual(original, firstObservation("EN", ["S", "R", "O"], 124));
});

test("word consumption is public before the next player's decision and bounds hidden starts", () => {
  let otherAfterWord: DecisionContext | undefined;
  const engine = new WordEngine(["AT"]);
  const redeemer: BotPolicy = { decideBid: () => 0, chooseWord: (ctx) => engine.playable(ctx.myRack)[0]?.word ?? null };
  const observer: BotPolicy = { decideBid: () => 0, chooseWord: (ctx) => { otherAfterWord ??= ctx; return null; } };
  simulateMatch({ engine, policies: [redeemer, observer], seed: 456, startingRacks: ["AT", "ER"], bag: ["S", "N", "O"] });
  assert.equal(otherAfterWord?.information?.consistent, true);
  const opponent = otherAfterWord!.information!.opponents[0]!;
  assert.equal(opponent.botId, "0");
  assert.equal(opponent.rackSize, 0);
  assert.equal(opponent.initialMinimum.get("A"), 1);
  assert.equal(opponent.initialMinimum.get("T"), 1);
  for (const sample of otherAfterWord!.information!.samples) {
    assert.equal([...sample.opponentRacks.get("0")!.values()].reduce((sum, count) => sum + count, 0), 0);
  }
});

test("standard six-player simulation conserves all 98 tiles in each observer's feasible scenarios", () => {
  const revealed = new Map<string, number>();
  let observedAuctions = 0;
  const observer: BotPolicy = {
    chooseWord: () => null,
    decideBid: (ctx) => {
      observedAuctions++;
      revealed.set(ctx.letter, (revealed.get(ctx.letter) ?? 0) + 1);
      assert.equal(ctx.information?.consistent, true);
      const sample = ctx.information.samples[0]!;
      for (const [letter, total] of TILE_DISTRIBUTION) {
        const physicallyAccounted = (revealed.get(letter) ?? 0) + (ctx.myRack.get(letter) ?? 0)
          + (sample.bag.get(letter) ?? 0)
          + [...sample.opponentRacks.values()].reduce((sum, rack) => sum + (rack.get(letter) ?? 0), 0);
        assert.equal(physicallyAccounted, total, `round ${observedAuctions}, tile ${letter}`);
      }
      return 0;
    },
  };
  const idle: BotPolicy = { decideBid: () => 0, chooseWord: () => null };
  simulateMatch({ engine: new WordEngine([]), policies: [observer, idle, idle, idle, idle, idle], seed: 987, beliefParticles: 8 });
  assert.equal(observedAuctions, 68);
});

test("unequal custom starting-rack fixtures remain playable with explicitly inconsistent beliefs", () => {
  let knownFallback = false;
  const observer: BotPolicy = { chooseWord: () => null, decideBid: (ctx) => {
    knownFallback = ctx.information?.consistent === false;
    return 0;
  } };
  const result = simulateMatch({ engine: new WordEngine([]), policies: [observer, { chooseWord: () => null, decideBid: () => 0 }],
    seed: 1234, startingRacks: ["AT", ""], bag: ["E"] });
  assert.equal(knownFallback, true);
  assert.equal(result.auctions, 1);
});
