import { performance } from 'node:perf_hooks';
import { canSpell, type WordEngine } from './engine.js';
import { simulateMatch } from './simulator.js';
import type { AuctionType, BotPolicy, DecisionContext } from './types.js';
import {runCpuJobs} from './cpu-pool.js';
import {isFrozenPolicySpec,type PolicySpec} from './policy-spec.js';

export interface LeagueFactoryContext { seed: number; seat: number; auctionType: AuctionType; }
export type LeaguePrimaryObjective = 'score' | 'win-share';
export interface LeagueEntry {
  name: string;
  /** Return a new evaluation-only policy, with learning/exploration disabled. */
  create: (context: LeagueFactoryContext) => BotPolicy;
  snapshot?: () => unknown;
  /** Explicit data recipe required for multi-core evaluation. */
  spec?:PolicySpec;
}
export interface LeagueOptions {
  engine: WordEngine;
  entries: readonly LeagueEntry[];
  /** First lower-31-bit offset reserved for this evaluation; no wrapping. */
  seedBlock: number;
  seedCount?: number;
  baselineName: string;
  championName: string;
  candidateNames: readonly string[];
  auctionTypes?: readonly AuctionType[];
  startingRackSize?: number;
  beliefParticles?: number;
  decisionBudgetMs?: number;
  winShareNoninferiorityMargin?: number;
  /** Win-share permits defensive improvements without demanding more own score. */
  primaryObjective?: LeaguePrimaryObjective;
  maxDurationMs?: number;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  snapshots?: Readonly<Record<string, () => unknown>>;
  arenaProfile?: unknown;
  workers?:number;
  dictionaryWords?:readonly string[];
}
export interface ActionMetrics {
  bidDecisions: number; wordDecisions: number; invalidBids: number; invalidWords: number;
  exceptions: number; lateBids: number; lateWords: number;
  maxBidMs: number; p95BidMs: number; maxWordMs: number; p95WordMs: number;
}
export interface ActionAccumulator {
  bidMs: number[]; wordMs: number[]; invalidBids: number; invalidWords: number;
  exceptions: number; lateBids: number; lateWords: number;
}
export interface LeaguePlayerResult {
  name: string; seat: number; score: number; spent: number; tilesWon: number;
  words: number; rank: number; winShare: number; actions: ActionMetrics;
}
export interface LeagueGame {
  blockIndex: number; seed: number; auctionType: AuctionType; rotation: number;
  auctions: number; players: LeaguePlayerResult[];
}
export interface PairedBlock {
  candidateScore: number; referenceScore: number; candidateWinShare: number; referenceWinShare: number;
}
export interface PairedComparison {
  blocks: number; meanScoreDifference: number; scoreDifference95NormalCI: [number, number] | null;
  scoreDifferenceLower95OneSided: number | null;
  meanWinShareDifference: number; winShareDifferenceLower95OneSided: number | null;
  superior: boolean; winShareSuperior: boolean; winShareNoninferior: boolean;
}
export interface LeagueRanking {
  name: string; games: number; meanScore: number; meanSpent: number; meanTilesWon: number;
  meanWords: number; meanRank: number; winShare: number; outrightWins: number; actions: ActionMetrics;
}
export interface LeagueModeReport {
  auctionType: AuctionType; games: number; completedSeedBlocks: number;
  ranking: LeagueRanking[];
  comparisons: { candidate: string; reference: string; result: PairedComparison }[];
}
export interface LeaguePromotionGate {
  candidate: string; primaryObjective: LeaguePrimaryObjective; eligible: boolean; reasons: string[]; promotionApplied: false;
}
export interface LeagueReport {
  schema: 'scrabblebot-league-v1'; completed: boolean; stopReason: string | null;
  seedBlock: number; seedCount: number; nextSeedBlock: number; seedDomain: 'upper-31-bit-held-out';
  seats: 6; rotationsPerSeed: 6; expectedGames: number; completedGames: number;
  auctionTypes: AuctionType[]; baselineName: string; championName: string;
  decisionBudgetMs: number; winShareNoninferiorityMargin: number; primaryObjective: LeaguePrimaryObjective; elapsedMs: number;
  frozen: { verified: boolean; unchanged: boolean; changed: string[]; snapshotErrors: string[] };
  modes: LeagueModeReport[]; gates: LeaguePromotionGate[]; games: LeagueGame[];
  promotionApplied: false; arenaProfile?: unknown; limitations: string[];
  execution:{mode:'serial'|'worker-threads';requestedWorkers:number;effectiveWorkers:number;workerThreadIds:number[];workersTerminated:true;wallTimeMs:number;gamesPerSecond:number};
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function quantile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)]!;
}
function uncertainty(values: readonly number[]) {
  const average = mean(values);
  if (values.length < 2) return { average, ci: null, lower: null };
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  const se = Math.sqrt(variance / values.length);
  return { average, ci: [average - 1.96 * se, average + 1.96 * se] as [number, number], lower: average - 1.6448536269514722 * se };
}
/** The independent observations are complete six-seat seed means, never seats. */
export function comparePairedBlocks(blocks: readonly PairedBlock[], winShareMargin = 0.05): PairedComparison {
  if (!Number.isFinite(winShareMargin) || winShareMargin < 0 || winShareMargin > 1 || blocks.some(block =>
    ![block.candidateScore, block.referenceScore, block.candidateWinShare, block.referenceWinShare].every(Number.isFinite))) {
    throw new Error('Invalid paired block values or noninferiority margin');
  }
  const score = uncertainty(blocks.map(block => block.candidateScore - block.referenceScore));
  const wins = uncertainty(blocks.map(block => block.candidateWinShare - block.referenceWinShare));
  return { blocks: blocks.length, meanScoreDifference: score.average, scoreDifference95NormalCI: score.ci,
    scoreDifferenceLower95OneSided: score.lower, meanWinShareDifference: wins.average,
    winShareDifferenceLower95OneSided: wins.lower,
    superior: blocks.length >= 6 && score.average > 0 && score.lower !== null && score.lower > 0,
    winShareSuperior: blocks.length >= 6 && wins.average > 0 && wins.lower !== null && wins.lower > 0,
    winShareNoninferior: blocks.length >= 6 && wins.lower !== null && wins.lower >= -winShareMargin };
}
/** Shared gate criterion; score remains descriptive when wins are primary. */
export function meetsPrimaryObjective(comparison: PairedComparison, objective: LeaguePrimaryObjective = 'score'): boolean {
  return objective === 'win-share' ? comparison.winShareSuperior : comparison.superior && comparison.winShareNoninferior;
}
function accumulator(): ActionAccumulator { return { bidMs: [], wordMs: [], invalidBids: 0, invalidWords: 0, exceptions: 0, lateBids: 0, lateWords: 0 }; }
function metrics(value: ActionAccumulator): ActionMetrics {
  return { bidDecisions: value.bidMs.length, wordDecisions: value.wordMs.length,
    invalidBids: value.invalidBids, invalidWords: value.invalidWords, exceptions: value.exceptions,
    lateBids: value.lateBids, lateWords: value.lateWords,
    maxBidMs: value.bidMs.reduce((maximum, time) => Math.max(maximum, time), 0), p95BidMs: quantile(value.bidMs, 0.95),
    maxWordMs: value.wordMs.reduce((maximum, time) => Math.max(maximum, time), 0), p95WordMs: quantile(value.wordMs, 0.95) };
}
function merge(target: ActionAccumulator, source: ActionAccumulator): void {
  target.bidMs.push(...source.bidMs); target.wordMs.push(...source.wordMs);
  for (const key of ['invalidBids', 'invalidWords', 'exceptions', 'lateBids', 'lateWords'] as const) target[key] += source[key];
}
function checkedPolicy(policy: BotPolicy, engine: WordEngine, observations: ActionAccumulator, budget: number): BotPolicy {
  const lifecycle = policy as BotPolicy & { beginEpisode?: () => void; finishEpisode?: (score: number) => void };
  return Object.assign({
    decideBid(ctx: DecisionContext): number {
      const start = performance.now(); let value: number;
      try { value = policy.decideBid(ctx); }
      catch { observations.exceptions++; value = NaN; }
      const duration = performance.now() - start; observations.bidMs.push(duration);
      if (duration > budget) observations.lateBids++;
      if (!Number.isSafeInteger(value) || value < 0 || value > ctx.myBalance) { observations.invalidBids++; return 0; }
      return value;
    },
    chooseWord(ctx: DecisionContext): string | null {
      const start = performance.now(); let value: string | null;
      try { value = policy.chooseWord(ctx); }
      catch { observations.exceptions++; observations.invalidWords++; value = null; }
      const duration = performance.now() - start; observations.wordMs.push(duration);
      if (duration > budget) observations.lateWords++;
      if (value === null) return null;
      const upper = typeof value === 'string' ? value.toUpperCase() : '';
      if (!/^[A-Z]{2,}$/.test(upper) || !canSpell(upper, ctx.myRack) || !engine.playable(ctx.myRack).some(word => word.word === upper)) {
        observations.invalidWords++; return null;
      }
      return upper;
    },
  }, {
    beginEpisode: () => { try { lifecycle.beginEpisode?.(); } catch { observations.exceptions++; } },
    finishEpisode: (score: number) => { try { lifecycle.finishEpisode?.(score); } catch { observations.exceptions++; } },
  });
}

