import { useEffect, useState } from 'react';
import Unlock from './pages/Unlock';
import Dashboard from './pages/Dashboard';
import SplashScreen from './pages/SplashScreen';

type State =
  | { kind: 'loading' }
  | { kind: 'unlock'; firstTime: boolean }
  | { kind: 'splashing' }
  | { kind: 'unlocked' };

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    window.api.vault.status().then((s: any) => {
      setState({ kind: 'unlock', firstTime: !s.initialized });
    });
    window.api.events.onLocked(() => {
      // Re-check vault status — after a Reset Vault, the meta + DB are gone
      // and we should boot into first-time setup, not the unlock screen.
      window.api.vault.status().then((s: any) => {
        setState({ kind: 'unlock', firstTime: !s.initialized });
      }).catch(() => {
        setState({ kind: 'unlock', firstTime: false });
      });
    });
  }, []);

  if (state.kind === 'loading') {
    return <div className="unlock"><div className="unlock-card">Loading...</div></div>;
  }

  if (state.kind === 'unlock') {
    return (
      <Unlock
        firstTime={state.firstTime}
        onUnlocked={() => setState({ kind: 'splashing' })}
      />
    );
  }

  // Dashboard mounts immediately in both states so it pre-loads data during the splash.
  // SplashScreen sits on top (position: fixed, z-index 9999) and removes itself when done.
  return (
    <>
      <Dashboard />
      {state.kind === 'splashing' && (
        <SplashScreen onDone={() => setState({ kind: 'unlocked' })} />
      )}
    </>
  );
}

