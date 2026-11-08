import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runCompetitionCycle,selectionExpiresAt,mayReplaceIncumbent,shouldFocusEndgame,shouldFocusReinvestment,sameEndgameFoundation,sameReinvestmentFoundation,reinvestmentDevelopmentConfigurations } from '../src/competition-loop.js';
import { createModel,saveModel } from '../src/model.js';
import { baselineSelection,publishSelection,artifactReference } from '../src/competition-store.js';
import { EXECUTION_PROTOCOL_VERSION } from '../src/coordinated-policy.js';
import { REINVEST_POLICY_VERSION,normalizedReinvestmentOptions } from '../src/reinvest.js';
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
  await runCompetitionCycle({root,offline:true,trainGames:1,evaluationSeeds:1,skipTuning:true,auctionTypes:['Vickrey'],untilMs,maxCycleMs:30000});
  const selection=JSON.parse(readFileSync(join(root,'models','active-selection.json'),'utf8'));
  assert.ok(Date.parse(selection.expiresAt)>untilMs+25*60000,'the selection must cover a face-off starting 25 minutes after training stops');
  assert.equal(Date.parse(selection.expiresAt),untilMs+90*60000);
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
  assert.equal(development.completed,true);assert.equal(development.completedGames,12);
  assert.deepEqual(development.auctionTypes,['Vickrey','FirstPrice']);
  assert.deepEqual(Object.keys(development.candidateConfigurations),configurations.map(configuration=>configuration.name));
  assert.deepEqual(Object.values(development.candidateConfigurations).map((options:any)=>[options.strength,options.mode]),[['balanced','both'],['aggressive','both'],['balanced','completions'],['balanced','rebuild']]);
  const merit=(name:string)=>development.modes.reduce((sum:number,mode:any)=>sum+(mode.ranking.find((row:any)=>row.name===name)?.winShare??0),0)/development.modes.length;
  const score=(name:string)=>development.modes.reduce((sum:number,mode:any)=>sum+(mode.ranking.find((row:any)=>row.name===name)?.meanScore??0),0)/development.modes.length;
  const chosen=configurations.sort((a,b)=>merit(b.name)-merit(a.name)||score(b.name)-score(a.name))[0]!;
  assert.deepEqual(normalizedReinvestmentOptions(final.candidateConfiguration.reinvestment),normalizedReinvestmentOptions(chosen.options));
  assert.notEqual(development.seedBlock,final.seedBlock);assert.equal(final.gates.length,1);assert.equal(final.gates[0].candidate,'reinvest-candidate');
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
