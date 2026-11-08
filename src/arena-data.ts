import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BAG_COUNTS, wordReward } from "./engine.js";
import { atomicWriteJson } from "./atomic-json.js";
import { arenaPhase, fitArenaProfile, splitArenaMatches } from "./arena-profile.js";
import type { ArenaPlayerEvidence, ArenaProfile, ArenaTeacherRow, ArenaWordRow } from "./arena-profile.js";

const ENDPOINT="https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql";
type SqlRow=Record<string,unknown>;
export interface ArenaMatch { id:number; totalAuctions:number; startingRackSize:number; auctionType:"Vickrey"|"FirstPrice"; createdAt:number; endedAt:number; }
export interface ArenaParticipant { id:number; matchId:number; botId:number; balance:number; score:number; }
export interface ArenaAuction { id:number; matchId:number; letter:string; opensAt:number; closesAt:number; }
export interface ArenaResult { auctionId:number; matchId:number; letter:string; winnerBotId:number|null; paid:number; closedAt:number; topBid:number; }
export interface ArenaWord { id:number; matchId:number; botId:number; word:string; reward:number; playedAt:number; }
export interface ArenaCompleteGame { match:ArenaMatch; participants:ArenaParticipant[]; auctions:ArenaAuction[]; results:ArenaResult[]; words:ArenaWord[]; }
export interface ArenaMetadata {
  schema:"scrabblebot-arena-data-v1"; generation:string; generatedAt:string;
  refreshStatus:"fresh"|"cached"|"stale"; stale:boolean; source:typeof ENDPOINT;
  lookbackHours:number; maxMatches:number; fetchedCompletedMatches:number; acceptedMatches:number;
  cutoffMatchId:number; cutoffEndedAt:string; dictionarySha256:string;
  configurationHash:string;
  queries:number; queryBytes:number; queryRows:number; skippedMatches:{matchId:number;reason:string}[];
  trainMatchIds:number[]; validationMatchIds:number[]; discoveryMatchIds:number[];
  teacherReconstruction:{complete:number;nonUnique:number;invalid:number};
  refreshError?:string;
}
export interface ArenaData {
  metadata:ArenaMetadata; discovery:ArenaPlayerEvidence[]; teacherRows:ArenaTeacherRow[];
  wordRows:ArenaWordRow[]; profile:ArenaProfile;
}
export interface ArenaRefreshResult extends ArenaData { paths:{data:string;profile:string;discovery:string;latest:string}; }
export interface ArenaRefreshOptions {
  maxMatches?:number; lookbackHours?:number; minTeacherMatches?:number; maxTeachers?:number;
  validationFraction?:number; excludedBotIds?:readonly number[]; dictionaryPath?:string;
  requestTimeoutMs?:number; maxResponseBytes?:number; maxRowsPerQuery?:number;
  minRefreshIntervalMs?:number; staleAfterMs?:number; now?:Date;
  fetchImpl?:typeof fetch;
}

const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,Number.isFinite(n)?n:min));
const number=(x:unknown,label:string)=>{const n=Number(x);if(!Number.isSafeInteger(n))throw new Error("Invalid integer: "+label);return n;};
const micros=(x:unknown)=>number(Array.isArray(x)?x[0]:x,"timestamp");
const option=(x:unknown):unknown=>Array.isArray(x)&&x[0]===0?x[1]:null;
const timestampOption=(x:unknown)=>{const v=option(x);return v===null?null:micros(v);};
const letter=(x:unknown)=>{if(typeof x!=="string"||!/^[A-Z]$/.test(x))throw new Error("Invalid public letter");return x;};
const iso=(us:number)=>new Date(us/1000).toISOString();
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const dedup=<T>(rows:T[],key:(x:T)=>number):T[]=>{const m=new Map<number,T>();for(const row of rows){const id=key(row);const old=m.get(id);if(old&&JSON.stringify(old)!==JSON.stringify(row))throw new Error("Conflicting duplicate public row "+id);m.set(id,row);}return [...m.values()];};

