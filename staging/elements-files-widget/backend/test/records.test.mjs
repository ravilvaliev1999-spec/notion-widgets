import test from 'node:test';
import assert from 'node:assert/strict';
import { P, RecordRepository, classifyFile, normalizeExternalUrl, recordProperties } from '../lib/records.mjs';

const taskId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherTaskId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const dataSourceId = '33333333333333333333333333333333';
const otherDataSourceId = '44444444444444444444444444444444';

function richText(value) {
  return { rich_text: value ? [{ plain_text: value }] : [] };
}

function lookupPage({
  id = 'dddddddddddddddddddddddddddddddd',
  type = 'Знание',
  taskIds = [taskId],
  parentDataSourceId = dataSourceId,
  status = 'synced',
  archive = false,
  inTrash = false,
  insideHasMore = false,
  idempotencyKey = 'lookup-key-12345678',
  googleFileId = 'drive-file-shared',
  url = 'https://example.test/shared'
} = {}) {
  return {
    id,
    archived: false,
    in_trash: inTrash,
    parent: { type: 'data_source_id', data_source_id: parentDataSourceId },
    properties: {
      [P.title]: { title: [{ plain_text: 'Lookup candidate' }] },
      [P.type]: { select: { name: type } },
      [P.archive]: { checkbox: archive },
      [P.inside]: { relation: taskIds.map((value) => ({ id: value })), has_more: insideHasMore },
      [P.section]: { select: { name: 'Drive' } },
      [P.syncStatus]: { select: { name: status } },
      [P.idempotencyKey]: richText(idempotencyKey),
      [P.googleFileId]: richText(googleFileId),
      [P.normalizedUrl]: richText(url)
    }
  };
}

function assertActiveLookupQuery(body) {
  const filters = body.filter.and;
  assert.ok(filters.some((item) => item.property === P.type && item.select?.equals === 'Знание'));
  assert.ok(filters.some((item) => item.property === P.inside && item.relation?.contains === taskId));
  assert.ok(filters.some((item) => item.property === P.archive && item.checkbox?.equals === false));
  for (const status of ['archived', 'unlinked', 'deleted']) {
    assert.ok(filters.some((item) => item.property === P.syncStatus && item.select?.does_not_equal === status));
  }
}

test('Office and Google-native formats map to the four widget sections', () => {
  assert.deepEqual(classifyFile('report.docx'), { section: 'Docs', format: 'Word' });
  assert.deepEqual(classifyFile('budget.xlsx'), { section: 'Sheets', format: 'Excel' });
  assert.deepEqual(classifyFile('pitch.pptx'), { section: 'Slides', format: 'PowerPoint' });
  assert.deepEqual(classifyFile('notes.bin'), { section: 'Drive', format: 'Other File' });
  assert.deepEqual(classifyFile('Untitled', 'application/vnd.google-apps.document'), { section: 'Docs', format: 'Google Docs' });
});

test('external URLs are normalized and unsafe protocols are rejected', () => {
  assert.equal(normalizeExternalUrl('https://Example.com:443/a#fragment'), 'https://example.com/a');
  assert.throws(() => normalizeExternalUrl('http://example.com'), { code: 'unsafe_url' });
  assert.throws(() => normalizeExternalUrl('javascript:alert(1)'), { code: 'unsafe_url' });
});

test('widget record uses knowledge type and direct Inside relation only', () => {
  const properties = recordProperties({
    name: 'file.docx', taskId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', section: 'Docs', format: 'Word',
    provider: 'Google Drive', googleFileId: 'drive-id', googleFolderId: 'folder-id', position: 1,
    status: 'synced', url: 'https://drive.google.com/file/d/x', idempotencyKey: 'idem-12345678',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 12,
    sha256: 'a'.repeat(64), md5: 'b'.repeat(32), syncedAt: new Date('2026-08-22T00:00:00Z')
  });
  assert.equal(properties['Тип'].select.name, 'Знание');
  assert.equal(properties['Внутри'].relation[0].id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(properties['3. Проекты'], undefined);
  assert.equal(properties['Parent item'], undefined);
});

test('Task and Section rows with colliding keys never satisfy record dedup lookups', async () => {
  const queryBodies = [];
  const collisions = [
    lookupPage({ id: '11111111111111111111111111111111', type: 'Задача' }),
    lookupPage({ id: '22222222222222222222222222222222', type: 'Раздел' })
  ];
  const notion = {
    queryDataSource: async (_dataSource, body) => {
      queryBodies.push(body);
      return collisions;
    }
  };
  const repository = new RecordRepository({ elementsDataSourceId: dataSourceId }, notion);

  assert.equal(await repository.findByIdempotency(taskId, 'lookup-key-12345678'), null);
  assert.equal(await repository.findByUniqueKey(taskId, { googleFileId: 'drive-file-shared' }), null);
  assert.equal(queryBodies.length, 2);
  for (const body of queryBodies) assertActiveLookupQuery(body);
});

test('dedup post-filter accepts only one active Knowledge relation in the current data source and task', async () => {
  const active = lookupPage({ id: '99999999999999999999999999999999' });
  const candidates = [
    lookupPage({ id: '11111111111111111111111111111111', taskIds: [otherTaskId] }),
    lookupPage({ id: '22222222222222222222222222222222', taskIds: [taskId, otherTaskId] }),
    lookupPage({ id: '55555555555555555555555555555555', parentDataSourceId: otherDataSourceId }),
    lookupPage({ id: '66666666666666666666666666666666', inTrash: true }),
    lookupPage({ id: '77777777777777777777777777777777', status: 'unlinked' }),
    lookupPage({ id: '88888888888888888888888888888888', archive: true }),
    active
  ];
  const notion = { queryDataSource: async () => candidates };
  const repository = new RecordRepository({ elementsDataSourceId: dataSourceId }, notion);

  assert.equal((await repository.findByIdempotency(taskId, 'lookup-key-12345678')).id, active.id);
  assert.equal((await repository.findByUniqueKey(taskId, { url: 'https://example.test/shared' })).id, active.id);
});

test('re-adding an archived identity creates a new active row instead of reporting dedup success', async () => {
  const archived = lookupPage({
    id: '77777777777777777777777777777777',
    status: 'archived',
    archive: true
  });
  const createCalls = [];
  const notion = {
    queryDataSource: async () => [archived],
    createPage: async (actualDataSourceId, properties) => {
      createCalls.push({ actualDataSourceId, properties });
      return {
        id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        archived: false,
        in_trash: false,
        parent: { type: 'data_source_id', data_source_id: actualDataSourceId },
        properties
      };
    }
  };
  const repository = new RecordRepository({ elementsDataSourceId: dataSourceId }, notion);
  const created = await repository.create(taskId, {
    name: 'Shared link',
    section: 'Drive',
    format: 'Link',
    provider: 'External URL',
    googleFileId: '',
    googleFolderId: '',
    url: 'https://example.test/shared',
    mimeType: 'text/uri-list',
    size: null,
    md5: '',
    sha256: '',
    idempotencyKey: 'lookup-key-12345678'
  });

  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].actualDataSourceId, dataSourceId);
  assert.equal(createCalls[0].properties[P.type].select.name, 'Знание');
  assert.equal(createCalls[0].properties[P.archive].checkbox, false);
  assert.equal(createCalls[0].properties[P.syncStatus].select.name, 'synced');
  assert.equal(createCalls[0].properties[P.inside].relation[0].id, taskId);
  assert.equal(created.id, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(created.status, 'synced');
  assert.equal(created.taskId, taskId);
});
