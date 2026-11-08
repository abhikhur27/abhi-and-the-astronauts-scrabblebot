import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WordEngine } from '../src/engine.js';
import { MathBot as MathV2 } from '../src/math-v2.js';
import { createModel,saveModel,LearningBot } from '../src/model.js';
import { LivePolicyManager } from '../src/live-policy.js';
import type { DecisionContext } from '../src/types.js';
import { baselineSelection,publishSelection,artifactReference } from '../src/competition-store.js';
import { ENDGAME_POLICY_VERSION } from '../src/endgame.js';
import { REINVEST_POLICY_VERSION } from '../src/reinvest.js';
import { EXECUTION_PROTOCOL_VERSION } from '../src/coordinated-policy.js';
const hash='a'.repeat(64), engine=new WordEngine(['AT','ATE','TEA','EAT','QI']);
const ctx:DecisionContext={myRack:new Map([['A',1],['T',1]]),myBalance:100,myScore:0,tilesRemaining:30,letter:'E',auctionType:'Vickrey'};
test('all three live labels use exact V2 actions when no candidate has passed',()=>{
 const root=mkdtempSync(join(tmpdir(),'live-v2-policy-'));
 const manager=new LivePolicyManager({root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const base=new MathV2(engine);
 for(const strategy of ['math','learner','dilute'] as const){const entry=manager.create(strategy,42n);assert.equal(entry.mode,'v2');assert.equal(entry.policy.decideBid(ctx),base.decideBid(ctx));assert.equal(entry.policy.chooseWord(ctx),base.chooseWord(ctx));}
});
test('baseline live episodes train the new critic while preserving the old checkpoint byte-for-byte',()=>{
 const root=mkdtempSync(join(tmpdir(),'live-v2-policy-')),legacyPath=join(root,'models','candidate.json');
 const old=createModel('legacy-mc');old.dictionaryHash=hash;saveModel(legacyPath,old);const before=readFileSync(legacyPath,'utf8');
 const manager=new LivePolicyManager({root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true,initialModelPath:legacyPath});
 const entry=manager.create('learner',43n);entry.policy.decideBid(ctx);entry.policy.chooseWord(ctx);manager.finish(entry.policy,20);
 const path=join(root,'models','live-v2-residual.json');assert.ok(existsSync(path));const model=JSON.parse(readFileSync(path,'utf8'));
 assert.equal(model.schema,'scrabblebot-v2-residual-v1');assert.equal(model.trainedGames,1);assert.ok(model.residual.valueUpdates>0);assert.equal(readFileSync(legacyPath,'utf8'),before);
});
test('manual startup refuses incompatible dictionaries before any live connection',()=>{
 const root=mkdtempSync(join(tmpdir(),'live-v2-policy-')),path=join(root,'models','candidate.json');const model=createModel();model.dictionaryHash='b'.repeat(64);saveModel(path,model);
 assert.throws(()=>new LivePolicyManager({root,engine,dictionaryHash:hash,onlineLearning:false,usesLearner:true,initialModelPath:path}),/dictionary/);
});
test('a stale sidecar cannot authorize unrelated configured weights when the live checkpoint is missing',()=>{
 const root=mkdtempSync(join(tmpdir(),'live-v2-adoption-')),dir=join(root,'models','league');mkdirSync(dir,{recursive:true});
 const approved=createModel();approved.dictionaryHash=hash;approved.trainedGames=80;
 const approvedPath=join(dir,'approved.json');saveModel(approvedPath,approved);
 const proofPath=join(dir,'proof.json');writeFileSync(proofPath,JSON.stringify({schema:'scrabblebot-league-v1',executionProtocol:EXECUTION_PROTOCOL_VERSION,primaryObjective:'win-share',completed:true,frozen:{verified:true,unchanged:true},modes:[{auctionType:'Vickrey',completedSeedBlocks:6},{auctionType:'FirstPrice',completedSeedBlocks:6}],gates:[{candidate:'learner-candidate',eligible:true,primaryObjective:'win-share'}]}));
 const ref=artifactReference(root,approvedPath),selection=baselineSelection(hash);selection.learner={mode:'approved',candidate:'learner-candidate',model:ref,report:artifactReference(root,proofPath)};publishSelection(root,selection);
 writeFileSync(join(root,'models','live-v2-residual-source.json'),JSON.stringify({approvedSha:ref.sha256}));
 const configured=createModel();configured.dictionaryHash=hash;configured.trainedGames=3;const configuredPath=join(root,'models','competition-candidate.json');saveModel(configuredPath,configured);
 const manager=new LivePolicyManager({root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true,initialModelPath:configuredPath});
 assert.equal(manager.create('learner',44n).mode,'approved');
 assert.equal(manager.counters.games,80);
 assert.equal(JSON.parse(readFileSync(join(root,'models','live-v2-residual.json'),'utf8')).trainedGames,80);
});
test('every live label preserves its committed DROWN completion before cashing WORN',()=>{
 const words=new WordEngine(['WORN','DROWN']);
 const manager=new LivePolicyManager({root:mkdtempSync(join(tmpdir(),'live-coordinated-')),engine:words,dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const closing:DecisionContext={myRack:new Map([... 'NORW'].map(c=>[c,1])),myBalance:36,myScore:84,tilesRemaining:9,letter:'D',auctionType:'Vickrey',committedBid:21};
 for(const strategy of ['math','learner','dilute'] as const){const chosen=manager.create(strategy,45n);assert.equal(chosen.policy.chooseWord(closing),null);}
});
test('a gated common endgame foundation protects the lead identically for all three labels',()=>{
 const root=mkdtempSync(join(tmpdir(),'live-endgame-')),dir=join(root,'models','league');mkdirSync(dir,{recursive:true});
 const proof=join(dir,'endgame-proof.json');writeFileSync(proof,JSON.stringify({schema:'scrabblebot-league-v1',executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION,primaryObjective:'win-share',completed:true,frozen:{verified:true,unchanged:true},candidateConfiguration:{endgame:{closingTiles:18}},modes:[{auctionType:'Vickrey',completedSeedBlocks:6},{auctionType:'FirstPrice',completedSeedBlocks:6}],gates:[{candidate:'endgame-candidate',eligible:true,primaryObjective:'win-share'}]}));
 const selection=baselineSelection(hash);selection.endgame={mode:'approved',candidate:'endgame-candidate',report:artifactReference(root,proof),options:{closingTiles:18}};publishSelection(root,selection);
 const manager=new LivePolicyManager({root,engine:new WordEngine(['QUIET','QUIETS']),dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const hand=new Map([... 'QUIET'].map(c=>[c,1])),bag=new Map([['E',1]]);
 const state:DecisionContext={myRack:new Map(),myBalance:80,myScore:110,tilesRemaining:1,letter:'S',auctionType:'Vickrey',opponents:[{botId:'18',balance:30,score:80}],information:{consistent:true,completeHistory:true,knownOwnInitial:true,bagCount:1,observedAuctionCount:67,expectedBag:bag,bagMinimum:bag,bagMaximum:bag,opponents:[{botId:'18',rackSize:5,initialMinimum:new Map(),rackMinimum:hand,rackMaximum:hand,rackMean:hand}],samples:[{weight:1,bag,opponentRacks:new Map([['18',hand]])}],effectiveSampleSize:1,market:{medianPayment:12,p75Payment:16,samples:20}}};
 for(const strategy of ['math','learner','dilute'] as const){const chosen=manager.create(strategy,46n);assert.ok(chosen.endgame);assert.equal(chosen.policy.decideBid(state),80);assert.equal(chosen.endgame.explainEndgameDecision(state).reason,'last-usable-pivotal-denial');}
});

test('a gated common reinvestment foundation protects the lead identically for all three labels',()=>{
 const root=mkdtempSync(join(tmpdir(),'live-reinvest-')),dir=join(root,'models','league');mkdirSync(dir,{recursive:true});
 const proof=join(dir,'reinvest-proof.json');writeFileSync(proof,JSON.stringify({schema:'scrabblebot-league-v1',executionProtocol:EXECUTION_PROTOCOL_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,primaryObjective:'win-share',completed:true,frozen:{verified:true,unchanged:true},candidateConfiguration:{reinvestment:{strength:'balanced',closingTiles:36}},modes:[{auctionType:'Vickrey',completedSeedBlocks:6},{auctionType:'FirstPrice',completedSeedBlocks:6}],gates:[{candidate:'reinvest-candidate',eligible:true,primaryObjective:'win-share'}]}));
 const selection=baselineSelection(hash);selection.reinvestment={mode:'approved',candidate:'reinvest-candidate',report:artifactReference(root,proof),options:{strength:'balanced',closingTiles:36}};publishSelection(root,selection);
 const manager=new LivePolicyManager({root,engine:new WordEngine(['QUIET','QUIETS']),dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const hand=new Map([... 'QUIET'].map(c=>[c,1])),bag=new Map([['E',1]]);
 const state:DecisionContext={myRack:new Map(),myBalance:80,myScore:110,tilesRemaining:1,letter:'S',auctionType:'Vickrey',opponents:[{botId:'18',balance:30,score:80}],information:{consistent:true,completeHistory:true,knownOwnInitial:true,bagCount:1,observedAuctionCount:67,expectedBag:bag,bagMinimum:bag,bagMaximum:bag,opponents:[{botId:'18',rackSize:5,initialMinimum:new Map(),rackMinimum:hand,rackMaximum:hand,rackMean:hand}],samples:[{weight:1,bag,opponentRacks:new Map([['18',hand]])}],effectiveSampleSize:1,market:{medianPayment:12,p75Payment:16,samples:20}}};
 for(const strategy of ['math','learner','dilute'] as const){const chosen=manager.create(strategy,46n);assert.ok(chosen.reinvestment);assert.equal(chosen.policy.decideBid(state),80);assert.equal(chosen.reinvestment.explainReinvestmentDecision(state).reason,'last-usable-proven-denial');}
});

function tournamentFixture() {
 const root=mkdtempSync(join(tmpdir(),'live-tournament-')),dir=join(root,'models','league');mkdirSync(dir,{recursive:true});
 const model=createModel();model.dictionaryHash=hash;model.trainedGames=80;
 const approvedPath=join(dir,'tournament-model.json');saveModel(approvedPath,model);
 const proofPath=join(dir,'tournament-proof.json');
 const proof={schema:'scrabblebot-league-v1',executionProtocol:EXECUTION_PROTOCOL_VERSION,primaryObjective:'win-share',completed:true,baselineName:'frozen-v2',frozen:{verified:true,unchanged:true},modes:['Vickrey','FirstPrice'].map(auctionType=>({auctionType,completedSeedBlocks:12,comparisons:[{candidate:'math-candidate',reference:'frozen-v2',result:{winShareDifferenceLower95OneSided:.02}},{candidate:'learner-candidate',reference:'frozen-v2',result:{winShareDifferenceLower95OneSided:auctionType==='Vickrey'?.07:.04}}]})),gates:['math-candidate','learner-candidate'].map(candidate=>({candidate,eligible:true,primaryObjective:'win-share'}))};
 writeFileSync(proofPath,JSON.stringify(proof));
 const selection=baselineSelection(hash);selection.generation='tournament-tested';selection.math={mode:'approved',candidate:'math-candidate',report:artifactReference(root,proofPath),bidScale:1.05};selection.learner={mode:'approved',candidate:'learner-candidate',report:artifactReference(root,proofPath),model:artifactReference(root,approvedPath)};publishSelection(root,selection);
 return {root,approvedPath,selection};
}
test('tournament chooses the approved strategy with the strongest worst-mode paired lower bound',()=>{
 const f=tournamentFixture(),manager=new LivePolicyManager({root:f.root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const entry=manager.createTournament('2',51n);assert.equal(entry.strategy,'learner');assert.equal(entry.mode,'approved');assert.equal(entry.generation,'tournament-tested');
});
test('tournament snapshots exact approved weights without changing live canary counters or files',()=>{
 const f=tournamentFixture(),manager=new LivePolicyManager({root:f.root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const live=manager.create('learner',52n);assert.ok(live.policy instanceof LearningBot);
 live.policy.decideBid(ctx);live.policy.chooseWord(ctx);manager.finish(live.policy,30);assert.equal(manager.counters.games,81);
 const livePath=join(f.root,'models','live-v2-residual.json'),before=readFileSync(livePath,'utf8'),counters=manager.counters;
 const entry=manager.createTournament('3',53n);assert.ok(entry.policy instanceof LearningBot);assert.equal(entry.policy.model.trainedGames,80);
 entry.policy.decideBid(ctx);entry.policy.chooseWord(ctx);manager.finish(entry.policy,40);
 assert.equal(entry.policy.model.trainedGames,80);assert.deepEqual(manager.counters,counters);assert.equal(readFileSync(livePath,'utf8'),before);
});
test('later tournament rounds use cached strategy and artifact bytes despite pointer and disk changes',()=>{
 const f=tournamentFixture(),manager=new LivePolicyManager({root:f.root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const first=manager.createTournament('4',54n);assert.ok(first.policy instanceof LearningBot);
 first.policy.model.trainedGames=999;writeFileSync(f.approvedPath,'corrupt');publishSelection(f.root,baselineSelection(hash));
 const next=manager.createTournament('4',55n,'math');assert.equal(next.strategy,'learner');assert.equal(next.generation,'tournament-tested');assert.ok(next.policy instanceof LearningBot);assert.equal(next.policy.model.trainedGames,80);
 assert.equal(manager.createTournament('5',56n).strategy,'math');
});
test('unapproved tournament learner override remains frozen V2 and creates no checkpoint',()=>{
 const root=mkdtempSync(join(tmpdir(),'live-tournament-baseline-')),manager=new LivePolicyManager({root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true});
 const entry=manager.createTournament('6',57n,'learner');assert.equal(entry.strategy,'learner');assert.equal(entry.mode,'v2');assert.equal(entry.policy.decideBid(ctx),new MathV2(engine).decideBid(ctx));entry.policy.chooseWord(ctx);manager.finish(entry.policy,20);
 assert.equal(manager.counters.games,0);assert.equal(existsSync(join(root,'models','live-v2-residual.json')),false);
});