export interface LeagueGameJob {blockIndex:number;seed:number;auctionType:AuctionType;rotation:number;startingRackSize:number;beliefParticles:number;budget:number;}
export interface LeagueGameResult {game:LeagueGame;observations:{name:string;value:ActionAccumulator}[];}
/** One deterministic simulation; all raw timings are returned for exact aggregation. */
export function runLeagueGame(engine:WordEngine,entries:readonly LeagueEntry[],job:LeagueGameJob):LeagueGameResult {
  const {blockIndex,seed,auctionType,rotation,startingRackSize,beliefParticles,budget}=job;
  const seated=Array.from({length:6},(_,seat)=>entries[(seat+rotation)%6]!);
  const observations=seated.map(()=>accumulator());
  const policies=seated.map((entry,seat)=>checkedPolicy(entry.create({seed,seat,auctionType}),engine,observations[seat]!,budget));
  const result=simulateMatch({engine,policies,seed,auctionType,startingRackSize,beliefParticles});
  const highest=Math.max(...result.players.map(player=>player.score));
  const tiedHighest=result.players.filter(player=>player.score===highest).length;
  const players=result.players.map((player,seat):LeaguePlayerResult=>{
    const tied=result.players.filter(other=>other.score===player.score).length;
    return {name:seated[seat]!.name,seat,score:player.score,spent:player.spent,
      tilesWon:[...player.rack.values()].reduce((sum,count)=>sum+count,0)+player.words.reduce((sum,word)=>sum+word.length,0)-startingRackSize,
      words:player.words.length,rank:1+result.players.filter(other=>other.score>player.score).length+(tied-1)/2,
      winShare:player.score===highest?1/tiedHighest:0,actions:metrics(observations[seat]!)};
  });
  return {game:{blockIndex,seed,auctionType,rotation,auctions:result.auctions,players},observations:seated.map((entry,seat)=>({name:entry.name,value:observations[seat]!}))};
}

