import test from 'node:test';
import assert from 'node:assert/strict';
import { WordEngine } from '../src/engine.js';
import { evaluateLeague, comparePairedBlocks, meetsPrimaryObjective, type LeagueEntry } from '../src/league.js';
import type { BotPolicy } from '../src/types.js';

const idle = (): BotPolicy => ({ decideBid: () => 0, chooseWord: () => null });
const engine = new WordEngine(['AT', 'TO', 'TA']);
function entries(create: (name: string) => BotPolicy = () => idle()): LeagueEntry[] {
  return ['math', 'rl', 'dilute', 'v2', 'teacher1', 'teacher2'].map(name => ({ name, create: () => create(name) }));
}

test('league rotates every policy through every seat with a shared held-out seed', async () => {
  const seen = new Map<string, number[]>();
  const policies = entries().map(entry => ({ ...entry, create: ({ seat, seed }: { seat: number; seed: number }) => {
    assert.equal(seed, 0x80000007); seen.set(entry.name, [...(seen.get(entry.name) ?? []), seat]); return idle();
  } }));
  const report = await evaluateLeague({ engine, entries: policies, seedBlock: 7, seedCount: 1,
    baselineName: 'v2', championName: 'v2', candidateNames: ['math', 'rl', 'dilute'], auctionTypes: ['Vickrey'], beliefParticles: 1,
    snapshots: { model: () => ({ frozen: true }) } });
  assert.equal(report.completed, true);
  assert.equal(report.primaryObjective, 'score');
  assert.equal(report.games.length, 6);
  assert.equal(report.modes[0]!.completedSeedBlocks, 1);
  for (const seats of seen.values()) assert.deepEqual([...seats].sort(), [0, 1, 2, 3, 4, 5]);
  assert.ok(report.games.every(game => game.seed === 0x80000007));
  assert.ok(report.gates.every(gate => !gate.eligible));
  assert.ok(report.gates[0]!.reasons.some(reason => reason.includes('six')));
  assert.ok(Math.abs(report.modes[0]!.ranking.reduce((sum, row) => sum + row.winShare, 0) - 1) < 1e-12);
});

test('seed-block uncertainty prevents a high-variance positive mean from claiming superiority', () => {
  const comparison = comparePairedBlocks([10, 10, 10, 10, 10, -40].map(difference => ({
    candidateScore: 100 + difference, referenceScore: 100, candidateWinShare: 0.2, referenceWinShare: 0.2,
  })));
  assert.equal(comparison.blocks, 6);
  assert.ok(comparison.meanScoreDifference > 0);
  assert.ok(comparison.scoreDifferenceLower95OneSided! < 0);
  assert.equal(comparison.superior, false);
});

test('score superiority cannot substitute for noninferior match win share', () => {
  const comparison = comparePairedBlocks(Array.from({ length: 6 }, () => ({
    candidateScore: 110, referenceScore: 100, candidateWinShare: 0, referenceWinShare: 0.2,
  })));
  assert.equal(comparison.superior, true);
  assert.equal(comparison.winShareNoninferior, false);
});

test('equal own score with more wins can pass the winning objective without passing score superiority', () => {
  const comparison = comparePairedBlocks(Array.from({ length: 6 }, () => ({
    candidateScore: 100, referenceScore: 100, candidateWinShare: 0.5, referenceWinShare: 0.25,
  })));
  assert.equal(comparison.winShareSuperior, true);
  assert.equal(meetsPrimaryObjective(comparison, 'win-share'), true);
  assert.equal(meetsPrimaryObjective(comparison, 'score'), false);
});

test('higher own score that wins fewer games fails the winning objective', () => {
  const comparison = comparePairedBlocks(Array.from({ length: 6 }, () => ({
    candidateScore: 120, referenceScore: 100, candidateWinShare: 0.15, referenceWinShare: 0.3,
  })));
  assert.equal(comparison.superior, true);
  assert.equal(comparison.winShareSuperior, false);
  assert.equal(meetsPrimaryObjective(comparison, 'win-share'), false);
});

test('positive but high-variance win improvement cannot pass the winning objective', () => {
  const comparison = comparePairedBlocks([1, 1, 1, 1, 1, 0].map(winShare => ({
    candidateScore: 100, referenceScore: 100, candidateWinShare: winShare, referenceWinShare: 0.75,
  })));
  assert.ok(comparison.meanWinShareDifference > 0);
  assert.ok(comparison.winShareDifferenceLower95OneSided! < 0);
  assert.equal(comparison.winShareSuperior, false);
  assert.equal(meetsPrimaryObjective(comparison, 'win-share'), false);
});