export function decodeArenaSql(value:unknown,maxRows=25000):SqlRow[] {
  if(!Array.isArray(value)||value.length!==1)throw new Error("Unexpected SQL response envelope");
  const result=value[0] as {schema?:{elements?:{name?:{some?:string}}[]};rows?:unknown[][]};
  const elements=result?.schema?.elements,rows=result?.rows;
  if(!Array.isArray(elements)||!Array.isArray(rows)||rows.length>maxRows)throw new Error("SQL schema/row cap rejected");
  const keys=elements.map(e=>e.name?.some);
  if(keys.some(k=>typeof k!=="string")||new Set(keys).size!==keys.length)throw new Error("Invalid SQL column names");
  return rows.map(row=>{if(!Array.isArray(row)||row.length!==keys.length)throw new Error("Invalid SQL row width");return Object.fromEntries(keys.map((k,i)=>[k!,row[i]]));});
}

export class ArenaPublicSqlClient {
  queries=0; bytes=0; rows=0;
  private previousRequestAt=0;
  constructor(private options:{fetchImpl?:typeof fetch;timeoutMs?:number;maxResponseBytes?:number;maxRows?:number}={}){}
  async query(sql:string):Promise<SqlRow[]> {
    const table=/^SELECT (?:\*|[a-z_]+(?:, [a-z_]+)*) FROM ([a-z_]+)(?: WHERE .*)?$/i.exec(sql)?.[1];
    const publicTables=new Set(["bot","match_state","match_participant","auction","auction_result","word_play","auction_top_bid_archive"]);
    if(sql.length>2000||!table||!publicTables.has(table)||/[;\r\n]/.test(sql)||/\b(?:SELECT|JOIN|UNION)\b/i.test(sql.slice(7)))throw new Error("Arena SQL query rejected");
    const fetcher=this.options.fetchImpl??fetch;
    for(let attempt=0;attempt<2;attempt++) {
      const delay=150-(Date.now()-this.previousRequestAt);if(delay>0)await wait(delay);
      this.previousRequestAt=Date.now();this.queries++;
      let retry=false;
      try {
        const response=await fetcher(ENDPOINT,{method:"POST",headers:{"Content-Type":"text/plain","Accept":"application/json"},body:sql,signal:AbortSignal.timeout(this.options.timeoutMs??10000)});
        if(!response.ok){retry=response.status===429||response.status>=500;throw new Error("Public SQL HTTP "+response.status);}
        const cap=this.options.maxResponseBytes??8_000_000;
        if(Number(response.headers.get("content-length")??0)>cap)throw new Error("Public SQL response byte cap exceeded");
        const reader=response.body?.getReader();if(!reader)throw new Error("Missing SQL response body");
        const chunks:Uint8Array[]=[];let size=0;
        while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>cap){await reader.cancel();throw new Error("Public SQL response byte cap exceeded");}chunks.push(r.value);}
        this.bytes+=size;
        const joined=new Uint8Array(size);let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.length;}
        const rows=decodeArenaSql(JSON.parse(new TextDecoder().decode(joined)),this.options.maxRows??25000);this.rows+=rows.length;return rows;
      } catch(error) {
        if(error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError"||error instanceof TypeError))retry=true;
        if(!retry||attempt===1)throw error;
        await wait(250);
      }
    }
    throw new Error("Public SQL retry exhausted");
  }
}

