import {LearningBot,type LearnedModel} from './model.js';
import {WordEngine} from './engine.js';
import {isFrozenPolicySpec,type PolicySpec} from './policy-spec.js';
import {runCpuJobs,type CpuJobResult} from './cpu-pool.js';
import type {AuctionType} from './types.js';
import type {TrainingReplicaJob,TrainingWorkerInit} from './training-worker.js';

export interface ParallelTrainingOptions {
  dictionaryWords:readonly string[]; initialModel:LearnedModel; replicas:number;
  gamesPerReplica?:number; trainingSeed:number; cycleId:string; anchor:PolicySpec;
  opponents:readonly PolicySpec[]; protectedHorizon?:number; untilMs:number;
  workers?:number; signal?:AbortSignal; shouldStop?:()=>boolean; beliefParticles?:number;
  onReplicaComplete?:(replica:TrainingReplicaResult)=>void;
}
export interface TrainingEpisodeReceipt {seed:number;actorSeed:number;auctionType:AuctionType;rotation:number;score:number;}
export interface TrainingReplicaResult {
  replicaIndex:number;lineageId:string;trainingSeed:number;requestedGames:number;completedGames:number;
  complete:boolean;stopReason:null|'deadline';initialTrainedGames:number;initialUpdates:number;
  updatesAdded:number;model:LearnedModel;episodes:TrainingEpisodeReceipt[];
}
export interface ParallelTrainingResult {
  replicas:TrainingReplicaResult[];completed:boolean;totalCompletedGames:number;
  requestedReplicas:number;gamesPerReplica:number;fallbackModel:LearnedModel;
  execution:Omit<CpuJobResult<TrainingReplicaResult>,'results'>;
}
export async function runParallelTraining(options:ParallelTrainingOptions):Promise<ParallelTrainingResult> {
  const gamesPerReplica=options.gamesPerReplica??40,workers=options.workers??options.replicas;
  if(!Number.isSafeInteger(options.replicas)||options.replicas<1||options.replicas>4||!Number.isSafeInteger(gamesPerReplica)||gamesPerReplica<1||gamesPerReplica>1000)throw new Error('Invalid independent training replica count');
  if(!Number.isSafeInteger(workers)||workers<1||workers>4)throw new Error('Training requires one to four workers');
  if(!Number.isSafeInteger(options.trainingSeed)||options.trainingSeed<300000000||options.trainingSeed+gamesPerReplica*options.replicas>500000000)throw new Error('Invalid reserved training seed range');
  if(options.initialModel?.schema!=='scrabblebot-v2-residual-v1')throw new Error('Parallel training requires a V2 residual checkpoint; legacy models remain separate');
  if(!Number.isFinite(options.untilMs)||typeof options.cycleId!=='string'||!options.cycleId.trim())throw new Error('Invalid training cycle deadline or lineage');
  if(!Array.isArray(options.opponents)||options.opponents.length!==5||!isFrozenPolicySpec(options.anchor)||!options.opponents.every(isFrozenPolicySpec))throw new Error('Training anchor and five opponents must be frozen');
  const protectedHorizon=options.protectedHorizon??2,beliefParticles=options.beliefParticles??16;
  if(!Number.isSafeInteger(protectedHorizon)||protectedHorizon<0||protectedHorizon>68||!Number.isSafeInteger(beliefParticles)||beliefParticles<1||beliefParticles>512)throw new Error('Invalid training horizon or belief budget');
  // Validate before returning a fallback, without exposing any caller-owned
  // optimizer state to a learner that can mutate it.
  const fallbackModel=structuredClone(options.initialModel);
  new LearningBot(new WordEngine([]),structuredClone(fallbackModel));
  if(Date.now()>=options.untilMs)return {replicas:[],completed:false,totalCompletedGames:0,requestedReplicas:options.replicas,gamesPerReplica,fallbackModel,
    execution:{stopReason:'duration-limit',requestedWorkers:workers,effectiveWorkers:0,workerThreadIds:[],elapsedMs:0,workersTerminated:true}};
  const initData:TrainingWorkerInit={dictionaryWords:options.dictionaryWords,anchor:options.anchor,opponents:options.opponents,protectedHorizon,beliefParticles,untilMs:options.untilMs};
  const jobs:TrainingReplicaJob[]=Array.from({length:options.replicas},(_,replicaIndex)=>({replicaIndex,initialModel:structuredClone(fallbackModel),trainingSeed:options.trainingSeed+replicaIndex*gamesPerReplica,requestedGames:gamesPerReplica,globalEpisodeOffset:replicaIndex*gamesPerReplica,cycleId:options.cycleId}));
  const pool=await runCpuJobs<TrainingReplicaJob,TrainingReplicaResult>({moduleURL:new URL('./training-worker.ts',import.meta.url),initData,jobs,workers,
    maxDurationMs:Math.max(0,options.untilMs-Date.now()),signal:options.signal,shouldStop:options.shouldStop,
    onResult:(_index,replica)=>options.onReplicaComplete?.(replica)});
  const replicas=pool.results.map(result=>result.result);
  const {results:_results,...execution}=pool;
  if(!execution.stopReason&&replicas.some(replica=>!replica.complete))execution.stopReason='duration-limit';
  return {replicas,completed:execution.stopReason===null&&replicas.length===options.replicas&&replicas.every(replica=>replica.complete),
    totalCompletedGames:replicas.reduce((total,replica)=>total+replica.completedGames,0),requestedReplicas:options.replicas,gamesPerReplica,fallbackModel,execution};
}