test('a mutation in a policy lifecycle invalidates frozen evaluation and prevents promotion', async () => {
  const weights = { updates: 0 };
  const policies = entries(name => name === 'rl' ? Object.assign(idle(), { finishEpisode: () => { weights.updates++; } }) : idle());
  const report = await evaluateLeague({ engine, entries: policies, seedBlock: 15, baselineName: 'v2', championName: 'v2',
    candidateNames: ['rl'], auctionTypes: ['Vickrey'], beliefParticles: 1, snapshots: { model: () => weights } });
  assert.equal(report.frozen.unchanged, false);
  assert.equal(report.completed, false);
  assert.equal(report.games.length, 1);
  assert.ok(report.gates[0]!.reasons.includes('frozen snapshot changed'));
});

test('invalid actions are counted instead of disappearing in simulator rejection', async () => {
  const policies = entries(name => name === 'math' ? { decideBid: () => NaN, chooseWord: () => 'ZZZZZZZZ' } : idle());
  const report = await evaluateLeague({ engine, entries: policies, seedBlock: 25, seedCount: 1,
    baselineName: 'v2', championName: 'v2', candidateNames: ['math'], auctionTypes: ['Vickrey'], beliefParticles: 1,
    snapshots: { model: () => 0 } });
  const math = report.modes[0]!.ranking.find(row => row.name === 'math')!;
  assert.ok(math.actions.invalidBids > 0);
  assert.ok(math.actions.invalidWords > 0);
  assert.ok(report.gates[0]!.reasons.some(reason => reason.includes('invalid')));
});

test('abort between matches yields an incomplete report that cannot promote', async () => {
  const abort = new AbortController();
  const policies = entries(name => name === 'math' ? Object.assign(idle(), { finishEpisode: () => abort.abort() }) : idle());
  const report = await evaluateLeague({ engine, entries: policies, seedBlock: 30, baselineName: 'v2', championName: 'v2',
    candidateNames: ['math'], auctionTypes: ['Vickrey'], beliefParticles: 1, signal: abort.signal,
    snapshots: { model: () => 0 } });
  assert.equal(report.completed, false);
  assert.equal(report.stopReason, 'aborted');
  assert.equal(report.games.length, 1);
  assert.equal(report.modes[0]!.completedSeedBlocks, 0);
  assert.equal(report.gates[0]!.eligible, false);
});

test('duration bound stops before a new game and unverified snapshots cannot promote', async () => {
  const report = await evaluateLeague({ engine, entries: entries(), seedBlock: 36, baselineName: 'v2', championName: 'v2',
    candidateNames: ['math'], maxDurationMs: 0 });
  assert.equal(report.stopReason, 'duration-limit');
  assert.equal(report.completedGames, 0);
  assert.equal(report.expectedGames, 72);
  assert.equal(report.frozen.verified, false);
  assert.ok(report.gates[0]!.reasons.includes('frozen snapshot unverified'));
});

test('winning objective is explicit in reports and gate rejection reasons', async () => {
  const report = await evaluateLeague({ engine, entries: entries(), seedBlock: 45, baselineName: 'v2', championName: 'teacher1',
    candidateNames: ['math'], primaryObjective: 'win-share', maxDurationMs: 0 });
  assert.equal(report.primaryObjective, 'win-share');
  assert.equal(report.gates[0]!.primaryObjective, 'win-share');
  assert.ok(report.gates[0]!.reasons.some(reason => reason.includes('primary win-share superiority unproved versus v2')));
  assert.ok(report.gates[0]!.reasons.some(reason => reason.includes('primary win-share superiority unproved versus teacher1')));
  assert.ok(!report.gates[0]!.reasons.some(reason => reason.includes('score superiority')));
});

test('slow policy decisions are measured and reject the latency gate', async () => {
  const abort = new AbortController();
  const policies = entries(name => name === 'math' ? {
    decideBid: () => 0,
    chooseWord: () => { const until = performance.now() + 1; while (performance.now() < until) { /* Deliberately exceed fixture budget. */ } return null; },
    finishEpisode: () => abort.abort(),
  } : idle());
  const report = await evaluateLeague({ engine, entries: policies, seedBlock: 40, baselineName: 'v2', championName: 'v2',
    candidateNames: ['math'], auctionTypes: ['Vickrey'], beliefParticles: 1, signal: abort.signal,
    decisionBudgetMs: 0.1, snapshots: { model: () => 0 } });
  const math = report.modes[0]!.ranking.find(row => row.name === 'math')!;
  assert.ok(math.actions.lateWords > 0);
  assert.ok(report.gates[0]!.reasons.some(reason => reason.includes('decision budget exceeded')));
});
