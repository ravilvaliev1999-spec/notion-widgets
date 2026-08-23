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

export const ELEMENTS_RUNTIME_SCHEMA_CONTRACT = Object.freeze({
  Name: { type: 'title' },
  'Тип': { type: 'select', options: ['Задача', 'Знание', 'Раздел'] },
  'Формат знания': { type: 'select', requiredOptions: ['Файл', 'Ссылка'] },
  'Архив': { type: 'checkbox' },
  'Ссылка': { type: 'url' },
  '[SYS] Context path': { type: 'rich_text' },
  '[SYS] Ancestor IDs': { type: 'rich_text' },
  '[SYS] Глубина': { type: 'number' },
  '[SYS] Контекст обновлён': { type: 'date' }
});

export const FORMULA_EXPRESSIONS = Object.freeze({
  [WIDGET_PROPERTY.taskPageId]: 'if(prop("Тип") == "Знание" and prop("Внутри").length() == 1 and prop("Внутри").first().prop("Тип") == "Задача", prop("Внутри").first().id(), "")',
  [WIDGET_PROPERTY.knowledgeKey]: 'if(empty(prop("[SYS] Task Page ID")), "", if(not(empty(prop("[SYS] Google File ID"))), prop("[SYS] Task Page ID") + "|g|" + prop("[SYS] Google File ID"), if(not(empty(prop("[SYS] Normalized URL"))), prop("[SYS] Task Page ID") + "|u|" + prop("[SYS] Normalized URL"), "")))'
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
  if (expected.requiredOptions) {
    const actual = options(property);
    const missing = expected.requiredOptions.filter((name) => !actual.has(name));
    invariant(missing.length === 0, 503, 'missing_runtime_schema_options',
      `Свойство «${name}» не содержит обязательные варианты`, { property: name, missing });
  }
}

function normalizeFormula(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formulaExpression(property) {
  const candidates = [
    property?.formula?.expression,
    property?.formula?.formula,
    property?.formula?.code,
    property?.expression
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
}

function formulaString(property) {
  if (property?.formula?.type === 'string') return String(property.formula.string || '');
  if (typeof property?.formula?.string === 'string') return property.formula.string;
  return '';
}

function canonicalId(value) {
  const id = normalizeId(value);
  return id.length === 32 ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : '';
}

function assertRelation(properties, name, target, options = {}) {
  const property = properties?.[name];
  invariant(property?.type === 'relation', 503, 'wrong_relation_schema',
    `Свойство «${name}» должно быть relation`, { property: name });
  invariant(relationTarget(property) === normalizeId(target), 503, 'wrong_relation_target',
    `Свойство «${name}» ссылается не на утверждённый data source`, { property: name });
  if (options.limit === 1) {
    const exposedLimit = property?.relation?.max_items ?? property?.relation?.limit ?? property?.relation?.maxItems;
    if (exposedLimit !== undefined && exposedLimit !== null) {
      invariant(Number(exposedLimit) === 1, 503, 'wrong_relation_limit',
        `Свойство «${name}» должно допускать не более одной связи`, { property: name, actual: exposedLimit });
    }
  }
}

function assertFormulaExpressions(dataSource) {
  const properties = dataSource?.properties || {};
  const exposed = Object.entries(FORMULA_EXPRESSIONS).map(([name, expected]) => ({
    name, expected, actual: formulaExpression(properties[name])
  }));
  const count = exposed.filter((item) => item.actual).length;
  invariant(count === 0 || count === exposed.length, 503, 'partial_formula_schema',
    'Notion раскрыл выражение только одной из двух обязательных формул');
  for (const item of exposed) {
    if (!item.actual) continue;
    invariant(normalizeFormula(item.actual) === normalizeFormula(item.expected), 503, 'wrong_formula_expression',
      `Формула «${item.name}» не совпадает с утверждённым выражением`, { property: item.name });
  }
}

export function formulasExposeExpressions(dataSource) {
  const properties = dataSource?.properties || {};
  return Object.keys(FORMULA_EXPRESSIONS).every((name) => Boolean(formulaExpression(properties[name])));
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
  for (const [name, expected] of Object.entries(ELEMENTS_RUNTIME_SCHEMA_CONTRACT)) assertProperty(properties, name, expected);

  const relationContracts = [
    ['Внутри', config.elementsDataSourceId],
    ['3. Проекты', config.projectsDataSourceId],
    ['Parent item', config.elementsDataSourceId, { limit: 1 }],
    ['Знание: Сфера', config.spheresDataSourceId],
    ['Знание: Направление', config.directionsDataSourceId],
    ['Знание: Проект', config.projectsDataSourceId],
    ['[SYS] Контекст: Сфера', config.spheresDataSourceId],
    ['[SYS] Контекст: Направление', config.directionsDataSourceId],
    ['[SYS] Контекст: Проект', config.projectsDataSourceId]
  ];
  for (const [name, target, options] of relationContracts) assertRelation(properties, name, target, options);
  assertFormulaExpressions(dataSource);
  return true;
}

function assertContextDataSource(dataSource, expectedId, kind) {
  invariant(normalizeId(dataSource?.id) === normalizeId(expectedId), 503, 'wrong_context_data_source',
    `Notion integration вернула не утверждённый data source «${kind}»`);
  assertProperty(dataSource?.properties || {}, 'Name', { type: 'title' });
}

export function assertContextDataSources({ spheres, directions, projects }, config) {
  assertContextDataSource(spheres, config.spheresDataSourceId, 'Сферы');
  assertContextDataSource(directions, config.directionsDataSourceId, 'Направления');
  assertContextDataSource(projects, config.projectsDataSourceId, 'Проекты');
  const properties = projects?.properties || {};
  assertRelation(properties, '2.Направления', config.directionsDataSourceId, { limit: 1 });
  assertRelation(properties, '1.Cферы', config.spheresDataSourceId, { limit: 1 });
  return true;
}

export function assertCanaryFormulaOutputs(page, config) {
  invariant(normalizeId(page?.id) === normalizeId(config.authorizedCanaryMaterialPageId), 503,
    'wrong_canary_material', 'Formula preflight вернул не утверждённый canary material');
  invariant(page?.in_trash !== true && page?.archived !== true, 503, 'canary_material_inactive',
    'Canary material находится в корзине или архиве');
  invariant(normalizeId(page?.parent?.data_source_id || page?.parent?.database_id) === normalizeId(config.elementsDataSourceId),
    503, 'canary_material_outside_elements', 'Canary material находится вне утверждённой DS «Элементы»');
  const properties = page?.properties || {};
  invariant(properties['Тип']?.select?.name === 'Знание', 503, 'wrong_canary_material_type',
    'Canary material должен иметь Тип=Знание');
  const inside = properties['Внутри'];
  const insideIds = Array.isArray(inside?.relation) ? inside.relation.map((item) => normalizeId(item?.id)).filter(Boolean) : [];
  invariant(inside?.has_more !== true && insideIds.length === 1 &&
    insideIds[0] === normalizeId(config.authorizedCanaryTaskPageId), 503, 'wrong_canary_material_task',
  'Canary material должен быть связан ровно с утверждённой canary-задачей');
  const expectedTask = canonicalId(config.authorizedCanaryTaskPageId);
  const taskOutput = formulaString(properties[WIDGET_PROPERTY.taskPageId]);
  invariant(taskOutput === expectedTask, 503, 'wrong_task_page_id_formula_output',
    'Canary output формулы Task Page ID не совпадает с точной canary-задачей');
  const googleFileId = String((properties[WIDGET_PROPERTY.googleFileId]?.rich_text || [])
    .map((item) => item?.plain_text || item?.text?.content || '').join('')).trim();
  invariant(Boolean(googleFileId), 503, 'missing_canary_google_file_id',
    'В canary material отсутствует Google File ID для проверки формулы');
  invariant(formulaString(properties[WIDGET_PROPERTY.knowledgeKey]) === `${expectedTask}|g|${googleFileId}`, 503,
    'wrong_knowledge_key_formula_output', 'Canary output формулы Knowledge key не совпадает с утверждённым ключом');
  return true;
}
