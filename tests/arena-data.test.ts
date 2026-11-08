import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaPublicSqlClient, decodeArenaSql, discoverArenaPlayers, reconstructArenaTeachers, refreshArenaData, validateArenaGame } from "../src/arena-data.js";
import type { ArenaCompleteGame } from "../src/arena-data.js";
import { fitArenaProfile, splitArenaMatches } from "../src/arena-profile.js";

const names=new Map([[114,"Bron"],[171,"GodOfThudner"],[18,"LUCENT"],[180,"NewStrongPlayer"]]);
const dictionary=new Set(["QI","AT","GO"]);
function game(id:number):ArenaCompleteGame {
  const base=Date.parse("2026-11-07T21:00:00Z")*1000+id*1_000_000;
  return {
    match:{id,totalAuctions:3,startingRackSize:1,auctionType:"Vickrey",createdAt:base,endedAt:base+900000},
    participants:[{id:id*10,matchId:id,botId:114,score:11,balance:110},{id:id*10+1,matchId:id,botId:171,score:2,balance:101},{id:id*10+2,matchId:id,botId:18,score:3,balance:102}],
    auctions:[{id:id*10,matchId:id,letter:"I",opensAt:base+100000,closesAt:base+200000},{id:id*10+1,matchId:id,letter:"T",opensAt:base+300000,closesAt:base+400000},{id:id*10+2,matchId:id,letter:"O",opensAt:base+500000,closesAt:base+600000}],
    results:[{auctionId:id*10,matchId:id,letter:"I",winnerBotId:114,paid:1,topBid:14,closedAt:base+200000},{auctionId:id*10+1,matchId:id,letter:"T",winnerBotId:171,paid:1,topBid:7,closedAt:base+400000},{auctionId:id*10+2,matchId:id,letter:"O",winnerBotId:18,paid:1,topBid:8,closedAt:base+600000}],
    words:[{id:id*10,matchId:id,botId:114,word:"QI",reward:11,playedAt:base+350000},{id:id*10+1,matchId:id,botId:171,word:"AT",reward:2,playedAt:base+450000},{id:id*10+2,matchId:id,botId:18,word:"GO",reward:3,playedAt:base+650000}],
  };
}
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));

test("public game validation rejects missing archives, inconsistent accounts and impossible hidden starts",()=>{
  assert.equal(validateArenaGame(game(1),dictionary),null);
  const noArchive=game(1);noArchive.results[0].topBid=-1;
  assert.match(validateArenaGame(noArchive,dictionary)!,/archive/);
  const wrongBalance=game(1);wrongBalance.participants[0].balance++;
  assert.match(validateArenaGame(wrongBalance,dictionary)!,/balance/);
  const wrongWord=game(1);wrongWord.words[0].word="ZZ";wrongWord.words[0].reward=20;wrongWord.participants[0].score=20;wrongWord.participants[0].balance=119;
  assert.match(validateArenaGame(wrongWord)!,/initial|finite/);
  const missing=game(1);missing.auctions.pop();assert.match(validateArenaGame(missing)!,/incomplete/);
});

test("retrospective teacher own-state labels preserve payments, censored losers and auction ambiguity",()=>{
  const games=[game(1),game(2),game(3),game(4)];
  const split=splitArenaMatches(games.map(g=>g.match.id),.25);
  assert.deepEqual(split,{trainMatchIds:[1,2,3],validationMatchIds:[4]});
  const discovery=discoverArenaPlayers(games.slice(0,3),names,{minMatches:2});
  assert.ok(discovery.find(x=>x.botId===114)?.selected);
  const data=reconstructArenaTeachers(games,discovery,split);
  const rows=data.teacherRows.filter(r=>r.matchId===1);
  assert.deepEqual(rows[0].rack,{Q:1});
  assert.deepEqual(rows[0].bidLabel,{type:"exact-winner-bid",amount:14});
  assert.equal(rows[0].paid,1);
  assert.deepEqual(rows[1].bidLabel,{type:"censored-loser-upper-bound",amount:7});
  assert.deepEqual(rows[1].rack,{Q:1,I:1});assert.equal(rows[1].wordDuringAuction,true);
  assert.deepEqual(rows[2].rack,{});assert.equal(rows[2].balance,110);
  assert.ok(data.teacherRows.filter(r=>r.matchId===4).every(r=>r.split==="validation"));
  const partial=game(5);partial.match.startingRackSize=2;
  const uncertain=reconstructArenaTeachers([partial],discovery,{trainMatchIds:[5],validationMatchIds:[]});
  assert.equal(uncertain.teacherRows.length,0);assert.equal(uncertain.nonUnique,1);
});

