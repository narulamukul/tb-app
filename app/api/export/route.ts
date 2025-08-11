export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

/* ---------------- helpers ---------------- */

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}

type Guess = { ext: 'xlsx' | 'xls' | 'csv' | 'pdf' | 'json'; mime: string };

function guessExtMime(buf: Buffer, contentType?: string | null, contentDisp?: string | null): Guess {
  if (contentDisp) {
    const m = /filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i.exec(contentDisp);
    const filename = decodeURIComponent(m?.[1] || m?.[2] || '').toLowerCase();
    if (filename.endsWith('.xlsx')) return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (filename.endsWith('.xls'))  return { ext: 'xls',  mime: 'application/vnd.ms-excel' };
    if (filename.endsWith('.csv'))  return { ext: 'csv',  mime: 'text/csv' };
    if (filename.endsWith('.pdf'))  return { ext: 'pdf',  mime: 'application/pdf' };
    if (filename.endsWith('.json')) return { ext: 'json', mime: 'application/json' };
  }
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('officedocument.spreadsheetml.sheet')) return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (ct.includes('vnd.ms-excel'))                        return { ext: 'xls',  mime: 'application/vnd.ms-excel' };
    if (ct.includes('text/csv') || ct.includes('application/csv')) return { ext: 'csv', mime: 'text/csv' };
    if (ct.includes('pdf'))                                 return { ext: 'pdf',  mime: 'application/pdf' };
    if (ct.includes('json'))                                return { ext: 'json', mime: 'application/json' };
  }
  const b = buf;
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) {
    return { ext: 'xls', mime: 'application/vnd.ms-excel' };
  }
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  return { ext: 'json', mime: 'application/json' };
}

/* ---- deep JSON → tables with flattening ---- */

type Table = { name: string; rows: any[]; size: number };

