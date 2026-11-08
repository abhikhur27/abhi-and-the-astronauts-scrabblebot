import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchRotation, matchQueries, LiveMatchIndex, TournamentMatchIndex,TournamentRegistrationLatch,selectRegistrationTournament,POLICY_NAMES } from '../src/live-session.js';

const registrationSince=Date.parse('2026-11-07T00:00:00-06:00'),registrationNow=Date.parse('2026-11-07T22:30:00-06:00');
const tournament=(id:bigint,status='Registration',createdMs=registrationNow-60000)=>({id,status:{tag:status},createdAt:{microsSinceUnixEpoch:BigInt(createdMs)*1000n},currentRound:0,matchSize:6,topCut:6,swissRoundsTotal:4});

test('automatic registration selects exactly one current-day Registration row using exact timestamp microseconds',()=>{
 const current=tournament(12n);
 const choice=selectRegistrationTournament([tournament(1n,'Ended'),tournament(2n,'Swiss'),tournament(3n,'Lobby'),tournament(4n,'Registration',registrationSince-1),current],[],9001n,registrationSince,registrationNow);
 assert.equal(choice.kind,'candidate');if(choice.kind==='candidate')assert.equal(choice.tournamentId,12n);
 const boundary=tournament(15n,'Registration',registrationSince);boundary.createdAt.microsSinceUnixEpoch-=1n;
 assert.equal(selectRegistrationTournament([boundary],[],9001n,registrationSince,registrationNow).kind,'none');
 boundary.createdAt.microsSinceUnixEpoch+=1n;
 assert.equal(selectRegistrationTournament([boundary,boundary],[],9001n,registrationSince,registrationNow).kind,'candidate');
 assert.equal(selectRegistrationTournament([tournament(16n,'Registration',registrationNow+1)],[],9001n,registrationSince,registrationNow).kind,'none');
});

test('multiple current registration tournaments require an operator and own entry detection uses the credential bot id',()=>{
 const rows=[tournament(12n),tournament(13n)];
 const own=[{id:33n,tournamentId:12n,botId:9001n}];
 const ambiguous=selectRegistrationTournament(rows,own,9001n,registrationSince,registrationNow);
 assert.equal(ambiguous.kind,'ambiguous');if(ambiguous.kind==='ambiguous')assert.deepEqual(ambiguous.tournamentIds,['12','13']);
 assert.equal(selectRegistrationTournament([rows[0]!],own,9001n,registrationSince,registrationNow).kind,'already-entered');
 assert.equal(selectRegistrationTournament([rows[0]!],own,9002n,registrationSince,registrationNow).kind,'candidate');
 assert.equal(selectRegistrationTournament([tournament(1n,'Ended')],own,9001n,registrationSince,registrationNow).kind,'none');
});

test('registration attempts are in-flight safe, cooldown bounded, and retry only on state changes or thirty seconds',()=>{
 const latch=new TournamentRegistrationLatch();
 assert.equal(latch.begin(12n,0,'initial'),1);assert.equal(latch.begin(12n,5000,'changed'),undefined);
 latch.settle(12n,1);assert.equal(latch.begin(12n,4999,'changed'),undefined);
 assert.equal(latch.begin(12n,5000,'initial'),undefined);
 assert.equal(latch.begin(12n,5000,'changed'),2);
 latch.settle(12n,1);assert.equal(latch.begin(12n,40000,'changed'),undefined,'an old ACK cannot clear a newer in-flight request');
 latch.disconnected();assert.equal(latch.begin(12n,34999,'changed'),undefined);
 assert.equal(latch.begin(12n,35000,'changed'),3);latch.settle(12n,3);
 assert.equal(latch.exhausted(12n),true);assert.equal(latch.begin(12n,100000,'changed-again'),undefined);
});

test('only an observed entry confirmation permanently closes registration, and ACK settlement alone does not',()=>{
 const latch=new TournamentRegistrationLatch();
 assert.equal(latch.begin(12n,0,'same'),1);latch.settle(12n,1);
 assert.equal(latch.begin(12n,30000,'same'),2,'an ACK without an entry may retry idempotently after thirty seconds');
 assert.equal(latch.confirm(12n),true);assert.equal(latch.confirm(12n),false);
 latch.disconnected();assert.equal(latch.begin(12n,100000,'later'),undefined);assert.equal(latch.exhausted(12n),false);
 assert.equal(latch.confirm(13n),true);assert.equal(latch.begin(13n,100000,'new'),undefined);
});
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
