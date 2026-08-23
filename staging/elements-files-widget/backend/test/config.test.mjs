import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORIZED_MAIN,
  LEGACY_NOTION_DENYLIST,
  assertTargetSafety,
  assertTaskWriteAllowed,
  assertWriteGate,
  embedRolloutTargetIds,
  loadConfig
} from '../lib/config.mjs';

function authorizedEnvironment(overrides = {}) {
  return {
    APP_ENV: 'staging',
    TARGET_PROFILE: 'authorized-main',
    AUTHORIZED_NOTION_WORKSPACE_ID: AUTHORIZED_MAIN.workspaceId,
    AUTHORIZED_ELEMENTS_DATABASE_ID: AUTHORIZED_MAIN.elementsDatabaseId,
    ELEMENTS_DATA_SOURCE_ID: AUTHORIZED_MAIN.elementsDataSourceId,
    AUTHORIZED_TASK_TEMPLATE_PAGE_ID: AUTHORIZED_MAIN.taskTemplatePageId,
    AUTHORIZED_CANARY_TASK_PAGE_ID: AUTHORIZED_MAIN.canaryTaskPageId,
    AUTHORIZED_CANARY_MATERIAL_PAGE_ID: AUTHORIZED_MAIN.canaryMaterialPageId,
    SPHERES_DATA_SOURCE_ID: AUTHORIZED_MAIN.spheresDataSourceId,
    DIRECTIONS_DATA_SOURCE_ID: AUTHORIZED_MAIN.directionsDataSourceId,
    PROJECTS_DATA_SOURCE_ID: AUTHORIZED_MAIN.projectsDataSourceId,
    STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder',
    STAGING_DRIVE_MARKER: 'staging-boundary-test',
    GOOGLE_EXPECTED_ACCOUNT_EMAIL: 'staging@example.com',
    WRITE_GATE: 'closed',
    DRY_RUN: 'true',
    TASK_WRITE_SCOPE: 'canary',
    EMBED_ROLLOUT_PHASE: 'disabled',
    ...overrides
  };
}

function load(overrides = {}) {
  return loadConfig(authorizedEnvironment(overrides), { allowMissingSecrets: true });
}

function hyphenate(id) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

test('exact authorized-main allowlist passes, including UUID punctuation', () => {
  assert.equal(assertTargetSafety(load()), true);
  const config = load({
    AUTHORIZED_NOTION_WORKSPACE_ID: hyphenate(AUTHORIZED_MAIN.workspaceId),
    AUTHORIZED_ELEMENTS_DATABASE_ID: hyphenate(AUTHORIZED_MAIN.elementsDatabaseId),
    ELEMENTS_DATA_SOURCE_ID: hyphenate(AUTHORIZED_MAIN.elementsDataSourceId),
    AUTHORIZED_TASK_TEMPLATE_PAGE_ID: hyphenate(AUTHORIZED_MAIN.taskTemplatePageId),
    AUTHORIZED_CANARY_TASK_PAGE_ID: hyphenate(AUTHORIZED_MAIN.canaryTaskPageId),
    AUTHORIZED_CANARY_MATERIAL_PAGE_ID: hyphenate(AUTHORIZED_MAIN.canaryMaterialPageId),
    SPHERES_DATA_SOURCE_ID: hyphenate(AUTHORIZED_MAIN.spheresDataSourceId),
    DIRECTIONS_DATA_SOURCE_ID: hyphenate(AUTHORIZED_MAIN.directionsDataSourceId),
    PROJECTS_DATA_SOURCE_ID: hyphenate(AUTHORIZED_MAIN.projectsDataSourceId)
  });
  assert.equal(assertTargetSafety(config), true);
});

