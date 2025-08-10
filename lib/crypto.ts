import 'server-only';
import crypto from 'crypto';

// Derive a 32-byte key from ENCRYPTION_KEY
const RAW = process.env.ENCRYPTION_KEY || '';
const KEY = crypto.createHash('sha256').update(RAW).digest(); // 32 bytes
const IV_LEN = 12; // AES-GCM recommended IV size

export function seal(plain: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store iv | tag | ciphertext (base64)
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function unseal(sealed: string): string {
  const buf = Buffer.from(sealed, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const enc = buf.subarray(IV_LEN + 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
