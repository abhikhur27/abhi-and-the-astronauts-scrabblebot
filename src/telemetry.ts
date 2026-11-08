import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DecisionContext, AuctionType } from './types.js';

export type StrategyLabel = 'math' | 'learner' | 'dilute';
export interface PublicMatchConfig {
  auctionType: AuctionType;
  startingRackSize: number;
  auctionDurationMs: number;
  participants: number;
  policyRevision?: string;
  tournamentId?:string;
  frozen?:boolean;
}
export interface PublicAuctionResult {
  matchId: bigint;
  auctionId: bigint;
  letter: string;
  winnerBotId?: bigint | null;
  paid: bigint;
}
export interface PublicWordPlay {
  id: bigint;
  matchId: bigint;
  botId: bigint;
  word: string;
  totalReward: bigint;
}

function integer(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Telemetry values must be finite nonnegative safe integers');
  return value;
}
function identifier(value: string | bigint): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('Telemetry IDs must be decimal integers');
  return text;
}
function letter(value: string): string {
  if (!/^[A-Z]$/.test(value)) throw new Error('Telemetry letter must be uppercase A-Z');
  return value;
}
function word(value: string): string {
  if (!/^[A-Z]{2,}$/.test(value)) throw new Error('Telemetry word must be uppercase letters');
  return value;
}
function auctionType(value: AuctionType): AuctionType {
  if (value !== 'Vickrey' && value !== 'FirstPrice') throw new Error('Invalid telemetry auction type');
  return value;
}

/**
 * Explicit game-field allowlists. Never pass credentials or a connection object.
 * Each call serializes immediately, so later caller mutation cannot change a row.
 */
export class LiveDataRecorder {
  private readonly strategies = new Map<string, StrategyLabel>();
  private readonly seenEvents = new Set<string>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private strategy(matchId: string, value?: StrategyLabel): StrategyLabel | null {
    if (value !== undefined) {
      if (value !== 'math' && value !== 'learner' && value !== 'dilute') throw new Error('Invalid telemetry strategy');
      this.strategies.set(matchId, value);
    }
    return this.strategies.get(matchId) ?? null;
  }

  private append(event: string, matchId: string, fields: Record<string, unknown>): void {
    const row = { schema: 'scrabblebot-live-v1', at: new Date().toISOString(), event, matchId, strategy: this.strategy(matchId), ...fields };
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private alreadySeen(key: string): boolean {
    if (this.seenEvents.has(key)) return true;
    this.seenEvents.add(key);
    // Keep callback replay protection bounded. Event IDs also support deduping
    // across reconnects/restarts during later dataset preparation.
    if (this.seenEvents.size > 4096) this.seenEvents.delete(this.seenEvents.values().next().value!);
    return false;
  }

  decision(matchId: string, auctionId: string | null, strategy: StrategyLabel, ctx: DecisionContext, action: { bid?: number; word?: string | null }): void {
    const id = identifier(matchId);
    const context = {
      myRack: [...ctx.myRack].map(([tile, count]) => [letter(tile), integer(count)] as [string, number]).sort(([a], [b]) => a.localeCompare(b)),
      myBalance: integer(ctx.myBalance), myScore: integer(ctx.myScore), tilesRemaining: integer(ctx.tilesRemaining),
      auctionType: auctionType(ctx.auctionType), letter: letter(ctx.letter),
      ...(ctx.committedBid!==undefined?{committedBid:integer(ctx.committedBid)}:{}),
      opponents: (ctx.opponents ?? []).map(player => ({ ...(player.botId!==undefined?{botId:identifier(player.botId)}:{}),...(typeof player.isSimulated==='boolean'?{isSimulated:player.isSimulated}:{}),balance: integer(player.balance), score: integer(player.score) })),
      information: ctx.information ? {
        consistent: ctx.information.consistent, completeHistory: ctx.information.completeHistory,
        knownOwnInitial: ctx.information.knownOwnInitial, bagCount: ctx.information.bagCount,
        observedAuctionCount: ctx.information.observedAuctionCount,
        expectedBag: [...ctx.information.expectedBag], bagMinimum: [...ctx.information.bagMinimum], bagMaximum: [...ctx.information.bagMaximum],
        opponents: ctx.information.opponents.map(player => ({ botId: identifier(player.botId), rackSize: player.rackSize, initialMinimum: [...player.initialMinimum], rackMinimum: [...player.rackMinimum], rackMaximum: [...player.rackMaximum], rackMean: [...player.rackMean] })),
        effectiveSampleSize: ctx.information.effectiveSampleSize, market: ctx.information.market,
      } : undefined,
    };
    const chosen: { bid?: number; word?: string | null } = {};
    if (action.bid !== undefined) chosen.bid = integer(action.bid);
    if (action.word !== undefined) chosen.word = action.word === null ? null : word(action.word);
    const auction = auctionId === null ? null : identifier(auctionId);
    this.strategy(id, strategy);
    this.append('decision', id, { auctionId: auction, context, action: chosen });
  }

  matchConfig(matchId: string, strategy: StrategyLabel, config: PublicMatchConfig): void {
    const id = identifier(matchId);
    if(config.frozen!==undefined&&typeof config.frozen!=='boolean')throw new Error('Invalid frozen policy flag');
    const publicConfig = {
      auctionType: auctionType(config.auctionType), startingRackSize: integer(config.startingRackSize),
      auctionDurationMs: integer(config.auctionDurationMs), participants: integer(config.participants),
      ...(config.policyRevision !== undefined ? { policyRevision: config.policyRevision } : {}),
      ...(config.tournamentId!==undefined?{tournamentId:identifier(config.tournamentId)}:{}),
      ...(config.frozen!==undefined?{frozen:config.frozen}:{}),
    };
    if (config.policyRevision !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(config.policyRevision)) throw new Error('Invalid policy revision');
    this.strategy(id, strategy);
    this.append('match-config', id, { config: publicConfig });
  }

  auctionResult(event: PublicAuctionResult): void {
    const id = identifier(event.matchId);
    const fields = {
      auctionId: identifier(event.auctionId), letter: letter(event.letter),
      winnerBotId: event.winnerBotId === undefined || event.winnerBotId === null ? null : identifier(event.winnerBotId),
      // Vickrey paid is the runner-up/reserve payment, never the winning bid.
      paid: identifier(event.paid),
    };
    if (!this.alreadySeen(`auction:${id}:${fields.auctionId}`)) this.append('auction-result', id, fields);
  }

  wordPlay(event: PublicWordPlay): void {
    const id = identifier(event.matchId);
    const fields = { wordPlayId: identifier(event.id), botId: identifier(event.botId), word: word(event.word), totalReward: identifier(event.totalReward) };
    if (!this.alreadySeen(`word:${id}:${fields.wordPlayId}`)) this.append('word-play', id, fields);
  }

  matchEnd(matchId: string, strategy: StrategyLabel, myScore: number, players: readonly { botId: string; score: number; balance: number }[]): void {
    const id = identifier(matchId);
    const publicPlayers = players.map(player => ({ botId: identifier(player.botId), score: integer(player.score), balance: integer(player.balance) }));
    const score = integer(myScore);
    this.strategy(id, strategy);
    this.append('match-ended', id, { myScore: score, players: publicPlayers });
  }
}
