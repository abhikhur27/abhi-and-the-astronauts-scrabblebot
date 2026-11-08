import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WordEngine } from './engine.js';
import { MathBot, MATH_POLICY_VERSION } from './math.js';
import { MathBot as MathV2 } from './math-v2.js';
import { LearningBot, createModel, loadModel, saveModel, type LearnedModel, type LearningOptions } from './model.js';
import { DiluteBot } from './dilute.js';
import { fitDiluteResidualProfile, validateDiluteResidualProfile, type DiluteResidualProfile } from './dilute-profile.js';
import { refreshArenaData, type ArenaRefreshResult } from './arena-data.js';
import { evaluateLeague, type LeagueEntry, type LeagueReport } from './league.js';
import { simulateMatch } from './simulator.js';
import { atomicWriteJson } from './atomic-json.js';
import { initialCompetitionState, reserveCycleSeeds, type CompetitionState } from './competition-state.js';
import { baselineSelection, loadSelection, publishSelection, artifactReference, loadArtifact, normalizedEndgameOptions, type CompetitionSelection, type StrategySelection } from './competition-store.js';
import { CoordinatedBot, EXECUTION_PROTOCOL_VERSION } from './coordinated-policy.js';
import { EndgameBot, ENDGAME_POLICY_VERSION, type EndgameOptions } from './endgame.js';
import { ReinvestmentBot, REINVEST_POLICY_VERSION, normalizedReinvestmentOptions, type ReinvestmentOptions } from './reinvest.js';
import type { AuctionType, BotPolicy } from './types.js';

export interface CompetitionCycleOptions {
  root:string; untilMs:number; offline?:boolean; trainGames?:number; evaluationSeeds?:number;
  tuningSeeds?:number; skipTuning?:boolean; maxCycleMs?:number; auctionTypes?:AuctionType[];
  /** Bounded manual cycles may prioritize the shared foundation immediately. */
  focusEndgame?:boolean;
  focusReinvestment?:boolean;
}
export interface CompetitionCycleResult {status:'stopped'|'complete';cycle?:number;evaluationSeed?:number;trainedGames?:number;promoted?:string[];reportPath?:string;}
const read=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const wait=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
const yieldTurn=()=>new Promise<void>(done=>setImmediate(done));
const rankMean=(report:LeagueReport,name:string)=>report.modes.reduce((n,m)=>n+(m.ranking.find(r=>r.name===name)?.meanScore??0),0)/Math.max(1,report.modes.length);
const rankWins=(report:LeagueReport,name:string)=>report.modes.reduce((n,m)=>n+(m.ranking.find(r=>r.name===name)?.winShare??0),0)/Math.max(1,report.modes.length);
const better=(report:LeagueReport,left:string,right:string)=>rankWins(report,left)-rankWins(report,right)||rankMean(report,left)-rankMean(report,right);
/** Cover the event after training freezes without extending public-data freshness. */
export function selectionExpiresAt(trainingUntilMs:number,sourceFreshUntilMs=Infinity):number {return Math.min(trainingUntilMs+90*60000,sourceFreshUntilMs);}
export function mayReplaceIncumbent(selection:CompetitionSelection,key:'math'|'learner'|'dilute',reference?:'math'|'learner'|'dilute'):boolean { return selection[key].mode==='v2'||key===reference; }
export function sameEndgameFoundation(left?:EndgameOptions,right?:EndgameOptions):boolean{return !left&&!right||!!left&&!!right&&JSON.stringify(normalizedEndgameOptions(left))===JSON.stringify(normalizedEndgameOptions(right));}
export function sameReinvestmentFoundation(left?:ReinvestmentOptions,right?:ReinvestmentOptions):boolean{return !left&&!right||!!left&&!!right&&JSON.stringify(normalizedReinvestmentOptions(left))===JSON.stringify(normalizedReinvestmentOptions(right));}
export function shouldFocusEndgame(_cycle:number,selection:CompetitionSelection,forced?:boolean):boolean{return !selection.endgame&&!selection.reinvestment&&forced===true;}
export function shouldFocusReinvestment(cycle:number,selection:CompetitionSelection,forced?:boolean):boolean{return !selection.endgame&&!selection.reinvestment&&(forced??cycle%2===1);}
export function reinvestmentDevelopmentConfigurations():{name:string;options:ReinvestmentOptions}[]{
  return [
    {name:'reinvestment-balanced-both',options:{strength:'balanced',mode:'both',closingTiles:36}},
    {name:'reinvestment-aggressive-both',options:{strength:'aggressive',mode:'both',closingTiles:36}},
    {name:'reinvestment-balanced-completions',options:{strength:'balanced',mode:'completions',closingTiles:36}},
    {name:'reinvestment-balanced-rebuild',options:{strength:'balanced',mode:'rebuild',closingTiles:36}},
  ];
}

