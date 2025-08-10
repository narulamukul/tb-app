import 'server-only';
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.postgresql://postgres.zrurjfpxcgzkesbowgyt:MiYS6OwwTsehWEDM@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require,      // keep your full Supabase URI
  ssl: { rejectUnauthorized: false },              // <- fix self-signed cert
});
