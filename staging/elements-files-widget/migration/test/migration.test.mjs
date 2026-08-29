import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMigrationConfig } from '../lib/config.mjs';
import { OfflineTarget, assertExactPlacement } from '../lib/offline-target.mjs';
import { runOfflineMigration } from '../lib/runner.mjs';
import { IDS, makeEnv, makeSourceSnapshot, makeTargetState } from './helpers.mjs';

const fixedNow = () => new Date('2026-08-22T00:00:00.000Z');

function writeConfig(overrides = {}) {
  return loadMigrationConfig(makeEnv({ WRITE_GATE: 'open', DRY_RUN: 'false', ...overrides }));
}

test('migrates 128 tasks and 16 knowledge records with exact placement and no network', async () => {
  const snapshot = makeSourceSnapshot();
  const sourceBefore = JSON.stringify(snapshot);
  const target = new OfflineTarget(makeTargetState());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network forbidden in migration tests'); };
  try {
    const result = await runOfflineMigration({ snapshot, config: writeConfig(), target, now: fixedNow });
    assert.deepEqual(result.stats, {
      created: 144,
      recovered: 0,
      skipped: 0,
      tasks: 128,
      sections: 0,
      knowledge: 16
    });
    assert.equal(target.records.length, 144);
    assert.equal(Object.keys(result.ledger.entries.tasks).length, 128);
    assert.equal(Object.keys(result.ledger.entries.knowledge).length, 16);
    assert.equal(result.ledger.complete, true);
    assertExactPlacement(target, result.ledger);
    assert.equal(JSON.stringify(snapshot), sourceBefore);
    for (const entry of Object.values(result.ledger.entries.knowledge)) {
      const record = target.getById(entry.targetId);
      assert.equal(entry.placement.mode, 'direct');
      assert.equal(entry.placement.kind, 'task');
      assert.deepEqual(record.properties.inside, [result.ledger.entries.tasks[entry.placement.sourceId].targetId]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a completed rerun skips all 144 mappings and creates no duplicates', async () => {
  const snapshot = makeSourceSnapshot();
  const target = new OfflineTarget(makeTargetState());
  const first = await runOfflineMigration({ snapshot, config: writeConfig(), target, now: fixedNow });
  const ledgerBefore = JSON.stringify(first.ledger);
  const second = await runOfflineMigration({
    snapshot,
    config: writeConfig(),
    target,
    ledger: first.ledger,
    now: fixedNow
  });
  assert.deepEqual(second.stats, {
    created: 0,
    recovered: 0,
    skipped: 144,
    tasks: 128,
    sections: 0,
    knowledge: 16
  });
  assert.equal(target.records.length, 144);
  assert.equal(JSON.stringify(second.ledger), ledgerBefore);
});

test('legacy version-1 ledgers are rejected instead of being reinterpreted', async () => {
  const snapshot = makeSourceSnapshot();
  const target = new OfflineTarget(makeTargetState());
  const first = await runOfflineMigration({ snapshot, config: writeConfig(), target, now: fixedNow });
  first.ledger.version = 1;
  await assert.rejects(
    runOfflineMigration({ snapshot, config: writeConfig(), target, ledger: first.ledger, now: fixedNow }),
    (error) => error.code === 'invalid_ledger'
  );
});

test('a lost ledger is rebuilt from deterministic target idempotency keys', async () => {
  const snapshot = makeSourceSnapshot();
  const target = new OfflineTarget(makeTargetState());
  await runOfflineMigration({ snapshot, config: writeConfig(), target, now: fixedNow });
  const recovered = await runOfflineMigration({ snapshot, config: writeConfig(), target, ledger: null, now: fixedNow });
  assert.deepEqual(recovered.stats, {
    created: 0,
    recovered: 144,
    skipped: 0,
    tasks: 128,
    sections: 0,
    knowledge: 16
  });
  assert.equal(target.records.length, 144);
  assertExactPlacement(target, recovered.ledger);
});

test('external precedence, ambiguous same-level IDs, and blank Inbox are enforced', async () => {
  const snapshot = makeSourceSnapshot();
  snapshot.relationMaps = {
    sphere: { [IDS.sourceSphere]: IDS.sandboxSphere },
    direction: { [IDS.sourceDirection]: IDS.sandboxDirection },
    project: {}
  };
  delete snapshot.knowledge[0].sourceTaskId;
  snapshot.knowledge[0].sourceDirectionId = IDS.sourceDirection;
  snapshot.knowledge[0].sourceSphereId = IDS.sourceSphere;
  delete snapshot.knowledge[1].sourceTaskId;
  snapshot.knowledge[1].sourceProjectIds = [IDS.sourceProject, '7'.repeat(32)];
  delete snapshot.knowledge[2].sourceTaskId;
  const config = writeConfig({
    SANDBOX_WRITE_ALLOWLIST_IDS: [IDS.sandboxSphere, IDS.sandboxDirection].join(',')
  });
  const target = new OfflineTarget(makeTargetState());
  const result = await runOfflineMigration({ snapshot, config, target, now: fixedNow });

  const directEntry = result.ledger.entries.knowledge[snapshot.knowledge[0].id];
  const directRecord = target.getById(directEntry.targetId);
  assert.deepEqual(directRecord.properties.direction, [IDS.sandboxDirection]);
  assert.deepEqual(directRecord.properties.sphere, []);
  assert.equal(directRecord.properties.type, 'Знание');

  for (const item of [snapshot.knowledge[1], snapshot.knowledge[2]]) {
    const entry = result.ledger.entries.knowledge[item.id];
    const record = target.getById(entry.targetId);
    assert.equal(entry.placement.mode, 'inbox');
    assert.equal(record.properties.type, '');
    assert.equal(record.properties.syncStatus, 'needs_review');
    assert.deepEqual(record.properties.inside, []);
    assert.deepEqual(record.properties.project, []);
    assert.deepEqual(record.properties.direction, []);
    assert.deepEqual(record.properties.sphere, []);
  }
  assertExactPlacement(target, result.ledger);
});

test('sections are migrated parent-first and remain cycle-safe', async () => {
  const snapshot = makeSourceSnapshot({ sectionCount: 3 });
  const deepestSectionId = snapshot.sections[2].id;
  delete snapshot.knowledge[0].sourceTaskId;
  snapshot.knowledge[0].sourceSectionId = deepestSectionId;
  snapshot.sections.reverse();
  const target = new OfflineTarget(makeTargetState());
  const result = await runOfflineMigration({
    snapshot,
    config: writeConfig({ MIGRATION_EXPECTED_SECTIONS: '3' }),
    target,
    now: fixedNow
  });
  assert.deepEqual(result.plan.sections.map(({ sourceId }) => sourceId), [
    snapshot.sections[2].id,
    snapshot.sections[1].id,
    snapshot.sections[0].id
  ]);
  assert.equal(Object.keys(result.ledger.entries.sections).length, 3);
  for (let index = 1; index < result.plan.sections.length; index += 1) {
    const operation = result.plan.sections[index];
    const entry = result.ledger.entries.sections[operation.sourceId];
    const record = target.getById(entry.targetId);
    const parent = result.ledger.entries.sections[operation.placement.sourceId];
    assert.deepEqual(record.properties.inside, [parent.targetId]);
    assert.equal(record.properties.type, 'Раздел');
  }
  const knowledgeEntry = result.ledger.entries.knowledge[snapshot.knowledge[0].id];
  const knowledgeRecord = target.getById(knowledgeEntry.targetId);
  assert.deepEqual(knowledgeRecord.properties.inside, [result.ledger.entries.sections[deepestSectionId].targetId]);
  assertExactPlacement(target, result.ledger);
});

test('target placement drift fails closed', async () => {
  const snapshot = makeSourceSnapshot();
  const target = new OfflineTarget(makeTargetState());
  const first = await runOfflineMigration({ snapshot, config: writeConfig(), target, now: fixedNow });
  const entry = Object.values(first.ledger.entries.knowledge)[0];
  target.getById(entry.targetId).properties.inside = [];
  await assert.rejects(
    runOfflineMigration({ snapshot, config: writeConfig(), target, ledger: first.ledger, now: fixedNow }),
    (error) => error.code === 'placement_not_exact'
  );
});

test('closed write guards leave target untouched', async () => {
  const target = new OfflineTarget(makeTargetState());
  await assert.rejects(
    runOfflineMigration({ snapshot: makeSourceSnapshot(), config: loadMigrationConfig(makeEnv()), target }),
    (error) => error.code === 'write_gate_closed'
  );
  assert.equal(target.records.length, 0);
});
