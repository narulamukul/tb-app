export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}

export async function POST(req: Request) {
  try {
    const { region, orgId, from, to, fmt = 'xlsx' } = await req.json();

    // 1) Validate inputs
    if (!region || !orgId || !from || !to) {
      return json(false, { error: 'Missing inputs (region/orgId/from/to)' }, 400);
    }
    const REGION = String(region).toUpperCase();
    if (!['IN', 'US', 'EU', 'UK'].includes(REGION)) {
      return json(false, { error: `Bad region: ${REGION}` }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return json(false, { error: 'Dates must be YYYY-MM-DD' }, 400);
    }

    // 2) Use same user as the callback (hard-coded until auth is wired)
    const USER_EMAIL = 'owner@ultrahuman.com';

    // 3) Load the sealed refresh token
    const row = await pool.query(
      `select refresh_token_enc from zoho_connections
         where user_email = $1 and region_key = $2
         limit 1`,
      [USER_EMAIL, REGION]
    );
    if (row.rowCount === 0) {
      return json(false, { error: `No Zoho connection found for ${REGION}. Click "Connect Zoho" first.` }, 400);
    }
    const raw = row.rows[0].refresh_token_enc as any;
    const sealed =
      typeof raw === 'string' ? raw :
      Buffer.isBuffer(raw) ? raw.toString('utf8') :
      String(raw);
    const refreshToken = unseal(sealed);

    // 4) Refresh -> access token
    const { accounts, api, id, secret } = zohoClientFor(REGION as any);
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
    const tokenJson: any = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      return json(false, { error: `Zoho token refresh failed: ${tokenRes.status} ${tokenRes.statusText}`, detail: tokenJson }, 502);
    }
    const accessToken = tokenJson.access_token as string;

    // 5) Trial Balance export — try both known parameter styles
    const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };

    // A) from_date/to_date + export_type (xlsx/pdf)
    const urlA =
      `${api}/books/v3/reports/trialbalance` +
      `?organization_id=${encodeURIComponent(orgId)}` +
      `&from_date=${from}&to_date=${to}` +
      `&export_type=${fmt === 'xlsx' ? 'xlsx' : 'pdf'}`;

    // B) from_date/to_date + export_format (xls/pdf)
    const urlB =
      `${api}/books/v3/reports/trialbalance` +
      `?organization_id=${encodeURIComponent(orgId)}` +
      `&from_date=${from}&to_date=${to}` +
      `&export_format=${fmt === 'xlsx' ? 'xls' : 'pdf'}`;

    const attempts = [urlA, urlB];
    let tbRes: Response | null = null;
    let lastErr = '';

    for (const u of attempts) {
      const r = await fetch(u, { headers: authHeader });
      if (r.ok) { tbRes = r; break; }
      lastErr = await r.text().catch(() => '');
    }

    if (!tbRes) {
      return json(false, {
        error: 'Zoho TB export failed (all variants)',
        detail: lastErr?.slice(0, 1200),
        tried: { urlA, urlB },
      }, 400);
    }

    const blob = Buffer.from(await tbRes.arrayBuffer());

    // 6) Upload to Google Drive (service account) — stream body (no Buffer)
    const { google } = await import('googleapis');
    const sa = JSON.parse(String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'));

    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const drive = google.drive({ version: 'v3', auth });
    const parent = String(process.env.GOOGLE_DRIVE_PARENT_ID || '');
    if (!parent) return json(false, { error: 'Missing GOOGLE_DRIVE_PARENT_ID' }, 500);

    const fileName = `TB_${REGION}_${from.slice(0, 7)}.${fmt}`;
    const mime = fmt === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/pdf';

    // Convert Buffer -> Readable stream (googleapis expects a stream for media.body)
    const stream = Readable.from(blob);

    const g = await drive.files.create({
      requestBody: { name: fileName, parents: [parent] },
      media: { mimeType: mime, body: stream },
      fields: 'id, name',
    } as any);

    return json(true, { driveFileId: g.data.id, driveFileName: g.data.name });
  } catch (e: any) {
    console.error('[export] error', e);
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
