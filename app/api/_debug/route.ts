import { NextResponse } from "next/server";

export async function GET() {
  // Do NOT print secrets. Just show if they exist.
  const required = [
    "NEXTAUTH_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_DRIVE_PARENT_ID",
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "ZOHO_IN_CLIENT_ID", "ZOHO_IN_CLIENT_SECRET",
    "ZOHO_US_CLIENT_ID", "ZOHO_US_CLIENT_SECRET",
    "ZOHO_EU_CLIENT_ID", "ZOHO_EU_CLIENT_SECRET",
    "ZOHO_UK_CLIENT_ID", "ZOHO_UK_CLIENT_SECRET",
  ];
  const status: Record<string, boolean> = {};
  for (const k of required) status[k] = Boolean(process.env[k]);
  return NextResponse.json({ ok: true, status });
}