/** Frozen comparison only: this function never promotes or writes any artifact. */
export async function evaluateLeague(options: LeagueOptions): Promise<LeagueReport> {
  const { engine, entries } = options;
  const seedCount = options.seedCount ?? 6, startingRackSize = options.startingRackSize ?? 5;
  const budget = options.decisionBudgetMs ?? 200, margin = options.winShareNoninferiorityMargin ?? 0.05;
  const primaryObjective = options.primaryObjective ?? 'score';
  const auctionTypes = [...(options.auctionTypes ?? ['Vickrey', 'FirstPrice'])];
  const names = entries.map(entry => entry.name), references = [...new Set([options.baselineName, options.championName])];
  if (entries.length !== 6 || new Set(names).size !== 6 || names.some(name => !name.trim()) ||
    [...references, ...options.candidateNames].some(name => !names.includes(name))) throw new Error('League requires six unique entries and named candidates/references in its lineup');
  if (!Number.isSafeInteger(options.seedBlock) || options.seedBlock < 0 || !Number.isSafeInteger(seedCount) || seedCount < 1 || options.seedBlock + seedCount > 0x80000000) throw new Error('Invalid held-out seed block');
  if (!auctionTypes.length || new Set(auctionTypes).size !== auctionTypes.length || auctionTypes.some(mode => !['Vickrey', 'FirstPrice'].includes(mode))) throw new Error('Invalid auction modes');
  if (!['score', 'win-share'].includes(primaryObjective)) throw new Error('Invalid primary objective');
  if (!Number.isInteger(startingRackSize) || startingRackSize < 0 || startingRackSize * 6 >= 98 || !Number.isFinite(budget) || budget <= 0 ||
    !Number.isFinite(margin) || margin < 0 || margin > 1 || (options.maxDurationMs !== undefined && (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs < 0))) throw new Error('Invalid league configuration');
  const started = performance.now(), games: LeagueGame[] = [], totals = new Map<string, ActionAccumulator>();
  const snapshots: [string, () => unknown][] = [...Object.entries(options.snapshots ?? {}), ...entries.flatMap(entry => entry.snapshot ? [[`entry:${entry.name}`, entry.snapshot] as [string, () => unknown]] : []),...entries.flatMap(entry=>entry.spec?[[`spec:${entry.name}`,()=>entry.spec] as [string,()=>unknown]]:[])];
  const initial = new Map<string, string | undefined>(), changed = new Set<string>(), snapshotErrors = new Set<string>();
  for (const [name, snapshot] of snapshots) { try { initial.set(name, JSON.stringify(snapshot())); } catch { snapshotErrors.add(name); } }
  function checkFrozen(): boolean {
    for (const [name, snapshot] of snapshots) { try { if (JSON.stringify(snapshot()) !== initial.get(name)) changed.add(name); } catch { snapshotErrors.add(name); } }
    return changed.size === 0 && snapshotErrors.size === 0;
  }
  let stopReason: string | null = snapshotErrors.size ? 'snapshot-error' : null;
  const requestedWorkers=options.workers??1;
  if(!Number.isSafeInteger(requestedWorkers)||requestedWorkers<1||requestedWorkers>4)throw new Error('League requires one to four CPU workers');
  if(requestedWorkers>1&&(!options.dictionaryWords||entries.some(entry=>!entry.spec)))throw new Error('Parallel league requires explicit policy specs and dictionary words');
  if(requestedWorkers>1&&entries.some(entry=>!isFrozenPolicySpec(entry.spec!)))throw new Error('Parallel league requires frozen policy specifications');
  const jobs:LeagueGameJob[]=[];
  for(const auctionType of auctionTypes)for(let blockIndex=0;blockIndex<seedCount;blockIndex++)for(let rotation=0;rotation<6;rotation++)jobs.push({blockIndex,seed:(0x80000000|(options.seedBlock+blockIndex))>>>0,auctionType,rotation,startingRackSize,beliefParticles:options.beliefParticles??32,budget});
  const accept=(result:LeagueGameResult)=>{
    games.push(result.game);
    for(const observation of result.observations){const key=`${result.game.auctionType}:${observation.name}`,total=totals.get(key)??accumulator();merge(total,observation.value);totals.set(key,total);}
  };
  let effectiveWorkers=requestedWorkers>1?0:1,workerThreadIds:number[]=[];
  if(requestedWorkers>1&&!stopReason){
    const pool=await runCpuJobs<LeagueGameJob,LeagueGameResult>({moduleURL:new URL('./league-worker.ts',import.meta.url),
      initData:{dictionaryWords:options.dictionaryWords,entries:entries.map(entry=>({name:entry.name,spec:entry.spec!}))},jobs,workers:requestedWorkers,
      maxDurationMs:options.maxDurationMs===undefined?undefined:Math.max(0,options.maxDurationMs-(performance.now()-started)),signal:options.signal,
      shouldStop:()=>{if(!checkFrozen()){stopReason='frozen-mutation';return true;}return options.shouldStop?.()??false;}});
    effectiveWorkers=pool.effectiveWorkers;workerThreadIds=pool.workerThreadIds;
    for(const result of pool.results)accept(result.result);
    stopReason=stopReason??pool.stopReason;
  }else if(!stopReason){
    for(const job of jobs){
      if(options.signal?.aborted||options.shouldStop?.()){stopReason='aborted';break;}
      if(performance.now()-started>=(options.maxDurationMs??Infinity)){stopReason='duration-limit';break;}
      try {accept(runLeagueGame(engine,entries,job));}catch{stopReason='simulation-error';}
      if(!checkFrozen())stopReason='frozen-mutation';
      if(stopReason)break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
  }
  checkFrozen();
  const expectedGames = seedCount * 6 * auctionTypes.length, completed = games.length === expectedGames && stopReason === null;
  const modes: LeagueModeReport[] = auctionTypes.map(auctionType => {
    const modeGames = games.filter(game => game.auctionType === auctionType);
    const blocks = Array.from({ length: seedCount }, (_, blockIndex) => modeGames.filter(game => game.blockIndex === blockIndex))
      .filter(block => block.length === 6 && new Set(block.map(game => game.rotation)).size === 6);
    const ranking: LeagueRanking[] = names.map(name => {
      const players = modeGames.map(game => game.players.find(player => player.name === name)!);
      return { name, games: players.length, meanScore: mean(players.map(player => player.score)), meanSpent: mean(players.map(player => player.spent)),
        meanTilesWon: mean(players.map(player => player.tilesWon)), meanWords: mean(players.map(player => player.words)), meanRank: mean(players.map(player => player.rank)),
        winShare: mean(players.map(player => player.winShare)), outrightWins: players.filter(player => player.winShare === 1).length,
        actions: metrics(totals.get(`${auctionType}:${name}`) ?? accumulator()) };
    }).sort((a, b) => b.winShare - a.winShare || a.meanRank - b.meanRank || b.meanScore - a.meanScore || a.name.localeCompare(b.name));
    const comparisons = options.candidateNames.flatMap(candidate => references.filter(reference => reference !== candidate).map(reference => ({ candidate, reference,
      result: comparePairedBlocks(blocks.map(block => {
        const candidatePlayers = block.map(game => game.players.find(player => player.name === candidate)!);
        const referencePlayers = block.map(game => game.players.find(player => player.name === reference)!);
        return { candidateScore: mean(candidatePlayers.map(player => player.score)), referenceScore: mean(referencePlayers.map(player => player.score)),
          candidateWinShare: mean(candidatePlayers.map(player => player.winShare)), referenceWinShare: mean(referencePlayers.map(player => player.winShare)) };
      }), margin) })));
    return { auctionType, games: modeGames.length, completedSeedBlocks: blocks.length, ranking, comparisons };
  });
  const frozen = { verified: snapshots.length > 0, unchanged: changed.size === 0 && snapshotErrors.size === 0, changed: [...changed], snapshotErrors: [...snapshotErrors] };
  const gates = options.candidateNames.map((candidate): LeaguePromotionGate => {
    const reasons: string[] = [];
    if (!completed) reasons.push('evaluation incomplete');
    if (!frozen.verified) reasons.push('frozen snapshot unverified');
    if (!frozen.unchanged) reasons.push('frozen snapshot changed');
    if (candidate === options.championName) reasons.push('already current champion');
    for (const mode of modes) {
      if (mode.completedSeedBlocks < 6) reasons.push(`${mode.auctionType}: fewer than six complete seed blocks`);
      if (mode.ranking.some(row => row.actions.invalidBids || row.actions.invalidWords || row.actions.exceptions)) reasons.push(`${mode.auctionType}: invalid action or exception in lineup`);
      if (mode.ranking.some(row => row.actions.lateBids || row.actions.lateWords)) reasons.push(`${mode.auctionType}: decision budget exceeded in lineup`);
      for (const comparison of mode.comparisons.filter(row => row.candidate === candidate)) {
        if (meetsPrimaryObjective(comparison.result, primaryObjective)) continue;
        if (primaryObjective === 'win-share') {
          reasons.push(`${mode.auctionType}: primary win-share superiority unproved versus ${comparison.reference}`);
        } else {
          if (!comparison.result.superior) reasons.push(`${mode.auctionType}: primary score superiority unproved versus ${comparison.reference}`);
          if (!comparison.result.winShareNoninferior) reasons.push(`${mode.auctionType}: win-share noninferiority unproved versus ${comparison.reference}`);
        }
      }
    }
    return { candidate, primaryObjective, eligible: reasons.length === 0, reasons, promotionApplied: false };
  });
  return { schema: 'scrabblebot-league-v1', completed, stopReason, seedBlock: options.seedBlock, seedCount,
    nextSeedBlock: options.seedBlock + seedCount, seedDomain: 'upper-31-bit-held-out', seats: 6, rotationsPerSeed: 6,
    expectedGames, completedGames: games.length, auctionTypes, baselineName: options.baselineName, championName: options.championName,
    decisionBudgetMs: budget, winShareNoninferiorityMargin: margin, primaryObjective, elapsedMs: performance.now() - started, frozen, modes, gates, games,
    promotionApplied: false, arenaProfile: options.arenaProfile,
    execution:{mode:requestedWorkers>1?'worker-threads':'serial',requestedWorkers,effectiveWorkers,workerThreadIds,workersTerminated:true,wallTimeMs:performance.now()-started,gamesPerSecond:games.length/Math.max(.001,(performance.now()-started)/1000)},
    limitations: [
      'Six cyclic seat rotations balance seats, not all 720 opponent orderings. Rotations are dependent; confidence calculations use seed-block means.',
      'Normal intervals with six blocks are approximate and fragile. The gate is a conservative operational screen, not strong statistical proof; repeated adaptive cycles and multiple candidates are not multiplicity-corrected.',
      'Simulator has zero transport delay. Measured local policy execution excludes belief/context construction, wrapper validation and network/server time; live deadline receipts remain necessary.',
      'Action checks reject malformed proposals explicitly. All lineup policies must meet validity and local latency budgets for any promotion recommendation.',
      'Factories must freeze learning/exploration. Supplied snapshots only detect mutations of the state their caller exposes; evaluation never writes or promotes.',
      'Reserve each reported seed range once. Training must remain in the lower 31-bit domain; do not train or tune on these held-out results.',
    ] };
}
