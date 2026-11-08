/** Compact, completed-public-game statistics. Never a source of live hidden state. */
export type ArenaPhase = "early" | "middle" | "late";
export type ArenaSplit = "train" | "validation";
export interface ArenaTeacherRow {
  provenance: "public-completed-game-retrospective-teacher-own-rack";
  matchId: number; botId: number; teacher: string; auctionId: number;
  round: number; totalAuctions: number; remainingAuctions: number;
  phase: ArenaPhase; letter: string; rack: Record<string, number>;
  balance: number; score: number; opponentCount: number;
  auctionType: "Vickrey" | "FirstPrice";
  bidLabel: { type: "exact-winner-bid" | "censored-loser-upper-bound"; amount: number };
  paid: number; wordDuringAuction: boolean; split: ArenaSplit;
}
export interface ArenaWordRow {
  matchId: number; botId: number; teacher: string; round: number; totalAuctions: number;
  phase: ArenaPhase; word: string; reward: number; balance: number;
  rack: Record<string, number>; rackSize: number; split: ArenaSplit;
  sincePreviousWordMs: number | null;
}
export interface ArenaPlayerEvidence {
  botId: number; name: string; requested: boolean; eligible: boolean; selected: boolean;
  matches: number; observedActiveMatches: number; wins: number; pairwiseComparisons: number;
  pairwiseWinRate: number; pairwiseWilsonLower: number; meanScore: number;
  meanNormalizedScore: number; meanObservedActiveOpponents: number;
  opponentStrength: number; discoveryScore: number; lastMatchId: number; lastEndedAt: string;
  reason: string;
}
export interface ArenaQuantiles { count: number; p25: number | null; median: number | null; p75: number | null; }
export interface ArenaBidBand {
  phase: ArenaPhase | "all"; letterClass: "all" | "vowel" | "consonant";
  exactWinningBids: ArenaQuantiles; payments: ArenaQuantiles; winningBidFractions: ArenaQuantiles;
  balance: ArenaQuantiles; rackSize: ArenaQuantiles; meanVowelFraction: number | null;
  meanDuplicateTiles: number | null;
}
export interface ArenaProfile {
  schema: "scrabblebot-arena-profile-v1"; generation: string; generatedAt: string;
  source: "anonymous-public-completed-games"; dictionarySha256: string;
  cutoffMatchId: number; cutoffEndedAt: string; staleAfter: string;
  trainMatchIds: number[]; validationMatchIds: number[]; splitRule: "latest-whole-matches-held-out";
  teacherIds: number[]; teachers: ArenaPlayerEvidence[];
  counts: { teacherRows: number; trainingRows: number; validationRows: number; exactTrainingWins: number; censoredTrainingLosses: number; excludedAmbiguousTrainingWins: number; trainingWords: number };
  bidBands: ArenaBidBand[];
  letterBands: { letter: string; exactWinningBids: ArenaQuantiles; payments: ArenaQuantiles }[];
  wordBehavior: {
    count: number; lengths: Record<string, number>; earlySmallWords: number;
    roundFraction: ArenaQuantiles; rackSize: ArenaQuantiles; preWordBalance: ArenaQuantiles;
    sincePreviousWordMs: ArenaQuantiles;
  };
  limitations: string[];
}

export function arenaQuantiles(values: readonly number[]): ArenaQuantiles {
  const a = values.filter(Number.isFinite).sort((x,y)=>x-y);
  const at = (q: number) => a.length ? a[Math.floor((a.length-1)*q)] : null;
  return { count: a.length, p25: at(.25), median: at(.5), p75: at(.75) };
}
export function arenaPhase(round: number, total: number): ArenaPhase {
  return (round-1) < total/3 ? "early" : (round-1) < 2*total/3 ? "middle" : "late";
}
export function splitArenaMatches(matchIds: readonly number[], validationFraction=.2): { trainMatchIds: number[]; validationMatchIds: number[] } {
  const ids = [...new Set(matchIds)].sort((a,b)=>a-b);
  if(ids.length<2) return {trainMatchIds:ids,validationMatchIds:[]};
  const n = Math.min(ids.length-1, Math.max(1, Math.ceil(ids.length*Math.min(.5,Math.max(.1,validationFraction)))));
  return {trainMatchIds:ids.slice(0,-n),validationMatchIds:ids.slice(-n)};
}
const mean = (a: number[]) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
const rackSize = (r: Record<string,number>) => Object.values(r).reduce((x,y)=>x+y,0);

