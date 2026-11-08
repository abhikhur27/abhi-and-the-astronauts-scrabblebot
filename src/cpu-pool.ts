import {Worker} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {freemem} from 'node:os';

export interface CpuJobOptions<T,R> {
  moduleURL:URL|string;initData:unknown;jobs:readonly T[];workers:number;
  maxDurationMs?:number;signal?:AbortSignal;shouldStop?:()=>boolean;
  onResult?:(index:number,result:R)=>void;
}
export interface CpuJobResult<R> {
  results:{index:number;result:R;threadId:number}[];
  stopReason:null|'aborted'|'duration-limit'|'worker-error'|'memory-pressure';
  requestedWorkers:number;effectiveWorkers:number;workerThreadIds:number[];
  elapsedMs:number;workersTerminated:true;
}
const activeWorkers=new Set<Worker>();
/** Diagnostic ownership count for bounded verification, not another orchestrator. */
export function activeCpuWorkers():number{return activeWorkers.size;}

export async function runCpuJobs<T,R>(options:CpuJobOptions<T,R>):Promise<CpuJobResult<R>> {
  if(!Number.isSafeInteger(options.workers)||options.workers<1||options.workers>4)throw new Error('CPU pool requires one to four workers');
  if(options.maxDurationMs!==undefined&&(!Number.isFinite(options.maxDurationMs)||options.maxDurationMs<0))throw new Error('Invalid CPU pool deadline');
  const moduleURL=options.moduleURL instanceof URL?options.moduleURL:new URL(options.moduleURL);
  if(moduleURL.protocol!=='file:')throw new Error('CPU worker module must be a local file');
  const started=performance.now(),results:CpuJobResult<R>['results']=[],threadIds=new Set<number>();
  const workers:Worker[]=[],busy=new Map<Worker,number>();
  const footprint=384*1024*1024,reserve=768*1024*1024;
  const effectiveWorkers=Math.min(options.workers,options.jobs.length,Math.max(0,Math.floor((freemem()-reserve)/footprint)));
  let stopReason:CpuJobResult<R>['stopReason']=null,next=0,settled=false;
  let finish!:()=>void;
  const done=new Promise<void>(resolve=>{finish=()=>{if(!settled){settled=true;resolve();}};});
  const stop=(reason:NonNullable<CpuJobResult<R>['stopReason']>)=>{if(!stopReason)stopReason=reason;finish();};
  const checkStop=()=>{
    try {
      if(options.signal?.aborted||options.shouldStop?.()){stop('aborted');return true;}
      if(freemem()<512*1024*1024){stop('memory-pressure');return true;}
      if(performance.now()-started>=(options.maxDurationMs??Infinity)){stop('duration-limit');return true;}
    }catch{stop('worker-error');return true;}
    return false;
  };
  const dispatch=(worker:Worker)=>{
    if(settled||checkStop())return;
    if(next>=options.jobs.length){if(busy.size===0)finish();return;}
    const index=next++;busy.set(worker,index);
    try {worker.postMessage({index,job:options.jobs[index]});}catch{stop('worker-error');}
  };
  const interval=setInterval(checkStop,100);
  const abort=()=>stop('aborted');options.signal?.addEventListener('abort',abort,{once:true});
  try {
    if(!options.jobs.length||checkStop())finish();
    else if(effectiveWorkers===0)stop('memory-pressure');
    else for(let index=0;index<effectiveWorkers;index++) {
      if(settled)break;
      // Admit before a worker can construct its dictionary/engine. Start the
      // next engine only after the previous one reports ready, so current
      // available memory includes its real allocation rather than four
      // simultaneous, unaccounted initialization peaks.
      if(freemem()<reserve+footprint){if(workers.length===0)stop('memory-pressure');break;}
      let ready!:()=>void;
      const initialized=new Promise<void>(resolve=>{ready=resolve;});
      const worker=new Worker(new URL('./cpu-worker-bootstrap.mjs',import.meta.url),{
        workerData:{moduleURL:moduleURL.href,initData:options.initData},
        // The static bootstrap registers its own scoped TS loader. Parent flags
        // include process-only options that Node rejects for Worker threads.
        execArgv:[],
        resourceLimits:{maxOldGenerationSizeMb:384,maxYoungGenerationSizeMb:32,stackSizeMb:4},
      });
      workers.push(worker);activeWorkers.add(worker);
      worker.on('message',(message:{kind:string;threadId:number;index?:number;result?:R})=>{
        if(settled)return;
        if(message.kind==='failure'){stop('worker-error');return;}
        if(message.kind==='ready'){threadIds.add(message.threadId);ready();dispatch(worker);return;}
        if(message.kind!=='result'||busy.get(worker)!==message.index){stop('worker-error');return;}
        busy.delete(worker);
        try {options.onResult?.(message.index!,message.result!);}catch{stop('worker-error');return;}
        results.push({index:message.index!,result:message.result!,threadId:message.threadId});
        dispatch(worker);
      });
      worker.on('error',()=>stop('worker-error'));
      worker.on('exit',()=>{activeWorkers.delete(worker);if(!settled)stop('worker-error');});
      await Promise.race([initialized,done]);
    }
    await done;
  }catch{stopReason='worker-error';}
  finally {
    clearInterval(interval);options.signal?.removeEventListener('abort',abort);
    await Promise.allSettled(workers.map(worker=>worker.terminate()));
    workers.forEach(worker=>activeWorkers.delete(worker));
  }
  results.sort((a,b)=>a.index-b.index);
  return {results,stopReason,requestedWorkers:options.workers,effectiveWorkers:workers.length,workerThreadIds:[...threadIds].sort((a,b)=>a-b),elapsedMs:performance.now()-started,workersTerminated:true};
}
