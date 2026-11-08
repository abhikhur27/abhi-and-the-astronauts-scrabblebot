# Bounded multicore research loop

The offline training process owns a bounded pool of CPU workers. This library
does not install a scheduler or another live client. Run offline training
separately from live play and choose process priorities appropriate to your host.

## Admission and measured execution

The example configuration requests four workers and four independent training replicas.
Before each league or training batch, the parent releases derived engine caches,
runs optional exposed garbage collection, yields, and reads currently available
memory. It admits at most the requested workers, at most four in total, at most
the logical CPU count minus two, and at most
`floor((availableMiB - 768) / 384)`, with a minimum serial fallback of one.
This is a conservative working-set estimate, not a claim that all requested
cores are available. Pool execution stops if available memory falls below512MiB.

Cycle progress records the requested count, admitted count, memory observation,
reserve and estimated footprint. League and training receipts separately record
the actual spawned worker count, thread IDs, elapsed time, stop reason and
termination. A serial fallback must not be reported as multicore execution.
The parent starts with `--expose-gc`; worker bootstrap flags are isolated so
Node's process-only flags do not prevent threads from starting.

No throughput gain or stronger policy is established merely by passing these
tests. Compare measured wall time, games per second, memory and live accepted
actions on the chosen execution host before claiming acceleration.

With `--cycle-interval-ms 300000`, the minimum interval between cycle starts is
five minutes. A longer cycle starts its successor immediately after finishing.
`--max-cycle-ms` controls the bounded work budget. Public-data fetches retain
their ten-minute cache/rate bound. The library default cycle interval remains
fifteen minutes, and every wait is clamped to the training cutoff.

## Reproducible frozen evaluation

League entries provide explicit data-only policy specifications. Each worker
constructs its own dictionary engine and fresh policies. Specifications cover
V2, mathematical options, public imitation profiles, frozen learner models and
the same commitment/endgame/reinvestment wrappers. Arbitrary closure source is
never serialized or evaluated. Custom closure factories retain the serial path.

Workers return full game results and raw action-duration samples/counts. The
parent sorts games by payment mode, seed block and rotation before aggregation;
it computes percentiles from all samples rather than averaging percentiles.
All six seat rotations remain one paired seed block. Both payment modes,
snapshot immutability, legality, the200ms wall-time budget and existing promotion
criteria remain required. Worker faults, cancellation, memory pressure or a
missing/late job make the evaluation incomplete; partial games cannot authorize
promotion. Every pool is terminated before its result is returned.

## Independent learning branches

Four replicas each start from the same copied checkpoint and train40 games.
They use disjoint reserved simulation seeds and independent actor streams derived
from cycle ID, replica index and episode. Each branch retains its own model and
lineage; weights, optimizer states and trained-game counters are not averaged
or added together. The parent alone writes checkpoint artifacts, including a
completed branch as it arrives.

A frozen development league compares the completed branches with V2 and public
teacher references in both payment modes. It selects one branch by win share,
then mean score; an incomplete comparison retains the parent checkpoint.
Aggregate completed episodes can be160 while the selected model's counter
increases only40. A separate fresh final league remains the only live-adoption
gate. Incomplete training/branch selection cannot cause a pointer update.

Training stops at the configured training cutoff, including discarding a game
that finishes after it. A bounded final frozen evaluation may use the existing
grace. Online and offline checkpoint writers remain separate.

## Development search and seed ownership

Every cycle reserves all training seeds and seven development chunks before
dispatching any work. Interrupted reservations are discarded rather than reused.
Existing math, patience, live-warmstart and Dilute/foundation development use
chunks0–3. Replica selection uses chunk4. Final held-out seed blocks occupy a
separate domain and never choose a development configuration.

Reinvestment development now includes the original four component variants,
aggressive completions at18/36/68 remaining tiles and balanced replenishment at68.
Two four-candidate heats use chunks3 and5, with V2 and a shared teacher reference.
Their winners face a common-field runoff on chunk6. Raw win rates from different
multiplayer heats are not compared directly. All three development stages use
both payment modes, and the chosen configuration still requires a fresh final
both-mode promotion gate.

## Verification boundary

Regression checks cover memory/CPU admission, serial-versus-worker seeded game
parity, real two-thread execution, frozen inputs, fault/cancel cleanup, independent
branch seeds and genuine updates, selected-branch counters, cutoff fallback and
the disjoint heat/runoff/final seed allocation. A small synthetic fixture proves
wiring and isolation, not competition strength. Deployment, achieved
throughput, current task health and actual live outcomes require dated receipts.
