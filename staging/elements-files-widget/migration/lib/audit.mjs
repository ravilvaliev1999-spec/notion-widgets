import { asIssue, invariant, MigrationError } from './errors.mjs';
import { fingerprint } from './canonical.mjs';
import { normalizeNotionId, normalizeOptionalNotionId } from './ids.mjs';

const EXTERNAL_PLACEMENT_KINDS = Object.freeze(['project', 'direction', 'sphere']);

function requireArray(value, label) {
  invariant(Array.isArray(value), 'invalid_snapshot_shape', `${label} должен быть массивом`);
  return value;
}

function requireTitle(value, label) {
  const title = String(value || '').trim();
  invariant(title.length > 0, 'missing_title', `${label} не содержит название`);
  return title;
}

function taskPlacement(task, taskIds, index) {
  const parent = normalizeOptionalNotionId(task.insideSourceTaskId, `tasks[${index}].insideSourceTaskId`);
  invariant(!parent || taskIds.has(parent), 'unknown_task_parent', 'Родительская задача отсутствует в source snapshot', {
    taskId: normalizeNotionId(task.id),
    parent
  });
  invariant(!parent || parent !== normalizeNotionId(task.id), 'self_parent_task', 'Задача не может быть вложена сама в себя', {
    taskId: normalizeNotionId(task.id)
  });
  return parent;
}

function normalizedIds(values, label) {
  const raw = [];
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) raw.push(...value);
    else raw.push(value);
  }
  const ids = raw
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value, index) => normalizeNotionId(value, `${label}[${index}]`));
  return [...new Set(ids)];
}

function taggedInsideCandidates(item, index, label) {
  const tasks = normalizedIds([
    item.sourceTaskId,
    item.sourceTaskIds,
    item.insideSourceTaskId,
    item.insideSourceTaskIds
  ], `${label}[${index}].task placement`);
  const sections = normalizedIds([
    item.sourceSectionId,
    item.sourceSectionIds,
    item.insideSourceSectionId,
    item.insideSourceSectionIds
  ], `${label}[${index}].section placement`);
  return [
    ...tasks.map((id) => ({ kind: 'task', sourceId: id })),
    ...sections.map((id) => ({ kind: 'section', sourceId: id }))
  ];
}

function externalCandidates(item, kind, index, label) {
  const title = kind[0].toUpperCase() + kind.slice(1);
  return normalizedIds([
    item[`source${title}Id`],
    item[`source${title}Ids`]
  ], `${label}[${index}].${kind} placement`)
    .map((sourceId) => ({ kind, sourceId }));
}

function inboxPlacement(reason, level, candidates = []) {
  return Object.freeze({
    mode: 'inbox',
    reason,
    level,
    sourceIds: candidates.map(({ sourceId }) => sourceId)
  });
}

function resolvePlacement(item, index, label, taskIds, sectionIds) {
  const levels = [
    { level: 'inside', candidates: taggedInsideCandidates(item, index, label) },
    ...EXTERNAL_PLACEMENT_KINDS.map((kind) => ({
      level: kind,
      candidates: externalCandidates(item, kind, index, label)
    }))
  ];

  for (const { level, candidates } of levels) {
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      return inboxPlacement(`multiple_${level}_ids`, level, candidates);
    }
    const candidate = candidates[0];
    if (candidate.kind === 'task') {
      invariant(taskIds.has(candidate.sourceId), 'unknown_inside_task',
        'Размещение «Внутри» ссылается на отсутствующую source-задачу', {
          label,
          index,
          sourceTaskId: candidate.sourceId
        });
    }
    if (candidate.kind === 'section') {
      invariant(sectionIds.has(candidate.sourceId), 'unknown_inside_section',
        'Размещение «Внутри» ссылается на отсутствующий source-раздел', {
          label,
          index,
          sourceSectionId: candidate.sourceId
        });
    }
    return Object.freeze({ mode: 'direct', ...candidate });
  }
  return inboxPlacement('missing_placement', 'none');
}

