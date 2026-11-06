import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string) {
  const parts = stored?.split('$');
  const valid = parts?.[0] === 'scrypt' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2]);
  const salt = valid ? parts![1] : '0'.repeat(32);
  const expected = valid ? Buffer.from(parts![2], 'hex') : Buffer.alloc(64);
  const actual = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(expected, actual) && !!valid;
}
