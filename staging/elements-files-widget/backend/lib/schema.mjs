import { invariant } from './errors.mjs';
import { normalizeId } from './config.mjs';

export const WIDGET_PROPERTY = Object.freeze({
  section: '[SYS] Раздел виджета',
  fileFormat: '[SYS] Формат файла',
  provider: '[SYS] Провайдер',
  googleFileId: '[SYS] Google File ID',
  googleFolderId: '[SYS] Google Folder ID',
  mimeType: '[SYS] MIME type',
  downloadName: '[SYS] Download name',
  size: '[SYS] Размер байт',
  sha256: '[SYS] SHA-256',
  md5: '[SYS] Drive MD5',
  position: '[SYS] Позиция',
  syncStatus: '[SYS] Sync status',
  syncedAt: '[SYS] Последняя синхронизация',
  syncError: '[SYS] Ошибка sync',
  normalizedUrl: '[SYS] Normalized URL',
  idempotencyKey: '[SYS] Idempotency key',
  taskPageId: '[SYS] Task Page ID',
  knowledgeKey: '[SYS] Knowledge key',
  integrity: '[SYS] Integrity'
});

export const WIDGET_SCHEMA_CONTRACT = Object.freeze({
  [WIDGET_PROPERTY.section]: { type: 'select', options: ['Drive', 'Docs', 'Sheets', 'Slides'] },
  [WIDGET_PROPERTY.fileFormat]: {
    type: 'select',
    options: ['Google Docs', 'Word', 'Google Sheets', 'Excel', 'CSV', 'Google Slides', 'PowerPoint', 'Link', 'Other File']
  },
  [WIDGET_PROPERTY.provider]: { type: 'select', options: ['Google Drive', 'External URL', 'Notion'] },
  [WIDGET_PROPERTY.googleFileId]: { type: 'rich_text' },
  [WIDGET_PROPERTY.googleFolderId]: { type: 'rich_text' },
  [WIDGET_PROPERTY.mimeType]: { type: 'rich_text' },
  [WIDGET_PROPERTY.downloadName]: { type: 'rich_text' },
  [WIDGET_PROPERTY.size]: { type: 'number' },
  [WIDGET_PROPERTY.sha256]: { type: 'rich_text' },
  [WIDGET_PROPERTY.md5]: { type: 'rich_text' },
  [WIDGET_PROPERTY.position]: { type: 'number' },
  [WIDGET_PROPERTY.syncStatus]: {
    type: 'select',
    options: ['pending', 'synced', 'error', 'archived', 'unlinked', 'deleted', 'needs_review']
  },
  [WIDGET_PROPERTY.syncedAt]: { type: 'date' },
  [WIDGET_PROPERTY.syncError]: { type: 'rich_text' },
  [WIDGET_PROPERTY.normalizedUrl]: { type: 'rich_text' },
  [WIDGET_PROPERTY.idempotencyKey]: { type: 'rich_text' },
  [WIDGET_PROPERTY.taskPageId]: { type: 'formula' },
  [WIDGET_PROPERTY.knowledgeKey]: { type: 'formula' },
  [WIDGET_PROPERTY.integrity]: { type: 'select', options: ['ok', 'duplicate', 'context_error', 'sync_error'] }
});

function options(property) {
  return new Set((property?.select?.options || property?.options || []).map((entry) =>
    typeof entry === 'string' ? entry : entry?.name).filter(Boolean));
}

function relationTarget(property) {
  return normalizeId(property?.relation?.data_source_id || property?.relation?.database_id || property?.data_source_id);
}

function assertProperty(properties, name, expected) {
  const property = properties && properties[name];
  invariant(property, 503, 'missing_widget_schema_property', `В «Элементы» отсутствует свойство «${name}»`, { property: name });
  invariant(property.type === expected.type, 503, 'wrong_widget_schema_type',
    `Свойство «${name}» должно иметь тип ${expected.type}`, { property: name, expected: expected.type, actual: property.type });
  if (expected.options) {
    const actual = options(property);
    const missing = expected.options.filter((name) => !actual.has(name));
    const unexpected = [...actual].filter((name) => !expected.options.includes(name));
    invariant(missing.length === 0 && unexpected.length === 0, 503, 'wrong_widget_schema_options',
      `Свойство «${name}» не совпадает с обязательным набором вариантов`, { property: name, missing, unexpected });
  }
}

export function assertAuthorizedDatabase(database, config) {
  invariant(normalizeId(database?.id) === normalizeId(config.authorizedElementsDatabaseId), 503,
    'wrong_elements_database', 'Notion integration вернула не утверждённую database «Элементы»');
  const dataSources = database?.data_sources || database?.dataSources || [];
  invariant(dataSources.some((item) => normalizeId(item?.id) === normalizeId(config.elementsDataSourceId)), 503,
    'elements_data_source_not_in_database', 'Утверждённая database не содержит ожидаемый data source «Элементы»');
  return true;
}

export function assertAuthorizedDataSource(dataSource, config) {
  invariant(normalizeId(dataSource?.id) === normalizeId(config.elementsDataSourceId), 503,
    'wrong_elements_data_source', 'Notion integration вернула не утверждённый data source «Элементы»');
  invariant(normalizeId(dataSource?.parent?.database_id) === normalizeId(config.authorizedElementsDatabaseId), 503,
    'wrong_elements_database', 'Data source «Элементы» принадлежит другой database');
  const properties = dataSource?.properties || {};
  for (const [name, expected] of Object.entries(WIDGET_SCHEMA_CONTRACT)) assertProperty(properties, name, expected);

  const relationContracts = [
    ['Внутри', config.elementsDataSourceId],
    ['Знание: Сфера', config.spheresDataSourceId],
    ['Знание: Направление', config.directionsDataSourceId],
    ['Знание: Проект', config.projectsDataSourceId],
    ['[SYS] Контекст: Сфера', config.spheresDataSourceId],
    ['[SYS] Контекст: Направление', config.directionsDataSourceId],
    ['[SYS] Контекст: Проект', config.projectsDataSourceId]
  ];
  for (const [name, target] of relationContracts) {
    const property = properties[name];
    invariant(property?.type === 'relation', 503, 'wrong_relation_schema',
      `Свойство «${name}» должно быть relation`, { property: name });
    invariant(relationTarget(property) === normalizeId(target), 503, 'wrong_relation_target',
      `Свойство «${name}» ссылается не на утверждённый data source`, { property: name });
  }
  return true;
}
