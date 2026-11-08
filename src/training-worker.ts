import {createHash} from 'node:crypto';
import {WordEngine} from './engine.js';
import {LearningBot,type LearnedModel} from './model.js';
import {hydratePolicy,isFrozenPolicySpec,type PolicySpec} from './policy-spec.js';
import {simulateMatch} from './simulator.js';
import type {BotPolicy,AuctionType} from './types.js';
import type {TrainingReplicaResult,TrainingEpisodeReceipt} from './parallel-training.js';

export interface TrainingWorkerInit {
  dictionaryWords:readonly string[];anchor:PolicySpec;opponents:readonly PolicySpec[];
  protectedHorizon:number;beliefParticles:number;untilMs:number;
}
export interface TrainingReplicaJob {
  replicaIndex:number;initialModel:LearnedModel;trainingSeed:number;requestedGames:number;
  globalEpisodeOffset:number;cycleId:string;
}

/** One engine per owned worker, one independent optimizer state per branch. */
export function createJobHandler(init:TrainingWorkerInit):(job:TrainingReplicaJob)=>TrainingReplicaResult {
  if(!isFrozenPolicySpec(init.anchor)||init.opponents.length!==5||!init.opponents.every(isFrozenPolicySpec))throw new Error('Training requires frozen anchor and opponents');
  const engine=new WordEngine(init.dictionaryWords);
  return job=>{
    if(job.initialModel.schema!=='scrabblebot-v2-residual-v1')throw new Error('Training worker requires a V2 residual checkpoint');
    let model=structuredClone(job.initialModel);
    const initialTrainedGames=model.trainedGames,initialUpdates=model.updates,episodes:TrainingEpisodeReceipt[]=[];
    model.trainingSeed=job.trainingSeed;
    const release=()=>{
      (engine as WordEngine&{releaseCaches?:()=>void}).releaseCaches?.();
      globalThis.gc?.();
    };
    try {
      for(let episode=0;episode<job.requestedGames&&Date.now()<init.untilMs;episode++){
        const beforeEpisode=structuredClone(model),seed=job.trainingSeed+episode,offset=job.globalEpisodeOffset+episode;
        // Deck/tie randomness never seeds the actor. The persisted cycle ID
        // and explicit branch/episode coordinates define its separate stream.
        const actorSeed=Number.parseInt(createHash('sha256').update(`${job.cycleId}:actor:${job.replicaIndex}:${episode}`).digest('hex').slice(0,8),16);
        const learner=new LearningBot(engine,model,{training:true,epsilon:.12,seed:actorSeed,protectedHorizon:init.protectedHorizon,anchorPolicy:hydratePolicy(engine,init.anchor)});
        const finish=learner.finishEpisode.bind(learner);let updated=false;
        learner.finishEpisode=score=>{if(Date.now()<init.untilMs){finish(score);updated=true;}};
        const policies:BotPolicy[]=[learner,...init.opponents.map(spec=>hydratePolicy(engine,spec))];
        const rotation=offset%6,ordered=[...policies.slice(rotation),...policies.slice(0,rotation)];
        const auctionType:AuctionType=offset%2?'FirstPrice':'Vickrey';
        const result=simulateMatch({engine,policies:ordered,seed,auctionType,beliefParticles:init.beliefParticles});
        if(!updated||Date.now()>=init.untilMs){model=beforeEpisode;release();break;}
        episodes.push({seed,actorSeed,auctionType,rotation,score:result.players[(6-rotation)%6]!.score});
        release();
      }
      return {replicaIndex:job.replicaIndex,lineageId:`${job.cycleId}:replica:${job.replicaIndex}`,trainingSeed:job.trainingSeed,
        requestedGames:job.requestedGames,completedGames:episodes.length,complete:episodes.length===job.requestedGames,
        stopReason:episodes.length===job.requestedGames?null:'deadline',initialTrainedGames,initialUpdates,
        updatesAdded:model.updates-initialUpdates,model,episodes};
    }finally{release();}
  };
}
