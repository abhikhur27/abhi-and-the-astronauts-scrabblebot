import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactReference } from '../src/competition-store.js';
import { EXECUTION_PROTOCOL_VERSION } from '../src/coordinated-policy.js';
import { REINVEST_POLICY_VERSION } from '../src/reinvest.js';
import { LivePolicyManager } from '../src/live-policy.js';
import { WordEngine } from '../src/engine.js';
import { createModel } from '../src/model.js';
import { loadChampionPin } from '../src/champion-pin.js';
const hash='a'.repeat(64),engine=new WordEngine(['AT','ATE','TEA','EAT']);
function fixture(learner=false){
 const root=mkdtempSync(join(tmpdir(),'champion-pin-')),dir=join(root,'models','league','cycle');mkdirSync(dir,{recursive:true});
 const candidate=learner?'learner-candidate':'reinvest-candidate',foundation={strength:'balanced',closingTiles:36,mode:'both'};
 const model=createModel();model.dictionaryHash=hash;model.trainedGames=12;
 const spec=learner?{type:'learner',model,options:{training:false,epsilon:0,protectedHorizon:36},anchor:{type:'reinvestment',options:foundation,base:{type:'coordinated',base:{type:'v2'}}}}:{type:'reinvestment',options:foundation,base:{type:'coordinated',base:{type:'v2'}}};
 const specPath=join(dir,'champion-spec.json');writeFileSync(specPath,JSON.stringify(spec));
 const actions={invalidBids:0,invalidWords:0,exceptions:0,lateBids:0,lateWords:0};
 const reportPath=join(dir,'league.json');writeFileSync(reportPath,JSON.stringify({schema:'scrabblebot-league-v1',completed:true,primaryObjective:'win-share',executionProtocol:EXECUTION_PROTOCOL_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,candidateConfiguration:{reinvestment:foundation},frozen:{verified:true,unchanged:true},modes:['Vickrey','FirstPrice'].map(auctionType=>({auctionType,completedSeedBlocks:12,ranking:[{name:candidate,actions}]})),gates:[{candidate,eligible:false,reasons:['win-share superiority unproved']}]}));
 const pin={schema:'scrabblebot-champion-pin-v1',dictionaryHash:hash,executionProtocol:EXECUTION_PROTOCOL_VERSION,generation:'manual-frozen-test',strategy:learner?'learner':'math',candidate,reason:'Highest observed win share; superiority remains unproved.',report:artifactReference(root,reportPath),spec:artifactReference(root,specPath)};
 const pinPath=join(root,'models','champion-pin.json');writeFileSync(pinPath,JSON.stringify(pin));return {root,pinPath,pin,specPath,reportPath};
}
test('champion pin accepts honest failed superiority gate but refuses hash corruption before startup',()=>{
 const f=fixture();assert.equal(loadChampionPin(f.root,'models/champion-pin.json',hash).receipt.candidate,'reinvest-candidate');
 writeFileSync(f.specPath,'{}');assert.throws(()=>loadChampionPin(f.root,'models/champion-pin.json',hash),/integrity/);
});
test('all pinned matches retain copied artifact bytes and ignore subsequent selection and artifact changes',()=>{
 const f=fixture();const manager=new LivePolicyManager({root:f.root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true,championPinFile:'models/champion-pin.json'});
 const first=manager.createPinned(1n);assert.ok(first.reinvestment);assert.equal(first.mode,'manual-frozen');
 writeFileSync(f.specPath,'corrupt');writeFileSync(f.reportPath,'corrupt');writeFileSync(f.pinPath,'corrupt');writeFileSync(join(f.root,'models','active-selection.json'),'{}');
 const second=manager.createPinned(2n);assert.equal(second.generation,first.generation);assert.deepEqual(second.championPin,first.championPin);assert.notEqual(second.policy,first.policy);assert.equal(second.reinvestment?.options.closingTiles,36);
});
test('pinned learner inference cannot update live weights or checkpoints even when manager learning is enabled',()=>{
 const f=fixture(true),before=readFileSync(f.specPath,'utf8');const manager=new LivePolicyManager({root:f.root,engine,dictionaryHash:hash,onlineLearning:true,usesLearner:true,championPinFile:'models/champion-pin.json'});
 const entry=manager.createPinned(3n),counters=manager.counters;
 const ctx={myRack:new Map([['A',1],['T',1]]),myBalance:100,myScore:0,tilesRemaining:30,letter:'E',auctionType:'Vickrey' as const};
 entry.policy.decideBid(ctx);entry.policy.chooseWord(ctx);manager.finish(entry.policy,20);
 assert.deepEqual(manager.counters,counters);assert.equal(readFileSync(f.specPath,'utf8'),before);assert.equal(existsSync(join(f.root,'models','live-v2-residual.json')),false);
 assert.equal(entry.learnerSnapshot?.games,12);assert.equal(manager.createPinned(4n).learnerSnapshot?.games,12);
});
test('champion pin rejects wrong dictionaries and illegal completed reports',()=>{
 const f=fixture();assert.throws(()=>loadChampionPin(f.root,'models/champion-pin.json','b'.repeat(64)),/dictionary/);
 const report=JSON.parse(readFileSync(f.reportPath,'utf8'));report.modes[0].ranking[0].actions.invalidWords=1;writeFileSync(f.reportPath,JSON.stringify(report));f.pin.report=artifactReference(f.root,f.reportPath);writeFileSync(f.pinPath,JSON.stringify(f.pin));assert.throws(()=>loadChampionPin(f.root,'models/champion-pin.json',hash),/legal/);
});
test('exact pre-evaluation spec hashes support common-field labels without inventing gate approval',()=>{
 const f=fixture(),report=JSON.parse(readFileSync(f.reportPath,'utf8'));f.pin.candidate='common-field-reinvest';report.candidateSpecsSha256={[f.pin.candidate]:f.pin.spec.sha256};
 for(const mode of report.modes)mode.ranking[0].name=f.pin.candidate;delete report.candidateConfiguration;
 writeFileSync(f.reportPath,JSON.stringify(report));f.pin.report=artifactReference(f.root,f.reportPath);writeFileSync(f.pinPath,JSON.stringify(f.pin));
 const loaded=loadChampionPin(f.root,'models/champion-pin.json',hash);assert.equal(loaded.receipt.automaticGateEligible,false);
 report.candidateSpecsSha256[f.pin.candidate]='b'.repeat(64);writeFileSync(f.reportPath,JSON.stringify(report));f.pin.report=artifactReference(f.root,f.reportPath);writeFileSync(f.pinPath,JSON.stringify(f.pin));assert.throws(()=>loadChampionPin(f.root,'models/champion-pin.json',hash),/Unsupported/);
});
test('learner champion refuses exploration even if the hashed source requests it',()=>{
 const f=fixture(true),spec=JSON.parse(readFileSync(f.specPath,'utf8'));spec.options.epsilon=.02;writeFileSync(f.specPath,JSON.stringify(spec));f.pin.spec=artifactReference(f.root,f.specPath);writeFileSync(f.pinPath,JSON.stringify(f.pin));assert.throws(()=>loadChampionPin(f.root,'models/champion-pin.json',hash),/frozen learner/);
});
test('malformed frozen learner weights fail at manager construction before a match',()=>{
 const f=fixture(true),spec=JSON.parse(readFileSync(f.specPath,'utf8'));spec.model.schema='unknown';writeFileSync(f.specPath,JSON.stringify(spec));f.pin.spec=artifactReference(f.root,f.specPath);writeFileSync(f.pinPath,JSON.stringify(f.pin));
 assert.throws(()=>new LivePolicyManager({root:f.root,engine,dictionaryHash:hash,onlineLearning:false,usesLearner:true,championPinFile:'models/champion-pin.json'}),/model|schema|checkpoint/i);
});
