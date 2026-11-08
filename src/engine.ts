import type { Candidate, Rack } from "./types.js";

export const LETTER_VALUES: Readonly<Record<string, number>> = Object.freeze({
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5,
  L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1,
  V: 4, W: 4, X: 8, Y: 4, Z: 10,
});

// Public initial distribution, never the simulator's or server's hidden bag.
export const BAG_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1,
  L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4,
  V: 2, W: 2, X: 1, Y: 2, Z: 1,
});

export function wordReward(word: string): number {
  if (!/^[A-Z]{2,}$/.test(word)) return 0;
  let base = 0;
  for (const letter of word) base += LETTER_VALUES[letter]!;
  const numerator = word.length <= 3 ? 2 : word.length === 4 ? 3 : word.length === 5 ? 4 : word.length === 6 ? 5 : 6;
  return Math.floor(base * numerator / 2);
}

function rackCounts(rack: Rack): number[] {
  const counts = Array<number>(26).fill(0);
  for (const [letter, amount] of rack) {
    if (/^[A-Z]$/.test(letter) && Number.isFinite(amount) && amount > 0) {
      counts[letter.charCodeAt(0) - 65] = Math.floor(amount);
    }
  }
  return counts;
}

function countsKey(counts: readonly number[]): string { return counts.join(","); }

export function canSpell(word: string, rack: Rack): boolean {
  if (!/^[A-Z]{2,}$/.test(word)) return false;
  const counts = rackCounts(rack);
  for (const letter of word) if (--counts[letter.charCodeAt(0) - 65]! < 0) return false;
  return true;
}

export function withTile(rack: Rack, letter: string): Map<string, number> {
  const result = new Map(rack);
  result.set(letter, (result.get(letter) ?? 0) + 1);
  return result;
}

export function withoutWord(rack: Rack, word: string): Map<string, number> {
  const result = new Map(rack);
  for (const letter of word) {
    const next = (result.get(letter) ?? 0) - 1;
    if (next > 0) result.set(letter, next);
    else result.delete(letter);
  }
  return result;
}

interface TrieNode {
  children: Map<number, TrieNode>;
  candidate?: Candidate;
}

export interface RedemptionPlan { value: number; firstWord: string | null; exact: boolean; }
/** Integer physical bags; fractional draws interpolate adjacent draw counts. */
export interface AcquisitionSupply { weight: number; bag: Rack; draws: number; }
interface PackedCandidate extends Candidate { letters: readonly [number, number][]; }

function candidateOrder(a: Candidate, b: Candidate): number {
  return b.reward - a.reward || b.word.length - a.word.length || a.word.localeCompare(b.word);
}

