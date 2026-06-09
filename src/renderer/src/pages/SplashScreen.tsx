import { useEffect, useRef, useState } from 'react';

interface Props {
  onDone: () => void;
}

const DURATION_MS = 1800;

export default function SplashScreen({ onDone }: Props) {
  const [progress, setProgress] = useState(0);
  const [exiting, setExiting] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    playUnlockChime();
  }, []);

  useEffect(() => {
    const start = performance.now();
    let raf: number;

    function tick(now: number) {
      const t = Math.min((now - start) / DURATION_MS, 1);
      // sqrt easing: fast start, slow finish — classic game loading bar feel
      setProgress(Math.sqrt(t) * 100);

      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setExiting(true);
        setTimeout(() => onDoneRef.current(), 380);
      }
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={`splash${exiting ? ' splash-exit' : ''}`}>
      <div className="splash-logo-wrap">
        <div className="splash-ring splash-ring-outer" />
        <div className="splash-ring splash-ring-inner" />
        <div className="splash-logo-text">IPO</div>
      </div>
      <div className="splash-name">IPO Manager</div>
      <div className="splash-bar-track">
        <div className="splash-bar-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function playUnlockChime() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;

    // D major arpeggio: D5 → F#5 → A5 — confident, financial
    ([
      [587.33, 0.00],
      [739.99, 0.14],
      [880.00, 0.28],
    ] as [number, number][]).forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const s = t + delay;
      gain.gain.setValueAtTime(0, s);
      gain.gain.linearRampToValueAtTime(0.14, s + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.36);
      osc.start(s);
      osc.stop(s + 0.38);
    });

    setTimeout(() => ctx.close(), 1500);
  } catch { /* AudioContext unavailable — skip silently */ }
}