function wilson(success:number,n:number):number {
  if(!n)return 0;const z=1.64,p=success/n;
  return (p+z*z/(2*n)-z*Math.sqrt((p*(1-p)+z*z/(4*n))/n))/(1+z*z/n);
}
/** Ranking uses only this bounded recent training cohort, not all-time bot_stats. */
export function discoverArenaPlayers(games:readonly ArenaCompleteGame[],names:ReadonlyMap<number,string>,options:{minMatches?:number;maxTeachers?:number;excludedBotIds?:readonly number[]}={}):ArenaPlayerEvidence[] {
  const requestedIds=new Set([114,171,18]);
  for(const [id,name] of names)if(/^(bron|godofthu?nd?er|godofthudner|lucent|lcuent)$/i.test(name.replace(/[\s_-]/g,"")))requestedIds.add(id);
  const excluded=new Set(options.excludedBotIds??[169]);
  const accum=new Map<number,{games:number;active:number;wins:number;pairSuccess:number;pairs:number;score:number;norm:number;activeOpp:number;opponentIds:number[];lastId:number;lastTime:number}>();
  for(const game of games){
    const active=game.participants.filter(p=>p.score>0||100+p.score-p.balance>0);
    const high=Math.max(0,...game.participants.map(p=>p.score));
    for(const p of game.participants){
      let a=accum.get(p.botId);if(!a){a={games:0,active:0,wins:0,pairSuccess:0,pairs:0,score:0,norm:0,activeOpp:0,opponentIds:[],lastId:0,lastTime:0};accum.set(p.botId,a);}
      const opponents=active.filter(x=>x.botId!==p.botId);
      a.games++;a.active+=Number(active.some(x=>x.botId===p.botId));a.wins+=Number(high>0&&p.score===high);a.score+=p.score;a.norm+=high>0?p.score/high:0;a.activeOpp+=opponents.length;
      for(const other of opponents){a.pairs++;a.pairSuccess+=p.score>other.score?1:p.score===other.score?.5:0;a.opponentIds.push(other.botId);}
      if(game.match.id>a.lastId){a.lastId=game.match.id;a.lastTime=game.match.endedAt;}
    }
  }
  const strength=new Map([...accum].map(([id,a])=>[id,(a.pairSuccess+2)/(a.pairs+4)]));
  const minimum=Math.max(2,options.minMatches??6);
  const evidence=[...accum].map(([botId,a]):ArenaPlayerEvidence=>{
    const lower=wilson(a.pairSuccess,a.pairs),opponentStrength=a.opponentIds.length?a.opponentIds.reduce((s,id)=>s+(strength.get(id)??.5),0)/a.opponentIds.length:0;
    const pairwiseRate=a.pairSuccess/Math.max(1,a.pairs);
    const eligible=!excluded.has(botId)&&a.active>=minimum&&a.pairs>=minimum*2&&pairwiseRate>=.5&&(a.wins/a.games>=.15||pairwiseRate>=.55);
    return {botId,name:names.get(botId)??`bot-${botId}`,requested:requestedIds.has(botId),eligible,selected:false,matches:a.games,observedActiveMatches:a.active,wins:a.wins,pairwiseComparisons:a.pairs,pairwiseWinRate:a.pairs?a.pairSuccess/a.pairs:0,pairwiseWilsonLower:lower,meanScore:a.score/a.games,meanNormalizedScore:a.norm/a.games,meanObservedActiveOpponents:a.activeOpp/a.games,opponentStrength,discoveryScore:.65*lower+.25*opponentStrength+.10*a.norm/a.games,lastMatchId:a.lastId,lastEndedAt:iso(a.lastTime),reason:excluded.has(botId)?"excluded own/training persona":a.active<minimum?`insufficient recent observed-active matches (${a.active}/${minimum})`:eligible?"supported recent opposition-aware performance":"insufficient recent competitive evidence"};
  }).sort((a,b)=>b.discoveryScore-a.discoveryScore||b.observedActiveMatches-a.observedActiveMatches||a.botId-b.botId);
  const selected=[...evidence.filter(x=>x.eligible&&x.requested),...evidence.filter(x=>x.eligible&&!x.requested)].slice(0,Math.max(3,options.maxTeachers??8));
  const selectedIds=new Set(selected.map(x=>x.botId));for(const row of evidence)row.selected=selectedIds.has(row.botId);
  // Requested bots with no recent games remain visible as insufficient evidence.
  for(const id of requestedIds)if(!evidence.some(x=>x.botId===id))evidence.push({botId:id,name:names.get(id)??`bot-${id}`,requested:true,eligible:false,selected:false,matches:0,observedActiveMatches:0,wins:0,pairwiseComparisons:0,pairwiseWinRate:0,pairwiseWilsonLower:0,meanScore:0,meanNormalizedScore:0,meanObservedActiveOpponents:0,opponentStrength:0,discoveryScore:0,lastMatchId:0,lastEndedAt:"",reason:"no completed games in recent training cohort"});
  return evidence;
}