test('each role-specific Notion target is exact and cannot be swapped', () => {
  const cases = {
    AUTHORIZED_NOTION_WORKSPACE_ID: 'f'.repeat(32),
    AUTHORIZED_ELEMENTS_DATABASE_ID: 'e'.repeat(32),
    ELEMENTS_DATA_SOURCE_ID: 'd'.repeat(32),
    AUTHORIZED_TASK_TEMPLATE_PAGE_ID: 'c'.repeat(32),
    AUTHORIZED_CANARY_TASK_PAGE_ID: 'b'.repeat(32),
    AUTHORIZED_CANARY_MATERIAL_PAGE_ID: '7'.repeat(32),
    SPHERES_DATA_SOURCE_ID: 'a'.repeat(32),
    DIRECTIONS_DATA_SOURCE_ID: '9'.repeat(32),
    PROJECTS_DATA_SOURCE_ID: '8'.repeat(32)
  };
  for (const [key, id] of Object.entries(cases)) {
    assert.throws(() => assertTargetSafety(load({ [key]: id })), { code: 'unauthorized_main_target' }, key);
  }
  assert.throws(() => assertTargetSafety(load({
    AUTHORIZED_TASK_TEMPLATE_PAGE_ID: AUTHORIZED_MAIN.canaryTaskPageId,
    AUTHORIZED_CANARY_TASK_PAGE_ID: AUTHORIZED_MAIN.taskTemplatePageId
  })), { code: 'unauthorized_main_target' });
  assert.throws(() => assertTargetSafety(load({
    SPHERES_DATA_SOURCE_ID: AUTHORIZED_MAIN.directionsDataSourceId,
    DIRECTIONS_DATA_SOURCE_ID: AUTHORIZED_MAIN.projectsDataSourceId,
    PROJECTS_DATA_SOURCE_ID: AUTHORIZED_MAIN.spheresDataSourceId
  })), { code: 'unauthorized_main_target' });
});

test('test targets require the explicit loader option and cannot be enabled by env', () => {
  const env = authorizedEnvironment({ ALLOW_TEST_TARGETS: 'true', ELEMENTS_DATA_SOURCE_ID: 'd'.repeat(32) });
  assert.throws(() => assertTargetSafety(loadConfig(env, { allowMissingSecrets: true })), { code: 'unauthorized_main_target' });

  const testEnv = {
    ...env,
    TARGET_PROFILE: 'test',
    AUTHORIZED_NOTION_WORKSPACE_ID: '1'.repeat(32),
    AUTHORIZED_ELEMENTS_DATABASE_ID: '2'.repeat(32),
    ELEMENTS_DATA_SOURCE_ID: '3'.repeat(32),
    AUTHORIZED_TASK_TEMPLATE_PAGE_ID: '4'.repeat(32),
    AUTHORIZED_CANARY_TASK_PAGE_ID: '5'.repeat(32),
    AUTHORIZED_CANARY_MATERIAL_PAGE_ID: '6'.repeat(32),
    SPHERES_DATA_SOURCE_ID: '7'.repeat(32),
    DIRECTIONS_DATA_SOURCE_ID: '8'.repeat(32),
    PROJECTS_DATA_SOURCE_ID: '9'.repeat(32)
  };
  assert.equal(assertTargetSafety(loadConfig(testEnv, { allowMissingSecrets: true, allowTestTargets: true })), true);
});

test('Legacy IDs remain denied and cannot overlap an authorized role', () => {
  assert.ok(LEGACY_NOTION_DENYLIST.length > 0);
  assert.throws(() => assertTargetSafety(load({
    LEGACY_NOTION_DENYLIST_IDS: AUTHORIZED_MAIN.elementsDataSourceId
  })), { code: 'allow_deny_overlap' });
  assert.throws(() => assertTargetSafety(load({
    LEGACY_NOTION_DENYLIST_IDS: 'not-a-notion-id'
  })), { code: 'invalid_notion_denylist_id' });
});

