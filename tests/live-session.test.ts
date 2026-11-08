import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchRotation, matchQueries, LiveMatchIndex, TournamentMatchIndex,POLICY_NAMES } from '../src/live-session.js';
test('tournament assignment links survive initial replay and remain independent of open-lobby rotation',()=>{
 const index=new TournamentMatchIndex(),rotation=new MatchRotation('rotate');
 index.replace([{matchId:20n,tournamentId:3n}]);assert.equal(index.get('20'),'3');assert.equal(index.get(21n),undefined);
 assert.equal(rotation.choose('21'),'math');index.set({matchId:22n,tournamentId:3n});assert.equal(index.get(22n),'3');
 assert.equal(rotation.choose('23'),'learner');index.delete(20n);assert.equal(index.get(20n),undefined);
 index.replace([{matchId:24n,tournamentId:4n}]);assert.equal(index.get(22n),undefined);assert.equal(index.get(24n),'4');
});
test('one persona alternates policies across matches and keeps assignments stable after restart', () => {
  const rotation = new MatchRotation('alternate');
  assert.equal(rotation.choose('100'), 'math');
  assert.equal(rotation.choose('100'), 'math');
  assert.equal(rotation.choose('200'), 'learner');
  const resumed = new MatchRotation('alternate', rotation.snapshot());
  assert.equal(resumed.choose('200'), 'learner');
  assert.equal(resumed.choose('300'), 'math');
  assert.equal(new MatchRotation('learner').choose('42'), 'learner');
});
test('three-policy rotation migrates old assignments, resumes and uses requested labels', () => {
  const old = { schema: 'scrabblebot-rotation-v1' as const, mode: 'alternate' as const, next: 7, assignments: { '1': 'learner' as const } };
  const rotation = new MatchRotation('rotate', old);
  assert.equal(rotation.choose('1'), 'learner');
  assert.equal(rotation.choose('2'), 'math');
  assert.equal(rotation.choose('3'), 'learner');
  const resumed = new MatchRotation('rotate', rotation.snapshot());
  assert.equal(resumed.choose('4'), 'dilute');
  assert.equal(resumed.choose('5'), 'math');
  assert.deepEqual(Object.values(POLICY_NAMES), ['AbhiAuction', 'AbhiRL', 'AbhiDilute']);
});
test('active dispatch finds our current match despite a large historical state cache', () => {
  const index = new LiveMatchIndex<{ id: bigint; status: { tag: string } }, { matchId: bigint; botId: bigint }>(169n);
  for (let id = 0n; id < 45000n; id++) index.state({ id, status: { tag: 'Ended' } });
  for (let id = 1n; id < 100n; id++) index.participant({ matchId: id, botId: 169n });
  index.state({ id: 50000n, status: { tag: 'Running' } });
  index.participant({ matchId: 50000n, botId: 169n });
  index.participant({ matchId: 50001n, botId: 1n });
  assert.deepEqual(index.running().map(row => row.id), [50000n]);
  assert.equal(index.mine('50000')?.botId, 169n);
  index.state({ id: 50000n, status: { tag: 'Ended' } });
  assert.equal(index.running().length, 0);
  assert.equal(index.get(50000n)?.status.tag, 'Ended');
  index.state({ id: 50000n, status: { tag: 'Running' } });
  index.replaceStates([]);
  assert.equal(index.running().length, 0);
  index.state({ id: 50000n, status: { tag: 'Running' } });
  index.replaceParticipants([]);
  assert.equal(index.running().length, 0);
});
test('match subscriptions isolate active-match auction and word history', () => {
  assert.deepEqual(matchQueries(169n), [
    'SELECT * FROM match_participant WHERE match_id = 169',
    'SELECT * FROM auction WHERE match_id = 169',
    'SELECT * FROM auction_result WHERE match_id = 169',
    'SELECT * FROM word_play WHERE match_id = 169',
  ]);
});