export async function runCompetitionCycle(options:CompetitionCycleOptions):Promise<CompetitionCycleResult> {
  const root=resolve(options.root), stopPath=join(root,'runs','STOP'), stopped=()=>existsSync(stopPath);
  if(stopped()||Date.now()>=options.untilMs)return {status:'stopped'};
  if(options.focusEndgame&&options.focusReinvestment)throw new Error('Choose one common foundation focus');
  const trainGames=options.trainGames??40, evaluationSeeds=options.evaluationSeeds??6,tuningSeeds=options.tuningSeeds??2;
  if(![trainGames,evaluationSeeds,tuningSeeds].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1000))throw new Error('Invalid competition batch size');
  const runDir=join(root,'runs','competition'),modelPath=join(root,'models','competition-candidate.json');mkdirSync(runDir,{recursive:true});
  const statePath=join(runDir,'state.json');
  const state=existsSync(statePath)?read<CompetitionState>(statePath):initialCompetitionState();
  const seeds=reserveCycleSeeds(state,trainGames,tuningSeeds,evaluationSeeds);
  // Reserve first: interruption may discard a range but never reuses validation seeds.
  atomicWriteJson(statePath,seeds.next);
  const cycle=seeds.next.cycle, id=`cycle-${cycle}-${randomUUID()}`, artifactDir=join(root,'models','league',id);mkdirSync(artifactDir,{recursive:true});
  const started=Date.now(), deadline=Math.min(started+(options.maxCycleMs??12*60000),options.untilMs+8*60000);
  const progress:Record<string,unknown>={schema:'scrabblebot-competition-progress-v1',cycle,id,pid:process.pid,cwd:root,policyRevision:MATH_POLICY_VERSION,executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,primaryObjective:'win-share',startedAt:new Date(started).toISOString(),until:new Date(options.untilMs).toISOString(),phase:'initializing',trainingSeed:seeds.training,tuningSeed:seeds.tuning,evaluationSeed:seeds.evaluation};
  const saveProgress=()=>atomicWriteJson(join(runDir,'progress.json'),{...progress,updatedAt:new Date().toISOString()});
  const phase=(value:string,fields:Record<string,unknown>={})=>{Object.assign(progress,fields,{phase:value});saveProgress();console.log(JSON.stringify({at:new Date().toISOString(),event:value,cycle,...fields}));};
  const abort=new AbortController();
  const heartbeat=setInterval(()=>{if(stopped()||Date.now()>=deadline)abort.abort();saveProgress();},5000);
  try {
    const dictionary=readFileSync(join(root,'data','enable1.txt')),dictionaryHash=digest(dictionary),engine=new WordEngine(dictionary.toString('utf8').split(/\r?\n/));
    let model:LearnedModel=existsSync(modelPath)?loadModel(modelPath,'v2-residual'):createModel();
    if(model.dictionaryHash&&model.dictionaryHash!==dictionaryHash)throw new Error('Competition checkpoint dictionary mismatch');
    model.dictionaryHash=dictionaryHash;
    let active=loadSelection(root,dictionaryHash).selection;
    const evaluatedFoundation=active.endgame?.options,evaluatedReinvestment=active.reinvestment?.options,focusEndgame=shouldFocusEndgame(cycle,active,options.focusEndgame),focusReinvestment=!focusEndgame&&shouldFocusReinvestment(cycle,active,options.focusReinvestment),focusFoundation=focusEndgame||focusReinvestment;
    let candidateEndgame:EndgameOptions={closingTiles:18};
    let candidateReinvestment:ReinvestmentOptions={strength:'balanced',mode:'both',closingTiles:36};
    if(!existsSync(join(root,'models','active-selection.json')))publishSelection(root,baselineSelection(dictionaryHash,Date.now(),selectionExpiresAt(options.untilMs)));
    let arena:ArenaRefreshResult|undefined, dataError:string|undefined;
    if(!options.offline&&!stopped()) {
      phase('refreshing-public-games');
      try {
        arena=await refreshArenaData(join(runDir,'arena'),{maxMatches:120,minTeacherMatches:6,maxTeachers:8,excludedBotIds:[169],dictionaryPath:join(root,'data','enable1.txt'),requestTimeoutMs:8000,minRefreshIntervalMs:10*60000,staleAfterMs:60*60000,
          fetchImpl:(input,init)=>fetch(input,{...init,signal:AbortSignal.any([abort.signal,...(init?.signal?[init.signal]:[])])})});
      }catch(error){dataError=error instanceof Error?error.message:'Public refresh failed';}
    }
    const fresh=!!arena&&!arena.metadata.stale&&arena.profile.dictionarySha256===dictionaryHash&&Date.now()<Date.parse(arena.profile.staleAfter);
    phase('fitting-public-profiles',{publicData:fresh?'fresh':arena?'stale':'unavailable',dataError,cutoffMatchId:arena?.metadata.cutoffMatchId,teachers:arena?.discovery.filter(p=>p.selected).map(p=>({id:p.botId,name:p.name,matches:p.matches,wins:p.wins}))??[]});
    let diluteProfile:DiluteResidualProfile|undefined,diluteSource:{kind:'merged'|'teacher';name:string;botId?:number}={kind:'merged',name:'merged-public-teachers'};
    const teacherProfiles:{botId:number;name:string;profile?:DiluteResidualProfile}[]=[];
    if(fresh&&arena) {
      diluteProfile=fitDiluteResidualProfile(arena.teacherRows,engine,{dictionaryHash,generatedAt:arena.metadata.generatedAt,cutoffMatchId:arena.metadata.cutoffMatchId});
      atomicWriteJson(join(artifactDir,'dilute-merged.json'),diluteProfile);
      atomicWriteJson(join(artifactDir,'dilute.json'),diluteProfile);
      for(const player of arena.discovery.filter(p=>p.selected).slice(0,4)) {
        const profile=fitDiluteResidualProfile(arena.teacherRows,engine,{dictionaryHash,generatedAt:arena.metadata.generatedAt,cutoffMatchId:arena.metadata.cutoffMatchId,teacherIds:[player.botId]});
        atomicWriteJson(join(artifactDir,`teacher-${player.botId}.json`),profile);
        teacherProfiles.push({botId:player.botId,name:player.name,profile:validateDiluteResidualProfile(profile,dictionaryHash)??undefined});
      }
    }
    const fixed=(core:BotPolicy,foundation:{endgame?:EndgameOptions;reinvestment?:ReinvestmentOptions}={endgame:evaluatedFoundation,reinvestment:evaluatedReinvestment}):BotPolicy=>{
      const coordinated=new CoordinatedBot(engine,core);
      if(foundation.endgame&&foundation.reinvestment)throw new Error('Common foundations are mutually exclusive');
      return foundation.reinvestment?new ReinvestmentBot(engine,coordinated,foundation.reinvestment):foundation.endgame?new EndgameBot(engine,coordinated,foundation.endgame):coordinated;
    };
    // Anchor before actor selection so a learner records the action it actually took.
    const learner=(weights:LearnedModel,learning:LearningOptions={}):LearningBot=>new LearningBot(engine,weights,{...learning,anchorPolicy:fixed(new MathV2(engine)),protectedHorizon:evaluatedReinvestment?normalizedReinvestmentOptions(evaluatedReinvestment).closingTiles:evaluatedFoundation?.closingTiles??2});
    const teacher=(index:number):BotPolicy=>fixed(new DiluteBot(engine,{dictionaryHash,profile:teacherProfiles[index]?.profile}));
    let bidScale=1,holdThreshold=.98;
    const selectedPolicy=(entry:StrategySelection,kind:'math'|'learner'|'dilute'):BotPolicy=>{
      if(entry.mode!=='approved')return fixed(new MathV2(engine));
      if(kind==='math')return fixed(new MathBot(engine,{bidScale:entry.bidScale,holdThreshold:entry.holdThreshold}));
      if(kind==='learner'&&entry.model)return learner(loadModel(resolve(root,entry.model.path),'v2-residual'));
      if(kind==='dilute'&&entry.profile)return fixed(new DiluteBot(engine,{dictionaryHash,profile:loadArtifact(root,entry.profile)}));
      return fixed(new MathV2(engine));
    };
    const leagueOptions=(entries:LeagueEntry[],seedBlock:number,seedCount:number,final=false)=>({engine,entries,seedBlock,seedCount,baselineName:'frozen-v2',championName:'frozen-v2',primaryObjective:'win-share' as const,candidateNames:entries.map(e=>e.name).filter(n=>n.includes('candidate')),auctionTypes:final?(options.auctionTypes??['Vickrey','FirstPrice'] as AuctionType[]):[options.auctionTypes?.[0]??'Vickrey'] as AuctionType[],beliefParticles:16,decisionBudgetMs:200,maxDurationMs:Math.max(1,deadline-Date.now()),shouldStop:()=>stopped()||Date.now()>=deadline,snapshots:{model:()=>model,profile:()=>diluteProfile??null,teachers:()=>teacherProfiles,endgame:()=>evaluatedFoundation??null,reinvestment:()=>evaluatedReinvestment??null,candidateFoundation:()=>focusReinvestment?candidateReinvestment:focusEndgame?candidateEndgame:null},arenaProfile:arena?.profile});
    if(!focusFoundation&&!options.skipTuning&&!stopped()&&Date.now()+3*60000<Math.min(deadline,options.untilMs)) {
      phase('tuning-math-on-development-seeds');
      const entries:LeagueEntry[]=[...[.95,1,1.05].map(scale=>({name:`math-scale-${scale}`,create:()=>fixed(new MathBot(engine,{bidScale:scale}))})),{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},{name:'teacher-surrogate-a',create:()=>teacher(0)},{name:'teacher-surrogate-b',create:()=>teacher(1)}];
      const tuning=await evaluateLeague(leagueOptions(entries,seeds.tuning,tuningSeeds));Object.assign(tuning,{executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION});atomicWriteJson(join(artifactDir,'math-development.json'),tuning);
      if(tuning.completed)bidScale=[.95,1,1.05].sort((a,b)=>better(tuning,`math-scale-${b}`,`math-scale-${a}`))[0]!;
    }
    if(!focusFoundation&&!options.skipTuning&&!stopped()&&Date.now()+3*60000<Math.min(deadline,options.untilMs)) {
      phase('tuning-word-patience-on-development-seeds');
      const entries:LeagueEntry[]=[...[.98,1.01,1.04].map(threshold=>({name:`math-hold-${threshold}`,create:()=>fixed(new MathBot(engine,{bidScale,holdThreshold:threshold}))})),{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},{name:'teacher-surrogate-a',create:()=>teacher(0)},{name:'teacher-surrogate-b',create:()=>teacher(1)}];
      const tuning=await evaluateLeague(leagueOptions(entries,seeds.tuning+tuningSeeds,tuningSeeds));Object.assign(tuning,{executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION});atomicWriteJson(join(artifactDir,'word-development.json'),tuning);
      if(tuning.completed)holdThreshold=[.98,1.01,1.04].sort((a,b)=>better(tuning,`math-hold-${b}`,`math-hold-${a}`))[0]!;
    }
    const livePath=join(root,'models','live-v2-residual.json'),seenPath=join(runDir,'live-source.json');
    if(!focusFoundation&&!options.skipTuning&&existsSync(livePath)&&!stopped()&&Date.now()+3*60000<Math.min(deadline,options.untilMs)) {
      try {
        const bytes=readFileSync(livePath),hash=digest(bytes),seen=existsSync(seenPath)?read<{hash:string}>(seenPath).hash:undefined;
        if(hash!==seen) {
          const copyPath=join(artifactDir,'live-warmstart.json');atomicWriteJson(copyPath,JSON.parse(bytes.toString('utf8')));
          const live=loadModel(copyPath,'v2-residual');if(live.dictionaryHash!==dictionaryHash)throw new Error('Live checkpoint dictionary mismatch');
          phase('comparing-live-warmstart-on-development-seeds');
          const entries:LeagueEntry[]=[{name:'offline-candidate',create:()=>learner(model)},{name:'live-candidate',create:()=>learner(live)},{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},{name:'math-candidate',create:()=>fixed(new MathBot(engine,{bidScale}))},{name:'teacher-surrogate-a',create:()=>teacher(0)},{name:'teacher-surrogate-b',create:()=>teacher(1)}];
          const comparisonOptions=leagueOptions(entries,seeds.tuning+2*tuningSeeds,tuningSeeds);
          const comparison=await evaluateLeague({...comparisonOptions,snapshots:{...comparisonOptions.snapshots,offline:()=>model,live:()=>live}});Object.assign(comparison,{executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION});atomicWriteJson(join(artifactDir,'warmstart-development.json'),comparison);
          const chosen=comparison.completed&&better(comparison,'live-candidate','offline-candidate')>0;if(chosen)model=live;
          atomicWriteJson(seenPath,{hash,chosen,cycle,liveGames:live.trainedGames,liveUpdates:live.updates});
        }
      }catch(error){progress.liveWarmstartError=error instanceof Error?error.message:'Live checkpoint unavailable';}
    }
    if(!focusFoundation&&fresh&&arena&&diluteProfile&&!options.skipTuning&&!stopped()&&Date.now()+3*60000<Math.min(deadline,options.untilMs)) {
      phase('selecting-dilute-source-on-development-seeds');
      const choices=[{name:'dilute-merged',profile:validateDiluteResidualProfile(diluteProfile,dictionaryHash)??undefined,source:{kind:'merged' as const,name:'merged-public-teachers'}},...[0,1,2].map(index=>({name:`dilute-teacher-${index}`,profile:teacherProfiles[index]?.profile,source:{kind:'teacher' as const,name:teacherProfiles[index]?.name??'unavailable',botId:teacherProfiles[index]?.botId}}))];
      const entries:LeagueEntry[]=[...choices.map(choice=>({name:choice.name,create:()=>fixed(new DiluteBot(engine,{dictionaryHash,profile:choice.profile}))})),{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},{name:'teacher-reference',create:()=>teacher(3)}];
      const tuning=await evaluateLeague({...leagueOptions(entries,seeds.tuning+3*tuningSeeds,tuningSeeds,true),auctionTypes:['Vickrey','FirstPrice']});
      const ordered=choices.filter(choice=>choice.profile).sort((a,b)=>better(tuning,b.name,a.name)),chosen=tuning.completed?ordered[0]:undefined;
      if(chosen){diluteProfile=chosen.profile;diluteSource=chosen.source;atomicWriteJson(join(artifactDir,'dilute.json'),diluteProfile);}
      Object.assign(tuning,{executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,candidateConfigurations:Object.fromEntries(choices.map(choice=>[choice.name,{source:choice.source,usable:!!choice.profile}])),selectedSource:chosen?.source??null});
      atomicWriteJson(join(artifactDir,'dilute-development.json'),tuning);
    }
    if(focusEndgame&&!options.skipTuning&&!stopped()&&Date.now()+3*60000<Math.min(deadline,options.untilMs)) {
      phase('tuning-endgame-on-development-seeds');
      const entries:LeagueEntry[]=[...[18,30].map(closingTiles=>({name:`endgame-${closingTiles}`,create:()=>fixed(new MathV2(engine),{endgame:{closingTiles}})})),{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},{name:'teacher-surrogate-a',create:()=>teacher(0)},{name:'teacher-surrogate-b',create:()=>teacher(1)},{name:'teacher-surrogate-c',create:()=>teacher(2)}];
      // A global foundation must be selected using both payment modes.
      const tuning=await evaluateLeague(leagueOptions(entries,seeds.tuning+3*tuningSeeds,tuningSeeds,true));
      Object.assign(tuning,{executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION});atomicWriteJson(join(artifactDir,'endgame-development.json'),tuning);
      if(tuning.completed)candidateEndgame={closingTiles:[18,30].sort((a,b)=>better(tuning,`endgame-${b}`,`endgame-${a}`))[0]!};
    }
    if(focusReinvestment&&!options.skipTuning&&!stopped()&&Date.now()+3*60000<Math.min(deadline,options.untilMs)) {
      phase('tuning-reinvestment-on-development-seeds');
      const configurations=reinvestmentDevelopmentConfigurations();
      const entries:LeagueEntry[]=[...configurations.map(configuration=>({name:configuration.name,create:()=>fixed(new MathV2(engine),{reinvestment:configuration.options})})),{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},{name:'teacher-surrogate-a',create:()=>teacher(0)}];
      const tuning=await evaluateLeague({...leagueOptions(entries,seeds.tuning+3*tuningSeeds,tuningSeeds,true),auctionTypes:['Vickrey','FirstPrice']});
      Object.assign(tuning,{executionProtocol:EXECUTION_PROTOCOL_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,candidateConfigurations:Object.fromEntries(configurations.map(configuration=>[configuration.name,normalizedReinvestmentOptions(configuration.options)]))});atomicWriteJson(join(artifactDir,'reinvestment-development.json'),tuning);
      if(tuning.completed)candidateReinvestment={...configurations.sort((a,b)=>better(tuning,b.name,a.name))[0]!.options};
    }
    phase('training-v2-residual',{bidScale,holdThreshold,actorSeedRecipe:'sha256(cycleId:actor:episode).first8hex',startingGames:model.trainedGames});let completed=0;
    for(;completed<trainGames&&!stopped()&&Date.now()<Math.min(options.untilMs,deadline);completed++) {
      const seed=seeds.training+completed;
      // Persisted random cycle ID supplies an independent, reproducible actor stream.
      const actorSeed=Number.parseInt(digest(`${id}:actor:${completed}`).slice(0,8),16);
      const policies:BotPolicy[]=[learner(model,{training:true,epsilon:.12,seed:actorSeed}),fixed(new MathV2(engine)),fixed(new MathBot(engine,{bidScale,holdThreshold})),fixed(new DiluteBot(engine,{profile:diluteProfile,dictionaryHash})),teacher(0),teacher(1)];
      const rotation=completed%6;const ordered=[...policies.slice(rotation),...policies.slice(0,rotation)];
      simulateMatch({engine,policies:ordered,seed,auctionType:completed%2?'FirstPrice':'Vickrey',beliefParticles:16});
      saveModel(modelPath,model);Object.assign(progress,{completedTrainingGames:completed+1,trainedGames:model.trainedGames,updates:model.updates});saveProgress();await yieldTurn();
    }
    saveModel(modelPath,model);
    if(stopped()){phase('stopped',{trainedGames:model.trainedGames});return {status:'stopped',cycle,evaluationSeed:seeds.evaluation,trainedGames:model.trainedGames};}
    phase('evaluating-frozen-candidates',{evaluationFocus:focusReinvestment?'reinvestment-foundation':focusEndgame?'endgame-foundation':'three-profiles',endgame:focusEndgame?candidateEndgame:evaluatedFoundation??null,reinvestment:focusReinvestment?candidateReinvestment:evaluatedReinvestment??null});
    const entries:LeagueEntry[]=focusFoundation?
      [{name:focusReinvestment?'reinvest-candidate':'endgame-candidate',create:()=>fixed(new MathV2(engine),focusReinvestment?{reinvestment:candidateReinvestment}:{endgame:candidateEndgame})},{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},...[0,1,2,3].map(index=>({name:`teacher-surrogate-${index}`,create:()=>teacher(index)}))]:
      [{name:'math-candidate',create:()=>fixed(new MathBot(engine,{bidScale,holdThreshold}))},{name:'learner-candidate',create:()=>learner(model)},{name:'dilute-candidate',create:()=>fixed(new DiluteBot(engine,{profile:diluteProfile,dictionaryHash}))},{name:'frozen-v2',create:()=>fixed(new MathV2(engine))},{name:'teacher-surrogate-a',create:()=>teacher(0)},{name:'teacher-surrogate-b',create:()=>teacher(1)}];
    const approvedKeys=(['math','learner','dilute'] as const).filter(key=>active[key].mode==='approved');
    const incumbent=!focusFoundation&&approvedKeys.length?approvedKeys[(cycle-1)%approvedKeys.length]:undefined;
    const finalOptions=leagueOptions(entries,seeds.evaluation,evaluationSeeds,true);
    if(incumbent){entries[5]={name:'current-champion',create:()=>selectedPolicy(active[incumbent],incumbent)};finalOptions.championName='current-champion';}
    const report=await evaluateLeague(finalOptions),reportPath=join(artifactDir,'league.json');
    Object.assign(report,{executionProtocol:EXECUTION_PROTOCOL_VERSION,endgameRevision:ENDGAME_POLICY_VERSION,reinvestmentRevision:REINVEST_POLICY_VERSION,candidateConfiguration:{endgame:focusEndgame?candidateEndgame:evaluatedFoundation,reinvestment:focusReinvestment?candidateReinvestment:evaluatedReinvestment,math:{bidScale,holdThreshold},learnerProfile:'v2-residual',diluteCutoff:diluteProfile?.cutoffMatchId,diluteSource,cycleId:id,sourceCutoff:arena?.metadata.cutoffMatchId}});atomicWriteJson(reportPath,report);
    const immutableModel=join(artifactDir,'learner.json');saveModel(immutableModel,model);
    const reportRef=artifactReference(root,reportPath),promoted:string[]=[];
    // Data calibration is not promotion. Only the fresh frozen league gate can authorize a pointer update.
    if(fresh&&Date.now()<Date.parse(arena!.profile.staleAfter)&&report.completed&&report.frozen.verified&&report.frozen.unchanged&&['Vickrey','FirstPrice'].every(type=>report.modes.some(mode=>mode.auctionType===type))) {
      active=loadSelection(root,dictionaryHash).selection;
      const next:CompetitionSelection=JSON.parse(JSON.stringify(active));next.createdAt=new Date().toISOString();next.generation=id;next.executionProtocol=EXECUTION_PROTOCOL_VERSION;
      next.expiresAt=new Date(selectionExpiresAt(options.untilMs,Date.parse(arena!.profile.staleAfter))).toISOString();
      if(focusFoundation&&!active.endgame&&!active.reinvestment&&report.gates.find(g=>g.candidate===(focusReinvestment?'reinvest-candidate':'endgame-candidate'))?.eligible){
        if(focusReinvestment)next.reinvestment={mode:'approved',candidate:'reinvest-candidate',report:reportRef,options:candidateReinvestment};
        else next.endgame={mode:'approved',candidate:'endgame-candidate',report:reportRef,options:candidateEndgame};
        // Components approved without this foundation are retained on disk but
        // require a new joint gate before they can be combined with it.
        for(const key of ['math','learner','dilute'] as const)next[key]={mode:'v2'};
        promoted.push(focusReinvestment?'reinvestment':'endgame');
      }
      for(const [key,name] of [['math','math-candidate'],['learner','learner-candidate'],['dilute','dilute-candidate']] as const) {
        if(focusFoundation||!sameEndgameFoundation(active.endgame?.options,evaluatedFoundation)||!sameReinvestmentFoundation(active.reinvestment?.options,evaluatedReinvestment))continue;
        if(!report.gates.find(g=>g.candidate===name)?.eligible)continue;
        if(!mayReplaceIncumbent(active,key,incumbent))continue;
        if(key==='dilute'&&!validateDiluteResidualProfile(diluteProfile,dictionaryHash))continue;
        next[key]={mode:'approved',candidate:name,report:reportRef,...(key==='math'?{bidScale,holdThreshold}:key==='learner'?{model:artifactReference(root,immutableModel)}:{profile:artifactReference(root,join(artifactDir,'dilute.json'))})};promoted.push(key);
      }
      if(promoted.length)publishSelection(root,next);
    }
    phase('complete',{trainedGames:model.trainedGames,updates:model.updates,leagueCompleted:report.completed,promoted,gates:report.gates,reportPath,nextCycleNotBefore:new Date(started+15*60000).toISOString()});
    return {status:'complete',cycle,evaluationSeed:seeds.evaluation,trainedGames:model.trainedGames,promoted,reportPath};
  }finally{clearInterval(heartbeat);}
}

