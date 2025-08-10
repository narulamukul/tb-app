import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { seal } from '@/lib/crypto';

async function exchangeToken(accounts: string, client_id: string, client_secret: string, code: string, redirect_uri: string){
  const res = await fetch(`${accounts}/oauth/v2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, client_secret, redirect_uri })
  });
  if(!res.ok) throw new Error('token exchange failed');
  return res.json();
}

export async function GET(req: NextRequest, { params }: { params: { region: 'IN'|'US'|'EU'|'UK' } }){
  const region = params.region;
  const { accounts, api, id, secret } = zohoClientFor(region);
  const url = new URL(req.url);
  const code = url.searchParams.get('code')!;
  const redirect_uri = `${process.env.NEXTAUTH_URL}/api/zoho/${region}/callback`;
  const tok = await exchangeToken(accounts, id!, secret!, code, redirect_uri);
  const rt = tok.refresh_token || tok.refreshToken || tok.refresh;
  if(!rt) throw new Error('no refresh token');
  // store connection (user email fetched from your session cookie on the frontend call if needed)
  const userEmail = 'owner@ultrahuman.com'; // TODO: read from session in production
  await pool.query(
    `insert into zoho_connections (user_email, region_key, zoho_dc, accounts_host, api_host, refresh_token_enc)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (user_email, region_key) do update set refresh_token_enc = excluded.refresh_token_enc`,
     [userEmail, region, api.includes('.in')?'in':api.includes('.eu')?'eu':'com', new URL(accounts).host, new URL(api).host, Buffer.from(seal(rt),'utf8')]
  );
  return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/dashboard?connected=${region}`);
}
