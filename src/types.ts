export type Rack = ReadonlyMap<string, number>;
export type AuctionType = "Vickrey" | "FirstPrice";
export interface OpponentEstimate {
  botId: string;
  rackSize: number;
  initialMinimum: Rack;
  rackMinimum: Rack;
  rackMaximum: Rack;
  rackMean: Rack;
}
export interface BeliefSample {
  weight: number;
  bag: Rack;
  opponentRacks: ReadonlyMap<string, Rack>;
}
export interface PublicInformation {
  consistent: boolean;
  completeHistory: boolean;
  knownOwnInitial: boolean;
  bagCount: number;
  observedAuctionCount: number;
  expectedBag: Rack;
  bagMinimum: Rack;
  bagMaximum: Rack;
  opponents: readonly OpponentEstimate[];
  samples: readonly BeliefSample[];
  effectiveSampleSize: number;
  market: { medianPayment: number; p75Payment: number; samples: number };
}
export interface DecisionContext {
  myRack: Rack;
  myBalance: number;
  myScore: number;
  tilesRemaining: number;
  auctionType: AuctionType;
  letter: string;
  opponents?: readonly { botId?: string; balance: number; score: number; isSimulated?:boolean }[];
  myBotId?: string;
  information?: PublicInformation;
  /** Our submitted amount for this still-open auction; never another player's bid. */
  committedBid?: number;
}
export interface Candidate { word: string; reward: number; }
export interface BotPolicy {
  decideBid(ctx: DecisionContext): number;
  chooseWord(ctx: DecisionContext): string | null;
}