async function main() {
  const arg=(name:string,fallback:string)=>{const index=process.argv.indexOf(name);return index<0?fallback:process.argv[index+1]??fallback;};
  const root=resolve(arg('--root',process.cwd())),untilMs=Date.parse(arg('--until','2026-11-07T22:20:00-06:00'));
  if(!Number.isFinite(untilMs))throw new Error('Invalid competition deadline');
  if(!process.argv.includes('--once')&&process.env.SCRABBLE_ALLOW_PERSISTENT_TRAINING!=='1')throw new Error('Use --once for a bounded run, or explicitly set SCRABBLE_ALLOW_PERSISTENT_TRAINING=1 on your chosen training host');
  const options:CompetitionCycleOptions={root,untilMs,offline:process.argv.includes('--offline'),trainGames:Number(arg('--train-games','40')),evaluationSeeds:Number(arg('--evaluation-seeds','6')),tuningSeeds:Number(arg('--tuning-seeds','2')),skipTuning:process.argv.includes('--skip-tuning'),focusEndgame:process.argv.includes('--focus-endgame')?true:undefined,focusReinvestment:process.argv.includes('--focus-reinvestment')?true:undefined,maxCycleMs:Number(arg('--max-cycle-ms',String(12*60000)))};
  let interrupted=false;const interrupt=()=>{interrupted=true;mkdirSync(join(root,'runs'),{recursive:true});writeFileSync(join(root,'runs','STOP'),'Competition loop signal stop');};
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  let firstIteration=true;
  do {
    const started=Date.now(),result=await runCompetitionCycle({...options,focusEndgame:process.argv.includes('--focus-endgame-first')&&firstIteration?true:options.focusEndgame,focusReinvestment:process.argv.includes('--focus-reinvestment-first')&&firstIteration?true:options.focusReinvestment});
    firstIteration=false;
    if(process.argv.includes('--once')||result.status==='stopped'||interrupted||Date.now()>=untilMs)break;
    const next=Math.min(untilMs,started+15*60000);
    while(Date.now()<next&&!interrupted&&!existsSync(join(root,'runs','STOP')))await wait(Math.min(1000,next-Date.now()));
  }while(!interrupted&&!existsSync(join(root,'runs','STOP'))&&Date.now()<untilMs);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'Competition loop failed');process.exitCode=1;});
