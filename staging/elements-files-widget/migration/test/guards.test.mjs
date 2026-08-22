import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReadOnlySource,
  assertSandboxSafety,
  assertWritesEnabled,
  loadMigrationConfig
} from '../lib/config.mjs';
import { IDS, makeEnv, makeSourceSnapshot } from './helpers.mjs';

function code(error) {
  return Boolean(error && error.code);
}

test('DRY_RUN=true and WRITE_GATE=closed are fail-closed defaults', () => {
  const env = makeEnv();
  delete env.DRY_RUN;
  delete env.WRITE_GATE;
  const config = loadMigrationConfig(env);
  assert.equal(config.dryRun, true);
  assert.equal(config.writeGate, 'closed');
  assert.throws(() => assertWritesEnabled(config, makeSourceSnapshot()), (error) =>
    code(error) && error.code === 'write_gate_closed');
});

test('write requires both an open gate and explicit DRY_RUN=false', () => {
  const snapshot = makeSourceSnapshot();
  const dryConfig = loadMigrationConfig(makeEnv({ WRITE_GATE: 'open' }));
  assert.throws(() => assertWritesEnabled(dryConfig, snapshot), (error) =>
    code(error) && error.code === 'dry_run_enabled');
  const liveConfig = loadMigrationConfig(makeEnv({ WRITE_GATE: 'open', DRY_RUN: 'false' }));
  assert.doesNotThrow(() => assertWritesEnabled(liveConfig, snapshot));
});

test('non-staging environment is always rejected', () => {
  const config = loadMigrationConfig(makeEnv({ APP_ENV: 'production', WRITE_GATE: 'open', DRY_RUN: 'false' }));
  assert.throws(() => assertWritesEnabled(config, makeSourceSnapshot()), (error) =>
    code(error) && error.code === 'unsafe_environment');
});

test('every original source container must be denied', () => {
  const env = makeEnv({ ORIGINAL_DENYLIST_IDS: IDS.sourceWorkspace });
  const config = loadMigrationConfig(env);
  assert.throws(() => assertSandboxSafety(config, makeSourceSnapshot()), (error) =>
    code(error) && error.code === 'source_not_denied');
});

test('sandbox allowlist may never overlap original denylist', () => {
  const snapshot = makeSourceSnapshot();
  const config = loadMigrationConfig(makeEnv({
    SANDBOX_WRITE_ALLOWLIST_IDS: IDS.sourceWorkspace
  }));
  assert.throws(() => assertSandboxSafety(config, snapshot), (error) =>
    code(error) && error.code === 'source_allowlisted');
});

test('source row IDs can never occupy core sandbox allowlist slots', () => {
  const snapshot = makeSourceSnapshot({ sectionCount: 1 });
  const sourceRows = [snapshot.tasks[0].id, snapshot.sections[0].id, snapshot.knowledge[0].id];
  const coreSlots = ['SANDBOX_WORKSPACE_ID', 'SANDBOX_PARENT_PAGE_ID', 'ELEMENTS_DATA_SOURCE_ID'];
  for (const sourceRowId of sourceRows) {
    for (const coreSlot of coreSlots) {
      const config = loadMigrationConfig(makeEnv({ [coreSlot]: sourceRowId }));
      assert.throws(() => assertSandboxSafety(config, snapshot), (error) =>
        code(error) && error.code === 'source_allowlisted');
    }
  }
});

test('external relation maps require explicit sandbox targets and reject source targets', () => {
  const snapshot = makeSourceSnapshot();
  snapshot.relationMaps.project = { [IDS.sourceProject]: IDS.sandboxProject };
  let config = loadMigrationConfig(makeEnv());
  assert.throws(() => assertSandboxSafety(config, snapshot), (error) =>
    code(error) && error.code === 'relation_target_not_allowlisted');

  config = loadMigrationConfig(makeEnv({ SANDBOX_WRITE_ALLOWLIST_IDS: IDS.sandboxProject }));
  assert.doesNotThrow(() => assertSandboxSafety(config, snapshot));

  snapshot.relationMaps.project = { [IDS.sourceProject]: IDS.sourceProject };
  config = loadMigrationConfig(makeEnv({ SANDBOX_WRITE_ALLOWLIST_IDS: IDS.sourceProject }));
  assert.throws(() => assertSandboxSafety(config, snapshot), (error) =>
    code(error) && error.code === 'relation_source_allowlisted');

  snapshot.relationMaps.project = { [IDS.sourceProject]: snapshot.tasks[0].id };
  config = loadMigrationConfig(makeEnv({ SANDBOX_WRITE_ALLOWLIST_IDS: snapshot.tasks[0].id }));
  assert.throws(() => assertSandboxSafety(config, snapshot), (error) =>
    code(error) && error.code === 'relation_target_is_source');

  snapshot.knowledge[0].sourceSphereId = IDS.sourceSphere;
  snapshot.relationMaps.project = { [IDS.sourceProject]: IDS.sourceSphere };
  config = loadMigrationConfig(makeEnv({ SANDBOX_WRITE_ALLOWLIST_IDS: IDS.sourceSphere }));
  assert.throws(() => assertSandboxSafety(config, snapshot), (error) =>
    code(error) && error.code === 'relation_target_is_source');
});

test('source must explicitly be read-only', () => {
  const snapshot = makeSourceSnapshot();
  snapshot.source.readOnly = false;
  assert.throws(() => assertReadOnlySource(snapshot), (error) =>
    code(error) && error.code === 'source_not_read_only');
});

test('ambiguous boolean values are rejected instead of guessed', () => {
  assert.throws(() => loadMigrationConfig(makeEnv({ DRY_RUN: '0' })), (error) =>
    code(error) && error.code === 'invalid_boolean');
});
