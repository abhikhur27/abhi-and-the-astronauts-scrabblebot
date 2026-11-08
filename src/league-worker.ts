import {WordEngine} from './engine.js';
import {hydratePolicy,isFrozenPolicySpec,type PolicySpec} from './policy-spec.js';
import {runLeagueGame,type LeagueGameJob,type LeagueGameResult} from './league.js';

export function createJobHandler(init:{dictionaryWords:string[];entries:{name:string;spec:PolicySpec}[]}):(job:LeagueGameJob)=>LeagueGameResult {
  if(!Array.isArray(init.dictionaryWords)||init.entries.length!==6||init.entries.some(entry=>!isFrozenPolicySpec(entry.spec)))throw new Error('Invalid frozen league worker input');
  const engine=new WordEngine(init.dictionaryWords),initial=JSON.stringify(init.entries);
  return job=>{
    try {
      const result=runLeagueGame(engine,init.entries.map(entry=>({name:entry.name,create:()=>hydratePolicy(engine,entry.spec)})),job);
      if(JSON.stringify(init.entries)!==initial)throw new Error('Frozen worker input changed');
      return result;
    }finally {engine.releaseCaches();global.gc?.();}
  };
}
