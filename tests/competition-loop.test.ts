import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runCompetitionCycle,selectionExpiresAt,competitionWorkerPlan,parseOwnedBotIds,loadOwnedBotIds,mayReplaceIncumbent,shouldFocusEndgame,shouldFocusReinvestment,sameEndgameFoundation,sameReinvestmentFoundation,reinvestmentDevelopmentConfigurations } from '../src/competition-loop.js';
import { createModel,saveModel } from '../src/model.js';
import { baselineSelection,publishSelection,artifactReference } from '../src/competition-store.js';
import { EXECUTION_PROTOCOL_VERSION } from '../src/coordinated-policy.js';
import { REINVEST_POLICY_VERSION,normalizedReinvestmentOptions } from '../src/reinvest.js';
import { discoverArenaPlayers,type ArenaCompleteGame } from '../src/arena-data.js';
function workspace() {const root=mkdtempSync(join(tmpdir(),'competition-cycle-'));mkdirSync(join(root,'data'));mkdirSync(join(root,'runs'));writeFileSync(join(root,'data','enable1.txt'),'AT\nATE\nTEA\n');return root;}
test('a requested stop prevents refresh, training, seed allocation and artifact publication',async()=>{
  const root=workspace();writeFileSync(join(root,'runs','STOP'),'stop');
  const result=await runCompetitionCycle({root,offline:true,trainGames:2,evaluationSeeds:1,skipTuning:true,auctionTypes:['Vickrey'],untilMs:Date.now()+60000});
  assert.equal(result.status,'stopped');
  assert.equal(existsSync(join(root,'models','competition-candidate.json')),false);
  assert.equal(existsSync(join(root,'runs','competition','state.json')),false);
});
test('the initial selection remains usable through the face-off after training stops',async()=>{
  const root=workspace(),untilMs=Date.now()+60000;
  writeFileSync(join(root,'runs','owned-bot-ids.json'),JSON.stringify({botIds:[169,99999]}));
  await runCompetitionCycle({root,offline:true,trainGames:1,evaluationSeeds:1,skipTuning:true,auctionTypes:['Vickrey'],untilMs,maxCycleMs:30000,cycleIntervalMs:5000});
  const selection=JSON.parse(readFileSync(join(root,'models','active-selection.json'),'utf8'));
  assert.ok(Date.parse(selection.expiresAt)>untilMs+25*60000,'the selection must cover a face-off starting 25 minutes after training stops');
  assert.equal(Date.parse(selection.expiresAt),untilMs+90*60000);
  const progress=JSON.parse(readFileSync(join(root,'runs','competition','progress.json'),'utf8'));
  assert.deepEqual(progress.excludedBotIds,[169,99999]);
  assert.equal(progress.cycleIntervalMs,5000);assert.equal(Date.parse(progress.nextCycleNotBefore),Math.min(untilMs,Date.parse(progress.startedAt)+5000));
});
test('the event lease never extends the candidate source freshness cutoff',()=>{
  const trainingUntil=Date.parse('2026-11-07T22:20:00-06:00'),faceOff=Date.parse('2026-11-07T22:45:00-06:00');
  const freshUntil=Date.parse('2026-11-07T23:20:00-06:00'),earlierFreshUntil=Date.parse('2026-11-07T22:30:00-06:00');
  assert.equal(selectionExpiresAt(trainingUntil,freshUntil),freshUntil);
  assert.ok(selectionExpiresAt(trainingUntil,freshUntil)>faceOff);
  assert.equal(selectionExpiresAt(trainingUntil,earlierFreshUntil),earlierFreshUntil);
  assert.equal(selectionExpiresAt(trainingUntil,trainingUntil+120*60000),Date.parse('2026-11-07T23:50:00-06:00'));
});
test('cycles resume genuine learning, reserve fresh seeds and retain V2 when evidence is insufficient',async()=>{
  const root=workspace();
  const options={root,offline:true,trainGames:2,evaluationSeeds:1,skipTuning:true,auctionTypes:['Vickrey' as const],untilMs:Date.now()+60000,maxCycleMs:30000};
  const first=await runCompetitionCycle(options), model=JSON.parse(readFileSync(join(root,'models','competition-candidate.json'),'utf8'));
  assert.equal(first.status,'complete');assert.equal(model.schema,'scrabblebot-v2-residual-v1');assert.equal(model.trainedGames,2);assert.ok(model.updates>0);
  const second=await runCompetitionCycle(options), next=JSON.parse(readFileSync(join(root,'models','competition-candidate.json'),'utf8'));
  assert.equal(next.trainedGames,4);assert.ok(next.updates>model.updates);
  assert.notEqual(first.evaluationSeed,second.evaluationSeed);
  const firstReport=JSON.parse(readFileSync(first.reportPath!,'utf8')),secondReport=JSON.parse(readFileSync(second.reportPath!,'utf8'));
  assert.equal(firstReport.executionProtocol,EXECUTION_PROTOCOL_VERSION);assert.equal(firstReport.primaryObjective,'win-share');
  assert.deepEqual(firstReport.gates.map((gate:{candidate:string})=>gate.candidate),['reinvest-candidate']);
  assert.equal(firstReport.candidateConfiguration.reinvestment.closingTiles,36);assert.equal(firstReport.reinvestmentRevision,REINVEST_POLICY_VERSION);
  assert.ok(firstReport.games.every((game:{players:{actions:{exceptions:number}}[]})=>game.players.every(player=>player.actions.exceptions===0)));
  assert.deepEqual(secondReport.gates.map((gate:{candidate:string})=>gate.candidate),['math-candidate','learner-candidate','dilute-candidate']);
  assert.equal(secondReport.primaryObjective,'win-share');
  const selection=JSON.parse(readFileSync(join(root,'models','active-selection.json'),'utf8'));
  assert.equal(selection.math.mode,'v2');assert.equal(selection.learner.mode,'v2');assert.equal(selection.dilute.mode,'v2');
});
test('foundation evaluation alternates before approval, may be prioritized, and compares normalized options',()=>{
  const selection=baselineSelection('a'.repeat(64));
  assert.equal(shouldFocusEndgame(1,selection),false);assert.equal(shouldFocusEndgame(2,selection),false);
  assert.equal(shouldFocusReinvestment(1,selection),true);assert.equal(shouldFocusReinvestment(2,selection),false);assert.equal(shouldFocusReinvestment(2,selection,true),true);
  assert.equal(shouldFocusEndgame(2,selection,true),true);
  selection.endgame={mode:'approved',candidate:'endgame-candidate',report:{path:'models/league/gate.json',sha256:'a'.repeat(64)},options:{closingTiles:18}};
  assert.equal(shouldFocusEndgame(3,selection),false);assert.equal(shouldFocusEndgame(4,selection,true),false);
  assert.equal(shouldFocusReinvestment(3,selection),false);assert.equal(shouldFocusReinvestment(4,selection,true),false);
  assert.equal(sameEndgameFoundation({closingTiles:18},{closingTiles:18,liquidationTiles:4,maxScenarios:4,minimumWinDelta:.15}),true);
  assert.equal(sameEndgameFoundation({closingTiles:18},{closingTiles:30}),false);
  assert.equal(sameEndgameFoundation(undefined,{closingTiles:18}),false);
  delete selection.endgame;selection.reinvestment={mode:'approved',candidate:'reinvest-candidate',report:{path:'models/league/gate.json',sha256:'a'.repeat(64)},options:{strength:'balanced',closingTiles:36}};
  assert.equal(shouldFocusEndgame(1,selection,true),false);assert.equal(shouldFocusReinvestment(1,selection,true),false);
  assert.equal(sameReinvestmentFoundation({},{strength:'balanced',closingTiles:36}),true);
  assert.equal(sameReinvestmentFoundation({strength:'balanced'},{strength:'aggressive'}),false);
  assert.equal(sameReinvestmentFoundation({mode:'completions'},{mode:'rebuild'}),false);
});
test('focused reinvestment development isolates components in both modes before a disjoint frozen evaluation',async()=>{
  const root=workspace(),result=await runCompetitionCycle({root,offline:true,focusReinvestment:true,trainGames:1,tuningSeeds:1,evaluationSeeds:1,auctionTypes:['Vickrey'],untilMs:Date.now()+10*60000,maxCycleMs:4*60000});
  const development=JSON.parse(readFileSync(join(dirname(result.reportPath!),'reinvestment-development.json'),'utf8')),final=JSON.parse(readFileSync(result.reportPath!,'utf8'));
  const configurations=reinvestmentDevelopmentConfigurations();
  assert.equal(development.completed,true);assert.equal(development.completedGames,36);
  assert.deepEqual(development.auctionTypes,['Vickrey','FirstPrice']);
  assert.deepEqual(Object.keys(development.candidateConfigurations),configurations.map(configuration=>configuration.name));
  assert.deepEqual(Object.values(development.candidateConfigurations).map((options:any)=>[options.strength,options.mode,options.closingTiles]),[['balanced','both',36],['aggressive','both',36],['balanced','completions',36],['balanced','rebuild',36],['aggressive','completions',18],['aggressive','completions',36],['aggressive','completions',68],['balanced','rebuild',68]]);
  assert.equal(development.selectionMethod,'within-heat-then-common-field-runoff');
  assert.equal(development.heats.length,2);
  for(const heat of [...development.heats,development.runoff]){assert.equal(heat.completed,true);assert.equal(heat.completedGames,12);assert.deepEqual(heat.auctionTypes,['Vickrey','FirstPrice']);}
  const developmentSeeds=[...development.heats,development.runoff].map((heat:any)=>heat.seedBlock);
  assert.equal(new Set(developmentSeeds).size,3);assert.ok(developmentSeeds.every((seed:number)=>seed!==final.seedBlock));
  const chosen=configurations.find(configuration=>configuration.name===development.selectedConfiguration)!;
  assert.deepEqual(normalizedReinvestmentOptions(final.candidateConfiguration.reinvestment),normalizedReinvestmentOptions(chosen.options));
  assert.equal(final.gates.length,1);assert.equal(final.gates[0].candidate,'reinvest-candidate');
  assert.equal(existsSync(join(dirname(result.reportPath!),'math-development.json')),false);
  assert.equal(existsSync(join(dirname(result.reportPath!),'word-development.json')),false);
  assert.equal(JSON.parse(readFileSync(join(root,'models','competition-candidate.json'),'utf8')).trainedGames,1);
});
test('manual endgame focus remains a separate bounded family',async()=>{
  const root=workspace(),result=await runCompetitionCycle({root,offline:true,trainGames:1,evaluationSeeds:1,skipTuning:true,focusEndgame:true,auctionTypes:['Vickrey'],untilMs:Date.now()+60000,maxCycleMs:30000});
  const proof=JSON.parse(readFileSync(result.reportPath!,'utf8'));
  assert.deepEqual(proof.gates.map((gate:{candidate:string})=>gate.candidate),['endgame-candidate']);
  assert.equal(proof.candidateConfiguration.endgame.closingTiles,18);assert.equal(proof.candidateConfiguration.reinvestment,undefined);
});
test('an approved reinvestment foundation runs through fixed and learner-anchor factories without exceptions',async()=>{
  const root=workspace(),time=Date.now(),dictionaryHash=createHash('sha256').update(readFileSync(join(root,'data','enable1.txt'))).digest('hex');
  mkdirSync(join(root,'models','league'),{recursive:true});
  const path=join(root,'models','league','fixture-proof.json');
  // Synthetic authorization fixture tests wiring only, not policy superiority.
  writeFileSync(path,JSON.stringify({schema:'scrabblebot-league-v1',completed:true,executionProtocol:EXECUTION_PROTOCOL_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,primaryObjective:'win-share',frozen:{verified:true,unchanged:true},modes:[{auctionType:'Vickrey',completedSeedBlocks:6},{auctionType:'FirstPrice',completedSeedBlocks:6}],candidateConfiguration:{reinvestment:{strength:'balanced',closingTiles:36}},gates:[{candidate:'reinvest-candidate',eligible:true,primaryObjective:'win-share'}]}));
  const selection=baselineSelection(dictionaryHash,time,time+60000);selection.reinvestment={mode:'approved',candidate:'reinvest-candidate',report:artifactReference(root,path),options:{strength:'balanced',closingTiles:36}};publishSelection(root,selection,time);
  const result=await runCompetitionCycle({root,offline:true,trainGames:1,evaluationSeeds:1,skipTuning:true,auctionTypes:['Vickrey'],untilMs:time+60000,maxCycleMs:30000});
  const proof=JSON.parse(readFileSync(result.reportPath!,'utf8'));
  assert.deepEqual(proof.candidateConfiguration.reinvestment,{strength:'balanced',closingTiles:36});
  assert.deepEqual(proof.gates.map((gate:{candidate:string})=>gate.candidate),['math-candidate','learner-candidate','dilute-candidate']);
  assert.ok(proof.games.every((game:{players:{actions:{exceptions:number;invalidBids:number;invalidWords:number}}[]})=>game.players.every(player=>player.actions.exceptions===0&&player.actions.invalidBids===0&&player.actions.invalidWords===0)));
  assert.equal(JSON.parse(readFileSync(join(root,'models','competition-candidate.json'),'utf8')).trainedGames,1);
});
test('resuming an incompatible dictionary checkpoint refuses to relabel learned weights',async()=>{
  const root=workspace(),path=join(root,'models','competition-candidate.json');
  const model=createModel();model.dictionaryHash='b'.repeat(64);saveModel(path,model);
  await assert.rejects(runCompetitionCycle({root,offline:true,trainGames:2,evaluationSeeds:1,skipTuning:true,untilMs:Date.now()+60000}),/dictionary/);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).dictionaryHash,'b'.repeat(64));
});
test('beating another policy cannot replace a stronger untested incumbent',()=>{
  const selection=baselineSelection('a'.repeat(64));selection.math={mode:'approved'};selection.learner={mode:'approved'};
  assert.equal(mayReplaceIncumbent(selection,'learner','math'),false);
  assert.equal(mayReplaceIncumbent(selection,'learner','learner'),true);
  assert.equal(mayReplaceIncumbent(selection,'dilute','math'),true);
});