export function fitArenaProfile(
  rows: readonly ArenaTeacherRow[], words: readonly ArenaWordRow[],
  options: { generation: string; generatedAt: string; dictionarySha256: string; cutoffMatchId: number; cutoffEndedAt: string; staleAfter: string; teachers: readonly ArenaPlayerEvidence[]; trainMatchIds: readonly number[]; validationMatchIds: readonly number[] },
): ArenaProfile {
  const trainIds = new Set(options.trainMatchIds), validationIds = new Set(options.validationMatchIds);
  if([...trainIds].some(id=>validationIds.has(id))) throw new Error("Arena train/validation match overlap");
  if(rows.some(r=>r.split==="train"&&!trainIds.has(r.matchId) || r.split==="validation"&&!validationIds.has(r.matchId))) throw new Error("Arena row split disagrees with match split");
  const training = rows.filter(r=>r.split==="train");
  const exact = training.filter(r=>r.bidLabel.type==="exact-winner-bid"&&!r.wordDuringAuction);
  const bidBands: ArenaBidBand[]=[];
  for(const phase of ["all","early","middle","late"] as const)for(const letterClass of ["all","vowel","consonant"] as const) {
    const r=exact.filter(x=>(phase==="all"||x.phase===phase)&&(letterClass==="all"||("AEIOU".includes(x.letter)?"vowel":"consonant")===letterClass));
    bidBands.push({phase,letterClass,exactWinningBids:arenaQuantiles(r.map(x=>x.bidLabel.amount)),payments:arenaQuantiles(r.map(x=>x.paid)),winningBidFractions:arenaQuantiles(r.filter(x=>x.balance>0).map(x=>x.bidLabel.amount/x.balance)),balance:arenaQuantiles(r.map(x=>x.balance)),rackSize:arenaQuantiles(r.map(x=>rackSize(x.rack))),meanVowelFraction:mean(r.map(x=>Object.entries(x.rack).filter(([l])=>"AEIOU".includes(l)).reduce((a,[,n])=>a+n,0)/Math.max(1,rackSize(x.rack)))),meanDuplicateTiles:mean(r.map(x=>Object.values(x.rack).reduce((a,n)=>a+Math.max(0,n-1),0)))});
  }
  const trainingWords=words.filter(w=>w.split==="train"&&trainIds.has(w.matchId));
  return {
    schema:"scrabblebot-arena-profile-v1",generation:options.generation,generatedAt:options.generatedAt,
    source:"anonymous-public-completed-games",dictionarySha256:options.dictionarySha256,
    cutoffMatchId:options.cutoffMatchId,cutoffEndedAt:options.cutoffEndedAt,staleAfter:options.staleAfter,
    trainMatchIds:[...options.trainMatchIds],validationMatchIds:[...options.validationMatchIds],splitRule:"latest-whole-matches-held-out",
    teacherIds:options.teachers.filter(x=>x.selected&&x.eligible).map(x=>x.botId),teachers:options.teachers.map(x=>({...x})),
    counts:{teacherRows:rows.length,trainingRows:training.length,validationRows:rows.length-training.length,exactTrainingWins:exact.length,censoredTrainingLosses:training.filter(x=>x.bidLabel.type==="censored-loser-upper-bound").length,excludedAmbiguousTrainingWins:training.filter(x=>x.bidLabel.type==="exact-winner-bid"&&x.wordDuringAuction).length,trainingWords:trainingWords.length},
    bidBands,letterBands:[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter=>{const r=exact.filter(x=>x.letter===letter);return {letter,exactWinningBids:arenaQuantiles(r.map(x=>x.bidLabel.amount)),payments:arenaQuantiles(r.map(x=>x.paid))};}),
    wordBehavior:{count:trainingWords.length,lengths:trainingWords.reduce<Record<string,number>>((a,w)=>(a[w.word.length]=(a[w.word.length]??0)+1,a),{}),earlySmallWords:trainingWords.filter(w=>w.round/w.totalAuctions<2/3&&w.word.length<5).length,roundFraction:arenaQuantiles(trainingWords.map(w=>w.round/w.totalAuctions)),rackSize:arenaQuantiles(trainingWords.map(w=>w.rackSize)),preWordBalance:arenaQuantiles(trainingWords.map(w=>w.balance)),sincePreviousWordMs:arenaQuantiles(trainingWords.flatMap(w=>w.sincePreviousWordMs===null?[]:[w.sincePreviousWordMs]))},
    limitations:["Exact teacher initial racks are reconstructed retrospectively from completed public histories for OFFLINE teacher-own-state imitation only; never live opponent inputs.","Winning bids are selected observations; loser bids are upper-bound censored, not zero. Payment is distinct from winning bid.","Auctions containing a teacher word between open and close have ambiguous bid-time features and are excluded from bid fitting.","Teacher selection and profile statistics use training matches only; latest whole matches are held out. Label validation is not a policy win-rate estimate.","No counterfactual winning or policy-improvement claim can be made from public traces alone."],
  };
}
