import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { uploadToDrive } from '@/lib/drive';
import { open } from '@/lib/crypto';
import { zohoClientFor } from '@/lib/zoho';

async function refreshAccessToken(accounts: string, client_id: string, client_secret: string, refresh_token: string){
  const res = await fetch(`${accounts}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type:'refresh_token', refresh_token, client_id, client_secret }) });
  if(!res.ok) throw new Error('refresh failed');
  return res.json();
}

async function downloadTB(api: string, orgId: string, accessToken: string, from: string, to: string, fmt: 'xlsx'|'pdf'){
  const url = new URL(`${api}/books/v3/reports/trialbalance`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('from_date', from);
  url.searchParams.set('to_date', to);
  url.searchParams.set('accept', fmt);
  const r = await fetch(url.toString(), { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  if(!r.ok){
    // TODO: fallback to journals+chart-of-accounts
    throw new Error(`TB request failed: ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = fmt === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return { buf, mime };
}

export async function POST(req: NextRequest){
  const { region, from, to, fmt, orgId } = await req.json();
  const { api, accounts, id, secret } = zohoClientFor(region);
  const { rows } = await pool.query('select * from zoho_connections where region_key=$1 limit 1', [region]);
  if(!rows.length) return NextResponse.json({ error: 'not connected'}, { status: 400 });
  const rt = open(Buffer.from(rows[0].refresh_token_enc).toString('utf8'));
  const tok = await refreshAccessToken(accounts, id!, secret!, rt);
  const at = tok.access_token;
  const { buf, mime } = await downloadTB(api, orgId, at, from, to, fmt);
  const fileName = `TB_${region}_${from.slice(0,7)}.${fmt}`;
  const file = await uploadToDrive(fileName, mime, buf);
  await pool.query('insert into audit_logs(user_email,region_key,event,meta) values ($1,$2,$3,$4)', ['system', region, 'export_complete', {file}]);
  return NextResponse.json({ ok: true, driveFileId: file.id, driveFileName: file.name });
}
