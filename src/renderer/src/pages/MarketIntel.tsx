import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';

// Shapes mirror src/main/market/service.ts (the renderer has no main-process imports).
type Verdict = 'APPLY' | 'CONSIDER' | 'AVOID' | 'WAIT';
interface Subscription {
  total: number | null; qib: number | null; nii: number | null; retail: number | null;
  employee: number | null; shareholder: number | null;
  hasShareholderQuota: boolean; hasEmployeeQuota: boolean;
}
interface IpoIntel {
  symbol: string | null; name: string; segment: 'MAINBOARD' | 'SME';
  status: 'OPEN' | 'UPCOMING' | 'CLOSED';
  openDate: string | null; closeDate: string | null; priceHigh: number | null;
  gmp: number | null; gmpPct: number | null; gmpSource: string | null;
  subscription: Subscription | null; retailOdds: number | null;
  verdict: Verdict; score: number; reasons: string[];
}
interface CorporateAction {
  symbol: string; company: string; kind: 'BONUS' | 'RIGHTS' | 'SPLIT'; ratio: string | null;
  exDate: string | null; recordDate: string | null; buyBy: string | null; subject: string;
}
interface Announcement {
  symbol: string; company: string; kind: 'BONUS' | 'RIGHTS' | 'PREFERENTIAL' | 'SPLIT';
  meetingDate: string | null; purpose: string; description: string; attachment: string | null;
}
interface QuotaPick {
  id: string | null; parentSymbol: string; ipoName: string; cutoffDate: string | null;
  buyBy: string | null; daysLeft: number | null; source: 'NSE' | 'WATCHLIST'; action: string;
}
interface Snapshot {
  fetchedAt: string; ipos: IpoIntel[]; corporateActions: CorporateAction[];
  announcements: Announcement[]; quotaPicks: QuotaPick[]; gmpEnabled: boolean; errors: string[];
}

type Tab = 'ipos' | 'actions' | 'quota';

const VERDICT_COLOR: Record<Verdict, string> = {
  APPLY: 'var(--success)', CONSIDER: 'var(--warn)', AVOID: 'var(--danger)', WAIT: 'var(--text-2)',
};

