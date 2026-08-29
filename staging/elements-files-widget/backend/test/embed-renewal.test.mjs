import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_MAIN, loadConfig } from '../lib/config.mjs';
import { issueTaskToken } from '../lib/auth.mjs';
import { P } from '../lib/records.mjs';
import { createApplication } from '../server.mjs';

const secret = '0123456789abcdef0123456789abcdef';
const widgetUrl = 'https://widget.example.test/widget/';
const templateTestTaskId = 'a1'.repeat(16);

function config(phase) {
  return loadConfig({
    APP_ENV: 'staging', TARGET_PROFILE: 'authorized-main',
    PUBLIC_BASE_URL: 'https://widget.example.test', WIDGET_PUBLIC_URL: widgetUrl,
    ALLOWED_ORIGINS: 'https://widget.example.test',
    STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder', STAGING_DRIVE_MARKER: 'marker',
    GOOGLE_EXPECTED_ACCOUNT_EMAIL: 'staging@example.test', TOKEN_SIGNING_SECRET: secret,
    WRITE_GATE: 'open', DRY_RUN: 'false', TASK_WRITE_SCOPE: 'canary',
    EMBED_ROLLOUT_PHASE: phase,
    ACCEPTANCE_APPROVED: ['template', 'test-task'].includes(phase) ? 'true' : 'false',
    AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID: templateTestTaskId
  }, { allowMissingSecrets: true });
}

function taskPage(id, overrides = {}) {
  return {
    id, archived: false, in_trash: false,
    parent: { type: 'data_source_id', data_source_id: AUTHORIZED_MAIN.elementsDataSourceId },
    properties: {
      [P.type]: { select: { name: 'Задача' } },
      [P.title]: { title: [{ plain_text: 'Task' }] },
      [P.integrity]: { select: { name: 'ok' } },
      [P.syncError]: { rich_text: [] }
    },
    ...overrides
  };
}

function validUrl(taskId) {
  const token = issueTaskToken(taskId, AUTHORIZED_MAIN.elementsDataSourceId, secret, 30 * 24 * 60 * 60);
  return widgetUrl + '#task=' + taskId + '&access=' + encodeURIComponent(token);
}

function harness({ phase, pageId, returnedPageId, blocks }) {
  const calls = { retrieve: [], list: [], patch: [], append: [], integrity: [], drivePreflight: 0 };
  const notion = {
    retrievePage: async (id) => { calls.retrieve.push(id); return taskPage(returnedPageId || id); },
    listBlockChildren: async (id) => { calls.list.push(id); return blocks; },
    updateEmbedBlock: async (...args) => { calls.patch.push(args); },
    appendBlockChildren: async (...args) => { calls.append.push(args); }
  };
  const drive = { assertStagingRoot: async () => { calls.drivePreflight += 1; return {}; } };
  const records = { markTaskIntegrity: async (...args) => { calls.integrity.push(args); } };
  const app = createApplication(config(phase), {
    notion, drive, records, targetPreflight: async () => true,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { app, calls, pageId };
}

test('disabled embed rollout reads and writes nothing', async () => {
  const { app, calls } = harness({ phase: 'disabled', blocks: [] });
  assert.deepEqual(await app.renewEmbeds(), { scanned: 0, changed: 0, duplicates: 0, targets: [] });
  assert.deepEqual(calls.retrieve, []);
  assert.equal(calls.drivePreflight, 0);
});

test('rollout rejects a different valid Elements task returned for the exact target ID', async () => {
  const { app, calls } = harness({
    phase: 'canary', returnedPageId: templateTestTaskId, blocks: []
  });
  await assert.rejects(app.renewEmbeds(), { code: 'notion_page_identity_mismatch' });
  assert.deepEqual(calls.retrieve, [AUTHORIZED_MAIN.canaryTaskPageId]);
  assert.deepEqual(calls.list, []);
  assert.deepEqual(calls.patch, []);
  assert.deepEqual(calls.append, []);
  assert.deepEqual(calls.integrity, []);
});

test('canary, copied test-task and template phases retrieve only their exact page without a data-source sweep', async () => {
  for (const [phase, target] of [
    ['canary', AUTHORIZED_MAIN.canaryTaskPageId],
    ['test-task', templateTestTaskId],
    ['template', AUTHORIZED_MAIN.taskTemplatePageId]
  ]) {
    const { app, calls } = harness({ phase, blocks: [] });
    const result = await app.renewEmbeds();
    assert.deepEqual(calls.retrieve, [target]);
    assert.deepEqual(calls.list, [target]);
    assert.equal(calls.append.length, 1);
    assert.equal(result.scanned, 1);
    assert.deepEqual(result.targets, [target]);
  }
});

test('valid embed keeps every duplicate block and marks task Integrity=duplicate', async () => {
  const target = AUTHORIZED_MAIN.canaryTaskPageId;
  const blocks = [
    { id: '1'.repeat(32), type: 'embed', embed: { url: validUrl(target) } },
    { id: '2'.repeat(32), type: 'embed', embed: { url: widgetUrl + '#task=' + target + '&access=stale' } }
  ];
  const { app, calls } = harness({ phase: 'canary', blocks });
  const result = await app.renewEmbeds();
  assert.equal(calls.patch.length, 0);
  assert.equal(calls.append.length, 0);
  assert.deepEqual(calls.integrity, [[target, 'duplicate', 'duplicate_widget_embed']]);
  assert.equal(result.duplicates, 1);
});

test('two stale widget embeds patch one deterministic keeper and preserve the other', async () => {
  const target = AUTHORIZED_MAIN.canaryTaskPageId;
  const blocks = [
    { id: '1'.repeat(32), type: 'embed', embed: { url: widgetUrl + '#stale=one' } },
    { id: '2'.repeat(32), type: 'embed', embed: { url: widgetUrl + '#stale=two' } }
  ];
  const { app, calls } = harness({ phase: 'canary', blocks });
  await app.renewEmbeds();
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0][0], blocks[0].id);
  assert.equal(calls.append.length, 0);
  assert.deepEqual(calls.integrity, [[target, 'duplicate', 'duplicate_widget_embed']]);
});

test('hostile similar-prefix embeds are ignored and one authorized embed is appended', async () => {
  const hostile = { id: '9'.repeat(32), type: 'embed', embed: { url: 'https://widget.example.test.evil/widget/#stale=1' } };
  const { app, calls } = harness({ phase: 'canary', blocks: [hostile] });
  await app.renewEmbeds();
  assert.equal(calls.patch.length, 0);
  assert.equal(calls.append.length, 1);
  assert.equal(calls.integrity.length, 0);
});
