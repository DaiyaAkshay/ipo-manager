# Windows device synchronization audit — 2 October 2026

Reviewed v0.3.9 at `beeedad`, with synthetic encrypted vaults and an in-memory
R2 transport. No live vault, R2 credentials, Gmail account or bank was accessed.

## Does a fetched bank balance reach every PC?

Yes, on the ordinary single-writer path. A successful fetch writes `balance`
and `balance_fetched_at` into `bank_accounts` (`ipc.ts:1483`). The app snapshots
the whole encrypted database and replicates it to the configured target. Other
clean PCs restore the newer snapshot. Their Dashboard receives `vault:autoSynced`,
clears cached members and reloads balances (`Dashboard.tsx:934`). A failed scrape
preserves the previous value and timestamp; synchronization does not fetch banks
again on receiving PCs.

Every PC must use the same shared vault, backup target and R2 account/bucket/prefix
(or the same genuinely shared folder). R2 must be enabled and each PC must have
valid object credentials. Folder-mode and R2-mode PCs do not share updates with
each other. The software has no separate per-user subscription or permission
system: an authorized PC receives the shared vault's contents.

Automatic sync runs every 30 seconds while unlocked (`ipc.ts:161`). Upload waits
until the source database hash has remained unchanged for 90 seconds
(`engine.ts:1471`). Typical delivery is approximately 90–150 seconds after the
last database write, plus network and processing time; it is not a delivery
guarantee. More writes restart the settling period. A bank/broker automation
defers automatic pushes and pulls. An offline, closed or locked receiver catches
up after reconnection/unlock. Lock/quit attempts an immediate source flush, but
network failure, conflicts or the exit deadline can defer it.

## Confirmed limitations and defects

### P1 — identical snapshot IDs can silently strand different balances

`engine.ts:579` allocates a timestamp-only ID from the local cache's head. Two
PCs with stale caches can independently allocate the same ID. This is especially
reproducible when both clocks are behind their common base: both choose base +
1 millisecond. There is no cross-device atomic ID reservation or writer suffix.

The replicator treats equal IDs as identical content: it skips an already-local
complete snapshot on download (`replicator.ts:279`) and an already-remote complete
snapshot on upload (`replicator.ts:317`). The second writer can record successful
publication even though its database was not uploaded. Both PCs then regard that
ID as their sync base and raise no conflict, while retaining different balances.

Reproduction: A and B start from one snapshot; A refreshes AU to 66,000 and B
refreshes HDFC to 77,000; force both clocks behind the base and publish from
their stale caches. Both publications report success with the same ID. B keeps
the HDFC update and reports no conflict, while new PC C receives A's AU update
and the old HDFC balance.

Before supporting overlapping writers, use unique immutable snapshot identities
and verify manifest/database identity on matching IDs. A uniqueness change must
preserve sorting, lineage and old snapshot compatibility, including other vault
viewers; it should be a separately tested format change rather than an ad hoc
timestamp adjustment.

### P1 — manual Sync now can invalidate an active bank login's database

Automatic sync checks `activeAutomations()` and supplies `canPull/canPush = false`
(`ipc.ts:173`). Manual `backup:runNow` at `ipc.ts:1163` lacks that guard and calls
`backupNow` after pausing only the sync loop. The bank login holds a database
reference across awaited browser operations (`ipc.ts:1424`, `1457`).

A manual sync can restore newer remote data while the login is running, closing
that reference. The pending balance/audit write then fails with a closed database.
The audit test reproduces a tracked active automation, a manual pull, and the
original handle being unusable. Add the same automation guard as Restore and
conflict resolution, and serialize vault-changing actions with login lifetimes.

### P2 — independent balance fetches are not merged

This is the current whole-vault policy, not a per-account synchronization system.
If A refreshes AU and B refreshes HDFC before seeing A's upload, B gets a conflict
even though the changes concern different rows (`syncPolicy.ts:121`). Choosing
"keep this PC" publishes that entire vault (`engine.ts:1605`); choosing the other
PC replaces it. One refreshed balance can therefore revert to its old value.
Snapshots/safety copies help recovery but do not combine the updates automatically.
Even a login-only audit-log write can make the receiving vault dirty.

For ordinary multiple-user balance fetching, separate derived balance updates
from whole-vault backup. Use stable account IDs, device identity, authenticated
fetch times/revisions and an explicit same-account conflict rule. Merge independent
account updates without choosing an entire PC. Credentials/documents can remain
under a separate, conservative vault synchronization policy.

## Verified scenarios

The new `tests/backup/deviceSync.test.ts` exercises the production encrypted
database, backup engine, replicator and conflict resolver; only R2 transport is
replaced. It simulates devices with separate data directories/config/state.
The mocked clock tests the settle interval without waiting 90 real seconds.
Device switching is sequential within one process; the collision scenario models
two writers whose preflights saw the same base, not live concurrent sockets.

1. One refreshed balance and its original fetch timestamp reach two clean PCs.
2. Concurrent fetches on different accounts conflict; choosing one whole vault
   discards the other PC's independently fetched value.
3. Identical snapshot IDs reproduce unreported divergence.
4. Automatic pulls defer while an automation is active and resume afterward.
5. Manual sync reproduces invalidation of an active login's database handle.
6. Offline receivers preserve their data and catch up after reconnection.
7. Source close flushes without the settling delay; locked receivers catch up on unlock.

The defect-reproduction tests assert v0.3.9's observed behavior. Passing them
documents these defects; it does not imply they are fixed. UI refresh was traced
in code, not tested through a live bank browser or on the owner's installed PCs.

Baseline: 95 native tests passed before audit additions. Final run: 102 native
tests passed, with no skips, and TypeScript and whitespace checks passed. The
final native run emitted two worker-shutdown timeout warnings (master/engine
workers), although assertions passed and the runner exited with status zero.
The audit changes add tests and documentation only; the findings remain present
in the published v0.3.9 app.

## Interim operating policy

Have one PC fetch/edit at a time. Other PCs should remain clean, use the same
R2 configuration, and be unlocked when immediate viewing is needed. After a
refresh finishes, click Sync now on the source, then on receiving PCs; do not
press it during an active login. Check for sync errors/conflicts and compare the
displayed fetch timestamp. Keep PC clocks synchronized. Until the collision and
manual-sync defects are fixed, do not treat overlapping multi-PC use as guaranteed
delivery to every user.
