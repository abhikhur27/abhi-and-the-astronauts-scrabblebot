import test from 'node:test';
import assert from 'node:assert/strict';
import { clampBid, auctionHasTime, WordGate, ConnectionGate, gameFailureReason, FreshAuctionWindow, wordDecisionKey } from '../src/runtime.js';
import type { DecisionContext, PublicInformation } from '../src/types.js';
import { mayReviseConfirmedBid,currentCommitment,lobbyWindowOpen } from '../src/runtime.js';
test('open-lobby joining stops while the client can remain available for assigned tournament matches',()=>{
 const cutoff=Date.parse('2026-11-07T22:32:00-06:00'),end=Date.parse('2026-11-07T23:50:00-06:00');
 assert.equal(lobbyWindowOpen(cutoff-1,cutoff),true);assert.equal(lobbyWindowOpen(cutoff,cutoff),false);
 assert.equal(lobbyWindowOpen(Date.parse('2026-11-07T22:45:00-06:00'),cutoff),false);
 assert.ok(Date.parse('2026-11-07T22:45:00-06:00')<end);
 assert.equal(lobbyWindowOpen(NaN,cutoff),false);
});

test('an opponent purchase, word or cash change invalidates a cached hold decision', () => {
  const info: PublicInformation = {consistent:false,completeHistory:true,knownOwnInitial:false,bagCount:50,observedAuctionCount:1,expectedBag:new Map(),bagMinimum:new Map(),bagMaximum:new Map(),opponents:[],samples:[],effectiveSampleSize:0,market:{medianPayment:0,p75Payment:0,samples:0}};
  const ctx: DecisionContext = {myRack:new Map([['A',1],['T',1]]),myBalance:100,myScore:0,tilesRemaining:50,letter:'E',auctionType:'Vickrey',opponents:[{botId:'1',balance:100,score:0}],information:info};
  const before = wordDecisionKey(ctx);
  assert.equal(wordDecisionKey(ctx), before);
  assert.notEqual(wordDecisionKey({...ctx,opponents:[{botId:'1',balance:120,score:20}]}),before);
  assert.notEqual(wordDecisionKey({...ctx,information:{...info}}),before);
  assert.notEqual(wordDecisionKey({...ctx,committedBid:21}),before);
});
test('only a confirmed own-state change permits a bounded revision of an existing bid',()=>{
 const old={amount:21,signature:'NORW:36',attemptedAt:1000,attempts:1,status:'accepted' as const};
 assert.equal(mayReviseConfirmedBid(old,'NORW:36',1100),false);
 assert.equal(mayReviseConfirmedBid(old,'D:46',1100),true);
 assert.equal(mayReviseConfirmedBid({...old,attempts:3},'D:46',1100),false);
 assert.equal(mayReviseConfirmedBid(old,'D:46',1010),false);
 assert.equal(mayReviseConfirmedBid(old,'D:46',1025),true);
 assert.equal(mayReviseConfirmedBid(undefined,'NORW:36',1000),true);
});
test('commitment persists after the send window but clears on rejection, cancellation or settlement',()=>{
 const accepted={amount:21,status:'accepted' as const};
 assert.equal(currentCommitment(accepted,true),21);
 assert.equal(currentCommitment({...accepted,status:'rejected'},true),0);
 assert.equal(currentCommitment({...accepted,amount:0},true),0);
 assert.equal(currentCommitment(accepted,false),0);
 assert.equal(currentCommitment({...accepted,status:'submitted'},true),21);
 assert.equal(currentCommitment({...accepted,status:'skipped'},true),0);
 assert.equal(currentCommitment({...accepted,amount:NaN},true),0);
 assert.equal(currentCommitment(undefined,true),0);
});

test('bids are finite nonnegative integer amounts within the available balance', () => {
  assert.equal(clampBid(12.9, 10), 10);
  assert.equal(clampBid(3.9, 10), 3);
  assert.equal(clampBid(NaN, 10), 0);
  assert.equal(clampBid(Infinity, 10), 0);
  assert.equal(clampBid(5, -1), 0);
});
test('reconnected socket cannot act on stale cache before subscription replay applies', () => {
  const session = new ConnectionGate();
  assert.equal(session.canAct(true), false);
  session.applied();
  assert.equal(session.canAct(true), true);
  assert.equal(session.canAct(false), false);
  session.disconnected();
  assert.equal(session.canAct(true), false);
  session.applied();
  assert.equal(session.canAct(true), true);
});
test('game reducer failures retain useful categories without echoing sensitive error text', () => {
  assert.equal(gameFailureReason(new Error('Auction closed private-marker')), 'auction-closed');
  assert.equal(gameFailureReason(new Error('Insufficient balance')), 'insufficient-balance');
  assert.equal(gameFailureReason(new Error('Auction window expired')), 'auction-expired');
  assert.equal(gameFailureReason(new Error('unrecognized private-marker')), 'other');
});
test('fresh-auction bidding expires by monotonic receipt time and duplicate notices cannot extend it', () => {
  const window = new FreshAuctionWindow();
  assert.equal(window.canSend('1', 1000), false);
  window.observe('1', 1000, 1000);
  assert.equal(window.canSend('1', 1001), true);
  assert.equal(window.canSend('1', 1300), false);
  window.observe('1', 1400, 1000);
  assert.equal(window.canSend('1', 1401), false);
  window.observe('2', 2000, 1000);
  assert.equal(window.canSend('2', 2010), true);
});
test('expired or near-expiry auctions are skipped', () => {
  assert.equal(auctionHasTime(1_200_000n, 1000, 100), true);
  assert.equal(auctionHasTime(1_050_000n, 1000, 100), false);
});
test('one word stays in flight until acknowledged and duplicate stale racks are suppressed', () => {
  const gate = new WordGate();
  assert.equal(gate.begin('m', 'A1T1', 1000), true);
  assert.equal(gate.begin('m', 'A2T1', 1001), false);
  gate.finish('m', 1100);
  assert.equal(gate.begin('m', 'A1T1', 1101), false);
  assert.equal(gate.begin('m', 'A2T1', 1101), true);
  gate.finish('m', 1200);
  assert.equal(gate.begin('m', 'A2T1', 3000), true);
});