const fmtX = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(n >= 10 ? 0 : 1)}×`);
const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

const cell: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', fontSize: 13, verticalAlign: 'top' };
const head: CSSProperties = { ...cell, color: 'var(--text-2)', fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left' };
const panel: CSSProperties = { background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' };

export function MarketIntelPage() {
  const [tab, setTab] = useState<Tab>('ipos');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState({ parentSymbol: '', ipoName: '', cutoffDate: '' });
  const [formError, setFormError] = useState<string | null>(null);

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.market.getSnapshot(force) as any;
      if (res?.ok) setSnap(res.snapshot);
      else setError(res?.error || 'Could not load market data.');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(false); }, []);

  async function toggleGmp() {
    if (!snap) return;
    await window.api.market.setGmpEnabled(!snap.gmpEnabled);
    await load(true);
  }

  async function addWatch() {
    setFormError(null);
    const res = await window.api.market.addQuotaWatch({
      parentSymbol: form.parentSymbol,
      ipoName: form.ipoName,
      cutoffDate: form.cutoffDate || null,
    }) as any;
    if (!res?.ok) { setFormError(res?.error || 'Could not add.'); return; }
    setForm({ parentSymbol: '', ipoName: '', cutoffDate: '' });
    await load(true);
  }

  async function removeWatch(id: string) {
    await window.api.market.removeQuotaWatch(id);
    await load(true);
  }

  const ipos = useMemo(() => (snap?.ipos || []).filter(i => i.segment === 'MAINBOARD'), [snap]);
  const counts = useMemo(() => ({
    apply: (snap?.ipos || []).filter(i => i.verdict === 'APPLY' && i.status !== 'CLOSED').length,
    actions: (snap?.corporateActions.length || 0) + (snap?.announcements.length || 0),
    quota: snap?.quotaPicks.length || 0,
  }), [snap]);

  const tabBtn = (id: Tab, label: string, badge?: number) => (
    <button
      className="btn-row"
      onClick={() => setTab(id)}
      style={tab === id ? { background: 'var(--accent)', color: '#1a1a1a', borderColor: 'var(--accent)' } : undefined}
    >
      {label}{badge ? ` (${badge})` : ''}
    </button>
  );

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Market Watch</h2>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
            {snap ? `Updated ${new Date(snap.fetchedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · NSE${snap.gmpEnabled ? ' + ipowatch GMP' : ''}` : 'NSE public data'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {tabBtn('ipos', 'IPOs', counts.apply)}
          {tabBtn('actions', 'Bonus / Rights', counts.actions)}
          {tabBtn('quota', 'Shareholder quota', counts.quota)}
          <button className="btn btn-primary" disabled={loading} onClick={() => load(true)}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', marginBottom: 14 }}>
        Signals are a checklist (GMP and subscription), not investment advice. GMP is an unofficial grey-market quote and can change or reverse before listing.
      </div>

      {error && <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</div>}
      {snap?.errors.length ? (
        <details style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 12 }}>
          <summary>{snap.errors.length} source{snap.errors.length > 1 ? 's' : ''} failed — data may be incomplete</summary>
          <ul style={{ margin: '6px 0 0 18px' }}>{snap.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      ) : null}

      {!snap && loading && <div style={{ color: 'var(--text-2)' }}>Fetching IPOs, corporate actions and board meetings…</div>}

      {snap && tab === 'ipos' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Mainboard IPOs only</span>
            <label style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-1)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={snap.gmpEnabled} onChange={toggleGmp} />
              Fetch GMP (unofficial)
            </label>
          </div>
          <div style={panel}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={head}>Issue</th>
                  <th style={head}>Dates</th>
                  <th style={head}>Price</th>
                  <th style={head}>GMP</th>
                  <th style={head}>Subscribed</th>
                  <th style={head}>Retail odds</th>
                  <th style={head}>Signal</th>
                </tr>
              </thead>
              <tbody>
                {ipos.length === 0 && (
                  <tr><td style={{ ...cell, color: 'var(--text-2)' }} colSpan={7}>No equity IPOs open or announced right now.</td></tr>
                )}
                {ipos.map(i => {
                  const key = i.symbol || i.name;
                  const open = expanded === key;
                  return (
                    <Fragment key={key}>
                      <tr onClick={() => setExpanded(open ? null : key)} style={{ cursor: 'pointer', opacity: i.status === 'CLOSED' ? 0.55 : 1 }}>
                        <td style={cell}>
                          <div style={{ fontWeight: 500 }}>{i.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                            {i.status.toLowerCase()}
                            {i.subscription?.hasShareholderQuota ? ' · shareholder quota' : ''}
                            {i.subscription?.hasEmployeeQuota ? ' · employee quota' : ''}
                          </div>
                        </td>
                        <td style={cell}>{i.openDate ? `${fmtDate(i.openDate)} – ${fmtDate(i.closeDate)}` : 'TBA'}</td>
                        <td style={{ ...cell, fontFamily: 'var(--mono)' }}>{i.priceHigh ? `₹${i.priceHigh}` : '—'}</td>
                        <td style={{ ...cell, fontFamily: 'var(--mono)', color: i.gmp === null ? 'var(--text-2)' : i.gmp < 0 ? 'var(--danger)' : 'var(--success)' }}>
                          {i.gmp === null ? '—' : `₹${i.gmp}`}
                          {i.gmpPct !== null && <span style={{ color: 'var(--text-2)' }}> ({i.gmpPct.toFixed(0)}%)</span>}
                        </td>
                        <td style={{ ...cell, fontFamily: 'var(--mono)' }}>
                          {fmtX(i.subscription?.total)}
                          {i.subscription?.retail !== null && i.subscription?.retail !== undefined && (
                            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>R {fmtX(i.subscription.retail)} · Q {fmtX(i.subscription.qib)}</div>
                          )}
                        </td>
                        <td style={{ ...cell, fontFamily: 'var(--mono)' }}>
                          {i.retailOdds === null ? '—' : i.retailOdds >= 1 ? 'sure' : `1 in ${Math.round(1 / i.retailOdds)}`}
                        </td>
                        <td style={cell}>
                          <span style={{ color: VERDICT_COLOR[i.verdict], fontWeight: 600, fontSize: 12 }}>{i.verdict}</span>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td style={{ ...cell, background: 'var(--bg-2)', color: 'var(--text-1)' }} colSpan={7}>
                            <ul style={{ margin: 0, paddingLeft: 18 }}>{i.reasons.map((r, n) => <li key={n}>{r}</li>)}</ul>
                            {i.retailOdds !== null && i.gmp !== null && i.retailOdds < 1 && (
                              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-2)' }}>
                                Applying in more family members' names (each with its own PAN) raises the chance of at least one lot; odds are a rough estimate.
                              </div>
                            )}
                            {i.gmpSource && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-2)' }}>GMP source: {i.gmpSource}</div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {snap && tab === 'actions' && (
        <div style={{ display: 'grid', gap: 18 }}>
          <div>
            <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>Confirmed — ex-date fixed (next 90 days)</h3>
            <div style={panel}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={head}>Stock</th><th style={head}>Action</th><th style={head}>Buy by</th><th style={head}>Ex / record</th></tr></thead>
                <tbody>
                  {snap.corporateActions.length === 0 && <tr><td style={{ ...cell, color: 'var(--text-2)' }} colSpan={4}>No bonus, rights or split ex-dates ahead.</td></tr>}
                  {snap.corporateActions.map((a, n) => (
                    <tr key={`${a.symbol}-${n}`}>
                      <td style={cell}><div style={{ fontWeight: 500 }}>{a.symbol}</div><div style={{ fontSize: 11, color: 'var(--text-2)' }}>{a.company}</div></td>
                      <td style={cell}><b>{a.kind}{a.ratio ? ` ${a.ratio}` : ''}</b><div style={{ fontSize: 11, color: 'var(--text-2)' }}>{a.subject}</div></td>
                      <td style={{ ...cell, fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{fmtDate(a.buyBy)}</td>
                      <td style={{ ...cell, fontFamily: 'var(--mono)' }}>{fmtDate(a.exDate)} / {fmtDate(a.recordDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6 }}>
              "Buy by" is the trading day before the ex-date (T+1 settlement). Exchange holidays are not accounted for — check the NSE holiday list near a long weekend.
            </div>
          </div>

          <div>
            <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>Proposed — board meetings (last 45 / next 60 days)</h3>
            <div style={panel}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={head}>Stock</th><th style={head}>Type</th><th style={head}>Meeting</th><th style={head}>Details</th></tr></thead>
                <tbody>
                  {snap.announcements.length === 0 && <tr><td style={{ ...cell, color: 'var(--text-2)' }} colSpan={4}>Nothing announced.</td></tr>}
                  {snap.announcements.map((a, n) => (
                    <tr key={`${a.symbol}-${a.kind}-${n}`}>
                      <td style={cell}><div style={{ fontWeight: 500 }}>{a.symbol}</div><div style={{ fontSize: 11, color: 'var(--text-2)' }}>{a.company}</div></td>
                      <td style={cell}><b>{a.kind}</b></td>
                      <td style={{ ...cell, fontFamily: 'var(--mono)' }}>{fmtDate(a.meetingDate)}</td>
                      <td style={{ ...cell, color: 'var(--text-1)', maxWidth: 460 }}>
                        {a.description}
                        {a.attachment && (
                          <div><a href="#" onClick={e => { e.preventDefault(); window.api.shell.openExternal(a.attachment!); }} style={{ color: 'var(--accent)', fontSize: 12 }}>Filing PDF</a></div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6 }}>
              Preferential allotments go to named investors (promoters, funds) — retail cannot apply. They are listed as a signal only.
            </div>
          </div>
        </div>
      )}

      {snap && tab === 'quota' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5 }}>
            When a listed company takes a subsidiary public, the IPO often reserves shares for the parent's shareholders.
            Holding even <b>one</b> parent share in a demat on the RHP date lets that member apply in the shareholder category
            as well as retail — a separate, usually less crowded, pool.
          </div>
          <div style={panel}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={head}>Buy</th><th style={head}>For IPO</th><th style={head}>Buy by</th><th style={head}>What to do</th><th style={head}></th></tr></thead>
              <tbody>
                {snap.quotaPicks.length === 0 && <tr><td style={{ ...cell, color: 'var(--text-2)' }} colSpan={5}>No shareholder-quota IPOs tracked. Add one below when a listed company announces a subsidiary IPO.</td></tr>}
                {snap.quotaPicks.map((p, n) => (
                  <tr key={p.id || `nse-${n}`}>
                    <td style={{ ...cell, fontWeight: 600 }}>{p.parentSymbol}</td>
                    <td style={cell}>{p.ipoName}<div style={{ fontSize: 11, color: 'var(--text-2)' }}>{p.source === 'NSE' ? 'detected on NSE' : 'your watchlist'}</div></td>
                    <td style={{ ...cell, fontFamily: 'var(--mono)', color: p.daysLeft !== null && p.daysLeft <= 3 && p.daysLeft >= 0 ? 'var(--danger)' : 'var(--accent)' }}>
                      {fmtDate(p.buyBy)}{p.daysLeft !== null && p.daysLeft >= 0 ? <div style={{ fontSize: 11 }}>{p.daysLeft} day{p.daysLeft === 1 ? '' : 's'}</div> : null}
                    </td>
                    <td style={{ ...cell, color: 'var(--text-1)' }}>{p.action}</td>
                    <td style={cell}>{p.id && <button className="btn-icon btn-icon-danger" title="Remove" onClick={() => removeWatch(p.id!)}>X</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Track a subsidiary IPO</div>
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 170px auto', gap: 10, alignItems: 'end' }}>
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Parent NSE symbol</label>
                <input placeholder="e.g. RELIANCE" value={form.parentSymbol}
                  onChange={e => setForm(f => ({ ...f, parentSymbol: e.target.value.toUpperCase() }))} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>IPO / subsidiary</label>
                <input placeholder="e.g. Jio Platforms" value={form.ipoName}
                  onChange={e => setForm(f => ({ ...f, ipoName: e.target.value }))} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>RHP / cut-off date</label>
                <input type="date" value={form.cutoffDate}
                  onChange={e => setForm(f => ({ ...f, cutoffDate: e.target.value }))} />
              </div>
              <button className="btn btn-primary" onClick={addWatch}>Add</button>
            </div>
            {formError && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{formError}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 8 }}>
              Leave the date empty if the RHP isn't filed yet — the row will remind you to buy early. Check the RHP for the exact eligibility date and quota size.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
