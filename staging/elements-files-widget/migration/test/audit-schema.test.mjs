import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { auditSourceSnapshot } from '../lib/audit.mjs';
import { loadMigrationConfig } from '../lib/config.mjs';
import { auditElementsSchema, ELEMENTS_SCHEMA_CONTRACT, PROPERTY } from '../lib/schema.mjs';
import { IDS, makeEnv, makeSchema, makeSourceSnapshot } from './helpers.mjs';

const config = loadMigrationConfig(makeEnv());

test('audits the exact 128 task + 16 knowledge baseline without mutating source', () => {
  const snapshot = makeSourceSnapshot();
  const before = JSON.stringify(snapshot);
  const audit = auditSourceSnapshot(snapshot, config);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.counts, { tasks: 128, sections: 0, knowledge: 16 });
  assert.match(audit.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot), before);
});

test('baseline counts are exact rather than minimum thresholds', () => {
  const tooFew = auditSourceSnapshot(makeSourceSnapshot({ taskCount: 127 }), config);
  assert.equal(tooFew.ok, false);
  assert.equal(tooFew.issues[0].code, 'task_baseline_mismatch');

  const tooManyKnowledge = auditSourceSnapshot(makeSourceSnapshot({ knowledgeCount: 17 }), config);
  assert.equal(tooManyKnowledge.ok, false);
  assert.equal(tooManyKnowledge.issues[0].code, 'knowledge_baseline_mismatch');

  const sectionConfig = loadMigrationConfig(makeEnv({ MIGRATION_EXPECTED_SECTIONS: '1' }));
  const tooManySections = auditSourceSnapshot(makeSourceSnapshot({ sectionCount: 2 }), sectionConfig);
  assert.equal(tooManySections.ok, false);
  assert.equal(tooManySections.issues[0].code, 'section_baseline_mismatch');
});

test('legacy placement uses task > project > direction > sphere precedence', () => {
  const snapshot = makeSourceSnapshot();
  snapshot.relationMaps = {
    sphere: { [IDS.sourceSphere]: IDS.sandboxSphere },
    direction: { [IDS.sourceDirection]: IDS.sandboxDirection },
    project: { [IDS.sourceProject]: IDS.sandboxProject }
  };
  Object.assign(snapshot.knowledge[0], {
    sourceProjectId: IDS.sourceProject,
    sourceDirectionId: IDS.sourceDirection,
    sourceSphereId: IDS.sourceSphere
  });
  let audit = auditSourceSnapshot(snapshot, config);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.normalized.knowledge[0].placement, {
    mode: 'direct',
    kind: 'task',
    sourceId: snapshot.tasks[0].id
  });

  delete snapshot.knowledge[0].sourceTaskId;
  audit = auditSourceSnapshot(snapshot, config);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.normalized.knowledge[0].placement, {
    mode: 'direct',
    kind: 'project',
    sourceId: IDS.sourceProject,
    targetId: IDS.sandboxProject
  });
});

test('redundant inherited context chooses the most specific direct relation', () => {
  const snapshot = makeSourceSnapshot();
  snapshot.relationMaps = {
    sphere: { [IDS.sourceSphere]: IDS.sandboxSphere },
    direction: { [IDS.sourceDirection]: IDS.sandboxDirection },
    project: { [IDS.sourceProject]: IDS.sandboxProject }
  };
  delete snapshot.knowledge[0].sourceTaskId;
  snapshot.knowledge[0].sourceDirectionId = IDS.sourceDirection;
  snapshot.knowledge[0].sourceSphereId = IDS.sourceSphere;
  let audit = auditSourceSnapshot(snapshot, config);
  assert.equal(audit.ok, true);
  assert.equal(audit.normalized.knowledge[0].placement.kind, 'direction');

  snapshot.knowledge[0].sourceProjectId = IDS.sourceProject;
  audit = auditSourceSnapshot(snapshot, config);
  assert.equal(audit.ok, true);
  assert.equal(audit.normalized.knowledge[0].placement.kind, 'project');
});

test('multiple IDs at the selected level and missing placement go to needs-review Inbox', () => {
  const ambiguous = makeSourceSnapshot();
  ambiguous.knowledge[0].sourceTaskIds = [ambiguous.tasks[0].id, ambiguous.tasks[1].id];
  delete ambiguous.knowledge[0].sourceTaskId;
  let audit = auditSourceSnapshot(ambiguous, config);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.normalized.knowledge[0].placement, {
    mode: 'inbox',
    reason: 'multiple_inside_ids',
    level: 'inside',
    sourceIds: [ambiguous.tasks[0].id, ambiguous.tasks[1].id]
  });

  const orphan = makeSourceSnapshot();
  delete orphan.knowledge[0].sourceTaskId;
  audit = auditSourceSnapshot(orphan, config);
  assert.equal(audit.ok, true);
  assert.equal(audit.normalized.knowledge[0].placement.mode, 'inbox');
  assert.equal(audit.normalized.knowledge[0].placement.reason, 'missing_placement');
});

test('a selected external placement requires an explicit relation map', () => {
  const snapshot = makeSourceSnapshot();
  delete snapshot.knowledge[0].sourceTaskId;
  snapshot.knowledge[0].sourceProjectId = IDS.sourceProject;
  const audit = auditSourceSnapshot(snapshot, config);
  assert.equal(audit.ok, false);
  assert.equal(audit.issues[0].code, 'missing_relation_mapping');
});

