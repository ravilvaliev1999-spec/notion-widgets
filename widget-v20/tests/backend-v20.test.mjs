import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = fs.readFileSync(path.join(root, 'Core.js'), 'utf8');
const backendSource = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
const registrySource = fs.readFileSync(path.join(root, 'Registry.gs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));

function loadCore() {
  const context = vm.createContext({ Object, String, RegExp, Error, Number, Boolean, Math, encodeURIComponent, decodeURIComponent });
  vm.runInContext(coreSource, context, { filename: 'Core.js' });
  return context.WidgetV19Core;
}

function loadBackend(activeEmail = '') {
  const core = loadCore();
  const context = vm.createContext({
    Object,
    String,
    RegExp,
    Error,
    Number,
    Boolean,
    Math,
    Date,
    JSON,
    Array,
    isFinite,
    encodeURIComponent,
    console: { log() {} },
    WidgetV19Core: core,
    Session: { getActiveUser: () => ({ getEmail: () => activeEmail }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      newBlob: (value) => ({ getBytes: () => [...Buffer.from(String(value), 'utf8')] }),
      computeDigest: (_algorithm, bytes) => [...crypto.createHash('sha256').update(Buffer.from(bytes)).digest()],
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', String(key)).update(String(value)).digest()]
    }
  });
  vm.runInContext(backendSource, context, { filename: 'Code.gs' });
  vm.runInContext(registrySource, context, { filename: 'Registry.gs' });
  return context;
}

test('Google Drive metadata is authoritative for title, type and canonical open URL', () => {
  const core = loadCore();
  const doc = core.describeGoogleMetadata({
    id: 'ABCDEFGHIJKL',
    name: 'Истинное имя документа',
    mimeType: 'application/vnd.google-apps.document',
    webViewLink: 'https://docs.google.com/document/d/ABCDEFGHIJKL/edit'
  }, 'https://drive.google.com/open?id=ABCDEFGHIJKL');
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), {
    id: 'ABCDEFGHIJKL',
    name: 'Истинное имя документа',
    mimeType: 'application/vnd.google-apps.document',
    section: 'Docs',
    format: 'Google Docs',
    provider: 'Google Drive',
    knowledgeFormat: 'Файл',
    sourceUrl: 'https://docs.google.com/document/d/ABCDEFGHIJKL/edit',
    normalizedUrl: 'https://docs.google.com/document/d/ABCDEFGHIJKL/edit',
    size: null,
    driveMd5: ''
  });

  const word = core.describeGoogleMetadata({
    id: 'MNOPQRSTUVWX',
    name: 'Техническое задание.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: '2048',
    md5Checksum: 'abc',
    webViewLink: 'https://docs.google.com/document/d/MNOPQRSTUVWX/edit'
  });
  assert.equal(word.section, 'Docs');
  assert.equal(word.format, 'Word');
  assert.equal(word.size, 2048);
  assert.equal(word.driveMd5, 'abc');

  const excel = core.describeGoogleMetadata({
    id: 'EXCELFILE123',
    name: 'Финансы.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    webViewLink: 'https://docs.google.com/spreadsheets/d/EXCELFILE123/edit'
  });
  assert.equal(excel.section, 'Sheets');
  assert.equal(excel.format, 'Excel');

  const powerPoint = core.describeGoogleMetadata({
    id: 'POWERPOINT123',
    name: 'Презентация.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    webViewLink: 'https://docs.google.com/presentation/d/POWERPOINT123/edit'
  });
  assert.equal(powerPoint.section, 'Slides');
  assert.equal(powerPoint.format, 'PowerPoint');
});

test('Google folders fall back to a real folder URL and stay in Drive', () => {
  const core = loadCore();
  const folder = core.describeGoogleMetadata({
    id: 'ABCDEFGHIJKL',
    name: 'Проект',
    mimeType: 'application/vnd.google-apps.folder'
  });
  assert.equal(folder.section, 'Drive');
  assert.equal(folder.sourceUrl, 'https://drive.google.com/drive/folders/ABCDEFGHIJKL');
});

test('capability auth requires both the stored hash and the exact authorized task', () => {
  const token = 'capability_token_0123456789_ABCDEFGH';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const task = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const cfg = {
    allowedEmail: 'owner@example.com',
    accessTokenHash: tokenHash,
    authorizedTaskPageId: task
  };
  const anonymous = loadBackend('');
  assert.equal(anonymous.w19AssertViewer_(cfg, { taskPageId: task, accessToken: token }), 'capability');
  assert.throws(
    () => anonymous.w19AssertViewer_(cfg, { taskPageId: '3ae2d627-39a1-80ad-b49c-e028699b75d9', accessToken: token }),
    (error) => error && error.code === 'AUTH_REQUIRED'
  );
  assert.throws(
    () => anonymous.w19AssertViewer_(cfg, { taskPageId: task, accessToken: 'wrong_token_0123456789_ABCDEFGHIJ' }),
    (error) => error && error.code === 'AUTH_REQUIRED'
  );
});

test('confirmed owner identity remains an independent authorization path', () => {
  const owner = loadBackend('owner@example.com');
  assert.equal(owner.w19AssertViewer_({ allowedEmail: 'owner@example.com' }, {}), 'owner');
});

test('every public data API authenticates the same input payload', () => {
  for (const name of [
    'apiBootstrap', 'apiCreateGoogle', 'apiAddLink', 'apiUpload', 'apiUpdateMaterial',
    'apiReorder', 'apiDeletePhysical', 'apiPrepareDownload', 'apiDownload', 'apiPollDriveMetadata', 'apiSyncTask', 'w19SetArchiveState_'
  ]) {
    const start = backendSource.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    const next = backendSource.indexOf('\nfunction ', start + 10);
    const body = backendSource.slice(start, next === -1 ? backendSource.length : next);
    assert.match(body, /w19AuthorizedConfig_\(input\)/, `${name} must authenticate input`);
  }
  assert.match(backendSource, /taskMatches\s*&&\s*tokenMatches/);
  assert.doesNotMatch(backendSource, /w19Audit_\([^\n]+accessToken/);
});

test('web app routes download requests to a dedicated top-level courier', () => {
  const doGet = backendSource.slice(backendSource.indexOf('function doGet'), backendSource.indexOf('/* ========================= Public client API'));
  assert.match(doGet, /event && event\.parameter/);
  assert.match(doGet, /params\.downloadPageId \|\| params\.downloadTicket/);
  assert.match(doGet, /createTemplateFromFile\('Download'\)/);
  assert.match(doGet, /template\.runtimeParamsJson = JSON\.stringify/);
  assert.match(doGet, /task:\s*String\(params\.task \|\| params\.taskPageId/);
  assert.match(doGet, /downloadPageId:\s*String\(params\.downloadPageId/);
  assert.match(doGet, /output = template\.evaluate\(\)/);
  assert.match(doGet, /createHtmlOutputFromFile\('Index'\)/);
  assert.match(doGet, /XFrameOptionsMode\.ALLOWALL/);
});

test('bootstrap returns the current deployment URL instead of hard-coding one', () => {
  const bootstrap = backendSource.slice(backendSource.indexOf('function apiBootstrap'), backendSource.indexOf('function apiCreateGoogle'));
  assert.match(bootstrap, /serviceUrl:\s*ScriptApp\.getService\(\)\.getUrl\(\)/);
  assert.doesNotMatch(bootstrap, /script\.google\.com\/macros\/s\//);
});

test('bootstrap falls back to the durable registry only for transient Notion transport failures', () => {
  const backend = loadBackend();
  const cfg = { authorizedTaskPageId: '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e', deniedPageIds: {} };
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w19AssertSchema_ = () => { throw new backend.W19Error_('GOOGLE_URLFETCH_QUOTA', 'quota', true); };
  backend.w20BootstrapFromRegistry_ = (_input, receivedCfg, reason) => ({ degraded: true, code: reason.code, sameCfg: receivedCfg === cfg });
  const fallback = backend.apiBootstrap({ taskPageId: cfg.authorizedTaskPageId });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.data.degraded, true);
  assert.equal(fallback.data.code, 'GOOGLE_URLFETCH_QUOTA');
  assert.equal(fallback.data.sameCfg, true);

  backend.w19AssertSchema_ = () => { throw new backend.W19Error_('NOTION_FORBIDDEN', 'forbidden', false); };
  const forbidden = backend.apiBootstrap({ taskPageId: cfg.authorizedTaskPageId });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'NOTION_FORBIDDEN');
});

test('scheduled sync rejects browser calls that are neither owner nor the installed trigger', () => {
  const scheduled = backendSource.slice(backendSource.indexOf('function scheduledSync'), backendSource.indexOf('function w19ClaimScheduledSync_'));
  const guard = backendSource.slice(backendSource.indexOf('function w19AssertScheduledInvocation_'), backendSource.indexOf('/* ========================= Authorization/config'));
  assert.match(scheduled, /w19AssertScheduledInvocation_\(cfg, event\)/);
  assert.match(guard, /event && event\.triggerUid/);
  assert.match(guard, /trigger\.getHandlerFunction\(\) === 'scheduledSync'/);
  assert.match(guard, /trigger\.getUniqueId\(\)/);
});

test('background rename trigger uses a five-minute cadence to stay below shared API limits', () => {
  const installer = backendSource.slice(backendSource.indexOf('function adminInstallSyncTrigger'), backendSource.indexOf('function scheduledSync'));
  assert.match(installer, /everyMinutes\(5\)\.create\(\)/);
  assert.doesNotMatch(installer, /everyMinutes\(1\)/);
});

test('five-second Drive metadata poll authenticates without reading or writing Notion', () => {
  const poll = backendSource.slice(backendSource.indexOf('function apiPollDriveMetadata'), backendSource.indexOf('function apiSyncTask'));
  assert.match(poll, /w19AuthorizedConfig_\(input\)/);
  assert.match(poll, /taskId !== cfg\.authorizedTaskPageId/);
  assert.match(poll, /w20DrivePollClaimStatus_/);
  assert.match(poll, /w19GetDriveMetadata_\(googleFileId\)/);
  assert.ok(poll.indexOf('w20DrivePollClaimStatus_') < poll.indexOf('w19GetDriveMetadata_'));
  assert.doesNotMatch(poll, /w19NotionRequest_|w19AssertTaskPage_|w19AssertMaterialForTask_|w19QueryTaskMaterials_/);
});

test('signed Drive poll makes zero Notion calls when metadata is unchanged and one PATCH after a rename', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
  const fileId = 'NativeGoogleDoc123';
  const cfg = { authorizedTaskPageId: taskId, deniedPageIds: {}, notionToken: 'server-only-signing-secret' };
  const row = {
    pageId, googleFileId:fileId,
    currentName:'Исходное имя',
    currentOpenUrl:`https://docs.google.com/document/d/${fileId}/edit`,
    currentFormat:'Google Docs',currentSection:'Docs',currentMimeType:'application/vnd.google-apps.document',
    currentSize:null,currentDriveMd5:'',currentDownloadName:'Исходное имя',
    currentNormalizedUrl:`https://docs.google.com/document/d/${fileId}/edit`
  };
  row.claim = backend.w20IssueDrivePollClaim_(taskId, pageId, fileId, row, cfg);
  backend.w19AuthorizedConfig_ = () => cfg;
  let driveName = 'Исходное имя';
  backend.w19GetDriveMetadata_ = () => ({
    id: fileId,
    name: driveName,
    mimeType: 'application/vnd.google-apps.document',
    webViewLink: `https://docs.google.com/document/d/${fileId}/edit`,trashed:false
  });
  let patches = 0;
  backend.w19UpdateNotionPage_ = () => { patches += 1; throw new Error('unchanged poll must not PATCH Notion'); };
  const unchanged = backend.apiPollDriveMetadata({taskPageId:taskId,materials:[row]});
  assert.equal(unchanged.ok, true);
  assert.equal(patches, 0);
  assert.equal(unchanged.data.materials[0].name, 'Исходное имя');

  driveName = 'Новое имя';
  let patchedProperties = null;
  backend.w19WithMutationLock_ = (fn) => fn();
  backend.w19UpdateNotionPage_ = (_id, properties) => { patches += 1;patchedProperties=properties;return {}; };
  backend.w19MaterialFromPage_ = () => ({id:pageId,name:driveName,section:'Docs',format:'Google Docs',provider:'Google Drive',openUrl:row.currentOpenUrl,googleFileId:fileId,mimeType:row.currentMimeType,size:null,driveMd5:'',downloadName:driveName,normalizedUrl:row.currentNormalizedUrl,syncStatus:'synced',integrity:'ok'});
  const changed = backend.apiPollDriveMetadata({taskPageId:taskId,materials:[row]});
  assert.equal(changed.ok, true);
  assert.equal(patches, 1);
  assert.ok(patchedProperties.Name);
  assert.ok(patchedProperties['[SYS] Download name']);
  assert.ok(patchedProperties['[SYS] Последняя синхронизация']);
  assert.equal(changed.data.materials[0].name, 'Новое имя');
});

test('every Notion request reserves a global slot and releases its lock before UrlFetch', () => {
  const backend = loadBackend();
  const events = [];
  const values = new Map();
  backend.Date = { now: () => 1000 };
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: (timeout) => { events.push(`lock:${timeout}`); return true; },
      releaseLock: () => events.push('release')
    })
  };
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => { events.push('cache:get'); return values.get(key) ?? null; },
      put: (key, value, ttl) => { events.push(`cache:put:${ttl}`); values.set(key, value); }
    })
  };
  backend.Utilities.sleep = (ms) => events.push(`sleep:${ms}`);
  backend.UrlFetchApp = {
    fetch: () => {
      events.push('fetch');
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    }
  };

  const result = backend.w19NotionRequest_('get', '/v1/users/me', null, {
    notionToken: 'secret-not-logged',
    notionVersion: '2026-03-11'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ['lock:5000', 'cache:get', 'cache:put:120', 'release', 'fetch']);
});

