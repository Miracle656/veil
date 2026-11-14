# Veil policies

Veil holds real money for real people on Stellar mainnet. These are the rules
we hold ourselves to. They are short on purpose: a rule nobody reads protects
nobody.

| Policy | What it covers |
|---|---|
| [User funds](USER_FUNDS.md) | What the code must never do with a key or a balance |
| [Releases](RELEASES.md) | What has to be true before a build reaches a user |
| [Incidents and reimbursement](INCIDENTS.md) | What we do when a user loses money or access |

**Status: draft, 2026-11-14.** Written after a user lost 31.07 USDC to a defect
in the app ([record](../incidents/2026-11-14-spending-account-loss.md)). The
engineering rules in *User funds* and *Releases* describe how the code and the
build pipeline already behave after that fix. The items marked **Decision
needed** in *Incidents and reimbursement* are the project owner's to set and
are proposals until confirmed.
