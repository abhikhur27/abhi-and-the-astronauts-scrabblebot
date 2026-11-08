import { readFileSync,statSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { loadArtifact,type ArtifactReference,normalizedEndgameOptions } from './competition-store.js';
import { EXECUTION_PROTOCOL_VERSION } from './coordinated-policy.js';
import { ENDGAME_POLICY_VERSION } from './endgame.js';
import { REINVEST_POLICY_VERSION,normalizedReinvestmentOptions } from './reinvest.js';
import { isFrozenPolicySpec,type PolicySpec } from './policy-spec.js';
import type { Strategy } from './live-session.js';
import { validateDiluteResidualProfile } from './dilute-profile.js';
export interface ChampionPin {
 schema:'scrabblebot-champion-pin-v1';dictionaryHash:string;executionProtocol:typeof EXECUTION_PROTOCOL_VERSION;
 generation:string;strategy:Strategy;candidate:string;reason:string;report:ArtifactReference;spec:ArtifactReference;
}
export interface ChampionPinReceipt {generation:string;strategy:Strategy;candidate:string;reason:string;pinSha256:string;specSha256:string;reportSha256:string;automaticGateEligible:boolean;frozen:true;learningEnabled:false;}
export interface LoadedChampionPin {spec:PolicySpec;receipt:ChampionPinReceipt;}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Deliberate owner selection is separate from, and never edits, automatic gate approval. */
export function loadChampionPin(root:string,file:string,dictionaryHash:string):LoadedChampionPin {
 if(isAbsolute(file)||!file)throw new Error('Champion pin must be root-relative');
 const path=resolve(root,file),rel=relative(resolve(root),path);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Champion pin escapes root');
 if(statSync(path).size>100_000)throw new Error('Champion pin exceeds size limit');
 const bytes=readFileSync(path),pin=JSON.parse(bytes.toString('utf8')) as ChampionPin;
 if(pin.schema!=='scrabblebot-champion-pin-v1'||pin.dictionaryHash!==dictionaryHash)throw new Error('Champion pin schema/dictionary mismatch');
 if(pin.executionProtocol!==EXECUTION_PROTOCOL_VERSION||!pin.generation||typeof pin.generation!=='string'||pin.generation.length>160||typeof pin.reason!=='string'||!pin.reason||pin.reason.length>2000||!['math','learner','dilute'].includes(pin.strategy))throw new Error('Invalid champion pin configuration');
 const report=loadArtifact<any>(root,pin.report),spec=loadArtifact<PolicySpec>(root,pin.spec);
 if(report.schema!=='scrabblebot-league-v1'||report.completed!==true||report.primaryObjective!=='win-share'||report.executionProtocol!==EXECUTION_PROTOCOL_VERSION||report.frozen?.verified!==true||report.frozen?.unchanged!==true)throw new Error('Champion requires a completed frozen report');
 const exactSpecBound=report.candidateSpecsSha256?.[pin.candidate]===pin.spec.sha256;
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(pin.candidate)||!exactSpecBound&&!['frozen-v2','math-candidate','learner-candidate','dilute-candidate','reinvest-candidate','endgame-candidate'].includes(pin.candidate))throw new Error('Unsupported champion candidate');
 for(const mode of ['Vickrey','FirstPrice']){
  const result=report.modes?.find((row:any)=>row.auctionType===mode),rank=result?.ranking?.find((row:any)=>row.name===pin.candidate);
  if(!result||!Number.isSafeInteger(result.completedSeedBlocks)||result.completedSeedBlocks<6||!rank||['invalidBids','invalidWords','exceptions','lateBids','lateWords'].some(key=>rank.actions?.[key]!==0))throw new Error('Champion report lacks complete legal on-time results in both modes');
 }
 let core=spec,endgame:unknown,reinvestment:unknown,coordinated=0,depth=0;
 if(core.type==='learner'){
  if(pin.strategy!=='learner'||!exactSpecBound&&pin.candidate!=='learner-candidate'||core.model?.dictionaryHash!==dictionaryHash||core.options?.training!==false||core.options?.epsilon!==0||!core.anchor)throw new Error('Invalid frozen learner champion');
  core=core.anchor;
 }
 while(['coordinated','endgame','reinvestment'].includes(core.type)){
  if(++depth>4)throw new Error('Champion wrapper nesting exceeds limit');
  if(core.type==='coordinated'){coordinated++;core=core.base;}
  else if(core.type==='endgame'){if(endgame||coordinated)throw new Error('Invalid endgame wrapper ordering');endgame=normalizedEndgameOptions(core.options??{});core=core.base;}
  else if(core.type==='reinvestment'){if(reinvestment||coordinated)throw new Error('Invalid reinvestment wrapper ordering');reinvestment=normalizedReinvestmentOptions(core.options);core=core.base;}
 }
 if(coordinated!==1||endgame&&reinvestment||!isFrozenPolicySpec(spec))throw new Error('Champion must be one frozen coordinated policy');
 const config=report.candidateConfiguration??{};
 if(exactSpecBound){
  if(spec.type!=='learner'&&pin.strategy==='learner'||spec.type!=='learner'&&core.type==='dilute'&&pin.strategy!=='dilute'||core.type==='math'&&pin.strategy!=='math')throw new Error('Champion strategy does not match exact frozen spec');
 }else if(pin.candidate!=='frozen-v2'){
  if(!same(endgame,config.endgame?normalizedEndgameOptions(config.endgame):undefined)||!same(reinvestment,config.reinvestment?normalizedReinvestmentOptions(config.reinvestment):undefined))throw new Error('Champion foundation differs from evaluated configuration');
 }else if(endgame||reinvestment)throw new Error('Bare V2 champion must have no candidate foundation');
 if(endgame&&report.endgameRevision!==ENDGAME_POLICY_VERSION||reinvestment&&report.reinvestmentRevision!==REINVEST_POLICY_VERSION)throw new Error('Champion foundation source revision mismatch');
 if(exactSpecBound){
  if(!['v2','math','dilute'].includes(core.type))throw new Error('Unsupported frozen champion core');
  if(core.type==='dilute'&&(core.dictionaryHash!==dictionaryHash||!validateDiluteResidualProfile(core.profile,dictionaryHash)))throw new Error('Invalid frozen dilute champion');
 }else if(pin.candidate==='math-candidate'){
  if(pin.strategy!=='math'||core.type!=='math'||!same(core.options,config.math))throw new Error('Champion math options differ from evaluated configuration');
 }else if(pin.candidate==='dilute-candidate'){
  if(pin.strategy!=='dilute'||core.type!=='dilute'||core.dictionaryHash!==dictionaryHash||!validateDiluteResidualProfile(core.profile,dictionaryHash))throw new Error('Invalid frozen dilute champion');
 }else if(core.type!=='v2')throw new Error('Champion anchor differs from evaluated V2');
 return {spec:structuredClone(spec),receipt:{generation:pin.generation,strategy:pin.strategy,candidate:pin.candidate,reason:pin.reason,pinSha256:createHash('sha256').update(bytes).digest('hex'),specSha256:pin.spec.sha256,reportSha256:pin.report.sha256,automaticGateEligible:report.gates?.find((gate:any)=>gate.candidate===pin.candidate)?.eligible===true,frozen:true,learningEnabled:false}};
}
