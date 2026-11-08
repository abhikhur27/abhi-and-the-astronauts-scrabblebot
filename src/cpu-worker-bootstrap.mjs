import {parentPort,workerData,threadId} from 'node:worker_threads';
import {tsImport} from 'tsx/esm/api';

try {
  const module=await tsImport(workerData.moduleURL,import.meta.url);
  const handle=await module.createJobHandler(workerData.initData);
  if(typeof handle!=='function')throw new Error('Invalid worker handler');
  parentPort.on('message',async ({index,job})=>{
    try {parentPort.postMessage({kind:'result',index,result:await handle(job),threadId});}
    catch {parentPort.postMessage({kind:'failure',index,threadId});}
  });
  parentPort.postMessage({kind:'ready',threadId});
} catch {
  parentPort.postMessage({kind:'failure',threadId});
}
