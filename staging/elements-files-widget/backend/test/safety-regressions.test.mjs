import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApplication } from '../server.mjs';
import { issueTaskToken } from '../lib/auth.mjs';
import { loadConfig } from '../lib/config.mjs';
import { P, RecordRepository } from '../lib/records.mjs';

const taskId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherTaskId = 'cccccccccccccccccccccccccccccccc';
const recordId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const dataSourceId = '33333333333333333333333333333333';
const secret = '0123456789abcdef0123456789abcdef';
const taskFolderId = 'drive-task-folder';

function stagingConfig({ writeEnabled = false } = {}) {
  return loadConfig({
    APP_ENV: 'staging',
    PORT: '8787',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    WIDGET_PUBLIC_URL: 'http://localhost:8787/',
    ALLOWED_ORIGINS: 'http://localhost:8787',
    SANDBOX_WORKSPACE_ID: '11111111111111111111111111111111',
    SANDBOX_PARENT_PAGE_ID: '22222222222222222222222222222222',
    ELEMENTS_DATA_SOURCE_ID: dataSourceId,
    STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder',
    STAGING_DRIVE_MARKER: 'ELEMENTS_WIDGET_STAGING_ONLY',
    GOOGLE_EXPECTED_ACCOUNT_EMAIL: 'sandbox@example.test',
    TOKEN_SIGNING_SECRET: secret,
    WRITE_GATE: writeEnabled ? 'open' : 'closed',
    DRY_RUN: writeEnabled ? 'false' : 'true'
  }, { allowMissingSecrets: true });
}

function taskPage(overrides = {}) {
  return {
    id: taskId,
    archived: false,
    in_trash: false,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      [P.type]: { select: { name: 'Задача' } },
      [P.title]: { title: [{ plain_text: 'Sandbox task' }] }
    },
    ...overrides
  };
}

function knowledgePage(relationIds) {
  return {
    id: recordId,
    archived: false,
    in_trash: false,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      [P.title]: { title: [{ plain_text: 'Shared file' }] },
      [P.type]: { select: { name: 'Знание' } },
      [P.inside]: {
        relation: relationIds.map((id) => ({ id })),
        has_more: false
      },
      [P.section]: { select: { name: 'Drive' } },
      [P.syncStatus]: { select: { name: 'synced' } }
    }
  };
}

function widgetHeaders(extra = {}) {
  return {
    Authorization: 'Bearer ' + issueTaskToken(taskId, dataSourceId, secret, 60),
    ...extra
  };
}

async function withServer(config, dependencies, run) {
  const app = createApplication(config, {
    ...dependencies,
    logger: { error() {}, info() {}, warn() {} }
  });
  const server = createServer(app.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function nativeRequest(base, key = 'native-concurrent-12345678') {
  return fetch(base + '/api/v1/tasks/' + taskId + '/google-native', {
    method: 'POST',
    headers: widgetHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': key
    }),
    body: JSON.stringify({ kind: 'docs', name: 'Concurrent document' })
  });
}

test('a sandbox task in Notion trash is rejected before its records are listed', async () => {
  let listCalls = 0;
  const notion = {
    retrievePage: async () => taskPage({ in_trash: true })
  };
  const records = {
    listForTask: async () => {
      listCalls += 1;
      return [];
    }
  };

  await withServer(stagingConfig(), { notion, drive: {}, records }, async (base) => {
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/files', {
      headers: widgetHeaders()
    });
    const payload = await response.json();

    assert.equal(response.status, 410);
    assert.equal(payload.error.code, 'task_in_trash');
    assert.equal(listCalls, 0);
  });
});

test('a knowledge record with two Inside relations is hidden from list and rejected by get', async () => {
  const ambiguous = knowledgePage([taskId, otherTaskId]);
  const notion = {
    queryDataSource: async () => [ambiguous],
    retrievePage: async () => ambiguous
  };
  const repository = new RecordRepository({ elementsDataSourceId: dataSourceId }, notion);

  assert.deepEqual(await repository.listForTask(taskId), []);
  await assert.rejects(repository.getForTask(taskId, recordId), {
    status: 409,
    code: 'ambiguous_record_placement'
  });
});