test('Notion request slots enforce at least 350 ms between outbound attempts', () => {
  const backend = loadBackend();
  const values = new Map();
  const reservations = [];
  const sleeps = [];
  let now = 1000;
  let releases = 0;
  backend.Date = { now: () => now };
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { releases += 1; }
    })
  };
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => values.get(key) ?? null,
      put: (key, value) => {
        values.set(key, value);
        reservations.push(Number(value));
      }
    })
  };
  backend.Utilities.sleep = (ms) => {
    sleeps.push(ms);
    now += ms;
  };

  backend.w19ReserveNotionRequestSlot_();
  now += 10;
  backend.w19ReserveNotionRequestSlot_();

  assert.deepEqual(reservations, [1000, 1350]);
  assert.deepEqual(sleeps, [340]);
  assert.ok(reservations[1] - reservations[0] >= 350);
  assert.equal(releases, 2);
});

test('Notion rate limiter always releases an acquired lock and fails retryably on lock contention', () => {
  const backend = loadBackend();
  let releases = 0;
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { releases += 1; }
    })
  };
  backend.CacheService = {
    getScriptCache: () => ({ get: () => { throw new Error('cache unavailable'); } })
  };
  assert.throws(() => backend.w19ReserveNotionRequestSlot_(), /cache unavailable/);
  assert.equal(releases, 1);

  let requestedTimeout = null;
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: (timeout) => { requestedTimeout = timeout; return false; },
      releaseLock: () => { throw new Error('must not release an unacquired lock'); }
    })
  };
  assert.throws(
    () => backend.w19ReserveNotionRequestSlot_(),
    (error) => error && error.code === 'NOTION_RATE_LIMIT_BUSY' && error.retryable === true
  );
  assert.equal(requestedTimeout, 5000);
});

