import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from './atomic-json.js';
import { EXECUTION_PROTOCOL_VERSION } from './coordinated-policy.js';
import { ENDGAME_POLICY_VERSION,type EndgameOptions } from './endgame.js';
import { REINVEST_POLICY_VERSION,normalizedReinvestmentOptions,type ReinvestmentOptions } from './reinvest.js';

export interface ArtifactReference { path: string; sha256: string; }
export interface StrategySelection {
  mode: 'v2' | 'approved'; candidate?: string; report?: ArtifactReference;
  bidScale?: number; holdThreshold?:number; model?: ArtifactReference; profile?: ArtifactReference;
}
export interface CompetitionSelection {
  schema: 'scrabblebot-competition-selection-v1'; baseline: 'v2-cash-pacing';
  dictionaryHash: string; generation: string; createdAt: string; expiresAt: string;
  math: StrategySelection; learner: StrategySelection; dilute: StrategySelection;
  executionProtocol?: typeof EXECUTION_PROTOCOL_VERSION;
  endgame?: { mode:'approved'; candidate:string; report:ArtifactReference; options:EndgameOptions };
  reinvestment?: { mode:'approved'; candidate:string; report:ArtifactReference; options:ReinvestmentOptions };
}
const pointer = (root:string) => join(root,'models','active-selection.json');
export function baselineSelection(dictionaryHash:string, now=Date.now(), expires=now+12*3600000):CompetitionSelection {
  return {schema:'scrabblebot-competition-selection-v1',baseline:'v2-cash-pacing',dictionaryHash,executionProtocol:EXECUTION_PROTOCOL_VERSION,
    generation:`v2-baseline-${now}`,createdAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),
    math:{mode:'v2'},learner:{mode:'v2'},dilute:{mode:'v2'}};
}
export function normalizedEndgameOptions(options:EndgameOptions):Required<EndgameOptions> {
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['closingTiles','liquidationTiles','maxScenarios','minimumWinDelta'].includes(key)))throw new Error('Invalid endgame options');
  const closingTiles=options.closingTiles??10,liquidationTiles=options.liquidationTiles??Math.min(4,closingTiles),maxScenarios=options.maxScenarios??4,minimumWinDelta=options.minimumWinDelta??.15;
  if(!Number.isSafeInteger(closingTiles)||closingTiles<1||closingTiles>30||!Number.isSafeInteger(liquidationTiles)||liquidationTiles<0||liquidationTiles>closingTiles||!Number.isSafeInteger(maxScenarios)||maxScenarios<1||maxScenarios>16||!Number.isFinite(minimumWinDelta)||minimumWinDelta<=0||minimumWinDelta>1)throw new Error('Invalid endgame options');
  return {closingTiles,liquidationTiles,maxScenarios,minimumWinDelta};
}
function artifactPath(root:string, ref:ArtifactReference):string {
  if (!ref || typeof ref.path!=='string' || isAbsolute(ref.path) || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Invalid artifact path or hash');
  const path=resolve(root,ref.path), allowed=resolve(root,'models','league');
  if (!path.startsWith(allowed+sep)) throw new Error('Artifact path escapes league storage');
  return path;
}
export function artifactReference(root:string,path:string):ArtifactReference {
  const rel=relative(resolve(root),resolve(path)).split(sep).join('/');
  const ref={path:rel,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
  artifactPath(root,ref); return ref;
}
export function loadArtifact<T=unknown>(root:string, ref:ArtifactReference):T {
  const path=artifactPath(root,ref);
  if (statSync(path).size>5_000_000) throw new Error('Artifact exceeds size limit');
  const bytes=readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex')!==ref.sha256) throw new Error('Artifact integrity mismatch');
  return JSON.parse(bytes.toString('utf8')) as T;
}
function validate(root:string, value:unknown, dictionaryHash:string, now:number):CompetitionSelection {
  const selection=value as CompetitionSelection;
  if (!selection || selection.schema!=='scrabblebot-competition-selection-v1' || selection.baseline!=='v2-cash-pacing') throw new Error('Invalid selection schema');
  if (selection.dictionaryHash!==dictionaryHash || !/^[a-f0-9]{64}$/.test(dictionaryHash)) throw new Error('Selection dictionary mismatch');
  if (!selection.generation || typeof selection.generation!=='string' || !Number.isFinite(Date.parse(selection.createdAt)) || Date.parse(selection.createdAt)>now+60000) throw new Error('Invalid selection generation/time');
  if (!Number.isFinite(Date.parse(selection.expiresAt)) || Date.parse(selection.expiresAt)<=now) throw new Error('Selection expired');
  if(selection.executionProtocol!==undefined&&selection.executionProtocol!==EXECUTION_PROTOCOL_VERSION)throw new Error('Selection execution protocol mismatch');
  if(selection.endgame&&selection.reinvestment)throw new Error('Common foundations are mutually exclusive');
  const gateReport=(entry:{candidate?:string;report?:ArtifactReference})=>{
    if (!entry.candidate || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.candidate) || !entry.report) throw new Error('Missing gate evidence');
    if(selection.executionProtocol!==EXECUTION_PROTOCOL_VERSION)throw new Error('Approved selection execution protocol mismatch');
    const report=loadArtifact<{schema?:string;completed?:boolean;executionProtocol?:string;endgameRevision?:string;reinvestmentRevision?:string;primaryObjective?:string;candidateConfiguration?:{endgame?:EndgameOptions;reinvestment?:ReinvestmentOptions};frozen?:{verified?:boolean;unchanged?:boolean};modes?:{auctionType:string;completedSeedBlocks:number}[];gates?:{candidate:string;eligible:boolean;primaryObjective?:string}[]}>(root,entry.report);
    if(report.executionProtocol!==EXECUTION_PROTOCOL_VERSION)throw new Error('Gate execution protocol mismatch');
    if(report.primaryObjective!=='win-share')throw new Error('Gate must evaluate win-share objective');
    if(report.candidateConfiguration?.endgame&&report.endgameRevision!==ENDGAME_POLICY_VERSION)throw new Error('Gate endgame revision mismatch');
    if(report.candidateConfiguration?.reinvestment&&report.reinvestmentRevision!==REINVEST_POLICY_VERSION)throw new Error('Gate reinvestment revision mismatch');
    if(report.candidateConfiguration?.endgame&&report.candidateConfiguration?.reinvestment)throw new Error('Gate combines mutually exclusive common foundations');
    if (report.schema!=='scrabblebot-league-v1' || report.completed!==true || !report.frozen?.verified || !report.frozen.unchanged || !report.modes?.length || report.modes.some(mode=>!Number.isSafeInteger(mode.completedSeedBlocks)||mode.completedSeedBlocks<6) || !report.gates?.some(gate=>gate.candidate===entry.candidate&&gate.eligible===true&&gate.primaryObjective==='win-share')) throw new Error('Candidate failed completed frozen gate');
    if(!['Vickrey','FirstPrice'].every(type=>report.modes!.some(mode=>mode.auctionType===type)))throw new Error('Global selection requires both auction modes');
    return report;
  };
  if(selection.endgame){
    if(selection.endgame.mode!=='approved')throw new Error('Invalid endgame selection');
    const normalized=normalizedEndgameOptions(selection.endgame.options),report=gateReport(selection.endgame);
    if(!report.candidateConfiguration?.endgame||JSON.stringify(normalizedEndgameOptions(report.candidateConfiguration.endgame))!==JSON.stringify(normalized))throw new Error('Endgame options do not match evaluated configuration');
  }
  if(selection.reinvestment){
    if(selection.reinvestment.mode!=='approved')throw new Error('Invalid reinvestment selection');
    const normalized=normalizedReinvestmentOptions(selection.reinvestment.options),report=gateReport(selection.reinvestment);
    if(!report.candidateConfiguration?.reinvestment||JSON.stringify(normalizedReinvestmentOptions(report.candidateConfiguration.reinvestment))!==JSON.stringify(normalized))throw new Error('Reinvestment options do not match evaluated configuration');
  }
  for (const key of ['math','learner','dilute'] as const) {
    const entry=selection[key];
    if (!entry || !['v2','approved'].includes(entry.mode)) throw new Error('Invalid strategy selection');
    if (entry.mode==='v2') continue;
    const report=gateReport(entry);
    const foundation=selection.endgame?.options;
    if(Boolean(foundation)!==Boolean(report.candidateConfiguration?.endgame)||(foundation&&JSON.stringify(normalizedEndgameOptions(foundation))!==JSON.stringify(normalizedEndgameOptions(report.candidateConfiguration!.endgame!))))throw new Error('Strategy endgame foundation differs from evaluated configuration');
    const reinvestment=selection.reinvestment?.options;
    if(Boolean(reinvestment)!==Boolean(report.candidateConfiguration?.reinvestment)||(reinvestment&&JSON.stringify(normalizedReinvestmentOptions(reinvestment))!==JSON.stringify(normalizedReinvestmentOptions(report.candidateConfiguration!.reinvestment!))))throw new Error('Strategy reinvestment foundation differs from evaluated configuration');
    if (key==='math' && (!Number.isFinite(entry.bidScale) || entry.bidScale!<.9 || entry.bidScale!>1.1)) throw new Error('Invalid math pacing scale');
    if(key==='math'&&entry.holdThreshold!==undefined&&(!Number.isFinite(entry.holdThreshold)||entry.holdThreshold<.98||entry.holdThreshold>1.04))throw new Error('Invalid math holding threshold');
    if (key==='learner') { if (!entry.model) throw new Error('Missing approved model'); loadArtifact(root,entry.model); }
    if (key==='dilute') { if (!entry.profile) throw new Error('Missing approved profile'); loadArtifact(root,entry.profile); }
  }
  return JSON.parse(JSON.stringify(selection)) as CompetitionSelection;
}
export function loadSelection(root:string,dictionaryHash:string,now=Date.now()):{selection:CompetitionSelection;reason?:string} {
  try {
    if (statSync(pointer(root)).size>100_000) throw new Error('Selection exceeds size limit');
    return {selection:validate(root,JSON.parse(readFileSync(pointer(root),'utf8')),dictionaryHash,now)};
  } catch(error) { return {selection:baselineSelection(dictionaryHash,now),reason:error instanceof Error?error.message:'Invalid selection'}; }
}
export function publishSelection(root:string,selection:CompetitionSelection,now=Date.now()):void {
  const checked=validate(root,selection,selection.dictionaryHash,now);
  if (existsSync(pointer(root))) {
    const previous=JSON.parse(readFileSync(pointer(root),'utf8'));
    atomicWriteJson(join(root,'models','active-selection.previous.json'),previous);
  }
  atomicWriteJson(pointer(root),checked);
}