test('worker admission respects live memory and CPU reserves instead of promising unavailable cores',()=>{
  const plan=competitionWorkerPlan(4,(768+384*3.5)*1048576,16);
  assert.equal(plan.workers,3);assert.equal(plan.reserveMiB,768);assert.equal(plan.memoryLimited,true);
  assert.equal(competitionWorkerPlan(4,700*1048576,16).workers,1);
  assert.equal(competitionWorkerPlan(4,8192*1048576,2).workers,1);
  assert.throws(()=>competitionWorkerPlan(5),/worker admission/);
});

test('independent training branches use reserved seeds and select one frozen branch without summing its counters',async()=>{
  const root=workspace(),result=await runCompetitionCycle({root,offline:true,workers:2,trainingReplicas:2,trainGames:1,tuningSeeds:1,evaluationSeeds:1,skipTuning:true,auctionTypes:['Vickrey'],untilMs:Date.now()+120000,maxCycleMs:120000});
  const directory=dirname(result.reportPath!),training=JSON.parse(readFileSync(join(directory,'training-replicas.json'),'utf8'));
  const model=JSON.parse(readFileSync(join(root,'models','competition-candidate.json'),'utf8'));
  assert.equal(training.completed,true);assert.equal(training.selectionCompleted,true);assert.equal(training.requestedReplicas,2);
  assert.equal(training.totalCompletedGames,2);assert.equal(training.reservedTrainingGames,2);assert.equal(training.replicas.length,2);
  assert.equal(new Set(training.replicas.map((replica:any)=>replica.trainingSeed)).size,2);
  const selected=training.replicas.find((replica:any)=>replica.replicaIndex===training.selectedReplica);
  assert.ok(selected);assert.equal(model.trainedGames,1);
  const selectedModel=JSON.parse(readFileSync(join(root,selected.artifact.path),'utf8'));
  assert.deepEqual(model,selectedModel);
  const development=JSON.parse(readFileSync(join(directory,'training-replica-development.json'),'utf8'));
  assert.equal(development.completed,true);assert.deepEqual(development.auctionTypes,['Vickrey','FirstPrice']);
  const final=JSON.parse(readFileSync(result.reportPath!,'utf8'));
  assert.notEqual(development.seedBlock,final.seedBlock);assert.equal(final.frozen.unchanged,true);
  assert.ok(final.execution.effectiveWorkers>=1&&final.execution.effectiveWorkers<=2);
  const ledger=JSON.parse(readFileSync(join(root,'runs','competition','state.json'),'utf8'));
  assert.equal(ledger.nextTrainingSeed,300000002);assert.equal(ledger.nextTuningSeed,500000007);
});

