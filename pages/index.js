// pages/index.js
import { useEffect, useState } from 'react';

function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function firstDayOfPrevMonth() {
  const now = new Date();
  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const prev = new Date(firstThisMonth);
  prev.setMonth(firstThisMonth.getMonth() - 1);
  return new Date(prev.getFullYear(), prev.getMonth(), 1);
}
function lastDayOfPrevMonth() {
  const s = firstDayOfPrevMonth();
  return new Date(s.getFullYear(), s.getMonth() + 1, 0);
}

export default function Home() {
  const [from, setFrom] = useState(ymd(firstDayOfPrevMonth()));
  const [to, setTo] = useState(ymd(lastDayOfPrevMonth()));
  const [prefer, setPrefer] = useState('auto');

  // Region selection + per-region orgIds
  const [selIN, setSelIN] = useState(true);
  const [selUS, setSelUS] = useState(false);
  const [selEU, setSelEU] = useState(false);

  const [orgIN, setOrgIN] = useState(''); // org id for IN
  const [orgUS, setOrgUS] = useState(''); // org id for US
  const [orgEU, setOrgEU] = useState(''); // org id for EU

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);   // table rows of results
  const [error, setError] = useState('');

  useEffect(() => {
    if (to < from) setTo(from);
  }, [from, to]);

  function selectedPayloads() {
    const items = [];
    if (selIN) items.push({ region: 'IN', orgId: orgIN });
    if (selUS) items.push({ region: 'US', orgId: orgUS });
    if (selEU) items.push({ region: 'EU', orgId: orgEU });
    return items.filter(x => x.orgId && x.orgId.trim().length > 0);
  }

  async function exportAll(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setRows([]);

    const tasks = selectedPayloads();
    if (!tasks.length) {
      setError('Please select at least one region and fill its Org ID.');
      setLoading(false);
      return;
    }

    try {
      const resList = await Promise.all(tasks.map(async ({ region, orgId }) => {
        const res = await fetch('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region, orgId, from, to, prefer }),
        });
        const json = await res.json().catch(() => ({}));
        return { region, orgId, ok: res.ok && json?.ok, data: json };
      }));

      const out = resList.map(({ region, orgId, ok, data }) => {
        const raw = data?.raw || {};
        const ext = data?.extracted || {};
        return {
          region,
          orgId,
          ok: !!ok && !ext?.error,
          rawName: raw?.name || '',
          rawLink: raw?.webViewLink || '',
          extName: ext?.name || '',
          extRows: typeof ext?.rows === 'number' ? ext.rows : '',
          extWithCode: typeof ext?.accounts_with_code === 'number' ? ext.accounts_with_code : '',
          extNoCode: typeof ext?.accounts_without_code === 'number' ? ext.accounts_without_code : '',
          extLink: ext?.webViewLink || '',
          err: ok ? (ext?.error || '') : (data?.error || 'Request failed'),
          status: data?.zoho?.status || '',
        };
      });

      setRows(out);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', padding: '0 20px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <h1 style={{ marginBottom: 8 }}>Trial Balance Export (Multi-Region)</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        Choose a date range, select regions, enter Org IDs, then export all at once. You’ll get RAW + Extracted CSV for each region.
      </p>

      <form onSubmit={exportAll} style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr', alignItems: 'end', marginTop: 20 }}>
        {/* Date range */}
        <div>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: '100%', padding: 10 }} required />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%', padding: 10 }} required />
        </div>

        {/* Format preference */}
        <div>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Prefer format (optional)</label>
          <select value={prefer} onChange={(e) => setPrefer(e.target.value)} style={{ width: '100%', padding: 10 }}>
            <option value="auto">auto</option>
            <option value="xlsx">xlsx</option>
            <option value="xls">xls</option>
            <option value="csv">csv</option>
            <option value="pdf">pdf</option>
            <option value="json">json</option>
          </select>
        </div>
        <div />

        {/* Region selectors + per-region org IDs */}
        <div style={{ gridColumn: 'span 2', background: '#f6f8fa', padding: 12, borderRadius: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={selIN} onChange={(e) => setSelIN(e.target.checked)} />
              IN (India)
            </label>
            <input disabled={!selIN} value={orgIN} onChange={(e) => setOrgIN(e.target.value)} placeholder="Org ID for IN"
                   style={{ width: '100%', padding: 10, opacity: selIN ? 1 : 0.5 }} />

            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={selUS} onChange={(e) => setSelUS(e.target.checked)} />
              US (United States)
            </label>
            <input disabled={!selUS} value={orgUS} onChange={(e) => setOrgUS(e.target.value)} placeholder="Org ID for US"
                   style={{ width: '100%', padding: 10, opacity: selUS ? 1 : 0.5 }} />

            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={selEU} onChange={(e) => setSelEU(e.target.checked)} />
              EU (Europe)
            </label>
            <input disabled={!selEU} value={orgEU} onChange={(e) => setOrgEU(e.target.value)} placeholder="Org ID for EU"
                   style={{ width: '100%', padding: 10, opacity: selEU ? 1 : 0.5 }} />
          </div>
        </div>

        <div style={{ gridColumn: 'span 2', marginTop: 4 }}>
          <button type="submit" disabled={loading} style={{
            padding: '12px 16px',
            background: loading ? '#999' : '#111',
            color: 'white',
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}>
            {loading ? 'Exporting all…' : 'Export All Selected'}
          </button>
        </div>
      </form>

      {error && (
        <div style={{ marginTop: 16, color: '#b00020', background: '#fde7ea', padding: 12, borderRadius: 6 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Results */}
      {rows.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ marginTop: 0 }}>Results</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr style={{ background: '#f0f3f6' }}>
                  <th style={th}>Region</th>
                  <th style={th}>Org ID</th>
                  <th style={th}>RAW</th>
                  <th style={th}>Extracted CSV</th>
                  <th style={th}>Rows</th>
                  <th style={th}>With Code</th>
                  <th style={th}>No Code</th>
                  <th style={th}>Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #e5e7eb' }}>
                    <td style={td}>{r.region}</td>
                    <td style={td}>{r.orgId}</td>
                    <td style={td}>
                      {r.rawLink ? <a href={r.rawLink} target="_blank" rel="noreferrer">{r.rawName || 'Open'}</a> : (r.rawName || '-') }
                    </td>
                    <td style={td}>
                      {r.extLink ? <a href={r.extLink} target="_blank" rel="noreferrer">{r.extName || 'Open'}</a> : (r.extName || '-') }
                    </td>
                    <td style={td}>{r.extRows || '-'}</td>
                    <td style={td}>{r.extWithCode || '-'}</td>
                    <td style={td}>{r.extNoCode || '-'}</td>
                    <td style={{ ...td, color: r.err ? '#b00020' : '#111' }}>{r.err ? `${r.err}${r.status ? ` (HTTP ${r.status})` : ''}` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary>Debug payload</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(rows, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

const th = { textAlign: 'left', padding: '10px 8px', fontWeight: 600, fontSize: 13 };
const td = { textAlign: 'left', padding: '10px 8px', fontSize: 13 };