test('daily Apps Script UrlFetch exhaustion is reported immediately and retry delays are capped', () => {
  const exhausted = loadBackend();
  exhausted.w19ReserveNotionRequestSlot_ = () => {};
  exhausted.Utilities.sleep = () => { throw new Error('daily quota errors must not be retried'); };
  exhausted.UrlFetchApp = {
    fetch: () => { throw new Error('Service invoked too many times for one day: urlfetch.'); }
  };
  assert.throws(
    () => exhausted.w19NotionRequest_('get', '/v1/users/me', null, { notionToken: 'secret', notionVersion: '2026-03-11' }),
    (error) => error && error.code === 'GOOGLE_URLFETCH_QUOTA' && error.retryable === true
  );

  const throttled = loadBackend();
  const sleeps = [];
  let calls = 0;
  throttled.w19ReserveNotionRequestSlot_ = () => {};
  throttled.Utilities.sleep = (ms) => sleeps.push(ms);
  throttled.UrlFetchApp = {
    fetch: () => {
      calls += 1;
      if (calls === 1) return {
        getResponseCode: () => 429,
        getContentText: () => '{"code":"rate_limited"}',
        getHeaders: () => ({ 'Retry-After': '99999' })
      };
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    }
  };
  assert.equal(throttled.w19NotionRequest_('get', '/v1/users/me', null, { notionToken: 'secret', notionVersion: '2026-03-11' }).ok, true);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 5000 && sleeps[0] < 5250);
});

