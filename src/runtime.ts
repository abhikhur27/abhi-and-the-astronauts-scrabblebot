import type { DecisionContext, PublicInformation } from './types.js';
const informationRevisions = new WeakMap<PublicInformation, number>();
let nextInformationRevision = 0;
export function wordDecisionKey(ctx: DecisionContext): string {
  let revision = 0;
  if (ctx.information) {
    revision = informationRevisions.get(ctx.information) ?? ++nextInformationRevision;
    informationRevisions.set(ctx.information, revision);
  }
  return JSON.stringify([[...ctx.myRack].sort(([a], [b]) => a.localeCompare(b)), ctx.myBalance, ctx.myScore, ctx.tilesRemaining, ctx.letter, ctx.opponents, ctx.committedBid, revision]);
}
export function clampBid(bid: number, balance: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(balance)) return 0;
  return Math.max(0, Math.min(Math.floor(bid), Math.floor(balance), Number.MAX_SAFE_INTEGER));
}
export function lobbyWindowOpen(nowMs:number,stopJoiningAtMs:number):boolean {
 return Number.isFinite(nowMs)&&!Number.isNaN(stopJoiningAtMs)&&nowMs<stopJoiningAtMs;
}
export interface OwnBidState {
  amount: number;
  attemptedAt: number;
  signature: string;
  attempts: number;
  status: 'submitted' | 'accepted' | 'rejected' | 'skipped';
}
/** Revisit an auction only after our confirmed rack/cash state changes. */
export function mayReviseConfirmedBid(previous: OwnBidState | undefined, signature: string, now: number): boolean {
  if (!previous) return true;
  return previous.signature !== signature && previous.attempts < 3 && now - previous.attemptedAt >= 25;
}
/** A submitted own bid remains relevant until its rejection or auction settlement. */
export function currentCommitment(record: Pick<OwnBidState, 'amount' | 'status'> | undefined, auctionOpen: boolean): number {
  return auctionOpen && record && (record.status === 'submitted' || record.status === 'accepted')
    && Number.isSafeInteger(record.amount) && record.amount > 0 ? record.amount : 0;
}
export function auctionHasTime(closesMicros: bigint, nowMs: number, marginMs = 100): boolean {
  return closesMicros > BigInt(Math.ceil(nowMs + marginMs)) * 1000n;
}
export function gameFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/auction closed/i.test(message)) return 'auction-closed';
  if (/auction window expired/i.test(message)) return 'auction-expired';
  if (/insufficient balance/i.test(message)) return 'insufficient-balance';
  if (/not enough|cannot spell/i.test(message)) return 'rack-mismatch';
  if (/not in the dictionary/i.test(message)) return 'invalid-word';
  return 'other';
}
export class WordGate {
  private attempts = new Map<string, { rack: string; pending: boolean; completed: number }>();
  begin(match: string, rack: string, now: number): boolean {
    const previous = this.attempts.get(match);
    if (previous?.pending || (previous?.rack === rack && now - previous.completed < 750)) return false;
    this.attempts.set(match, { rack, pending: true, completed: now });
    return true;
  }
  finish(match: string, now: number): void {
    const previous = this.attempts.get(match);
    if (previous) this.attempts.set(match, { ...previous, pending: false, completed: now });
  }
  clear(match: string): void { this.attempts.delete(match); }
  reset(): void { this.attempts.clear(); }
}
export class ConnectionGate {
  private ready = false;
  applied(): void { this.ready = true; }
  disconnected(): void { this.ready = false; }
  canAct(active: boolean): boolean { return active && this.ready; }
}
export class FreshAuctionWindow {
  private readonly auctions = new Map<string, { received: number; budget: number }>();
  observe(id: string, receivedMs: number, durationMs: number): void {
    if (this.auctions.has(id)) return;
    this.auctions.set(id, { received: receivedMs, budget: Math.max(0, Math.min(250, durationMs / 4)) });
    if (this.auctions.size > 512) this.auctions.delete(this.auctions.keys().next().value!);
  }
  canSend(id: string, nowMs: number): boolean {
    const auction = this.auctions.get(id);
    return !!auction && nowMs >= auction.received && nowMs - auction.received < auction.budget;
  }
  age(id: string, nowMs: number): number | null { const auction = this.auctions.get(id); return auction ? Math.max(0, nowMs - auction.received) : null; }
}
