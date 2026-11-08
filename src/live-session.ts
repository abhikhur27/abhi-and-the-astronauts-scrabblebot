export type LiveMode = 'math' | 'learner' | 'dilute' | 'alternate' | 'rotate';
export type Strategy = 'math' | 'learner' | 'dilute';
export const POLICY_NAMES: Record<Strategy, string> = { math: 'AbhiAuction', learner: 'AbhiRL', dilute: 'AbhiDilute' };
export interface RegistrationTournament {
 id:bigint;status:{tag:string};createdAt:{microsSinceUnixEpoch:bigint};
 currentRound?:number;matchSize?:number;swissRoundsTotal?:number;topCut?:number;
}
export interface RegistrationEntry {id:bigint;tournamentId:bigint;botId:bigint;}
export type RegistrationChoice = {kind:'none';stateKey:string}
 | {kind:'ambiguous';stateKey:string;tournamentIds:string[]}
 | {kind:'candidate'|'already-entered';stateKey:string;tournamentId:bigint};
/** Select only an unambiguous recent Registration row; created_at is not a start time. */
export function selectRegistrationTournament(tournaments:Iterable<RegistrationTournament>,entries:Iterable<RegistrationEntry>,myBotId:bigint,earliestCreatedMs:number,nowMs:number):RegistrationChoice {
 if(!Number.isSafeInteger(earliestCreatedMs)||!Number.isSafeInteger(nowMs)||earliestCreatedMs>nowMs)return {kind:'none',stateKey:'none'};
 const minimum=BigInt(earliestCreatedMs)*1000n,maximum=BigInt(nowMs)*1000n;
 const recent=[...new Map([...tournaments].filter(row=>row.status.tag==='Registration'&&typeof row.createdAt.microsSinceUnixEpoch==='bigint'
  &&row.createdAt.microsSinceUnixEpoch>=minimum&&row.createdAt.microsSinceUnixEpoch<=maximum&&row.id>0n).map(row=>[String(row.id),row])).values()]
  .sort((left,right)=>left.id<right.id?-1:left.id>right.id?1:0);
 if(!recent.length)return {kind:'none',stateKey:'none'};
 const allEntries=[...entries];
 const stateKey=JSON.stringify(recent.map(row=>[String(row.id),row.status.tag,String(row.createdAt.microsSinceUnixEpoch),row.currentRound,row.matchSize,row.swissRoundsTotal,row.topCut,allEntries.filter(entry=>entry.tournamentId===row.id).length]));
 if(recent.length!==1)return {kind:'ambiguous',stateKey,tournamentIds:recent.map(row=>String(row.id))};
 const tournamentId=recent[0]!.id;
 return {kind:allEntries.some(entry=>entry.tournamentId===tournamentId&&entry.botId===myBotId)?'already-entered':'candidate',stateKey,tournamentId};
}
/** Bounded, reconnect-safe RPC attempts. An ACK is never an entry confirmation. */
export class TournamentRegistrationLatch {
 private readonly states=new Map<string,{attempts:number;lastAt:number;stateKey:string;inFlight:boolean;confirmed:boolean}>();
 constructor(private readonly maximumAttempts=3,private readonly cooldownMs=5000,private readonly retryAfterMs=30000) {
  if(!Number.isSafeInteger(maximumAttempts)||maximumAttempts<1||!Number.isFinite(cooldownMs)||cooldownMs<0||!Number.isFinite(retryAfterMs)||retryAfterMs<cooldownMs)throw new Error('Invalid registration retry bounds');
 }
 begin(tournamentId:bigint,nowMs:number,stateKey:string):number|undefined {
  if(tournamentId<=0n||!Number.isFinite(nowMs))return;
  const key=String(tournamentId),previous=this.states.get(key);
  if(previous&&(previous.confirmed||previous.inFlight||previous.attempts>=this.maximumAttempts||nowMs-previous.lastAt<this.cooldownMs
   ||(stateKey===previous.stateKey&&nowMs-previous.lastAt<this.retryAfterMs)))return;
  const attempts=(previous?.attempts??0)+1;
  this.states.set(key,{attempts,lastAt:nowMs,stateKey,inFlight:true,confirmed:false});return attempts;
 }
 settle(tournamentId:bigint,attempt:number):void {const current=this.states.get(String(tournamentId));if(current?.attempts===attempt)current.inFlight=false;}
 exhausted(tournamentId:bigint):boolean {const current=this.states.get(String(tournamentId));return !!current&&!current.confirmed&&!current.inFlight&&current.attempts>=this.maximumAttempts;}
 disconnected():void {for(const current of this.states.values())current.inFlight=false;}
 confirm(tournamentId:bigint):boolean {
  const key=String(tournamentId),current=this.states.get(key);
  if(current?.confirmed)return false;
  this.states.set(key,{attempts:current?.attempts??0,lastAt:current?.lastAt??0,stateKey:current?.stateKey??'',inFlight:false,confirmed:true});return true;
 }
}
/** Tournament links are separate from match_state; index once, never scan on bids. */
export class TournamentMatchIndex {
 private readonly links=new Map<string,string>();
 replace(rows:Iterable<{matchId:bigint;tournamentId:bigint}>):void{this.links.clear();for(const row of rows)this.set(row);}
 set(row:{matchId:bigint;tournamentId:bigint}):void{this.links.set(String(row.matchId),String(row.tournamentId));}
 delete(matchId:bigint):void{this.links.delete(String(matchId));}
 get(matchId:bigint|string):string|undefined{return this.links.get(String(matchId));}
}
export interface RotationState { schema: 'scrabblebot-rotation-v1' | 'scrabblebot-rotation-v2'; mode: LiveMode; next: number; assignments: Record<string, Strategy>; }
export class MatchRotation {
  private next = 0;
  private readonly assignments = new Map<string, Strategy>();
  constructor(private readonly mode: LiveMode, saved?: RotationState) {
    if (saved) {
      const migrating = saved.schema === 'scrabblebot-rotation-v1' && saved.mode === 'alternate' && mode === 'rotate';
      if (!['scrabblebot-rotation-v1', 'scrabblebot-rotation-v2'].includes(saved.schema) || (!migrating && saved.mode !== mode) || !Number.isSafeInteger(saved.next) || saved.next < 0) throw new Error('Invalid live rotation state');
      this.next = migrating ? 0 : saved.next;
      for (const [id, label] of Object.entries(saved.assignments)) {
        if (!/^\d+$/.test(id) || !['math', 'learner', 'dilute'].includes(label)) throw new Error('Invalid live match assignment');
        this.assignments.set(id, label);
      }
    }
  }
  choose(matchId: string): Strategy {
    if (!/^\d+$/.test(matchId)) throw new Error('Invalid match id');
    const existing = this.assignments.get(matchId);
    if (existing) return existing;
    const label = this.mode === 'rotate' ? (['math', 'learner', 'dilute'] as const)[this.next++ % 3]! : this.mode === 'alternate' ? (this.next++ % 2 === 0 ? 'math' : 'learner') : this.mode;
    this.assignments.set(matchId, label);
    return label;
  }
  snapshot(): RotationState { return { schema: 'scrabblebot-rotation-v2', mode: this.mode, next: this.next, assignments: Object.fromEntries(this.assignments) }; }
}