test('physical deletion requires a two-step X-Delete-Token and trashes instead of hard-deleting', async () => {
  const record = {
    id: recordId,
    taskId,
    name: 'report.docx',
    provider: 'Google Drive',
    googleFileId: 'drive-file-1',
    googleFolderId: taskFolderId,
    status: 'synced'
  };
  const notion = { retrievePage: async () => taskPage() };
  const patchCalls = [];
  const records = {
    getForTask: async () => record,
    patch: async (actualTaskId, actualRecordId, changes) => {
      patchCalls.push({ actualTaskId, actualRecordId, changes });
      return { ...record, ...changes };
    }
  };
  const trashCalls = [];
  const deleteCalls = [];
  const drive = {
    assertStagingRoot: async () => ({ root: { id: 'drive-staging-folder' }, principal: { emailAddress: 'sandbox@example.test' } }),
    getFile: async () => ({
      id: record.googleFileId,
      name: record.name,
      trashed: false,
      parents: [taskFolderId],
      appProperties: { elementsTaskPageId: taskId }
    }),
    trashFile: async (fileId) => {
      trashCalls.push(fileId);
      return { id: fileId, trashed: true };
    },
    deleteFile: async (fileId) => {
      deleteCalls.push(fileId);
    }
  };

  await withServer(stagingConfig({ writeEnabled: true }), { notion, drive, records }, async (base) => {
    const direct = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/physical-delete', {
      method: 'POST',
      headers: widgetHeaders()
    });
    const directPayload = await direct.json();
    assert.equal(direct.status, 401);
    assert.equal(directPayload.error.code, 'invalid_token');
    assert.deepEqual(trashCalls, []);
    assert.deepEqual(deleteCalls, []);

    const intent = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/physical-delete-intent', {
      method: 'POST',
      headers: widgetHeaders()
    });
    const intentPayload = await intent.json();
    assert.equal(intent.status, 200);
    assert.equal(typeof intentPayload.deleteToken, 'string');
    assert.ok(intentPayload.deleteToken.length > 40);

    const confirmed = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/physical-delete', {
      method: 'POST',
      headers: widgetHeaders({ 'X-Delete-Token': intentPayload.deleteToken })
    });
    const confirmedPayload = await confirmed.json();

    assert.equal(confirmed.status, 200);
    assert.equal(confirmedPayload.item.status, 'deleted');
    assert.deepEqual(trashCalls, [record.googleFileId]);
    assert.deepEqual(deleteCalls, []);
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].actualTaskId, taskId);
    assert.equal(patchCalls[0].actualRecordId, recordId);
    assert.equal(patchCalls[0].changes.status, 'deleted');
    assert.equal(patchCalls[0].changes.taskId, null);
  });
});

test('concurrent duplicate native requests create one Drive side effect', async () => {
  let taskChecks = 0;
  let resolveSecondTaskCheck;
  const secondTaskCheck = new Promise((resolve) => { resolveSecondTaskCheck = resolve; });
  const notion = {
    retrievePage: async () => {
      taskChecks += 1;
      if (taskChecks === 2) resolveSecondTaskCheck();
      return taskPage();
    }
  };
  let createNativeCalls = 0;
  let findFileCalls = 0;
  const drive = {
    assertStagingRoot: async () => ({ root: { id: 'drive-staging-folder' }, principal: { emailAddress: 'sandbox@example.test' } }),
    ensureTaskFolder: async () => ({ id: taskFolderId }),
    findFileByIdempotency: async () => {
      findFileCalls += 1;
      return null;
    },
    createNative: async () => {
      createNativeCalls += 1;
      await secondTaskCheck;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        id: 'drive-native-1',
        name: 'Concurrent document',
        mimeType: 'application/vnd.google-apps.document',
        webViewLink: 'https://drive.google.com/open?id=drive-native-1',
        parents: [taskFolderId],
        appProperties: {
          elementsTaskPageId: taskId,
          elementsIdempotencyKey: 'native-concurrent-12345678'
        }
      };
    }
  };
  let recordCreateCalls = 0;
  const records = {
    findByIdempotency: async () => null,
    create: async (actualTaskId, input) => {
      recordCreateCalls += 1;
      return { id: recordId, taskId: actualTaskId, ...input };
    }
  };

  await withServer(stagingConfig({ writeEnabled: true }), { notion, drive, records }, async (base) => {
    const [first, second] = await Promise.all([
      nativeRequest(base),
      nativeRequest(base)
    ]);
    const [firstPayload, secondPayload] = await Promise.all([first.json(), second.json()]);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(firstPayload.item, secondPayload.item);
    assert.equal(taskChecks, 2);
    assert.equal(findFileCalls, 1);
    assert.equal(createNativeCalls, 1);
    assert.equal(recordCreateCalls, 1);
  });
});