test('an expired parallel training budget retains the parent checkpoint and cannot promote partial branches',async()=>{
  const root=workspace(),path=join(root,'models','competition-candidate.json'),parent=createModel();
  parent.trainedGames=7;parent.updates=19;saveModel(path,parent);
  const result=await runCompetitionCycle({root,offline:true,workers:2,trainingReplicas:2,trainGames:1,tuningSeeds:1,evaluationSeeds:1,skipTuning:true,auctionTypes:['Vickrey'],untilMs:Date.now()+60000,maxCycleMs:0});
  const kept=JSON.parse(readFileSync(path,'utf8')),training=JSON.parse(readFileSync(join(dirname(result.reportPath!),'training-replicas.json'),'utf8'));
  assert.equal(kept.trainedGames,7);assert.equal(kept.updates,19);
  assert.equal(training.fallbackRetained,true);assert.equal(training.selectionCompleted,false);assert.equal(training.selectedReplica,null);
  assert.deepEqual(result.promoted,[]);assert.equal(JSON.parse(readFileSync(result.reportPath!,'utf8')).completed,false);
});

test('owned identity configuration retains the retired bot and loads a replacement from its runtime file',()=>{
  const root=workspace();assert.deepEqual(loadOwnedBotIds(root),[169]);assert.deepEqual(parseOwnedBotIds(),[169]);
  assert.deepEqual(parseOwnedBotIds({botIds:[99999]}),[169,99999]);
  writeFileSync(join(root,'runs','owned-bot-ids.json'),JSON.stringify({botIds:[99999,169,8]}));
  assert.deepEqual(loadOwnedBotIds(root),[8,169,99999]);
  assert.deepEqual(parseOwnedBotIds({botIds:[]}),[169]);
});