test('relation maps cannot collapse or cross external hierarchy kinds', () => {
  const snapshot = makeSourceSnapshot();
  snapshot.relationMaps = {
    sphere: { [IDS.sourceSphere]: IDS.sandboxProject },
    direction: {},
    project: { [IDS.sourceProject]: IDS.sandboxProject }
  };
  const audit = auditSourceSnapshot(snapshot, config);
  assert.equal(audit.ok, false);
  assert.equal(audit.issues[0].code, 'cross_kind_relation_map_target');
});

test('duplicate IDs and task placement cycles fail the source audit', () => {
  const duplicate = makeSourceSnapshot();
  duplicate.tasks[1].id = duplicate.tasks[0].id;
  let audit = auditSourceSnapshot(duplicate, config);
  assert.equal(audit.ok, false);
  assert.equal(audit.issues[0].code, 'duplicate_task_id');

  const cyclic = makeSourceSnapshot();
  cyclic.tasks[0].insideSourceTaskId = cyclic.tasks[1].id;
  cyclic.tasks[1].insideSourceTaskId = cyclic.tasks[0].id;
  audit = auditSourceSnapshot(cyclic, config);
  assert.equal(audit.ok, false);
  assert.equal(audit.issues[0].code, 'task_placement_cycle');

  const sectionConfig = loadMigrationConfig(makeEnv({ MIGRATION_EXPECTED_SECTIONS: '2' }));
  const sectionCycle = makeSourceSnapshot({ sectionCount: 2 });
  delete sectionCycle.sections[0].sourceTaskId;
  sectionCycle.sections[0].sourceSectionId = sectionCycle.sections[1].id;
  sectionCycle.sections[1].sourceSectionId = sectionCycle.sections[0].id;
  audit = auditSourceSnapshot(sectionCycle, sectionConfig);
  assert.equal(audit.ok, false);
  assert.equal(audit.issues[0].code, 'section_placement_cycle');
});

test('complete Elements schema passes', () => {
  const schema = makeSchema();
  const audit = auditElementsSchema(schema, IDS.elementsDataSource);
  assert.deepEqual(audit, { ok: true, issues: [] });
  assert.ok(schema.properties[PROPERTY.type].options.includes('Раздел'));
  assert.equal(schema.properties[PROPERTY.project].type, 'relation');
  assert.equal(schema.properties[PROPERTY.direction].type, 'relation');
  assert.equal(schema.properties[PROPERTY.sphere].type, 'relation');
  assert.equal(schema.properties[PROPERTY.archived].type, 'checkbox');
  assert.equal(schema.properties[PROPERTY.link].type, 'url');
  assert.ok(schema.properties[PROPERTY.syncStatus].options.includes('needs_review'));
});

test('missing fields, wrong types, options, and non-self relation are reported', () => {
  const schema = makeSchema();
  delete schema.properties[PROPERTY.googleFileId];
  schema.properties[PROPERTY.position].type = 'rich_text';
  schema.properties[PROPERTY.section].options = ['Drive'];
  schema.properties[PROPERTY.inside].dataSourceId = 'd'.repeat(32);
  const audit = auditElementsSchema(schema, IDS.elementsDataSource);
  assert.equal(audit.ok, false);
  const codes = new Set(audit.issues.map((issue) => issue.code));
  assert.ok(codes.has('missing_schema_property'));
  assert.ok(codes.has('wrong_schema_type'));
  assert.ok(codes.has('missing_schema_options'));
  assert.ok(codes.has('wrong_relation_target'));
});

test('Inbox must remain a blank Type rather than a schema option', () => {
  const schema = makeSchema();
  schema.properties[PROPERTY.type].options.push('Inbox');
  const audit = auditElementsSchema(schema, IDS.elementsDataSource);
  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some((issue) => issue.code === 'unexpected_schema_options'));
});

test('checked-in JSON schema contract covers the executable migration schema', async () => {
  const jsonContract = JSON.parse(await readFile(
    new URL('../../config/elements-schema.contract.json', import.meta.url),
    'utf8'
  ));
  assert.equal(PROPERTY.project, 'Знание: Проект');
  assert.equal(PROPERTY.direction, 'Знание: Направление');
  assert.equal(PROPERTY.sphere, 'Знание: Сфера');

  for (const [name, expected] of Object.entries(ELEMENTS_SCHEMA_CONTRACT)) {
    const declared = jsonContract.properties[name];
    if (!declared) {
      assert.ok(jsonContract.preserveFromTasks.includes(name), `${name} отсутствует в JSON contract`);
      continue;
    }
    const declaredType = declared.type === 'self_relation' ? 'relation' : declared.type;
    assert.equal(declaredType, expected.type, `type mismatch for ${name}`);
    if (expected.selfRelation) assert.equal(declared.type, 'self_relation', `${name} must be a self relation`);
    if (expected.options) {
      const declaredOptions = new Set(declared.options || []);
      for (const option of expected.options) {
        assert.ok(declaredOptions.has(option), `${name} misses option ${option}`);
      }
      if (expected.exactOptions) {
        assert.deepEqual([...declaredOptions].sort(), [...expected.options].sort(), `${name} options diverge`);
      }
    }
  }
  assert.ok(jsonContract.properties[PROPERTY.syncStatus].options.includes('needs_review'));
});