test('ambiguous Notion failure preserves the Drive file and retry recovers it by idempotency', async () => {
  const notion = { retrievePage: async () => taskPage() };
  let createdFile = null;
  let createNativeCalls = 0;
  const recoveryCalls = [];
  const trashCalls = [];
  const deleteCalls = [];
  const drive = {
    assertStagingRoot: async () => ({ root: { id: 'drive-staging-folder' }, principal: { emailAddress: 'sandbox@example.test' } }),
    ensureTaskFolder: async () => ({ id: taskFolderId }),
    findFileByIdempotency: async (query) => {
      recoveryCalls.push(query);
      return createdFile;
    },
    createNative: async () => {
      createNativeCalls += 1;
      createdFile = {
        id: 'drive-native-recoverable',
        name: 'Concurrent document',
        mimeType: 'application/vnd.google-apps.document',
        webViewLink: 'https://drive.google.com/open?id=drive-native-recoverable',
        parents: [taskFolderId],
        appProperties: {
          elementsTaskPageId: taskId,
          elementsIdempotencyKey: 'native-recovery-12345678'
        }
      };
      return createdFile;
    },
    trashFile: async (fileId) => { trashCalls.push(fileId); },
    deleteFile: async (fileId) => { deleteCalls.push(fileId); }
  };
  let notionCreateAttempts = 0;
  const records = {
    findByIdempotency: async () => null,
    create: async (actualTaskId, input) => {
      notionCreateAttempts += 1;
      if (notionCreateAttempts === 1) throw new Error('Notion connection closed after request body was sent');
      return { id: recordId, taskId: actualTaskId, ...input };
    }
  };

  await withServer(stagingConfig({ writeEnabled: true }), { notion, drive, records }, async (base) => {
    const first = await nativeRequest(base, 'native-recovery-12345678');
    const firstPayload = await first.json();

    assert.equal(first.status, 500);
    assert.equal(firstPayload.error.code, 'internal_error');
    assert.equal(createNativeCalls, 1);
    assert.deepEqual(trashCalls, []);
    assert.deepEqual(deleteCalls, []);

    const retry = await nativeRequest(base, 'native-recovery-12345678');
    const retryPayload = await retry.json();

    assert.equal(retry.status, 201);
    assert.equal(retryPayload.item.googleFileId, createdFile.id);
    assert.equal(createNativeCalls, 1);
    assert.equal(notionCreateAttempts, 2);
    assert.equal(recoveryCalls.length, 2);
    assert.deepEqual(recoveryCalls[1], {
      folderId: taskFolderId,
      taskId,
      idempotencyKey: 'native-recovery-12345678'
    });
    assert.deepEqual(trashCalls, []);
    assert.deepEqual(deleteCalls, []);
  });
});