function initialMinimum(game:ArenaCompleteGame,botId:number):Record<string,number> {
  const net:Record<string,number>={},initial:Record<string,number>={};
  const events=[...game.results.filter(x=>x.winnerBotId===botId).map(x=>({time:x.closedAt,kind:0,letter:x.letter})),...game.words.filter(x=>x.botId===botId).map(x=>({time:x.playedAt,kind:1,word:x.word}))].sort((a,b)=>a.time-b.time||a.kind-b.kind);
  for(const event of events){if("letter" in event){net[event.letter]=(net[event.letter]??0)+1;}else for(const l of event.word){net[l]=(net[l]??0)-1;initial[l]=Math.max(initial[l]??0,-net[l]);}}
  return Object.fromEntries(Object.entries(initial).filter(([,n])=>n>0));
}

export function reconstructArenaTeachers(games:readonly ArenaCompleteGame[],teachers:readonly ArenaPlayerEvidence[],split:{trainMatchIds:readonly number[];validationMatchIds:readonly number[]}):{teacherRows:ArenaTeacherRow[];wordRows:ArenaWordRow[];complete:number;nonUnique:number;invalid:number} {
  const selected=new Map(teachers.filter(x=>x.selected&&x.eligible).map(x=>[x.botId,x.name]));
  const train=new Set(split.trainMatchIds),validation=new Set(split.validationMatchIds);
  if([...train].some(x=>validation.has(x)))throw new Error("Arena split overlap");
  const teacherRows:ArenaTeacherRow[]=[],wordRows:ArenaWordRow[]=[];let complete=0,nonUnique=0,invalid=0;
  for(const game of games)for(const p of game.participants){
    const name=selected.get(p.botId);if(!name)continue;
    const start=initialMinimum(game,p.botId),count=Object.values(start).reduce((a,b)=>a+b,0);
    if(count!==game.match.startingRackSize){if(count>game.match.startingRackSize)invalid++;else nonUnique++;continue;}
    if(!train.has(game.match.id)&&!validation.has(game.match.id))throw new Error("Unassigned arena match");
    const set=train.has(game.match.id)?"train" as const:"validation" as const;
    const rack={...start};let balance=100,score=0,previousWord:number|null=null;
    const myWords=game.words.filter(w=>w.botId===p.botId);
    const events=[...game.results.filter(r=>r.winnerBotId===p.botId).map(r=>({time:r.closedAt,kind:0,result:r})),...myWords.map(w=>({time:w.playedAt,kind:1,word:w}))].sort((a,b)=>a.time-b.time||a.kind-b.kind);
    let i=0;
    const applyUntil=(time:number)=>{while(i<events.length&&events[i].time<=time){const e=events[i++];if("result" in e){const r=e.result;rack[r.letter]=(rack[r.letter]??0)+1;balance-=r.paid;}else{const w=e.word;const round=game.results.filter(r=>r.closedAt<w.playedAt).length;wordRows.push({matchId:game.match.id,botId:p.botId,teacher:name,round,totalAuctions:game.match.totalAuctions,phase:arenaPhase(Math.max(1,round),game.match.totalAuctions),word:w.word,reward:w.reward,balance,rack:{...rack},rackSize:Object.values(rack).reduce((a,b)=>a+b,0),split:set,sincePreviousWordMs:previousWord===null?null:(w.playedAt-previousWord)/1000});for(const l of w.word){rack[l]=(rack[l]??0)-1;if(rack[l]===0)delete rack[l];if(rack[l]<0)throw new Error("Negative reconstructed teacher rack");}balance+=w.reward;score+=w.reward;previousWord=w.playedAt;}}};
    const resultById=new Map(game.results.map(r=>[r.auctionId,r]));
    const auctions=game.auctions.slice().sort((a,b)=>a.opensAt-b.opensAt||a.id-b.id);
    for(let round=0;round<auctions.length;round++){
      const a=auctions[round];applyUntil(a.opensAt);const result=resultById.get(a.id)!;
      teacherRows.push({provenance:"public-completed-game-retrospective-teacher-own-rack",matchId:game.match.id,botId:p.botId,teacher:name,auctionId:a.id,round:round+1,totalAuctions:auctions.length,remainingAuctions:auctions.length-round-1,phase:arenaPhase(round+1,auctions.length),letter:a.letter,rack:{...rack},balance,score,opponentCount:game.participants.length-1,auctionType:game.match.auctionType,bidLabel:{type:result.winnerBotId===p.botId?"exact-winner-bid":"censored-loser-upper-bound",amount:result.topBid},paid:result.paid,wordDuringAuction:myWords.some(w=>w.playedAt>=a.opensAt&&w.playedAt<=a.closesAt),split:set});
    }
    applyUntil(Number.POSITIVE_INFINITY);
    if(balance!==p.balance||score!==p.score)throw new Error("Teacher balance/score reconstruction mismatch");complete++;
  }
  return {teacherRows,wordRows,complete,nonUnique,invalid};
}

