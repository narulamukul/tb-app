export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}

type Guess = { ext: 'xlsx' | 'xls' | 'pdf'; mime: string };

function guessExtMime(buf: Buffer, contentType?: string | null, contentDisp?: string | null): Guess {
  // 1) Try filename from Content-Disposition
  if (contentDisp) {
    const m =
      /filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i.exec(contentDisp);
    const filename = decodeURIComponent(m?.[1] || m?.[2] || '').toLowerCase();
    if (filename.endsWith('.xlsx')) return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (filename.endsWith('.xls'))  return { ext: 'xls',  mime: 'application/vnd.ms-excel' };
    if (filename.endsWith('.pdf'))  return { ext: 'pdf',  mime: 'application/pdf' };
  }

  // 2) Use Content-Type
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('officedocument.spreadsheetml.sheet')) {
      return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    if (ct.includes('vnd.ms-excel')) {
      return { ext: 'xls', mime: 'application/vnd.ms-excel' };
    }
    if (ct.includes('pdf')) {
      return { ext: 'pdf', mime: 'application/pdf' };
    }
  }

  // 3) Magic bytes
  const b = buf;
  // XLSX is a ZIP: 50 4B 03 04
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  // Legacy XLS (OLE): D0 CF 11 E0 A1 B1 1A E1
  if (
    b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
    b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1
  ) {
    return { ext: 'xls', mime: 'application/vnd.ms-excel' };
  }
  // PDF: %PDF
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }

  // Fallback: treat as XLS (Zoho often sends this for "xls" exports)
  return { ext: 'xls', mime: 'application/vnd.ms-excel' };
}

export async function POST(req: Request) {
  try {
    const { region, orgId, from, to, fmt = 'xlsx' } = await req.json();

    if (!region || !orgId || !from || !to) return json(false, { error: 'Missing inputs (region/orgId/from/to)' }, 400);
    const REGION = String(region).toUpperCase();
    if (!['IN', 'US', 'EU', 'UK'].includes(REGION)) return json(false, { error: `Bad region: ${REGION}` }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return json(false, { error: 'Dates must be YYYY-MM-DD' }, 400);
    }

    // Our temporary user key
    const USER_EMAIL = 'owner@ultrahuman.com';

    // Load sealed refresh token
    const row = await pool.query(
      `select refresh_token_enc from zoho_connections
       where user_email=$1 and region_key=$2
       limit 1`,
      [USER_EMAIL, REGION]
    );
    if (!row.rowCount) return json(false, { error: `No Zoho connection found for ${REGION}` }, 400);

    const raw = row.rows[0].refresh_token_enc as any;
    const sealed = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const refreshToken = unseal(sealed);

    // Refresh -> access token
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

    // Build both TB URLs (Zoho varies)
    const authHeader = { Authorization: `Zoho-oauthtoken ${accessToken}` };

    // Prefer xlsx if available
    const urlA =
      `${api}/books/v3/reports/trialbalance` +
      `?organization_id=${encodeURIComponent(orgId)}` +
      `&from_date=${from}&to_date=${to}` +
      `&export_type=${fmt === 'xlsx' ? 'xlsx' : 'pdf'}`;

    // Fallback xls
    const urlB =
      `${api}/books/v3/reports/trialbalance` +
      `?organization_id=${encodeURIComponent(orgId)}` +
      `&from_date=${from}&to_date=${to}` +
      `&export_format=${fmt === 'xlsx' ? 'xls' : 'pdf'}`;

    // Try in order
    let tbRes: Response | null = null;
    let lastErr = '';
    for (const u of [urlA, urlB]) {
      const r = await fetch(u, { headers: authHeader });
      if (r.ok) { tbRes = r; break; }
      lastErr = await r.text().catch(() => '');
    }
    if (!tbRes) {
      return json(false, { error: 'Zoho TB export failed', detail: lastErr?.slice(0, 1200) }, 400);
    }

    // Read bytes and deduce actual format
    const buf = Buffer.from(await tbRes.arrayBuffer());
    const guess = guessExtMime(buf, tbRes.headers.get('content-type'), tbRes.headers.get('content-disposition'));

    // Upload to Drive (Shared Drive compatible)
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

    const fileName = `TB_${REGION}_${from.slice(0, 7)}.${guess.ext}`;
    const stream = Readable.from(buf);

    const g = await drive.files.create({
      requestBody: { name: fileName, parents: [parent] },
      media: { mimeType: guess.mime, body: stream },
      fields: 'id, name, mimeType, fileExtension, webViewLink, parents',
      supportsAllDrives: true,
    } as any);

    return json(true, {
      driveFileId: g.data.id,
      driveFileName: g.data.name,
      mimeType: g.data.mimeType,
      fileExtension: g.data.fileExtension,
      webViewLink: g.data.webViewLink,
    });
  } catch (e: any) {
    console.error('[export] error', e);
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
