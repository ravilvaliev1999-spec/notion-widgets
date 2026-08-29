import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { issueTaskToken } from '../../backend/lib/auth.mjs';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const env = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
const server = await readFile(new URL('../../backend/server.mjs', import.meta.url), 'utf8');

function notionReferrerReader() {
  const start = app.indexOf('function readNotionReferrer');
  const end = app.indexOf('function initDom', start);
  assert.ok(start >= 0 && end > start);
  return Function(app.slice(start, end) + '; return readNotionReferrer;')();
}

function tokenTaskReader() {
  const start = app.indexOf('function readTokenTaskId');
  const end = app.indexOf('function initDom', start);
  assert.ok(start >= 0 && end > start);
  return Function(app.slice(start, end) + '; return readTokenTaskId;')();
}

function runInvalidWidget(referrer, taskId = '3ae2d62739a180adb49ce028699b75d9', access = 'x'.repeat(32)) {
  const localReads = [];
  const sessionReads = [];
  let fetches = 0;
  const node = () => ({
    dataset: {}, classList: { add() {}, remove() {} }, content: { cloneNode: () => ({}) },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, replaceChildren() {}, appendChild() {}, append() {}
  });
  const documentElement = node();
  documentElement.scrollHeight = 100;
  const document = {
    referrer, readyState: 'complete', visibilityState: 'visible', documentElement,
    getElementById: () => node(), querySelector: () => node(), querySelectorAll: () => [],
    addEventListener() {}, createElement: () => node(), createElementNS: () => node()
  };
  const window = {
    location: { hash: `#task=${taskId}&access=${encodeURIComponent(access)}`, origin: 'https://widget.example.test' },
    ELEMENTS_WIDGET_CONFIG: { apiBase: 'https://widget.example.test' },
    addEventListener() {}, setTimeout() {}, setInterval() {}, crypto: {}, parent: null
  };
  window.parent = window;
  runInNewContext(app, {
    window, document, navigator: { onLine: true }, URL, URLSearchParams, atob,
    localStorage: { getItem(key) { localReads.push(key); return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem(key) { sessionReads.push(key); return null; }, setItem() {}, removeItem() {} },
    fetch() { fetches += 1; return Promise.reject(new Error('unexpected fetch')); },
    console, Map, Set, Promise, Array, Object, String, Number, RegExp, Date, Math, JSON, Uint8Array
  });
  return { localReads, sessionReads, fetches };
}

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
  assert.match(app, /validBinding: referrer\.valid && referrer\.taskId === taskId && tokenTaskId === taskId/);
  assert.ok(app.indexOf('if (!context.validBinding)') < app.indexOf('var cached = readCache()'));
});

test('host binding rejects missing, malformed and non-Notion referrers', () => {
  const read = notionReferrerReader();
  for (const referrer of ['', 'not a url', 'https://example.com/' + 'a'.repeat(32), 'https://www.notion.so/no-page-id']) {
    assert.deepEqual(read(referrer), { valid: false, taskId: '' });
  }
});

test('host binding accepts only a parseable Notion page ID and preserves exact task identity', () => {
  const read = notionReferrerReader();
  const task = '3ae2d62739a180adb49ce028699b75d9';
  assert.deepEqual(read('https://www.notion.so/Task-' + task), { valid: true, taskId: task });
  assert.deepEqual(read('https://team.notion.site/Task-3ae2d627-39a1-80ad-b49c-e028699b75d9'), { valid: true, taskId: task });
  assert.deepEqual(read('https://www.notion.com/view?page_id=' + task), { valid: true, taskId: task });
  assert.notEqual(read('https://www.notion.so/' + 'b'.repeat(32)).taskId, task);
});

test('host binding also requires the task claim from the widget token', () => {
  const read = tokenTaskReader();
  const task = '3ae2d62739a180adb49ce028699b75d9';
  const token = issueTaskToken(task, '3822d62739a18018a2dc000b95bf5722', '0123456789abcdef0123456789abcdef', 60);
  assert.equal(read(token), task);
  assert.equal(read('not-a-token'), '');
});

test('invalid host binding performs no fetch or task-scoped storage access at runtime', () => {
  const task = '3ae2d62739a180adb49ce028699b75d9';
  for (const referrer of ['', 'not a url', 'https://example.test/' + task, 'https://www.notion.so/' + 'b'.repeat(32)]) {
    const result = runInvalidWidget(referrer, task);
    assert.equal(result.fetches, 0, referrer);
    assert.deepEqual(result.sessionReads, [], referrer);
    assert.deepEqual(result.localReads, [], referrer);
  }
  const otherTask = 'b'.repeat(32);
  const mismatchedToken = issueTaskToken(otherTask, '3822d62739a18018a2dc000b95bf5722', '0123456789abcdef0123456789abcdef', 60);
  const mismatch = runInvalidWidget('https://www.notion.so/' + task, task, mismatchedToken);
  assert.equal(mismatch.fetches, 0);
  assert.deepEqual(mismatch.sessionReads, []);
  assert.deepEqual(mismatch.localReads, []);
});

test('pre-acceptance UI has no destructive Drive action and refresh is task-scoped', () => {
  assert.doesNotMatch(app, /physical-delete|X-Delete-Token|Переместить файл в корзину Drive/);
  assert.doesNotMatch(server, /trashFile|deleteFile|X-Delete-Token/);
  assert.match(app, /\/api\/v1\/tasks\/" \+ context\.taskId \+ "\/refresh/);
  assert.match(app, /Тип, задача, связи и файл сохранятся/);
  assert.match(server, /status: 'unlinked', archive: true/);
});