export function validateArenaGame(game:ArenaCompleteGame,dictionary?:ReadonlySet<string>):string|null {
  const {match,participants,auctions,results,words}=game;
  if(!participants.length||participants.length>20||match.totalAuctions<1||match.totalAuctions>98)return "invalid match dimensions";
  if(auctions.length!==match.totalAuctions||results.length!==match.totalAuctions)return "incomplete auction/result/archive history";
  const players=new Set(participants.map(p=>p.botId)),auctionIds=new Set(auctions.map(a=>a.id));
  if(players.size!==participants.length||auctionIds.size!==auctions.length)return "duplicate participants/auctions";
  if(results.some(r=>!auctionIds.has(r.auctionId)||r.topBid<0||r.paid<0||r.paid>r.topBid||r.winnerBotId!==null&&!players.has(r.winnerBotId)))return "invalid settlement/archive";
  const auctionById=new Map(auctions.map(a=>[a.id,a]));
  if(results.some(r=>r.letter!==auctionById.get(r.auctionId)?.letter||r.winnerBotId===null&&(r.topBid!==0||r.paid!==0)||r.winnerBotId!==null&&r.paid<1||match.auctionType==="FirstPrice"&&r.topBid!==r.paid))return "settlement letter/payment mismatch";
  if(new Set(results.map(r=>r.auctionId)).size!==results.length)return "duplicate settlement";
  if(words.some(w=>!players.has(w.botId)||!dictionary?.has(w.word)&&dictionary!==undefined||wordReward(w.word)!==w.reward))return "invalid public word/reward";
  const revealed:Record<string,number>={};for(const r of results)revealed[r.letter]=(revealed[r.letter]??0)+1;
  if(Object.entries(revealed).some(([l,n])=>n>(BAG_COUNTS[l]??0)))return "revealed letters exceed finite bag";
  const forcedInitial:Record<string,number>={};
  for(const p of participants){const reward=words.filter(w=>w.botId===p.botId).reduce((a,w)=>a+w.reward,0),paid=results.filter(r=>r.winnerBotId===p.botId).reduce((a,r)=>a+r.paid,0);if(p.score!==reward||p.balance!==100+reward-paid)return "participant balance/score mismatch";const initial=initialMinimum(game,p.botId);if(Object.values(initial).reduce((a,b)=>a+b,0)>match.startingRackSize)return "impossible hidden initial rack";for(const [l,n]of Object.entries(initial))forcedInitial[l]=(forcedInitial[l]??0)+n;}
  if(Object.entries(forcedInitial).some(([l,n])=>n+(revealed[l]??0)>(BAG_COUNTS[l]??0)))return "hidden initial lower bounds exceed finite bag";
  return null;
}

