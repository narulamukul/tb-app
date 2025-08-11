// app/api/export/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

/* ---------------- small helpers ---------------- */

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
  // XLSX ZIP
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  // Legacy XLS OLE
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
      b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) {
    return { ext: 'xls', mime: 'application/vnd.ms-excel' };
  }
  // PDF
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  return { ext: 'json', mime: 'application/json' };
}

/* ------ JSON → tables (deep search + flatten safely) ------ */

type Table = { name: string; rows: any[]; size: number };

// Excel cell limit guard
const MAX_CELL = 32000;
function safeCell(v: any): any {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (v.length > MAX_CELL) return v.slice(0, MAX_CELL) + '…(truncated)';
    return v;
  }
  return v;
}

// keys that tend to be HUGE; summarize instead of dumping JSON
const PRUNE_PATTERNS: RegExp[] = [
  /account_transactions/i,
  /previous_values/i,
  /account_type_col_span_list/i,
  /columns/i,
  /history/i,
  /audit/i,
];
function shouldSummarize(path: string): boolean {
  return PRUNE_PATTERNS.some((re) => re.test(path));
}

// flatten nested objects into dot.notation columns, summarizing huge branches
function flattenRow(obj: any, prefix = '', out: Record<string, any> = {}, depth = 0): Record<string, any> {
  if (obj === null || obj === undefined) return out;

  // Avoid exploding deeply
  if (depth > 4) {
    out[prefix || 'value'] = '[nested object]';
    return out;
  }

  if (typeof obj !== 'object') {
    out[prefix || 'value'] = safeCell(obj);
    return out;
  }

  if (Array.isArray(obj)) {
    if (obj.every(v => v === null || typeof v !== 'object')) {
      out[prefix || 'value'] = safeCell(obj.join('; '));
    } else {
      out[prefix || 'value'] = `[${obj.length} items]`;
    }
    return out;
  }

  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      if (shouldSummarize(key)) {
        if (Array.isArray(v)) out[key] = `[${v.length} items]`;
        else out[key] = '[object]';
      } else {
        flattenRow(v, key, out, depth + 1);
      }
    } else {
      out[key] = safeCell(v);
    }
  }
  return out;
}

// collect ALL arrays-of-objects with their JSON path
function collectTablesDeep(node: any, path = 'root', out: Table[] = []): Table[] {
  if (!node) return out;

  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && !Array.isArray(node[0])) {
      const rows = node.map((r) => flattenRow(r));
      out.push({ name: path.slice(-64), rows, size: rows.length });
    }
    node.forEach((v, i) => collectTablesDeep(v, `${path}[${i}]`, out));
    return out;
  }

  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectTablesDeep(v, `${path}.${k}`, out);
    }
  }

  return out;
}