test('linked Google files use Drive metadata instead of a caller-supplied label', () => {
  const addLink = backendSource.slice(backendSource.indexOf('function apiAddLink'), backendSource.indexOf('function apiUpload'));
  assert.match(addLink, /w19ResolveGoogleLink_\(googleFileId, normalized\)/);
  assert.match(addLink, /name:\s*linkData\.name/);
  assert.match(addLink, /mimeType:\s*linkData\.mimeType/);
  assert.match(addLink, /sourceUrl:\s*linkData\.sourceUrl/);
  assert.match(addLink, /GOOGLE_LINK_NOT_ACCESSIBLE|w19ResolveGoogleLink_/);
});

test('binary uploads are sent to Notion as a single-part file upload', () => {
  const backend = loadBackend();
  const uploadId = '43833259-72ae-404e-8441-b6577f3159b4';
  const uploadUrl = `https://api.notion.com/v1/file_uploads/${uploadId}/send`;
  const calls = [];
  backend.w19NotionRequest_ = (method, requestPath, body) => {
    calls.push({ kind: 'create', method, requestPath, body });
    return { object: 'file_upload', id: uploadId, status: 'pending', upload_url: uploadUrl };
  };
  backend.UrlFetchApp = {
    fetch: (url, options) => {
      calls.push({ kind: 'send', url, options });
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ object: 'file_upload', id: uploadId, status: 'uploaded' })
      };
    }
  };

  const result = backend.w19CreateAndSendNotionUpload_([1, 2, 3], 'application/pdf', 'brief.pdf', {
    notionToken: 'secret-not-logged',
    notionVersion: '2026-03-11'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { id: uploadId, name: 'brief.pdf', mimeType: 'application/pdf' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
    mode: 'single_part',
    filename: 'brief.pdf',
    content_type: 'application/pdf'
  });
  assert.equal(calls[1].url, uploadUrl);
  assert.ok(calls[1].options.payload.file);
  assert.equal(Object.hasOwn(calls[1].options, 'contentType'), false, 'Apps Script must generate the multipart boundary');
});

test('uncertain Notion send responses are checked before the upload is resent', () => {
  const backend = loadBackend();
  const uploadId = '43833259-72ae-404e-8441-b6577f3159b4';
  let statusChecks = 0;
  backend.w19NotionRequest_ = (method, requestPath) => {
    if (method === 'post' && requestPath === '/v1/file_uploads') {
      return {
        object: 'file_upload',
        id: uploadId,
        status: 'pending',
        upload_url: `https://api.notion.com/v1/file_uploads/${uploadId}/send`
      };
    }
    if (method === 'get' && requestPath === `/v1/file_uploads/${uploadId}`) {
      statusChecks += 1;
      return { object: 'file_upload', id: uploadId, status: 'uploaded' };
    }
    throw new Error(`unexpected request: ${method} ${requestPath}`);
  };
  backend.UrlFetchApp = { fetch: () => { throw new Error('connection reset after send'); } };

  const result = backend.w19CreateAndSendNotionUpload_([1, 2, 3], 'application/pdf', 'brief.pdf', {
    notionToken: 'secret-not-logged',
    notionVersion: '2026-03-11'
  });

  assert.equal(result.id, uploadId);
  assert.equal(statusChecks, 1);
});

test('effective upload limit follows the workspace plan and is cached', () => {
  const backend = loadBackend();
  const cacheValues = new Map();
  let meRequests = 0;
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => cacheValues.get(key) ?? null,
      put: (key, value) => cacheValues.set(key, value)
    })
  };
  backend.w19NotionRequest_ = (method, requestPath) => {
    assert.equal(method, 'get');
    assert.equal(requestPath, '/v1/users/me');
    meRequests += 1;
    return { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5 * 1024 * 1024 } } };
  };
  const cfg = {
    maxUploadBytes: 20 * 1024 * 1024,
    dataSourceId: '3822d627-39a1-8018-a2dc-000b95bf5722',
    notionVersion: '2026-03-11'
  };

  assert.equal(backend.w19EffectiveUploadLimit_(cfg), 5 * 1024 * 1024);
  assert.equal(backend.w19EffectiveUploadLimit_(cfg), 5 * 1024 * 1024);
  assert.equal(meRequests, 1);
});

