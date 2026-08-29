import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AUTHORIZED_MAIN, loadConfig } from '../lib/config.mjs';
import { issueTaskToken } from '../lib/auth.mjs';
import { P } from '../lib/records.mjs';
import { createApplication } from '../server.mjs';
import { AppError } from '../lib/errors.mjs';

const taskId = AUTHORIZED_MAIN.canaryTaskPageId;
const recordId = '11111111111111111111111111111111';
const secret = '0123456789abcdef0123456789abcdef';

function config(overrides = {}) {
  return loadConfig({
    APP_ENV: 'staging', TARGET_PROFILE: 'authorized-main', PORT: '8787',
    PUBLIC_BASE_URL: 'http://localhost:8787', WIDGET_PUBLIC_URL: 'http://localhost:8787/',
    ALLOWED_ORIGINS: 'http://localhost:8787',
    STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder', STAGING_DRIVE_MARKER: 'marker',
    GOOGLE_EXPECTED_ACCOUNT_EMAIL: 'staging@example.test', TOKEN_SIGNING_SECRET: secret,
    WRITE_GATE: 'open', DRY_RUN: 'false', TASK_WRITE_SCOPE: 'canary', EMBED_ROLLOUT_PHASE: 'disabled',
    ...overrides
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
    idempotencyKey: 'idem-12345678',
    status: 'synced', syncError: '', integrity: 'ok', section: 'Docs', format: 'Word', position: 1,
    ...overrides
  };
}

function headers(id = taskId) {
  return { Authorization: 'Bearer ' + issueTaskToken(id, AUTHORIZED_MAIN.elementsDataSourceId, secret, 60) };
}

function inheritedContext(overrides = {}) {
  return {
    sphereId: AUTHORIZED_MAIN.spheresDataSourceId,
    directionId: AUTHORIZED_MAIN.directionsDataSourceId,
    projectId: AUTHORIZED_MAIN.projectsDataSourceId,
    path: 'Sphere / Direction / Project / Task',
    ancestorIds: '[]',
    depth: 0,
    updatedAt: new Date('2026-08-23T00:00:00.000Z'),
    status: 'synced', integrity: 'ok', syncError: '',
    ...overrides
  };
}

async function withServer(dependencies, run, configOverrides = {}) {
  const app = createApplication(config(configOverrides), {
    ...dependencies,
    contextResolver: dependencies.contextResolver || (async () => inheritedContext()),
    targetPreflight: dependencies.targetPreflight || (async () => true),
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
  const current = record({
    name: 'old.docx', status: 'error', syncError: 'old_error', integrity: 'sync_error',
    context: inheritedContext()
  });
  const patches = [];
  let queryArgs;
  const records = {
    listActiveKnowledgeForTask: async () => [current],
    listGoogleDriveForTask: async (...args) => { queryArgs = args; return [current]; },
    patch: async (_task, _record, changes) => { patches.push(changes); return { ...current, ...changes }; },
    listForTask: async () => [{ ...current, ...patches.at(-1) }]
  };
  const notion = { retrievePage: async (id) => taskPage(id) };
  const drive = {
    assertStagingRoot: async () => ({}),
    getFile: async (id) => id === current.googleFileId ? ({
      id, name: 'fresh.docx', webViewLink: current.url, mimeType: current.mimeType,
      size: '3', md5Checksum: current.md5, parents: [current.googleFolderId], trashed: false,
      appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
    }) : ({
      id, mimeType: 'application/vnd.google-apps.folder', parents: ['drive-staging-folder'], trashed: false,
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

test('refresh resolves placement once, updates every scoped active provider, then reconciles Drive', async () => {
  const moved = inheritedContext({
    sphereId: '1'.repeat(32), directionId: '2'.repeat(32), projectId: '3'.repeat(32),
    path: 'New Sphere / New Direction / New Project / Task',
    ancestorIds: JSON.stringify(['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]), depth: 1
  });
  const oldContext = inheritedContext({
    sphereId: '4'.repeat(32), directionId: '5'.repeat(32), projectId: '6'.repeat(32),
    path: 'Old placement', ancestorIds: '[]', depth: 0
  });
  const external = {
    ...record({ id: '7'.repeat(32), provider: 'External URL', googleFileId: '', googleFolderId: '', context: oldContext }),
    taskIds: [taskId]
  };
  const driveRecord = { ...record({ id: '8'.repeat(32), context: oldContext }), taskIds: [taskId] };
  const foreign = {
    ...record({ id: '9'.repeat(32), taskId: 'a'.repeat(32), context: oldContext }),
    taskIds: ['a'.repeat(32)]
  };
  const events = [];
  const patches = [];
  let resolverCalls = 0;
  const records = {
    listActiveKnowledgeForTask: async () => { events.push('list-context'); return [external, driveRecord, foreign]; },
    listForTask: async () => [external, driveRecord],
    listGoogleDriveForTask: async () => { events.push('reconcile-drive'); return []; },
    patch: async (_task, id, changes) => { events.push('patch-' + id); patches.push({ id, changes }); return changes; }
  };
  const notion = { retrievePage: async (id) => taskPage(id) };
  const drive = { assertStagingRoot: async () => ({}) };
  const contextResolver = async () => { resolverCalls += 1; events.push('resolve'); return moved; };
  await withServer({ notion, drive, records, contextResolver }, async (base) => {
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/refresh', { method: 'POST', headers: headers() });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(resolverCalls, 1);
    assert.deepEqual(patches.map((entry) => entry.id), [external.id, driveRecord.id]);
    assert.deepEqual(patches.map((entry) => entry.changes.context.path), [moved.path, moved.path]);
    assert.ok(patches.every((entry) => entry.changes.context.updatedAt instanceof Date));
    assert.ok(events.indexOf('reconcile-drive') > events.indexOf('patch-' + driveRecord.id));
    assert.deepEqual(payload.sync.context, { scanned: 2, changed: 2, recovered: 0 });
  });
});

test('unchanged inherited context is a no-op and does not churn its timestamp', async () => {
  const context = inheritedContext();
  const external = {
    ...record({ provider: 'External URL', googleFileId: '', googleFolderId: '', context }),
    taskIds: [taskId]
  };
  let patchCalls = 0;
  let resolverCalls = 0;
  const records = {
    listActiveKnowledgeForTask: async () => [external],
    listForTask: async () => [external],
    listGoogleDriveForTask: async () => [],
    patch: async () => { patchCalls += 1; }
  };
  const notion = { retrievePage: async (id) => taskPage(id) };
  const drive = { assertStagingRoot: async () => ({}) };
  const contextResolver = async () => { resolverCalls += 1; return { ...context, updatedAt: new Date() }; };
  await withServer({ notion, drive, records, contextResolver }, async (base) => {
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/refresh', { method: 'POST', headers: headers() });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(resolverCalls, 1);
    assert.equal(patchCalls, 0);
    assert.deepEqual(payload.sync.context, { scanned: 1, changed: 0, recovered: 0 });
  });
});

test('download Content-Disposition uses immutable Download name after Drive rename', async () => {
  const current = record();
  const bytes = Buffer.from('abc');
  const notion = { retrievePage: async (id) => taskPage(id) };
  const records = { getForTask: async () => current };
  const drive = {
    getFile: async (id) => id === current.googleFileId ? ({
      id: current.googleFileId, name: current.name, mimeType: current.mimeType, size: String(current.size),
      md5Checksum: current.md5, parents: [current.googleFolderId], trashed: false,
      appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
    }) : ({
      id: current.googleFolderId, mimeType: 'application/vnd.google-apps.folder',
      parents: ['drive-staging-folder'], trashed: false,
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

test('Drive rename validates the exact file/folder boundary before any rename side effect', async () => {
  const baseRecord = record();
  const scenarios = [
    { name: 'missing record idempotency', record: { ...baseRecord, idempotencyKey: '' } },
    { name: 'corrupt SYS folder', record: { ...baseRecord, googleFolderId: 'corrupt-folder' }, folderParent: 'task-folder' },
    { name: 'file outside folder', fileParent: 'other-folder' },
    { name: 'file task binding', fileTask: 'f'.repeat(32) },
    { name: 'file idempotency binding', fileKey: 'other-key' },
    { name: 'folder MIME', folderMime: 'application/octet-stream' },
    { name: 'folder outside staging root', folderParent: 'other-root' },
    { name: 'folder task binding', folderTask: 'e'.repeat(32) },
    { name: 'trashed file', fileTrashed: true },
    { name: 'unknown file trash state', omitFileTrashed: true },
    { name: 'unknown folder trash state', omitFolderTrashed: true }
  ];
  for (const scenario of scenarios) {
    const current = scenario.record || baseRecord;
    let renameCalls = 0;
    let patchCalls = 0;
    const notion = { retrievePage: async (id) => taskPage(id) };
    const records = {
      getForTask: async () => current,
      patch: async () => { patchCalls += 1; return current; }
    };
    const drive = {
      assertStagingRoot: async () => ({}),
      getFile: async (id) => id === current.googleFileId ? ({
        id: current.googleFileId, mimeType: current.mimeType, parents: [scenario.fileParent || current.googleFolderId],
        trashed: scenario.omitFileTrashed ? undefined : scenario.fileTrashed === true,
        appProperties: {
          elementsTaskPageId: scenario.fileTask || taskId,
          elementsIdempotencyKey: scenario.fileKey || baseRecord.idempotencyKey
        }
      }) : ({
        id: current.googleFolderId, mimeType: scenario.folderMime || 'application/vnd.google-apps.folder',
        parents: [scenario.folderParent || 'drive-staging-folder'],
        trashed: scenario.omitFolderTrashed ? undefined : false,
        appProperties: { elementsTaskPageId: scenario.folderTask || taskId }
      }),
      renameFile: async () => { renameCalls += 1; }
    };
    await withServer({ notion, drive, records }, async (base) => {
      const response = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId, {
        method: 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new.docx' })
      });
      assert.ok(response.status >= 400, scenario.name);
      assert.equal(renameCalls, 0, scenario.name);
      assert.equal(patchCalls, 0, scenario.name);
    });
  }
});

test('Drive rename proceeds only after a complete valid boundary re-fetch', async () => {
  const current = record();
  const calls = [];
  const notion = { retrievePage: async (id) => taskPage(id) };
  const records = {
    getForTask: async () => current,
    patch: async (_task, _record, changes) => ({ ...current, ...changes })
  };
  const drive = {
    assertStagingRoot: async () => ({}),
    getFile: async (id) => {
      calls.push(['get', id]);
      return id === current.googleFileId ? ({
        id, mimeType: current.mimeType, parents: [current.googleFolderId], trashed: false,
        appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
      }) : ({
        id, mimeType: 'application/vnd.google-apps.folder', parents: ['drive-staging-folder'], trashed: false,
        appProperties: { elementsTaskPageId: taskId }
      });
    },
    renameFile: async (...args) => { calls.push(['rename', ...args]); }
  };
  await withServer({ notion, drive, records }, async (base) => {
    const response = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId, {
      method: 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'safe-new.docx' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      ['get', current.googleFileId], ['get', current.googleFolderId], ['rename', current.googleFileId, 'safe-new.docx']
    ]);
  });
});

test('metadata edits never advance successful-sync time for sticky binary quarantine', async () => {
  for (const syncError of ['drive_content_changed', 'drive_content_unverifiable']) {
    const current = record({ status: 'needs_review', integrity: 'sync_error', syncError });
    let renameCalls = 0;
    let changes;
    const notion = { retrievePage: async (id) => taskPage(id) };
    const records = {
      getForTask: async () => current,
      patch: async (_task, _record, input) => { changes = input; return { ...current, ...input }; }
    };
    const drive = {
      assertStagingRoot: async () => ({}),
      getFile: async (id) => id === current.googleFileId ? ({
        id, mimeType: current.mimeType, parents: [current.googleFolderId], trashed: false,
        appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
      }) : ({
        id, mimeType: 'application/vnd.google-apps.folder', parents: ['drive-staging-folder'], trashed: false,
        appProperties: { elementsTaskPageId: taskId }
      }),
      renameFile: async () => { renameCalls += 1; }
    };
    await withServer({ notion, drive, records }, async (base) => {
      const response = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId, {
        method: 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'review-name.docx' })
      });
      assert.equal(response.status, 200, syncError);
      assert.equal(renameCalls, 1, syncError);
      assert.equal(changes.name, 'review-name.docx', syncError);
      assert.equal('syncedAt' in changes, false, syncError);
    });
  }
});

test('download is blocked for every non-clean record before Drive access', async () => {
  for (const overrides of [
    { status: 'error' }, { status: 'needs_review' }, { status: 'archived' },
    { integrity: 'sync_error' }, { integrity: 'duplicate' }, { syncError: 'stale_error' }
  ]) {
    let driveCalls = 0;
    const notion = { retrievePage: async (id) => taskPage(id) };
    const records = { getForTask: async () => record(overrides) };
    const drive = { getFile: async () => { driveCalls += 1; return {}; } };
    await withServer({ notion, drive, records }, async (base) => {
      const response = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/download-link', {
        method: 'POST', headers: headers()
      });
      assert.equal(response.status, 409, JSON.stringify(overrides));
      assert.equal((await response.json()).error.code, 'download_blocked_by_integrity');
      assert.equal(driveCalls, 0);
    });
  }
});

test('download stream rechecks binary baseline and full staging folder boundary', async () => {
  for (const scenario of [
    { name: 'binary changed', size: '4', md5: 'c'.repeat(32), folderParent: 'drive-staging-folder', code: 'drive_content_changed', diagnostic: true },
    {
      name: 'Drive MD5 missing', size: '3', md5: undefined,
      folderParent: 'drive-staging-folder', code: 'drive_content_unverifiable', diagnostic: true
    },
    {
      name: 'fresh Google-native MIME cannot bypass a stored SHA baseline',
      fileMime: 'application/vnd.google-apps.document', size: undefined, md5: undefined,
      folderParent: 'drive-staging-folder', code: 'drive_content_unverifiable', diagnostic: true
    },
    {
      name: 'stale native SYS MIME cannot bypass fresh binary metadata',
      recordMime: 'application/vnd.google-apps.document', fileMime: 'application/octet-stream',
      linkMime: 'application/octet-stream',
      size: '4', md5: 'c'.repeat(32), folderParent: 'drive-staging-folder', code: 'drive_content_changed', diagnostic: true
    },
    { name: 'folder outside root', size: '3', md5: 'a'.repeat(32), folderParent: 'other-root', code: 'unsafe_drive_folder_parent', diagnostic: false }
  ]) {
    const current = record({ ...(scenario.recordMime ? { mimeType: scenario.recordMime } : {}) });
    let downloadCalls = 0;
    const patches = [];
    let recordReads = 0;
    const notion = { retrievePage: async (id) => taskPage(id) };
    const records = {
      getForTask: async () => {
        recordReads += 1;
        return recordReads === 1 && scenario.linkMime ? { ...current, mimeType: scenario.linkMime } : current;
      },
      patch: async (_task, _record, changes) => { patches.push(changes); return { ...current, ...changes }; }
    };
    const drive = {
      assertStagingRoot: async () => ({}),
      getFile: async (id) => id === current.googleFileId ? ({
        id, mimeType: scenario.fileMime || current.mimeType, size: scenario.size, md5Checksum: scenario.md5,
        parents: [current.googleFolderId], trashed: false,
        appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: current.idempotencyKey }
      }) : ({
        id, mimeType: 'application/vnd.google-apps.folder', parents: [scenario.folderParent], trashed: false,
        appProperties: { elementsTaskPageId: taskId }
      }),
      downloadFile: async () => { downloadCalls += 1; return new Response('should not stream'); }
    };
    await withServer({ notion, drive, records }, async (base) => {
      const linkResponse = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/download-link', {
        method: 'POST', headers: headers()
      });
      const link = await linkResponse.json();
      assert.equal(linkResponse.status, 200, scenario.name);
      const signed = new URL(link.url);
      const response = await fetch(base + signed.pathname + signed.search);
      assert.equal(response.status, 409, scenario.name);
      assert.equal((await response.json()).error.code, scenario.code);
      assert.equal(downloadCalls, 0, scenario.name);
      assert.deepEqual(patches, scenario.diagnostic ? [{
        status: 'needs_review', syncError: scenario.code, integrity: 'sync_error'
      }] : [], scenario.name);
    });
  }
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

test('post-acceptance test-task scope allows CRUD only on the exact copied task', async () => {
  const templateTestTask = 'a1'.repeat(16);
  let preflightCalls = 0;
  const notion = { retrievePage: async (id) => taskPage(id) };
  const current = record({ taskId: templateTestTask, taskIds: [templateTestTask] });
  const records = {
    getForTask: async () => current,
    patch: async (_task, _record, changes) => ({ ...current, ...changes })
  };
  const drive = { assertStagingRoot: async () => { preflightCalls += 1; return {}; } };
  const scope = {
    ACCEPTANCE_APPROVED: 'true', TASK_WRITE_SCOPE: 'test-task',
    AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID: templateTestTask
  };
  await withServer({ notion, drive, records }, async (base) => {
    const blocked = await fetch(base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/archive', {
      method: 'POST', headers: headers(taskId)
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'task_write_not_allowlisted');
    assert.equal(preflightCalls, 0);

    const allowed = await fetch(base + '/api/v1/tasks/' + templateTestTask + '/files/' + recordId + '/archive', {
      method: 'POST', headers: headers(templateTestTask)
    });
    assert.equal(allowed.status, 200);
    assert.equal(preflightCalls, 1);
  }, scope);
});

test('every sequential mutation reruns Drive and Notion preflight and later drift closes the gate', async () => {
  for (const drift of ['drive', 'notion']) {
    const current = record();
    let driveChecks = 0;
    let notionChecks = 0;
    let patchCalls = 0;
    const notion = { retrievePage: async (id) => taskPage(id) };
    const records = {
      getForTask: async () => current,
      patch: async () => { patchCalls += 1; return current; }
    };
    const drive = {
      assertStagingRoot: async () => {
        driveChecks += 1;
        if (drift === 'drive' && driveChecks === 2) {
          throw new AppError(503, 'staging_marker_drift', 'marker changed');
        }
        return {};
      }
    };
    const targetPreflight = async () => {
      notionChecks += 1;
      if (drift === 'notion' && notionChecks === 2) {
        throw new AppError(503, 'wrong_formula_expression', 'formula changed');
      }
      return true;
    };
    await withServer({ notion, drive, records, targetPreflight }, async (base) => {
      const url = base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/archive';
      assert.equal((await fetch(url, { method: 'POST', headers: headers() })).status, 200);
      const blocked = await fetch(url, { method: 'POST', headers: headers() });
      assert.equal(blocked.status, 503, drift);
      assert.equal(patchCalls, 1, drift);
      assert.equal(driveChecks, 2, drift);
      assert.equal(notionChecks, 2, drift);
    });
  }
});

test('concurrent mutations share only their in-flight write preflight', async () => {
  const current = record();
  let driveChecks = 0;
  let notionChecks = 0;
  let patchCalls = 0;
  const notion = { retrievePage: async (id) => taskPage(id) };
  const records = {
    getForTask: async () => current,
    patch: async () => { patchCalls += 1; return current; }
  };
  const drive = {
    assertStagingRoot: async () => {
      driveChecks += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {};
    }
  };
  const targetPreflight = async () => {
    notionChecks += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  await withServer({ notion, drive, records, targetPreflight }, async (base) => {
    const url = base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/archive';
    const responses = await Promise.all([
      fetch(url, { method: 'POST', headers: headers() }),
      fetch(url, { method: 'POST', headers: headers() })
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(driveChecks, 1);
    assert.equal(notionChecks, 1);
    assert.equal(patchCalls, 2);
  });
});

test('a failed write preflight is discarded and retried on the next mutation', async () => {
  const current = record();
  let gateCalls = 0;
  let patchCalls = 0;
  const notion = { retrievePage: async (id) => taskPage(id) };
  const records = {
    getForTask: async () => current,
    patch: async () => { patchCalls += 1; return current; }
  };
  const drive = { assertStagingRoot: async () => ({}) };
  const targetPreflight = async () => {
    gateCalls += 1;
    if (gateCalls === 1) throw new AppError(503, 'schema_temporarily_unavailable', 'schema unavailable');
  };
  await withServer({ notion, drive, records, targetPreflight }, async (base) => {
    const url = base + '/api/v1/tasks/' + taskId + '/files/' + recordId + '/archive';
    assert.equal((await fetch(url, { method: 'POST', headers: headers() })).status, 503);
    assert.equal((await fetch(url, { method: 'POST', headers: headers() })).status, 200);
    assert.equal(gateCalls, 2);
    assert.equal(patchCalls, 1);
  });
});
