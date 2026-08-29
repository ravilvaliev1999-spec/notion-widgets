import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApplication } from '../server.mjs';
import { issueTaskToken } from '../lib/auth.mjs';
import { AUTHORIZED_MAIN, loadConfig } from '../lib/config.mjs';

const taskId = AUTHORIZED_MAIN.canaryTaskPageId;
const dataSourceId = AUTHORIZED_MAIN.elementsDataSourceId;
const secret = '0123456789abcdef0123456789abcdef';

function config() {
  const value = loadConfig({
    APP_ENV: 'staging', PORT: '8787', PUBLIC_BASE_URL: 'http://localhost:8787', WIDGET_PUBLIC_URL: 'http://localhost:8787/',
    ALLOWED_ORIGINS: 'http://localhost:8787', TARGET_PROFILE: 'authorized-main', ELEMENTS_DATA_SOURCE_ID: dataSourceId,
    STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder', TOKEN_SIGNING_SECRET: secret, WRITE_GATE: 'closed', DRY_RUN: 'true'
  }, { allowMissingSecrets: true });
  value.signingSecret = secret;
  return value;
}

async function withServer(run) {
  const notion = {
    retrievePage: async () => ({ id: taskId, parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties: { 'Тип': { select: { name: 'Задача' } }, Name: { title: [{ plain_text: 'Task' }] } } })
  };
  const records = { listForTask: async () => [{ id: 'record-1', name: 'Safe' }] };
  const app = createApplication(config(), { notion, drive: {}, records, logger: { error() {}, info() {}, warn() {} } });
  const server = createServer(app.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try { await run('http://127.0.0.1:' + address.port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('valid task-scoped token can read only its sandbox task', async () => {
  await withServer(async (base) => {
    const token = issueTaskToken(taskId, dataSourceId, secret, 60);
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/files', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].name, 'Safe');
  });
});

test('mutation fails before any external write while gate is closed', async () => {
  await withServer(async (base) => {
    const token = issueTaskToken(taskId, dataSourceId, secret, 60);
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/google-native', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': 'native-12345678' },
      body: JSON.stringify({ kind: 'docs', name: 'Blocked' })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'write_gate_closed');
  });
});

test('untrusted browser origin is rejected', async () => {
  await withServer(async (base) => {
    const token = issueTaskToken(taskId, dataSourceId, secret, 60);
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/files', { headers: { Authorization: 'Bearer ' + token, Origin: 'https://evil.example' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'origin_blocked');
  });
});
