import { fingerprint } from './canonical.mjs';
import { invariant } from './errors.mjs';

const SECTIONS = new Set(['Drive', 'Docs', 'Sheets', 'Slides']);
const PROVIDERS = new Set(['Google Drive', 'External URL', 'Notion']);
const KNOWLEDGE_FORMATS = new Set(['Файл', 'Ссылка']);
const SYNC_STATUSES = new Set(['pending', 'synced', 'error', 'archived', 'unlinked', 'deleted', 'needs_review']);

function idempotencyKey(kind, sourceId) {
  return `elements-migration:v2:${kind}:${sourceId}`;
}

function topologicalOrder(records, parentFor, cycleCode, cycleMessage) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  function visit(record) {
    if (visited.has(record.id)) return;
    invariant(!visiting.has(record.id), cycleCode, cycleMessage, { sourceId: record.id });
    visiting.add(record.id);
    const parentId = parentFor(record);
    if (parentId) {
      const parent = byId.get(parentId);
      invariant(parent, 'placement_parent_missing', 'Родитель отсутствует в нормализованном snapshot', {
        sourceId: record.id,
        parentId
      });
      visit(parent);
    }
    visiting.delete(record.id);
    visited.add(record.id);
    ordered.push(record);
  }
  for (const record of records) visit(record);
  return ordered;
}

function orderTasks(tasks) {
  return topologicalOrder(
    tasks,
    (task) => task.insideSourceTaskId,
    'task_placement_cycle',
    'Обнаружен цикл во вложенности задач'
  );
}

function orderSections(sections) {
  return topologicalOrder(
    sections,
    (section) => section.placement.mode === 'direct' && section.placement.kind === 'section'
      ? section.placement.sourceId
      : '',
    'section_placement_cycle',
    'Обнаружен цикл во вложенности разделов'
  );
}

function normalizedUrl(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(String(value));
  } catch {
    invariant(false, 'invalid_source_url', 'Элемент содержит некорректный URL');
  }
  invariant(url.protocol === 'https:', 'unsafe_source_url', 'Мигрируются только HTTPS URL');
  url.hash = '';
  url.username = '';
  url.password = '';
  if (url.port === '443') url.port = '';
  return url.toString();
}

function position(item, fallback = 0) {
  const value = item.position === undefined ? fallback : Number(item.position);
  invariant(Number.isSafeInteger(value) && value >= 0, 'invalid_position',
    'Позиция должна быть целым неотрицательным числом', {
      sourceId: item.id,
      position: item.position
    });
  return value;
}

function archived(item) {
  return item.archived === true || item.archived === '__YES__' || item.status === 'Архив';
}

function syncStatus(item, placement) {
  const value = placement && placement.mode === 'inbox'
    ? 'needs_review'
    : String(item.syncStatus || (archived(item) ? 'archived' : 'synced'));
  invariant(SYNC_STATUSES.has(value), 'invalid_sync_status', 'Неизвестный sync status', {
    sourceId: item.id,
    syncStatus: value
  });
  return value;
}

function taskPayload(task) {
  const link = normalizedUrl(task.url || task.sourceUrl || '');
  return {
    name: task.title,
    type: 'Задача',
    archived: archived(task),
    link,
    normalizedUrl: link,
    position: position(task)
  };
}

function sectionPayload(item) {
  const link = normalizedUrl(item.url || item.sourceUrl || '');
  const payload = {
    name: item.title,
    type: item.placement.mode === 'inbox' ? '' : 'Раздел',
    archived: archived(item),
    link,
    normalizedUrl: link,
    position: position(item),
    syncStatus: syncStatus(item, item.placement)
  };
  if (item.section !== undefined && item.section !== null && String(item.section).trim() !== '') {
    const widgetSection = String(item.section);
    invariant(SECTIONS.has(widgetSection), 'invalid_section', 'Неизвестный раздел виджета', {
      section: widgetSection,
      sourceId: item.id
    });
    payload.section = widgetSection;
  }
  return payload;
}