function extractTablesFromZohoDeep(json: any): Table[] {
  const all = collectTablesDeep(json, 'root');

  // Prefer the largest, “TB-looking” arrays
  const score = (t: Table) => {
    const p = t.name.toLowerCase();
    let s = t.size;
    if (p.includes('trial') || p.includes('tb')) s += 10_000;
    if (p.includes('.values'))                 s += 5_000;
    if (p.includes('rows') || p.includes('records') || p.includes('items')) s += 2_000;
    return s;
  };

  all.sort((a, b) => score(b) - score(a));

  // Prettify names
  return all.map((t, i) => {
    let name = t.name.split('.').slice(-1)[0] || `Sheet${i + 1}`;
    name = name.replace(/\[.*?\]/g, '').replace(/[:\\/?*\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) name = `Sheet${i + 1}`;
    return { ...t, name: name.slice(0, 31) };
  });
}

/* ---- Excel sheet name sanitizing + de-duplication ---- */

function sanitizeSheetName(raw: string) {
  let name = (raw || 'Sheet')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[:\\/?*\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) name = 'Sheet';
  return name.slice(0, 31);
}
function uniqueSheetName(seen: Set<string>, base: string) {
  let name = sanitizeSheetName(base);
  if (!seen.has(name)) { seen.add(name); return name; }
  for (let i = 2; i < 200; i++) {
    const suffix = ` (${i})`;
    const head = name.slice(0, 31 - suffix.length);
    const candidate = head + suffix;
    if (!seen.has(candidate)) { seen.add(candidate); return candidate; }
  }
  const fallback = (name.slice(0, 20) + '_' + (Date.now() % 100000)).slice(0, 31);
  seen.add(fallback);
  return fallback;
}

/* ---------------------- handler ---------------------- */

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { region, orgId, from, to } = body as {
      region: string; orgId: string; from: string; to: string;
    };

    if (!region || !orgId || !from || !to) return json(false, { error: 'Missing inputs (region/orgId/from/to)' }, 400);
    const REGION = String(region).toUpperCase();
    if (!['IN','US','EU','UK'].includes(REGION)) return json(false, { error: `Bad region: ${REGION}` }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return json(false, { error: 'Dates must be YYYY-MM-DD' }, 400);
    }

    // single-user for now
    const USER_EMAIL = 'owner@ultrahuman.com';

    // load sealed refresh token
    const row = await pool.query(
      `select refresh_token_enc from zoho_connections
       where user_email=$1 and region_key=$2 limit 1`,
      [USER_EMAIL, REGION]
    );
    if (!row.rowCount) return json(false, { error: `No Zoho connection found for ${REGION}` }, 400);

    const sealedRaw = row.rows[0].refresh_token_enc as any;
    const sealed = typeof sealedRaw === 'string' ? sealedRaw : Buffer.isBuffer(sealedRaw) ? sealedRaw.toString('utf8') : String(sealedRaw);
    const refreshToken = unseal(sealed);

    // refresh → access token
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

    // Try export variants; fall back to raw JSON
    const base = `${api}/books/v3/reports/trialbalance?organization_id=${encodeURIComponent(orgId)}&from_date=${from}&to_date=${to}`;
    const attempts: string[] = [
      `${base}&export_type=xlsx`,
      `${base}&export_format=xls`,
      `${base}`, // JSON
    ];

    let resp: Response | null = null, lastErr = '';
    for (const url of attempts) {
      const r = await fetch(url, { headers });
      if (r.ok) { resp = r; break; }
      lastErr = await r.text().catch(() => '');
    }
    if (!resp) return json(false, { error: 'Zoho TB request failed', detail: lastErr.slice(0, 1200), tried: attempts }, 400);

    // payload
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get('content-type') || '';
    const cd = resp.headers.get('content-disposition') || '';
    const rawGuess = guessExtMime(buf, ct, cd);

    // JSON detection (with BOM-safe head check)
    const head = buf.toString('utf8', 0, Math.min(buf.length, 128));
    const looksJson =
      rawGuess.ext === 'json' ||
      ct.toLowerCase().includes('json') ||
      /^[\uFEFF\s\r\n]*[\{\[]/.test(head);

    // prepare Drive
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

    const period = from.slice(0, 7);

    /* 1) Always upload RAW */
    const rawName = `TB_${REGION}_${period}_RAW.${rawGuess.ext}`;
    const rawUpload = await drive.files.create({
      requestBody: { name: rawName, parents: [parent] },
      media: { mimeType: rawGuess.mime, body: Readable.from(buf) },
      fields: 'id, name, mimeType, fileExtension, webViewLink',
      supportsAllDrives: true,
    } as any);

    /* 2) Build XLSX (convert when needed) */
    let xlsxBuf: Buffer;

    if (looksJson) {
      // JSON → tables → XLSX
      const rawText = buf.toString('utf8').replace(/^\uFEFF/, '');
      let jsonBody: any;
      try { jsonBody = JSON.parse(rawText); }
      catch (e: any) {
        // If parse fails, still create a minimal workbook explaining the issue
        const XLSXmod: any = await import('xlsx');
        const XLSX = XLSXmod?.default ?? XLSXmod;
        const ws = XLSX.utils.aoa_to_sheet([
          ['Zoho returned non-JSON content that looks like JSON but failed to parse.'],
          ['Content-Type', ct],
          ['Error', String(e?.message || e)],
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Info');
        xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      }

      if (jsonBody) {
        if (jsonBody?.code && jsonBody?.message && !jsonBody?.trialbalance && !jsonBody?.data) {
          const XLSXmod: any = await import('xlsx');
          const XLSX = XLSXmod?.default ?? XLSXmod;
          const ws = XLSX.utils.aoa_to_sheet([
            ['Zoho returned error JSON'],
            ['code', jsonBody.code],
            ['message', jsonBody.message],
          ]);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Zoho Error');
          xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        } else {
          const tables = extractTablesFromZohoDeep(jsonBody);
          const XLSXmod: any = await import('xlsx');
          const XLSX = XLSXmod?.default ?? XLSXmod;
          const wb = XLSX.utils.book_new();

          if (!tables.length) {
            const ws = XLSX.utils.aoa_to_sheet([
              ['No table-like arrays found in Zoho JSON.'],
              ['Top-level keys', Object.keys(jsonBody).slice(0, 30).join(', ')],
            ]);
            XLSX.utils.book_append_sheet(wb, ws, 'Info');
          } else {
            const seen = new Set<string>();
            tables.slice(0, 8).forEach((t, idx) => {
              const ws = XLSX.utils.json_to_sheet(t.rows);
              let base = t.name || `Sheet${idx + 1}`;
              const low = base.toLowerCase();
              if (low.includes('values')) base = 'Trial Balance';
              else if (low.includes('rows')) base = 'Trial Balance Rows';
              const safe = uniqueSheetName(seen, base);
              XLSX.utils.book_append_sheet(wb, ws, safe);
            });
          }
          xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        }
      }
    } else if (rawGuess.ext === 'xlsx') {
      // Already XLSX
      xlsxBuf = buf;
    } else if (rawGuess.ext === 'xls' || rawGuess.ext === 'csv') {
      // Convert XLS/CSV → XLSX
      const XLSXmod: any = await import('xlsx');
      const XLSX = XLSXmod?.default ?? XLSXmod;
      const wbIn = XLSX.read(buf, { type: 'buffer' });

      // enforce cell length in all sheets
      for (const sn of wbIn.SheetNames) {
        const ws = wbIn.Sheets[sn];
        const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
        if (!range) continue;
        for (let R = range.s.r; R <= range.e.r; R++) {
          for (let C = range.s.c; C <= range.e.c; C++) {
            const addr = XLSX.utils.encode_cell({ r: R, c: C });
            const cell = ws[addr];
            if (cell && typeof cell.v === 'string' && cell.v.length > MAX_CELL) {
              cell.v = cell.v.slice(0, MAX_CELL) + '…(truncated)';
            }
          }
        }
      }
      xlsxBuf = XLSX.write(wbIn, { type: 'buffer', bookType: 'xlsx' });
    } else {
      // PDF/other → create info workbook
      const XLSXmod: any = await import('xlsx');
      const XLSX = XLSXmod?.default ?? XLSXmod;
      const ws = XLSX.utils.aoa_to_sheet([
        ['Zoho returned a non-Excel format (e.g., PDF).'],
        ['Content-Type', ct],
        ['We saved the original as RAW; conversion to XLSX is not applicable.'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Info');
      xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    }

    const xlsxName = `TB_${REGION}_${period}.xlsx`;
    const xlsxUpload = await drive.files.create({
      requestBody: { name: xlsxName, parents: [parent] },
      media: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Readable.from(xlsxBuf) },
      fields: 'id, name, mimeType, fileExtension, webViewLink',
      supportsAllDrives: true,
    } as any);

    return json(true, {
      raw: {
        id: rawUpload.data.id,
        name: rawUpload.data.name,
        mimeType: rawUpload.data.mimeType,
        webViewLink: rawUpload.data.webViewLink,
        ext: rawGuess.ext,
      },
      xlsx: {
        id: xlsxUpload.data.id,
        name: xlsxUpload.data.name,
        mimeType: xlsxUpload.data.mimeType,
        webViewLink: xlsxUpload.data.webViewLink,
      },
      sourceType: looksJson ? 'json' : rawGuess.ext,
    });
  } catch (e: any) {
    console.error('[export] error', e);
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