function flattenRow(obj: any, prefix = '', out: Record<string, any> = {}, depth = 0): Record<string, any> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== 'object' || depth > 4) { out[prefix || 'value'] = obj; return out; }
  if (Array.isArray(obj)) {
    if (obj.every(v => v === null || typeof v !== 'object')) out[prefix || 'value'] = obj.join('; ');
    else out[prefix || 'value'] = JSON.stringify(obj);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flattenRow(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

function collectTablesDeep(node: any, path = 'root', out: Table[] = []): Table[] {
  if (!node) return out;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && !Array.isArray(node[0])) {
      const rows = node.map(r => flattenRow(r));
      out.push({ name: path.slice(-64), rows, size: rows.length });
    }
    node.forEach((v, i) => collectTablesDeep(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectTablesDeep(v, `${path}.${k}`, out);
  }
  return out;
}

function extractTablesFromZohoDeep(json: any): Table[] {
  const all = collectTablesDeep(json, 'root');
  const score = (t: Table) => {
    const p = t.name.toLowerCase();
    let s = t.size;
    if (p.includes('trial') || p.includes('tb')) s += 10_000;
    if (p.includes('.values'))                 s += 5_000;
    if (p.includes('rows') || p.includes('records') || p.includes('items')) s += 2_000;
    return s;
  };
  all.sort((a, b) => score(b) - score(a));
  return all.map((t, i) => {
    let name = t.name.split('.').slice(-1)[0] || `Sheet${i + 1}`;
    name = name.replace(/\[.*?\]/g, '').replace(/[^A-Za-z0-9 _-]/g, '').trim();
    if (!name) name = `Sheet${i + 1}`;
    return { ...t, name: name.slice(0, 31) };
  });
}

/* --------------------- handler --------------------- */

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { region, orgId, from, to, debug = false } = body as {
      region: string; orgId: string; from: string; to: string; debug?: boolean;
    };

    if (!region || !orgId || !from || !to) return json(false, { error: 'Missing inputs (region/orgId/from/to)' }, 400);
    const REGION = String(region).toUpperCase();
    if (!['IN','US','EU','UK'].includes(REGION)) return json(false, { error: `Bad region: ${REGION}` }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return json(false, { error: 'Dates must be YYYY-MM-DD' }, 400);
    }

    const USER_EMAIL = 'owner@ultrahuman.com';

    const row = await pool.query(
      `select refresh_token_enc from zoho_connections
       where user_email=$1 and region_key=$2 limit 1`,
      [USER_EMAIL, REGION]
    );
    if (!row.rowCount) return json(false, { error: `No Zoho connection found for ${REGION}` }, 400);

    const sealedRaw = row.rows[0].refresh_token_enc as any;
    const sealed = typeof sealedRaw === 'string' ? sealedRaw : Buffer.isBuffer(sealedRaw) ? sealedRaw.toString('utf8') : String(sealedRaw);
    const refreshToken = unseal(sealed);

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
    const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };

    const base = `${api}/books/v3/reports/trialbalance?organization_id=${encodeURIComponent(orgId)}&from_date=${from}&to_date=${to}`;
    const attempts: string[] = [
      `${base}&export_type=xlsx`,
      `${base}&export_format=xls`,
      `${base}`, // JSON fallback
    ];

    let resp: Response | null = null, lastErr = '';
    for (const url of attempts) {
      const r = await fetch(url, { headers });
      if (r.ok) { resp = r; break; }
      lastErr = await r.text().catch(() => '');
    }
    if (!resp) return json(false, { error: 'Zoho TB request failed', detail: lastErr.slice(0, 1200), tried: attempts }, 400);

    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get('content-type') || '';
    const cd = resp.headers.get('content-disposition') || '';
    const guess = guessExtMime(buf, ct, cd);

    let uploadBuf = buf;
    let uploadExt = guess.ext;
    let uploadMime = guess.mime;
    let convertedFromJson = false;

    // JSON detection (also handles BOM)
    const textHead = buf.toString('utf8', 0, Math.min(buf.length, 128));
    const looksJson =
      uploadExt === 'json' ||
      ct.toLowerCase().includes('json') ||
      /^[\uFEFF\s\r\n]*[\{\[]/.test(textHead);

    // prepare Drive (also used for debug upload)
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

    if (looksJson) {
      const rawText = buf.toString('utf8').replace(/^\uFEFF/, ''); // strip BOM
      let jsonBody: any;
      try {
        jsonBody = JSON.parse(rawText);
      } catch (e: any) {
        // Upload raw JSON (debug) and return parse error
        let debugUpload;
        if (debug) {
          const dbg = await drive.files.create({
            requestBody: { name: `TB_${REGION}_${from.slice(0,7)}_RAW.json`, parents: [parent] },
            media: { mimeType: 'application/json', body: Readable.from(Buffer.from(rawText, 'utf8')) },
            fields: 'id, webViewLink, name',
            supportsAllDrives: true,
          } as any);
          debugUpload = dbg.data;
        }
        return json(false, {
          error: 'Zoho JSON parse failed',
          parseError: String(e?.message || e),
          head: rawText.slice(0, 500),
          contentType: ct,
          debugFile: debugUpload,
        }, 422);
      }

      // if Zoho returned an error JSON, surface it
      if (jsonBody?.code && jsonBody?.message && !jsonBody?.trialbalance && !jsonBody?.data) {
        return json(false, { error: 'Zoho error', zoho: { code: jsonBody.code, message: jsonBody.message } }, 400);
      }

      const tables = extractTablesFromZohoDeep(jsonBody);
      if (!tables.length) {
        // Upload raw (debug) so we can inspect structure
        let debugUpload;
        if (debug) {
          const dbg = await drive.files.create({
            requestBody: { name: `TB_${REGION}_${from.slice(0,7)}_RAW.json`, parents: [parent] },
            media: { mimeType: 'application/json', body: Readable.from(Buffer.from(JSON.stringify(jsonBody, null, 2))) },
            fields: 'id, webViewLink, name',
            supportsAllDrives: true,
          } as any);
          debugUpload = dbg.data;
        }
        return json(false, {
          error: 'Zoho JSON returned but no table-like data found',
          previewKeys: Object.keys(jsonBody).slice(0, 30),
          debugFile: debugUpload,
        }, 422);
      }

      const XLSXmod: any = await import('xlsx');
      const XLSX = XLSXmod?.default ?? XLSXmod;

      const wb = XLSX.utils.book_new();
      const TOP = tables.slice(0, 6);
      TOP.forEach((t, idx) => {
        const ws = XLSX.utils.json_to_sheet(t.rows);
        let name = t.name;
        const low = name.toLowerCase();
        if (low.includes('values')) name = 'TrialBalance';
        else if (low.includes('rows')) name = 'TrialBalanceRows';
        XLSX.utils.book_append_sheet(wb, ws, (name || `Sheet${idx + 1}`).slice(0, 31));
      });

      uploadBuf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      uploadExt  = 'xlsx';
      uploadMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      convertedFromJson = true;
    }

    const fileName = `TB_${REGION}_${from.slice(0,7)}.${uploadExt}`;
    const stream = Readable.from(uploadBuf);

    const g = await drive.files.create({
      requestBody: { name: fileName, parents: [parent] },
      media: { mimeType: uploadMime, body: stream },
      fields: 'id, name, mimeType, fileExtension, webViewLink, parents',
      supportsAllDrives: true,
    } as any);

    return json(true, {
      driveFileId: g.data.id,
      driveFileName: g.data.name,
      mimeType: g.data.mimeType,
      fileExtension: g.data.fileExtension,
      webViewLink: g.data.webViewLink,
      detectedResponse: guess.ext,
      convertedFromJson,
    });
  } catch (e: any) {
    console.error('[export] error', e);
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
