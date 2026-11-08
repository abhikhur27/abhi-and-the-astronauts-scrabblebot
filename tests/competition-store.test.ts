import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineSelection, loadSelection, publishSelection, artifactReference } from '../src/competition-store.js';
import { EXECUTION_PROTOCOL_VERSION } from '../src/coordinated-policy.js';
import { ENDGAME_POLICY_VERSION } from '../src/endgame.js';
import { REINVEST_POLICY_VERSION } from '../src/reinvest.js';

const hash = 'a'.repeat(64), now = Date.parse('2026-11-07T22:20:00Z');
function workspace() { const root=mkdtempSync(join(tmpdir(),'auction-selection-')); mkdirSync(join(root,'models','league'),{recursive:true}); return root; }
function report(root:string, eligible=true, extra:Record<string,unknown>={}) {
  const path=join(root,'models','league','report.json');
  writeFileSync(path,JSON.stringify({schema:'scrabblebot-league-v1',completed:true,executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,primaryObjective:'win-share',frozen:{verified:true,unchanged:true},modes:[{auctionType:'Vickrey',completedSeedBlocks:6},{auctionType:'FirstPrice',completedSeedBlocks:6}],gates:[{candidate:'math-candidate',eligible,primaryObjective:'win-share'}],...extra}));
  return artifactReference(root,path);
}
test('missing, stale or wrong-dictionary selections leave live actions on V2',()=>{
  const root=workspace();
  assert.equal(loadSelection(root,hash,now).selection.math.mode,'v2');
  const selection=baselineSelection(hash,now-2000,now-1000);
  writeFileSync(join(root,'models','active-selection.json'),JSON.stringify(selection));
  assert.equal(loadSelection(root,hash,now).selection.math.mode,'v2');
  assert.match(loadSelection(root,hash,now).reason!,/expired/);
  selection.expiresAt=new Date(now+10000).toISOString();
  writeFileSync(join(root,'models','active-selection.json'),JSON.stringify(selection));
  assert.match(loadSelection(root,'b'.repeat(64),now).reason!,/dictionary/);
});
test('only a completed frozen passing gate can activate a candidate',()=>{
  const root=workspace(), selection=baselineSelection(hash,now,now+60000);
  selection.math={mode:'approved',candidate:'math-candidate',report:report(root,false),bidScale:1.05};
  assert.throws(()=>publishSelection(root,selection,now),/gate/);
  selection.math.report=report(root,true);
  publishSelection(root,selection,now);
  assert.equal(loadSelection(root,hash,now).selection.math.bidScale,1.05);
});
test('corrupt approved artifacts and escaping paths fail closed before loading models',()=>{
  const root=workspace(), selection=baselineSelection(hash,now,now+60000);
  const model=join(root,'models','league','model.json');writeFileSync(model,'{}');
  selection.learner={mode:'approved',candidate:'learner-candidate',report:report(root,true),model:artifactReference(root,model)};
  // This report has no learner gate, so it cannot authorize a model.
  assert.throws(()=>publishSelection(root,selection,now),/gate/);
  selection.math={mode:'approved',candidate:'math-candidate',report:report(root,true),bidScale:1.05};
  selection.learner={mode:'v2'}; publishSelection(root,selection,now);
  writeFileSync(join(root,'models','league','report.json'),'{}');
  assert.equal(loadSelection(root,hash,now).selection.math.mode,'v2');
  selection.math.report={path:'../secrets/token.txt',sha256:'a'.repeat(64)};
  assert.throws(()=>publishSelection(root,selection,now),/path/);
});
test('publishing preserves the previous selection and an acquired snapshot stays unchanged',()=>{
  const root=workspace(), first=baselineSelection(hash,now,now+60000);
  first.generation='first';publishSelection(root,first,now);
  const snapshot=loadSelection(root,hash,now).selection;
  const second=baselineSelection(hash,now,now+60000);second.generation='second';publishSelection(root,second,now);
  assert.equal(snapshot.generation,'first');
  assert.equal(JSON.parse(readFileSync(join(root,'models','active-selection.previous.json'),'utf8')).generation,'first');
  assert.equal(loadSelection(root,hash,now).selection.generation,'second');
});
test('a single-mode win cannot authorize a globally active strategy',()=>{
  const root=workspace(),selection=baselineSelection(hash,now,now+60000),ref=report(root,true);
  const path=join(root,ref.path),proof=JSON.parse(readFileSync(path,'utf8'));proof.modes=proof.modes.slice(0,1);writeFileSync(path,JSON.stringify(proof));
  selection.math={mode:'approved',candidate:'math-candidate',report:artifactReference(root,path),bidScale:1.05};
  assert.throws(()=>publishSelection(root,selection,now),/mode/);
});
test('legacy all-V2 pointers load, but approved gates require matching execution and win objective',()=>{
  const root=workspace(),selection=baselineSelection(hash,now,now+60000);
  delete selection.executionProtocol;
  publishSelection(root,selection,now);
  assert.equal(loadSelection(root,hash,now).selection.math.mode,'v2');
  selection.math={mode:'approved',candidate:'math-candidate',report:report(root,true),bidScale:1};
  assert.throws(()=>publishSelection(root,selection,now),/protocol/);
  selection.executionProtocol=EXECUTION_PROTOCOL_VERSION;
  selection.math.report=report(root,true,{executionProtocol:'words-before-bids'});
  assert.throws(()=>publishSelection(root,selection,now),/protocol/);
  selection.math.report=report(root,true,{primaryObjective:'score'});
  assert.throws(()=>publishSelection(root,selection,now),/win-share/);
});
test('a shared endgame foundation is bound to frozen winning evidence and exact bounded options',()=>{
  const root=workspace(),selection=baselineSelection(hash,now,now+60000);
  const proof=()=>report(root,true,{candidateConfiguration:{endgame:{closingTiles:18}},gates:[{candidate:'endgame-candidate',eligible:true,primaryObjective:'win-share'}]});
  selection.endgame={mode:'approved',candidate:'endgame-candidate',report:proof(),options:{closingTiles:18}};
  publishSelection(root,selection,now);
  assert.equal(loadSelection(root,hash,now).selection.endgame?.options.closingTiles,18);
  selection.endgame.options={closingTiles:30};
  assert.throws(()=>publishSelection(root,selection,now),/evaluated/);
  selection.endgame.options={closingTiles:31};
  assert.throws(()=>publishSelection(root,selection,now),/options/);
  selection.endgame.options={closingTiles:18};
  selection.endgame.report=report(root,false,{candidateConfiguration:{endgame:{closingTiles:18}},gates:[{candidate:'endgame-candidate',eligible:false,primaryObjective:'win-share'}]});
  assert.throws(()=>publishSelection(root,selection,now),/gate/);
  selection.endgame.report=report(root,true,{endgameRevision:'obsolete-controller',candidateConfiguration:{endgame:{closingTiles:18}},gates:[{candidate:'endgame-candidate',eligible:true,primaryObjective:'win-share'}]});
  assert.throws(()=>publishSelection(root,selection,now),/revision/);
});
test('profile promotion cannot silently combine a variant with a different endgame foundation',()=>{
  const root=workspace(),selection=baselineSelection(hash,now,now+60000);
  const foundationPath=join(root,'models','league','foundation.json');
  const foundationRef=report(root,true,{candidateConfiguration:{endgame:{closingTiles:18}},gates:[{candidate:'endgame-candidate',eligible:true,primaryObjective:'win-share'}]});
  writeFileSync(foundationPath,readFileSync(join(root,foundationRef.path)));
  selection.endgame={mode:'approved',candidate:'endgame-candidate',report:artifactReference(root,foundationPath),options:{closingTiles:18}};
  selection.math={mode:'approved',candidate:'math-candidate',report:report(root,true),bidScale:1};
  assert.throws(()=>publishSelection(root,selection,now),/foundation/);
  selection.math.report=report(root,true,{candidateConfiguration:{endgame:{closingTiles:18}}});
  publishSelection(root,selection,now);
  assert.equal(loadSelection(root,hash,now).selection.math.mode,'approved');
});
test('reinvestment foundation requires current source version and exact bounded options',()=>{
  const root=workspace(),selection=baselineSelection(hash,now,now+60000);
  const proof=(extra:Record<string,unknown>={})=>report(root,true,{candidateConfiguration:{reinvestment:{strength:'balanced',closingTiles:36}},gates:[{candidate:'reinvest-candidate',eligible:true,primaryObjective:'win-share'}],...extra});
  selection.reinvestment={mode:'approved',candidate:'reinvest-candidate',report:proof(),options:{strength:'balanced',closingTiles:36}};
  publishSelection(root,selection,now);
  assert.equal(loadSelection(root,hash,now).selection.reinvestment?.options.strength,'balanced');
  selection.reinvestment.options={strength:'aggressive',closingTiles:36};
  assert.throws(()=>publishSelection(root,selection,now),/evaluated/);
  selection.reinvestment.options={strength:'balanced',mode:'completions',closingTiles:36};
  assert.throws(()=>publishSelection(root,selection,now),/evaluated/);
  selection.reinvestment.options={strength:'balanced',closingTiles:69};
  assert.throws(()=>publishSelection(root,selection,now),/options/);
  selection.reinvestment.options={strength:'balanced',closingTiles:36};
  selection.reinvestment.report=proof({reinvestmentRevision:'obsolete-source'});
  assert.throws(()=>publishSelection(root,selection,now),/revision/);
});
test('endgame and reinvestment foundations cannot be combined in pointers or proof',()=>{
  const root=workspace(),selection=baselineSelection(hash,now,now+60000);
  const proof=report(root,true,{candidateConfiguration:{reinvestment:{strength:'balanced',closingTiles:36}},gates:[{candidate:'reinvest-candidate',eligible:true,primaryObjective:'win-share'}]});
  selection.reinvestment={mode:'approved',candidate:'reinvest-candidate',report:proof,options:{strength:'balanced',closingTiles:36}};
  selection.endgame={mode:'approved',candidate:'endgame-candidate',report:proof,options:{closingTiles:18}};
  assert.throws(()=>publishSelection(root,selection,now),/mutually exclusive/);
  delete selection.endgame;
  selection.reinvestment.report=report(root,true,{candidateConfiguration:{endgame:{closingTiles:18},reinvestment:{strength:'balanced',closingTiles:36}},gates:[{candidate:'reinvest-candidate',eligible:true,primaryObjective:'win-share'}]});
  assert.throws(()=>publishSelection(root,selection,now),/mutually exclusive/);
});
test('profile gates must match the selected reinvestment foundation',()=>{
  const root=workspace(),selection=baselineSelection(hash,now,now+60000);
  const foundationPath=join(root,'models','league','reinvestment-foundation.json');
  const foundationRef=report(root,true,{candidateConfiguration:{reinvestment:{strength:'balanced',closingTiles:36}},gates:[{candidate:'reinvest-candidate',eligible:true,primaryObjective:'win-share'}]});
  writeFileSync(foundationPath,readFileSync(join(root,foundationRef.path)));
  selection.reinvestment={mode:'approved',candidate:'reinvest-candidate',report:artifactReference(root,foundationPath),options:{strength:'balanced',closingTiles:36}};
  selection.math={mode:'approved',candidate:'math-candidate',report:report(root,true),bidScale:1};
  assert.throws(()=>publishSelection(root,selection,now),/foundation/);
  selection.math.report=report(root,true,{candidateConfiguration:{reinvestment:{strength:'aggressive',closingTiles:36}}});
  assert.throws(()=>publishSelection(root,selection,now),/foundation/);
  selection.math.report=report(root,true,{candidateConfiguration:{reinvestment:{strength:'balanced',mode:'rebuild',closingTiles:36}}});
  assert.throws(()=>publishSelection(root,selection,now),/foundation/);
  selection.math.report=report(root,true,{candidateConfiguration:{reinvestment:{strength:'balanced',closingTiles:36}}});
  publishSelection(root,selection,now);
  assert.equal(loadSelection(root,hash,now).selection.math.mode,'approved');
});
