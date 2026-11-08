# Abhi ScrabbleBot

HackUTD team: **abhi and the astronauts**.

Open-source TypeScript bots for Clockwork Labs' real-time tile-auction and word-redemption challenge. This game has no Scrabble board.

The project provides three policy labels: **AbhiAuction** (fixed mathematical baseline), **AbhiRL** (bounded residual actor/critic), and **AbhiDilute** (bounded imitation fitted to completed public games). They share an exact dictionary trie, physical tile/opponent inference, commitment-aware actions, a simulator, and frozen evaluation. Candidate research is experimental; this repository does not claim a tournament win or a proven general win-rate advantage.

## Install and verify

Node.js22 or newer is required.

```sh
npm ci
npm run build
npm test
```

## Bounded local training

```sh
npm run train -- --games 10 --eval-games 4 --out runs/smoke/candidate.json
npm run evaluate -- --model runs/smoke/candidate.json --games 20 --seed 8000000
```

These commands exercise the simulator. Training progress is not evidence of competitive strength. The competition loop separately refreshes bounded public data, fits candidates, and uses independent seed blocks and both payment modes for frozen win-share gates. For one bounded loop run:

```sh
npm run competition -- --once --until 2026-11-08T04:20:00Z
```

Pass a future ISO8601 deadline appropriate to your event. Continuous looping requires the explicit `SCRABBLE_ALLOW_PERSISTENT_TRAINING=1` opt-in on your selected host. No persistent worker or scheduled job is installed by this repository.

## Authorized live play

Use your own account and team through the [official ScrabbleBot account page](https://scrabblebot.spacetimedb.com/account) and [official bot guide](https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/docs/bot-guide.md). Follow the event's GitHub-login, public-repository, and exact HackUTD-team-name requirements. This source alone does not establish account eligibility or register an entry.

Save your authorized bot token to an ignored private file. Never put it in source, a commit, a command argument, or a public issue. For example, in PowerShell:

```powershell
$env:BOT_KIND = 'rotate'
$env:BOT_NAME = 'scrabble-bot'
$env:BOT_TOKEN_FILE = './secrets/bot-token.txt'
$env:LIVE_UNTIL = '2026-11-08T05:50:00Z'
$env:LOBBY_UNTIL = '2026-11-08T04:32:00Z'
node --import tsx src/live.ts --check
npm run live
```

Choose future deadlines for your event. `math`, `learner`, and `dilute` select a fixed label; `rotate` assigns the three labels to whole matches on **one authorized identity**. Run only one client per credential. `BOT_LEARN=1` enables the live learner's separate checkpoint; keep offline and online writers separate. `MODEL_PATH` selects an initial compatible model. Runtime tokens, checkpoints and logs are ignored by Git.

Casual lobby joining stops at `LOBBY_UNTIL`; the client can remain connected for assigned tournament matches until `LIVE_UNTIL`. Tournament links are read from the official public table. The manager freezes its selected strategy and approved artifact bytes for each tournament, disables learner training/exploration, and isolates tournament models from the live checkpoint. `TOURNAMENT_POLICY=math`, `learner`, or `dilute` is an optional override; leaving it unset selects the available approved strategy conservatively. Connecting does not register an entry.

## Strategy and implementation

- [Game rules and source authority](docs/game-rules.md)
- [Mathematical and learning design](docs/strategy.md)
- [Experimental exact small-rack planner](docs/exact-packing.md): candidate-only subset dynamic programming for at most 10 tiles; source versions remain subject to frozen promotion gates. The default planner and immutable V2 baseline are preserved.
- `src/math-v2.ts`: preserved baseline core.
- `src/coordinated-policy.ts`: coordinated bids/cashouts and guarded terminal cash use.
- `src/belief.ts`: joint physical scenarios for hidden starts and remaining tiles.
- `src/model.ts`: residual actor/critic and checkpoint migration.
- `src/dilute-profile.ts`: winner-conditional public-data fitting with censored losing bids.
- `src/competition-loop.ts`, `src/league.ts`: bounded experimentation and held-out checks.
- `src/live.ts`, `src/live-policy.ts`: credential-file client and frozen tournament policy selection.

The simulator omits network jitter and treats its policy seats as external clients. Internal server padding bots have a distinct final-close action, so source-faithful external timing does not erase that asymmetry. Public teacher fits approximate observable behavior, not other players' private implementations.

## License and export

MIT; retain [third-party attribution](THIRD_PARTY.md) and [Clockwork Labs' license notice](licenses/clockworklabs-MIT.txt).

This is a clean source export. Source and tests were copied from the working bot implementation; the only export-specific code change replaces a machine-name restriction on continuous offline training with an explicit portable opt-in. Strategy and client behavior are otherwise preserved. Private deployment scripts, personal instructions, logs, checkpoints and repository history are excluded. `PUBLIC_SOURCE_MANIFEST.json` records packaged file hashes.
