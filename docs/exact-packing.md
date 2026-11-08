# Exact small-rack packing candidate — November 7, 2026

The audited `ACILRSTW` hand exposed a bounded-search limitation. The baseline planner values it at27 with `exact:false`; `CRAWLS`27 followed by `IT`2 is worth29. Adding the offered Y permits `SCRAWLY`45 followed by `IT`2, worth47, while the baseline returns45 with `exact:false`. Exact dictionary legality and repeated-tile consumption establish these attainable totals. They do not establish that buying the Y wins an adaptive multiplayer game.

## Separate opt-in method

`WordEngine.exactRedemptionPlan` exhaustively maximizes the total reward of disjoint words for a physical rack containing at most10 tiles. It uses the complete legal subanagram list, retains one deterministic spelling per anagram pattern, and represents physical tile copies by at most1,024 subset states. Every state either leaves its lowest indexed tile unused or assigns that tile to one legal word and solves the remaining subset. These cases exhaust every feasible packing, including repeated letters and multiple copies of the same word.

At10 tiles the loops inspect at most58,025 nonempty submasks across all states; only submasks containing the selected tile can produce a transition. Among equally valuable packings, the method prefers the highest-reward first component word using the existing deterministic reward/length/spelling order. This keeps its reported single-word refund executable; it never treats the full packing value as one immediate refund.

The result cache holds at most1,024 rack keys and returns independent result objects. Temporary subset arrays are discarded after each search. Invalid keys, negative/fractional counts, counts exceeding the standard physical letter distribution, or racks over10 tiles do not receive an exact certificate: the legacy feasible planner is used with `exact:false`. The full-game caller still must supply valid real inventory. This method is not a new validator for every legacy engine API.

The existing `redemptionPlan`, `potential`, and their caches are unchanged. `math-v2.ts`, math/learner cores and the default commitment planner retain their previous behavior. In particular, calling the opt-in method does not overwrite the baseline27/45 results.

## Candidate integration and adoption

Only candidate `EndgameBot` and `ReinvestmentBot` opt in for own-rack and offered-tile packing. Their source versions are both **`v3-exact-packing`**, so earlier controller reports cannot authorize these revisions. Rival scenario packing remains on the previous bounded planner; its uncertainty and lower-bound limitations remain. Finite-supply option estimates also retain their existing bounds and heuristic assumptions.

`explainCommittedWord` accepts an optional planner, defaulting to the unchanged legacy method. Candidate wrappers pass the exact method. A real committed Y bid can therefore preserve the `SCRAWLY` line instead of immediately selling `CITRALS`: keeping the awarded rack has value47; selling `CITRALS` first leaves only27 attainable in that local comparison. A proposed, rejected, zero or otherwise invalid commitment still cannot reserve letters. Baseline coordination continues to reject this comparison as uncertified.

The change does not alter execution ordering or its protocol version. Candidate-version checks and the existing fresh, frozen, both-mode promotion gates remain required. It has not established a general win-rate improvement, and implementation/testing does not itself activate it in live matches.

## Verification

The new API and candidate own-hand regression were first observed failing against the old implementation. The committed-Y opt-in and wrapper tests then failed against the default-only coordination path before that optional argument was implemented. All220 tests and the TypeScript build pass after the change.

Tests cover the full ENABLE29/47 lines, preservation of the baseline27/45 values, exhaustive whole-word search over72 small repeated-letter/unused-tile hands, repeated word use, independent cached results, unchanged caller inventory, physical-scope fallback, exact own gain, terminal liquidation and commitment lifecycle behavior.

A bounded200-rack full ENABLE probe on the development machine used physically sampled10-tile hands. Every plan was legal, exactly redeemable and at least as valuable as the legacy result;56 had higher values. With the test suite running concurrently, planner-only p50 was1.28ms, p95 6.58ms and maximum22.24ms (first cold call); cached p95 was0.013ms. Dictionary load, the rest of the policy, belief construction and network were excluded.

After the tests completed, a separate sequential probe exercised66 synthetic physical contexts, each with four joint bag/hand scenarios and five rivals, own racks0–10, and both payment modes. Across Endgame, balanced Reinvestment and aggressive Reinvestment,198 complete bid/word/cached-explanation paths were legal. Combined p50 was15.16ms, p95 41.05ms, p99 48.50ms and maximum57.18ms; none exceeded200ms. This includes the coordinated V2 base and controller search, but excludes dictionary initialization, constructing beliefs, network and deployment-host scheduling. It is bounded timing evidence, not a guarantee for all racks or the desktop.