function cacheResult<T>(cache: Map<string, T>, key: string, value: T, capacity: number): void {
  if (cache.size >= capacity) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

function fits(counts: readonly number[], letters: readonly [number, number][]): boolean {
  for (const [letter, amount] of letters) if (counts[letter]! < amount) return false;
  return true;
}

function packed(candidate: Candidate): PackedCandidate {
  const letters = new Map<number, number>();
  for (const letter of candidate.word) {
    const code = letter.charCodeAt(0) - 65;
    letters.set(code, (letters.get(code) ?? 0) + 1);
  }
  return {...candidate, letters: [...letters]};
}

// Approximate availability from the public starting distribution. Different
// missing letters are treated independently; competition is handled by the
// bidding policy, so this is an option-value heuristic rather than a forecast.
function availableProbability(draws: number, letter: number, needed: number): number {
  if (draws < needed) return 0;
  const p = BAG_COUNTS[String.fromCharCode(letter + 65)]! / 98;
  const none = (1 - p) ** draws;
  return needed === 1 ? 1 - none : Math.max(0, 1 - none - draws * p * (1 - p) ** (draws - 1));
}

// P(no marked tile) in a simple random sample without replacement. 98 tiles
// keeps this product short and avoids large binomial coefficients.
function noneOf(population: number, marked: number, draws: number): number {
  if (draws > population - marked) return 0;
  let probability = 1;
  for (let i = 0; i < draws; i++) probability *= (population - marked - i) / (population - i);
  return probability;
}

function finiteCompletion(counts: readonly number[], draws: number, missing: readonly number[]): number {
  const population = counts.reduce((sum, n) => sum + n, 0);
  const integerDraws = Math.max(0, Math.min(population, Math.floor(draws)));
  if (integerDraws < missing.length || missing.some(letter => counts[letter]! === 0)) return 0;
  const first = counts[missing[0]!]!;
  if (missing.length === 1) return 1 - noneOf(population, first, integerDraws);
  if (missing[0] !== missing[1]) {
    const second = counts[missing[1]!]!;
    // Inclusion-exclusion gives the joint event, unlike independent marginals.
    return Math.max(0, 1 - noneOf(population, first, integerDraws) - noneOf(population, second, integerDraws) + noneOf(population, first + second, integerDraws));
  }
  if (first < 2) return 0;
  const none = noneOf(population, first, integerDraws);
  const exactlyOne = first * integerDraws / population * noneOf(population - 1, first - 1, integerDraws - 1);
  return Math.max(0, 1 - none - exactlyOne);
}

export class WordEngine {
  private readonly root: TrieNode = {children: new Map()};
  private readonly playableCache = new Map<string, readonly Candidate[]>();
  private readonly potentialCache = new Map<string, number>();
  private readonly planCache = new Map<string, RedemptionPlan>();
  private readonly exactPlanCache = new Map<string, RedemptionPlan>();

  /** Release only derived search caches between owned offline worker games. */
  releaseCaches():void {
    this.playableCache.clear();this.potentialCache.clear();this.planCache.clear();this.exactPlanCache.clear();
  }

  constructor(words: readonly string[]) {
    for (const raw of words) {
      const word = raw.trim().toUpperCase();
      if (!/^[A-Z]{2,}$/.test(word)) continue;
      let node = this.root;
      for (const letter of word) {
        const code = letter.charCodeAt(0) - 65;
        let child = node.children.get(code);
        if (!child) { child = {children: new Map()}; node.children.set(code, child); }
        node = child;
      }
      node.candidate = {word, reward: wordReward(word)};
    }
  }

  /** Exact legal subanagrams. `limit` truncates only after complete search. */
  playable(rack: Rack, limit = Number.POSITIVE_INFINITY): Candidate[] {
    const counts = rackCounts(rack);
    const key = countsKey(counts);
    let candidates = this.playableCache.get(key);
    if (!candidates) {
      const found: Candidate[] = [];
      const visit = (node: TrieNode) => {
        if (node.candidate) found.push(node.candidate);
        for (const [letter, child] of node.children) {
          if (counts[letter]! <= 0) continue;
          counts[letter]!--;
          visit(child);
          counts[letter]!++;
        }
      };
      visit(this.root);
      candidates = found.sort(candidateOrder);
      cacheResult(this.playableCache, key, candidates, 2048);
    }
    return candidates.slice(0, Math.max(0, Math.floor(limit))).map(candidate => ({...candidate}));
  }

  /**
   * W(R)=max_w reward(w)+W(R-w), with deterministic resource limits.
   * If a rack needs more than 384 states or 128 candidate words, return a
   * feasible lower bound and exact:false. Legal move generation stays exact.
   */
  redemptionPlan(rack: Rack): RedemptionPlan {
    const counts = rackCounts(rack);
    const key = countsKey(counts);
    const cached = this.planCache.get(key);
    if (cached) return {...cached};
    const legal = this.playable(rack);
    const candidates = legal.slice(0, 128).map(packed);
    let exact = legal.length <= 128;
    let states = 0;
    const memo = new Map<string, {value: number; firstWord: string | null}>();
    const greedy = (remaining: number[]) => {
      const mutable = remaining.slice();
      let value = 0;
      let firstWord: string | null = null;
      for (const candidate of candidates) {
        while (fits(mutable, candidate.letters)) {
          for (const [letter, amount] of candidate.letters) mutable[letter]! -= amount;
          value += candidate.reward;
          firstWord ??= candidate.word;
        }
      }
      return {value, firstWord};
    };
    const solve = (remaining: number[]): {value: number; firstWord: string | null} => {
      const stateKey = countsKey(remaining);
      const found = memo.get(stateKey);
      if (found) return found;
      if (++states > 384) { exact = false; return greedy(remaining); }
      let best = {value: 0, firstWord: null as string | null};
      for (const candidate of candidates) {
        if (!fits(remaining, candidate.letters)) continue;
        const next = remaining.slice();
        for (const [letter, amount] of candidate.letters) next[letter]! -= amount;
        const value = candidate.reward + solve(next).value;
        if (value > best.value) best = {value, firstWord: candidate.word};
      }
      memo.set(stateKey, best);
      return best;
    };
    const plan = {...solve(counts), exact};
    cacheResult(this.planCache, key, plan, 1024);
    return {...plan};
  }

  /**
   * Opt-in complete packing for physical racks of at most ten tiles. The
   * baseline planner and its cache stay unchanged. Larger/invalid inputs use
   * its feasible fallback without claiming an exact certificate.
   */
  exactRedemptionPlan(rack: Rack): RedemptionPlan {
    const counts = rackCounts(rack);
    const total = counts.reduce((sum, n) => sum + n, 0);
    const physical = [...rack].every(([letter, amount]) => /^[A-Z]$/.test(letter)
      && Number.isSafeInteger(amount) && amount >= 0 && amount <= BAG_COUNTS[letter]!);
    if (!physical || total > 10) return {...this.redemptionPlan(rack), exact: false};
    const key = countsKey(counts);
    const cached = this.exactPlanCache.get(key);
    if (cached) return {...cached};

    // Equal letter multisets have equal reward. Keep the first deterministic
    // spelling of each pattern, then map every physical tile subset to it.
    const patterns = new Map<string, Candidate>();
    for (const candidate of this.playable(rack)) {
      const pattern = [...candidate.word].sort().join('');
      if (!patterns.has(pattern)) patterns.set(pattern, candidate);
    }
    const letters = counts.flatMap((amount, letter) => Array<string>(amount).fill(String.fromCharCode(65 + letter)));
    const states = 1 << total;
    const words = Array<Candidate | undefined>(states);
    for (let mask = 1; mask < states; mask++) {
      let pattern = '';
      for (let tile = 0; tile < total; tile++) if (mask & (1 << tile)) pattern += letters[tile];
      words[mask] = patterns.get(pattern);
    }
    const values = new Int32Array(states);
    const first = Array<Candidate | undefined>(states);
    const preferred = (left: Candidate, right?: Candidate): Candidate => !right || candidateOrder(left, right) <= 0 ? left : right;
    for (let mask = 1; mask < states; mask++) {
      const tile = mask & -mask;
      // In every packing this tile is either unused or belongs to exactly one
      // word. This recurrence enumerates both cases, including repeated tiles.
      values[mask] = values[mask ^ tile]!;
      first[mask] = first[mask ^ tile];
      for (let part = mask; part; part = (part - 1) & mask) {
        if (!(part & tile)) continue;
        const word = words[part];
        if (!word) continue;
        const remaining = mask ^ part;
        const value = word.reward + values[remaining]!;
        const firstWord = preferred(word, first[remaining]);
        if (value > values[mask]! || value === values[mask]! && (!first[mask] || candidateOrder(firstWord, first[mask]!) < 0)) {
          values[mask] = value;
          first[mask] = firstWord;
        }
      }
    }
    const plan = {value: values[states - 1]!, firstWord: first[states - 1]?.word ?? null, exact: true};
    cacheResult(this.exactPlanCache, key, plan, 1024);
    return {...plan};
  }

  /**
   * Current redemption plus a one/two-letter completion option, limited to
   * length ten and 30,000 trie visits. This heuristic can miss a promising
   * target when its budget is reached; `playable` remains an exact search.
   */
  potential(rack: Rack, tilesRemaining: number, supplies?: readonly AcquisitionSupply[]): number {
    const counts = rackCounts(rack);
    const total = counts.reduce((sum, n) => sum + n, 0);
    if (total === 0) return 0;
    const horizon = Number.isFinite(tilesRemaining) ? Math.max(0, Math.min(98, Math.floor(tilesRemaining))) : 0;
    const validSupplies = supplies?.filter(supply => Number.isFinite(supply.weight) && supply.weight > 0)
      .map(supply => ({weight:supply.weight, counts:rackCounts(supply.bag), draws:Math.max(0, Number.isFinite(supply.draws) ? supply.draws : 0)}));
    const supplyKey = validSupplies ? validSupplies.map(supply => `${supply.weight}:${countsKey(supply.counts)}:${supply.draws.toFixed(3)}`).join(";") : "prior";
    const key = `${countsKey(counts)}:${horizon}:${supplyKey}`;
    const cached = this.potentialCache.get(key);
    if (cached !== undefined) return cached;
    const currentRedemption = this.redemptionPlan(rack).value;
    let best = currentRedemption;
    if (horizon === 0) return best;
    const residualCandidates = this.playable(rack, 12).map(packed);
    const missing: number[] = [];
    const oneMissing = Array.from({length: 26}, (_, letter) => availableProbability(horizon, letter, 1));
    const twoMissing = Array.from({length: 26}, (_, letter) => availableProbability(horizon, letter, 2));
    const probabilityCache = new Map<string, number>();
    const completionProbability = (needed: readonly number[]) => {
      if (!validSupplies) return needed.length === 1 ? oneMissing[needed[0]!]!
        : needed[0] === needed[1] ? twoMissing[needed[0]!]!
        : oneMissing[needed[0]!]! * oneMissing[needed[1]!]!;
      const missingKey = [...needed].sort((a,b)=>a-b).join(",");
      const found = probabilityCache.get(missingKey);
      if (found !== undefined) return found;
      let total = 0; let mass = 0;
      for (const supply of validSupplies) {
        const draws = Math.min(horizon, supply.draws);
        const low = Math.floor(draws); const fraction = draws - low;
        const probability = finiteCompletion(supply.counts, low, needed) * (1 - fraction)
          + (fraction > 0 ? finiteCompletion(supply.counts, low + 1, needed) * fraction : 0);
        total += probability * supply.weight; mass += supply.weight;
      }
      const result = mass > 0 ? Math.max(0,Math.min(1,total / mass)) : 0;
      probabilityCache.set(missingKey,result);
      return result;
    };
    const maxLength = Math.min(10, total + 2);
    let visited = 0;
    const visit = (node: TrieNode, depth: number, deficit: number, used: number) => {
      if (++visited > 30_000) return;
      if (node.candidate && deficit > 0 && used > 0) {
        const probability = completionProbability(missing);
        let residualReward = 0;
        for (const candidate of residualCandidates) {
          if (fits(counts, candidate.letters)) { residualReward = candidate.reward; break; }
        }
        // Waiting for a missing letter does not destroy the original rack.
        // With finite supplies, retain its liquidation value on failure and
        // probability-weight only the incremental successful completion.
        // The original prior branch stays identical for frozen V2 replay.
        const option = validSupplies
          ? currentRedemption + Math.max(0,residualReward+node.candidate.reward-currentRedemption) * probability * 0.96 ** deficit
          : residualReward + node.candidate.reward * probability * 0.96 ** deficit;
        best = Math.max(best, option);
      }
      if (depth >= maxLength) return;
      for (const [letter, child] of node.children) {
        if (counts[letter]! > 0) {
          counts[letter]!--;
          visit(child, depth + 1, deficit, used + 1);
          counts[letter]!++;
        } else if (deficit < 2 && deficit < horizon) {
          missing.push(letter);
          visit(child, depth + 1, deficit + 1, used);
          missing.pop();
        }
      }
    };
    visit(this.root, 0, 0, 0);
    cacheResult(this.potentialCache, key, best, 2048);
    return best;
  }
}
