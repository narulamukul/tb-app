import 'server-only';
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,   // <-- use the env var
  ssl: { rejectUnauthorized: false },           // TLS for Supabase/pooler
});
