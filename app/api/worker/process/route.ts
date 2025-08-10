import { NextResponse } from 'next/server';
// Minimal stub — you can expand to a real BullMQ worker later.
export async function GET(){
  // pull pending jobs from DB or Redis and call /api/export for each
  return NextResponse.json({ ok: true });
}
