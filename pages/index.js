import { useEffect, useState } from 'react';

function pad(n){ return n < 10 ? `0${n}` : `${n}`; }
function lastMonthIST(){
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0 = Jan
  const start = new Date(y, m - 1, 1);  // 1st of previous month (local)
  const end   = new Date(y, m, 0);      // last day of previous month (local)
  return {
    from: `${start.getFullYear()}-${pad(start.getMonth()+1)}-01`,
    to: `${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())}`,
  };
}

export default function Home(){
  const [fmt, setFmt] = useState('xlsx');
  const [org, setOrg] = useState({ IN:'', US:'', EU:'', UK:'' });
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem('org_ids')||'{}'); setOrg(o => ({...o, ...saved})); } catch {}
  }, []);

  function saveOrg(){ localStorage.setItem('org_ids', JSON.stringify(org)); addLog('Saved Org IDs'); }
  function addLog(msg){ setLog(prev => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0,50)); }

  function connectZoho(region){ window.location.href = `/api/zoho/${region}/auth`; }

  async function exportTB(region){
    const id = org[region];
    if(!id){ alert(`Enter Org ID for ${region}`); return; }
    const { from, to } = lastMonthIST();
    setBusy(true); addLog(`Exporting ${region} TB for ${from}→${to} (${fmt.toUpperCase()})...`);
    try {
      const res = await fetch('/api/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, from, to, fmt, orgId: id })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok){
        addLog(`Saved ${region} → ${data.driveFileName}`);
        alert(`Saved to Drive: ${data.driveFileName}`);
      } else {
        addLog(`FAILED ${region}: ${data.error || res.status}`);
        alert(`Export failed: ${data.error || res.status}`);
      }
    } catch (e){
      addLog(`FAILED ${region}: ${e?.message || e}`);
      alert('Network or server error');
    } finally { setBusy(false); }
  }

  async function exportAll(){
    for (const r of ['IN','US','EU','UK']) { // run one-by-one
      // eslint-disable-next-line no-await-in-loop
      await exportTB(r);
    }
  }

  const box = { border:'1px solid #e5e7eb', borderRadius:12, padding:16 };
  const row = { display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 };
  const btn = (primary) => ({ padding:'8px 12px', borderRadius:10, border: primary? 'none':'1px solid #e5e7eb', background: primary? '#111827':'#fff', color: primary? '#fff':'#111827', cursor:'pointer' });
  const input = { width:'100%', padding:8, border:'1px solid #e5e7eb', borderRadius:10 };

  return (
    <main style={{ fontFamily:'system-ui, -apple-system, Segoe UI, Roboto', maxWidth:920, margin:'24px auto', padding:'0 16px' }}>
      <h1 style={{ fontSize:26, fontWeight:700, marginBottom:8 }}>Trial Balance Exporter</h1>
      <p style={{ color:'#6b7280', marginBottom:16 }}>Paste Zoho <b>Organization IDs</b>, connect each region, then export last month’s TB to Google Drive.</p>

      <div style={{ ...box, marginBottom:16 }}>
        <div style={{ ...row, alignItems:'center' }}>
          <div>
            <label>India (IN) Org ID</label>
            <input style={input} value={org.IN} onChange={e=>setOrg({...org, IN:e.target.value})} placeholder="e.g. 123456789" />
          </div>
          <div>
            <label>USA (US) Org ID</label>
            <input style={input} value={org.US} onChange={e=>setOrg({...org, US:e.target.value})} />
          </div>
          <div>
            <label>Europe (EU) Org ID</label>
            <input style={input} value={org.EU} onChange={e=>setOrg({...org, EU:e.target.value})} />
          </div>
          <div>
            <label>UK (EU DC) Org ID</label>
            <input style={input} value={org.UK} onChange={e=>setOrg({...org, UK:e.target.value})} />
          </div>
        </div>
        <div style={{ display:'flex', gap:8, marginTop:12 }}>
          <button onClick={saveOrg} style={btn(true)}>Save Org IDs</button>
          <button onClick={()=>setFmt(fmt==='xlsx'?'pdf':'xlsx')} style={btn(false)}>Format: {fmt.toUpperCase()}</button>
          <button onClick={exportAll} style={btn(false)} disabled={busy}>Export All</button>
        </div>
        <p style={{ marginTop:8, color:'#6b7280', fontSize:13 }}>Where to find the Org ID: Zoho Books → top-right org switcher → <b>Manage</b> → copy <b>Organization ID</b>.</p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        {['IN','US','EU','UK'].map(r => (
          <div key={r} style={box}>
            <h3 style={{ marginTop:0, marginBottom:8 }}>{r} Region</h3>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <button onClick={()=>connectZoho(r)} style={btn(false)}>Connect Zoho</button>
              <button onClick={()=>exportTB(r)} style={btn(true)} disabled={busy}>Export</button>
            </div>
            <p style={{ color:'#6b7280', fontSize:12, marginTop:8 }}>Make sure you clicked <b>Connect Zoho</b> first for this region.</p>
          </div>
        ))}
      </div>

      <div style={{ ...box, marginTop:16 }}>
        <h3 style={{ marginTop:0 }}>Activity</h3>
        <ul style={{ listStyle:'none', padding:0, margin:0 }}>
          {log.map((l,i)=>(<li key={i} style={{ padding:'6px 0', borderBottom:'1px solid #f3f4f6' }}>{l}</li>))}
        </ul>
      </div>
    </main>
  );
}