function knowledgePayload(item, positionFallback) {
  const provider = String(item.provider || (item.url || item.sourceUrl ? 'External URL' : 'Notion'));
  const section = String(item.section || 'Drive');
  invariant(PROVIDERS.has(provider), 'invalid_provider', 'Неизвестный провайдер материала', {
    provider,
    sourceId: item.id
  });
  invariant(SECTIONS.has(section), 'invalid_section', 'Неизвестный раздел виджета', {
    section,
    sourceId: item.id
  });
  const link = normalizedUrl(item.url || item.sourceUrl || '');
  const knowledgeFormat = item.knowledgeFormat || (provider === 'External URL' ? 'Ссылка' : 'Файл');
  invariant(KNOWLEDGE_FORMATS.has(knowledgeFormat), 'invalid_knowledge_format', 'Неизвестный формат знания', {
    sourceId: item.id,
    knowledgeFormat
  });
  const size = item.size === undefined || item.size === null ? null : Number(item.size);
  invariant(size === null || (Number.isSafeInteger(size) && size >= 0), 'invalid_size',
    'Размер должен быть целым неотрицательным числом', { sourceId: item.id, size: item.size });
  return {
    name: item.title,
    type: item.placement.mode === 'inbox' ? '' : 'Знание',
    knowledgeFormat,
    section,
    fileFormat: String(item.fileFormat || item.format || (provider === 'External URL' ? 'External URL' : 'Other File')),
    provider,
    googleFileId: String(item.googleFileId || ''),
    googleFolderId: String(item.googleFolderId || ''),
    position: position(item, positionFallback),
    syncStatus: syncStatus(item, item.placement),
    syncedAt: item.syncedAt || null,
    archived: archived(item),
    link,
    normalizedUrl: link,
    mimeType: String(item.mimeType || ''),
    size,
    sha256: String(item.sha256 || ''),
    md5: String(item.md5 || '')
  };
}

function operationPlacement(placement) {
  return placement.mode === 'direct'
    ? {
        mode: 'direct',
        kind: placement.kind,
        sourceId: placement.sourceId,
        ...(placement.targetId ? { targetId: placement.targetId } : {})
      }
    : {
        mode: 'inbox',
        reason: placement.reason,
        level: placement.level,
        sourceIds: [...placement.sourceIds]
      };
}

export function buildMigrationPlan(normalizedSource) {
  const tasks = orderTasks(normalizedSource.tasks).map((task) => ({
    kind: 'task',
    sourceId: task.id,
    parentSourceId: task.insideSourceTaskId || '',
    sourceFingerprint: fingerprint(task),
    idempotencyKey: idempotencyKey('task', task.id),
    payload: taskPayload(task)
  }));

  const sections = orderSections(normalizedSource.sections || []).map((section) => ({
    kind: 'section',
    sourceId: section.id,
    placement: operationPlacement(section.placement),
    sourceFingerprint: fingerprint(section),
    idempotencyKey: idempotencyKey('section', section.id),
    payload: sectionPayload(section)
  }));

  const perPlacementPosition = new Map();
  const knowledge = normalizedSource.knowledge.map((item) => {
    const placement = operationPlacement(item.placement);
    const placementKey = placement.mode === 'direct'
      ? `${placement.kind}:${placement.sourceId}`
      : `inbox:${placement.reason}`;
    const counterKey = `${placementKey}:${item.section || 'Drive'}`;
    const fallback = (perPlacementPosition.get(counterKey) || 0) + 1;
    perPlacementPosition.set(counterKey, fallback);
    return {
      kind: 'knowledge',
      sourceId: item.id,
      placement,
      sourceFingerprint: fingerprint(item),
      idempotencyKey: idempotencyKey('knowledge', item.id),
      payload: knowledgePayload(item, fallback)
    };
  });
  return Object.freeze({ version: 2, tasks, sections, knowledge });
}