test('download authorization cache stores only short-lived server-derived ownership coordinates', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const dataSourceId = '3822d627-39a1-8018-a2dc-000b95bf5722';
  const values = new Map();
  const writes = [];
  let now = 1_800_000_000_000;
  backend.Date = { now: () => now };
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => values.get(key) ?? null,
      putAll: (entries, ttl) => {
        writes.push({ entries, ttl });
        Object.entries(entries).forEach(([key, value]) => values.set(key, value));
      },
      remove: (key) => values.delete(key)
    })
  };
  const page = {
    id: pageId,
    in_trash: false,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      Name: { title: [{ plain_text: 'Файл.docx' }] },
      'Тип': { select: { name: 'Знание' } },
      'Внутри': { relation: [{ id: taskId }] },
      'Архив': { checkbox: false },
      'Ссылка': { url: 'https://drive.google.com/file/d/1OwnedBinaryFile123/view' },
      'Вложения': { files: [{
        name: 'Файл.docx',
        type: 'file',
        file: { url: 'https://signed-storage.example/private?secret=must-not-be-cached' }
      }] },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'Google Drive' } },
      '[SYS] Google File ID': { rich_text: [{ plain_text: '1OwnedBinaryFile123' }] },
      '[SYS] Google Folder ID': { rich_text: [{ plain_text: '1OwnedTaskFolder123' }] }
    }
  };
  const cfg = { dataSourceId, deniedPageIds: {}, notionToken: 'notion-secret-must-not-be-cached' };

  assert.equal(backend.w20CacheDownloadMaterials_(taskId, [page], cfg), 1);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].ttl > 0 && writes[0].ttl <= 120);
  assert.equal(values.size, 1);
  const [[key, raw]] = [...values.entries()];
  assert.doesNotMatch(key, new RegExp(taskId.replaceAll('-', ''), 'i'));
  assert.doesNotMatch(key, new RegExp(pageId.replaceAll('-', ''), 'i'));
  assert.doesNotMatch(raw, /notion-secret|signed-storage|must-not-be-cached|accessToken|downloadUrl|attachment/i);
  assert.deepEqual(
    JSON.parse(JSON.stringify(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg))),
    {
      id: pageId,
      provider: 'Google Drive',
      googleFileId: '1OwnedBinaryFile123',
      folderId: '1OwnedTaskFolder123'
    }
  );
  const validEntry = JSON.parse(raw);
  values.set(key, JSON.stringify({ ...validEntry, googleFileId: '../client-controlled' }));
  assert.equal(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg), null);
  values.set(key, JSON.stringify({ ...validEntry, dataSourceId: '3822d62739a18018a2dc000b95bf5723' }));
  assert.equal(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg), null);
  values.set(key, raw);
  assert.equal(backend.w20GetCachedDownloadMaterial_('3c62d627-39a1-80a1-aac7-ec19ffc9ef8f', pageId, cfg), null);
  now += writes[0].ttl * 1000 + 1;
  assert.equal(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg), null);
});

test('download cache refuses archived, cross-task, cross-source, denied and Google-native records', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const otherTaskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8f';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const dataSourceId = '3822d627-39a1-8018-a2dc-000b95bf5722';
  const base = {
    id: pageId,
    in_trash: false,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      'Тип': { select: { name: 'Знание' } },
      'Внутри': { relation: [{ id: taskId }] },
      'Архив': { checkbox: false },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'Google Drive' } },
      '[SYS] Google File ID': { rich_text: [{ plain_text: '1OwnedBinaryFile123' }] },
      '[SYS] Google Folder ID': { rich_text: [{ plain_text: '1OwnedTaskFolder123' }] }
    }
  };
  const clone = () => structuredClone(base);
  const cfg = { dataSourceId, deniedPageIds: {} };
  assert.ok(backend.w20DownloadCacheEntryFromPage_(taskId, clone(), cfg, Date.now()));

  const archived = clone();
  archived.properties['Архив'].checkbox = true;
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, archived, cfg, Date.now()), null);

  const crossTask = clone();
  crossTask.properties['Внутри'].relation = [{ id: otherTaskId }];
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, crossTask, cfg, Date.now()), null);

  const crossSource = clone();
  crossSource.parent.data_source_id = '3822d627-39a1-8018-a2dc-000b95bf5723';
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, crossSource, cfg, Date.now()), null);

  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, clone(), {
    dataSourceId,
    deniedPageIds: { [pageId]: true }
  }, Date.now()), null);

  const native = clone();
  native.properties['[SYS] Формат файла'].select.name = 'Google Docs';
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, native, cfg, Date.now()), null);

  const values = new Map();
  backend.CacheService = {
    getScriptCache: () => ({
      putAll: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
      removeAll: (keys) => keys.forEach((key) => values.delete(key))
    })
  };
  assert.equal(backend.w20CacheDownloadMaterials_(taskId, [clone()], cfg), 1);
  assert.equal(values.size, 1);
  assert.equal(backend.w20CacheDownloadMaterials_(taskId, [archived], cfg), 0);
  assert.equal(values.size, 0);
});

test('download cache hit skips the material Notion GET but still runs the full Drive ownership guard', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = {
    dataSourceId: '3822d627-39a1-8018-a2dc-000b95bf5722',
    maxUploadBytes: 1024,
    deniedPageIds: {}
  };
  const cached = { id: pageId, provider: 'Google Drive', googleFileId: '1OwnedBinaryFile123', folderId: '1OwnedTaskFolder123' };
  let guardCalls = 0;
  let taskAssertions = 0;
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w19AssertTaskPage_ = () => { taskAssertions += 1; throw new Error('task Notion GET must be skipped on a cache hit'); };
  backend.w20GetCachedDownloadMaterial_ = () => cached;
  backend.w19AssertMaterialForTask_ = () => { throw new Error('material Notion GET must be skipped on a cache hit'); };
  backend.w19AssertOwnedBinary_ = (material, task, receivedCfg) => {
    guardCalls += 1;
    assert.equal(material, cached);
    assert.equal(task.id, taskId);
    assert.equal(receivedCfg, cfg);
    return { id: '1OwnedBinaryFile123', name: 'Файл.docx', mimeType: 'application/octet-stream' };
  };
  backend.w19DriveRetry_ = (fn) => fn();
  backend.DriveApp = { getFileById: () => ({ getBlob: () => ({ getBytes: () => [1, 2, 3] }) }) };
  backend.Utilities.base64Encode = (bytes) => Buffer.from(bytes).toString('base64');

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, true);
  assert.equal(taskAssertions, 0);
  assert.equal(guardCalls, 1);
  assert.equal(result.data.base64, 'AQID');
});

