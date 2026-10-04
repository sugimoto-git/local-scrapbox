import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

// パスワードは scrypt でハッシュ化して保存する（平文は保存しない）。形式: scrypt$<salt hex>$<key hex>
export function hashPassword(password) {
  const salt = randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + scryptSync(password, salt, 64).toString('hex');
}
export function verifyPassword(password, stored) {
  const [kind, saltHex, keyHex] = String(stored).split('$');
  if (kind !== 'scrypt' || !/^[0-9a-f]{32}$/.test(saltHex || '') || !/^[0-9a-f]{64,}$/.test(keyHex || '') || keyHex.length % 2) return false;
  const expected = Buffer.from(keyHex, 'hex'), actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ログイン状態は「有効期限.署名」の署名付きCookieで持つ。サーバー側に状態は持たない。
const sign = (secret, expires) => createHmac('sha256', secret).update(String(expires)).digest('base64url');
export function createSession(secret, ttlMs, now = Date.now()) {
  const expires = now + ttlMs;
  return expires + '.' + sign(secret, expires);
}
export function checkSession(secret, token, now = Date.now()) {
  const [expires, signature] = String(token || '').split('.');
  if (!/^\d+$/.test(expires || '') || !signature || Number(expires) < now) return false;
  const expected = Buffer.from(sign(secret, expires)), actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
export const newSecret = () => randomBytes(32).toString('hex');

// ログインの試行回数を制限する（IPごとに、時間内の失敗が上限に達したら拒否）
export function createLimiter({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const recent = (key, now) => (failures.get(key) || []).filter(t => now - t < windowMs);
  return {
    blocked(key, now = Date.now()) { return recent(key, now).length >= max; },
    fail(key, now = Date.now()) { failures.set(key, [...recent(key, now), now]); if (failures.size > 5000) failures.clear(); },
    clear(key) { failures.delete(key); }
  };
}
