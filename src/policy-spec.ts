import type { BotPolicy } from './types.js';
import type { WordEngine } from './engine.js';
import { MathBot as MathV2 } from './math-v2.js';
import { MathBot, type MathOptions } from './math.js';
import { DiluteBot } from './dilute.js';
import { LearningBot, type LearnedModel, type LearningOptions } from './model.js';
import { CoordinatedBot } from './coordinated-policy.js';
import { EndgameBot, type EndgameOptions } from './endgame.js';
import { ReinvestmentBot, type ReinvestmentOptions } from './reinvest.js';

/** Data only: worker jobs never serialize executable factories or artifact paths. */
export type PolicySpec =
  | { type:'v2' }
  | { type:'math'; options?:MathOptions }
  | { type:'dilute'; dictionaryHash?:string; profile?:unknown }
  | { type:'learner'; model:LearnedModel; options?:Omit<LearningOptions,'anchorPolicy'>; anchor?:PolicySpec }
  | { type:'coordinated'; base:PolicySpec }
  | { type:'endgame'; base:PolicySpec; options?:EndgameOptions }
  | { type:'reinvestment'; base:PolicySpec; options?:ReinvestmentOptions };

/** Each hydration owns a fresh model/profile copy, including during evaluation. */
export function hydratePolicy(engine:WordEngine,spec:PolicySpec):BotPolicy {
  switch(spec.type) {
    case 'v2': return new MathV2(engine);
    case 'math': return new MathBot(engine,spec.options);
    case 'dilute': return new DiluteBot(engine,{dictionaryHash:spec.dictionaryHash,profile:structuredClone(spec.profile)});
    case 'learner': return new LearningBot(engine,structuredClone(spec.model),{...spec.options,anchorPolicy:spec.anchor?hydratePolicy(engine,spec.anchor):undefined});
    case 'coordinated': return new CoordinatedBot(engine,hydratePolicy(engine,spec.base));
    case 'endgame': return new EndgameBot(engine,hydratePolicy(engine,spec.base),spec.options);
    case 'reinvestment': return new ReinvestmentBot(engine,hydratePolicy(engine,spec.base),spec.options);
    default: throw new Error('Unsupported worker policy specification');
  }
}

export function isFrozenPolicySpec(spec:PolicySpec):boolean {
  switch(spec.type) {
    case 'learner': return spec.options?.training!==true && (spec.options?.epsilon??0)===0 && (!spec.anchor||isFrozenPolicySpec(spec.anchor));
    case 'coordinated': case 'endgame': case 'reinvestment': return isFrozenPolicySpec(spec.base);
    case 'v2': case 'math': case 'dilute': return true;
    default:return false;
  }
}
