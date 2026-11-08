import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveDataRecorder } from '../src/telemetry.js';
import type { DecisionContext } from '../src/types.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hackutd-telemetry-'));
  const path = join(directory, 'nested', 'game.jsonl');
  return { directory, path, recorder: new LiveDataRecorder(path), rows: () => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
const context = (): DecisionContext => ({ myRack: new Map([['T', 1], ['A', 2]]), myBalance: 87, myScore: 21, tilesRemaining: 60, auctionType: 'Vickrey', letter: 'E', opponents: [{balance: 95, score: 12}] });

test('decision append takes an own-rack snapshot and excludes injected credential/private fields', () => {
  const f = fixture();
  try {
    const rack = new Map([['T', 1], ['A', 2]]);
    const opponent = { balance: 95, score: 12, rack: ['Q', 'I'], token: 'private-opponent-marker' };
    const ctx = { ...context(), myRack: rack, opponents: [opponent], token: 'private-token-marker', identity: 'private-identity-marker' };
    f.recorder.decision('10', '15', 'math', ctx, { bid: 7, token: 'private-action-marker' } as { bid: number });
    rack.set('A', 9); opponent.balance = 0;
    assert.ok(existsSync(f.path), 'Decision must be appended to the real data file');
    const [row] = f.rows();
    assert.deepEqual(row.context.myRack, [['A', 2], ['T', 1]]);
    assert.deepEqual(row.context.opponents, [{ balance: 95, score: 12 }]);
    assert.deepEqual(row.action, { bid: 7 });
    assert.equal(row.strategy, 'math');
    assert.equal(row.schema, 'scrabblebot-live-v1');
    assert.ok(Number.isFinite(Date.parse(row.at)));
    assert.equal(readFileSync(f.path, 'utf8').includes('private-'), false);
  } finally { rmSync(f.directory, { recursive: true }); }
});

test('public BigInt events keep exact IDs and paid is never relabeled as winning bid', () => {
  const f = fixture();
  try {
    f.recorder.matchConfig('9007199254740993', 'learner', {auctionType: 'Vickrey', startingRackSize: 5, auctionDurationMs: 1000, participants: 6});
    const event = { matchId: 9007199254740993n, auctionId: 9007199254740994n, letter: 'Q', winnerBotId: 3n, paid: 11n, topBid: 999n, token: 'private-marker' };
    f.recorder.auctionResult(event);
    f.recorder.auctionResult(event);
    f.recorder.wordPlay({ id: 21n, matchId: event.matchId, botId: 3n, word: 'QI', totalReward: 11n });
    assert.ok(existsSync(f.path), 'Public events must be appended to the real data file');
    f.recorder.wordPlay({ id: 21n, matchId: event.matchId, botId: 3n, word: 'QI', totalReward: 11n });
    const rows = f.rows();
    assert.equal(rows.length, 3);
    assert.equal(rows[1].matchId, '9007199254740993');
    assert.equal(rows[1].auctionId, '9007199254740994');
    assert.equal(rows[1].paid, '11');
    assert.equal(rows[1].winnerBotId, '3');
    assert.equal(rows[1].strategy, 'learner');
    assert.equal(rows[1].topBid, undefined);
    assert.equal(rows[2].totalReward, '11');
    assert.equal(readFileSync(f.path, 'utf8').includes('private-marker'), false);
  } finally { rmSync(f.directory, { recursive: true }); }
});

test('match outcome appends public scores without leaking extra player fields', () => {
  const f = fixture();
  try {
    f.recorder.decision('10', null, 'learner', context(), { word: null });
    f.recorder.matchEnd('10', 'learner', 43, [{ botId: '1', score: 43, balance: 110, token: 'private-marker', rack: ['X'] } as {botId:string;score:number;balance:number}]);
    assert.ok(existsSync(f.path), 'Outcome must be appended to the real data file');
    assert.deepEqual(f.rows()[1].players, [{botId:'1',score:43,balance:110}]);
    assert.equal(f.rows()[1].myScore, 43);
    assert.equal(f.rows()[0].action.word, null);
    assert.equal(readFileSync(f.path, 'utf8').includes('private-marker'), false);
  } finally { rmSync(f.directory, { recursive: true }); }
});

test('nonfinite decisions fail closed instead of producing corrupted training rows', () => {
  const f = fixture();
  try {
    assert.throws(() => f.recorder.decision('10', '15', 'math', { ...context(), myBalance: NaN }, { bid: 1 }), /finite/);
    assert.throws(() => f.recorder.decision('10', '15', 'math', context(), { bid: Infinity }), /finite/);
  } finally { rmSync(f.directory, { recursive: true }); }
});
test('decision records public opponent IDs and only our submitted commitment',()=>{
 const f=fixture();try{
  f.recorder.decision('10','15','dilute',{...context(),committedBid:21,opponents:[{botId:'18',score:96,balance:72}]},{word:null});
  const row=f.rows()[0];assert.equal(row.context.committedBid,21);assert.deepEqual(row.context.opponents,[{botId:'18',score:96,balance:72}]);
 }finally{rmSync(f.directory,{recursive:true});}
});
test('tournament metadata distinguishes frozen play without accepting extra objects',()=>{
 const f=fixture();try{
  const config={auctionType:'Vickrey' as const,startingRackSize:5,auctionDurationMs:1000,participants:6,tournamentId:'1',frozen:true};
  f.recorder.matchConfig('10','learner',config);assert.equal(f.rows()[0].config.tournamentId,'1');assert.equal(f.rows()[0].config.frozen,true);
  assert.throws(()=>f.recorder.matchConfig('11','learner',{...config,frozen:{token:'private-marker'}} as unknown as typeof config),/frozen/);
  assert.equal(f.rows().length,1);
 }finally{rmSync(f.directory,{recursive:true});}
});
