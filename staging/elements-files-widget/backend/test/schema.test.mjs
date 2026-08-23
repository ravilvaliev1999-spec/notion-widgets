import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_MAIN } from '../lib/config.mjs';
import { P, recordProperties } from '../lib/records.mjs';
import {
  WIDGET_PROPERTY,
  WIDGET_SCHEMA_CONTRACT,
  assertAuthorizedDatabase,
  assertAuthorizedDataSource
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
  spheresDataSourceId: AUTHORIZED_MAIN.spheresDataSourceId,
  directionsDataSourceId: AUTHORIZED_MAIN.directionsDataSourceId,
  projectsDataSourceId: AUTHORIZED_MAIN.projectsDataSourceId
};

function relation(target) {
  return { type: 'relation', relation: { data_source_id: target } };
}

function property(expected) {
  if (expected.type === 'select') {
    return { type: 'select', select: { options: expected.options.map((name) => ({ name })) } };
  }
  return { type: expected.type, [expected.type]: {} };
}

function dataSource() {
  const properties = Object.fromEntries(Object.entries(WIDGET_SCHEMA_CONTRACT).map(([name, expected]) => [name, property(expected)]));
  Object.assign(properties, {
    'Внутри': relation(config.elementsDataSourceId),
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
