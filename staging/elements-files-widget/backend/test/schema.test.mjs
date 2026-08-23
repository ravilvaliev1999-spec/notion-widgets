import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_MAIN } from '../lib/config.mjs';
import { P, recordProperties } from '../lib/records.mjs';
import {
  ELEMENTS_RUNTIME_SCHEMA_CONTRACT,
  FORMULA_EXPRESSIONS,
  WIDGET_PROPERTY,
  WIDGET_SCHEMA_CONTRACT,
  assertAuthorizedDatabase,
  assertAuthorizedDataSource,
  assertCanaryFormulaOutputs,
  assertContextDataSources,
  formulasExposeExpressions
} from '../lib/schema.mjs';

const REQUIRED = [
  '[SYS] Раздел виджета', '[SYS] Формат файла', '[SYS] Провайдер', '[SYS] Google File ID',
  '[SYS] Google Folder ID', '[SYS] MIME type', '[SYS] Download name', '[SYS] Размер байт',
  '[SYS] SHA-256', '[SYS] Drive MD5', '[SYS] Позиция', '[SYS] Sync status',
  '[SYS] Последняя синхронизация', '[SYS] Ошибка sync', '[SYS] Normalized URL',
  '[SYS] Idempotency key', '[SYS] Task Page ID', '[SYS] Knowledge key', '[SYS] Integrity'
];

const config = {
  authorizedElementsDatabaseId: AUTHORIZED_MAIN.elementsDatabaseId,
  elementsDataSourceId: AUTHORIZED_MAIN.elementsDataSourceId,
  authorizedCanaryTaskPageId: AUTHORIZED_MAIN.canaryTaskPageId,
  authorizedCanaryMaterialPageId: AUTHORIZED_MAIN.canaryMaterialPageId,
  spheresDataSourceId: AUTHORIZED_MAIN.spheresDataSourceId,
  directionsDataSourceId: AUTHORIZED_MAIN.directionsDataSourceId,
  projectsDataSourceId: AUTHORIZED_MAIN.projectsDataSourceId
};

function relation(target, limit) {
  return { type: 'relation', relation: { data_source_id: target, ...(limit ? { max_items: limit } : {}) } };
}

function property(expected) {
  if (expected.type === 'select') {
    return { type: 'select', select: { options: (expected.options || expected.requiredOptions).map((name) => ({ name })) } };
  }
  return { type: expected.type, [expected.type]: {} };
}

function dataSource() {
  const contracts = { ...WIDGET_SCHEMA_CONTRACT, ...ELEMENTS_RUNTIME_SCHEMA_CONTRACT };
  const properties = Object.fromEntries(Object.entries(contracts).map(([name, expected]) => [name, property(expected)]));
  Object.assign(properties, {
    'Внутри': relation(config.elementsDataSourceId),
    '3. Проекты': relation(config.projectsDataSourceId),
    'Parent item': relation(config.elementsDataSourceId, 1),
    'Знание: Сфера': relation(config.spheresDataSourceId),
    'Знание: Направление': relation(config.directionsDataSourceId),
    'Знание: Проект': relation(config.projectsDataSourceId),
    '[SYS] Контекст: Сфера': relation(config.spheresDataSourceId),
    '[SYS] Контекст: Направление': relation(config.directionsDataSourceId),
    '[SYS] Контекст: Проект': relation(config.projectsDataSourceId)
  });
  return {
    id: config.elementsDataSourceId,
    parent: { type: 'database_id', database_id: config.authorizedElementsDatabaseId },
    properties
  };
}

function contextDataSources() {
  return {
    spheres: { id: config.spheresDataSourceId, properties: { Name: { type: 'title', title: {} } } },
    directions: { id: config.directionsDataSourceId, properties: { Name: { type: 'title', title: {} } } },
    projects: {
      id: config.projectsDataSourceId,
      properties: {
        Name: { type: 'title', title: {} },
        '2.Направления': relation(config.directionsDataSourceId, 1),
        '1.Cферы': relation(config.spheresDataSourceId, 1)
      }
    }
  };
}

function formulaProperty(value) {
  return { type: 'formula', formula: { type: 'string', string: value } };
}

test('runtime contract is an independent exact 19-field contract', () => {
  assert.deepEqual(Object.values(WIDGET_PROPERTY), REQUIRED);
  assert.deepEqual(Object.keys(WIDGET_SCHEMA_CONTRACT), REQUIRED);
  assert.equal(Object.keys(WIDGET_SCHEMA_CONTRACT).length, 19);
  assert.deepEqual(WIDGET_SCHEMA_CONTRACT[P.fileFormat].options,
    ['Google Docs', 'Word', 'Google Sheets', 'Excel', 'CSV', 'Google Slides', 'PowerPoint', 'Link', 'Other File']);
  assert.deepEqual(WIDGET_SCHEMA_CONTRACT[P.integrity].options, ['ok', 'duplicate', 'context_error', 'sync_error']);
});

test('authorized database and full data source schema pass', () => {
  assert.equal(assertAuthorizedDatabase({
    id: config.authorizedElementsDatabaseId,
    data_sources: [{ id: config.elementsDataSourceId }]
  }, config), true);
  assert.equal(assertAuthorizedDataSource(dataSource(), config), true);
  assert.equal(assertContextDataSources(contextDataSources(), config), true);
});

