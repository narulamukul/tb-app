import { NextResponse } from "next/server";
import { zohoClientFor } from "@/lib/zoho";

export async function GET(
  req: Request,
  context: { params: { region: string } }
) {
  const region = (context.params.region || "").toUpperCase() as "IN" | "US" | "EU" | "UK";
  const { accounts, id } = zohoClientFor(region);
  const redirect_uri = `${process.env.NEXTAUTH_URL}/api/zoho/${region}/callback`;
  const scope = encodeURIComponent("ZohoBooks.fullaccess.all");

  const url =
    `${accounts}/oauth/v2/auth` +
    `?response_type=code` +
    `&client_id=${id}` +
    `&scope=${scope}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&access_type=offline&prompt=consent`;

  return NextResponse.redirect(url);
}
