export default async function handler(req, res) {
  try {
    const { google } = await import('googleapis');
    const sa = JSON.parse(String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'));
    const auth = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    const drive = google.drive({ version: 'v3', auth });

    const id = String(req.query.folder || process.env.GOOGLE_DRIVE_PARENT_ID || '');
    if (!id) return res.status(400).json({ ok:false, error:'No folder ID' });

    const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType, driveId, parents', supportsAllDrives: true });
    const list = await drive.files.list({ q: `'${id}' in parents`, pageSize: 1, fields: 'files(id,name)', includeItemsFromAllDrives: true, supportsAllDrives: true });

    res.status(200).json({ ok:true, folder: meta.data, sampleChild: list.data.files?.[0] || null });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
}
