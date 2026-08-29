import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_MAIN } from '../lib/config.mjs';
import { metadataSyncTargetId, reconcileTaskFiles } from '../lib/sync.mjs';

const taskId = AUTHORIZED_MAIN.canaryTaskPageId;
const config = {
  taskWriteScope: 'canary', authorizedCanaryTaskPageId: taskId,
  stagingDriveFolderId: 'drive-staging-folder'
};

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

function safeFolder(current, overrides = {}) {
  return {
    id: current.googleFolderId,
    mimeType: 'application/vnd.google-apps.folder',
    trashed: false,
    parents: [config.stagingDriveFolderId],
    appProperties: { elementsTaskPageId: taskId },
    ...overrides
  };
}

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
      if (id === valid.googleFolderId) return safeFolder(valid);
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
  assert.deepEqual(driveCalls, [valid.googleFileId, valid.googleFolderId]);
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

test('true Google-native rows with no SHA preserve good size and MD5 metadata', async () => {
  const current = record({
    mimeType: 'application/vnd.google-apps.document', size: 77, md5: 'd'.repeat(32), sha256: '',
    status: 'synced', syncError: '', integrity: 'ok'
  });
  let changes;
  const repository = {
    listGoogleDriveForTask: async () => [current],
    patch: async (_task, _record, input) => { changes = input; return { ...current, ...input }; }
  };
  const drive = { getFile: async (id) => id === current.googleFolderId ? safeFolder(current) : ({
    id: current.googleFileId,
    name: current.name,
    webViewLink: current.url,
    mimeType: current.mimeType,
    trashed: false,
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
        id: 'different-file', trashed: false, parents: ['different-folder'], appProperties: { elementsTaskPageId: '4'.repeat(32) }
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
    const drive = { getFile: async (id) => id === current.googleFolderId ? safeFolder(current) : ({
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
  const drive = { getFile: async (id) => id === current.googleFolderId ? safeFolder(current) : ({
    id: current.googleFileId, mimeType: 'application/octet-stream', size: '13', md5Checksum: 'c'.repeat(32),
    parents: [current.googleFolderId], trashed: false,
    appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
  }) };
  await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  assert.deepEqual(diagnostic, {
    status: 'needs_review', syncError: 'drive_content_changed', integrity: 'sync_error'
  });
});

test('missing MD5 or fresh MIME makes a SHA-bearing binary baseline unverifiable', async () => {
  for (const scenario of [
    { name: 'stored MD5 missing', record: { md5: '' } },
    { name: 'Drive MD5 missing', file: { md5Checksum: undefined } },
    {
      name: 'fresh MIME missing despite stale native SYS MIME',
      record: { mimeType: 'application/vnd.google-apps.document' },
      file: { mimeType: undefined }
    },
    {
      name: 'fresh Google-native MIME cannot erase a stored binary SHA baseline',
      file: { mimeType: 'application/vnd.google-apps.document', size: undefined, md5Checksum: undefined }
    },
    { name: 'Drive size missing', file: { size: undefined } }
  ]) {
    const current = record({ status: 'synced', syncError: '', integrity: 'ok', ...scenario.record });
    const patches = [];
    const repository = {
      listGoogleDriveForTask: async () => [current],
      patch: async (_task, _record, changes) => { patches.push(changes); return { ...current, ...changes }; }
    };
    const file = {
      id: current.googleFileId, mimeType: 'application/octet-stream', size: String(current.size),
      md5Checksum: 'a'.repeat(32), parents: [current.googleFolderId], trashed: false,
      appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey },
      ...scenario.file
    };
    const drive = { getFile: async (id) => id === current.googleFolderId ? safeFolder(current) : file };
    const result = await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
    assert.deepEqual(patches, [{
      status: 'needs_review', syncError: 'drive_content_unverifiable', integrity: 'sync_error'
    }], scenario.name);
    assert.equal('syncedAt' in patches[0], false, scenario.name);
    assert.equal(result.errors, 1, scenario.name);
  }
});

test('binary integrity quarantine is sticky until an explicit audited rebaseline', async () => {
  let current = record({ status: 'synced', syncError: '', integrity: 'ok' });
  let changed = true;
  let folderMoved = false;
  const patches = [];
  const repository = {
    listGoogleDriveForTask: async () => [current],
    patch: async (_task, _record, changes) => {
      patches.push(changes);
      current = { ...current, ...changes };
      return current;
    }
  };
  const drive = { getFile: async (id) => id === current.googleFolderId
    ? safeFolder(current, folderMoved ? { parents: ['other-root'] } : {})
    : ({
    id: current.googleFileId, mimeType: current.mimeType, size: String(current.size),
    md5Checksum: changed ? 'c'.repeat(32) : current.md5,
    parents: [current.googleFolderId], trashed: false,
    appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
  }) };

  await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  changed = false;
  await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  folderMoved = true;
  await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  folderMoved = false;
  await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
  assert.deepEqual(patches, [{
    status: 'needs_review', syncError: 'drive_content_changed', integrity: 'sync_error'
  }]);
  assert.equal(current.status, 'needs_review');
  assert.equal(current.syncError, 'drive_content_changed');
  assert.equal('syncedAt' in patches[0], false);
});

test('reconciliation rejects moved or unknown-trash-state task folders without restoring sync metadata', async () => {
  for (const scenario of [
    { folder: { parents: ['other-root'] }, expected: 'unsafe_drive_folder_parent' },
    { folder: { trashed: undefined }, expected: 'drive_folder_trashed' }
  ]) {
    const current = record({ status: 'synced', syncError: '', integrity: 'ok' });
    const patches = [];
    const repository = {
      listGoogleDriveForTask: async () => [current],
      patch: async (_task, _record, changes) => { patches.push(changes); return { ...current, ...changes }; }
    };
    const drive = { getFile: async (id) => id === current.googleFolderId
      ? safeFolder(current, scenario.folder)
      : ({
          id: current.googleFileId, mimeType: current.mimeType, size: String(current.size), md5Checksum: current.md5,
          parents: [current.googleFolderId], trashed: false,
          appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
        }) };
    await reconcileTaskFiles(config, taskId, drive, repository, quietLogger);
    assert.deepEqual(patches, [{
      status: 'error', syncError: scenario.expected, integrity: 'sync_error'
    }]);
    assert.equal('syncedAt' in patches[0], false);
  }
});
