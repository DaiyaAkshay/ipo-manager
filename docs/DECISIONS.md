# Decisions

## 2026-10-02 — v0.3.9 integration and recovery checks

Combine `claude/backup-audit` at `69d2697` and `claude/fix-cipher-docs` at
`4527640` on the v0.3.8 base (`29c1cee`). The unrelated remove-captcha branch
is outside this release.

Preserve SQLite3MC's existing ChaCha20 vault format; the earlier SQLCipher
description was incorrect. Compatibility tests open a vault created with the
old pragmas and reject opening the new vault as SQLCipher.

Run `npm run test:native` on Windows to use Electron's Node ABI. Plain `npm test`
skips the encrypted SQLite tests because its native module targets Electron.
Use an ESM Vitest configuration for compatibility with Electron's Node runtime.
Recovery fixtures initialize the field key as normal app setup does, load the
Gmail dependency graph before timing operations, and always close the database
before deleting temporary synthetic vaults. Existing assertions are retained.

An absent document now stops backup publication/download/restore. A failed
Credential Manager write belongs inside database restore rollback. These checks
prevent success being reported for an incomplete or unusable recovered vault.

R2 is still a synchronization target: pruning can propagate, and the optional
mirror also follows pruning. Keep an independently retained offline copy and
protect recent objects with a bucket lock. Filenames and host metadata remain
plaintext. Live R2 credentials, live Gmail accounts and real banking data are
outside release verification; tests use synthetic data and an in-memory store.

## 2026-10-02 — v0.3.10 Windows device sync

Automatically merge only balance observations and append-only login history.
Before merging, compare the schema and all other table rows (including encrypted
credential bytes, documents, bids, portfolio reports and account identities).
Exclude balance/value timestamps and the audit log's local integer sequence.
Require matching KDF metadata, matching decrypted field keys and the remote
snapshot's SHA-256. Any difference falls back to the existing conflict choice.
This prevents independent integer account IDs from joining unrelated accounts.
No account additions, deletions or credential edits are merged automatically.

Balances use the newest successful fetch timestamp per account; retain the
value and timestamp together. New fetches use UTC ISO milliseconds. Equal-time
observations use a deterministic lexical value tie-break so both PCs converge;
that tie-break does not establish which fetch actually happened last. Keep PC
clocks synchronized. Null/failed reads do not erase a successful observation.
Audit history is a union by content with maximum multiplicity, ignoring locally
allocated IDs. Identical attempts from separate PCs at the same timestamp can
be indistinguishable. Audit deletion is not supported as a merged operation.
The merge transaction leaves the live DB open, then snapshots the union with
both histories in its lineage. A renderer reload uses the existing auto-sync
event. Upload failures retain the union locally and show the retry error.

Use timestamp + random UUID snapshot directory IDs to avoid simultaneous
writers claiming the same identity even with identical or skewed clocks.
Continue to read timestamp-only IDs and keep the encrypted DB, manifest and
root metadata format at version 1. Release version 0.3.10 and its changelog
record the naming contract change. Mixed 0.3.9/0.3.10 writers are unsafe: upgrade
all Windows PCs before resuming shared use. Android viewer compatibility with
new names is outside this Windows-only change.

Before trusting an existing remote ID, compare manifest bytes. Cache the
verification against local manifest SHA-256 and remote listing size/time to
avoid fetching every known manifest on every pass. Legacy identity collisions
stop replication while preserving both copies; they need manual recovery,
not a silent overwrite. The guard does not repair a lost upload from an older
build retroactively.

Reserve vault replacement synchronously before any asynchronous restore
preparation. A bank/broker operation reserves automation before its first DB
read or credential decryption. New logins cannot enter an ongoing restore,
and restores cannot enter an ongoing login. Recheck automation after network
preflight: the state can change while an R2 request is pending. This also covers
portfolio downloads and AU bid preparation/submission. Automatic sync defers;
manual sync returns an actionable wait message.

Offline edits remain local and reconcile after reconnect/unlock. Normal pushes
still settle for 90 seconds with a 30-second polling interval. A concurrent
balance merge publishes immediately after discovery. Shutdown can defer a
conflict until next unlock rather than swap a vault while closing. This is
eventual synchronization, not a live shared bank session or transaction system.

Verification uses synthetic encrypted vaults and an in-memory R2 transport.
Live banking portals, customer data, a real R2 bucket and physical multi-PC
network timing are not used by these tests.

Capture the live DB hash and document references synchronously with VACUUM,
before keychain/network awaits. The baseline of an uploaded snapshot must not
include edits that arrived during its upload; those edits remain dirty and
upload in the next pass. A regression test writes a second account balance
inside the object-store upload and verifies delivery in a later snapshot.

## 2026-10-03 — v0.3.10 release validation

109 tests pass under Electron's native runtime, with no skips. TypeScript
passes and the production bundle/Windows NSIS build succeed. The packaged
version is 0.3.10; compiled main, preload and renderer hashes match the ASAR.
A fresh synthetic profile displays the master-password screen. The updater's
SHA-512 and size match the rebuilt installer. Existing build notices about the
AI usage import/chunk size, default icon and absent signing certificate remain.
No live vault was opened or modified. Installer installation on a real profile,
live R2/Gmail/banking integration and physical multi-PC timing are not verified.