test('resumable Google session URL never leaves the backend', async () => {
  const notion = { retrievePage: async () => taskPage() };
  const sessionUrl = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=server-only-secret';
  const drive = {
    assertStagingRoot: async () => ({ root: { id: 'drive-staging-folder' }, principal: { emailAddress: 'sandbox@example.test' } }),
    ensureTaskFolder: async () => ({ id: taskFolderId }),
    findFileByIdempotency: async () => null,
    initiateResumable: async () => sessionUrl
  };
  const records = { findByIdempotency: async () => null };

  await withServer(stagingConfig({ writeEnabled: true }), { notion, drive, records }, async (base) => {
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/uploads', {
      method: 'POST',
      headers: widgetHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': 'upload-opaque-12345678' }),
      body: JSON.stringify({ name: 'report.docx', mimeType: 'application/octet-stream', size: 12, sha256: 'a'.repeat(64) })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.completed, false);
    assert.equal(JSON.stringify(payload).includes('server-only-secret'), false);
    const claims = JSON.parse(Buffer.from(payload.uploadToken.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(claims.sessionUrl, undefined);
    assert.equal(typeof claims.uploadId, 'string');
  });
});

test('external link replacement accepts only normalized HTTPS URLs', async () => {
  const notion = { retrievePage: async () => taskPage() };
  const record = {
    id: recordId, taskId, name: 'Reference', provider: 'External URL', googleFileId: '', googleFolderId: '',
    section: 'Drive', format: 'Link', url: 'https://example.test/old', status: 'synced'
  };
  const patches = [];
  const records = {
    getForTask: async () => record,
    patch: async (_task, _record, changes) => { patches.push(changes); return { ...record, ...changes }; }
  };
  const drive = {
    assertStagingRoot: async () => ({ root: { id: 'drive-staging-folder' }, principal: { emailAddress: 'sandbox@example.test' } })
  };

  await withServer(stagingConfig({ writeEnabled: true }), { notion, drive, records }, async (base) => {
    const unsafe = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId, {
      method: 'PATCH', headers: widgetHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ url: 'http://example.test/new' })
    });
    assert.equal(unsafe.status, 422);
    assert.equal(patches.length, 0);

    const safe = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId, {
      method: 'PATCH', headers: widgetHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ url: 'https://Example.test:443/new#fragment' })
    });
    const payload = await safe.json();
    assert.equal(safe.status, 200);
    assert.equal(payload.item.url, 'https://example.test/new');
    assert.equal(patches[0].url, 'https://example.test/new');
  });
});

test('crash after verified upload is recovered without uploading bytes twice', async () => {
  const body = Buffer.from('abc');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const notion = { retrievePage: async () => taskPage() };
  let uploadArgs;
  let uploadedFile = null;
  let uploadCalls = 0;
  let markCalls = 0;
  const drive = {
    assertStagingRoot: async () => ({ root: { id: 'drive-staging-folder' }, principal: { emailAddress: 'sandbox@example.test' } }),
    ensureTaskFolder: async () => ({ id: taskFolderId }),
    findFileByIdempotency: async () => uploadedFile,
    initiateResumable: async (args) => { uploadArgs = args; return 'https://upload.example.test/session'; },
    uploadSession: async (_url, stream) => {
      uploadCalls += 1;
      for await (const _chunk of stream) {}
      uploadedFile = {
        id: 'uploaded-file', name: uploadArgs.name, mimeType: uploadArgs.mimeType, size: String(uploadArgs.size),
        webViewLink: 'https://drive.google.com/file/d/uploaded-file/view', parents: [taskFolderId],
        appProperties: {
          elementsTaskPageId: taskId,
          elementsIdempotencyKey: uploadArgs.idempotencyKey,
          elementsPayloadFingerprint: uploadArgs.payloadFingerprint,
          elementsDeclaredSha256: uploadArgs.sha256
        }
      };
      return uploadedFile;
    },
    markFileVerified: async (args) => {
      markCalls += 1;
      uploadedFile.appProperties = {
        ...uploadedFile.appProperties,
        elementsVerified: 'v1', elementsVerifiedSha256: args.sha256, elementsVerifiedSize: String(args.size)
      };
      return uploadedFile;
    }
  };
  let createAttempts = 0;
  const records = {
    findByIdempotency: async () => null,
    create: async (actualTaskId, input) => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('Notion response lost after create');
      return { id: recordId, taskId: actualTaskId, ...input };
    }
  };

  await withServer(stagingConfig({ writeEnabled: true }), { notion, drive, records }, async (base) => {
    const key = 'upload-crash-recovery-12345678';
    const init = await fetch(base + '/api/v1/tasks/' + taskId + '/uploads', {
      method: 'POST', headers: widgetHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': key }),
      body: JSON.stringify({ name: 'a.bin', mimeType: 'application/octet-stream', size: body.length, sha256 })
    });
    const session = await init.json();
    assert.equal(init.status, 200);

    const first = await fetch(base + '/api/v1/tasks/' + taskId + '/uploads', {
      method: 'PUT', headers: widgetHeaders({ 'X-Upload-Token': session.uploadToken, 'Content-Type': 'application/octet-stream' }), body
    });
    assert.equal(first.status, 500);
    assert.equal(uploadCalls, 1);
    assert.equal(markCalls, 1);

    const retry = await fetch(base + '/api/v1/tasks/' + taskId + '/uploads', {
      method: 'PUT', headers: widgetHeaders({ 'X-Upload-Token': session.uploadToken, 'Content-Type': 'application/octet-stream' }), body
    });
    const payload = await retry.json();
    assert.equal(retry.status, 201);
    assert.equal(payload.record.googleFileId, uploadedFile.id);
    assert.equal(uploadCalls, 1);
    assert.equal(markCalls, 1);
    assert.equal(createAttempts, 2);
  });
});

