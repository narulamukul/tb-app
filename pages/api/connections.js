import { pool } from '@/lib/db';

export default async function handler(_req, res) {
  try {
    const r = await pool.query(
      `select user_email, region_key, zoho_dc, accounts_host, api_host,
              length(refresh_token_enc) as token_len
         from zoho_connections
        order by user_email, region_key
        limit 10`
    );
    res.status(200).json({ ok: true, rows: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
