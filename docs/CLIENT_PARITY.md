# Web and app parity

Which top-level surface each client has, and whether a difference is deliberate
or a gap. Web is `frontend/wallet/app`, the app is `frontend/mobile/app`. Written
for issue [#1218](https://github.com/Miracle656/veil/issues/1218).

When you add, remove or rename a top-level route in either client, update its
row here in the same PR. A gap closes in the direction given; a deliberate
difference needs a reason in the last column.

| Surface | Web | App | Status | Direction / reason |
|---|---|---|---|---|
| Create / sign in | `page.tsx` | `index`, `(onboarding)/welcome`, `create-wallet`, `login` | Both | Same job, split differently |
| Lock | `lock` | `lock` | Both | |
| Recover | `recover` | `recover` | Both | |
| Dashboard | `dashboard` | `(tabs)/dashboard` | Both | |
| Activity | `activity` | `transactions` | Both | Same surface, different route name |
| Send | `send` | `send` | Both | |
| Payment link entry | — | `pay` | Deliberate (app) | OS deep-link and SEP-7 target; forwards to Send, no UI of its own |
| Receive | `receive` | `receive` | Both | |
| Swap | `swap` | `swap` | Both | |
| Assets and token detail | `assets`, `assets/usdy`, `token/[code]` | `assets`, `token/[id]`, `token/usdy` | Both | |
| NFTs | `nfts` | `nfts` | Both | |
| Contacts | `contacts` | `contacts` | Both | |
| Earn | `earn` | `(tabs)/earn` | Both | |
| Invest (anchor directory) | `invest` | — | Gap → app | After the eligibility gate [#743](https://github.com/Miracle656/veil/issues/743); see [#735](https://github.com/Miracle656/veil/issues/735), [#737](https://github.com/Miracle656/veil/issues/737) |
| Buy (SEP-24 anchors) | `buy` | `buy` | Both | |
| Buy with naira | `buy-ngn` | — | Gap → app | Exists only on `feat/buy-with-naira`: [#1139](https://github.com/Miracle656/veil/issues/1139) |
| Verify (one-time NIN check) | `verify` | — | Gap → app | Live bug: airtime navigates to it, [#1200](https://github.com/Miracle656/veil/issues/1200) |
| Cash out | `cashout` | `cash-out` | Both | Same surface, different route name |
| Withdraw | `withdraw` | `withdraw` | Both | |
| Bills and airtime | `bills` | `airtime`; data, power, TV and bills tiles say "soon" | Gap, both ways | App: [#1133](https://github.com/Miracle656/veil/issues/1133), [#1140](https://github.com/Miracle656/veil/issues/1140). Web page says nothing is live: [#1131](https://github.com/Miracle656/veil/issues/1131) |
| Bulk payout | `bulk-payout` | `bulk-payout` | Both | |
| Multisig | `multisig` | `multisig` | Both | |
| Vault | `vault` | `vault` | Both | |
| Pools | `pools` | `pools` | Both | |
| Privacy | `privacy/{send,shield,unshield}` | `privacy/{index,send,shield,unshield}` | Gap → app | App screens have no prover: [#1202](https://github.com/Miracle656/veil/issues/1202), [#724](https://github.com/Miracle656/veil/issues/724) |
| dApp directory | `dapps` | `dapps` | Both | |
| dApp browser | — | `dapp`, `settings/permissions` | Deliberate (app) | On web the page is already in a browser and connects through WalletConnect. Wallet injection: [#1053](https://github.com/Miracle656/veil/issues/1053) |
| Agent | `agent`, `settings/agent` | `(tabs)/agent`, agent options in `settings/profile` | Both | |
| Offline | `offline` | `offline` | Both | |
| Settings | `settings/*` | `(tabs)/settings`, `settings/*` | Both | App-only pages are deliberate: `reveal-secret` (keypair wallets on phones without passkeys) and `voice` (phone assistants). `backup` and `recovery` are inline on web's settings page, and the network switch is on web's lock screen |
| Dev-only screens | — | `fonts`, `ui`, `(tabs)/prover-spike`, `privacy/benchmark` | Deliberate (app) | Type specimen, primitives gallery and on-device prover measurements; not user surfaces |
| Server routes | `api/*`, `spp/circuits` | — | Deliberate (web) | Routes the web host serves, not screens |
