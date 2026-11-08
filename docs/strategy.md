# Strategy and evaluation design

The fixed V2 core values marginal rack utility, immediate multiword redemption, finite remaining opportunity and cash as working capital. Complementary letters make this a repeated auction problem rather than a setting where isolated Vickrey bids can simply be called truthful. Packing and potential searches use explicit resource limits; `exact:false` is not a proof of optimality.

The shared tracker maintains feasible integer joint scenarios for unseen starts, opponent purchases/consumption and the remaining bag. All allocations conserve physical tiles. Marginal means are summaries, never literal legal racks. Finite completion estimates use sampling without replacement; two missing letters need their joint event. Auction selection and opponent behavior still affect whether this bot will personally acquire those letters.

A current own commitment can protect rack letters needed for the offered completion. Confirmed own cashouts can trigger bounded bid updates. The terminal cash guard applies only to the last usable offer, with exact zero own redemption before and after it and verified external rivals; it cannot treat an internal simulated bot as an ordinary external client.

The RL model is a bounded residual actor/critic anchored to the fixed policy. Training uses completed episode returns and decision-time own/public features. Legacy schemas migrate explicitly. Baseline-only live episodes can update the critic without fabricated actor exploration credit. Offline experiments train on disjoint seeds; frozen evaluation disables learning and exploration.

The imitation fit uses completed public games and reconstructable teacher-own histories as retrospective labels. Unknown losing bids are censored, not zero. Winner-selected observations and teacher selection bias limit causal conclusions. Combined and individual profiles are evaluated independently; no private opponent implementation is available.

Candidates must earn a fresh frozen win-share gate in both payment modes with all6 seat rotations. The independent unit is a complete seed block, not each correlated rotation. The evaluator reports approximate paired confidence bounds, legal-action and timing checks, and unchanged snapshots. Repeated adaptive testing and V2-based opponent surrogates remain practical limitations. A passing synthetic gate does not guarantee live or tournament superiority.

The research draws on standard auction theory, finite-population probability and reinforcement learning: [Vickrey's counter-speculation paper](https://doi.org/10.1111/j.1540-6261.1961.tb02789.x), [Milgrom and Weber's auction model](https://doi.org/10.2307/1911865), and [Sutton and Barto's reinforcement learning text](http://incompleteideas.net/book/the-book-2nd.html). These references motivate the design; they do not certify the heuristic coefficients or game strength.
