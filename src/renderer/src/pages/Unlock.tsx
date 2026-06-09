import { useState } from 'react';

interface Props {
  firstTime: boolean;
  onUnlocked: () => void;
}

export default function Unlock({ firstTime, onUnlocked }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setIssues([]);

    if (firstTime && password !== confirm) {
      setErr('Passwords do not match.');
      return;
    }

    setBusy(true);
    const result: any = await window.api.vault.unlock(password);
    setBusy(false);

    if (result.ok) {
      onUnlocked();
      return;
    }
    if (result.issues) {
      setIssues(result.issues);
    } else if (result.error === 'INVALID_MASTER_PASSWORD') {
      setErr('Wrong password. Try again.');
    } else {
      setErr(result.error || 'Unable to unlock vault.');
    }
  }

  return (
    <div className="unlock">
      <form className="unlock-card" onSubmit={submit}>
        <div className="unlock-mark">IPO Manager</div>
        <div className="unlock-sub">encrypted local vault</div>

        <div className={`unlock-mode ${firstTime ? 'new' : ''}`}>
          {firstTime ? '* first-time setup' : 'unlock'}
        </div>

        <div className="field">
          <label>Master password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="current-password"
          />
        </div>

        {firstTime && (
          <div className="field">
            <label>Confirm</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              spellCheck={false}
              autoComplete="new-password"
            />
          </div>
        )}

        <button className="btn btn-block" disabled={busy || !password}>
          {busy ? 'Deriving key...' : firstTime ? 'Create vault' : 'Unlock'}
        </button>

        {err && <div className="error">{err}</div>}
        {issues.length > 0 && (
          <div className="error">
            Password too weak:
            <ul>{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>
          </div>
        )}

        {firstTime && (
          <div className="unlock-warning">
            <strong>WRITE THIS PASSWORD ON PAPER.</strong> If you lose it, the vault
            cannot be recovered. Anthropic, your OS, and this app have no
            recovery mechanism - that&apos;s what makes the encryption real.
          </div>
        )}
      </form>
    </div>
  );
}
