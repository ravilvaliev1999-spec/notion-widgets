import { asIssue, invariant, MigrationError } from './errors.mjs';
import { normalizeNotionId } from './ids.mjs';

export const PROPERTY = Object.freeze({
  title: 'Name',
  type: 'Тип',
  knowledgeFormat: 'Формат знания',
  inside: 'Внутри',
  project: 'Знание: Проект',
  direction: 'Знание: Направление',
  sphere: 'Знание: Сфера',
  archived: 'Архив',
  link: 'Ссылка',
  section: '[SYS] Раздел виджета',
  fileFormat: '[SYS] Формат файла',
  provider: '[SYS] Провайдер',
  googleFileId: '[SYS] Google File ID',
  googleFolderId: '[SYS] Google Folder ID',
  position: '[SYS] Позиция',
  syncStatus: '[SYS] Sync status',
  syncedAt: '[SYS] Последняя синхронизация',
  normalizedUrl: '[SYS] Normalized URL',
  idempotencyKey: '[SYS] Idempotency key',
  mimeType: '[SYS] MIME type',
  size: '[SYS] Размер байт',
  sha256: '[SYS] SHA-256',
  md5: '[SYS] Drive MD5'
});

export const ELEMENTS_SCHEMA_CONTRACT = Object.freeze({
  [PROPERTY.title]: { type: 'title' },
  // Inbox is represented by an empty value, not by another select option.
  [PROPERTY.type]: { type: 'select', options: ['Задача', 'Знание', 'Раздел'], exactOptions: true },
  [PROPERTY.knowledgeFormat]: { type: 'select', options: ['Файл', 'Ссылка'] },
  [PROPERTY.inside]: { type: 'relation', selfRelation: true },
  [PROPERTY.project]: { type: 'relation' },
  [PROPERTY.direction]: { type: 'relation' },
  [PROPERTY.sphere]: { type: 'relation' },
  [PROPERTY.archived]: { type: 'checkbox' },
  [PROPERTY.link]: { type: 'url' },
  [PROPERTY.section]: { type: 'select', options: ['Drive', 'Docs', 'Sheets', 'Slides'] },
  [PROPERTY.fileFormat]: { type: 'select' },
  [PROPERTY.provider]: { type: 'select', options: ['Google Drive', 'External URL', 'Notion'] },
  [PROPERTY.googleFileId]: { type: 'rich_text' },
  [PROPERTY.googleFolderId]: { type: 'rich_text' },
  [PROPERTY.position]: { type: 'number' },
  [PROPERTY.syncStatus]: {
    type: 'select',
    options: ['pending', 'synced', 'error', 'archived', 'unlinked', 'deleted', 'needs_review']
  },
  [PROPERTY.syncedAt]: { type: 'date' },
  [PROPERTY.normalizedUrl]: { type: 'rich_text' },
  [PROPERTY.idempotencyKey]: { type: 'rich_text' },
  [PROPERTY.mimeType]: { type: 'rich_text' },
  [PROPERTY.size]: { type: 'number' },
  [PROPERTY.sha256]: { type: 'rich_text' },
  [PROPERTY.md5]: { type: 'rich_text' }
});

function optionNames(property) {
  const raw = property && property.options;
  return Array.isArray(raw)
    ? raw.map((entry) => typeof entry === 'string' ? entry : entry && entry.name).filter(Boolean)
    : [];
}

function validateProperty(schema, name, expected, targetDataSourceId) {
  const actual = schema.properties && schema.properties[name];
  invariant(actual, 'missing_schema_property', `В «Элементы» отсутствует свойство «${name}»`, { property: name });
  invariant(actual.type === expected.type, 'wrong_schema_type', `Свойство «${name}» должно иметь тип ${expected.type}`, {
    property: name,
    expected: expected.type,
    actual: actual.type
  });
  if (expected.options) {
    const actualOptions = new Set(optionNames(actual));
    const missing = expected.options.filter((option) => !actualOptions.has(option));
    invariant(missing.length === 0, 'missing_schema_options', `Свойство «${name}» не содержит обязательные варианты`, {
      property: name,
      missing
    });
    if (expected.exactOptions) {
      const expectedOptions = new Set(expected.options);
      const unexpected = [...actualOptions].filter((option) => !expectedOptions.has(option));
      invariant(unexpected.length === 0, 'unexpected_schema_options',
        `Свойство «${name}» содержит запрещённые варианты`, {
          property: name,
          unexpected
        });
    }
  }
  if (expected.selfRelation) {
    const relationTarget = normalizeNotionId(actual.dataSourceId, `${name}.dataSourceId`);
    invariant(relationTarget === targetDataSourceId, 'wrong_relation_target', '«Внутри» должна быть self-relation на «Элементы»', {
      expected: targetDataSourceId,
      actual: relationTarget
    });
  }
}

export function auditElementsSchema(schema, expectedDataSourceId) {
  const issues = [];
  try {
    invariant(schema && typeof schema === 'object', 'missing_target_schema', 'Не передана схема «Элементы»');
    const expectedId = normalizeNotionId(expectedDataSourceId, 'ELEMENTS_DATA_SOURCE_ID');
    const schemaId = normalizeNotionId(schema.dataSourceId, 'schema.dataSourceId');
    invariant(schemaId === expectedId, 'wrong_schema_data_source', 'Проверяется не sandbox data source «Элементы»', {
      expected: expectedId,
      actual: schemaId
    });
    for (const [name, contract] of Object.entries(ELEMENTS_SCHEMA_CONTRACT)) {
      try {
        validateProperty(schema, name, contract, expectedId);
      } catch (error) {
        issues.push(asIssue(error));
      }
    }
  } catch (error) {
    issues.push(asIssue(error));
  }
  return Object.freeze({ ok: issues.length === 0, issues });
}

export function assertElementsSchema(schema, expectedDataSourceId) {
  const audit = auditElementsSchema(schema, expectedDataSourceId);
  if (!audit.ok) throw new MigrationError('schema_audit_failed', 'Схема «Элементы» не прошла аудит', audit.issues);
  return true;
}
