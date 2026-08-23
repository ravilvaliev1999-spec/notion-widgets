import { randomUUID } from 'node:crypto';
import { AppError, invariant } from './errors.mjs';
import {
  dateValue,
  pageParentDataSource,
  propertyNumber,
  propertyRelation,
  propertySelect,
  propertyText,
  relationValue,
  richTextValue,
  selectValue,
  titleValue
} from './notion.mjs';
import { normalizeId } from './config.mjs';
import { WIDGET_PROPERTY } from './schema.mjs';

export const P = Object.freeze({
  title: 'Name',
  type: 'Тип',
  knowledgeFormat: 'Формат знания',
  archive: 'Архив',
  link: 'Ссылка',
  inside: 'Внутри',
  taskProjects: '3. Проекты',
  parentItem: 'Parent item',
  contextSphere: '[SYS] Контекст: Сфера',
  contextDirection: '[SYS] Контекст: Направление',
  contextProject: '[SYS] Контекст: Проект',
  contextPath: '[SYS] Context path',
  ancestorIds: '[SYS] Ancestor IDs',
  depth: '[SYS] Глубина',
  contextUpdatedAt: '[SYS] Контекст обновлён',
  ...WIDGET_PROPERTY
});

const FORMAT_BY_EXTENSION = Object.freeze({
  doc: ['Docs', 'Word'], docx: ['Docs', 'Word'], odt: ['Docs', 'Word'], rtf: ['Docs', 'Word'],
  xls: ['Sheets', 'Excel'], xlsx: ['Sheets', 'Excel'], xlsm: ['Sheets', 'Excel'], ods: ['Sheets', 'Excel'], csv: ['Sheets', 'CSV'], tsv: ['Sheets', 'CSV'],
  ppt: ['Slides', 'PowerPoint'], pptx: ['Slides', 'PowerPoint'], odp: ['Slides', 'PowerPoint']
});

const INACTIVE_RECORD_STATUSES = new Set(['archived', 'unlinked', 'deleted']);

export function classifyFile(name, mimeType = '') {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (FORMAT_BY_EXTENSION[ext]) return { section: FORMAT_BY_EXTENSION[ext][0], format: FORMAT_BY_EXTENSION[ext][1] };
  if (mimeType === 'application/vnd.google-apps.document') return { section: 'Docs', format: 'Google Docs' };
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return { section: 'Sheets', format: 'Google Sheets' };
  if (mimeType === 'application/vnd.google-apps.presentation') return { section: 'Slides', format: 'Google Slides' };
  return { section: 'Drive', format: 'Other File' };
}

export function normalizeExternalUrl(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { throw new AppError(422, 'invalid_url', 'Некорректная ссылка'); }
  invariant(url.protocol === 'https:', 422, 'unsafe_url', 'Разрешены только HTTPS-ссылки');
  url.hash = '';
  url.username = '';
  url.password = '';
  if (url.port === '443') url.port = '';
  return url.toString();
}

function maxPosition(rows, section) {
  return rows.filter((row) => row.section === section && !INACTIVE_RECORD_STATUSES.has(row.status))
    .reduce((max, row) => Math.max(max, Number(row.position || 0)), 0);
}

function activeLookupFilters(taskId) {
  return [
    { property: P.type, select: { equals: 'Знание' } },
    { property: P.inside, relation: { contains: normalizeId(taskId) } },
    { property: P.archive, checkbox: { equals: false } },
    ...[...INACTIVE_RECORD_STATUSES].map((status) => ({
      property: P.syncStatus,
      select: { does_not_equal: status }
    }))
  ];
}