test("compact fitting excludes held-out matches and ambiguous exact bids",()=>{
  const games=[game(1),game(2),game(3),game(4)],split=splitArenaMatches([1,2,3,4],.25);
  const discovery=discoverArenaPlayers(games.slice(0,3),names,{minMatches:2});
  const data=reconstructArenaTeachers(games,discovery,split);
  const options={generation:"test",generatedAt:"2026-11-07T22:00:00Z",dictionarySha256:"hash",cutoffMatchId:4,cutoffEndedAt:"2026-11-07T21:00:05Z",staleAfter:"2026-11-07T23:00:00Z",teachers:discovery,...split};
  const profile=fitArenaProfile(data.teacherRows,data.wordRows,options);
  const changed=clone(data.teacherRows);for(const r of changed)if(r.split==="validation")r.bidLabel.amount=9999;
  assert.deepEqual(fitArenaProfile(changed,data.wordRows,options).bidBands,profile.bidBands);
  changed.find(r=>r.split==="train"&&r.bidLabel.type==="exact-winner-bid")!.wordDuringAuction=true;
  assert.equal(fitArenaProfile(changed,data.wordRows,options).counts.exactTrainingWins,profile.counts.exactTrainingWins-1);
  assert.throws(()=>fitArenaProfile(data.teacherRows,data.wordRows,{...options,validationMatchIds:[3,4]}),/overlap/);
});

test("recent discovery supports a new active winner and rejects small or inactive samples",()=>{
  const games=Array.from({length:8},(_,i)=>game(i+1));
  for(const g of games.slice(0,7)){for(const p of g.participants)if(p.botId===114)p.botId=180;}
  const ranked=discoverArenaPlayers(games,names,{minMatches:6});
  assert.equal(ranked.find(x=>x.botId===180)?.selected,true);
  assert.equal(ranked.find(x=>x.botId===180)?.matches,7);
  assert.equal(ranked.find(x=>x.botId===114)?.eligible,false);
  assert.equal(ranked.find(x=>x.botId===18)?.name,"LUCENT");
  const absent=discoverArenaPlayers([],names);assert.equal(absent.find(x=>x.botId===114)?.matches,0);
  const spiky=Array.from({length:8},(_,i)=>game(i+1));
  for(const g of spiky.slice(2)){const p=g.participants.find(x=>x.botId===114)!;p.score=0;p.balance=99;}
  const weakWinner=discoverArenaPlayers(spiky,names,{minMatches:6}).find(x=>x.botId===114)!;
  assert.equal(weakWinner.wins,2);assert.equal(weakWinner.eligible,false);
});

function sqlEnvelope(rows:Record<string,unknown>[]):unknown {
  const keys=Object.keys(rows[0]??{id:0});return [{schema:{elements:keys.map(k=>({name:{some:k}}))},rows:rows.map(r=>keys.map(k=>r[k]))}];
}
function mockTables(games:ArenaCompleteGame[]):Record<string,Record<string,unknown>[]> {
  return {
    match_state:games.map(g=>({id:g.match.id,status:[2,[]],current_round:g.match.totalAuctions,starting_rack_size:g.match.startingRackSize,auction_type:[1,[]],created_at:[g.match.createdAt],ended_at:[0,[g.match.endedAt]]})),
    bot:[...names].map(([id,name])=>({id,name})),
    match_participant:games.flatMap(g=>g.participants.map(p=>({id:p.id,match_id:p.matchId,bot_id:p.botId,balance:p.balance,score:p.score}))),
    auction:games.flatMap(g=>g.auctions.map(a=>({id:a.id,match_id:a.matchId,letter:a.letter,opens_at:[a.opensAt],closes_at:[a.closesAt]}))),
    auction_result:games.flatMap(g=>g.results.map(r=>({auction_id:r.auctionId,match_id:r.matchId,letter:r.letter,winner_bot_id:r.winnerBotId===null?[1,[]]:[0,r.winnerBotId],paid:r.paid,closed_at:[r.closedAt]}))),
    word_play:games.flatMap(g=>g.words.map(w=>({id:w.id,match_id:w.matchId,bot_id:w.botId,word:w.word,total_reward:w.reward,played_at:[w.playedAt]}))),
    auction_top_bid_archive:games.flatMap(g=>g.results.map(r=>({auction_id:r.auctionId,match_id:r.matchId,top_bid:r.topBid}))),
  };
}

