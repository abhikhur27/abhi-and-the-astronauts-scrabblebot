import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DbConnection, type SubscriptionHandle } from './module_bindings/index.js';
import type { Identity } from 'spacetimedb';
import { WordEngine } from './engine.js';
import { MATH_POLICY_VERSION } from './math.js';
import { PublicBeliefTracker } from './belief.js';
import { atomicWriteJson } from './atomic-json.js';
import { LivePolicyManager } from './live-policy.js';
import type { ChampionPinReceipt } from './champion-pin.js';
import { clampBid, WordGate, ConnectionGate, gameFailureReason, FreshAuctionWindow, wordDecisionKey, mayReviseConfirmedBid, currentCommitment,lobbyWindowOpen,type OwnBidState } from './runtime.js';
import { EXECUTION_PROTOCOL_VERSION,type CoordinatedBot } from './coordinated-policy.js';
import { ENDGAME_POLICY_VERSION,type EndgameBot } from './endgame.js';
import { REINVEST_POLICY_VERSION,type ReinvestmentBot } from './reinvest.js';
import { LiveDataRecorder } from './telemetry.js';
import { MatchRotation, matchQueries, LiveMatchIndex, TournamentMatchIndex,TournamentRegistrationLatch,selectRegistrationTournament,POLICY_NAMES, type LiveMode, type Strategy } from './live-session.js';
import type { DecisionContext, BotPolicy } from './types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kind = (process.env.BOT_KIND ?? 'math') as LiveMode;
const name = process.env.BOT_NAME ?? `abhi-${kind}`;
if (!['math', 'learner', 'dilute', 'alternate', 'rotate'].includes(kind)) throw new Error('BOT_KIND must be math, learner, dilute, alternate or rotate');
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid BOT_NAME');
const tokenPath = process.env.BOT_TOKEN_FILE;
if (!tokenPath || !existsSync(tokenPath)) {
  console.error('A bot token file is required. Link your account at https://scrabblebot.spacetimedb.com/account, then provision the team credential. No anonymous client was started.');
  process.exit(2);
}
const token = readFileSync(tokenPath, 'utf8').trim();
if (!token) { console.error('Bot token file is empty'); process.exit(2); }
const dictionaryText = readFileSync(resolve(root, 'data/enable1.txt'), 'utf8');
const dictionary = dictionaryText.split(/\r?\n/).filter(Boolean);
const engine = new WordEngine(dictionary);
const usesLearner = ['learner', 'alternate', 'rotate'].includes(kind);
const championPinFile=process.env.CHAMPION_PIN_FILE;
if(championPinFile!==undefined&&!championPinFile.trim())throw new Error('CHAMPION_PIN_FILE is empty');
const onlineLearning = !championPinFile && usesLearner && process.env.BOT_LEARN === '1';
const autoRegisterTournament=process.env.AUTO_REGISTER_TOURNAMENT==='1';
const registrationSinceMs=Date.parse('2026-11-07T00:00:00-06:00');
const dictionaryHash=createHash('sha256').update(dictionaryText).digest('hex');
const policies=new LivePolicyManager({root,engine,dictionaryHash,onlineLearning,usesLearner,championPinFile,initialModelPath:resolve(root,process.env.MODEL_PATH??'models/competition-candidate.json')});
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ mode: 'offline-config-check', kind, dictionaryWords: dictionary.length, onlineLearning, autoRegisterTournament, championPin:policies.championPin,learningProfile:policies.counters.profile,checkpointSource:policies.initialSource,credentialsFilePresent: true, networkStarted: false }));
  process.exit(0);
}
const runDir = resolve(root, 'runs', `live-${name}`);
mkdirSync(runDir, { recursive: true });
const recorder = new LiveDataRecorder(resolve(runDir, 'data.jsonl'));
const rotationPath = resolve(runDir, 'rotation.json');
const rotation = new MatchRotation(kind, existsSync(rotationPath) ? JSON.parse(readFileSync(rotationPath, 'utf8')) : undefined);
function log(event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), bot: name, kind, policyRevision: MATH_POLICY_VERSION, adapterRevision: 'coordinated-live-v6.3',executionProtocol:EXECUTION_PROTOCOL_VERSION,event, ...fields });
  console.log(line); appendFileSync(resolve(runDir, 'events.jsonl'), line + '\n');
}
function saveRotation() { atomicWriteJson(rotationPath, rotation.snapshot()); }
if(policies.championPin)log('champion-pinned',{championPin:policies.championPin,onlineLearning:false});
const until = process.env.LIVE_UNTIL ? Date.parse(process.env.LIVE_UNTIL) : Infinity;
if (Number.isNaN(until)) throw new Error('Invalid LIVE_UNTIL');
const lobbyUntil=process.env.LOBBY_UNTIL?Date.parse(process.env.LOBBY_UNTIL):until-180_000;
if(Number.isNaN(lobbyUntil))throw new Error('Invalid LOBBY_UNTIL');
const tournamentPolicy=(process.env.TOURNAMENT_POLICY&&process.env.TOURNAMENT_POLICY!=='auto'?process.env.TOURNAMENT_POLICY:undefined) as Strategy|undefined;
if(tournamentPolicy&&!['math','learner','dilute'].includes(tournamentPolicy))throw new Error('Invalid TOURNAMENT_POLICY');
const stopFile = resolve(root, process.env.LIVE_STOP_FILE ?? 'runs/STOP_LIVE');
const stopping = () => Date.now() >= until || existsSync(stopFile);
let myIdentity: Identity | undefined;
let myBotId: bigint | undefined;
let pendingPump = false;
let baseReady = false;
let ownReady = false;
let ownSubscriptionStarted = false;
let joining = false;
const gate = new WordGate();
const session = new ConnectionGate();
const auctionWindow = new FreshAuctionWindow();
const bids = new Map<string, OwnBidState>();
const ended = new Set<string>();
const wordDecisions = new Map<string, string>();
type TableRow<T extends { iter: () => Iterable<unknown> }> = ReturnType<T['iter']> extends Iterable<infer R> ? R : never;
type MatchRow = TableRow<DbConnection['db']['matchState']>;
type ParticipantRow = TableRow<DbConnection['db']['matchParticipant']>;
type AuctionRow = TableRow<DbConnection['db']['auction']>;
type TournamentRow=TableRow<DbConnection['db']['tournament']>;
type TournamentEntryRow=TableRow<DbConnection['db']['tournamentEntry']>;
type MatchEntry = { strategy: Strategy; policy: BotPolicy;coordinator:CoordinatedBot;endgame?:EndgameBot;reinvestment?:ReinvestmentBot;tournamentId?:string;learnerSnapshot?:ReturnType<LivePolicyManager['createTournament']>['learnerSnapshot'];championPin?:ChampionPinReceipt;frozen:boolean;ready: boolean; handle?: SubscriptionHandle; tracker?: PublicBeliefTracker; selectedMode:'v2'|'approved'|'manual-frozen';generation:string };
let index: LiveMatchIndex<MatchRow, ParticipantRow> | undefined;
const tournamentMatches=new TournamentMatchIndex();
const registrationLatch=new TournamentRegistrationLatch();
const registrationTournaments=new Map<string,TournamentRow>();
const registrationEntries=new Map<string,TournamentEntryRow>();
let registrationWarningState:string|undefined;
const simulatedFlags=new Map<string,boolean>();
const auctionsById = new Map<string, AuctionRow>();
const matches = new Map<string, MatchEntry>();
const host = process.env.STDB_HOST ?? 'https://maincloud.spacetimedb.com';
const database = process.env.STDB_DB ?? 'scrabblebot';
const registrationServiceAllowed=host.replace(/\/$/,'')==='https://maincloud.spacetimedb.com'&&database==='scrabblebot';
log('auto-registration-configured',{enabled:autoRegisterTournament&&registrationServiceAllowed,requested:autoRegisterTournament,serviceAllowed:registrationServiceAllowed,createdSince:new Date(registrationSinceMs).toISOString(),maximumAttempts:3,cooldownMs:5000,retryAfterMs:30000});
function shutdown() { log('stopped'); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

function ensureMatch(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (matches.has(key)) return;
  const tournamentId=tournamentMatches.get(key);
  const chosen=policies.championPin?policies.createPinned(matchId):tournamentId?policies.createTournament(tournamentId,matchId,tournamentPolicy):(()=>{const strategy=rotation.choose(key);saveRotation();return {...policies.create(strategy,matchId),strategy,learnerSnapshot:undefined};})();
  const {strategy,policy}=chosen;
  const entry: MatchEntry = { strategy, policy,coordinator:chosen.coordinator,endgame:chosen.endgame,reinvestment:chosen.reinvestment,tournamentId,learnerSnapshot:chosen.learnerSnapshot,championPin:chosen.championPin,frozen:!!chosen.championPin||!!tournamentId,ready: false,selectedMode:chosen.mode,generation:chosen.generation };
  matches.set(key, entry);
  entry.handle = conn.subscriptionBuilder().onApplied(() => {
    entry.ready = true;
    const match = index?.get(matchId);
    const players = [...conn.db.matchParticipant.iter()].filter(p => p.matchId === matchId);
    if (match && myBotId !== undefined) entry.tracker = new PublicBeliefTracker({ myBotId: String(myBotId), playerIds: players.map(p => String(p.botId)), startingRackSize: match.startingRackSize, particles: 128, seed: Number(matchId % 0x7fffffffn) });
    if (match) recorder.matchConfig(key, strategy, { auctionType: match.auctionType.tag, startingRackSize: match.startingRackSize, auctionDurationMs: Number(match.auctionDurationMs), participants: [...conn.db.matchParticipant.iter()].filter(p => p.matchId === matchId).length,tournamentId,frozen:entry.frozen,policyRevision: chosen.reinvestment?REINVEST_POLICY_VERSION:chosen.endgame?ENDGAME_POLICY_VERSION:chosen.mode==='v2'?'v2-cash-pacing':MATH_POLICY_VERSION });
    log('match-ready', { matchId: key, strategy, policyName: POLICY_NAMES[strategy],tournamentId,frozen:entry.frozen,championPin:chosen.championPin,selectedMode:chosen.mode,endgameEnabled:!!chosen.endgame,reinvestmentEnabled:!!chosen.reinvestment,foundationRevision:chosen.reinvestment?REINVEST_POLICY_VERSION:chosen.endgame?ENDGAME_POLICY_VERSION:undefined,foundationOptions:chosen.reinvestment?.options,selectionGeneration:chosen.generation,selectionReason:chosen.reason,learner:chosen.learnerSnapshot??policies.counters }); enqueue(conn);
  }).onError(() => { log('match-subscription-error', { matchId: key }); process.exit(1); }).subscribe(matchQueries(matchId));
}
function context(conn: DbConnection, match: MatchRow, entry: MatchEntry, offered?: AuctionRow): DecisionContext | undefined {
  const participants = [...conn.db.matchParticipant.iter()].filter(p => p.matchId === match.id);
  const mine = participants.find(p => p.botId === myBotId);
  if (!mine) return;
  const rack = new Map<string, number>();
  for (const row of conn.db.myRack.iter()) if (row.matchId === match.id) rack.set(row.letter, row.count);
  const auction = offered ?? (match.currentAuctionId === undefined ? undefined : auctionsById.get(String(match.currentAuctionId)));
  const history = [...conn.db.auction.iter()].filter(row => row.matchId === match.id);
  const results = new Map([...conn.db.auctionResult.iter()].filter(row => row.matchId === match.id).map(row => [String(row.auctionId), row]));
  const information = entry.tracker?.observe({
    myRack: rack, bagCount: match.bagTotal, completeHistory: true,
    currentAuction: auction?.status.tag === 'Open' ? { id: String(auction.id), letter: auction.letter, opensAtMicros: auction.opensAt.microsSinceUnixEpoch } : undefined,
    auctions: history.map(row => { const result = results.get(String(row.id)); return {
      id: String(row.id), letter: row.letter, opensAtMicros: row.opensAt.microsSinceUnixEpoch, closesAtMicros: row.closesAt.microsSinceUnixEpoch,
      winnerBotId: result?.winnerBotId === undefined ? undefined : String(result.winnerBotId), paid: result ? Number(result.paid) : undefined, closedAtMicros: result?.closedAt.microsSinceUnixEpoch,
    }; }),
    words: [...conn.db.wordPlay.iter()].filter(row => row.matchId === match.id).map(row => ({ id: String(row.id), botId: String(row.botId), word: row.word, playedAtMicros: row.playedAt.microsSinceUnixEpoch })),
  });
  return { myRack: rack, myBalance: Number(mine.balance), myScore: Number(mine.score), tilesRemaining: match.bagTotal,
    myBotId: String(myBotId), auctionType: match.auctionType.tag, letter: auction?.letter ?? 'E', information,
    committedBid:currentCommitment(auction?bids.get(String(auction.id)):undefined,auction?.status.tag==='Open'),
    opponents: participants.filter(p => p.botId !== myBotId).map(p => ({ botId: String(p.botId), balance: Number(p.balance), score: Number(p.score),isSimulated:simulatedFlags.get(String(p.botId)) })),
  };
}
function bidOnAuction(conn: DbConnection, auction: AuctionRow, trigger: string) {
  if (!session.canAct(conn.isActive) || myBotId === undefined || auction.status.tag !== 'Open') return;
  const key = String(auction.matchId), bidKey = String(auction.id), entry = matches.get(key), match = index?.get(key);
  // An index callback may follow this auction callback in the same SDK transaction.
  // The queued dispatch runs after all callbacks; it never scans global history.
  if (!entry?.ready || !match || match.status.tag !== 'Running' || match.currentAuctionId !== auction.id) return;
  const started = performance.now();
  if (!auctionWindow.canSend(bidKey, started)) return;
  const previous=bids.get(bidKey);
  if(previous){
    const mine=index?.mine(key);if(!mine)return;
    const ownRack=new Map<string,number>();for(const row of conn.db.myRack.iter())if(row.matchId===match.id)ownRack.set(row.letter,row.count);
    const ownSignature=JSON.stringify([[...ownRack].sort(([a],[b])=>a.localeCompare(b)),Number(mine.balance),Number(mine.score)]);
    // ACKs and rival updates cannot revise our bid. Reject them before the
    // public-history and particle reconstruction used by a real decision.
    if(!mayReviseConfirmedBid(previous,ownSignature,started))return;
  }
  const ctx = context(conn, match, entry, auction);
  if (!ctx) return;
  const signature=JSON.stringify([[...ctx.myRack].sort(([a],[b])=>a.localeCompare(b)),ctx.myBalance,ctx.myScore]);
  if(!mayReviseConfirmedBid(previous,signature,started))return;
  const amount = clampBid(entry.policy.decideBid(ctx), ctx.myBalance);
  const computeMs = performance.now() - started;
  const ageMs = auctionWindow.age(bidKey, performance.now());
  if (!auctionWindow.canSend(bidKey, performance.now())) {
    if(!previous)bids.set(bidKey,{amount:0,attemptedAt:started,signature,attempts:1,status:'skipped'});
    log('bid-window-missed', { matchId: key, auctionId: bidKey, strategy: entry.strategy, policyName: POLICY_NAMES[entry.strategy], computeMs, ageMs }); return;
  }
  if(previous&&previous.status!=='rejected'&&amount===previous.amount){previous.signature=signature;return;}
  const record:OwnBidState={amount,attemptedAt:started,signature,attempts:(previous?.attempts??0)+1,status:amount>0||currentCommitment(previous,true)>0?'submitted':'skipped'};
  bids.set(bidKey,record);
  recorder.decision(key, bidKey, entry.strategy, ctx, { bid: amount });
  const submittedAt = Date.now();
  if(record.status==='submitted')conn.reducers.submitBid({ auctionId: auction.id, amount: BigInt(amount) })
    .then(() => {record.status='accepted';log(amount>0?'bid-accepted':'bid-cancelled', { matchId: key, auctionId: bidKey, strategy: entry.strategy, amount,revision:record.attempts,acknowledgmentMs: Date.now() - submittedAt });enqueue(conn);})
    .catch(error => {record.status='rejected';if(previous&&bids.get(bidKey)===record&&currentCommitment(previous,true)>0)bids.set(bidKey,{...previous,signature,attempts:record.attempts,attemptedAt:record.attemptedAt});log('bid-rejected', { matchId: key, auctionId: bidKey, strategy: entry.strategy,reason: gameFailureReason(error),revision:record.attempts,acknowledgmentMs: Date.now() - submittedAt });enqueue(conn);});
  log('bid-decision', { matchId: key, auctionId: bidKey, strategy: entry.strategy, policyName: POLICY_NAMES[entry.strategy], letter: auction.letter, amount,revision:record.attempts,trigger, computeMs, ageMs, beliefConsistent: ctx.information?.consistent, beliefESS: ctx.information?.effectiveSampleSize,terminalCashGuard:entry.coordinator.terminalCashGuardFor(ctx),endgame:entry.endgame?.explainEndgameDecision(ctx),reinvestment:entry.reinvestment?.explainReinvestmentDecision(ctx) });
}
/** Runs after gameplay dispatch, never awaits or blocks a bid/word action. */
function maybeRegisterTournament(conn:DbConnection) {
  if(!autoRegisterTournament||!registrationServiceAllowed||stopping()||!baseReady||!ownReady||myBotId===undefined||!session.canAct(conn.isActive))return;
  for(const entry of registrationEntries.values()) {
    const tournament=registrationTournaments.get(String(entry.tournamentId));
    if(entry.botId!==myBotId||!tournament||tournament.createdAt.microsSinceUnixEpoch<BigInt(registrationSinceMs)*1000n)continue;
    if(registrationLatch.confirm(entry.tournamentId))log('tournament-entry-confirmed',{botId:String(myBotId),tournamentId:String(entry.tournamentId),entryId:String(entry.id),status:tournament.status.tag,createdAtMicros:String(tournament.createdAt.microsSinceUnixEpoch)});
  }
  const choice=selectRegistrationTournament(registrationTournaments.values(),registrationEntries.values(),myBotId,registrationSinceMs,Date.now());
  if(choice.kind==='ambiguous') {
    if(registrationWarningState!==choice.stateKey)log('tournament-registration-needs-operator',{reason:'multiple-current-registration-tournaments',tournamentIds:choice.tournamentIds});
    registrationWarningState=choice.stateKey;return;
  }
  if(choice.kind!=='candidate'){registrationWarningState=undefined;return;}
  if(registrationLatch.exhausted(choice.tournamentId)) {
    const warning=`attempt-limit:${choice.tournamentId}`;
    if(registrationWarningState!==warning)log('tournament-registration-needs-operator',{reason:'registration-attempt-limit',tournamentId:String(choice.tournamentId)});
    registrationWarningState=warning;return;
  }
  registrationWarningState=undefined;
  const attempt=registrationLatch.begin(choice.tournamentId,Date.now(),choice.stateKey);
  if(attempt===undefined)return;
  const botId=String(myBotId),tournamentId=String(choice.tournamentId);
  log('tournament-registration-requested',{botId,tournamentId,attempt});
  Promise.resolve().then(()=>conn.reducers.registerForTournament({tournamentId:choice.tournamentId}))
    .then(()=>log('tournament-registration-accepted',{botId,tournamentId,attempt,entryConfirmedByAck:false}))
    .catch(error=>log('tournament-registration-rejected',{botId,tournamentId,attempt,reason:gameFailureReason(error)}))
    .finally(()=>{registrationLatch.settle(choice.tournamentId,attempt);enqueue(conn);});
}
function pump(conn: DbConnection) {
  if (!session.canAct(conn.isActive) || !myIdentity || myBotId === undefined || !index) return;
  for (const match of index.running()) ensureMatch(conn, match.id);
  // Only subscribed active matches belong in the action loop. Historical global
  // match states are indexed once and never searched through SDK id.find here.
  for (const [key, entry] of matches) {
    const match = index.get(key), mine = index.mine(key);
    if (!match || !mine || !entry.ready) continue;
    const { strategy, policy } = entry;
    if (match.status.tag === 'Ended') {
      if (ended.has(key)) continue;
      ended.add(key); gate.clear(key); wordDecisions.delete(key);
      policies.finish(policy,Number(mine.score));
      recorder.matchEnd(key, strategy, Number(mine.score), [...conn.db.matchParticipant.iter()].filter(p => p.matchId === match.id).map(p => ({ botId: String(p.botId), score: Number(p.score), balance: Number(p.balance) })));
      log('match-ended', { matchId: key, strategy, policyName: POLICY_NAMES[strategy],tournamentId:entry.tournamentId,frozen:entry.frozen,championPin:entry.championPin,selectedMode:entry.selectedMode,selectionGeneration:entry.generation,score: Number(mine.score), balance: Number(mine.balance), modelUpdates:entry.learnerSnapshot?.updates??policies.counters.updates,learner:entry.learnerSnapshot??policies.counters });
      entry.handle?.unsubscribe(); matches.delete(key); join(conn); continue;
    }
    if (match.status.tag !== 'Running') continue;
    const auction = match.currentAuctionId === undefined ? undefined : auctionsById.get(String(match.currentAuctionId));
    if (auction) bidOnAuction(conn, auction, 'queued');
    const ctx = context(conn, match, entry, auction);
    if (!ctx) continue;
    const signature = [...ctx.myRack].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c}${n}`).join('');
    const state = wordDecisionKey(ctx);
    if (wordDecisions.get(key) === state) continue;
    const word = policy.chooseWord(ctx);
    if (word && gate.begin(key, signature, Date.now())) {
      recorder.decision(key, auction ? String(auction.id) : null, strategy, ctx, { word });
      conn.reducers.submitWord({ matchId: match.id, word }).then(() => log('word-accepted', { matchId: key, strategy, policyName: POLICY_NAMES[strategy], word }))
        .catch(error => log('word-rejected', { matchId: key, strategy, word, reason: gameFailureReason(error) })).finally(() => { gate.finish(key, Date.now()); enqueue(conn); });
    } else if (!word) { wordDecisions.set(key, state); recorder.decision(key, auction ? String(auction.id) : null, strategy, ctx, { word: null });const coordination=entry.coordinator.coordinationFor(ctx);if(coordination?.defer)log('word-deferred-for-purchase',{matchId:key,auctionId:auction?String(auction.id):null,strategy,...coordination}); }
  }
  maybeRegisterTournament(conn);
  if (bids.size > 500) for (const [id] of [...bids].slice(0, 250)) { bids.delete(id); auctionsById.delete(id); }
}
function enqueue(conn: DbConnection) { if (!pendingPump) { pendingPump = true; setImmediate(() => { pendingPump = false; pump(conn); }); } }
function join(conn: DbConnection) {
  if (!session.canAct(conn.isActive) || joining || myBotId === undefined || stopping() || !lobbyWindowOpen(Date.now(),lobbyUntil)) return;
  if (index?.running().length) return;
  const lobbies = new Set([...conn.db.openLobbies.iter()].map(l => l.id));
  if ([...conn.db.openLobbyMembers.iter()].some(m => m.botId === myBotId && lobbies.has(m.lobbyId))) return;
  joining = true;
  conn.reducers.joinLobby({}).then(() => log('lobby-joined')).catch(() => log('lobby-join-rejected')).finally(() => { joining = false; });
}
function markReady(conn: DbConnection) { if (baseReady && ownReady) { session.applied(); log('ready', { botId: String(myBotId), host, database,championPin:policies.championPin }); join(conn); enqueue(conn); } }
DbConnection.builder().withUri(host).withDatabaseName(database).withToken(token)
  .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 10_000 })
  .onConnect((conn, identity) => {
    myIdentity = identity;
    conn.subscriptionBuilder().onApplied(() => {
      myBotId = conn.db.botCredential.identity.find(identity)?.botId;
      if (myBotId === undefined) { log('invalid-bot-credential'); process.exit(2); }
      index ??= new LiveMatchIndex<MatchRow, ParticipantRow>(myBotId);
      index.replaceStates(conn.db.matchState.iter());
      tournamentMatches.replace(conn.db.tournamentMatch.iter());
      registrationTournaments.clear();for(const row of conn.db.tournament.iter())registrationTournaments.set(String(row.id),row);
      registrationEntries.clear();for(const row of conn.db.tournamentEntry.iter())registrationEntries.set(String(row.id),row);
      simulatedFlags.clear();for(const row of conn.db.bot.iter())simulatedFlags.set(String(row.id),row.isSimulated);
      baseReady = true;
      if (!ownSubscriptionStarted) {
        ownSubscriptionStarted = true;
        conn.subscriptionBuilder().onApplied(() => { index?.replaceParticipants(conn.db.matchParticipant.iter()); ownReady = true; markReady(conn); })
          .onError(() => { log('own-subscription-error'); process.exit(1); })
          .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`, 'SELECT * FROM my_rack']);
      }
      markReady(conn);
    }).onError(() => { log('global-subscription-error'); process.exit(1); })
      .subscribe(['SELECT * FROM bot_credential', 'SELECT * FROM open_lobbies', 'SELECT * FROM open_lobby_members', 'SELECT * FROM match_state','SELECT * FROM tournament_match','SELECT * FROM tournament','SELECT * FROM tournament_entry','SELECT * FROM bot']);
    // The SDK applies the transaction cache before callbacks. Act on a fresh
    // auction immediately, before queued word searches or the polling timer.
    conn.db.auction.onInsert((ctx, row) => {
      // Only a new transaction starts a local bidding window. Initial/replayed
      // snapshots can contain an auction already near its server deadline.
      auctionsById.set(String(row.id), row);
      if (row.status.tag === 'Open' && (ctx.event.tag === 'Transaction' || ctx.event.tag === 'Reducer')) {
        auctionWindow.observe(String(row.id), performance.now(), Number((row.closesAt.microsSinceUnixEpoch - row.opensAt.microsSinceUnixEpoch) / 1000n));
        bidOnAuction(conn, row, 'auction-insert');
      }
      enqueue(conn);
    });
    conn.db.auction.onUpdate((_ctx, _old, row) => { auctionsById.set(String(row.id), row); enqueue(conn); });
    conn.db.auction.onDelete((_ctx, row) => auctionsById.delete(String(row.id)));
    conn.db.myRack.onInsert(() => enqueue(conn)); conn.db.myRack.onUpdate(() => enqueue(conn)); conn.db.myRack.onDelete(() => enqueue(conn));
    conn.db.matchParticipant.onInsert((_ctx, row) => { index?.participant(row); enqueue(conn); }); conn.db.matchParticipant.onUpdate((_ctx, _old, row) => { index?.participant(row); enqueue(conn); });
    conn.db.matchParticipant.onDelete((_ctx, row) => { index?.deleteParticipant(row); enqueue(conn); });
    conn.db.matchState.onInsert((_ctx, row) => { index?.state(row); enqueue(conn); }); conn.db.matchState.onUpdate((_ctx, _old, row) => { index?.state(row); enqueue(conn); });
    conn.db.matchState.onDelete((_ctx, row) => { index?.deleteState(row.id); enqueue(conn); });
    conn.db.tournamentMatch.onInsert((_ctx,row)=>{tournamentMatches.set(row);enqueue(conn);});
    conn.db.tournamentMatch.onUpdate((_ctx,_old,row)=>{tournamentMatches.set(row);enqueue(conn);});
    conn.db.tournamentMatch.onDelete((_ctx,row)=>tournamentMatches.delete(row.matchId));
    conn.db.tournament.onInsert((_ctx,row)=>{registrationTournaments.set(String(row.id),row);enqueue(conn);});
    conn.db.tournament.onUpdate((_ctx,_old,row)=>{registrationTournaments.set(String(row.id),row);enqueue(conn);});
    conn.db.tournament.onDelete((_ctx,row)=>{registrationTournaments.delete(String(row.id));enqueue(conn);});
    conn.db.tournamentEntry.onInsert((_ctx,row)=>{registrationEntries.set(String(row.id),row);enqueue(conn);});
    conn.db.tournamentEntry.onUpdate((_ctx,_old,row)=>{registrationEntries.set(String(row.id),row);enqueue(conn);});
    conn.db.tournamentEntry.onDelete((_ctx,row)=>{registrationEntries.delete(String(row.id));enqueue(conn);});
    conn.db.bot.onInsert((_ctx,row)=>{simulatedFlags.set(String(row.id),row.isSimulated);enqueue(conn);});
    conn.db.bot.onUpdate((_ctx,_old,row)=>{simulatedFlags.set(String(row.id),row.isSimulated);enqueue(conn);});
    conn.db.bot.onDelete((_ctx,row)=>simulatedFlags.delete(String(row.id)));
    conn.db.auctionResult.onInsert((_ctx, row) => { if (matches.has(String(row.matchId))) recorder.auctionResult(row); });
    conn.db.wordPlay.onInsert((_ctx, row) => { if (matches.has(String(row.matchId))) recorder.wordPlay(row); });
    setInterval(() => { if (stopping()) shutdown(); enqueue(conn); join(conn); }, 200);
  })
  .onAutomaticReconnect((_conn, identity) => { myIdentity = identity; log('socket-reconnected-awaiting-cache'); })
  .onConnectError((_ctx, _error, nextAttempt, delayMs) => { session.disconnected(); registrationLatch.disconnected(); baseReady = ownReady = false; log('connection-error', { nextAttempt, delayMs }); if (nextAttempt === undefined) process.exit(1); })
  .onDisconnect((_ctx, _error, nextAttempt, delayMs) => {
    session.disconnected(); registrationLatch.disconnected(); baseReady = ownReady = false; gate.reset(); joining = false;
    // Known accepted own bids survive subscription replay. Only the current
    // still-open auction can expose one through currentCommitment().
    for (const entry of matches.values()) entry.ready = false;
    log('disconnected', { nextAttempt, delayMs }); if (nextAttempt === undefined) process.exit(1);
  }).build();
