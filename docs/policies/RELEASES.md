# Releases

What has to be true before an Android build reaches a user.

## Where builds come from

- Community APKs are built only by the `mobile-apk.yml` workflow, from the
  `integration/release-next` branch. Not from `main`, and not from Expo's cloud.
- A build is started only when the project owner asks for one.
- The only download link given to users is
  `https://github.com/Miracle656/veil/releases/latest/download/veil.apk`.
  GitHub points it at the newest release, so it cannot go stale. A link to a
  numbered file can, and the website served build 26 for a day after build 28
  was out.

## Checks the workflow enforces

The workflow refuses to publish when any of these fail:

| Check | Why it exists |
|---|---|
| Signing certificate matches `assetlinks.json` | A build signed with another key cannot install over the app, and passkeys stop working |
| Passkey module links against the libraries in the APK | Builds 20 to 27 could not create a wallet; signing in still worked, so nobody noticed |

## Checks a person does before the link is shared

A build that passes the workflow is not a build that works. Before telling
users about it:

1. **Create a new wallet on a phone that has never had Veil.** Signing in with
   an existing wallet does not test this. Five builds shipped unable to create
   a wallet because every tester already had one.
2. **Install over the previous build** on a phone that has a wallet, and
   confirm the wallet and balance are still there.
3. **Download from the public link on mobile data**, on a phone, and install
   the file that arrives. Do not test with a file passed between phones.
4. **Send, receive, and one naira payment** (airtime is cheapest).
5. **Open the dashboard and Receive** on a wallet and confirm the address
   shown is the one that holds the balance.

Record who ran the checks, on which phone, and the build number in the release
notes. If a check was skipped, say so there.

## When a build is bad

- Say so in the release notes of that build and mark the release as a
  pre-release so it is no longer "latest".
- Do not delete the release: someone has it installed and needs to be able to
  see what it was.
- The fix ships as a new build number. A build number is never reused.

## Not covered yet

- A signed-out user cannot see which build they have installed. This cost a
  day on 2026-11-12.
- Some phones refuse to install a build they downloaded themselves and accept
  the same file sent from another phone. The cause is not known.
