// app/api/export/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

/** Small JSON responder */
function j(ok: boolean, data: any, status = 200) {
  return NextResponse.json({ ok, ...data }, { status });
}

/** Try to guess file extension & mime from headers and magic bytes */
function guessExtMime(buf: Buffer, ct?: string | null, cd?: string | null): { ext: string; mime: string } {
  // filename from Content-Disposition
  if (cd) {
    const m = /filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i.exec(cd);
    const fn = decodeURIComponent(m?.[1] || m?.[2] || '').toLowerCase();
    if (fn.endsWith('.xlsx')) return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (fn.endsWith('.xls'))  return { ext: 'xls',  mime: 'application/vnd.ms-excel' };
    if (fn.endsWith('.csv'))  return { ext: 'csv',  mime: 'text/csv' };
    if (fn.endsWith('.pdf'))  return { ext: 'pdf',  mime: 'application/pdf' };
    if (fn.endsWith('.json')) return { ext: 'json', mime: 'application/json' };
    if (fn.endsWith('.zip'))  return { ext: 'zip',  mime: 'application/zip' };
  }
  // content-type
  if (ct) {
    const t = ct.toLowerCase();
    if (t.includes('officedocument.spreadsheetml.sheet')) return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (t.includes('vnd.ms-excel'))                        return { ext: 'xls',  mime: 'application/vnd.ms-excel' };
    if (t.includes('text/csv') || t.includes('application/csv')) return { ext: 'csv', mime: 'text/csv' };
    if (t.includes('pdf'))                                 return { ext: 'pdf',  mime: 'application/pdf' };
    if (t.includes('json'))                                return { ext: 'json', mime: 'application/json' };
    if (t.includes('zip'))                                 return { ext: 'zip',  mime: 'application/zip' };
  }
  // magic bytes
  const b = buf;
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    // ZIP container (xlsx or zip). Default to xlsx because Zoho exports use OOXML.
    return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  if (b.length >= 8 &&
      b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
      b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) {
    return { ext: 'xls', mime: 'application/vnd.ms-excel' };
  }
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  // fallback
  return { ext: 'json', mime: 'application/json' };
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { region, orgId, from, to, prefer } = body as {
      region: 'IN' | 'US' | 'EU' | 'UK';
      orgId: string;
      from: string; // YYYY-MM-DD
      to: string;   // YYYY-MM-DD
      prefer?: 'xlsx' | 'xls' | 'csv' | 'pdf' | 'json' | 'auto';
    };

    if (!region || !orgId || !from || !to) {
      return j(false, { error: 'Missing inputs (region, orgId, from, to)' }, 400);
    }
    const REGION = region.toUpperCase();
    if (!['IN', 'US', 'EU', 'UK'].includes(REGION)) {
      return j(false, { error: `Unsupported region: ${REGION}` }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return j(false, { error: 'from/to must be YYYY-MM-DD' }, 400);
    }

    const USER_EMAIL = 'owner@ultrahuman.com'; // adjust if you key by actual user

    // 1) get sealed Zoho refresh token from DB
    const q = await pool.query(
      `select refresh_token_enc from zoho_connections
       where user_email=$1 and region_key=$2 limit 1`,
      [USER_EMAIL, REGION]
    );
    if (!q.rowCount) {
      return j(false, { error: `No Zoho connection found for ${REGION}` }, 400);
    }
    const sealedRaw = q.rows[0].refresh_token_enc as any;
    const sealed = typeof sealedRaw === 'string'
      ? sealedRaw
      : Buffer.isBuffer(sealedRaw)
      ? sealedRaw.toString('utf8')
      : String(sealedRaw);
    const refreshToken = unseal(sealed);

    // 2) refresh token → access token
    const { accounts, api, id, secret } = zohoClientFor(REGION as any);
    const tokRes = await fetch(`${accounts}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: String(id),
        client_secret: String(secret),
      }),
    });
    const tokJson: any = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokJson?.access_token) {
      return j(false, { error: 'Zoho token refresh failed', detail: tokJson }, 502);
    }
    const accessToken = tokJson.access_token as string;
    const authHeaders = { Authorization: `Zoho-oauthtoken ${accessToken}` };

    // 3) Build TB URL(s); try preferred type first, then JSON
    const base = `${api}/books/v3/reports/trialbalance?organization_id=${encodeURIComponent(orgId)}&from_date=${from}&to_date=${to}`;
    const preferLower = (prefer || 'auto').toLowerCase();

    const attemptUrls: string[] = [];
    if (preferLower === 'xlsx') attemptUrls.push(`${base}&export_type=xlsx`);
    if (preferLower === 'xls')  attemptUrls.push(`${base}&export_type=xls`);
    if (preferLower === 'csv')  attemptUrls.push(`${base}&export_type=csv`);
    if (preferLower === 'pdf')  attemptUrls.push(`${base}&export_type=pdf`);
    if (preferLower === 'json') attemptUrls.push(base);
    if (preferLower === 'auto' || attemptUrls.length === 0) {
      // sensible default: ask for xlsx first, then fall back to JSON
      attemptUrls.push(`${base}&export_type=xlsx`);
      attemptUrls.push(base);
    }

    // 4) Fetch raw file from Zoho
    let resp: Response | null = null;
    let lastText = '';
    for (const url of attemptUrls) {
      const r = await fetch(url, { headers: authHeaders });
      if (r.ok) { resp = r; break; }
      lastText = await r.text().catch(() => '');
    }
    if (!resp) {
      return j(false, { error: 'Zoho TB request failed', tried: attemptUrls, detail: lastText?.slice(0, 1200) }, 502);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type');
    const contentDisp  = resp.headers.get('content-disposition');
    const { ext, mime } = guessExtMime(buf, contentType, contentDisp);

    // 5) Upload RAW to Google Drive
    const { google } = await import('googleapis');
    const sa = JSON.parse(String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'));
    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const parent = String(process.env.GOOGLE_DRIVE_PARENT_ID || '');
    if (!parent) return j(false, { error: 'Missing GOOGLE_DRIVE_PARENT_ID' }, 500);

    const period = from.slice(0, 7); // YYYY-MM
    const filename = `TB_${REGION}_${period}_RAW.${ext}`;

    const upload = await drive.files.create({
      requestBody: { name: filename, parents: [parent] },
      media: { mimeType: mime, body: Readable.from(buf) },
      fields: 'id, name, mimeType, fileExtension, webViewLink, size',
      supportsAllDrives: true,
    } as any);

    // 6) Return only metadata about the RAW file
    return j(true, {
      raw: {
        id: upload.data.id,
        name: upload.data.name,
        webViewLink: upload.data.webViewLink,
        mimeType: upload.data.mimeType,
        fileExtension: upload.data.fileExtension ?? ext,
        size: upload.data.size ?? buf.length,
      },
      detect: {
        guessedExt: ext,
        guessedMime: mime,
        contentType,
        contentDisposition: contentDisp,
      },
      zoho: {
        status: resp.status,
        statusText: resp.statusText,
      },
      tried: attemptUrls,
    });
  } catch (e: any) {
    console.error('[export raw] error', e);
    return j(false, { error: String(e?.message || e) }, 500);
  }
}
