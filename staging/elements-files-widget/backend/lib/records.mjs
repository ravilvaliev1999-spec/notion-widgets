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

export const P = Object.freeze({
  title: 'Name',
  type: 'Тип',
  knowledgeFormat: 'Формат знания',
  archive: 'Архив',
  link: 'Ссылка',
  inside: 'Внутри',
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
  if ((url.protocol === 'https:' && url.port === '443')) url.port = '';
  return url.toString();
}

function maxPosition(rows, section) {
  return rows.filter((row) => row.section === section && row.status !== 'archived').reduce((max, row) => Math.max(max, Number(row.position || 0)), 0);
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

function findActiveLookupRecord(rows, taskId, dataSourceId) {
  const expectedTaskId = normalizeId(taskId);
  const expectedDataSourceId = normalizeId(dataSourceId);
  for (const page of rows) {
    const record = pageToRecord(page);
    const properties = page.properties || {};
    if (record.inTrash) continue;
    if (record.dataSourceId !== expectedDataSourceId) continue;
    if (propertySelect(properties[P.type]) !== 'Знание') continue;
    if (properties[P.archive]?.checkbox === true) continue;
    if (record.taskIds.length !== 1 || record.insideHasMore || record.taskId !== expectedTaskId) continue;
    if (INACTIVE_RECORD_STATUSES.has(String(record.status || '').toLowerCase())) continue;
    return record;
  }
  return null;
}

export function pageToRecord(page) {
  const p = page.properties || {};
  const inside = propertyRelation(p[P.inside]).map(normalizeId);
  const insideHasMore = p[P.inside]?.has_more === true;
  return {
    id: normalizeId(page.id),
    dataSourceId: pageParentDataSource(page),
    name: propertyText(p[P.title]),
    taskId: inside.length === 1 && !insideHasMore ? inside[0] : '',
    taskIds: inside,
    insideHasMore,
    inTrash: page.in_trash === true || page.archived === true,
    section: propertySelect(p[P.section]),
    format: propertySelect(p[P.fileFormat]),
    provider: propertySelect(p[P.provider]),
    googleFileId: propertyText(p[P.googleFileId]),
    googleFolderId: propertyText(p[P.googleFolderId]),
    position: propertyNumber(p[P.position]) || 0,
    status: propertySelect(p[P.syncStatus]),
    url: propertyText(p[P.normalizedUrl]),
    idempotencyKey: propertyText(p[P.idempotencyKey]),
    mimeType: propertyText(p[P.mimeType]),
    size: propertyNumber(p[P.size]),
    sha256: propertyText(p[P.sha256]),
    md5: propertyText(p[P.md5]),
    notionUrl: page.url,
    lastEditedTime: page.last_edited_time
  };
}

export function recordProperties(record) {
  return {
    [P.title]: titleValue(record.name),
    [P.type]: selectValue('Знание'),
    [P.knowledgeFormat]: selectValue(record.provider === 'External URL' ? 'Ссылка' : 'Файл'),
    [P.archive]: { checkbox: false },
    [P.link]: { url: record.url || null },
    [P.inside]: relationValue([record.taskId]),
    [P.section]: selectValue(record.section),
    [P.fileFormat]: selectValue(record.format),
    [P.provider]: selectValue(record.provider),
    [P.googleFileId]: richTextValue(record.googleFileId),
    [P.googleFolderId]: richTextValue(record.googleFolderId),
    [P.position]: { number: Number(record.position) },
    [P.syncStatus]: selectValue(record.status || 'synced'),
    [P.syncedAt]: dateValue(record.syncedAt || new Date()),
    [P.normalizedUrl]: richTextValue(record.url),
    [P.idempotencyKey]: richTextValue(record.idempotencyKey),
    [P.mimeType]: richTextValue(record.mimeType),
    [P.size]: { number: Number.isFinite(Number(record.size)) ? Number(record.size) : null },
    [P.sha256]: richTextValue(record.sha256),
    [P.md5]: richTextValue(record.md5)
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
    const records = rows.map(pageToRecord).filter((row) => !row.inTrash && row.taskId === normalizeId(taskId));
    return includeArchived ? records : records.filter((row) => row.status !== 'archived' && row.status !== 'unlinked' && row.status !== 'deleted');
  }

  async getForTask(taskId, recordId) {
    const page = await this.notion.retrievePage(recordId);
    const record = pageToRecord(page);
    invariant(!record.inTrash, 410, 'record_in_trash', 'Запись файла находится в корзине или архиве');
    invariant(record.dataSourceId === normalizeId(this.config.elementsDataSourceId), 404, 'record_not_found', 'Запись находится вне sandbox «Элементы»');
    invariant(record.taskIds.length === 1 && !record.insideHasMore, 409, 'ambiguous_record_placement', 'Запись файла должна быть связана ровно с одной задачей');
    invariant(record.taskId === normalizeId(taskId), 404, 'record_not_found', 'Файл не принадлежит этой задаче');
    invariant(propertySelect(page.properties && page.properties[P.type]) === 'Знание', 404, 'record_not_found', 'Запись файла некорректна');
    return record;
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
    return findActiveLookupRecord(rows, taskId, this.config.elementsDataSourceId);
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
    return findActiveLookupRecord(rows, taskId, this.config.elementsDataSourceId);
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
        syncedAt: new Date()
      };
      const page = await this.notion.createPage(this.config.elementsDataSourceId, recordProperties(record));
      return pageToRecord(page);
    })();
    this.inflight.set(operationKey, operation);
    try { return await operation; } finally { this.inflight.delete(operationKey); }
  }

  async patch(taskId, recordId, changes) {
    await this.getForTask(taskId, recordId);
    const properties = {};
    if (changes.name !== undefined) properties[P.title] = titleValue(changes.name);
    if (changes.type !== undefined) properties[P.type] = selectValue(changes.type);
    if (changes.archive !== undefined) properties[P.archive] = { checkbox: Boolean(changes.archive) };
    if (changes.position !== undefined) properties[P.position] = { number: Number(changes.position) };
    if (changes.status !== undefined) properties[P.syncStatus] = selectValue(changes.status);
    if (changes.section !== undefined) properties[P.section] = selectValue(changes.section);
    if (changes.format !== undefined) properties[P.fileFormat] = selectValue(changes.format);
    if (changes.taskId !== undefined) properties[P.inside] = relationValue(changes.taskId ? [changes.taskId] : []);
    if (changes.syncedAt !== undefined) properties[P.syncedAt] = dateValue(changes.syncedAt);
    if (changes.url !== undefined) {
      properties[P.normalizedUrl] = richTextValue(changes.url);
      properties[P.link] = { url: changes.url || null };
    }
    const page = await this.notion.updatePage(recordId, properties);
    return pageToRecord(page);
  }
}
