// pages/index.js
import { useEffect, useState } from 'react';

function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstDayOfPrevMonth() {
  const now = new Date();
  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonth = new Date(firstThisMonth);
  prevMonth.setMonth(firstThisMonth.getMonth() - 1); // previous month
  return new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
}

function lastDayOfPrevMonth() {
  const start = firstDayOfPrevMonth();
  // last day = day 0 of next month from start
  return new Date(start.getFullYear(), start.getMonth() + 1, 0);
}

export default function Home() {
  const [region, setRegion] = useState('IN'); // IN already works; you can switch to US/EU after connecting them
  const [orgId, setOrgId] = useState('');
  const [from, setFrom] = useState(ymd(firstDayOfPrevMonth()));
  const [to, setTo] = useState(ymd(lastDayOfPrevMonth()));
  const [prefer, setPrefer] = useState('auto');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // Keep "to" >= "from"
    if (to < from) setTo(from);
  }, [from, to]);

  async function runExport(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, orgId, from, to, prefer }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json?.error || `Request failed (${res.status})`);
      } else {
        setResult(json);
      }
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '40px auto', padding: '0 20px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <h1 style={{ marginBottom: 8 }}>Trial Balance Export</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        Choose a date range and export from Zoho Books. You’ll get the RAW file and an extracted CSV (flattened).
      </p>

      <form onSubmit={runExport}
            style={{ display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr', alignItems: 'end', marginTop: 20 }}>

        <div style={{ gridColumn: 'span 1' }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Region</label>
          <select value={region} onChange={(e) => setRegion(e.target.value)} style={{ width: '100%', padding: 10 }}>
            <option value="IN">IN (India)</option>
            <option value="US">US (United States)</option>
            <option value="EU">EU (Europe)</option>
          </select>
        </div>

        <div style={{ gridColumn: 'span 1' }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Org ID</label>
          <input value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="e.g. 1234567890"
                 style={{ width: '100%', padding: 10 }} required />
        </div>

        <div style={{ gridColumn: 'span 1' }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>From date</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: '100%', padding: 10 }} required />
        </div>

        <div style={{ gridColumn: 'span 1' }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>To date</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%', padding: 10 }} required />
        </div>

        <div style={{ gridColumn: 'span 2' }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Prefer format (optional)</label>
          <select value={prefer} onChange={(e) => setPrefer(e.target.value)} style={{ width: 240, padding: 10 }}>
            <option value="auto">auto</option>
            <option value="xlsx">xlsx</option>
            <option value="xls">xls</option>
            <option value="csv">csv</option>
            <option value="pdf">pdf</option>
            <option value="json">json</option>
          </select>
        </div>

        <div style={{ gridColumn: 'span 2', marginTop: 8 }}>
          <button type="submit" disabled={loading} style={{
            padding: '12px 16px',
            background: loading ? '#999' : '#111',
            color: 'white',
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}>
            {loading ? 'Exporting…' : 'Export TB'}
          </button>
        </div>
      </form>

      {error && (
        <div style={{ marginTop: 20, color: '#b00020', background: '#fde7ea', padding: 12, borderRadius: 6 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 24, background: '#f6f8fa', padding: 16, borderRadius: 6 }}>
          <h3 style={{ marginTop: 0 }}>Result</h3>
          <div style={{ display: 'grid', gap: 10 }}>
            {result.raw && (
              <div>
                <div style={{ fontWeight: 600 }}>RAW</div>
                <div>Name: {result.raw.name}</div>
                {result.raw.webViewLink && <div><a href={result.raw.webViewLink} target="_blank" rel="noreferrer">Open in Drive</a></div>}
              </div>
            )}
            {result.extracted && !result.extracted.error && (
              <div>
                <div style={{ fontWeight: 600 }}>Extracted CSV</div>
                <div>Name: {result.extracted.name}</div>
                <div>Rows: {result.extracted.rows}</div>
                <div>Accounts with code: {result.extracted.accounts_with_code}</div>
                <div>Accounts without code: {result.extracted.accounts_without_code}</div>
                {result.extracted.webViewLink && <div><a href={result.extracted.webViewLink} target="_blank" rel="noreferrer">Open in Drive</a></div>}
              </div>
            )}
            {result.extracted && result.extracted.error && (
              <div style={{ color: '#b00020' }}>
                <div style={{ fontWeight: 600 }}>Extracted CSV</div>
                <div>Error: {result.extracted.error}</div>
                {result.extracted.status && <div>Status: {result.extracted.status} {result.extracted.statusText || ''}</div>}
              </div>
            )}
          </div>

          <details style={{ marginTop: 12 }}>
            <summary>Debug</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(result, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