test('every core/context field used by runtime is preflighted independently', () => {
  for (const name of Object.keys(ELEMENTS_RUNTIME_SCHEMA_CONTRACT)) {
    const missing = dataSource();
    delete missing.properties[name];
    assert.throws(() => assertAuthorizedDataSource(missing, config), { code: 'missing_widget_schema_property' }, name);
  }
  for (const name of ['Внутри', '3. Проекты', 'Parent item', '[SYS] Контекст: Сфера', '[SYS] Контекст: Направление', '[SYS] Контекст: Проект']) {
    const wrong = dataSource();
    wrong.properties[name] = relation('f'.repeat(32));
    assert.throws(() => assertAuthorizedDataSource(wrong, config), { code: 'wrong_relation_target' }, name);
  }
});

test('resolver data sources and mixed-script project relation names fail closed', () => {
  for (const key of ['spheres', 'directions', 'projects']) {
    const sources = contextDataSources();
    sources[key].id = 'f'.repeat(32);
    assert.throws(() => assertContextDataSources(sources, config), { code: 'wrong_context_data_source' }, key);
  }
  for (const name of ['2.Направления', '1.Cферы']) {
    const sources = contextDataSources();
    delete sources.projects.properties[name];
    assert.throws(() => assertContextDataSources(sources, config), { code: 'wrong_relation_schema' }, name);
  }
  for (const [exact, alias] of [['2.Направления', '2. Направления'], ['1.Cферы', '1.Сферы']]) {
    const sources = contextDataSources();
    sources.projects.properties[alias] = sources.projects.properties[exact];
    delete sources.projects.properties[exact];
    assert.throws(() => assertContextDataSources(sources, config), { code: 'wrong_relation_schema' }, alias);
  }
  const elements = dataSource();
  elements.properties['3.Проекты'] = elements.properties['3. Проекты'];
  delete elements.properties['3. Проекты'];
  assert.throws(() => assertAuthorizedDataSource(elements, config), { code: 'wrong_relation_schema' });
});

test('formula expressions are exact when API exposes them', () => {
  const source = dataSource();
  for (const [name, expression] of Object.entries(FORMULA_EXPRESSIONS)) source.properties[name].formula.expression = expression;
  assert.equal(formulasExposeExpressions(source), true);
  assert.equal(assertAuthorizedDataSource(source, config), true);
  source.properties[P.knowledgeKey].formula.expression += ' + "corrupt"';
  assert.throws(() => assertAuthorizedDataSource(source, config), { code: 'wrong_formula_expression' });
});

test('canary formula fallback verifies one exact material and both exact outputs', () => {
  const task = '3ae2d627-39a1-80ad-b49c-e028699b75d9';
  const googleFileId = 'drive-canary-file';
  const page = {
    id: AUTHORIZED_MAIN.canaryMaterialPageId,
    parent: { data_source_id: config.elementsDataSourceId },
    properties: {
      'Тип': { select: { name: 'Знание' } },
      'Внутри': { relation: [{ id: config.authorizedCanaryTaskPageId }], has_more: false },
      [P.googleFileId]: { rich_text: [{ plain_text: googleFileId }] },
      [P.taskPageId]: formulaProperty(task),
      [P.knowledgeKey]: formulaProperty(`${task}|g|${googleFileId}`)
    }
  };
  assert.equal(assertCanaryFormulaOutputs(page, config), true);
  page.properties[P.knowledgeKey] = formulaProperty('wrong');
  assert.throws(() => assertCanaryFormulaOutputs(page, config), { code: 'wrong_knowledge_key_formula_output' });
});

test('every missing or wrong widget field fails closed', () => {
  for (const name of REQUIRED) {
    const missing = dataSource();
    delete missing.properties[name];
    assert.throws(() => assertAuthorizedDataSource(missing, config), { code: 'missing_widget_schema_property' }, name);

    const wrong = dataSource();
    wrong.properties[name] = { type: 'url', url: {} };
    assert.throws(() => assertAuthorizedDataSource(wrong, config), { code: 'wrong_widget_schema_type' }, name);
  }
});

test('select options are exact and formula fields are never written', () => {
  const wrong = dataSource();
  wrong.properties[P.integrity].select.options.push({ name: 'legacy' });
  assert.throws(() => assertAuthorizedDataSource(wrong, config), { code: 'wrong_widget_schema_options' });

  const payload = recordProperties({
    name: 'report.docx', taskId: AUTHORIZED_MAIN.canaryTaskPageId, section: 'Docs', format: 'Word',
    provider: 'Google Drive', googleFileId: 'drive-file', googleFolderId: 'folder', downloadName: 'original.docx',
    url: 'https://drive.google.com/file/d/x', mimeType: 'application/octet-stream', size: 1,
    sha256: 'a'.repeat(64), md5: 'b'.repeat(32), position: 1, status: 'synced',
    idempotencyKey: 'idem-12345678', integrity: 'ok', context: {}
  });
  assert.equal(payload[P.taskPageId], undefined);
  assert.equal(payload[P.knowledgeKey], undefined);
  assert.equal(payload[P.downloadName].rich_text[0].text.content, 'original.docx');
});
