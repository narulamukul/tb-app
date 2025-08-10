export default async function handler(_req, res) {
  try {
    const { google } = await import('googleapis');
    const sa = JSON.parse(String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'));
    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const parent = String(process.env.GOOGLE_DRIVE_PARENT_ID || '');
    if (!parent) return res.status(400).json({ ok:false, error:'GOOGLE_DRIVE_PARENT_ID missing' });

    const { Readable } = await import('stream');
    const content = Readable.from(Buffer.from('hello from tb-app\n'));
    const r = await drive.files.create({
      requestBody: { name: `tb-test-${Date.now()}.txt`, parents: [parent] },
      media: { mimeType: 'text/plain', body: content },
      fields: 'id, name'
    });
    return res.status(200).json({ ok:true, file: r.data });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