test('unverified corrupt recovery is never promoted when quarantine fails', async () => {
  const expected = Buffer.from('abc');
  const corrupt = Buffer.from('abd');
  const sha256 = createHash('sha256').update(expected).digest('hex');
  const notion = { retrievePage: async () => taskPage() };
  let uploadArgs;
  let exposeCorrupt = false;
  let createCalls = 0;
  let trashCalls = 0;
  const drive = {
    assertStagingRoot: async () => ({ root: { id: 'drive-staging-folder' }, principal: { emailAddress: 'sandbox@example.test' } }),
    ensureTaskFolder: async () => ({ id: taskFolderId }),
    findFileByIdempotency: async () => exposeCorrupt ? ({
      id: 'corrupt-file', name: uploadArgs.name, mimeType: uploadArgs.mimeType, size: String(uploadArgs.size), parents: [taskFolderId],
      appProperties: {
        elementsTaskPageId: taskId, elementsIdempotencyKey: uploadArgs.idempotencyKey,
        elementsPayloadFingerprint: uploadArgs.payloadFingerprint, elementsDeclaredSha256: uploadArgs.sha256
      }
    }) : null,
    initiateResumable: async (args) => { uploadArgs = args; return 'https://upload.example.test/corrupt-session'; },
    downloadFile: async () => new Response(corrupt, { status: 200 }),
    trashFile: async () => { trashCalls += 1; throw new Error('Drive trash unavailable'); }
  };
  const records = {
    findByIdempotency: async () => null,
    create: async () => { createCalls += 1; throw new Error('must not create'); }
  };

  await withServer(stagingConfig({ writeEnabled: true }), { notion, drive, records }, async (base) => {
    const key = 'upload-corrupt-recovery-1234';
    const init = await fetch(base + '/api/v1/tasks/' + taskId + '/uploads', {
      method: 'POST', headers: widgetHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': key }),
      body: JSON.stringify({ name: 'a.bin', mimeType: 'application/octet-stream', size: expected.length, sha256 })
    });
    const session = await init.json();
    exposeCorrupt = true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await fetch(base + '/api/v1/tasks/' + taskId + '/uploads', {
        method: 'PUT', headers: widgetHeaders({ 'X-Upload-Token': session.uploadToken, 'Content-Type': 'application/octet-stream' }), body: expected
      });
      assert.equal(result.status, 500);
    }
    assert.equal(trashCalls, 2);
    assert.equal(createCalls, 0);
  });
});
