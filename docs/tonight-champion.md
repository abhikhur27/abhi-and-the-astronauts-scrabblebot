# Frozen champion for tonight

The owner requested one policy with the best observed win rate through tonight's face-off. This supersedes the earlier live three-policy rotation. A fresh common-field comparison uses identical held-out seeds, six seat rotations and both auction modes. Select by equally weighted mean win share across the modes, breaking ties by the weaker mode. Evaluation outcomes and uncertainty remain separate from automatic promotion eligibility.

`CHAMPION_PIN_FILE` activates an explicit, frozen policy snapshot. Its manifest binds the dictionary, execution protocol, completed frozen evaluation report and exact policy recipe by SHA-256. It requires legal actions and on-time decisions in both modes. It records whether the usual automatic statistical gate passed; a manual empirical choice never rewrites that gate.

The client loads the pin once at startup, uses fresh copies of the same tested policy for all casual and tournament matches, and ignores later automatic selections. Learning, exploration and policy rotation are disabled. A malformed configured pin fails startup. Runtime receipts identify the pin, recipe and report hashes. Credentials, runtime logs and checkpoint artifacts remain excluded from the public source repository.

An evaluation win rate is a result for that simulated field. It does not establish the same win rate against live opponents or prove a tournament entry. A public own-entry row and accepted live actions are separate receipts.