function normalizeRelationMaps(rawRelationMaps = {}) {
  invariant(rawRelationMaps && typeof rawRelationMaps === 'object' && !Array.isArray(rawRelationMaps),
    'invalid_relation_maps', 'relationMaps должен быть объектом');
  const normalized = {};
  const allSourceIds = new Set();
  const allTargetIds = new Set();
  for (const kind of ['sphere', 'direction', 'project']) {
    const rawMap = rawRelationMaps[kind] ?? {};
    invariant(rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap),
      'invalid_relation_map', `relationMaps.${kind} должен быть объектом sourceId→sandboxId`);
    const next = {};
    const targetIds = new Set();
    for (const [rawSourceId, rawTargetId] of Object.entries(rawMap)) {
      const sourceId = normalizeNotionId(rawSourceId, `relationMaps.${kind}.sourceId`);
      const targetId = normalizeNotionId(rawTargetId, `relationMaps.${kind}.${rawSourceId}`);
      invariant(next[sourceId] === undefined, 'duplicate_relation_map_source',
        'relationMaps содержит повторяющийся source ID после нормализации', { kind, sourceId });
      invariant(!allSourceIds.has(sourceId), 'cross_kind_relation_map_source',
        'Один source ID не может одновременно быть сферой, направлением и проектом', { kind, sourceId });
      invariant(!targetIds.has(targetId), 'duplicate_relation_map_target',
        'relationMaps не может самовольно объединять несколько source ID в один sandbox ID', { kind, targetId });
      invariant(!allTargetIds.has(targetId), 'cross_kind_relation_map_target',
        'Один sandbox ID не может одновременно быть сферой, направлением и проектом', { kind, targetId });
      next[sourceId] = targetId;
      targetIds.add(targetId);
      allSourceIds.add(sourceId);
      allTargetIds.add(targetId);
    }
    normalized[kind] = next;
  }
  return normalized;
}

function attachExternalTarget(placement, relationMaps, label, sourceId) {
  if (placement.mode !== 'direct' || !EXTERNAL_PLACEMENT_KINDS.includes(placement.kind)) return placement;
  const targetId = relationMaps[placement.kind][placement.sourceId];
  invariant(targetId, 'missing_relation_mapping',
    'Для выбранного legacy-размещения отсутствует source→sandbox mapping', {
      label,
      sourceId,
      placementKind: placement.kind,
      placementSourceId: placement.sourceId
    });
  return Object.freeze({ ...placement, targetId });
}

function assertAcyclicPlacement(records, parentFor, code, message) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const visiting = new Set();
  const visited = new Set();
  function visit(record) {
    if (visited.has(record.id)) return;
    invariant(!visiting.has(record.id), code, message, { sourceId: record.id });
    visiting.add(record.id);
    const parentId = parentFor(record);
    if (parentId) {
      const parent = byId.get(parentId);
      invariant(parent, 'unknown_placement_parent', 'Родитель отсутствует в source snapshot', {
        sourceId: record.id,
        parentId
      });
      visit(parent);
    }
    visiting.delete(record.id);
    visited.add(record.id);
  }
  for (const record of records) visit(record);
}

function assertAcyclicTaskPlacement(tasks) {
  assertAcyclicPlacement(
    tasks,
    (task) => task.insideSourceTaskId,
    'task_placement_cycle',
    'Обнаружен цикл во вложенности задач'
  );
}

function assertAcyclicSectionPlacement(sections) {
  assertAcyclicPlacement(
    sections,
    (section) => section.placement.mode === 'direct' && section.placement.kind === 'section'
      ? section.placement.sourceId
      : '',
    'section_placement_cycle',
    'Обнаружен цикл во вложенности разделов'
  );
}

