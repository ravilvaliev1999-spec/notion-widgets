import { invariant } from './errors.mjs';
import { normalizeNotionId, uniqueNormalizedIds } from './ids.mjs';

function text(env, key, fallback = '') {
  return String(env[key] ?? fallback).trim();
}

function csv(value) {
  return String(value || '')
    .split(/[;,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function boolean(env, key, fallback) {
  const raw = text(env, key, fallback ? 'true' : 'false').toLowerCase();
  invariant(raw === 'true' || raw === 'false', 'invalid_boolean', `${key} должен быть true или false`);
  return raw === 'true';
}

function positiveInteger(env, key, fallback) {
  const parsed = Number(text(env, key, String(fallback)));
  invariant(Number.isSafeInteger(parsed) && parsed >= 0, 'invalid_count', `${key} должен быть целым неотрицательным числом`);
  return parsed;
}

export function loadMigrationConfig(env = process.env) {
  return Object.freeze({
    appEnv: text(env, 'APP_ENV', 'staging').toLowerCase(),
    dryRun: boolean(env, 'DRY_RUN', true),
    writeGate: text(env, 'WRITE_GATE', 'closed').toLowerCase(),
    sandboxWorkspaceId: text(env, 'SANDBOX_WORKSPACE_ID'),
    sandboxParentPageId: text(env, 'SANDBOX_PARENT_PAGE_ID'),
    elementsDataSourceId: text(env, 'ELEMENTS_DATA_SOURCE_ID'),
    extraAllowlistIds: csv(text(env, 'SANDBOX_WRITE_ALLOWLIST_IDS')),
    originalDenylistIds: csv(text(env, 'ORIGINAL_DENYLIST_IDS')),
    expectedTaskCount: positiveInteger(env, 'MIGRATION_EXPECTED_TASKS', 128),
    expectedSectionCount: positiveInteger(env, 'MIGRATION_EXPECTED_SECTIONS', 0),
    expectedKnowledgeCount: positiveInteger(env, 'MIGRATION_EXPECTED_KNOWLEDGE', 16)
  });
}

function relationMapPairs(snapshot) {
  const relationMaps = snapshot && snapshot.relationMaps;
  if (relationMaps === undefined) return [];
  invariant(relationMaps && typeof relationMaps === 'object' && !Array.isArray(relationMaps),
    'invalid_relation_maps', 'relationMaps должен быть объектом');
  const pairs = [];
  for (const kind of ['sphere', 'direction', 'project']) {
    const mapping = relationMaps[kind] ?? {};
    invariant(mapping && typeof mapping === 'object' && !Array.isArray(mapping),
      'invalid_relation_map', `relationMaps.${kind} должен быть объектом sourceId→sandboxId`);
    for (const [rawSourceId, rawTargetId] of Object.entries(mapping)) {
      pairs.push({
        kind,
        sourceId: normalizeNotionId(rawSourceId, `relationMaps.${kind}.sourceId`),
        targetId: normalizeNotionId(rawTargetId, `relationMaps.${kind}.${rawSourceId}`)
      });
    }
  }
  return pairs;
}

function sourceContainerIds(snapshot) {
  const source = snapshot && snapshot.source;
  invariant(source && typeof source === 'object', 'missing_source_identity', 'В snapshot отсутствует source');
  return uniqueNormalizedIds([
    source.workspaceId,
    source.tasksDataSourceId,
    source.knowledgeDataSourceId
  ], 'source containers');
}

function sourceRecordIds(snapshot) {
  const ids = [];
  for (const [name, records] of [
    ['tasks', snapshot && snapshot.tasks],
    ['sections', snapshot && snapshot.sections],
    ['knowledge', snapshot && snapshot.knowledge]
  ]) {
    if (records === undefined) continue;
    invariant(Array.isArray(records), 'invalid_snapshot_shape', `${name} должен быть массивом`);
    for (let index = 0; index < records.length; index += 1) {
      ids.push(normalizeNotionId(records[index] && records[index].id, `${name}[${index}].id`));
    }
  }
  return ids;
}

function sourceReferenceIds(snapshot) {
  const ids = [];
  const fields = [
    'sourceTaskId', 'sourceTaskIds', 'insideSourceTaskId', 'insideSourceTaskIds',
    'sourceSectionId', 'sourceSectionIds', 'insideSourceSectionId', 'insideSourceSectionIds',
    'sourceProjectId', 'sourceProjectIds',
    'sourceDirectionId', 'sourceDirectionIds',
    'sourceSphereId', 'sourceSphereIds'
  ];
  for (const [name, records] of [
    ['tasks', snapshot && snapshot.tasks],
    ['sections', snapshot && snapshot.sections],
    ['knowledge', snapshot && snapshot.knowledge]
  ]) {
    if (!Array.isArray(records)) continue;
    for (let index = 0; index < records.length; index += 1) {
      for (const field of fields) {
        const value = records[index] && records[index][field];
        const values = Array.isArray(value) ? value : [value];
        for (let itemIndex = 0; itemIndex < values.length; itemIndex += 1) {
          if (values[itemIndex] === undefined || values[itemIndex] === null || String(values[itemIndex]).trim() === '') continue;
          ids.push(normalizeNotionId(values[itemIndex], `${name}[${index}].${field}[${itemIndex}]`));
        }
      }
    }
  }
  return ids;
}

export function assertReadOnlySource(snapshot) {
  invariant(snapshot && snapshot.source && snapshot.source.readOnly === true,
    'source_not_read_only', 'Источник должен быть явно помечен source.readOnly=true');
  return sourceContainerIds(snapshot);
}

export function assertSandboxSafety(config, snapshot) {
  invariant(config.appEnv === 'staging', 'unsafe_environment', 'Разрешён только APP_ENV=staging');

  const requiredTargets = uniqueNormalizedIds([
    config.sandboxWorkspaceId,
    config.sandboxParentPageId,
    config.elementsDataSourceId
  ], 'sandbox allowlist');
  const extraTargets = config.extraAllowlistIds.map((id, index) =>
    normalizeNotionId(id, `SANDBOX_WRITE_ALLOWLIST_IDS[${index}]`));
  const allow = new Set([...requiredTargets, ...extraTargets]);
  const externalRelationAllow = new Set(extraTargets);
  const deny = new Set(config.originalDenylistIds.map((id, index) =>
    normalizeNotionId(id, `ORIGINAL_DENYLIST_IDS[${index}]`)));
  invariant(deny.size > 0, 'missing_original_denylist', 'ORIGINAL_DENYLIST_IDS не заполнен');

  const sourceIds = assertReadOnlySource(snapshot);
  const recordSourceIds = sourceRecordIds(snapshot);
  const referenceSourceIds = sourceReferenceIds(snapshot);
  const relationPairs = relationMapPairs(snapshot);
  const allSourceIds = new Set([
    ...sourceIds,
    ...recordSourceIds,
    ...referenceSourceIds,
    ...relationPairs.map(({ sourceId }) => sourceId)
  ]);
  for (const id of sourceIds) {
    invariant(deny.has(id), 'source_not_denied', 'Каждый исходный workspace/data source обязан находиться в denylist', { id });
    invariant(!allow.has(id), 'source_allowlisted', 'Исходный ID не может находиться в sandbox allowlist', { id });
  }
  for (const id of allow) {
    invariant(!deny.has(id), 'allow_deny_overlap', 'Sandbox allowlist пересекается с original denylist', { id });
  }
  for (const id of requiredTargets) {
    invariant(!allSourceIds.has(id), 'source_allowlisted',
      'Core sandbox target не может совпадать ни с одним source ID', { id });
  }
  for (const { kind, sourceId, targetId } of relationPairs) {
    invariant(!allow.has(sourceId), 'relation_source_allowlisted',
      'Source ID из relationMaps не может находиться в sandbox allowlist', { kind, sourceId });
    invariant(externalRelationAllow.has(targetId), 'relation_target_not_allowlisted',
      'Каждый target ID из relationMaps должен быть явно указан в SANDBOX_WRITE_ALLOWLIST_IDS', {
        kind,
        targetId
      });
    invariant(!deny.has(targetId), 'relation_target_denied',
      'Target ID из relationMaps не может находиться в original denylist', { kind, targetId });
    invariant(!allSourceIds.has(targetId), 'relation_target_is_source',
      'Target ID из relationMaps не может быть source ID', { kind, targetId });
  }
  return Object.freeze({ allow, deny, sourceIds, recordSourceIds, referenceSourceIds, relationPairs });
}

export function assertWritesEnabled(config, snapshot) {
  const safety = assertSandboxSafety(config, snapshot);
  invariant(config.writeGate === 'open', 'write_gate_closed', 'WRITE_GATE закрыт');
  invariant(config.dryRun === false, 'dry_run_enabled', 'DRY_RUN=true: запись запрещена');
  return safety;
}
