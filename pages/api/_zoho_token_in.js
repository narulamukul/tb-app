import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

export default async function handler(_req, res) {
  try {
    const USER_EMAIL = 'owner@ultrahuman.com';
    const REGION = 'IN';
    const r = await pool.query(
      `select refresh_token_enc from zoho_connections
        where user_email=$1 and region_key=$2 limit 1`,
      [USER_EMAIL, REGION]
    );
    if (!r.rowCount) return res.status(400).json({ ok:false, error:'no refresh token in DB' });

    const refreshToken = unseal(Buffer.from(r.rows[0].refresh_token_enc, 'utf8').toString());
    const { accounts, id, secret } = zohoClientFor(REGION);

    const tokenRes = await fetch(`${accounts}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: String(id),
        client_secret: String(secret),
      }),
    });
    const json = await tokenRes.json().catch(() => ({}));
    return res.status(200).json({ ok: tokenRes.ok, status: tokenRes.status, has_access_token: !!json.access_token, json });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
