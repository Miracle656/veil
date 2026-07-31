# Maestro e2e flows

Device tests for the critical mobile paths, ported from the Playwright suite in
[`frontend/wallet/e2e/`](../../wallet/e2e). Same scenarios, different runner:
Maestro drives a real app on a real (or virtual) device instead of a browser.

## Layout

```
.maestro/
  config.yaml              workspace config — entry points and default tag filter
  flows/                   one file per scenario; these are what `maestro test` runs
    create-wallet.yaml     onboarding through to a created wallet
    send.yaml              send form, validation, and prefill from a link
    receive.yaml           address, QR, copy and share
    dashboard.yaml         first-run tutorial skip and the quick actions
    deep-link.yaml         cold-start and warm-resume routing for every scheme
    passkey-smoke.yaml     real-device only; tagged `device`
  subflows/                shared fragments pulled in with `runFlow`
    launch-fresh.yaml      cold start from wiped state
    dismiss-offline.yaml   get past the offline screen if the network is not up
    skip-tutorial.yaml     dismiss the first-run tutorial (backlog #27)
    open-dashboard.yaml    reach the dashboard tab from a wiped install
```

## Running

```bash
# Install Maestro (once)
curl -Ls "https://get.maestro.mobile.dev" | bash

cd frontend/mobile
npm run e2e            # emulator / simulator suite
npm run e2e:device     # real-device passkey smoke test
```

The app must be installed on the target device first. Deep links do not reach
the app through Expo Go, so build a dev client or a release build:

```bash
npx expo run:android      # or: npx expo run:ios
```

Maestro picks up whichever emulator or device is already booted. With several
attached, select one with `maestro --device <id> test .maestro`.

## Conventions

**Selectors are testIDs, never visible copy.** Every element a flow touches
carries a `testID` in the source, which maps to the Android resource id and the
iOS accessibility identifier. Text assertions are reserved for copy that is
itself the thing under test (a validation message, a "Copied" confirmation),
for tab-bar labels, and for system UI that has no testID. Rewording a heading
should not break a flow.

**Every flow cold-starts from wiped state** via `subflows/launch-fresh.yaml`, so
flows cannot leak state into each other and their order never matters. A wiped
install has no wallet address and no `veil_seen_welcome`, so `app/index.tsx`
routes it to the welcome screen — that is the fixed starting point.

**Reaching the tabs takes a deep link, for now.** `app/index.tsx` only routes to
`/dashboard` once a wallet address is in secure storage, and the placeholder
create-wallet screen does not persist one yet (backlog #25). `open-dashboard.yaml`
opens `veil://send` to mount the tab navigator and moves across the tab bar from
there. When registration starts persisting an address, that subflow is the one
place to change.

**The offline screen is defended against.** `ConnectivityGate` pushes `/offline`
whenever NetInfo positively reports no usable connection, and a freshly booted
CI emulator often has not finished bringing its network up. `dismiss-offline.yaml`
retries the probe and falls back to `back`, so a slow network delays a flow
instead of failing it.

## Tags

`core` covers everything that runs on an emulator. `device` marks flows needing
real hardware and is excluded by default in `config.yaml`.

```bash
maestro test .maestro                          # core suite (device flows excluded)
maestro test --include-tags device .maestro    # passkey smoke only
maestro test --include-tags deeplink .maestro  # one area
```

## The passkey smoke test

`passkey-smoke.yaml` is excluded from the default run because a stock emulator
has no enrolled credential, so the platform prompt either never appears or
cannot be answered. Run it against a device with a screen lock and Face ID /
fingerprint enrolled.

Maestro cannot press a physical fingerprint sensor: the operator authenticates
by hand while the flow waits (60s timeout). Everything either side of that
moment is asserted automatically, which covers the two failures that actually
show up in the field — the prompt never being raised, and the app failing to
recover once it is answered.

## Current coverage

Registration and payment submission are still placeholders. The flows assert
what exists today and are laid out so the assertions deepen in place as the real
logic lands:

| Flow | Asserted now | Extends to |
| --- | --- | --- |
| `create-wallet` | welcome entry points, creation tap-through, wallet-created state, entry routing on relaunch | real passkey registration and factory deploy (backlog #25) |
| `send` | route, recipient validation, submit gating, link-driven prefill | fee estimation, signing, submission |
| `receive` | address, copy confirmation, share affordance, tab round-trip | requested-amount rendering in the SEP-7 QR |
| `dashboard` | tutorial skip and its persistence, quick-action routing | balance and activity feed once the wallet is wired |
| `deep-link` | routing for all three schemes, both launch paths, fallback | SEP-7 validation and confirmation (backlog #38) |
| `passkey-smoke` | prompt raised, app recovers | unlock-with-passkey after a cold restart |

Where a flow asserts behaviour that is only correct because a feature is
unfinished — the create-wallet flow returning to itself instead of the dashboard,
for instance — the file says so, and names the assertion that replaces it.
