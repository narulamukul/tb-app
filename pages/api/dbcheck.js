import { pool } from '@/lib/db';

export default async function handler(_req, res) {
  try {
    const r = await pool.query('select now() as now');
    res.status(200).json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
