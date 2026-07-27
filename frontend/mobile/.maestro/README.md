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
    send.yaml              send form, including prefill from a link
    receive.yaml           receive address and requested-amount links
    deep-link.yaml         cold-start and warm-resume routing for every scheme
    passkey-smoke.yaml     real-device only; tagged `device`
  subflows/                shared fragments pulled in with `runFlow`
    launch-fresh.yaml      cold start from wiped state
    skip-tutorial.yaml     dismiss the first-run tutorial (backlog #27)
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
itself the thing under test, or for system UI that has no testID (the biometric
prompt). Rewording a label should not break a flow.

**Every flow cold-starts from wiped state** via `subflows/launch-fresh.yaml`, so
flows cannot leak state into each other and their order never matters.

**The first-run tutorial is skipped, not exercised.** `launch-fresh.yaml` passes
a `skipTutorial` launch argument, and `skip-tutorial.yaml` dismisses the overlay
if it renders anyway. This mirrors the web suite pre-seeding `veil_seen_tutorial`
in localStorage, where the overlay would otherwise swallow the first tap. The
tutorial itself (backlog #27) deserves its own flow once it ships.

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

The screens are still placeholders; no wallet SDK is wired up. The flows assert
what exists today — routing, form prefill, and the shape of each screen — and
are laid out so the assertions deepen in place as the real logic lands:

| Flow | Asserted now | Extends to |
| --- | --- | --- |
| `create-wallet` | onboarding tap-through, wallet-created state | real passkey registration and factory deploy (backlog #25) |
| `send` | route, prefill contract, link-driven prefill | fee estimation, signing, submission |
| `receive` | address display, requested-amount links | QR rendering and share sheet (backlog #41) |
| `deep-link` | routing for all three schemes, both launch paths | SEP-7 validation and confirmation (backlog #38) |
| `passkey-smoke` | prompt raised, app recovers | unlock-with-passkey after a cold restart |
