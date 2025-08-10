export const runtime = 'nodejs';
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { seal } from '@/lib/crypto';

async function exchangeToken(
  accounts: string, client_id: string, client_secret: string, code: string, redirect_uri: string
) {
  const res = await fetch(`${accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, client_secret, redirect_uri }),
  });
  if (!res.ok) throw new Error('token exchange failed');
  return res.json() as Promise<any>;
}

export async function GET(req: Request, { params }: any) {
  const region = String(params?.region || '').toUpperCase();
  if (!['IN','US','EU','UK'].includes(region)) {
    return NextResponse.json({ error: 'Bad region' }, { status: 400 });
  }

  const { accounts, api, id, secret } = zohoClientFor(region as any);
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  const redirect_uri = `${process.env.NEXTAUTH_URL}/api/zoho/${region}/callback`;
  const tok: any = await exchangeToken(accounts, id!, secret!, code, redirect_uri);
  const rt = tok.refresh_token || tok.refreshToken || tok.refresh;
  if (!rt) throw new Error('no refresh token');

  // TODO: replace with session email when NextAuth is wired
  const userEmail = 'owner@ultrahuman.com';

  await pool.query(
    `insert into zoho_connections
      (user_email, region_key, zoho_dc, accounts_host, api_host, refresh_token_enc)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (user_email, region_key)
     do update set refresh_token_enc = excluded.refresh_token_enc`,
    [
      userEmail,
      region,
      api.includes('.in') ? 'in' : api.includes('.eu') ? 'eu' : 'com',
      new URL(accounts).host,
      new URL(api).host,
      Buffer.from(seal(rt), 'utf8'),
    ]
  );

  return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/dashboard?connected=${region}`);
}
