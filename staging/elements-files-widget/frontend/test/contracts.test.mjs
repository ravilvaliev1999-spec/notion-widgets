import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const env = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
const server = await readFile(new URL('../../backend/server.mjs', import.meta.url), 'utf8');

test('sample deployment keeps widget and API on one explicit origin', () => {
  const values = Object.fromEntries(env.split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  assert.equal(new URL(values.PUBLIC_BASE_URL).origin, new URL(values.WIDGET_PUBLIC_URL).origin);
  assert.match(values.ALLOWED_ORIGINS, new RegExp(new URL(values.PUBLIC_BASE_URL).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(app, /url\.origin !== window\.location\.origin/);
  assert.match(server, /connect-src 'self'/);
});

test('logical mutations retain idempotency keys in sessionStorage until success or explicit cancel', () => {
  assert.match(app, /function pendingIdempotencyKey/);
  assert.match(app, /sessionStorage\.setItem/);
  assert.match(app, /job\.idempotencyKey/);
  assert.match(app, /function retryUpload/);
  assert.match(app, /clearPendingOperation\(job\.operationSlot/);
});

test('task credentials stay in the fragment and referrer mismatch fails before API/cache', () => {
  assert.match(app, /window\.location\.hash/);
  assert.doesNotMatch(html, /(?:task|access)=/i);
  assert.match(app, /if \(!context\.validBinding\)/);
  assert.ok(app.indexOf('if (!context.validBinding)') < app.indexOf('var cached = readCache()'));
});

test('two-step Drive trash confirmation remains wired in UI and API', () => {
  assert.match(app, /physical-delete-intent/);
  assert.match(app, /X-Delete-Token/);
  assert.match(app, /Переместить файл в корзину Drive/);
});
