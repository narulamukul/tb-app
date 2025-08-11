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

/** ---- TB flattening helpers ---- */
type TBRow = {
  section: string;
  account_id: string | null;
  account_code: string;
  account_name: string | null;
  depth: number | null;
  is_child_present: boolean | null;
  net_debit_total: number | null;
  net_credit_total: number | null;
  opening_debit?: number | null;
  opening_credit?: number | null;
  period_debit?: number | null;
  period_credit?: number | null;
  closing_debit?: number | null;
  closing_credit?: number | null;
  codes_enabled_in_section?: boolean;
};

function toNum(x: any): number | null {
  if (x === '' || x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function flattenZohoTrialBalance(tbJson: any): TBRow[] {
  // Expected Zoho Books TB JSON shape:
  // { code, message, trialbalance: [ { account_transactions: [ {name:'Assets', account_transactions:[...]} ] } ] }
  const sections = tbJson?.trialbalance?.[0]?.account_transactions;
  if (!Array.isArray(sections)) return [];

  const rows: TBRow[] = [];

  for (const section of sections) {
    const sectionName = section?.name ?? '';
    const codesEnabled = !!section?.is_account_code_column_enabled;

    const accounts: any[] = section?.account_transactions ?? [];
    for (const acc of accounts) {
      const vals = Array.isArray(acc?.values) && acc.values.length ? acc.values[0] : {};

      rows.push({
        section: String(sectionName),
        account_id: acc?.account_id ?? null,
        account_code: String((acc?.account_code ?? '')).trim(),
        account_name: acc?.name ?? null,
        depth: typeof acc?.depth === 'number' ? acc.depth : null,
        is_child_present: typeof acc?.is_child_present === 'boolean' ? acc.is_child_present : null,

        // Prefer inner values[...] if present; fall back to top-level fields
        net_debit_total: toNum(vals?.net_debit_total ?? acc?.net_debit_total),
        net_credit_total: toNum(vals?.net_credit_total ?? acc?.net_credit_total),

        // Optional fields if the org/report includes them
        opening_debit: toNum(vals?.opening_debit_total),
        opening_credit: toNum(vals?.opening_credit_total),
        period_debit: toNum(vals?.debit_total),
        period_credit: toNum(vals?.credit_total),
        closing_debit: toNum(vals?.closing_debit_total),
        closing_credit: toNum(vals?.closing_credit_total),

        codes_enabled_in_section: codesEnabled,
      });
    }
  }
  return rows;
}

function csvEscape(s: any): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function rowsToCSV(rows: TBRow[]): string {
  const headers = [
    'section',
    'account_id',
    'account_code',
    'account_name',
    'depth',
    'is_child_present',
    'net_debit_total',
    'net_credit_total',
    'opening_debit',
    'opening_credit',
    'period_debit',
    'period_credit',
    'closing_debit',
    'closing_credit',
    'codes_enabled_in_section',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const line = [
      r.section,
      r.account_id,
      r.account_code,
      r.account_name,
      r.depth,
      r.is_child_present,
      r.net_debit_total,
      r.net_credit_total,
      r.opening_debit,
      r.opening_credit,
      r.period_debit,
      r.period_credit,
      r.closing_debit,
      r.closing_credit,
      r.codes_enabled_in_section,
    ].map(csvEscape).join(',');
    lines.push(line);
  }
  // Normalize line endings to CRLF for Excel friendliness
  return lines.join('\r\n');
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

    // ---- STEP E: fetch JSON (no export_type), flatten, upload CSV ----
    let extracted: any = null;
    try {
      const jsonRes = await fetch(base, { headers: authHeaders });
      if (jsonRes.ok) {
        const tbJson = await jsonRes.json();
        const rows = flattenZohoTrialBalance(tbJson);
        const csv = rowsToCSV(rows);

        const csvName = `TB_${REGION}_${period}_Extract.csv`;
        const csvUpload = await drive.files.create({
          requestBody: { name: csvName, parents: [parent] },
          media: { mimeType: 'text/csv', body: Readable.from(Buffer.from(csv, 'utf8')) },
          fields: 'id, name, mimeType, webViewLink, size',
          supportsAllDrives: true,
        } as any);

        extracted = {
          id: csvUpload.data.id,
          name: csvUpload.data.name,
          webViewLink: csvUpload.data.webViewLink,
          mimeType: csvUpload.data.mimeType,
          size: csvUpload.data.size,
          rows: rows.length,
          accounts_with_code: rows.filter(r => r.account_code && r.account_code !== '').length,
          accounts_without_code: rows.filter(r => !r.account_code).length,
        };
      } else {
        extracted = { error: 'JSON fetch failed', status: jsonRes.status, statusText: jsonRes.statusText };
      }
    } catch (e: any) {
      extracted = { error: 'Extraction error', detail: String(e?.message || e) };
    }

    // 6) Return metadata for both files
    return j(true, {
      raw: {
        id: upload.data.id,
        name: upload.data.name,
        webViewLink: upload.data.webViewLink,
        mimeType: upload.data.mimeType,
        fileExtension: upload.data.fileExtension ?? ext,
        size: upload.data.size ?? buf.length,
      },
      extracted, // <-- flattened CSV meta (or error details)
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