test('download cache miss can recover server-owned provenance from private Drive appProperties without Notion', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = { maxUploadBytes: 1024, deniedPageIds: {} };
  const recovered = { id: pageId, provider: 'Google Drive', googleFileId: '1OwnedBinaryFile123', folderId: '1OwnedTaskFolder123' };
  let taskAssertions = 0;
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FindOwnedBinaryMaterialByMarkers_ = () => recovered;
  backend.w19AssertTaskPage_ = () => { taskAssertions += 1; throw new Error('Notion must not be needed for marked Drive files'); };
  backend.w19AssertMaterialForTask_ = () => { throw new Error('Notion material assertion must be skipped'); };
  backend.w19AssertOwnedBinary_ = (material) => {
    assert.equal(material, recovered);
    return { id: recovered.googleFileId, name: 'Файл.docx', mimeType: 'application/octet-stream' };
  };
  backend.w19DriveRetry_ = (fn) => fn();
  backend.DriveApp = { getFileById: () => ({ getBlob: () => ({ getBytes: () => [5, 6] }) }) };
  backend.Utilities.base64Encode = (bytes) => Buffer.from(bytes).toString('base64');

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, true);
  assert.equal(taskAssertions, 0);
  assert.equal(result.data.base64, 'BQY=');
});

test('archived Drive markers revoke stale courier links without a Notion lookup', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  const compactPage = backend.WidgetV19Core.compactUuid(pageId);
  backend.w19AssertRootFolder_ = () => ({ id: 'RootFolder123' });
  backend.w19DriveRetry_ = (fn) => fn();
  backend.Drive = {
    Files: {
      list: () => ({ files: [{
        id: 'OwnedBinary123',
        name: 'Архив.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: '10',
        trashed: false,
        parents: ['TaskFolder123'],
        appProperties: {
          widgetVersion: 'v20',
          taskPageId: compactTask,
          notionPageId: compactPage,
          materialState: 'archived'
        }
      }] })
    }
  };
  backend.w19GetDriveMetadata_ = () => {
    throw new Error('revoked files must be rejected before folder traversal');
  };

  const recovered = backend.w20FindOwnedBinaryMaterialByMarkers_(taskId, pageId, { deniedPageIds: {} });
  assert.equal(recovered, null);
});

test('archive and restore state is persisted in the private Drive marker', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  const compactPage = backend.WidgetV19Core.compactUuid(pageId);
  const material = { id: pageId, widgetOwned: true, googleFileId: 'OwnedBinary123' };
  const writes = [];
  backend.w19GetDriveMetadata_ = () => ({
    id: 'OwnedBinary123',
    appProperties: {
      widgetVersion: 'v20',
      taskPageId: compactTask,
      notionPageId: compactPage,
      widgetIdem: 'kept'
    }
  });
  backend.w19DriveRetry_ = (fn) => fn();
  backend.Drive = {
    Files: {
      update: (resource, fileId) => {
        writes.push({ resource, fileId });
        return { id: fileId, appProperties: resource.appProperties };
      }
    }
  };

  backend.w20SetDriveMaterialState_(material, taskId, 'archived');
  backend.w20SetDriveMaterialState_(material, taskId, 'active');

  assert.deepEqual(writes.map((entry) => entry.resource.appProperties.materialState), ['archived', 'active']);
  assert.ok(writes.every((entry) => entry.resource.appProperties.widgetIdem === 'kept'));
  assert.ok(writes.every((entry) => entry.fileId === 'OwnedBinary123'));
});

test('late idempotency marker repair never reactivates a revoked file', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  let written = null;
  backend.w19DriveRetry_ = (fn) => fn();
  backend.Drive = {
    Files: {
      update: (resource) => {
        written = resource.appProperties;
        return { id: 'OwnedBinary123', appProperties: written };
      }
    }
  };
  const drive = {
    id: 'OwnedBinary123',
    appProperties: { widgetVersion: 'v20', taskPageId: compactTask, materialState: 'archived' }
  };

  backend.w19MarkDriveNotionPage_(drive, taskId, 'idem', pageId, 'active');

  assert.equal(written.materialState, 'archived');
  assert.equal(written.notionPageId, backend.WidgetV19Core.compactUuid(pageId));
});

test('download cache miss falls back to the authoritative Notion material assertion', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = { maxUploadBytes: 1024, deniedPageIds: {} };
  let taskAssertions = 0;
  let materialAssertions = 0;
  const material = { id: pageId, provider: 'Google Drive', googleFileId: '1OwnedBinaryFile123', folderId: '1OwnedTaskFolder123' };
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w19AssertTaskPage_ = () => { taskAssertions += 1; return { id: taskId, name: 'Задача' }; };
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FindOwnedBinaryMaterialByMarkers_ = () => null;
  backend.w19AssertMaterialForTask_ = () => { materialAssertions += 1; return { id: pageId }; };
  backend.w19MaterialFromPage_ = () => material;
  backend.w19AssertOwnedBinary_ = () => ({ id: '1OwnedBinaryFile123', name: 'Файл.docx', mimeType: 'application/octet-stream' });
  backend.w19DriveRetry_ = (fn) => fn();
  backend.DriveApp = { getFileById: () => ({ getBlob: () => ({ getBytes: () => [4] }) }) };
  backend.Utilities.base64Encode = (bytes) => Buffer.from(bytes).toString('base64');

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, true);
  assert.equal(taskAssertions, 1);
  assert.equal(materialAssertions, 1);
});

