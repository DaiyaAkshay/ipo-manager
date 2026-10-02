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
