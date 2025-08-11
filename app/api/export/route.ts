// app/api/export/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { pool } from '@/lib/db';
import { zohoClientFor } from '@/lib/zoho';
import { unseal } from '@/lib/crypto';

/* ---------------- basic helpers ---------------- */

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}

type Guess = { ext: 'xlsx' | 'xls' | 'csv' | 'pdf' | 'json'; mime: string };

function guessExtMime(buf: Buffer, contentType?: string | null, contentDisp?: string | null): Guess {
  // filename hint
  if (contentDisp) {
    const m = /filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i.exec(contentDisp);
    const filename = decodeURIComponent(m?.[1] || m?.[2] || '').toLowerCase();
    if (filename.endsWith('.xlsx')) return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (filename.endsWith('.xls'))  return { ext: 'xls',  mime: 'application/vnd.ms-excel' };
    if (filename.endsWith('.csv'))  return { ext: 'csv',  mime: 'text/csv' };
    if (filename.endsWith('.pdf'))  return { ext: 'pdf',  mime: 'application/pdf' };
    if (filename.endsWith('.json')) return { ext: 'json', mime: 'application/json' };
  }
  // content-type
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('officedocument.spreadsheetml.sheet')) return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (ct.includes('vnd.ms-excel'))                        return { ext: 'xls',  mime: 'application/vnd.ms-excel' };
    if (ct.includes('text/csv') || ct.includes('application/csv')) return { ext: 'csv', mime: 'text/csv' };
    if (ct.includes('pdf'))                                 return { ext: 'pdf',  mime: 'application/pdf' };
    if (ct.includes('json'))                                return { ext: 'json', mime: 'application/json' };
  }
  // magic bytes
  const b = buf;
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
      b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) {
    return { ext: 'xls', mime: 'application/vnd.ms-excel' };
  }
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  return { ext: 'json', mime: 'application/json' };
}

/* -------- JSON table discovery + flattening (safe) -------- */

type Table = { name: string; rows: any[]; size: number };

const MAX_CELL = 32000; // Excel limit guard
function safeCell(v: any): any {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > MAX_CELL ? v.slice(0, MAX_CELL) + '…(truncated)' : v;
  return v;
}

// summarize super-large branches instead of dumping them
const PRUNE_PATTERNS: RegExp[] = [
  /account_transactions/i,
  /previous_values/i,
  /account_type_col_span_list/i,
  /columns/i,
  /history/i,
  /audit/i,
];
function shouldSummarize(path: string) {
  return PRUNE_PATTERNS.some((re) => re.test(path));
}

function flattenRow(obj: any, prefix = '', out: Record<string, any> = {}, depth = 0): Record<string, any> {
  if (obj === null || obj === undefined) return out;
  if (depth > 4) { out[prefix || 'value'] = '[nested object]'; return out; }

  if (typeof obj !== 'object') { out[prefix || 'value'] = safeCell(obj); return out; }

  if (Array.isArray(obj)) {
    if (obj.every(v => v === null || typeof v !== 'object')) out[prefix || 'value'] = safeCell(obj.join('; '));
    else out[prefix || 'value'] = `[${obj.length} items]`;
    return out;
  }

  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      if (shouldSummarize(key)) out[key] = Array.isArray(v) ? `[${(v as any[]).length} items]` : '[object]';
      else flattenRow(v, key, out, depth + 1);
    } else {
      out[key] = safeCell(v);
    }
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
    if (p.includes('trial') || p.includes('tb')) s += 10000;
    if (p.includes('.values'))                 s += 5000;
    if (p.includes('rows') || p.includes('records') || p.includes('items')) s += 2000;
    return s;
  };
  all.sort((a, b) => score(b) - score(a));
  return all.map((t, i) => {
    let name = t.name.split('.').slice(-1)[0] || `Sheet${i + 1}`;
    name = name.replace(/\[.*?\]/g, '').replace(/[:\\/?*\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) name = `Sheet${i + 1}`;
    return { ...t, name: name.slice(0, 31) };
  });
}