test('download cache miss fails closed when authoritative Notion ownership rejects the material', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = { maxUploadBytes: 1024, deniedPageIds: {} };
  let guardCalls = 0;
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FindOwnedBinaryMaterialByMarkers_ = () => null;
  backend.w19AssertTaskPage_ = () => ({ id: taskId, name: 'Задача' });
  backend.w19AssertMaterialForTask_ = () => {
    throw new backend.W19Error_('MATERIAL_TASK_MISMATCH', 'Материал не принадлежит этой задаче.', false);
  };
  backend.w19AssertOwnedBinary_ = () => { guardCalls += 1; throw new Error('Drive guard must not run after Notion rejection'); };

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MATERIAL_TASK_MISMATCH');
  assert.equal(guardCalls, 0);
});

test('durable fallback registry keeps only safe server-derived card metadata and supports replacement cleanup', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const values = new Map([['NOTION_TOKEN', 'must-remain-unread']]);
  backend.PropertiesService = {
    getScriptProperties: () => ({
      getProperties: () => Object.fromEntries(values),
      setProperty: (key, value) => values.set(key, value),
      setProperties: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
      deleteProperty: (key) => values.delete(key)
    })
  };
  const material = {
    id: pageId,
    name: 'Файл.docx',
    section: 'Docs',
    format: 'Word',
    provider: 'Google Drive',
    openUrl: 'https://drive.google.com/file/d/1OwnedBinaryFile123/view',
    attachmentUrl: 'https://signed.example/secret',
    accessToken: 'must-not-persist',
    googleFileId: '1OwnedBinaryFile123',
    folderId: '1OwnedTaskFolder123',
    widgetOwnedBinary: true,
    mimeType: 'application/octet-stream',
    size: 2,
    position: 1,
    syncStatus: 'synced'
  };
  assert.equal(backend.w20RegistryReplaceTask_(taskId, [material]), 1);
  const registryEntries = [...values.entries()].filter(([key]) => key.startsWith('w20:material-registry:'));
  assert.equal(registryEntries.length, 1);
  assert.doesNotMatch(registryEntries[0][1], /must-not-persist|signed\.example|attachmentUrl|accessToken|NOTION_TOKEN/);
  const restored = backend.w20RegistryReadTask_(taskId, null);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, pageId);
  assert.equal(restored[0].canDownload, true);
  assert.equal(restored[0].downloadUrl, null);
  assert.equal(backend.w20RegistryReplaceTask_(taskId, []), 0);
  assert.equal(backend.w20RegistryReadTask_(taskId, null).length, 0);
  assert.equal(values.get('NOTION_TOKEN'), 'must-remain-unread');
});

test('material parser prefers the fresh Notion-hosted file URL for downloads', () => {
  const backend = loadBackend();
  const signedUrl = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/file.docx?signature=fresh';
  const material = backend.w19MaterialFromPage_({
    id: '3c72d627-39a1-81e1-971f-c6b30665ce55',
    url: 'https://notion.so/example',
    properties: {
      Name: { title: [{ plain_text: 'Файл.docx' }] },
      'Ссылка': { url: 'https://drive.google.com/file/d/1FsC0H5uqBpE6bXDXN0oaDHtig4xkuhKm/view' },
      'Вложения': { files: [{
        name: 'Файл.docx',
        type: 'file',
        file: { url: signedUrl, expiry_time: '2026-08-25T20:00:00.000Z' }
      }] },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'Google Drive' } },
      '[SYS] Google File ID': { rich_text: [{ plain_text: '1FsC0H5uqBpE6bXDXN0oaDHtig4xkuhKm' }] },
      '[SYS] Google Folder ID': { rich_text: [{ plain_text: '1UBwsBgiAzmm9L5t53KlXqS3Axv8KRFXO' }] }
    }
  });

  assert.equal(material.downloadUrl, signedUrl);
  assert.equal(material.canDownload, true);
  assert.equal(material.hostedAttachment, true);
  assert.equal(material.attachmentType, 'file');
  assert.equal(material.attachmentName, 'Файл.docx');
  assert.equal(material.attachmentExpiry, '2026-08-25T20:00:00.000Z');
});

test('hosted URLs are not exposed for unrelated materials', () => {
  const backend = loadBackend();
  const material = backend.w19MaterialFromPage_({
    id: '3c72d627-39a1-81e1-971f-c6b30665ce55',
    properties: {
      Name: { title: [{ plain_text: 'Чужой файл' }] },
      'Вложения': { files: [{ name: 'unrelated.docx', type: 'file', file: { url: 'https://files.example/unrelated.docx' } }] },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'External URL' } }
    }
  });
  assert.equal(material.downloadUrl, null);
  assert.equal(material.canDownload, false);
  assert.equal(material.hostedAttachment, false);
});