test('pre-acceptance write scope is canary-only and destructive gates stay closed', () => {
  const config = load();
  assert.equal(assertTaskWriteAllowed(config, AUTHORIZED_MAIN.canaryTaskPageId), true);
  assert.throws(() => assertTaskWriteAllowed(config, AUTHORIZED_MAIN.taskTemplatePageId), { code: 'task_write_not_allowlisted' });
  for (const [key, value] of [
    ['TASK_WRITE_SCOPE', 'elements'],
    ['TASK_WRITE_SCOPE', 'test-task'],
    ['ENABLE_NEW_TASK_WEBHOOK', 'true'],
    ['EMBED_ROLLOUT_PHASE', 'test-task'],
    ['EMBED_ROLLOUT_PHASE', 'template'],
    ['ALLOW_RELATION_UNLINK', 'true'],
    ['ALLOW_DRIVE_TRASH', 'true']
  ]) {
    assert.throws(() => assertTargetSafety(load({ [key]: value })), {
      code: key.startsWith('ALLOW_') ? 'destructive_action_blocked' : 'acceptance_required'
    });
  }
});

test('post-acceptance test-task scope permits only the one exact copied task', () => {
  const templateTestTask = 'a1'.repeat(16);
  const config = load({
    ACCEPTANCE_APPROVED: 'true', TASK_WRITE_SCOPE: 'test-task',
    AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID: templateTestTask
  });
  assert.equal(assertTargetSafety(config), true);
  assert.equal(assertTaskWriteAllowed(config, templateTestTask), true);
  assert.throws(() => assertTaskWriteAllowed(config, AUTHORIZED_MAIN.canaryTaskPageId),
    { code: 'task_write_not_allowlisted' });
  assert.throws(() => assertTaskWriteAllowed(config, AUTHORIZED_MAIN.taskTemplatePageId),
    { code: 'task_write_not_allowlisted' });
  assert.throws(() => assertTargetSafety(load({ ACCEPTANCE_APPROVED: 'true', TASK_WRITE_SCOPE: 'test-task' })),
    { code: 'missing_template_test_task_id' });
});

test('embed renewal targets only one exact rollout page', () => {
  const templateTestTask = 'a1'.repeat(16);
  assert.deepEqual(embedRolloutTargetIds(load({ EMBED_ROLLOUT_PHASE: 'disabled' })), []);
  assert.deepEqual(embedRolloutTargetIds(load({ EMBED_ROLLOUT_PHASE: 'canary' })), [AUTHORIZED_MAIN.canaryTaskPageId]);
  assert.deepEqual(embedRolloutTargetIds(load({ EMBED_ROLLOUT_PHASE: 'test-task', ACCEPTANCE_APPROVED: 'true',
    AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID: templateTestTask })), [templateTestTask]);
  assert.deepEqual(embedRolloutTargetIds(load({ EMBED_ROLLOUT_PHASE: 'template', ACCEPTANCE_APPROVED: 'true' })),
    [AUTHORIZED_MAIN.taskTemplatePageId]);
});

test('test-task rollout requires an exact optional task ID and fails closed', () => {
  assert.throws(() => assertTargetSafety(load({ EMBED_ROLLOUT_PHASE: 'test-task', ACCEPTANCE_APPROVED: 'true' })),
    { code: 'missing_template_test_task_id' });
  assert.throws(() => assertTargetSafety(load({ AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID: 'a-' + 'a'.repeat(31) })),
    { code: 'invalid_template_test_task_id' });
  assert.throws(() => assertTargetSafety(load({ AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID: AUTHORIZED_MAIN.canaryTaskPageId })),
    { code: 'duplicate_main_target' });
  assert.equal(assertTargetSafety(load({
    EMBED_ROLLOUT_PHASE: 'test-task', ACCEPTANCE_APPROVED: 'true',
    AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID: 'a1'.repeat(16)
  })), true);
});

test('writes require an open gate and DRY_RUN=false together', () => {
  assert.throws(() => assertWriteGate(load()), { code: 'write_gate_closed' });
  assert.throws(() => assertWriteGate(load({ WRITE_GATE: 'open' })), { code: 'dry_run_enabled' });
  assert.doesNotThrow(() => assertWriteGate(load({ WRITE_GATE: 'open', DRY_RUN: 'false' })));
});
