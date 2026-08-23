import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AUTHORIZED_MAIN, loadConfig } from '../lib/config.mjs';
import { issueTaskToken } from '../lib/auth.mjs';
import { P } from '../lib/records.mjs';
import { createApplication } from '../server.mjs';

const taskId = AUTHORIZED_MAIN.canaryTaskPageId;
const recordId = '11111111111111111111111111111111';
const secret = '0123456789abcdef0123456789abcdef';

function config() {
  return loadConfig({
    APP_ENV: 'staging', TARGET_PROFILE: 'authorized-main', PORT: '8787',
    PUBLIC_BASE_URL: 'http://localhost:8787', WIDGET_PUBLIC_URL: 'http://localhost:8787/',
    ALLOWED_ORIGINS: 'http://localhost:8787',
    STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder', STAGING_DRIVE_MARKER: 'marker',
    GOOGLE_EXPECTED_ACCOUNT_EMAIL: 'staging@example.test', TOKEN_SIGNING_SECRET: secret,
    WRITE_GATE: 'open', DRY_RUN: 'false', TASK_WRITE_SCOPE: 'canary', EMBED_ROLLOUT_PHASE: 'disabled'
  }, { allowMissingSecrets: true });
}

function taskPage(id = taskId) {
  return {
    id, archived: false, in_trash: false,
    parent: { type: 'data_source_id', data_source_id: AUTHORIZED_MAIN.elementsDataSourceId },
    properties: {
      [P.type]: { select: { name: 'Задача' } },
      [P.title]: { title: [{ plain_text: 'Task' }] }
    }
  };
}

function record(overrides = {}) {
  return {
    id: recordId, taskId, taskIds: [taskId], insideHasMore: false,
    provider: 'Google Drive', googleFileId: 'drive-file', googleFolderId: 'task-folder',
    name: 'renamed.docx', downloadName: 'original name.docx', url: 'https://drive.google.com/file/d/x',
    mimeType: 'application/octet-stream', size: 3, md5: 'a'.repeat(32), sha256: 'b'.repeat(64),
    status: 'synced', syncError: '', integrity: 'ok', section: 'Docs', format: 'Word', position: 1,
    ...overrides
  };
}

function headers(id = taskId) {
  return { Authorization: 'Bearer ' + issueTaskToken(id, AUTHORIZED_MAIN.elementsDataSourceId, secret, 60) };
}

async function withServer(dependencies, run) {
  const app = createApplication(config(), {
    ...dependencies,
    targetPreflight: async () => true,
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = createServer(app.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await run(base); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('manual refresh reconciles only the authenticated task before returning its list', async () => {
  const current = record({ name: 'old.docx', status: 'error', syncError: 'old_error', integrity: 'sync_error' });
  const patches = [];
  let queryArgs;
  const records = {
    listGoogleDriveForTask: async (...args) => { queryArgs = args; return [current]; },
    patch: async (_task, _record, changes) => { patches.push(changes); return { ...current, ...changes }; },
    listForTask: async () => [{ ...current, ...patches.at(-1) }]
  };
  const notion = { retrievePage: async (id) => taskPage(id) };
  const drive = {
    assertStagingRoot: async () => ({}),
    getFile: async () => ({
      id: current.googleFileId, name: 'fresh.docx', webViewLink: current.url, mimeType: current.mimeType,
      size: '3', md5Checksum: current.md5, parents: [current.googleFolderId], trashed: false,
      appProperties: { elementsTaskPageId: taskId }
    })
  };
  await withServer({ notion, drive, records }, async (base) => {
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/refresh', { method: 'POST', headers: headers() });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(queryArgs, [taskId, false]);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].name, 'fresh.docx');
    assert.equal(patches[0].syncError, '');
    assert.equal(payload.items[0].name, 'fresh.docx');
    assert.equal(payload.sync.scanned, 1);
  });
});

test('download Content-Disposition uses immutable Download name after Drive rename', async () => {
  const current = record();
  const bytes = Buffer.from('abc');
  const notion = { retrievePage: async (id) => taskPage(id) };
  const records = { getForTask: async () => current };
  const drive = {
    getFile: async () => ({
      id: current.googleFileId, name: current.name, parents: [current.googleFolderId], trashed: false,
      appProperties: { elementsTaskPageId: taskId }
    }),
    downloadFile: async () => new Response(bytes, { headers: { 'content-type': current.mimeType, 'content-length': String(bytes.length) } })
  };
  await withServer({ notion, drive, records }, async (base) => {
    const linkResponse = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/download-link', {
      method: 'POST', headers: headers()
    });
    const link = await linkResponse.json();
    assert.equal(linkResponse.status, 200);
    const signed = new URL(link.url);
    const response = await fetch(base + signed.pathname + signed.search);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /original%20name\.docx/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  });
});

test('a valid token cannot widen pre-acceptance writes beyond canary', async () => {
  const otherTaskId = '99999999999999999999999999999999';
  let preflightCalls = 0;
  const notion = { retrievePage: async (id) => taskPage(id) };
  const drive = { assertStagingRoot: async () => { preflightCalls += 1; return {}; } };
  const records = {};
  await withServer({ notion, drive, records }, async (base) => {
    const response = await fetch(base + '/api/v1/tasks/' + otherTaskId + '/google-native', {
      method: 'POST', headers: { ...headers(otherTaskId), 'Content-Type': 'application/json', 'Idempotency-Key': 'blocked-12345678' },
      body: JSON.stringify({ kind: 'docs', name: 'Blocked' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'task_write_not_allowlisted');
    assert.equal(preflightCalls, 0);
  });
});
