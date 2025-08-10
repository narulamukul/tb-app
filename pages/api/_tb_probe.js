import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

export default async function handler(req, res) {
  try {
    const region = String(req.query.region || 'IN').toUpperCase();
    const orgId  = String(req.query.org || '').trim();
    const from   = String(req.query.from || '').trim();   // YYYY-MM-DD
    const to     = String(req.query.to || '').trim();     // YYYY-MM-DD
    const USER   = 'owner@ultrahuman.com';

    if (!orgId || !from || !to) {
      return res.status(400).json({ ok:false, error:'Missing ?org=&from=&to=' });
    }

    // 1) Get sealed refresh token
    const r = await pool.query(
      `select refresh_token_enc from zoho_connections
       where user_email=$1 and region_key=$2 limit 1`,
      [USER, region]
    );
    if (!r.rowCount) {
      return res.status(400).json({ ok:false, error:`No Zoho connection for ${USER}/${region}` });
    }
    const raw = r.rows[0].refresh_token_enc;
    const sealed =
      typeof raw === 'string' ? raw :
      Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const refreshToken = unseal(sealed);

    // 2) Refresh to access token
    const { accounts, api, id, secret } = zohoClientFor(region);
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
    const tokJ = await tok.json().catch(() => ({}));
    if (!tok.ok || !tokJ.access_token) {
      return res.status(502).json({ ok:false, step:'refresh', status: tok.status, detail: tokJ });
    }
    const at = tokJ.access_token;

    // 3) Try two common parameter patterns Zoho uses for reports
    const tries = [];

    // A) what we’re currently doing
    tries.push({
      name: 'date_from/date_to + export_type',
      url: `${api}/books/v3/reports/trialbalance?organization_id=${encodeURIComponent(orgId)}&date_from=${from}&date_to=${to}&export_type=xlsx`,
    });

    // B) alternative pattern used by many Zoho Books report endpoints
    tries.push({
      name: 'from_date/to_date + filter_by + export_format',
      url: `${api}/books/v3/reports/trialbalance?organization_id=${encodeURIComponent(orgId)}&filter_by=DateRange.Custom&from_date=${from}&to_date=${to}&export_format=xls`,
    });

    const results = [];
    for (const t of tries) {
      const resp = await fetch(t.url, { headers: { Authorization: `Zoho-oauthtoken ${at}` } });
      const bodyText = await resp.text().catch(() => '');
      results.push({
        try: t.name,
        status: resp.status,
        ok: resp.ok,
        snippet: bodyText.slice(0, 1200), // return the first bit so we see the error message
      });
      if (resp.ok) break; // stop after first success
    }

    return res.status(200).json({ ok: true, region, orgId, from, to, results });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