export async function refreshArenaData(outputDir:string,options:ArenaRefreshOptions={}):Promise<ArenaRefreshResult> {
  const paths={data:resolve(outputDir,"arena-data.json"),profile:resolve(outputDir,"arena-profile.json"),discovery:resolve(outputDir,"arena-discovery.json"),latest:resolve(outputDir,"arena-latest.json")};
  const now=options.now??new Date(),nowMs=now.getTime();if(!Number.isFinite(nowMs))throw new Error("Invalid arena refresh time");
  const minRefresh=clamp(options.minRefreshIntervalMs??300000,0,3600000),staleAfter=clamp(options.staleAfterMs??3600000,60000,86400000);
  let cached:ArenaData|undefined;
  try{const raw=JSON.parse(await readFile(paths.data,"utf8"));if(raw.metadata?.schema==="scrabblebot-arena-data-v1"&&raw.profile?.schema==="scrabblebot-arena-profile-v1")cached=raw;}catch{}
  try {
    const maxMatches=Math.floor(clamp(options.maxMatches??120,2,160)),lookbackHours=clamp(options.lookbackHours??6,.25,24);
    const minTeacherMatches=Math.floor(clamp(options.minTeacherMatches??6,2,maxMatches)),maxTeachers=Math.floor(clamp(options.maxTeachers??8,3,12));
    const validationFraction=clamp(options.validationFraction??.2,.1,.5),excludedBotIds=[...(options.excludedBotIds??[169])].sort((a,b)=>a-b);
    const dictionaryBytes=await readFile(options.dictionaryPath??resolve("data/enable1.txt"));
    const dictionarySha256=createHash("sha256").update(dictionaryBytes).digest("hex"),dictionary=new Set(dictionaryBytes.toString("utf8").split(/\r?\n/).map(w=>w.trim().toUpperCase()).filter(w=>/^[A-Z]{2,}$/.test(w)));
    const configurationHash=createHash("sha256").update(JSON.stringify({discoveryVersion:2,maxMatches,lookbackHours,minTeacherMatches,maxTeachers,validationFraction,excludedBotIds,dictionarySha256})).digest("hex");
    if(cached&&cached.metadata.configurationHash===configurationHash&&nowMs-Date.parse(cached.metadata.generatedAt)>=0&&nowMs-Date.parse(cached.metadata.generatedAt)<minRefresh)return {...cached,metadata:{...cached.metadata,refreshStatus:"cached",stale:nowMs>Date.parse(cached.profile.staleAfter)},paths};
    const client=new ArenaPublicSqlClient({fetchImpl:options.fetchImpl,timeoutMs:clamp(options.requestTimeoutMs??10000,100,15000),maxResponseBytes:clamp(options.maxResponseBytes??8_000_000,1000,12_000_000),maxRows:clamp(options.maxRowsPerQuery??25000,100,40000)});
    const since=new Date(nowMs-lookbackHours*3600000).toISOString();
    const rawMatches=await client.query(`SELECT * FROM match_state WHERE created_at > '${since}'`);
    const matches=dedup(rawMatches.filter(r=>Array.isArray(r.status)&&r.status[0]===2&&timestampOption(r.ended_at)!==null).map(r=>({id:number(r.id,"match id"),totalAuctions:number(r.current_round,"rounds"),startingRackSize:number(r.starting_rack_size,"starting rack"),auctionType:(Array.isArray(r.auction_type)&&r.auction_type[0]===0?"FirstPrice":"Vickrey") as "FirstPrice"|"Vickrey",createdAt:micros(r.created_at),endedAt:timestampOption(r.ended_at)!})),m=>m.id).filter(m=>m.endedAt<=nowMs*1000).sort((a,b)=>b.id-a.id).slice(0,maxMatches);
    if(!matches.length)throw new Error("No completed matches in bounded lookback");
    const ids=new Set(matches.map(m=>m.id)),min=Math.min(...ids),max=Math.max(...ids),where=`WHERE match_id >= ${min} AND match_id <= ${max}`;
    const names=new Map((await client.query("SELECT id, name FROM bot")).map(r=>[number(r.id,"bot id"),String(r.name)]));
    const rawParticipants=await client.query(`SELECT * FROM match_participant ${where}`);
    const rawAuctions=await client.query(`SELECT * FROM auction ${where}`);
    const rawResults=await client.query(`SELECT * FROM auction_result ${where}`);
    const rawWords=await client.query(`SELECT * FROM word_play ${where}`);
    // Archive is public only after completion. No live private table/view is queried.
    const rawArchive=await client.query(`SELECT * FROM auction_top_bid_archive ${where}`);
    const participants=dedup(rawParticipants.filter(r=>ids.has(number(r.match_id,"match id"))).map(r=>({id:number(r.id,"participant id"),matchId:number(r.match_id,"match id"),botId:number(r.bot_id,"bot id"),balance:number(r.balance,"balance"),score:number(r.score,"score")})),p=>p.id);
    const auctions=dedup(rawAuctions.filter(r=>ids.has(number(r.match_id,"match id"))).map(r=>({id:number(r.id,"auction id"),matchId:number(r.match_id,"match id"),letter:letter(r.letter),opensAt:micros(r.opens_at),closesAt:micros(r.closes_at)})),a=>a.id);
    const archive=new Map(dedup(rawArchive.filter(r=>ids.has(number(r.match_id,"match id"))).map(r=>({auctionId:number(r.auction_id,"archive auction"),topBid:number(r.top_bid,"archived top bid")})),r=>r.auctionId).map(r=>[r.auctionId,r.topBid]));
    const results=dedup(rawResults.filter(r=>ids.has(number(r.match_id,"match id"))).map(r=>({auctionId:number(r.auction_id,"result auction"),matchId:number(r.match_id,"match id"),letter:letter(r.letter),winnerBotId:option(r.winner_bot_id)===null?null:number(option(r.winner_bot_id),"winner id"),paid:number(r.paid,"payment"),closedAt:micros(r.closed_at),topBid:archive.get(number(r.auction_id,"result auction"))??-1})),r=>r.auctionId);
    const words=dedup(rawWords.filter(r=>ids.has(number(r.match_id,"match id"))).map(r=>({id:number(r.id,"word id"),matchId:number(r.match_id,"match id"),botId:number(r.bot_id,"bot id"),word:String(r.word),reward:number(r.total_reward,"word reward"),playedAt:micros(r.played_at)})),w=>w.id);
    const games:ArenaCompleteGame[]=[],skippedMatches:{matchId:number;reason:string}[]=[];
    for(const match of matches){const game={match,participants:participants.filter(p=>p.matchId===match.id),auctions:auctions.filter(a=>a.matchId===match.id),results:results.filter(r=>r.matchId===match.id),words:words.filter(w=>w.matchId===match.id)};const reason=validateArenaGame(game,dictionary);if(reason)skippedMatches.push({matchId:match.id,reason});else games.push(game);}
    if(games.length<2)throw new Error("Fewer than two consistent completed public histories");
    const split=splitArenaMatches(games.map(g=>g.match.id),validationFraction),train=new Set(split.trainMatchIds);
    // Selection is fitted on training matches; held-out outcomes do not choose teachers.
    const discovery=discoverArenaPlayers(games.filter(g=>train.has(g.match.id)),names,{minMatches:minTeacherMatches,maxTeachers,excludedBotIds});
    const reconstructed=reconstructArenaTeachers(games,discovery,split);
    if(!reconstructed.teacherRows.some(r=>r.split==="train"))throw new Error("No supported uniquely reconstructable training teachers");
    const generation=randomUUID(),generatedAt=now.toISOString(),cutoff=games.reduce((a,g)=>g.match.id>a.id?g.match:a,games[0].match);
    const profile=fitArenaProfile(reconstructed.teacherRows,reconstructed.wordRows,{generation,generatedAt,dictionarySha256,cutoffMatchId:cutoff.id,cutoffEndedAt:iso(cutoff.endedAt),staleAfter:new Date(nowMs+staleAfter).toISOString(),teachers:discovery,...split});
    const metadata:ArenaMetadata={schema:"scrabblebot-arena-data-v1",generation,generatedAt,refreshStatus:"fresh",stale:false,source:ENDPOINT,lookbackHours,maxMatches,fetchedCompletedMatches:matches.length,acceptedMatches:games.length,cutoffMatchId:cutoff.id,cutoffEndedAt:iso(cutoff.endedAt),dictionarySha256,configurationHash,queries:client.queries,queryBytes:client.bytes,queryRows:client.rows,skippedMatches,...split,discoveryMatchIds:split.trainMatchIds,teacherReconstruction:{complete:reconstructed.complete,nonUnique:reconstructed.nonUnique,invalid:reconstructed.invalid}};
    const data:ArenaData={metadata,discovery,teacherRows:reconstructed.teacherRows,wordRows:reconstructed.wordRows,profile};
    atomicWriteJson(paths.data,data);atomicWriteJson(paths.profile,profile);atomicWriteJson(paths.discovery,{generation,generatedAt,cutoffMatchId:cutoff.id,discoveryMatchIds:split.trainMatchIds,players:discovery});atomicWriteJson(paths.latest,{generation,generatedAt,...paths});
    return {...data,paths};
  } catch(error) {
    if(cached)return {...cached,metadata:{...cached.metadata,refreshStatus:"stale",stale:true,refreshError:error instanceof Error?error.message:String(error)},paths};
    throw error;
  }
}
