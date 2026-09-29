import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';

const path = new URL('./.ebay-token.enc', import.meta.url);
const key = () => {
  if (!process.env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required for token storage');
  return createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY).digest();
};

export async function saveToken(token) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key(),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(token),'utf8'),cipher.final()]);
  const temp=new URL('./.ebay-token.enc.tmp',import.meta.url); await writeFile(temp, JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}), {mode:0o600}); await rename(temp,path);
}

export async function loadToken() {
  try { const saved=JSON.parse(await readFile(path,'utf8')); const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(saved.iv,'base64')); decipher.setAuthTag(Buffer.from(saved.tag,'base64')); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data,'base64')),decipher.final()]).toString('utf8')); }
  catch (err) { if (err.code==='ENOENT') return null; throw err; }
}
