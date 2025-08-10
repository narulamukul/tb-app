export default function handler(_req, res) {
  // Show ONLY presence of envs (no secrets)
  const keys = [
    'NEXTAUTH_URL',
    'DATABASE_URL',
    'ENCRYPTION_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_DRIVE_PARENT_ID',
    'ZOHO_IN_CLIENT_ID','ZOHO_IN_CLIENT_SECRET',
    'ZOHO_US_CLIENT_ID','ZOHO_US_CLIENT_SECRET',
    'ZOHO_EU_CLIENT_ID','ZOHO_EU_CLIENT_SECRET',
    'ZOHO_UK_CLIENT_ID','ZOHO_UK_CLIENT_SECRET',
  ];
  const status = Object.fromEntries(keys.map(k => [k, Boolean(process.env[k])]));
  let saEmail = null;
  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    saEmail = sa.client_email || null;
  } catch {}
  res.status(200).json({
    ok: true,
    status,
    serviceAccountEmail: saEmail,          // safe to show
    driveParent: process.env.GOOGLE_DRIVE_PARENT_ID ? 'set' : 'missing',
  });
}
