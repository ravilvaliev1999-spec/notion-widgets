import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_MAIN } from '../lib/config.mjs';
import { metadataSyncTargetId, reconcileTaskFiles } from '../lib/sync.mjs';

const taskId = AUTHORIZED_MAIN.canaryTaskPageId;
const config = { taskWriteScope: 'canary', authorizedCanaryTaskPageId: taskId };

function record(overrides = {}) {
  return {
    id: '11111111111111111111111111111111',
    taskId,
    taskIds: [taskId],
    insideHasMore: false,
    provider: 'Google Drive',
    googleFileId: 'drive-file-1',
    googleFolderId: 'task-folder-1',
    name: 'renamed-in-notion.docx',
    downloadName: 'original-upload.docx',
    url: 'https://drive.google.com/old',
    mimeType: 'application/octet-stream',
    size: 12,
    md5: 'a'.repeat(32),
    sha256: 'b'.repeat(64),
    idempotencyKey: 'idem-12345678',
    section: 'Docs',
    format: 'Word',
    position: 7,
    status: 'error',
    syncError: 'drive_network_error',
    integrity: 'sync_error',
    ...overrides
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test('background metadata refresh remains a one-task scope during template testing', () => {
  const templateTestTask = 'a1'.repeat(16);
  assert.equal(metadataSyncTargetId({ taskWriteScope: 'canary', authorizedCanaryTaskPageId: taskId }), taskId);
  assert.equal(metadataSyncTargetId({
    taskWriteScope: 'test-task', authorizedCanaryTaskPageId: taskId,
    authorizedTemplateTestTaskPageId: templateTestTask
  }), templateTestTask);
  assert.equal(metadataSyncTargetId({ taskWriteScope: 'elements', authorizedCanaryTaskPageId: taskId }), taskId);
});

test('task-scoped refresh patches complete mutable Drive metadata and clears recovered errors', async () => {
  const valid = record({ sha256: '' });
  const foreign = record({ id: '2'.repeat(32), taskId: '3'.repeat(32), taskIds: ['3'.repeat(32)], googleFileId: 'foreign-file' });
  const queryCalls = [];
  const patchCalls = [];
  const driveCalls = [];
  const repository = {
    listGoogleDriveForTask: async (...args) => { queryCalls.push(args); return [valid, foreign]; },
    patch: async (...args) => { patchCalls.push(args); return { ...valid, ...args[2] }; }
  };
  const drive = {
    getFile: async (id) => {
      driveCalls.push(id);
      return {
        id,
        name: 'renamed-in-drive.docx',
        webViewLink: 'https://drive.google.com/current',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: '24',
        md5Checksum: 'c'.repeat(32),
        trashed: false,
        parents: [valid.googleFolderId],
        appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: valid.idempotencyKey }
      };
    }
  };

  const result = await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  assert.deepEqual(queryCalls, [[taskId, false]]);
  assert.deepEqual(driveCalls, [valid.googleFileId]);
  assert.equal(patchCalls.length, 1);
  const changes = patchCalls[0][2];
  assert.equal(changes.name, 'renamed-in-drive.docx');
  assert.equal(changes.url, 'https://drive.google.com/current');
  assert.equal(changes.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(changes.size, 24);
  assert.equal(changes.md5, 'c'.repeat(32));
  assert.equal(changes.downloadName, 'original-upload.docx');
  assert.equal(changes.status, 'synced');
  assert.equal(changes.syncError, '');
  assert.equal(changes.integrity, 'ok');
  for (const immutable of ['sha256', 'idempotencyKey', 'section', 'format', 'position', 'provider', 'googleFileId', 'googleFolderId', 'taskId', 'type']) {
    assert.equal(immutable in changes, false, immutable);
  }
  assert.deepEqual(result, { taskId, scanned: 1, changed: 1, recovered: 1, errors: 1 });
});

test('Google-native omissions preserve good size and MD5 metadata', async () => {
  const current = record({ mimeType: 'application/vnd.google-apps.document', size: 77, md5: 'd'.repeat(32), status: 'synced', syncError: '', integrity: 'ok' });
  let changes;
  const repository = {
    listGoogleDriveForTask: async () => [current],
    patch: async (_task, _record, input) => { changes = input; return { ...current, ...input }; }
  };
  const drive = { getFile: async () => ({
    id: current.googleFileId,
    name: current.name,
    webViewLink: current.url,
    mimeType: current.mimeType,
    parents: [current.googleFolderId],
    appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
  }) };
  await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  assert.equal(changes.size, 77);
  assert.equal(changes.md5, 'd'.repeat(32));
});

test('unsafe Drive binding and Drive exceptions persist diagnostic metadata', async () => {
  for (const scenario of [
    {
      drive: { getFile: async () => ({
        id: 'different-file', parents: ['different-folder'], appProperties: { elementsTaskPageId: '4'.repeat(32) }
      }) }, expected: 'unsafe_drive_parent'
    },
    {
      drive: { getFile: async () => { const error = new Error('offline'); error.code = 'drive_network_error'; throw error; } },
      expected: 'drive_network_error'
    }
  ]) {
    const current = record({ status: 'synced', syncError: '', integrity: 'ok' });
    const patches = [];
    const repository = {
      listGoogleDriveForTask: async () => [current],
      patch: async (_task, _record, input) => { patches.push(input); return { ...current, ...input }; }
    };
    const result = await reconcileTaskFiles(config, taskId, scenario.drive, repository, quietLogger);
    const diagnostic = patches.at(-1);
    assert.equal(diagnostic.status, 'error');
    assert.equal(diagnostic.syncError, scenario.expected);
    assert.equal(diagnostic.integrity, 'sync_error');
    assert.equal('syncedAt' in diagnostic, false);
    assert.equal(result.errors, 1);
  }
});

test('changed binary content is quarantined without overwriting the good baseline or successful-sync time', async () => {
  for (const fileChanges of [
    { size: '13', md5Checksum: 'a'.repeat(32) },
    { size: '12', md5Checksum: 'c'.repeat(32) }
  ]) {
    const current = record({ status: 'synced', syncError: '', integrity: 'ok' });
    const patches = [];
    const repository = {
      listGoogleDriveForTask: async () => [current],
      patch: async (_task, _record, changes) => { patches.push(changes); return { ...current, ...changes }; }
    };
    const drive = { getFile: async () => ({
      id: current.googleFileId, name: 'changed.docx', webViewLink: 'https://drive.google.com/changed',
      mimeType: current.mimeType, ...fileChanges, parents: [current.googleFolderId], trashed: false,
      appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
    }) };
    const result = await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], {
      status: 'needs_review', syncError: 'drive_content_changed', integrity: 'sync_error'
    });
    for (const protectedField of ['sha256', 'size', 'md5', 'name', 'url', 'mimeType', 'syncedAt']) {
      assert.equal(protectedField in patches[0], false, protectedField);
    }
    assert.deepEqual(result, { taskId, scanned: 1, changed: 0, recovered: 0, errors: 1 });
  }
});

test('fresh Drive binary MIME cannot be bypassed by a stale Google-native SYS MIME', async () => {
  const current = record({
    mimeType: 'application/vnd.google-apps.document', status: 'synced', syncError: '', integrity: 'ok'
  });
  let diagnostic;
  const repository = {
    listGoogleDriveForTask: async () => [current],
    patch: async (_task, _record, changes) => { diagnostic = changes; return { ...current, ...changes }; }
  };
  const drive = { getFile: async () => ({
    id: current.googleFileId, mimeType: 'application/octet-stream', size: '13', md5Checksum: 'c'.repeat(32),
    parents: [current.googleFolderId], trashed: false,
    appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
  }) };
  await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  assert.deepEqual(diagnostic, {
    status: 'needs_review', syncError: 'drive_content_changed', integrity: 'sync_error'
  });
});
