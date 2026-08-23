import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient } from '../lib/drive.mjs';

const rootId = 'drive-staging-root';
const markerValue = 'boundary-marker-test';

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/json', ...headers }
  });
}

function client(fetchImpl) {
  const drive = new DriveClient({ googleClientId: 'x', googleClientSecret: 'y', googleRefreshToken: 'z' }, fetchImpl);
  drive.cachedToken = 'test-token';
  drive.expiresAt = Date.now() + 3600_000;
  return drive;
}

test('Drive preflight verifies exact account, root, private permissions, and marker file fallback', async () => {
  const calls = [];
  const drive = client(async (url) => {
    calls.push(String(url));
    if (String(url).includes('/about?')) return response({ user: { emailAddress: 'sandbox@example.test', permissionId: 'p1' } });
    if (String(url).includes('/files/' + rootId + '?')) {
      return response({
        id: rootId,
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false,
        appProperties: {},
        permissions: [{ id: 'p1', type: 'user', role: 'owner', emailAddress: 'sandbox@example.test' }]
      });
    }
    if (String(url).includes('/files?')) {
      return response({ files: [{ id: 'marker-file', name: '.elements-staging-boundary.json', mimeType: 'application/json', size: '120', parents: [rootId] }] });
    }
    if (String(url).includes('/files/marker-file?alt=media')) {
      return response({ schema: 1, rootFolderId: rootId, marker: markerValue });
    }
    throw new Error('Unexpected URL ' + url);
  });

  const result = await drive.assertStagingRoot({ folderId: rootId, expectedAccountEmail: 'sandbox@example.test', expectedMarker: markerValue });
  assert.equal(result.root.id, rootId);
  assert.equal(calls.length, 4);
});

test('Drive preflight rejects anyone/domain access before opening the gate', async () => {
  const drive = client(async (url) => {
    if (String(url).includes('/about?')) return response({ user: { emailAddress: 'sandbox@example.test' } });
    return response({
      id: rootId,
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      appProperties: { elementsStagingBoundary: markerValue },
      permissions: [{ id: 'public', type: 'anyone', role: 'reader' }]
    });
  });

  await assert.rejects(
    drive.assertStagingRoot({ folderId: rootId, expectedAccountEmail: 'sandbox@example.test', expectedMarker: markerValue }),
    { code: 'public_drive_boundary' }
  );
});

test('Drive idempotency and task-folder lookups fail closed on duplicates', async () => {
  const duplicateFiles = [{ id: 'one' }, { id: 'two' }];
  const drive = client(async () => response({ files: duplicateFiles }));
  await assert.rejects(drive.findFileByIdempotency({
    folderId: 'folder', taskId: 'a'.repeat(32), idempotencyKey: 'idem-12345678'
  }), { code: 'duplicate_drive_identity' });
  await assert.rejects(drive.ensureTaskFolder(rootId, 'a'.repeat(32), 'Task'), { code: 'duplicate_task_folder' });
});

test('new task-folder is re-queried and must remain the unique exact identity', async () => {
  const taskId = 'a'.repeat(32);
  const created = {
    id: 'created-folder', name: 'Task', mimeType: 'application/vnd.google-apps.folder',
    trashed: false, parents: [rootId], appProperties: { elementsTaskPageId: taskId }
  };
  let listCalls = 0;
  const drive = client(async (_url, options = {}) => {
    if (options.method === 'POST') return response(created);
    listCalls += 1;
    return response({ files: listCalls === 1 ? [] : [created] });
  });
  assert.deepEqual(await drive.ensureTaskFolder(rootId, taskId, 'Task'), created);
  assert.equal(listCalls, 2);

  let raceListCalls = 0;
  const raced = client(async (_url, options = {}) => {
    if (options.method === 'POST') return response(created);
    raceListCalls += 1;
    return response({ files: raceListCalls === 1 ? [] : [{ ...created, id: 'other-folder' }] });
  });
  await assert.rejects(raced.ensureTaskFolder(rootId, taskId, 'Task'), { code: 'task_folder_creation_race' });
});

test('Drive client exposes no trash or permanent-delete capability', () => {
  const drive = client(async () => response({}));
  assert.equal(typeof drive.trashFile, 'undefined');
  assert.equal(typeof drive.deleteFile, 'undefined');
});
