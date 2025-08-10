export default function handler(_req, res) {
  try {
    const url = new URL(process.env.DATABASE_URL || '');
    res.status(200).json({ ok: true, host: url.hostname, rawSet: !!process.env.DATABASE_URL });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e), rawSet: !!process.env.DATABASE_URL });
  }
}