test('owned identity configuration rejects unsafe, duplicate or unbounded IDs rather than fitting with a partial list',()=>{
  const invalid=[null,[],{},{botIds:'169'},{botIds:[0]},{botIds:[-1]},{botIds:[1.5]},{botIds:['169']},{botIds:[Number.MAX_SAFE_INTEGER+1]},{botIds:[169,169]},{botIds:[169],token:'unexpected'}, {botIds:Array.from({length:101},(_,i)=>i+1)}];
  for(const value of invalid)assert.throws(()=>parseOwnedBotIds(value),/owned bot ID/i);
  assert.deepEqual(parseOwnedBotIds({botIds:[Number.MAX_SAFE_INTEGER]}),[169,Number.MAX_SAFE_INTEGER]);
});

test('a strong replacement bot is excluded from public teacher discovery alongside the retired identity',()=>{
  const root=workspace(),replacement=99999;
  writeFileSync(join(root,'runs','owned-bot-ids.json'),JSON.stringify({botIds:[169,replacement]}));
  // Synthetic discovery rankings only; full-history legality has separate tests.
  const games:ArenaCompleteGame[]=Array.from({length:6},(_,index)=>({
    match:{id:index+1,totalAuctions:0,startingRackSize:5,auctionType:'Vickrey',createdAt:1000000,endedAt:2000000},
    participants:[[replacement,100],[169,90],[114,110],[18,30]].map(([botId,score],seat)=>({id:index*10+seat,matchId:index+1,botId:botId!,score:score!,balance:100})),
    auctions:[],results:[],words:[],
  }));
  const names=new Map([[replacement,'Own replacement'],[169,'Own retired'],[114,'Bron'],[18,'LUCENT']]);
  assert.equal(discoverArenaPlayers(games,names).find(player=>player.botId===replacement)?.selected,true);
  const selected=discoverArenaPlayers(games,names,{excludedBotIds:loadOwnedBotIds(root)});
  for(const botId of [169,replacement]){const player=selected.find(row=>row.botId===botId);assert.equal(player?.selected,false);assert.equal(player?.eligible,false);assert.match(player!.reason,/excluded/);}
  assert.equal(selected.find(player=>player.botId===114)?.selected,true);
});

test('malformed owned identity metadata fails before allocating seeds or requesting public games',async()=>{
  const root=workspace(),path=join(root,'runs','owned-bot-ids.json');
  for(const content of ['{"botIds":[0]}','{',' '.repeat(8193)]) {
    writeFileSync(path,content);
    await assert.rejects(runCompetitionCycle({root,untilMs:Date.now()+60000}),/owned bot ID/i);
    assert.equal(existsSync(join(root,'runs','competition','state.json')),false);
  }
});
