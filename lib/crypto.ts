import crypto from 'crypto';
const key = Buffer.from(process.env.ENCRYPTION_KEY!, 'base64');
export function seal(plain: string){
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
export function open(sealed: string){
  const buf = Buffer.from(sealed, 'base64');
  const iv = buf.subarray(0,12);
  const tag = buf.subarray(12,28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}
