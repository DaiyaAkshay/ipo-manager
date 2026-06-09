/**
 * In-memory keytar stub for tests.
 *
 * Real keytar requires the OS credential manager (Windows) / Keychain (macOS)
 * which isn't available in headless test environments. This stub stores
 * passwords in a plain Map for the duration of the test process.
 */

const store = new Map<string, string>();

function key(service: string, account: string): string {
  return `${service}::${account}`;
}

export async function getPassword(service: string, account: string): Promise<string | null> {
  return store.get(key(service, account)) ?? null;
}

export async function setPassword(service: string, account: string, password: string): Promise<void> {
  store.set(key(service, account), password);
}

export async function deletePassword(service: string, account: string): Promise<boolean> {
  return store.delete(key(service, account));
}

export async function findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
  return [...store.entries()]
    .filter(([k]) => k.startsWith(`${service}::`))
    .map(([k, password]) => ({ account: k.split('::')[1], password }));
}

export default { getPassword, setPassword, deletePassword, findCredentials };