/* --------- 4-column mapping (name/code/debit/credit) --------- */

const NAME_KEYS       = ['name', 'account_name', 'account', 'accountname', 'account_name_formatted', 'ledger_name'];
const CODE_KEYS       = ['account_code', 'code', 'accountnumber', 'account_number', 'account_id', 'accountcode', 'ledger_code'];
const NET_DEBIT_KEYS  = ['net_debit_total', 'net_debit', 'debit_total', 'debit', 'netdebit'];
const NET_CREDIT_KEYS = ['net_credit_total', 'net_credit', 'credit_total', 'credit', 'netcredit'];

function toNumber(v: any): number | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = String(v).replace(/[, ]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function pickByKeys(flat: Record<string, any>, candidates: string[]): any {
  const cand = candidates.map(c => c.toLowerCase());
  // exact or tail match
  for (const [k, v] of Object.entries(flat)) {
    const lk = k.toLowerCase();
    if (cand.includes(lk)) return v;
    if (cand.some(c => lk.endsWith('.' + c))) return v;
  }
  // loose contains
  for (const [k, v] of Object.entries(flat)) {
    const lk = k.toLowerCase();
    if (cand.some(c => lk.includes(c))) return v;
  }
  return undefined;
}

function mapRowToFourCols(anyRow: any) {
  const flat = flattenRow(anyRow);
  const name = pickByKeys(flat, NAME_KEYS);
  const account_code = pickByKeys(flat, CODE_KEYS);
  const net_debit_total  = toNumber(pickByKeys(flat, NET_DEBIT_KEYS));
  const net_credit_total = toNumber(pickByKeys(flat, NET_CREDIT_KEYS));
  return { name, account_code, net_debit_total, net_credit_total };
}

/* ---------------------- route handler ---------------------- */

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { region, orgId, from, to } = body as { region: string; orgId: string; from: string; to: string; };

    if (!region || !orgId || !from || !to) return json(false, { error: 'Missing inputs (region/orgId/from/to)' }, 400);
    const REGION = String(region).toUpperCase();
    if (!['IN','US','EU','UK'].includes(REGION)) return json(false, { error: `Bad region: ${REGION}` }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json(false, { error: 'Dates must be YYYY-MM-DD' }, 400);

    const USER_EMAIL = 'owner@ultrahuman.com';

    // get sealed refresh token
    const q = await pool.query(
      `select refresh_token_enc from zoho_connections
       where user_email=$1 and region_key=$2 limit 1`,
      [USER_EMAIL, REGION]
    );
    if (!q.rowCount) return json(false, { error: `No Zoho connection found for ${REGION}` }, 400);

    const sealedRaw = q.rows[0].refresh_token_enc as any;
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

    // build URLs (try Excel first, then JSON)
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

    // payload & detection
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get('content-type') || '';
    const cd = resp.headers.get('content-disposition') || '';
    const rawGuess = guessExtMime(buf, ct, cd);
    const head = buf.toString('utf8', 0, Math.min(buf.length, 128));
    const looksJson =
      rawGuess.ext === 'json' ||
      ct.toLowerCase().includes('json') ||
      /^[\uFEFF\s\r\n]*[\{\[]/.test(head);

    // Google Drive auth
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

    /* 1) ALWAYS upload RAW Zoho response */
    const rawName = `TB_${REGION}_${period}_RAW.${rawGuess.ext}`;
    const rawUpload = await drive.files.create({
      requestBody: { name: rawName, parents: [parent] },
      media: { mimeType: rawGuess.mime, body: Readable.from(buf) },
      fields: 'id, name, mimeType, fileExtension, webViewLink',
      supportsAllDrives: true,
    } as any);

    /* 2) Build the final 4-column XLSX */
    let xlsxBuf: Buffer = Buffer.alloc(0); // init to satisfy TS

    if (looksJson) {
      // JSON → pick the biggest table → map to 4 columns
      let jsonBody: any;
      try {
        const rawText = buf.toString('utf8').replace(/^\uFEFF/, '');
        jsonBody = JSON.parse(rawText);
      } catch (e: any) {
        const XLSXmod: any = await import('xlsx');
        const XLSX = XLSXmod?.default ?? XLSXmod;
        const ws = XLSX.utils.aoa_to_sheet([
          ['Zoho JSON parse failed'],
          ['Content-Type', ct],
          ['Error', String(e?.message || e)],
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Info');
        xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      }

      if (!xlsxBuf && jsonBody) {
        if (jsonBody?.code && jsonBody?.message && !jsonBody?.trialbalance && !jsonBody?.data) {
          const XLSXmod: any = await import('xlsx');
          const XLSX = XLSXmod?.default ?? XLSXmod;
          const ws = XLSX.utils.aoa_to_sheet([
            ['Zoho error'],
            ['code', jsonBody.code],
            ['message', jsonBody.message],
          ]);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Zoho Error');
          xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        } else {
          const tables = extractTablesFromZohoDeep(jsonBody);
          const rows = tables.length ? tables[0].rows : [];
          const mapped = rows.map(mapRowToFourCols)
                            .filter(r => (r.name ?? r.account_code) != null);

          const XLSXmod: any = await import('xlsx');
          const XLSX = XLSXmod?.default ?? XLSXmod;
          const header = ['name', 'account_code', 'net_debit_total', 'net_credit_total'] as const;
          const aoa = [header as any].concat(
            mapped.map(r => [r.name ?? '', r.account_code ?? '', r.net_debit_total ?? '', r.net_credit_total ?? ''])
          );
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Trial Balance');
          xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        }
      }
    } else if (rawGuess.ext === 'xlsx' || rawGuess.ext === 'xls' || rawGuess.ext === 'csv') {
      // Read sheet → objects → map to 4 columns
      const XLSXmod: any = await import('xlsx');
      const XLSX = XLSXmod?.default ?? XLSXmod;
      const wbIn = XLSX.read(buf, { type: 'buffer' });
      const first = wbIn.SheetNames[0];
      let objects: any[] = [];
      if (first) {
        const wsIn = wbIn.Sheets[first];
        objects = XLSX.utils.sheet_to_json(wsIn, { defval: '' }) as any[];
      }
      const mapped = (objects || []).map(mapRowToFourCols)
                                    .filter(r => (r.name ?? r.account_code) != null);
      const header = ['name', 'account_code', 'net_debit_total', 'net_credit_total'] as const;
      const aoa = [header as any].concat(
        mapped.map(r => [r.name ?? '', r.account_code ?? '', r.net_debit_total ?? '', r.net_credit_total ?? ''])
      );
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Trial Balance');
      xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    } else {
      // PDF / other → info workbook
      const XLSXmod: any = await import('xlsx');
      const XLSX = XLSXmod?.default ?? XLSXmod;
      const ws = XLSX.utils.aoa_to_sheet([
        ['Zoho returned a non-Excel format (e.g., PDF).'],
        ['We saved the RAW file; 4-column XLSX not applicable.'],
        ['Content-Type', ct],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Info');
      xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    }

    // Final guard: ensure we always have something to upload
    if (!xlsxBuf || xlsxBuf.length === 0) {
      const XLSXmod: any = await import('xlsx');
      const XLSX = XLSXmod?.default ?? XLSXmod;
      const ws = XLSX.utils.aoa_to_sheet([
        ['No XLSX content was produced from the Zoho response.'],
        ['sourceType', looksJson ? 'json' : rawGuess.ext],
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
      sheet: 'Trial Balance',
      columns: ['name', 'account_code', 'net_debit_total', 'net_credit_total'],
      sourceType: looksJson ? 'json' : rawGuess.ext,
    });
  } catch (e: any) {
    console.error('[export] error', e);
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