test("anonymous refresh persists atomic cache, skips fresh requests and marks failed refresh stale",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"arena-data-test-")),dictionaryPath=join(dir,"words.txt");writeFileSync(dictionaryPath,"QI\nAT\nGO\n");
  const tables=mockTables([game(1),game(2),game(3),game(4)]),queries:string[]=[];
  const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{
    assert.equal((init?.headers as Record<string,string>).Authorization,undefined);
    const sql=String(init?.body);queries.push(sql);
    const table=/FROM (\w+)/.exec(sql)?.[1];assert.ok(table&&tables[table]);
    return new Response(JSON.stringify(sqlEnvelope(tables[table!])),{status:200});
  }) as typeof fetch;
  const options={fetchImpl,dictionaryPath,minTeacherMatches:2,maxMatches:4,now:new Date("2026-11-07T22:00:00Z")};
  const first=await refreshArenaData(dir,options);
  assert.equal(first.metadata.refreshStatus,"fresh");assert.equal(first.metadata.acceptedMatches,4);
  assert.equal(queries.length,7);assert.ok(!queries.some(q=>/FROM (auction_top_bid|pending_bid|holding|bag_letter|bot_stats)\b/.test(q)));
  assert.equal(JSON.parse(readFileSync(first.paths.profile,"utf8")).generation,first.metadata.generation);
  assert.deepEqual(first.metadata.discoveryMatchIds,first.metadata.trainMatchIds);
  const cached=await refreshArenaData(dir,{...options,fetchImpl:(async()=>{throw new Error("must not fetch fresh cache");}) as typeof fetch});
  assert.equal(cached.metadata.refreshStatus,"cached");
  writeFileSync(dictionaryPath,"QI\nAT\nGO\nCAT\n");
  const changedDictionary=await refreshArenaData(dir,options);
  assert.equal(changedDictionary.metadata.refreshStatus,"fresh");
  assert.notEqual(changedDictionary.metadata.dictionarySha256,first.metadata.dictionarySha256);
  assert.equal(queries.length,14);
  const stale=await refreshArenaData(dir,{...options,minRefreshIntervalMs:0,fetchImpl:(async()=>new Response("unavailable",{status:400})) as typeof fetch});
  assert.equal(stale.metadata.refreshStatus,"stale");assert.equal(stale.metadata.stale,true);
  assert.match(stale.metadata.refreshError!,/HTTP 400/);
  assert.equal(JSON.parse(readFileSync(first.paths.data,"utf8")).metadata.refreshStatus,"fresh");
});

test("SQL schema, bytes and row caps fail closed",async()=>{
  assert.throws(()=>decodeArenaSql(sqlEnvelope([{id:1},{id:2}]),1),/cap/);
  assert.throws(()=>decodeArenaSql([{schema:{elements:[{name:{some:"id"}}]},rows:[[1,2]]}]),/width/);
  const fetchImpl=(async()=>new Response("x".repeat(2000),{status:200})) as typeof fetch;
  await assert.rejects(new ArenaPublicSqlClient({fetchImpl,maxResponseBytes:1000}).query("SELECT id FROM bot"),/byte cap/);
  await assert.rejects(new ArenaPublicSqlClient({fetchImpl}).query("SELECT id FROM bot; DELETE FROM bot"),/rejected/);
  await assert.rejects(new ArenaPublicSqlClient({fetchImpl}).query("SELECT * FROM holding"),/rejected/);
  await assert.rejects(new ArenaPublicSqlClient({fetchImpl}).query("SELECT * FROM auction_top_bid"),/rejected/);
});