test('hosted Notion attachments are attached on creation and preserved during Drive sync', () => {
  const upload = backendSource.slice(backendSource.indexOf('function apiUpload'), backendSource.indexOf('function apiUpdateMaterial'));
  const create = backendSource.slice(backendSource.indexOf('function w19CreateNotionMaterial_'), backendSource.indexOf('function w19AppendContextProperties_'));
  const sync = backendSource.slice(backendSource.indexOf('function w19SyncOnePageUnlocked_'), backendSource.indexOf('function w19MarkSyncError_'));
  assert.match(upload, /w19CreateAndSendNotionUpload_\(bytes/);
  assert.match(upload, /type:\s*'file_upload'/);
  assert.match(upload, /file_upload:\s*\{\s*id:\s*notionUpload\.id\s*\}/);
  assert.match(upload, /var outcome = w19WithIdempotency_/);
  assert.doesNotMatch(upload, /w19AssertMaterialForTask_\(outcome\.material\.id/);
  assert.match(upload, /pageForDownloadCache = page/);
  assert.match(upload, /w20CacheDownloadMaterials_\(task\.id, \[pageForDownloadCache\], cfg\)/);
  assert.match(create, /Array\.isArray\(data\.attachments\)/);
  assert.match(sync, /driveData\.sourceUrl\s*&&\s*!material\.widgetOwnedBinary\s*&&\s*!material\.hostedAttachment/);
});

test('next position reads only the highest active position in the requested section', () => {
  const backend = loadBackend();
  let request;
  backend.w19NotionRequest_ = (method, requestPath, body, cfg) => {
    request={method,requestPath,body,cfg};
    return {results:[{properties:{'[SYS] Позиция':{number:7}}}]};
  };
  const cfg={dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722'};
  assert.equal(backend.w19NextPosition_('3c62d627-39a1-80a1-aac7-ec19ffc9ef8e','Docs',cfg),8);
  assert.equal(request.method,'post');
  assert.equal(request.body.page_size,1);
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.sorts)),[
    {property:'[SYS] Позиция',direction:'descending'},
    {timestamp:'created_time',direction:'descending'}
  ]);
  assert.equal(request.body.filter.and[3].select.equals,'Docs');
  assert.equal(request.body.filter.and[2].checkbox.equals,false);
});

test('bootstrap metadata sync is a no-op when Drive metadata did not change', () => {
  const sync = backendSource.slice(backendSource.indexOf('function w19SyncOnePageUnlocked_'), backendSource.indexOf('function w19MarkSyncError_'));
  assert.match(sync, /if \(!Object\.keys\(props\)\.length\) return page;/);
  assert.ok(sync.indexOf('if (!Object.keys(props).length) return page;') < sync.indexOf('props[W19_P.LAST_SYNC]'));
  assert.match(sync, /nameChanged/);
  assert.match(sync, /driveData\.name !== material\.downloadName/);
});

test('download API is restricted to widget-owned binary files below the configured limit', () => {
  const download = backendSource.slice(backendSource.indexOf('function apiDownload'), backendSource.indexOf('function apiSyncTask'));
  const guard = backendSource.slice(backendSource.indexOf('function w19AssertOwnedBinary_'), backendSource.indexOf('function w19IsDriveNotFound_'));
  assert.match(download, /w19AssertMaterialForTask_/);
  assert.match(download, /w19AssertOwnedBinary_/);
  assert.match(download, /w20FindOwnedBinaryMaterialByMarkers_/);
  assert.match(download, /DriveApp\.getFileById\(drive\.id\)\.getBlob\(\)/);
  assert.doesNotMatch(download, /UrlFetchApp/);
  assert.match(download, /Utilities\.base64Encode\(bytes\)/);
  assert.match(guard, /folderParents\.indexOf\(root\.id\) === -1/);
  assert.match(guard, /driveProps\.taskPageId !== compactTask/);
  assert.match(guard, /driveParents\.indexOf\(folder\.id\) === -1/);
  assert.match(guard, /DOWNLOAD_NATIVE_GOOGLE_FILE/);
  assert.match(guard, /size > cfg\.maxUploadBytes/);
});

test('prepare download revalidates Notion and Drive before returning an allowlisted hosted URL', () => {
  const backend = loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
  const signed='https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file/report.xlsx?X-Amz-Signature=abc';
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{}};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertMaterialForTask_=(receivedPage,receivedTask)=>({id:receivedPage,taskId:receivedTask});
  backend.w19MaterialFromPage_=()=>({
    id:pageId,name:'report.xlsx',downloadName:'report.xlsx',attachmentName:'report.xlsx',
    downloadUrl:signed,attachmentUrl:signed,attachmentExpiry:'2099-01-01T00:00:00.000Z',
    hostedAttachment:true,attachmentType:'file',widgetOwnedBinary:true,mimeType:'application/octet-stream',size:123
  });
  let guardCalls=0;
  backend.w19AssertOwnedBinary_=()=>{guardCalls+=1;return {id:'DRIVEFILE123',name:'report.xlsx',mimeType:'application/octet-stream',size:'123'};};
  const result=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(result.ok,true);
  assert.equal(result.data.mode,'direct');
  assert.equal(result.data.url,signed);
  assert.equal(guardCalls,1);
  backend.w19MaterialFromPage_=()=>({
    name:'report.xlsx',downloadName:'report.xlsx',attachmentName:'report.xlsx',
    downloadUrl:'https://evil.example/report.xlsx',attachmentUrl:'https://evil.example/report.xlsx',attachmentExpiry:'2099-01-01T00:00:00.000Z',
    hostedAttachment:true,attachmentType:'file',widgetOwnedBinary:true
  });
  const rejected=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(rejected.ok,true);
  assert.equal(rejected.data.mode,'proxy');
  assert.equal(guardCalls,2);
});

test('deployment contract supports a capability-authenticated iframe with full Drive metadata access', () => {
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert.ok(!manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive.file'));
  assert.deepEqual(manifest.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
  assert.match(backendSource, /AUTHORIZED_TASK_PAGE_ID/);
  assert.match(backendSource, /WIDGET_ACCESS_TOKEN_SHA256/);
  assert.match(backendSource, /Session\.getActiveUser\(\).*Административный запуск/s);
});

test('Drive idempotency marker is linked back to the resulting Notion page', () => {
  assert.match(backendSource, /appProperties:\s*\{[\s\S]*widgetIdem:[\s\S]*notionPageId:/);
  assert.match(backendSource, /w19MarkDriveNotionPage_\(driveFile, task\.id, idemHash, page\.id, 'active'\)/);
});
