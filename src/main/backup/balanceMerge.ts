/** Only derived observations may merge automatically. Credentials and every
 * other vault record must match byte-for-byte before the transaction starts. */
import type Database from 'better-sqlite3-multiple-ciphers';

type Row = Record<string, any>;
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const canonical = (row: Row) => JSON.stringify(row);

function structure(db: Database.Database): string {
  const schema = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as Row[];
  const records = schema.filter(s => s.type === 'table' && s.name !== 'audit_log').map(s => {
    const rows = db.prepare(`SELECT * FROM ${quote(s.name)}`).all() as Row[];
    const normalized = rows.filter(r => s.name !== 'sqlite_sequence' || r.name !== 'audit_log').map(r => {
      const result = { ...r };
      if (s.name === 'bank_accounts' || s.name === 'broker_accounts') {
        delete result.balance; delete result.balance_fetched_at;
      }
      return canonical(result);
    }).sort();
    return [s.name, normalized];
  });
  return JSON.stringify([db.pragma('user_version', { simple: true }), schema, records]);
}

function observationKey(row: Row): string {
  if (!row.balance_fetched_at) return `0000:${String(row.balance ?? '')}`;
  const raw = String(row.balance_fetched_at);
  const time = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(time)) throw new Error('Invalid balance fetch timestamp');
  // Deterministic tie-break for same-time observations; never compare amounts
  // numerically, since a smaller balance can be the more recent observation.
  return `${String(time).padStart(16, '0')}:${String(row.balance ?? '')}`;
}

export function mergeBalancesAndAudit(local: Database.Database, remote: Database.Database): boolean {
  if (structure(local) !== structure(remote)) return false;
  const updates: Array<{ table: string; row: Row }> = [];
  for (const table of ['bank_accounts', 'broker_accounts']) {
    const own = new Map((local.prepare(`SELECT id, balance, balance_fetched_at FROM ${table}`).all() as Row[]).map(r => [r.id, r]));
    for (const row of remote.prepare(`SELECT id, balance, balance_fetched_at FROM ${table}`).all() as Row[]) {
      if (row.balance !== null && observationKey(row) > observationKey(own.get(row.id)!)) updates.push({ table, row });
    }
  }
  // IDs are allocated locally and can collide. Merge audit entries by content
  // with multiplicity, keeping repeated identical attempts already recorded.
  const columns = (local.prepare('PRAGMA table_info(audit_log)').all() as Row[]).map(r => r.name).filter(n => n !== 'id');
  const names = columns.map(quote).join(',');
  const counts = new Map<string, number>();
  for (const row of local.prepare(`SELECT ${names} FROM audit_log`).all() as Row[]) {
    const key = canonical(row); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const additions: Row[] = [];
  for (const row of remote.prepare(`SELECT ${names} FROM audit_log ORDER BY id`).all() as Row[]) {
    const key = canonical(row), left = counts.get(key) ?? 0;
    if (left) counts.set(key, left - 1); else additions.push(row);
  }
  local.transaction(() => {
    for (const { table, row } of updates) {
      local.prepare(`UPDATE ${table} SET balance=?, balance_fetched_at=? WHERE id=?`)
        .run(row.balance, row.balance_fetched_at, row.id);
    }
    const insert = local.prepare(`INSERT INTO audit_log (${names}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of additions) insert.run(...columns.map(n => row[n]));
  })();
  return true;
}