/** SDK id.find scans tables. Keep repeated action dispatch independent of global history. */
export class LiveMatchIndex<M extends { id: bigint; status: { tag: string } }, P extends { matchId: bigint; botId: bigint }> {
  private states = new Map<string, M>();
  private own = new Map<string, P>();
  constructor(private readonly myBotId: bigint) {}
  replaceStates(rows: Iterable<M>): void { this.states.clear(); for (const row of rows) this.state(row); }
  replaceParticipants(rows: Iterable<P>): void { this.own.clear(); for (const row of rows) this.participant(row); }
  state(row: M): void { this.states.set(String(row.id), row); }
  participant(row: P): void { if (row.botId === this.myBotId) this.own.set(String(row.matchId), row); }
  deleteState(id: bigint): void { this.states.delete(String(id)); }
  deleteParticipant(row: P): void { if (row.botId === this.myBotId) this.own.delete(String(row.matchId)); }
  get(id: bigint | string): M | undefined { return this.states.get(String(id)); }
  mine(id: bigint | string): P | undefined { return this.own.get(String(id)); }
  running(): M[] {
    const result: M[] = [];
    for (const id of this.own.keys()) { const row = this.states.get(id); if (row?.status.tag === 'Running') result.push(row); }
    return result;
  }
}
export function matchQueries(matchId: bigint): string[] {
  if (matchId < 0n) throw new Error('Invalid match id');
  return ['match_participant', 'auction', 'auction_result', 'word_play'].map(table => `SELECT * FROM ${table} WHERE match_id = ${matchId}`);
}
