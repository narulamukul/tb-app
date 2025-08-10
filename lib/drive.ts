import { google } from 'googleapis';
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!),
  scopes: ['https://www.googleapis.com/auth/drive']
});
export async function uploadToDrive(name: string, mimeType: string, data: Buffer, parentId?: string){
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: { name, parents: [parentId || process.env.GOOGLE_DRIVE_PARENT_ID!] },
    media: { mimeType, body: Buffer.from(data) as any },
    fields: 'id, name'
  });
  return res.data;
}
