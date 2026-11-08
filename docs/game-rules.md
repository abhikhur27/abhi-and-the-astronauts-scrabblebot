# Game rules and authority

This project targets the [Clockwork Labs ScrabbleBot challenge](https://github.com/clockworklabs/scrabblebot), using revision `b5ccb36aa238ad16692f8d6af54da15ef9f11324` as its source reference. A source pin is not proof of the currently deployed server revision. Generated schema and verified service behavior govern the protocol.

- The default game has98 standard letter tiles, no blanks,6 players,5 hidden starting tiles each and100 starting cash. Administrator configuration can differ.
- A word consumes owned letter multiplicities. Its reward is the integer floor of face-value sum times a length multiplier:1 for2–3letters,1.5 for4,2 for5,2.5 for6 and3 for7or more. It adds both score and cash; a bid spends cash without subtracting ranking score.
- Positive affordable integer bids compete in a sealed auction. Equal top bids are randomly resolved. Vickrey pays the runner-up/reserve; FirstPrice pays the winning bid. A bot can replace its own bid before the deadline.
- Revealed unsold tiles are consumed. The final auction ends atomically, so an external client has no word window to redeem its final award. The preceding award is the last ordinarily redeemable one.
- Own rack information is authorized by the bot credential. Public purchases and played words constrain unknown opponent starting tiles. Live winning bids remain private; completed-game archives can support offline labels.

Primary references: [letter values](https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/letters.ts), [game settlement and timing](https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/game.ts), [reducers and views](https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/index.ts), [schema](https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/schema.ts).
