import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTargetSafety, assertWriteGate, loadConfig } from '../lib/config.mjs';

function environment(overrides = {}) {
  return {
    APP_ENV: 'staging',
    SANDBOX_WORKSPACE_ID: '11111111111111111111111111111111',
    SANDBOX_PARENT_PAGE_ID: '22222222222222222222222222222222',
    ELEMENTS_DATA_SOURCE_ID: '33333333333333333333333333333333',
    STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder',
    STAGING_DRIVE_MARKER: 'staging-boundary-test',
    GOOGLE_EXPECTED_ACCOUNT_EMAIL: 'staging@example.com',
    WRITE_GATE: 'closed',
    DRY_RUN: 'true',
    ...overrides
  };
}

test('staging allowlist passes only when separate from production denylist', () => {
  const config = loadConfig(environment(), { allowMissingSecrets: true });
  assert.equal(assertTargetSafety(config), true);
});

test('production data source in allowlist is rejected', () => {
  const config = loadConfig(environment({ ELEMENTS_DATA_SOURCE_ID: '3822d627-39a1-8018-a2dc-000b95bf5722' }), { allowMissingSecrets: true });
  assert.throws(() => assertTargetSafety(config), { code: 'production_target_blocked' });
});

test('sandbox allowlist accepts UUID punctuation but rejects normalized IDs that are not exactly 32 hex', () => {
  const hyphenated = loadConfig(environment({
    SANDBOX_WORKSPACE_ID: '11111111-1111-1111-1111-111111111111'
  }), { allowMissingSecrets: true });
  assert.equal(assertTargetSafety(hyphenated), true);

  for (const invalid of ['1234', 'g'.repeat(32), 'a'.repeat(33)]) {
    const config = loadConfig(environment({ SANDBOX_WORKSPACE_ID: invalid }), { allowMissingSecrets: true });
    assert.throws(() => assertTargetSafety(config), { code: 'invalid_notion_allowlist_id' });
  }
});

test('additional Notion denylist IDs must normalize to exactly 32 hex', () => {
  const valid = loadConfig(environment({
    ORIGINAL_DENYLIST_IDS: '44444444-4444-4444-4444-444444444444'
  }), { allowMissingSecrets: true });
  assert.equal(assertTargetSafety(valid), true);

  for (const invalid of ['not-a-notion-id', 'f'.repeat(31), 'f'.repeat(33)]) {
    const config = loadConfig(environment({ ORIGINAL_DENYLIST_IDS: invalid }), { allowMissingSecrets: true });
    assert.throws(() => assertTargetSafety(config), { code: 'invalid_notion_denylist_id' });
  }
});

test('writes require open gate and DRY_RUN=false together', () => {
  const closed = loadConfig(environment(), { allowMissingSecrets: true });
  assert.throws(() => assertWriteGate(closed), { code: 'write_gate_closed' });
  const dry = loadConfig(environment({ WRITE_GATE: 'open' }), { allowMissingSecrets: true });
  assert.throws(() => assertWriteGate(dry), { code: 'dry_run_enabled' });
  const open = loadConfig(environment({ WRITE_GATE: 'open', DRY_RUN: 'false' }), { allowMissingSecrets: true });
  assert.doesNotThrow(() => assertWriteGate(open));
});
