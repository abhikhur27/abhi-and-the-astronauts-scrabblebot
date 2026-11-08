import { existsSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import type { WordEngine } from './engine.js';
import { MathBot } from './math.js';
import { MathBot as MathV2 } from './math-v2.js';
import { LearningBot,createModel,loadModel,saveModel,modelProfile,type LearnedModel } from './model.js';
import { DiluteBot } from './dilute.js';
import { loadSelection,loadArtifact,type CompetitionSelection } from './competition-store.js';
import { atomicWriteJson } from './atomic-json.js';
import { CoordinatedBot } from './coordinated-policy.js';
import { EndgameBot } from './endgame.js';
import { ReinvestmentBot,normalizedReinvestmentOptions } from './reinvest.js';
import type { Strategy } from './live-session.js';
import type { BotPolicy } from './types.js';
export interface LivePolicyOptions {root:string;engine:WordEngine;dictionaryHash:string;onlineLearning:boolean;usesLearner:boolean;initialModelPath?:string;}
export interface LivePolicyEntry {policy:BotPolicy;coordinator:CoordinatedBot;endgame?:EndgameBot;reinvestment?:ReinvestmentBot;mode:'v2'|'approved';generation:string;reason?:string;}
interface TournamentSnapshot {selection:CompetitionSelection;strategy:Strategy;reason?:string;model?:LearnedModel;profile?:unknown;}
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
export class LivePolicyManager {
 private model:LearnedModel;
 private readonly modelPath:string;
 private readonly sourcePath:string;
 private adoptedSha?:string;
 private readonly tournaments=new Map<string,TournamentSnapshot>();
 private readonly frozenPolicies=new WeakSet<BotPolicy>();
 readonly initialSource:string;
 constructor(private readonly options:LivePolicyOptions) {
  this.modelPath=join(options.root,'models','live-v2-residual.json');this.sourcePath=join(options.root,'models','live-v2-residual-source.json');
  this.model=createModel();this.model.dictionaryHash=options.dictionaryHash;
  const source=options.usesLearner&&(options.onlineLearning&&existsSync(this.modelPath)?this.modelPath:options.initialModelPath);
  if(source&&existsSync(source)) {
    const loaded=loadModel(source);
    if(loaded.dictionaryHash!==options.dictionaryHash)throw new Error('Checkpoint dictionary hash mismatch');
    if(modelProfile(loaded)==='v2-residual'){this.model=loaded;this.initialSource=source===this.modelPath?'live-v2-residual':'configured-v2-residual';}
    else this.initialSource='fresh-v2-residual-legacy-preserved';
  }else this.initialSource='fresh-v2-residual';
  if(this.initialSource==='live-v2-residual'&&existsSync(this.sourcePath))try{this.adoptedSha=JSON.parse(readFileSync(this.sourcePath,'utf8')).approvedSha;}catch{}
 }
 get counters(){return {schema:this.model.schema,profile:modelProfile(this.model),games:this.model.trainedGames,updates:this.model.updates,modelSha256:createHash('sha256').update(JSON.stringify(this.model)).digest('hex')};}
 create(strategy:Strategy,matchId:bigint):LivePolicyEntry {
  const {selection,reason}=loadSelection(this.options.root,this.options.dictionaryHash),entry=selection[strategy];
  let mode=entry.mode,policy:BotPolicy,rejection=reason,coordinator:CoordinatedBot|undefined,endgame:EndgameBot|undefined,reinvestment:ReinvestmentBot|undefined;
  const anchor=(base:BotPolicy):BotPolicy=>{coordinator=new CoordinatedBot(this.options.engine,base);endgame=selection.endgame?new EndgameBot(this.options.engine,coordinator,selection.endgame.options):undefined;reinvestment=selection.reinvestment?new ReinvestmentBot(this.options.engine,coordinator,selection.reinvestment.options):undefined;return reinvestment??endgame??coordinator;};
  const learner=()=>new LearningBot(this.options.engine,this.model,{training:this.options.onlineLearning,epsilon:mode==='approved'?.02:0,allowDeviations:mode==='approved',seed:Number(matchId%0x7fffffffn),anchorPolicy:anchor(new MathV2(this.options.engine)),protectedHorizon:selection.reinvestment?normalizedReinvestmentOptions(selection.reinvestment.options).closingTiles:selection.endgame?.options.closingTiles??(selection.endgame?10:2)});
  try {
    if(strategy==='math')policy=mode==='approved'?new MathBot(this.options.engine,{bidScale:entry.bidScale,holdThreshold:entry.holdThreshold}):new MathV2(this.options.engine);
    else if(strategy==='dilute') {
      const dilute=new DiluteBot(this.options.engine,{dictionaryHash:this.options.dictionaryHash,profile:mode==='approved'&&entry.profile?loadArtifact(this.options.root,entry.profile):undefined});
      if(dilute.profileStatus.anchored)mode='v2';policy=dilute;
    }else {
      if(mode==='approved'&&entry.model&&entry.model.sha256!==this.adoptedSha) {
        const approved=loadModel(resolve(this.options.root,entry.model.path),'v2-residual');
        if(approved.dictionaryHash!==this.options.dictionaryHash)throw new Error('Approved dictionary mismatch');
        if(this.options.onlineLearning)saveModel(join(this.options.root,'models','live-history',`${Date.now()}-${randomUUID()}.json`),this.model);
        this.model=approved;this.adoptedSha=entry.model.sha256;
        if(this.options.onlineLearning){saveModel(this.modelPath,this.model);atomicWriteJson(this.sourcePath,{approvedSha:this.adoptedSha,adoptedAt:new Date().toISOString(),generation:selection.generation});}
      }
      policy=learner();
    }
  }catch {
    mode='v2';rejection='approved-artifact-rejected';
    policy=strategy==='learner'?learner():new MathV2(this.options.engine);
  }
  if(strategy!=='learner')policy=anchor(policy);
  (policy as BotPolicy&{beginEpisode?:()=>void}).beginEpisode?.();
  return {policy,coordinator:coordinator!,endgame,reinvestment,mode,generation:selection.generation,reason:rejection};
 }
 private tournamentStrategy(selection:CompetitionSelection):Strategy {
  let chosen:Strategy='math',best=0;
  for(const strategy of ['math','learner','dilute'] as const){
   const entry=selection[strategy];if(entry.mode!=='approved'||!entry.report||!entry.candidate)continue;
   try {
    const report=loadArtifact<{baselineName?:string;gates?:{candidate:string;eligible:boolean}[];modes?:{auctionType:string;comparisons?:{candidate:string;reference:string;result?:{winShareDifferenceLower95OneSided?:number|null}}[]}[]}>(this.options.root,entry.report);
    if(!report.gates?.some(g=>g.candidate===entry.candidate&&g.eligible))continue;
    const lower=['Vickrey','FirstPrice'].map(type=>report.modes?.find(m=>m.auctionType===type)?.comparisons?.find(c=>c.candidate===entry.candidate&&c.reference===report.baselineName)?.result?.winShareDifferenceLower95OneSided);
    if(lower.some(value=>typeof value!=='number'||!Number.isFinite(value)||value<=0))continue;
    const score=Math.min(...lower as number[]);if(score>best){best=score;chosen=strategy;}
   }catch{/* A report that changed after validation cannot select a challenger. */}
  }
  return chosen;
 }
 /** Lock one tested selection and immutable artifact snapshot for all rounds. */
 createTournament(tournamentId:string,matchId:bigint,overrideStrategy?:Strategy):LivePolicyEntry&{strategy:Strategy;tournamentId:string;frozen:true;learnerSnapshot?:{schema:string;profile:string;games:number;updates:number;modelSha256:string}} {
  if(!/^\d+$/.test(tournamentId))throw new Error('Invalid tournament ID');
  if(overrideStrategy!==undefined&&!['math','learner','dilute'].includes(overrideStrategy))throw new Error('Invalid tournament strategy');
  let snapshot=this.tournaments.get(tournamentId);
  if(!snapshot){
   const loaded=loadSelection(this.options.root,this.options.dictionaryHash),selection=copy(loaded.selection),strategy=overrideStrategy??this.tournamentStrategy(selection);
   snapshot={selection,strategy,reason:loaded.reason};
   const entry=selection[strategy];
   try {
    if(strategy==='learner'&&entry.mode==='approved'){
     const model=new LearningBot(this.options.engine,loadArtifact<LearnedModel>(this.options.root,entry.model!)).model;
     if(modelProfile(model)!=='v2-residual'||model.dictionaryHash!==this.options.dictionaryHash)throw new Error('Frozen checkpoint mismatch');
     snapshot.model=copy(model);
    }else if(strategy==='dilute'&&entry.mode==='approved'){
     const profile=loadArtifact(this.options.root,entry.profile!);
     if(new DiluteBot(this.options.engine,{dictionaryHash:this.options.dictionaryHash,profile:copy(profile)}).profileStatus.anchored)throw new Error('Invalid frozen profile');
     snapshot.profile=copy(profile);
    }
   }catch{selection[strategy]={mode:'v2'};snapshot.reason='tournament-artifact-rejected';}
   this.tournaments.set(tournamentId,snapshot);
  }
  const {selection,strategy}=snapshot,entry=selection[strategy],mode=entry.mode;
  let coordinator:CoordinatedBot|undefined,endgame:EndgameBot|undefined,reinvestment:ReinvestmentBot|undefined;
  const anchor=(base:BotPolicy):BotPolicy=>{coordinator=new CoordinatedBot(this.options.engine,base);endgame=selection.endgame?new EndgameBot(this.options.engine,coordinator,copy(selection.endgame.options)):undefined;reinvestment=selection.reinvestment?new ReinvestmentBot(this.options.engine,coordinator,copy(selection.reinvestment.options)):undefined;return reinvestment??endgame??coordinator;};
  let policy:BotPolicy,learnerSnapshot:{schema:string;profile:string;games:number;updates:number;modelSha256:string}|undefined;
  if(strategy==='learner'){
   const model=snapshot.model?copy(snapshot.model):createModel();model.dictionaryHash=this.options.dictionaryHash;
   learnerSnapshot={schema:model.schema,profile:modelProfile(model),games:model.trainedGames,updates:model.updates,modelSha256:createHash('sha256').update(JSON.stringify(model)).digest('hex')};
   policy=new LearningBot(this.options.engine,model,{training:false,epsilon:0,allowDeviations:mode==='approved',seed:Number(matchId%0x7fffffffn),anchorPolicy:anchor(new MathV2(this.options.engine)),protectedHorizon:selection.reinvestment?normalizedReinvestmentOptions(selection.reinvestment.options).closingTiles:selection.endgame?.options.closingTiles??(selection.endgame?10:2)});
  }else if(strategy==='dilute')policy=anchor(new DiluteBot(this.options.engine,{dictionaryHash:this.options.dictionaryHash,profile:mode==='approved'?copy(snapshot.profile):undefined}));
  else policy=anchor(mode==='approved'?new MathBot(this.options.engine,{bidScale:entry.bidScale,holdThreshold:entry.holdThreshold}):new MathV2(this.options.engine));
  this.frozenPolicies.add(policy);(policy as BotPolicy&{beginEpisode?:()=>void}).beginEpisode?.();
  return {policy,coordinator:coordinator!,endgame,reinvestment,mode,generation:selection.generation,reason:snapshot.reason,strategy,tournamentId,frozen:true,learnerSnapshot};
 }
 finish(policy:BotPolicy,score:number):void {
  (policy as BotPolicy&{finishEpisode?:(value:number)=>void}).finishEpisode?.(score);
  if(policy instanceof LearningBot&&this.options.onlineLearning&&!this.frozenPolicies.has(policy)){this.model=policy.model;saveModel(this.modelPath,this.model);}
 }
}