function activeLookupRecords(rows, taskId, dataSourceId) {
  const expectedTaskId = normalizeId(taskId);
  const expectedDataSourceId = normalizeId(dataSourceId);
  return rows.map(pageToRecord).filter((record) =>
    !record.inTrash &&
    record.dataSourceId === expectedDataSourceId &&
    record.type === 'Знание' &&
    record.archived !== true &&
    record.taskIds.length === 1 &&
    !record.insideHasMore &&
    record.taskId === expectedTaskId &&
    !INACTIVE_RECORD_STATUSES.has(String(record.status || '').toLowerCase())
  );
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function pageToRecord(page) {
  const p = page.properties || {};
  const inside = propertyRelation(p[P.inside]).map(normalizeId);
  const insideHasMore = p[P.inside]?.has_more === true;
  return {
    id: normalizeId(page.id),
    dataSourceId: pageParentDataSource(page),
    name: propertyText(p[P.title]),
    type: propertySelect(p[P.type]),
    archived: p[P.archive]?.checkbox === true,
    taskId: inside.length === 1 && !insideHasMore ? inside[0] : '',
    taskIds: inside,
    insideHasMore,
    inTrash: page.in_trash === true || page.archived === true,
    section: propertySelect(p[P.section]),
    format: propertySelect(p[P.fileFormat]),
    provider: propertySelect(p[P.provider]),
    googleFileId: propertyText(p[P.googleFileId]),
    googleFolderId: propertyText(p[P.googleFolderId]),
    downloadName: propertyText(p[P.downloadName]),
    position: propertyNumber(p[P.position]) || 0,
    status: propertySelect(p[P.syncStatus]),
    syncError: propertyText(p[P.syncError]),
    integrity: propertySelect(p[P.integrity]),
    url: propertyText(p[P.normalizedUrl]),
    idempotencyKey: propertyText(p[P.idempotencyKey]),
    mimeType: propertyText(p[P.mimeType]),
    size: propertyNumber(p[P.size]),
    sha256: propertyText(p[P.sha256]),
    md5: propertyText(p[P.md5]),
    context: {
      sphereId: propertyRelation(p[P.contextSphere]).map(normalizeId)[0] || '',
      directionId: propertyRelation(p[P.contextDirection]).map(normalizeId)[0] || '',
      projectId: propertyRelation(p[P.contextProject]).map(normalizeId)[0] || '',
      path: propertyText(p[P.contextPath]),
      ancestorIds: propertyText(p[P.ancestorIds]),
      depth: propertyNumber(p[P.depth]) || 0
    },
    notionUrl: page.url,
    lastEditedTime: page.last_edited_time
  };
}

export function recordProperties(record) {
  const context = record.context || {};
  return {
    [P.title]: titleValue(record.name),
    [P.type]: selectValue('Знание'),
    [P.knowledgeFormat]: selectValue(record.provider === 'External URL' ? 'Ссылка' : 'Файл'),
    [P.archive]: { checkbox: Boolean(record.archived) },
    [P.link]: { url: record.url || null },
    [P.inside]: relationValue([record.taskId]),
    [P.contextSphere]: relationValue(context.sphereId ? [context.sphereId] : []),
    [P.contextDirection]: relationValue(context.directionId ? [context.directionId] : []),
    [P.contextProject]: relationValue(context.projectId ? [context.projectId] : []),
    [P.contextPath]: richTextValue(context.path || ''),
    [P.ancestorIds]: richTextValue(context.ancestorIds || '[]'),
    [P.depth]: { number: finiteNumber(context.depth) || 0 },
    [P.contextUpdatedAt]: dateValue(context.updatedAt || new Date()),
    [P.section]: selectValue(record.section),
    [P.fileFormat]: selectValue(record.format),
    [P.provider]: selectValue(record.provider),
    [P.googleFileId]: richTextValue(record.googleFileId),
    [P.googleFolderId]: richTextValue(record.googleFolderId),
    [P.mimeType]: richTextValue(record.mimeType),
    [P.downloadName]: richTextValue(record.downloadName || record.name),
    [P.size]: { number: finiteNumber(record.size) },
    [P.sha256]: richTextValue(record.sha256),
    [P.md5]: richTextValue(record.md5),
    [P.position]: { number: finiteNumber(record.position) || 0 },
    [P.syncStatus]: selectValue(record.status || 'synced'),
    [P.syncedAt]: dateValue(record.syncedAt || new Date()),
    [P.syncError]: richTextValue(record.syncError || ''),
    [P.normalizedUrl]: richTextValue(record.url),
    [P.idempotencyKey]: richTextValue(record.idempotencyKey),
    [P.integrity]: selectValue(record.integrity || 'ok')
  };
}

export class RecordRepository {
  constructor(config, notion) {
    this.config = config;
    this.notion = notion;
    this.inflight = new Map();
  }

  async listForTask(taskId, includeArchived = false) {
    const rows = await this.notion.queryDataSource(this.config.elementsDataSourceId, {
      filter: {
        and: [
          { property: P.type, select: { equals: 'Знание' } },
          { property: P.inside, relation: { contains: normalizeId(taskId) } },
          { property: P.section, select: { is_not_empty: true } }
        ]
      },
      sorts: [{ property: P.position, direction: 'ascending' }]
    });
    const records = rows.map(pageToRecord).filter((row) =>
      !row.inTrash && row.taskIds.length === 1 && !row.insideHasMore && row.taskId === normalizeId(taskId));
    return includeArchived ? records : records.filter((row) =>
      !row.archived && !INACTIVE_RECORD_STATUSES.has(String(row.status || '').toLowerCase()));
  }

  async listGoogleDriveForTask(taskId, includeArchived = false) {
    const rows = await this.notion.queryDataSource(this.config.elementsDataSourceId, {
      filter: {
        and: [
          { property: P.type, select: { equals: 'Знание' } },
          { property: P.inside, relation: { contains: normalizeId(taskId) } },
          { property: P.provider, select: { equals: 'Google Drive' } },
          { property: P.googleFileId, rich_text: { is_not_empty: true } }
        ]
      },
      sorts: [{ property: P.position, direction: 'ascending' }]
    });
    const records = rows.map(pageToRecord).filter((row) =>
      !row.inTrash && row.dataSourceId === normalizeId(this.config.elementsDataSourceId) &&
      row.type === 'Знание' && row.provider === 'Google Drive' && row.googleFileId &&
      row.taskIds.length === 1 && !row.insideHasMore && row.taskId === normalizeId(taskId));
    return includeArchived ? records : records.filter((row) =>
      !row.archived && !INACTIVE_RECORD_STATUSES.has(String(row.status || '').toLowerCase()));
  }

  async getForTask(taskId, recordId) {
    const page = await this.notion.retrievePage(recordId);
    const record = pageToRecord(page);
    invariant(!record.inTrash, 410, 'record_in_trash', 'Запись файла находится в корзине или архиве');
    invariant(record.dataSourceId === normalizeId(this.config.elementsDataSourceId), 404, 'record_not_found',
      'Запись находится вне утверждённой main DS «Элементы»');
    invariant(record.taskIds.length === 1 && !record.insideHasMore, 409, 'ambiguous_record_placement',
      'Запись файла должна быть связана ровно с одной задачей');
    invariant(record.taskId === normalizeId(taskId), 404, 'record_not_found', 'Файл не принадлежит этой задаче');
    invariant(record.type === 'Знание', 404, 'record_not_found', 'Запись файла некорректна');
    return record;
  }

  async uniqueActive(rows, taskId) {
    const records = activeLookupRecords(rows, taskId, this.config.elementsDataSourceId);
    if (records.length > 1) {
      await Promise.allSettled(records.map((record) => this.patch(taskId, record.id, {
        integrity: 'duplicate',
        syncError: 'duplicate_widget_identity'
      })));
      throw new AppError(409, 'duplicate_widget_records', 'Обнаружены дубли материалов; записи сохранены и помечены для проверки');
    }
    return records[0] || null;
  }

  async findByIdempotency(taskId, key) {
    const rows = await this.notion.queryDataSource(this.config.elementsDataSourceId, {
      filter: {
        and: [
          ...activeLookupFilters(taskId),
          { property: P.idempotencyKey, rich_text: { equals: String(key) } }
        ]
      }
    });
    return this.uniqueActive(rows, taskId);
  }

  async findByUniqueKey(taskId, input) {
    const identity = input.googleFileId
      ? { property: P.googleFileId, rich_text: { equals: String(input.googleFileId) } }
      : input.url
        ? { property: P.normalizedUrl, rich_text: { equals: String(input.url) } }
        : null;
    if (!identity) return null;
    const rows = await this.notion.queryDataSource(this.config.elementsDataSourceId, {
      filter: { and: [...activeLookupFilters(taskId), identity] }
    });
    return this.uniqueActive(rows, taskId);
  }

  async create(taskId, input) {
    const key = String(input.idempotencyKey || randomUUID());
    const operationKey = normalizeId(taskId) + ':' + key;
    if (this.inflight.has(operationKey)) return this.inflight.get(operationKey);
    const operation = (async () => {
      const existing = await this.findByIdempotency(taskId, key);
      if (existing) return existing;
      const duplicate = await this.findByUniqueKey(taskId, input);
      if (duplicate) return duplicate;
      const current = await this.listForTask(taskId, true);
      const record = {
        ...input,
        taskId: normalizeId(taskId),
        idempotencyKey: key,
        position: input.position || maxPosition(current, input.section) + 1,
        status: input.status || 'synced',
        integrity: input.integrity || 'ok',
        syncError: input.syncError || '',
        syncedAt: new Date()
      };
      const page = await this.notion.createPage(this.config.elementsDataSourceId, recordProperties(record));
      const created = pageToRecord(page);
      await this.findByUniqueKey(taskId, input);
      return created;
    })();
    this.inflight.set(operationKey, operation);
    try { return await operation; } finally { this.inflight.delete(operationKey); }
  }

  async patch(taskId, recordId, changes) {
    await this.getForTask(taskId, recordId);
    const properties = {};
    if (changes.name !== undefined) properties[P.title] = titleValue(changes.name);
    if (changes.archive !== undefined) properties[P.archive] = { checkbox: Boolean(changes.archive) };
    if (changes.position !== undefined) properties[P.position] = { number: finiteNumber(changes.position) };
    if (changes.status !== undefined) properties[P.syncStatus] = selectValue(changes.status);
    if (changes.section !== undefined) properties[P.section] = selectValue(changes.section);
    if (changes.format !== undefined) properties[P.fileFormat] = selectValue(changes.format);
    if (changes.provider !== undefined) properties[P.provider] = selectValue(changes.provider);
    if (changes.googleFileId !== undefined) properties[P.googleFileId] = richTextValue(changes.googleFileId);
    if (changes.googleFolderId !== undefined) properties[P.googleFolderId] = richTextValue(changes.googleFolderId);
    if (changes.mimeType !== undefined) properties[P.mimeType] = richTextValue(changes.mimeType);
    if (changes.downloadName !== undefined) properties[P.downloadName] = richTextValue(changes.downloadName);
    if (changes.size !== undefined) properties[P.size] = { number: finiteNumber(changes.size) };
    if (changes.sha256 !== undefined) properties[P.sha256] = richTextValue(changes.sha256);
    if (changes.md5 !== undefined) properties[P.md5] = richTextValue(changes.md5);
    if (changes.syncedAt !== undefined) properties[P.syncedAt] = dateValue(changes.syncedAt);
    if (changes.syncError !== undefined) properties[P.syncError] = richTextValue(changes.syncError);
    if (changes.integrity !== undefined) properties[P.integrity] = selectValue(changes.integrity);
    if (changes.url !== undefined) {
      properties[P.normalizedUrl] = richTextValue(changes.url);
      properties[P.link] = { url: changes.url || null };
    }
    const page = await this.notion.updatePage(recordId, properties);
    return pageToRecord(page);
  }

  async markTaskIntegrity(taskId, integrity, syncError = '') {
    return this.notion.updatePage(normalizeId(taskId), {
      [P.integrity]: selectValue(integrity),
      [P.syncError]: richTextValue(syncError)
    });
  }
}