export function auditSourceSnapshot(snapshot, config) {
  const issues = [];
  let normalized;
  try {
    invariant(snapshot && typeof snapshot === 'object', 'missing_source_snapshot', 'Не передан source snapshot');
    invariant(snapshot.version === 1 || snapshot.version === 2, 'unsupported_snapshot_version',
      'Поддерживается source snapshot version=1 или version=2');
    invariant(snapshot.source && snapshot.source.readOnly === true, 'source_not_read_only', 'source.readOnly должен быть true');
    const tasks = requireArray(snapshot.tasks, 'tasks');
    const sections = requireArray(snapshot.sections ?? [], 'sections');
    const knowledge = requireArray(snapshot.knowledge, 'knowledge');
    invariant(tasks.length === config.expectedTaskCount, 'task_baseline_mismatch', 'Нарушен baseline количества задач', {
      expected: config.expectedTaskCount,
      actual: tasks.length
    });
    invariant(sections.length === config.expectedSectionCount, 'section_baseline_mismatch',
      'Нарушен baseline количества разделов', {
        expected: config.expectedSectionCount,
        actual: sections.length
      });
    invariant(knowledge.length === config.expectedKnowledgeCount, 'knowledge_baseline_mismatch',
      'Нарушен baseline базы знаний', {
        expected: config.expectedKnowledgeCount,
        actual: knowledge.length
      });

    const taskIds = new Set();
    const normalizedTasks = tasks.map((task, index) => {
      const id = normalizeNotionId(task.id, `tasks[${index}].id`);
      invariant(!taskIds.has(id), 'duplicate_task_id', 'Source snapshot содержит повторяющийся task ID', { id });
      taskIds.add(id);
      return { ...task, id, title: requireTitle(task.title, `tasks[${index}]`) };
    });
    for (let index = 0; index < normalizedTasks.length; index += 1) {
      normalizedTasks[index].insideSourceTaskId = taskPlacement(normalizedTasks[index], taskIds, index);
    }
    assertAcyclicTaskPlacement(normalizedTasks);

    const sectionIds = new Set();
    const normalizedSections = sections.map((section, index) => {
      const id = normalizeNotionId(section.id, `sections[${index}].id`);
      invariant(!sectionIds.has(id), 'duplicate_section_id', 'Source snapshot содержит повторяющийся section ID', { id });
      invariant(!taskIds.has(id), 'cross_type_id_collision', 'Один page ID используется как задача и раздел', { id });
      sectionIds.add(id);
      return { ...section, id, title: requireTitle(section.title, `sections[${index}]`) };
    });

    const relationMaps = normalizeRelationMaps(snapshot.relationMaps ?? {});
    for (let index = 0; index < normalizedSections.length; index += 1) {
      const section = normalizedSections[index];
      section.placement = attachExternalTarget(
        resolvePlacement(section, index, 'sections', taskIds, sectionIds),
        relationMaps,
        'sections',
        section.id
      );
    }
    assertAcyclicSectionPlacement(normalizedSections);

    const knowledgeIds = new Set();
    const normalizedKnowledge = knowledge.map((item, index) => {
      const id = normalizeNotionId(item.id, `knowledge[${index}].id`);
      invariant(!knowledgeIds.has(id), 'duplicate_knowledge_id', 'Source snapshot содержит повторяющийся knowledge ID', { id });
      invariant(!taskIds.has(id) && !sectionIds.has(id), 'cross_type_id_collision',
        'Один page ID используется в нескольких типах элементов', { id });
      knowledgeIds.add(id);
      const placement = attachExternalTarget(
        resolvePlacement(item, index, 'knowledge', taskIds, sectionIds),
        relationMaps,
        'knowledge',
        id
      );
      return {
        ...item,
        id,
        title: requireTitle(item.title, `knowledge[${index}]`),
        placement
      };
    });
    normalized = {
      version: 2,
      source: {
        ...snapshot.source,
        workspaceId: normalizeNotionId(snapshot.source.workspaceId, 'source.workspaceId'),
        tasksDataSourceId: normalizeNotionId(snapshot.source.tasksDataSourceId, 'source.tasksDataSourceId'),
        knowledgeDataSourceId: normalizeNotionId(snapshot.source.knowledgeDataSourceId, 'source.knowledgeDataSourceId'),
        readOnly: true
      },
      relationMaps,
      tasks: normalizedTasks,
      sections: normalizedSections,
      knowledge: normalizedKnowledge
    };
  } catch (error) {
    issues.push(asIssue(error));
  }
  return Object.freeze({
    ok: issues.length === 0,
    issues,
    counts: Object.freeze({
      tasks: Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks.length : 0,
      sections: Array.isArray(snapshot && snapshot.sections) ? snapshot.sections.length : 0,
      knowledge: Array.isArray(snapshot && snapshot.knowledge) ? snapshot.knowledge.length : 0
    }),
    ...(normalized ? { normalized, fingerprint: fingerprint(normalized) } : {})
  });
}

export function assertSourceSnapshot(snapshot, config) {
  const audit = auditSourceSnapshot(snapshot, config);
  if (!audit.ok) throw new MigrationError('source_audit_failed', 'Source snapshot не прошёл аудит', audit.issues);
  return audit;
}
