export interface CompetitionState {
  schema:'scrabblebot-competition-state-v1';cycle:number;
  nextTrainingSeed:number;nextTuningSeed:number;nextEvaluationSeed:number;
}
export function initialCompetitionState():CompetitionState { return {schema:'scrabblebot-competition-state-v1',cycle:0,nextTrainingSeed:300000000,nextTuningSeed:500000000,nextEvaluationSeed:700000000}; }
export function reserveCycleSeeds(state:CompetitionState,training:number,tuning:number,evaluation:number) {
  if(state.schema!=='scrabblebot-competition-state-v1' || ![state.cycle,state.nextTrainingSeed,state.nextTuningSeed,state.nextEvaluationSeed].every(n=>Number.isSafeInteger(n)&&n>=0) || ![training,tuning,evaluation].every(n=>Number.isSafeInteger(n)&&n>=1))throw new Error('Invalid seed ledger');
  const next={...state,cycle:state.cycle+1,nextTrainingSeed:state.nextTrainingSeed+training,nextTuningSeed:state.nextTuningSeed+tuning*4,nextEvaluationSeed:state.nextEvaluationSeed+evaluation};
  if(next.nextTrainingSeed>=500000000||next.nextTuningSeed>=700000000||next.nextEvaluationSeed>=0x80000000)throw new Error('Competition seed domain exhausted');
  return {training:state.nextTrainingSeed,tuning:state.nextTuningSeed,evaluation:state.nextEvaluationSeed,next};
}
