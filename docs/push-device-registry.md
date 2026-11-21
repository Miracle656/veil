# Push device registry — implementation blocker

**Issue:** [#1274](https://github.com/Miracle656/veil/issues/1274)  
**Date:** 2026-11-21  
**Status:** Blocked — the Wraith backend checkout is not available in this workspace

This is a Wraith/Postgres/Prisma backend feature, not a Veil app feature.
No implementation was added to Veil application code. The Wraith repository
must be provided or checked out before the schema, routes, sender integration,
logging controls, and tests can be changed.

## Repository block

This workspace contains the Veil repository only. The only discovered Wraith
references are issue and architecture documents under `scripts/`. No Wraith
source tree, Prisma schema, package manifest, test suite, or migration directory
is present locally.

## Required implementation plan

### Data model

Add one new Prisma model, `PushDevice`, with:

- `installId` as the opaque, client-generated primary or unique install key
- `token` as a unique Expo push token
- `platform` constrained to `ios` or `android`
- nullable or defaulted `appVersion` and `locale`
- category preferences as a defaulted JSON column or defaulted category fields
- `createdAt` and `updatedAt`

The table must contain no wallet address, public key, passkey or credential ID,
NIN, IP address, auth foreign key, or other wallet/user relationship.

The migration must add a table only. It must not rename, drop, retype, or alter
existing Prisma models or columns.

### Routes

- `POST /push/devices`
  - Upsert by install identity and/or token; a token remains unique.
  - Re-registering the same token updates metadata and preferences.
  - Reject bad Expo token shapes, bad platforms, overlong strings, unknown fields,
    and invalid category values.
  - Return a minimal success response that does not reveal whether the token
    was previously registered and never echoes the token.
- `DELETE /push/devices/:token`
  - Delete matching rows.
  - Return 204 for both existing and unknown tokens.
- `PATCH /push/devices/:installId/preferences` or an equivalent upsert field
  - Read/update category preferences without using wallet identifiers.
  - Provide a server-side selector filtered by category.

Existing Wraith validation, error, logging, and rate-limit conventions must be
used in the real checkout.

### Privacy and logs

- Never log a push token in full.
- Mask token values in request access logs, error logs, and delete-path logs.
- Do not log request auth headers or wallet identifiers in these handlers.
- Do not add IP storage.
- Apply tighter unauthenticated rate limits to both routes.
- Redact or reject unknown fields rather than accepting and ignoring them.

### Expo sender integration

When Wraith's Expo sender is found:

- On `DeviceNotRegistered`, call `removeDeviceByToken(token)`.
- Add `removeDeviceByToken(token)` as an internal helper even if no sender is
  wired yet.
- Provide `selectDevicesByCategory(category)` or an equivalent server-side
  helper for notification sends.

No Expo sender integration exists in the discovered Veil repository evidence.
The actual Wraith sender client must be inspected in Wraith.

## Category preference assumption

No consent/category preference model was found in the Wraith references or issue
text available in this workspace. The implementation should use a flexible,
defaulted JSON category preference structure until the consent issue is found.
The sender and mobile client must agree on category names before production use.

Open category questions:

- Are preferences a per-install allow/deny map or separate category booleans?
- Are category names fixed or namespaced?
- What is the default for a newly registered install?
- Is a missing preference opt-in or opt-out?
- Is preference revocation audit relevant?

## Verification plan

In Wraith, add tests for:

- create
- token upsert preserving one row and later metadata
- delete existing
- delete unknown returns success
- preference set/read/filter
- bad token, platform, and unknown fields
- route rate limits
- privacy schema and full-token log grep checks

Run the real Wraith commands after checkout:

```sh
npm ci
npx tsc --noEmit
npm test
```

Run the real Prisma startup/diff commands documented by Wraith. The acceptance
check is that `prisma migrate diff` or an equivalent diff contains no
`DROP TABLE`, `DROP COLUMN`, `ALTER TABLE`, rename, or retype destructive
statement.

## Required next step

Open or clone the sibling `Miracle656/wraith` repository beside Veil, then
implement this plan there on the Wraith branch
`feat/1274-push-device-registry`. This Veil branch is a blocker artifact only.
