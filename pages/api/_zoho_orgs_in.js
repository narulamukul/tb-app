import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

export default async function handler(_req, res) {
  try {
    const USER = 'owner@ultrahuman.com';
    const REGION = 'IN';

    const r = await pool.query(
      `select refresh_token_enc from zoho_connections
       where user_email=$1 and region_key=$2 limit 1`,
      [USER, REGION]
    );
    if (!r.rowCount) return res.status(400).json({ ok:false, error:'No IN connection' });

    const raw = r.rows[0].refresh_token_enc;
    const sealed = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const refreshToken = unseal(sealed);

    const { accounts, api, id, secret } = zohoClientFor(REGION);
    const tok = await fetch(`${accounts}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: String(id),
        client_secret: String(secret),
      }),
    });
    const tj = await tok.json();
    if (!tok.ok || !tj.access_token) return res.status(502).json({ ok:false, step:'refresh', tj, status: tok.status });

    const orgs = await fetch(`${api}/books/v3/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${tj.access_token}` },
    });
    const body = await orgs.json();
    return res.status(200).json({ ok:true, status: orgs.status, organizations: body.organizations || body });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
