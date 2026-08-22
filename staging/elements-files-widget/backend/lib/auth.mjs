import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, invariant } from './errors.mjs';
import { normalizeId } from './config.mjs';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signature(encoded, secret) {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

export function signToken(payload, secret, ttlSeconds) {
  invariant(secret && secret.length >= 32, 500, 'weak_signing_secret', 'Слабый ключ подписи');
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const encoded = encode(body);
  return encoded + '.' + signature(encoded, secret);
}

export function verifyToken(token, secret, expectations = {}) {
  try {
    const [encoded, actual] = String(token || '').split('.');
    invariant(encoded && actual, 401, 'invalid_token', 'Некорректный access token');
    const expected = signature(encoded, secret);
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    invariant(a.length === b.length && timingSafeEqual(a, b), 401, 'invalid_token', 'Подпись access token не совпала');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    invariant(payload.exp >= Math.floor(Date.now() / 1000), 401, 'expired_token', 'Access token истёк');
    if (expectations.aud) invariant(payload.aud === expectations.aud, 403, 'wrong_token_scope', 'Неверная область access token');
    if (expectations.taskId) invariant(normalizeId(payload.taskId) === normalizeId(expectations.taskId), 403, 'wrong_task', 'Access token выпущен для другой задачи');
    if (expectations.recordId) invariant(normalizeId(payload.recordId) === normalizeId(expectations.recordId), 403, 'wrong_record', 'Access token выпущен для другой записи');
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'invalid_token', 'Некорректный access token');
  }
}

export function bearer(headers) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ''));
  return match ? match[1] : '';
}

export function issueTaskToken(taskId, dataSourceId, secret, ttlSeconds = 2592000) {
  return signToken({ aud: 'widget', taskId: normalizeId(taskId), dataSourceId: normalizeId(dataSourceId) }, secret, ttlSeconds);
}
