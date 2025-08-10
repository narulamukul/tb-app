export const runtime = 'nodejs';
import { NextResponse } from 'next/server';
import { zohoClientFor } from '@/lib/zoho';

export async function GET(_req: Request, { params }: any) {
  const region = String(params?.region || '').toUpperCase();
  if (!['IN','US','EU','UK'].includes(region)) {
    return NextResponse.json({ error: 'Bad region' }, { status: 400 });
  }

  const { accounts, id } = zohoClientFor(region as any);
  const redirect_uri = `${process.env.NEXTAUTH_URL}/api/zoho/${region}/callback`;
  const scope = encodeURIComponent('ZohoBooks.fullaccess.all');

  const url =
    `${accounts}/oauth/v2/auth?response_type=code` +
    `&client_id=${id}&scope=${scope}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&access_type=offline&prompt=consent`;

  return NextResponse.redirect(url);
}
