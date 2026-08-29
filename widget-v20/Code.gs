/* global Drive, DriveApp, HtmlService, Session, PropertiesService, CacheService, LockService,
          ScriptApp, UrlFetchApp, Utilities, WidgetV19Core */

var W19_VERSION = 'v20';
var W20_DRIVE_MARKER = 'v20';
var W19_NOTION_DEFAULT_VERSION = '2026-03-11';
var W19_LEDGER_PREFIX = 'w20:idem:';
var W19_SYNC_CURSOR = 'w20:sync:cursor';
var W19_SYNC_LEASE = 'w20:sync:lease';
var W19_NOTION_SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024;
var W20_DOWNLOAD_MATERIAL_CACHE_PREFIX = 'w20:download-material:';
var W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS = 120;
var W20_DOWNLOAD_MATERIAL_CACHE_SCHEMA = 1;
var W20_DOWNLOAD_GRANT_CACHE_PREFIX = 'w20:download-grant:';
var W20_DOWNLOAD_GRANT_EPOCH_PREFIX = 'w20:download-grant-epoch:';
var W20_DOWNLOAD_GRANT_TTL_SECONDS = 60;
var W20_DOWNLOAD_GRANT_SCHEMA = 2;
var W20_FAST_DOWNLOAD_PACKAGE_TTL_SECONDS = 60;
var W20_DRIVE_DIRECT_SOURCE_TTL_SECONDS = 15 * 60;
var W20_DRIVE_POLL_CLAIM_TTL_SECONDS = 60;
var W20_ATTACHMENT_JOB_PREFIX = 'w20:attachment-job:';
var W20_ATTACHMENT_JOB_SCHEMA = 1;
var W20_ATTACHMENT_JOB_MAX = 100;
var W20_ATTACHMENT_JOB_TTL_MS = 14 * 24 * 60 * 60 * 1000;
var W20_ATTACHMENT_JOB_LEASE_MS = 8 * 60 * 1000;
var W20_ATTACHMENT_JOB_DRAIN_LIMIT = 2;
var W20_CREATE_RESERVATION_PREFIX = 'w20:create-reservation:';
var W20_CREATE_CLAIM_PREFIX = 'w20:create-claim:';
var W20_CREATE_RESERVATION_SCHEMA = 1;
var W20_CREATE_RESERVATION_PREPARING_TTL_MS = 2 * 60 * 1000;
var W20_CREATE_RESERVATION_V2_PREFIX = 'w20:create-reservation:v2:';
var W20_CREATE_CLIENT_V2_PREFIX = 'w20:create-client:v2:';
var W20_CREATE_RESERVATION_V2_SCHEMA = 2;
var W20_CREATE_RESERVATION_V2_TTL_MS = 30 * 24 * 60 * 60 * 1000;
var W20_CREATE_RESERVATION_V2_CLEANUP_LIMIT = 6;
var W20_CREATE_RESERVATION_V2_CLEANUP_LEASE_MS = 2 * 60 * 1000;
var W20_CREATE_RESERVATION_V2_MAX_CLIENTS = 4;
var W20_CREATE_RESERVATION_V2_PROOF_DOMAIN = 'notion-widget-create-reservation-v2';
var W20_NAVIGATION_BINDING_DOMAIN = 'notion-widget-navigation-binding-v1';
var W19_IDEMPOTENCY_PENDING_TTL_MS = 7 * 60 * 1000;
var W19_NOTION_RATE_CACHE_KEY = 'w20:notion:last-request-at';
var W19_NOTION_RATE_INTERVAL_MS = 350;
var W19_NOTION_RATE_LOCK_WAIT_MS = 5000;
var W19_NOTION_MAX_RETRY_DELAY_MS = 5000;

var W19_P = Object.freeze({
  NAME: 'Name',
  TYPE: 'Тип',
  INSIDE: 'Внутри',
  SOURCE: 'Ссылка',
  ATTACHMENTS: 'Вложения',
  KNOWLEDGE_FORMAT: 'Формат знания',
  ARCHIVE: 'Архив',
  FILE_FORMAT: '[SYS] Формат файла',
  SECTION: '[SYS] Раздел виджета',
  GOOGLE_FILE_ID: '[SYS] Google File ID',
  GOOGLE_FOLDER_ID: '[SYS] Google Folder ID',
  POSITION: '[SYS] Позиция',
  SYNC_STATUS: '[SYS] Sync status',
  IDEMPOTENCY: '[SYS] Idempotency key',
  CONTEXT_PATH: '[SYS] Context path',
  ANCESTOR_IDS: '[SYS] Ancestor IDs',
  DEPTH: '[SYS] Глубина',
  CONTEXT_SPHERE: '[SYS] Контекст: Сфера',
  CONTEXT_DIRECTION: '[SYS] Контекст: Направление',
  CONTEXT_PROJECT: '[SYS] Контекст: Проект',
  CONTEXT_UPDATED: '[SYS] Контекст обновлён'
});

var W19_REQUIRED_SCHEMA = Object.freeze({
  'Name': 'title',
  'Тип': 'select',
  'Внутри': 'relation',
  'Ссылка': 'url',
  'Вложения': 'files',
  'Формат знания': 'select',
  'Архив': 'checkbox',
  '[SYS] Формат файла': 'select',
  '[SYS] Раздел виджета': 'select',
  '[SYS] Google File ID': 'rich_text',
  '[SYS] Google Folder ID': 'rich_text',
  '[SYS] Позиция': 'number',
  '[SYS] Sync status': 'select',
  '[SYS] Idempotency key': 'rich_text',
  '[SYS] Context path': 'rich_text',
  '[SYS] Ancestor IDs': 'rich_text',
  '[SYS] Глубина': 'number',
  '[SYS] Контекст: Сфера': 'relation',
  '[SYS] Контекст: Направление': 'relation',
  '[SYS] Контекст: Проект': 'relation',
  '[SYS] Контекст обновлён': 'date'
});

function W19Error_(code, message, retryable, details) {
  this.name = 'W19Error';
  this.code = code || 'UNEXPECTED';
  this.message = message || 'Неизвестная ошибка';
  this.retryable = Boolean(retryable);
  this.details = details || null;
  if (Error.captureStackTrace) Error.captureStackTrace(this, W19Error_);
}
W19Error_.prototype = Object.create(Error.prototype);
W19Error_.prototype.constructor = W19Error_;

function doGet(event) {
  var params = event && event.parameter || {};
  var isDownloadCourier = Boolean(params.downloadPageId || params.downloadTicket);
  var isCreateCourier = !isDownloadCourier && Boolean(params.createSection || params.createRequestId);
  var output;
  if (isDownloadCourier) {
    var template = HtmlService.createTemplateFromFile('Download');
    template.runtimeParamsJson = JSON.stringify({
      task: String(params.task || params.taskPageId || '').slice(0, 100),
      downloadPageId: String(params.downloadPageId || '').slice(0, 100),
      accessToken: String(params.accessToken || '').slice(0, 300),
      downloadTicket: String(params.downloadTicket || '').slice(0, 200)
    });
    template.precomputedResultJson = 'null';
    output = template.evaluate();
  } else if (isCreateCourier) {
    var createTemplate = HtmlService.createTemplateFromFile('Create');
    createTemplate.runtimeParamsJson = JSON.stringify({
      task: String(params.task || params.taskPageId || '').slice(0, 100),
      accessToken: String(params.accessToken || '').slice(0, 300),
      createSection: String(params.createSection || '').slice(0, 20),
      createRequestId: String(params.createRequestId || '').slice(0, 100)
    });
    createTemplate.precomputedResultJson = 'null';
    output = createTemplate.evaluate();
  } else {
    var indexTemplate = HtmlService.createTemplateFromFile('Index');
    indexTemplate.initialBootstrapJson = 'null';
    var initialTaskId = WidgetV19Core.normalizeUuid(params.task || params.taskPageId);
    indexTemplate.runtimeParamsJson = JSON.stringify({
      task: initialTaskId || '',
      accessToken: String(params.accessToken || '').slice(0, 300),
      clientId: String(params.clientId || '').slice(0, 80),
      embedNonce: String(params.embedNonce || '').slice(0, 64),
      release: String(params.release || '').slice(0, 80)
    });
    try {
      var initialInput = {
        taskPageId: initialTaskId,
        accessToken: String(params.accessToken || '').slice(0, 300),
        clientId: String(params.clientId || '').slice(0, 80)
      };
      var initialProperties = PropertiesService.getScriptProperties().getProperties();
      var initialCfg = w19AuthorizedConfigFromValues_(initialInput, initialProperties);
      var initialBootstrap = w20BootstrapFromRegistry_(initialInput, initialCfg, null, {
        propertyValues: initialProperties,
        issueDrivePollClaims: false,
        seedDownloadCache: false,
        includeServiceUrl: false
      });
      if (initialBootstrap) indexTemplate.initialBootstrapJson = JSON.stringify(initialBootstrap);
    } catch (_initialBootstrapError) {}
    output = indexTemplate.evaluate();
  }
  return output
    .setTitle(isDownloadCourier ? 'Скачивание файла' : (isCreateCourier ? 'Создание файла' : 'Файлы задачи'))
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function w20CreatePostFields_(event) {
  var expected = ['task', 'accessToken', 'createSection', 'createRequestId'];
  var parameters = event && event.parameters;
  var postType = String(event && event.postData && event.postData.type || '').toLowerCase().split(';')[0].trim();
  var keys = parameters && typeof parameters === 'object' ? Object.keys(parameters) : [];
  var exact = postType === 'application/x-www-form-urlencoded' && !String(event && event.queryString || '') && keys.length === expected.length;
  var values = {};
  expected.forEach(function (key) {
    var list = parameters && parameters[key];
    if (!list || typeof list.length !== 'number' || list.length !== 1) exact = false;
    values[key] = list && list.length === 1 ? String(list[0] || '') : '';
  });
  if (keys.some(function (key) { return expected.indexOf(key) === -1; })) exact = false;
  var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var task = String(values.task || '').toLowerCase();
  var requestId = String(values.createRequestId || '').toLowerCase();
  var accessToken = String(values.accessToken || '');
  var section = String(values.createSection || '');
  return {
    valid: Boolean(exact && uuid.test(task) && uuid.test(requestId) &&
      /^[A-Za-z0-9._~-]{32,256}$/.test(accessToken) && ['Docs', 'Sheets', 'Slides'].indexOf(section) !== -1),
    taskPageId: task,
    accessToken: accessToken,
    section: section,
    requestId: uuid.test(requestId) ? requestId : ''
  };
}

function w20DownloadPostFields_(event) {
  var expected = ['task', 'accessToken', 'downloadPageId', 'downloadTicket'];
  var parameters = event && event.parameters;
  var postType = String(event && event.postData && event.postData.type || '').toLowerCase().split(';')[0].trim();
  var keys = parameters && typeof parameters === 'object' ? Object.keys(parameters) : [];
  var exact = postType === 'application/x-www-form-urlencoded' && !String(event && event.queryString || '') && keys.length === expected.length;
  var values = {};
  expected.forEach(function (key) {
    var list = parameters && parameters[key];
    if (!list || typeof list.length !== 'number' || list.length !== 1) exact = false;
    values[key] = list && list.length === 1 ? String(list[0] || '') : '';
  });
  if (keys.some(function (key) { return expected.indexOf(key) === -1; })) exact = false;
  var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var task = String(values.task || '').toLowerCase();
  var pageId = String(values.downloadPageId || '').toLowerCase();
  var accessToken = String(values.accessToken || '');
  var ticket = String(values.downloadTicket || '');
  return {
    valid: Boolean(exact && uuid.test(task) && uuid.test(pageId) &&
      /^[A-Za-z0-9._~-]{32,256}$/.test(accessToken) && /^[A-Za-z0-9_-]{32,160}$/.test(ticket)),
    taskPageId: task,
    accessToken: accessToken,
    pageId: pageId,
    ticket: ticket
  };
}

function w20HasExactObjectKeys_(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var actual = Object.keys(value).sort();
  var wanted = expected.slice().sort();
  return actual.length === wanted.length && actual.every(function (key, index) { return key === wanted[index]; });
}

function w20MutationPostFields_(event) {
  var expected = ['task', 'accessToken', 'mutationRequestId', 'mutationPayload'];
  var parameters = event && event.parameters;
  var postType = String(event && event.postData && event.postData.type || '').toLowerCase().split(';')[0].trim();
  var keys = parameters && typeof parameters === 'object' ? Object.keys(parameters) : [];
  var exact = postType === 'application/x-www-form-urlencoded' && !String(event && event.queryString || '') && keys.length === expected.length;
  var values = {};
  expected.forEach(function (key) {
    var list = parameters && parameters[key];
    if (!list || typeof list.length !== 'number' || list.length !== 1) exact = false;
    values[key] = list && list.length === 1 ? String(list[0] || '') : '';
  });
  if (keys.some(function (key) { return expected.indexOf(key) === -1; })) exact = false;
  var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var taskUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var task = String(values.task || '').toLowerCase();
  var requestId = String(values.mutationRequestId || '').toLowerCase();
  var accessToken = String(values.accessToken || '');
  var rawPayload = String(values.mutationPayload || '');
  var payload = null;
  if (rawPayload && rawPayload.length <= 1000) {
    try { payload = JSON.parse(rawPayload); } catch (_payloadError) { payload = null; }
  }
  var kind = String(payload && payload.kind || '');
  var binding = String(payload && payload.binding || '').toLowerCase();
  var validPayload = false;
  if (kind === 'hide') {
    validPayload = w20HasExactObjectKeys_(payload, ['kind', 'binding']);
  } else if (kind === 'edit') {
    var name = String(payload && payload.name || '').replace(/\s+/g, ' ').trim();
    var section = String(payload && payload.section || '');
    validPayload = w20HasExactObjectKeys_(payload, ['kind', 'binding', 'name', 'section']) &&
      Boolean(name && name.length <= 180 && ['Drive', 'Docs', 'Sheets', 'Slides'].indexOf(section) !== -1);
    if (validPayload) payload = { kind: kind, binding: binding, name: name, section: section };
  }
  validPayload = Boolean(validPayload && /^[a-f0-9]{64}$/.test(binding));
  return {
    valid: Boolean(exact && taskUuid.test(task) && uuid.test(requestId) &&
      /^[A-Za-z0-9._~-]{32,256}$/.test(accessToken) && validPayload),
    taskPageId: task,
    accessToken: accessToken,
    requestId: uuid.test(requestId) ? requestId : '',
    payload: validPayload ? payload : null
  };
}

function w20CourierPostKind_(event) {
  var parameters = event && event.parameters;
  var keys = parameters && typeof parameters === 'object' ? Object.keys(parameters) : [];
  var hasCreate = keys.indexOf('createSection') !== -1 || keys.indexOf('createRequestId') !== -1;
  var hasDownload = keys.indexOf('downloadPageId') !== -1 || keys.indexOf('downloadTicket') !== -1;
  var hasMutation = keys.indexOf('mutationRequestId') !== -1 || keys.indexOf('mutationPayload') !== -1;
  if (hasCreate && !hasDownload && !hasMutation) return 'create';
  if (hasDownload && !hasCreate && !hasMutation) return 'download';
  if (hasMutation && !hasCreate && !hasDownload) return 'mutation';
  return '';
}

function w20SafeCreateOpenUrl_(value) {
  var normalized = WidgetV19Core.normalizeExternalUrl(value);
  return normalized && WidgetV19Core.isGoogleDriveUrl(normalized) ? normalized : '';
}

function w20SafeCreateMaterialOpenUrl_(material) {
  var url = w20SafeCreateOpenUrl_(material && material.openUrl);
  var fileId = w20SafeDriveId_(material && material.googleFileId);
  var section = String(material && material.section || '');
  var expectedFormat = section === 'Docs' ? 'Google Docs' : (section === 'Sheets' ? 'Google Sheets' : (section === 'Slides' ? 'Google Slides' : ''));
  if (!url || !fileId || WidgetV19Core.extractGoogleFileId(url) !== fileId ||
      material.provider !== 'Google Drive' || material.format !== expectedFormat || material.archived) return '';
  return url;
}

function w20CreateDriveReadyData_(driveFile, section) {
  var fileId = w20SafeDriveId_(driveFile && driveFile.id);
  var normalizedSection = String(section || '');
  var format = normalizedSection === 'Docs' ? 'Google Docs' : (normalizedSection === 'Sheets' ? 'Google Sheets' : (normalizedSection === 'Slides' ? 'Google Slides' : ''));
  if (!fileId || !format) return null;
  var material = {
    openUrl: driveFile && driveFile.webViewLink || WidgetV19Core.makeDriveOpenUrl(fileId, format),
    googleFileId: fileId,
    section: normalizedSection,
    format: format,
    provider: 'Google Drive',
    archived: false
  };
  return w20SafeCreateMaterialOpenUrl_(material) ? material : null;
}

function w20WriteCreateDriveReady_(canonicalKey, attemptId, driveFile, section) {
  var ready = w20CreateDriveReadyData_(driveFile, section);
  var ledgerKey = w19IdempotencyLedgerKey_(canonicalKey);
  var expectedAttemptId = String(attemptId || '').toLowerCase();
  if (!ready || !ledgerKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expectedAttemptId)) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w19ReadLedger_(props, ledgerKey);
    if (!current || current.status !== 'pending' || String(current.attemptId || '').toLowerCase() !== expectedAttemptId) return false;
    current.driveReady = ready;
    current.driveReadyAt = Date.now();
    props.setProperty(ledgerKey, JSON.stringify(current));
    return true;
  } catch (_driveReadyError) {
    return false;
  } finally {
    lock.releaseLock();
  }
}

function w20CreateDriveReadyUrl_(ledger) {
  var readyAt = Number(ledger && ledger.driveReadyAt || 0);
  if (!ledger || (ledger.status !== 'pending' && ledger.status !== 'failed') || !isFinite(readyAt) || readyAt <= 0 ||
      Date.now() - readyAt > W19_IDEMPOTENCY_PENDING_TTL_MS) return '';
  return w20SafeCreateMaterialOpenUrl_(ledger.driveReady);
}

function w20SafeCreatePostResult_(requestId, response) {
  var normalizedRequest = String(requestId || '').toLowerCase();
  var openUrl = response && response.ok ? w20SafeCreateMaterialOpenUrl_(response.data && response.data.material) : '';
  if (openUrl) return { requestId: normalizedRequest, status: 'success', openUrl: openUrl };
  var message = response && response.error && response.error.message ||
    (response && response.ok ? 'Сервис вернул недопустимый адрес файла.' : 'Файл не удалось создать.');
  return { requestId: normalizedRequest, status: 'error', message: WidgetV19Core.cleanName(message, 'Файл не удалось создать.') };
}

function w20RecoverConcurrentCreatePost_(fields, response) {
  if (!(response && response.ok === false && response.error && response.error.code === 'OPERATION_IN_PROGRESS')) {
    return w20SafeCreatePostResult_(fields.requestId, response);
  }
  for (var attempt = 0; attempt < 9; attempt += 1) {
    var material = null;
    try { material = w20RegistryFindCreateRequest_(fields.taskPageId, fields.section, fields.requestId); }
    catch (_err) { material = null; }
    var openUrl = w20SafeCreateMaterialOpenUrl_(material);
    if (openUrl) return { requestId: fields.requestId, status: 'success', openUrl: openUrl };
    if (attempt < 8) Utilities.sleep(350);
  }
  return {
    requestId: fields.requestId,
    status: 'pending',
    message: 'Этот файл уже создаётся в первой вкладке. Дубликат не будет создан.'
  };
}

function w20PreparedDownloadPostDirect_(response, fields, cfg) {
  var prepared = response && response.ok === true && response.data;
  var grant = String(prepared && prepared.downloadGrant || '');
  if (!fields || fields.valid !== true || !cfg || !prepared || prepared.mode !== 'grant' ||
      !/^[a-f0-9]{96}$/.test(grant)) return null;
  return w20GetDownloadGrant_(fields.taskPageId, fields.pageId, grant, cfg);
}

function w20FreshRegistryMaterialByNavigationBinding_(taskId, binding, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var exactBinding = String(binding || '').toLowerCase();
  if (!task || !/^[a-f0-9]{64}$/.test(exactBinding) || !cfg || task !== cfg.authorizedTaskPageId ||
      (cfg.deniedPageIds && cfg.deniedPageIds[task])) return null;
  var values;
  try { values = PropertiesService.getScriptProperties().getProperties(); }
  catch (_propertyError) { return null; }
  var registry;
  var meta;
  try {
    registry = w20RegistryReadTaskResultFromValues_(task, null, values);
    meta = w20RegistryParseTaskMeta_(task, values[w20RegistryMetaKey_(task)]);
  } catch (_registryError) { return null; }
  var proof = w20RegistryActionProof_(meta, registry, cfg.rootFolderId);
  var materials = registry && Array.isArray(registry.materials) ? registry.materials : [];
  if (!proof.ready || !registry.ok || !registry.integrityOk || registry.activeCount !== materials.length ||
      !meta || registry.activeCount !== meta.snapshotActiveCount) return null;
  var match = null;
  var count = 0;
  materials.forEach(function (material) {
    if (w20NavigationBinding_(material, task, cfg) !== exactBinding) return;
    match = material;
    count += 1;
  });
  return count === 1 ? match : null;
}

function w20MutationPresentation_(material, taskId, cfg) {
  var client = w20MaterialForClient_(material, taskId, cfg);
  var name = String(client && client.name || '').replace(/\s+/g, ' ').trim();
  var section = String(client && client.section || '');
  var format = String(client && client.format || '').replace(/\s+/g, ' ').trim();
  var position = Number(client && client.position);
  var binding = String(client && client.navigationBinding || '').toLowerCase();
  if (!name || name.length > 180 || ['Drive', 'Docs', 'Sheets', 'Slides'].indexOf(section) === -1 ||
      format.length > 100 || !isFinite(position) || position < 0 || position > 10000 || !/^[a-f0-9]{64}$/.test(binding)) {
    throw new W19Error_('MUTATION_RESULT_INVALID', 'Обновлённая карточка не прошла проверку.', true);
  }
  return { name: name, section: section, format: format || 'Файл', position: Math.round(position), navigationBinding: binding };
}

function w20ApplyOuterMutation_(fields) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_({ taskPageId: fields.taskPageId, accessToken: fields.accessToken });
    var taskId = w20AssertAuthorizedTaskId_(fields.taskPageId, cfg);
    var payload = fields.payload || {};
    var canonical = w19CanonicalIdempotency_(taskId, 'outer-' + payload.kind + '-' + payload.binding, fields.requestId);
    return w19WithIdempotency_(canonical, function () {
      var initial = w20FreshRegistryMaterialByNavigationBinding_(taskId, payload.binding, cfg);
      if (!initial) throw new W19Error_('MUTATION_REFRESH_REQUIRED', 'Карточка изменилась. Обновите виджет и повторите действие.', true);
      var pageId = WidgetV19Core.normalizeUuid(initial.id);
      if (!pageId || (cfg.deniedPageIds && cfg.deniedPageIds[pageId])) throw new W19Error_('WRITE_BARRIER', 'Материал запрещён write barrier.', false);
      return w19WithMutationLock_(function () {
        var currentRegistry = w20FreshRegistryMaterialByNavigationBinding_(taskId, payload.binding, cfg);
        if (!currentRegistry || WidgetV19Core.normalizeUuid(currentRegistry.id) !== pageId) {
          throw new W19Error_('MUTATION_REFRESH_REQUIRED', 'Карточка изменилась. Обновите виджет и повторите действие.', true);
        }
        var page = w19AssertMaterialForTask_(pageId, taskId, cfg, payload.kind === 'hide');
        if (page.in_trash) throw new W19Error_('MATERIAL_ARCHIVED', 'Материал находится в корзине.', false);
        var current = w19MaterialFromPage_(page);
        if (w20NavigationBinding_(current, taskId, cfg) !== payload.binding) {
          throw new W19Error_('MUTATION_REFRESH_REQUIRED', 'Карточка уже изменилась. Обновите виджет.', true);
        }
        if (current.syncStatus === 'deleting') throw new W19Error_('BUSY', 'Материал сейчас удаляется.', true);
        if (current.syncStatus === 'deleted') throw new W19Error_('MATERIAL_DELETED', 'Физически удалённый материал нельзя изменить.', false);
        w20InvalidateDownloadMaterialCache_(taskId, pageId);
        if (payload.kind === 'hide') {
          if (!w20CancelAttachmentJob_(taskId, pageId)) throw new W19Error_('BUSY', 'Фоновая копия ещё завершается.', true);
          w20SetDriveMaterialState_(current, taskId, 'archived');
          var archiveProps = {};
          archiveProps[W19_P.ARCHIVE] = { checkbox: true };
          archiveProps[W19_P.SYNC_STATUS] = w19Select_('archived');
          w19UpdateNotionPage_(pageId, archiveProps, cfg);
          if (!w20RegistryRemove_(taskId, pageId)) {
            throw new W19Error_('BUSY', 'Карточка скрыта, но быстрый снимок ещё обновляется.', true);
          }
          return { kind: 'hide', binding: payload.binding, material: null };
        }
        var nextSection = WidgetV19Core.assertSection(payload.section);
        var nextName = WidgetV19Core.cleanName(payload.name, current.name);
        if (nextSection === current.section && nextName === current.name) {
          return { kind: 'edit', binding: payload.binding, material: w20MutationPresentation_(current, taskId, cfg) };
        }
        var editProps = {};
        if (nextSection !== current.section) {
          editProps[W19_P.SECTION] = w19Select_(nextSection);
          editProps[W19_P.POSITION] = { number: w19NextPosition_(taskId, nextSection, cfg) };
        }
        if (nextName !== current.name) {
          if (current.provider === 'Google Drive' && current.googleFileId) {
            w19DriveRetry_(function () { Drive.Files.update({ name: nextName }, current.googleFileId, null, { fields: 'id,name' }); });
          }
          editProps[W19_P.NAME] = w19Title_(nextName);
        }
        editProps[W19_P.SYNC_STATUS] = w19Select_('synced');
        var updated = w19UpdateNotionPage_(pageId, editProps, cfg);
        var updatedMaterial = w19MaterialFromPage_(updated);
        if (!w20RegistryUpsert_(taskId, updatedMaterial)) {
          throw new W19Error_('BUSY', 'Изменение сохранено, но быстрый снимок ещё обновляется.', true);
        }
        return { kind: 'edit', binding: payload.binding, material: w20MutationPresentation_(updatedMaterial, taskId, cfg) };
      });
    });
  });
}

function w20SafeMutationPostResult_(fields, response) {
  var requestId = String(fields && fields.requestId || '').toLowerCase();
  var data = response && response.data;
  var safeMaterial = null;
  if (data && data.kind === 'edit' && w20HasExactObjectKeys_(data.material, ['name', 'section', 'format', 'position', 'navigationBinding'])) {
    var name = String(data.material.name || '').replace(/\s+/g, ' ').trim();
    var section = String(data.material.section || '');
    var format = String(data.material.format || '').replace(/\s+/g, ' ').trim();
    var position = Number(data.material.position);
    var navigationBinding = String(data.material.navigationBinding || '').toLowerCase();
    if (name && name.length <= 180 && ['Drive', 'Docs', 'Sheets', 'Slides'].indexOf(section) !== -1 &&
        format.length <= 100 && isFinite(position) && position >= 0 && position <= 10000 && /^[a-f0-9]{64}$/.test(navigationBinding)) {
      safeMaterial = { name: name, section: section, format: format || 'Файл', position: Math.round(position), navigationBinding: navigationBinding };
    }
  }
  if (response && response.ok === true && response.data &&
      (data.kind === 'hide' || data.kind === 'edit') && /^[a-f0-9]{64}$/.test(String(data.binding || '')) &&
      (data.kind === 'hide' && data.material === null || data.kind === 'edit' && safeMaterial)) {
    return {
      requestId: requestId,
      status: 'success',
      kind: data.kind,
      binding: data.binding,
      material: data.kind === 'edit' ? safeMaterial : null
    };
  }
  return {
    requestId: requestId,
    status: 'error',
    message: WidgetV19Core.cleanName(response && response.error && response.error.message, 'Изменение не сохранено.'),
    retryable: Boolean(response && response.error && response.error.retryable)
  };
}

function doPost(event) {
  var kind = w20CourierPostKind_(event);
  if (kind === 'download') {
    var downloadFields = w20DownloadPostFields_(event);
    var direct = null;
    if (downloadFields.valid) {
      try {
        var cfg = w19AuthorizedConfig_({
          taskPageId: downloadFields.taskPageId,
          accessToken: downloadFields.accessToken
        });
        direct = w20GetDownloadGrant_(downloadFields.taskPageId, downloadFields.pageId, downloadFields.ticket, cfg);
        if (!direct) {
          var prepared = apiPrepareDownload({
            taskPageId: downloadFields.taskPageId,
            pageId: downloadFields.pageId,
            accessToken: downloadFields.accessToken
          });
          direct = w20PreparedDownloadPostDirect_(prepared, downloadFields, cfg);
        }
      } catch (_downloadAuthError) { direct = null; }
    }
    var downloadTemplate = HtmlService.createTemplateFromFile('Download');
    downloadTemplate.runtimeParamsJson = direct ? '{}' : JSON.stringify(downloadFields.valid ? {
      task: downloadFields.taskPageId,
      accessToken: downloadFields.accessToken,
      downloadPageId: downloadFields.pageId,
      downloadTicket: downloadFields.ticket
    } : {});
    downloadTemplate.precomputedResultJson = JSON.stringify(direct ? {
      mode: 'direct',
      url: direct.url,
      name: direct.name,
      mimeType: direct.mimeType,
      size: direct.size,
      expiresAt: direct.expiresAt,
      downloadTicket: downloadFields.ticket
    } : null);
    return downloadTemplate.evaluate()
      .setTitle('Скачивание файла')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  }
  if (kind === 'mutation') {
    var mutationFields = w20MutationPostFields_(event);
    var mutationResult = mutationFields.valid ?
      w20SafeMutationPostResult_(mutationFields, w20ApplyOuterMutation_(mutationFields)) :
      { requestId: mutationFields.requestId, status: 'error', message: 'Параметры изменения повреждены.', retryable: false };
    var mutationTemplate = HtmlService.createTemplateFromFile('Mutation');
    mutationTemplate.precomputedResultJson = JSON.stringify(mutationResult);
    return mutationTemplate.evaluate()
      .setTitle('Изменение материала')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  }
  var fields = w20CreatePostFields_(event);
  var result;
  if (fields.valid) {
    var response = apiCreateGoogle({
      taskPageId: fields.taskPageId,
      accessToken: fields.accessToken,
      section: fields.section,
      idempotencyKey: fields.requestId
    });
    result = w20RecoverConcurrentCreatePost_(fields, response);
  } else {
    result = { requestId: fields.requestId, status: 'error', message: 'Параметры создания повреждены.' };
  }
  var template = HtmlService.createTemplateFromFile('Create');
  template.runtimeParamsJson = '{}';
  template.precomputedResultJson = JSON.stringify(result);
  return template.evaluate()
    .setTitle('Создание файла')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ========================= Public client API ========================= */

function apiBootstrap(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    if (!(input && input.forceRefresh === true)) {
      var cached = w20BootstrapFromRegistry_(input, cfg, null);
      if (cached) return cached;
    }
    try {
      var registrySnapshotStartedAt = Date.now();
      w19AssertSchema_(cfg);
      var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
      var taskValidatedAt = new Date().toISOString();
      var pages = w19QueryTaskMaterials_(task.id, cfg);
      w20CacheDownloadMaterials_(task.id, pages, cfg);
      var materials = pages.map(function (page) {
        return w20MaterialForClient_(w19MaterialFromPage_(page), task.id, cfg);
      });
      materials = w20PreserveRegistryRuntimeMetadata_(task.id, materials);
      var replacement = w20RegistryReplaceTaskResult_(task.id, materials, registrySnapshotStartedAt);
      if (!replacement.ok) throw new W19Error_('BUSY', 'Не удалось сохранить актуальный снимок карточек. Повторите обновление.', true);
      var snapshotValidatedAt = new Date().toISOString();
      var metaWrite = w20RegistryWriteTaskMetaResult_(task.id, {
        taskName: task.name,
        taskValidatedAt: taskValidatedAt,
        snapshotValidatedAt: snapshotValidatedAt,
        snapshotActiveCount: replacement.activeCount,
        context: w20TaskContextSnapshot_(task)
      });
      var registry = metaWrite.ok ? metaWrite.registry : replacement;
      if (!registry || !registry.ok || !registry.integrityOk || registry.activeCount !== replacement.activeCount) {
        throw new W19Error_('BUSY', 'Не удалось подтвердить актуальный снимок карточек. Повторите обновление.', true);
      }
      materials = registry.materials.map(function (material) {
        return w20MaterialForClient_(material, task.id, cfg);
      });
      var actionMeta = metaWrite.ok ? metaWrite.meta : null;
      var actionProof = w20RegistryActionProof_(actionMeta, registry, cfg.rootFolderId);
      var folderReady = w20RegistryFolderMetaFresh_(actionMeta, cfg.rootFolderId);
      var preparedPropertyValues = metaWrite.propertyValues;
      var refreshedFolderProof = false;
      if (!actionProof.ready && actionMeta && w20RegistryTaskMetaFresh_(actionMeta)) {
        try { refreshedFolderProof = w20WarmTaskFolderProof_(task.id, cfg); }
        catch (folderProofError) {
          w19Audit_('bootstrap_folder_proof_deferred', {
            code: String(folderProofError && folderProofError.code || 'DRIVE_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 80)
          });
        }
      }
      if (refreshedFolderProof) {
        actionMeta = w20RegistryReadTaskMeta_(task.id);
        registry = w20RegistryReadTaskResult_(task.id, null);
        actionProof = w20RegistryActionProof_(actionMeta, registry, cfg.rootFolderId);
        folderReady = w20RegistryFolderMetaFresh_(actionMeta, cfg.rootFolderId);
        preparedPropertyValues = null;
      }
      return {
        version: W19_VERSION,
        task: { id: task.id, name: task.name },
        folderUrl: folderReady ? 'https://drive.google.com/drive/folders/' + encodeURIComponent(actionMeta.folderId) : null,
        serviceUrl: ScriptApp.getService().getUrl(),
        maxUploadBytes: cfg.maxUploadBytes,
        materials: materials,
        cached: false,
        authoritative: true,
        actionReady: actionProof.ready,
        preparedCreates: actionProof.ready ?
          w20PreparedCreatePoolForInput_(task.id, input, cfg, preparedPropertyValues) : [],
        trustedUntil: actionProof.trustedUntil,
        fullySynced: true,
        refreshRequired: false
      };
    } catch (err) {
      if (err && (err.code === 'GOOGLE_URLFETCH_QUOTA' || err.code === 'NOTION_UNAVAILABLE' || err.code === 'NOTION_RATE_LIMIT_BUSY')) {
        var degraded = w20BootstrapFromRegistry_(input, cfg, err);
        if (degraded) return degraded;
      }
      throw err;
    }
  });
}

function w20CreateReservationId_(value) {
  var normalized = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized) ? normalized : '';
}

function w20PreparedCreatePoolForInput_(taskId, input, cfg, propertyValues) {
  var rawClientId = String(input && input.clientId || '');
  var clientId = w20CreateClientId_(rawClientId);
  if (rawClientId && !clientId) return [];
  return clientId ? w20PreparedCreatePoolV2Snapshot_(taskId, clientId, cfg, propertyValues) :
    w20PreparedCreatePoolSnapshot_(taskId, propertyValues);
}

function w20CreateReservationSection_(value) {
  var section = String(value || '');
  return ['Docs', 'Sheets', 'Slides'].indexOf(section) === -1 ? '' : section;
}

function w20CreateClientId_(value) {
  var candidate = String(value || '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate) ? candidate : '';
}

function w20CreateClientHash_(taskId, clientId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var client = w20CreateClientId_(clientId);
  return task && client ? w19Hash_('w20:create-client:v2|' + task + '|' + client).slice(0, 32) : '';
}

function w20CreateReservationV2Key_(taskId, clientHash, section) {
  var task = WidgetV19Core.compactUuid(taskId);
  var hash = String(clientHash || '').trim().toLowerCase();
  var normalizedSection = w20CreateReservationSection_(section);
  return task && /^[a-f0-9]{32}$/.test(hash) && normalizedSection ?
    W20_CREATE_RESERVATION_V2_PREFIX + task + ':' + hash + ':' + normalizedSection : '';
}

function w20CreateClientV2Key_(taskId, clientHash) {
  var task = WidgetV19Core.compactUuid(taskId);
  var hash = String(clientHash || '').trim().toLowerCase();
  return task && /^[a-f0-9]{32}$/.test(hash) ? W20_CREATE_CLIENT_V2_PREFIX + task + ':' + hash : '';
}

function w20CreateNavigateUntil_(value) {
  var parsed = typeof value === 'number' ? Number(value) : Date.parse(String(value || ''));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0;
  return (typeof value === 'number' || new Date(parsed).toISOString() === String(value || '')) ? parsed : 0;
}

function w20CreatePreparedNameV2_(value) {
  var normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized && normalized.length <= 180 ? normalized : '';
}

function w20CreateReservationV2Payload_(taskId, clientHash, section, reservationId, openUrl, preparedName, generation, navigateUntil) {
  var task = WidgetV19Core.compactUuid(taskId);
  var hash = String(clientHash || '').trim().toLowerCase();
  var normalizedSection = w20CreateReservationSection_(section);
  var normalizedReservation = w20CreateReservationId_(reservationId);
  var normalizedName = w20CreatePreparedNameV2_(preparedName);
  var normalizedGeneration = Number(generation);
  var normalizedUntil = w20CreateNavigateUntil_(navigateUntil);
  var expectedOpenUrl = w20CreateReservationOpenUrl_(WidgetV19Core.extractGoogleFileId(openUrl), normalizedSection);
  if (!task || !/^[a-f0-9]{32}$/.test(hash) || !normalizedSection || !normalizedReservation || !normalizedName ||
      normalizedName !== String(preparedName || '') ||
      !Number.isSafeInteger(normalizedGeneration) || normalizedGeneration < 1 || normalizedGeneration > 2147483647 ||
      !normalizedUntil || !expectedOpenUrl || expectedOpenUrl !== String(openUrl || '')) return '';
  return [W20_CREATE_RESERVATION_V2_PROOF_DOMAIN, task, hash, normalizedSection, normalizedReservation,
    expectedOpenUrl, normalizedName, normalizedGeneration, normalizedUntil].join('|');
}

function w20CreateReservationV2Signature_(payload, cfg) {
  if (!payload || !cfg || !cfg.notionToken) return '';
  return Utilities.computeHmacSha256Signature(String(payload), String(cfg.notionToken)).map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function w20CreateReservationV2Proof_(taskId, clientHash, section, reservationId, openUrl, preparedName, generation, navigateUntil, cfg) {
  var payload = w20CreateReservationV2Payload_(taskId, clientHash, section, reservationId, openUrl, preparedName, generation, navigateUntil);
  return payload ? w20CreateReservationV2Signature_(payload, cfg) : '';
}

function w20ReadCreateClientV2_(props, key) {
  var raw = key && props && props.getProperty(key);
  if (!raw) return null;
  var value;
  try { value = JSON.parse(raw); } catch (_parseClientError) { return null; }
  var task = String(value && value.taskId || '').toLowerCase();
  var clientHash = String(value && value.clientHash || '').toLowerCase();
  var at = Number(value && value.at || 0);
  var expiresAt = Number(value && value.expiresAt || 0);
  var generations = value && value.generations;
  if (!value || value.schema !== W20_CREATE_RESERVATION_V2_SCHEMA || !/^[a-f0-9]{32}$/.test(task) ||
      !/^[a-f0-9]{32}$/.test(clientHash) || !Number.isSafeInteger(at) || at <= 0 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !generations || typeof generations !== 'object' || Array.isArray(generations)) return null;
  for (var i = 0; i < 3; i += 1) {
    var section = ['Docs', 'Sheets', 'Slides'][i];
    var generation = Number(generations[section] || 0);
    if (!Number.isSafeInteger(generation) || generation < 0 || generation > 2147483647) return null;
  }
  return value;
}

function w20ReadCreateReservationV2_(props, key) {
  var raw = key && props && props.getProperty(key);
  if (!raw) return null;
  var value;
  try { value = JSON.parse(raw); } catch (_parseReservationError) { return null; }
  var status = String(value && value.status || '');
  var task = String(value && value.taskId || '').toLowerCase();
  var clientHash = String(value && value.clientHash || '').toLowerCase();
  var section = w20CreateReservationSection_(value && value.section);
  var reservationId = w20CreateReservationId_(value && value.reservationId);
  var at = Number(value && value.at || 0);
  var generation = Number(value && value.generation || 0);
  var navigateUntil = Number(value && value.navigateUntil || 0);
  if (!value || value.schema !== W20_CREATE_RESERVATION_V2_SCHEMA || !/^[a-f0-9]{32}$/.test(task) ||
      !/^[a-f0-9]{32}$/.test(clientHash) || !section || value.section !== section || !reservationId ||
      !Number.isSafeInteger(at) || at <= 0 || !Number.isSafeInteger(generation) || generation < 1 || generation > 2147483647 ||
      !Number.isSafeInteger(navigateUntil) || navigateUntil <= 0 ||
      ['preparing', 'prepared', 'cleaning', 'claimed', 'done'].indexOf(status) === -1) return null;
  if (status === 'preparing') {
    if (!w20CreateReservationId_(value.prepareAttemptId)) return null;
  } else if (!w20SafeDriveId_(value.fileId) || !w20CreatePreparedNameV2_(value.preparedName) ||
      w20CreatePreparedNameV2_(value.preparedName) !== value.preparedName) {
    return null;
  }
  if ((status === 'prepared' || status === 'cleaning') && value.preparedModifiedTime &&
      (!isFinite(Date.parse(String(value.preparedModifiedTime))) ||
        new Date(Date.parse(String(value.preparedModifiedTime))).toISOString() !== value.preparedModifiedTime)) return null;
  if (status === 'cleaning' && !w20CreateReservationId_(value.cleanupAttemptId)) return null;
  if (status === 'prepared' || status === 'claimed' || status === 'done') {
    if (!/^[a-f0-9]{64}$/.test(String(value.reservationProof || ''))) return null;
  }
  if (status === 'claimed' || status === 'done') {
    if (!/^[a-f0-9]{64}$/.test(String(value.canonicalHash || '')) ||
        !w20CreateReservationId_(value.createRequestId) || !w20CreateReservationId_(value.attemptId) ||
        value.createRequestId !== reservationId || !w20SafeDriveId_(value.folderId) ||
        !Number.isFinite(Number(value.position)) || Number(value.position) < 0) return null;
    if (status === 'claimed' && value.notionPageId) return null;
    if (status === 'done' && !WidgetV19Core.normalizeUuid(value.notionPageId)) return null;
  }
  return value;
}

function w20CreateReservationKey_(taskId, section) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  return task && normalizedSection ? W20_CREATE_RESERVATION_PREFIX + task + ':' + normalizedSection : '';
}

function w20CreateClaimKey_(canonicalHash) {
  var hash = String(canonicalHash || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? W20_CREATE_CLAIM_PREFIX + hash.slice(0, 48) : '';
}

function w20CreateReservationRef_(value) {
  var normalized = String(value || '').trim().toLowerCase();
  return normalized.indexOf(W20_CREATE_CLAIM_PREFIX) === 0 &&
    /^[a-f0-9]{48}$/.test(normalized.slice(W20_CREATE_CLAIM_PREFIX.length)) ? normalized : '';
}

function w20ExactCreateAppProperties_(actual, expected) {
  var source = actual && typeof actual === 'object' ? actual : {};
  var wanted = expected && typeof expected === 'object' ? expected : {};
  var actualKeys = Object.keys(source).sort();
  var expectedKeys = Object.keys(wanted).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  for (var i = 0; i < expectedKeys.length; i += 1) {
    var key = expectedKeys[i];
    if (actualKeys[i] !== key || String(source[key]) !== String(wanted[key])) return false;
  }
  return true;
}

function w20ReadCreateReservation_(props, key) {
  var raw = key && props && props.getProperty(key);
  if (!raw) return null;
  var value;
  try { value = JSON.parse(raw); } catch (_parseReservationError) { return null; }
  var status = String(value && value.status || '');
  var task = String(value && value.taskId || '').toLowerCase();
  var section = w20CreateReservationSection_(value && value.section);
  var reservationId = w20CreateReservationId_(value && value.reservationId);
  var at = Number(value && value.at || 0);
  if (!value || value.schema !== W20_CREATE_RESERVATION_SCHEMA ||
      !/^[a-f0-9]{32}$/.test(task) || value.taskId !== task || !section || value.section !== section ||
      !reservationId || value.reservationId !== reservationId || !isFinite(at) || at <= 0 ||
      ['preparing', 'prepared', 'claimed', 'done'].indexOf(status) === -1) return null;
  if (status === 'preparing') {
    if (!w20CreateReservationId_(value.prepareAttemptId)) return null;
  } else if (!w20SafeDriveId_(value.fileId)) {
    return null;
  }
  if (status !== 'preparing' && (typeof value.preparedName !== 'string' || !value.preparedName || value.preparedName.length > 500)) return null;
  if (status === 'claimed' || status === 'done') {
    if (!/^[a-f0-9]{64}$/.test(String(value.canonicalHash || '').toLowerCase()) ||
        !w20CreateReservationId_(value.createRequestId) || !w20CreateReservationId_(value.attemptId) ||
        value.createRequestId !== reservationId || !w20SafeDriveId_(value.folderId) ||
        !isFinite(Number(value.position)) || Number(value.position) < 0) return null;
    if (status === 'claimed' && value.notionPageId) return null;
    if (status === 'done' && !WidgetV19Core.normalizeUuid(value.notionPageId)) return null;
  }
  return value;
}

function w20CreateReservationFormat_(section) {
  return section === 'Docs' ? 'Google Docs' : (section === 'Sheets' ? 'Google Sheets' : (section === 'Slides' ? 'Google Slides' : ''));
}

function w20CreateReservationOpenUrl_(fileId, section) {
  var id = w20SafeDriveId_(fileId);
  var format = w20CreateReservationFormat_(section);
  if (!id || !format) return '';
  var url = WidgetV19Core.makeDriveOpenUrl(id, format);
  return w20SafeCreateMaterialOpenUrl_({
    openUrl: url,
    googleFileId: id,
    section: section,
    format: format,
    provider: 'Google Drive',
    archived: false
  });
}

function w20PreparedCreateFile_(file, taskId, section, reservationId, rootFolderId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  var normalizedReservation = w20CreateReservationId_(reservationId);
  var root = w20SafeDriveId_(rootFolderId);
  var props = file && file.appProperties || {};
  var parents = file && Array.isArray(file.parents) ? file.parents.map(String) : [];
  var fileId = w20SafeDriveId_(file && file.id);
  var expectedProperties = {
    widgetVersion: W20_DRIVE_MARKER,
    taskPageId: task,
    createReservationSection: normalizedSection,
    createReservationId: normalizedReservation,
    createReservationState: 'prepared',
    materialState: 'reserved'
  };
  if (!task || !normalizedSection || !normalizedReservation || !root || !fileId || !file || file.trashed || file.ownedByMe !== true ||
      file.mimeType !== WidgetV19Core.GOOGLE_MIME[normalizedSection] || parents.length !== 1 || parents[0] !== root ||
      !w20ExactCreateAppProperties_(props, expectedProperties)) return null;
  var openUrl = w20CreateReservationOpenUrl_(fileId, normalizedSection);
  return openUrl ? { file: file, openUrl: openUrl } : null;
}

function w20ClaimedCreateFile_(file, claim, expectedNotionPageId) {
  var props = file && file.appProperties || {};
  var parents = file && Array.isArray(file.parents) ? file.parents.map(String) : [];
  var fileId = w20SafeDriveId_(file && file.id);
  var expectedIdem = String(claim && claim.canonicalHash || '').slice(0, 40);
  var expectedProperties = {
    widgetVersion: W20_DRIVE_MARKER,
    taskPageId: claim && claim.taskId,
    widgetIdem: expectedIdem,
    materialState: 'active'
  };
  var compactPage = expectedNotionPageId === undefined ? '' : WidgetV19Core.compactUuid(expectedNotionPageId);
  if (expectedNotionPageId !== undefined && !compactPage) return null;
  var propertiesValid = w20ExactCreateAppProperties_(props, expectedProperties);
  if (compactPage) {
    var withPage = {};
    Object.keys(expectedProperties).forEach(function (key) { withPage[key] = expectedProperties[key]; });
    withPage.notionPageId = compactPage;
    propertiesValid = propertiesValid || w20ExactCreateAppProperties_(props, withPage);
  }
  if (!file || file.trashed || file.ownedByMe !== true || !fileId || fileId !== claim.fileId ||
      file.mimeType !== WidgetV19Core.GOOGLE_MIME[claim.section] || parents.length !== 1 || parents[0] !== claim.folderId ||
      !propertiesValid) return null;
  var openUrl = w20CreateReservationOpenUrl_(fileId, claim.section);
  return openUrl ? { file: file, openUrl: openUrl } : null;
}

function w20CreateReservationForClient_(slot, verified) {
  var reservationId = w20CreateReservationId_(slot && slot.reservationId);
  var section = w20CreateReservationSection_(slot && slot.section);
  var openUrl = verified && w20CreateReservationOpenUrl_(verified.file && verified.file.id, section);
  return reservationId && section && openUrl ? { section: section, reservationId: reservationId, openUrl: openUrl } : null;
}

function w20PreparedCreatePoolSnapshot_(taskId, propertyValues) {
  var task = WidgetV19Core.compactUuid(taskId);
  if (!task) return [];
  var values = propertyValues && typeof propertyValues === 'object' ? propertyValues :
    PropertiesService.getScriptProperties().getProperties();
  var snapshot = {
    getProperty: function (key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    }
  };
  var prepared = [];
  ['Docs', 'Sheets', 'Slides'].forEach(function (section) {
    var slot = w20ReadCreateReservation_(snapshot, w20CreateReservationKey_(taskId, section));
    if (!slot || slot.status !== 'prepared' || slot.taskId !== task || slot.section !== section) return;
    var openUrl = w20CreateReservationOpenUrl_(slot.fileId, section);
    if (openUrl) prepared.push({ section: section, reservationId: slot.reservationId, openUrl: openUrl });
  });
  return prepared;
}

function w20FindPreparedReservationFiles_(taskId, section, reservationId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  var normalizedReservation = w20CreateReservationId_(reservationId);
  if (!task || !normalizedSection) return [];
  var q = "trashed = false and appProperties has { key='widgetVersion' and value='" + W20_DRIVE_MARKER + "' } and " +
    "appProperties has { key='taskPageId' and value='" + w19DriveQueryEscape_(task) + "' } and " +
    "appProperties has { key='createReservationSection' and value='" + normalizedSection + "' } and " +
    "appProperties has { key='createReservationState' and value='prepared' }";
  if (normalizedReservation) q += " and appProperties has { key='createReservationId' and value='" + normalizedReservation + "' }";
  var result = w19DriveRetry_(function () {
    return Drive.Files.list({
      q: q,
      pageSize: 2,
      spaces: 'drive',
      fields: 'files(id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,ownedByMe,trashed,parents,appProperties)'
    });
  });
  return result && Array.isArray(result.files) ? result.files.slice(0, 2) : [];
}

function w20CreatePreparedReservationFile_(taskId, section, reservationId, cfg) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  var normalizedReservation = w20CreateReservationId_(reservationId);
  if (!task || !normalizedSection || !normalizedReservation || !w20SafeDriveId_(cfg && cfg.rootFolderId)) {
    throw new W19Error_('RESERVATION_INVALID', 'Не удалось подготовить резерв файла.', false);
  }
  var recovered = w20FindPreparedReservationFiles_(taskId, normalizedSection, normalizedReservation);
  if (recovered.length === 1) return recovered[0];
  if (recovered.length > 1) throw new W19Error_('RESERVATION_AMBIGUOUS', 'Обнаружено несколько резервов файла.', false);
  try {
    return Drive.Files.create({
      name: w19DefaultGoogleName_(normalizedSection),
      mimeType: WidgetV19Core.GOOGLE_MIME[normalizedSection],
      parents: [cfg.rootFolderId],
      appProperties: {
        widgetVersion: W20_DRIVE_MARKER,
        taskPageId: task,
        createReservationSection: normalizedSection,
        createReservationId: normalizedReservation,
        createReservationState: 'prepared',
        materialState: 'reserved'
      }
    }, null, { fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,ownedByMe,trashed,parents,appProperties' });
  } catch (err) {
    var afterError = [];
    try { afterError = w20FindPreparedReservationFiles_(taskId, normalizedSection, normalizedReservation); }
    catch (_reservationLookupError) { afterError = []; }
    if (afterError.length === 1) return afterError[0];
    throw new W19Error_('RESERVATION_PREPARE_UNCERTAIN', 'Google Drive не подтвердил подготовку резерва.', true);
  }
}

function w20StorePreparedReservation_(key, expected, file, cfg) {
  var verified = w20PreparedCreateFile_(file, expected.taskId, expected.section, expected.reservationId, cfg.rootFolderId);
  if (!verified) return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w20ReadCreateReservation_(props, key);
    if (!current || current.status !== 'preparing' || current.reservationId !== expected.reservationId ||
        current.prepareAttemptId !== expected.prepareAttemptId || current.taskId !== expected.taskId || current.section !== expected.section) return null;
    var prepared = {
      schema: W20_CREATE_RESERVATION_SCHEMA,
      status: 'prepared',
      taskId: expected.taskId,
      section: expected.section,
      reservationId: expected.reservationId,
      fileId: verified.file.id,
      preparedName: String(verified.file.name || w19DefaultGoogleName_(expected.section)),
      at: Date.now()
    };
    props.setProperty(key, JSON.stringify(prepared));
    return { slot: prepared, verified: verified };
  } finally {
    lock.releaseLock();
  }
}

function w20EnsurePreparedCreate_(taskId, section, cfg) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  var key = w20CreateReservationKey_(taskId, normalizedSection);
  if (!task || !normalizedSection || !key) return null;
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(key);
  var slot = w20ReadCreateReservation_(props, key);

  if (slot && slot.status === 'prepared') {
    var preparedFile = w19GetDriveMetadata_(slot.fileId);
    var preparedVerified = w20PreparedCreateFile_(preparedFile, taskId, normalizedSection, slot.reservationId, cfg.rootFolderId);
    if (!preparedVerified) return null;
    var verifyLock = LockService.getScriptLock();
    if (!verifyLock.tryLock(5000)) return null;
    try {
      var currentPrepared = w20ReadCreateReservation_(PropertiesService.getScriptProperties(), key);
      if (!currentPrepared || currentPrepared.status !== 'prepared' || currentPrepared.reservationId !== slot.reservationId ||
          currentPrepared.fileId !== slot.fileId) return null;
      return w20CreateReservationForClient_(currentPrepared, preparedVerified);
    } finally {
      verifyLock.releaseLock();
    }
  }
  if (slot && (slot.status === 'claimed' || slot.status === 'done')) return null;

  if (slot && slot.status === 'preparing') {
    var recoveredPreparing = w20FindPreparedReservationFiles_(taskId, normalizedSection, slot.reservationId);
    if (recoveredPreparing.length === 1) {
      var promoted = w20StorePreparedReservation_(key, slot, recoveredPreparing[0], cfg);
      return promoted ? w20CreateReservationForClient_(promoted.slot, promoted.verified) : null;
    }
    if (recoveredPreparing.length > 1 || Date.now() - Number(slot.at || 0) < W20_CREATE_RESERVATION_PREPARING_TTL_MS) return null;
  }

  if (raw && !slot) return null;
  if (!slot) {
    var existingFiles = w20FindPreparedReservationFiles_(taskId, normalizedSection, '');
    if (existingFiles.length > 1) return null;
    if (existingFiles.length === 1) {
      var existingId = w20CreateReservationId_(existingFiles[0].appProperties && existingFiles[0].appProperties.createReservationId);
      var existingVerified = w20PreparedCreateFile_(existingFiles[0], taskId, normalizedSection, existingId, cfg.rootFolderId);
      if (!existingVerified) return null;
      var reconstructLock = LockService.getScriptLock();
      if (!reconstructLock.tryLock(5000)) return null;
      try {
        var reconstructProps = PropertiesService.getScriptProperties();
        if (reconstructProps.getProperty(key)) return null;
        var reconstructed = {
          schema: W20_CREATE_RESERVATION_SCHEMA,
          status: 'prepared',
          taskId: task,
          section: normalizedSection,
          reservationId: existingId,
          fileId: existingFiles[0].id,
          preparedName: String(existingFiles[0].name || w19DefaultGoogleName_(normalizedSection)),
          at: Date.now()
        };
        reconstructProps.setProperty(key, JSON.stringify(reconstructed));
        return w20CreateReservationForClient_(reconstructed, existingVerified);
      } finally {
        reconstructLock.releaseLock();
      }
    }
  }

  var prepareAttemptId = Utilities.getUuid().toLowerCase();
  var reservationId = slot && slot.status === 'preparing' ? slot.reservationId : Utilities.getUuid().toLowerCase();
  var prepareLock = LockService.getScriptLock();
  if (!prepareLock.tryLock(5000)) return null;
  var preparing;
  try {
    var prepareProps = PropertiesService.getScriptProperties();
    var current = w20ReadCreateReservation_(prepareProps, key);
    if (current && current.status !== 'preparing') return null;
    if (current && Date.now() - Number(current.at || 0) < W20_CREATE_RESERVATION_PREPARING_TTL_MS) return null;
    if (!current && prepareProps.getProperty(key)) return null;
    preparing = {
      schema: W20_CREATE_RESERVATION_SCHEMA,
      status: 'preparing',
      taskId: task,
      section: normalizedSection,
      reservationId: reservationId,
      prepareAttemptId: prepareAttemptId,
      at: Date.now()
    };
    prepareProps.setProperty(key, JSON.stringify(preparing));
  } finally {
    prepareLock.releaseLock();
  }

  var created = w20CreatePreparedReservationFile_(taskId, normalizedSection, reservationId, cfg);
  var stored = w20StorePreparedReservation_(key, preparing, created, cfg);
  return stored ? w20CreateReservationForClient_(stored.slot, stored.verified) : null;
}

function w20WarmCreatePool_(taskId, cfg) {
  var prepared = w20PreparedCreatePoolSnapshot_(taskId);
  var present = {};
  prepared.forEach(function (item) { present[item.section] = true; });
  ['Docs', 'Sheets', 'Slides'].forEach(function (section) {
    if (present[section]) return;
    try {
      var item = w20EnsurePreparedCreate_(taskId, section, cfg);
      if (item) {
        prepared.push(item);
        present[section] = true;
      }
    } catch (err) {
      w19Audit_('create_reservation_prepare_deferred', { section: section, code: String(err && err.code || 'DRIVE_ERROR') });
    }
  });
  return prepared;
}

function w20WarmCreateSection_(taskId, section, cfg) {
  var normalizedSection = w20CreateReservationSection_(section);
  if (!normalizedSection) throw new W19Error_('INVALID_CREATE_TYPE', 'Можно подготовить только Google Docs, Sheets или Slides.', false);
  var prepared = w20PreparedCreatePoolSnapshot_(taskId).filter(function (item) {
    return item && item.section === normalizedSection;
  });
  if (prepared.length) return prepared.slice(0, 1);
  try {
    var item = w20EnsurePreparedCreate_(taskId, normalizedSection, cfg);
    return item ? [item] : [];
  } catch (err) {
    w19Audit_('create_reservation_prepare_deferred', { section: normalizedSection, code: String(err && err.code || 'DRIVE_ERROR') });
    return [];
  }
}

function w20CreateReservationForClientV2_(slot, cfg) {
  if (!slot || slot.status !== 'prepared' || slot.schema !== W20_CREATE_RESERVATION_V2_SCHEMA ||
      Number(slot.navigateUntil || 0) <= Date.now() + 1000) return null;
  var openUrl = w20CreateReservationOpenUrl_(slot.fileId, slot.section);
  var preparedName = w20CreatePreparedNameV2_(slot.preparedName);
  var navigateUntil = new Date(Number(slot.navigateUntil)).toISOString();
  var expectedProof = w20CreateReservationV2Proof_(slot.taskId, slot.clientHash, slot.section, slot.reservationId,
    openUrl, preparedName, slot.generation, navigateUntil, cfg);
  if (!openUrl || !preparedName || !expectedProof || !WidgetV19Core.safeEqual(expectedProof, String(slot.reservationProof || ''))) return null;
  return {
    section: slot.section,
    reservationId: slot.reservationId,
    openUrl: openUrl,
    preparedName: preparedName,
    generation: Number(slot.generation),
    navigateUntil: navigateUntil,
    reservationProof: expectedProof
  };
}

function w20PreparedCreateFileV2_(file, taskId, section, reservationId, clientHash, generation, navigateUntil, rootFolderId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  var normalizedReservation = w20CreateReservationId_(reservationId);
  var hash = String(clientHash || '').trim().toLowerCase();
  var normalizedGeneration = Number(generation);
  var normalizedUntil = Number(navigateUntil);
  var root = w20SafeDriveId_(rootFolderId);
  var props = file && file.appProperties || {};
  var parents = file && Array.isArray(file.parents) ? file.parents.map(String) : [];
  var fileId = w20SafeDriveId_(file && file.id);
  var expectedProperties = {
    widgetVersion: W20_DRIVE_MARKER,
    taskPageId: task,
    createReservationSection: normalizedSection,
    createReservationId: normalizedReservation,
    createReservationState: 'prepared',
    createReservationClient: hash,
    createReservationGeneration: String(normalizedGeneration),
    createReservationNavigateUntil: String(normalizedUntil),
    materialState: 'reserved'
  };
  if (!task || !normalizedSection || !normalizedReservation || !/^[a-f0-9]{32}$/.test(hash) ||
      !Number.isSafeInteger(normalizedGeneration) || normalizedGeneration < 1 || !Number.isSafeInteger(normalizedUntil) || normalizedUntil <= 0 ||
      !root || !fileId || !file || file.trashed || file.ownedByMe !== true ||
      file.mimeType !== WidgetV19Core.GOOGLE_MIME[normalizedSection] || parents.length !== 1 || parents[0] !== root ||
      !w20ExactCreateAppProperties_(props, expectedProperties)) return null;
  var openUrl = w20CreateReservationOpenUrl_(fileId, normalizedSection);
  return openUrl ? { file: file, openUrl: openUrl } : null;
}

function w20CreateClientV2Records_(taskId, values) {
  var task = WidgetV19Core.compactUuid(taskId);
  var prefix = task ? W20_CREATE_CLIENT_V2_PREFIX + task + ':' : '';
  if (!prefix) return [];
  var source = values && typeof values === 'object' ? values : {};
  var snapshot = { getProperty: function (key) { return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : null; } };
  return Object.keys(source).filter(function (key) { return key.indexOf(prefix) === 0; }).map(function (key) {
    return { key: key, value: w20ReadCreateClientV2_(snapshot, key) };
  }).filter(function (entry) { return entry.value && entry.value.taskId === task; });
}

function w20EnsureCreateClientV2_(taskId, clientId, cfg) {
  var task = WidgetV19Core.compactUuid(taskId);
  var client = w20CreateClientId_(clientId);
  var clientHash = w20CreateClientHash_(taskId, client);
  var key = w20CreateClientV2Key_(taskId, clientHash);
  if (!task || !client || !clientHash || !key) throw new W19Error_('CREATE_CLIENT_INVALID', 'Идентификатор браузера повреждён.', false);
  var props = PropertiesService.getScriptProperties();
  var existing = w20ReadCreateClientV2_(props, key);
  if (existing && existing.expiresAt > Date.now()) return existing;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new W19Error_('BUSY', 'Сервис занят подготовкой файла.', true);
  var record = null;
  var provisioned = false;
  try {
    props = PropertiesService.getScriptProperties();
    existing = w20ReadCreateClientV2_(props, key);
    var now = Date.now();
    if (existing && existing.expiresAt > now) return existing;
    var values = props.getProperties();
    var active = w20CreateClientV2Records_(taskId, values).filter(function (entry) {
      return entry.key !== key && Number(entry.value.expiresAt || 0) > now;
    });
    if (active.length >= W20_CREATE_RESERVATION_V2_MAX_CLIENTS) {
      throw new W19Error_('CREATE_CLIENT_LIMIT', 'В этой задаче достигнут безопасный лимит подготовленных браузеров.', false);
    }
    if (props.getProperty(key) && !existing) throw new W19Error_('CREATE_CLIENT_STATE_INVALID', 'Состояние браузера повреждено.', false);
    record = {
      schema: W20_CREATE_RESERVATION_V2_SCHEMA,
      taskId: task,
      clientHash: clientHash,
      at: now,
      expiresAt: now + W20_CREATE_RESERVATION_V2_TTL_MS,
      generations: existing && existing.generations || { Docs: 0, Sheets: 0, Slides: 0 }
    };
    props.setProperty(key, JSON.stringify(record));
    provisioned = true;
  } finally {
    lock.releaseLock();
  }
  if (provisioned) {
    try { w20CleanupExpiredCreateReservationsV2_(taskId, cfg, W20_CREATE_RESERVATION_V2_CLEANUP_LIMIT); }
    catch (cleanupError) {
      w19Audit_('create_reservation_v2_cleanup_deferred', { code: String(cleanupError && cleanupError.code || 'CLEANUP_ERROR') });
    }
  }
  return record;
}

function w20PreparedCreatePoolV2Snapshot_(taskId, clientId, cfg, propertyValues) {
  var task = WidgetV19Core.compactUuid(taskId);
  var clientHash = w20CreateClientHash_(taskId, clientId);
  if (!task || !clientHash || !cfg) return [];
  var values = propertyValues && typeof propertyValues === 'object' ? propertyValues :
    PropertiesService.getScriptProperties().getProperties();
  var snapshot = { getProperty: function (key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; } };
  var prepared = [];
  ['Docs', 'Sheets', 'Slides'].forEach(function (section) {
    var slot = w20ReadCreateReservationV2_(snapshot, w20CreateReservationV2Key_(taskId, clientHash, section));
    if (!slot || slot.status !== 'prepared' || slot.taskId !== task || slot.clientHash !== clientHash || slot.section !== section) return;
    var descriptor = w20CreateReservationForClientV2_(slot, cfg);
    if (descriptor) prepared.push(descriptor);
  });
  return prepared;
}

function w20FindPreparedReservationFilesV2_(taskId, section, clientHash, reservationId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  var hash = String(clientHash || '').trim().toLowerCase();
  var normalizedReservation = w20CreateReservationId_(reservationId);
  if (!task || !normalizedSection || !/^[a-f0-9]{32}$/.test(hash)) return [];
  var q = "trashed = false and appProperties has { key='widgetVersion' and value='" + W20_DRIVE_MARKER + "' } and " +
    "appProperties has { key='taskPageId' and value='" + w19DriveQueryEscape_(task) + "' } and " +
    "appProperties has { key='createReservationSection' and value='" + normalizedSection + "' } and " +
    "appProperties has { key='createReservationClient' and value='" + hash + "' } and " +
    "appProperties has { key='createReservationState' and value='prepared' }";
  if (normalizedReservation) q += " and appProperties has { key='createReservationId' and value='" + normalizedReservation + "' }";
  var result = w19DriveRetry_(function () {
    return Drive.Files.list({ q: q, pageSize: 2, spaces: 'drive', fields: 'files(id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,ownedByMe,trashed,parents,appProperties)' });
  });
  return result && Array.isArray(result.files) ? result.files.slice(0, 2) : [];
}

function w20CreatePreparedReservationFileV2_(expected, cfg) {
  var recovered = w20FindPreparedReservationFilesV2_(expected.taskId, expected.section, expected.clientHash, expected.reservationId);
  if (recovered.length === 1) return recovered[0];
  if (recovered.length > 1) throw new W19Error_('RESERVATION_AMBIGUOUS', 'Обнаружено несколько резервов файла.', false);
  try {
    return Drive.Files.create({
      name: w19DefaultGoogleName_(expected.section),
      mimeType: WidgetV19Core.GOOGLE_MIME[expected.section],
      parents: [cfg.rootFolderId],
      appProperties: {
        widgetVersion: W20_DRIVE_MARKER,
        taskPageId: expected.taskId,
        createReservationSection: expected.section,
        createReservationId: expected.reservationId,
        createReservationState: 'prepared',
        createReservationClient: expected.clientHash,
        createReservationGeneration: String(expected.generation),
        createReservationNavigateUntil: String(expected.navigateUntil),
        materialState: 'reserved'
      }
    }, null, { fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,ownedByMe,trashed,parents,appProperties' });
  } catch (err) {
    var afterError = [];
    try { afterError = w20FindPreparedReservationFilesV2_(expected.taskId, expected.section, expected.clientHash, expected.reservationId); }
    catch (_lookupError) { afterError = []; }
    if (afterError.length === 1) return afterError[0];
    throw new W19Error_('RESERVATION_PREPARE_UNCERTAIN', 'Google Drive не подтвердил подготовку резерва.', true);
  }
}

function w20StorePreparedReservationV2_(key, expected, file, cfg) {
  var verified = w20PreparedCreateFileV2_(file, expected.taskId, expected.section, expected.reservationId,
    expected.clientHash, expected.generation, expected.navigateUntil, cfg.rootFolderId);
  if (!verified) return null;
  var openUrl = verified.openUrl;
  var preparedName = w20CreatePreparedNameV2_(verified.file.name || w19DefaultGoogleName_(expected.section));
  var preparedModifiedTime = String(verified.file.modifiedTime || '');
  if (preparedModifiedTime && (!isFinite(Date.parse(preparedModifiedTime)) ||
      new Date(Date.parse(preparedModifiedTime)).toISOString() !== preparedModifiedTime)) preparedModifiedTime = '';
  var navigateUntil = new Date(expected.navigateUntil).toISOString();
  var reservationProof = w20CreateReservationV2Proof_(expected.taskId, expected.clientHash, expected.section,
    expected.reservationId, openUrl, preparedName, expected.generation, navigateUntil, cfg);
  if (!preparedName || !reservationProof) return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w20ReadCreateReservationV2_(props, key);
    if (!current || current.status !== 'preparing' || current.reservationId !== expected.reservationId ||
        current.prepareAttemptId !== expected.prepareAttemptId || current.clientHash !== expected.clientHash ||
        current.generation !== expected.generation || current.navigateUntil !== expected.navigateUntil) return null;
    var prepared = {
      schema: W20_CREATE_RESERVATION_V2_SCHEMA,
      status: 'prepared',
      taskId: expected.taskId,
      clientHash: expected.clientHash,
      section: expected.section,
      reservationId: expected.reservationId,
      generation: expected.generation,
      navigateUntil: expected.navigateUntil,
      reservationProof: reservationProof,
      fileId: verified.file.id,
      preparedName: preparedName,
      preparedModifiedTime: preparedModifiedTime,
      at: Date.now()
    };
    props.setProperty(key, JSON.stringify(prepared));
    return { slot: prepared, verified: verified };
  } finally {
    lock.releaseLock();
  }
}

function w20EnsurePreparedCreateV2_(taskId, clientId, section, cfg) {
  var task = WidgetV19Core.compactUuid(taskId);
  var normalizedSection = w20CreateReservationSection_(section);
  var clientRecord = w20EnsureCreateClientV2_(taskId, clientId, cfg);
  var clientHash = clientRecord && clientRecord.clientHash;
  var key = w20CreateReservationV2Key_(taskId, clientHash, normalizedSection);
  if (!task || !normalizedSection || !clientHash || !key) return null;
  var props = PropertiesService.getScriptProperties();
  var slot = w20ReadCreateReservationV2_(props, key);
  if (slot && (slot.status === 'cleaning' || slot.status === 'prepared' && slot.navigateUntil <= Date.now() + 1000)) {
    w20CleanupExpiredCreateReservationsV2_(taskId, cfg, 1);
    slot = w20ReadCreateReservationV2_(PropertiesService.getScriptProperties(), key);
    if (slot) return null;
  }
  if (slot && slot.status === 'prepared') {
    var currentFile = w19GetDriveMetadata_(slot.fileId);
    var verifiedCurrent = w20PreparedCreateFileV2_(currentFile, taskId, normalizedSection, slot.reservationId,
      clientHash, slot.generation, slot.navigateUntil, cfg.rootFolderId);
    return verifiedCurrent ? w20CreateReservationForClientV2_(slot, cfg) : null;
  }
  if (slot && slot.status === 'preparing') {
    var recoveredPreparing = w20FindPreparedReservationFilesV2_(taskId, normalizedSection, clientHash, slot.reservationId);
    if (recoveredPreparing.length === 1) {
      var promoted = w20StorePreparedReservationV2_(key, slot, recoveredPreparing[0], cfg);
      return promoted ? w20CreateReservationForClientV2_(promoted.slot, cfg) : null;
    }
    if (recoveredPreparing.length > 1 || Date.now() - Number(slot.at || 0) < W20_CREATE_RESERVATION_PREPARING_TTL_MS) return null;
  }
  if (props.getProperty(key) && !slot) return null;
  var prepareLock = LockService.getScriptLock();
  if (!prepareLock.tryLock(5000)) return null;
  var preparing;
  try {
    var prepareProps = PropertiesService.getScriptProperties();
    var current = w20ReadCreateReservationV2_(prepareProps, key);
    if (current && current.status !== 'preparing') return null;
    if (current && Date.now() - Number(current.at || 0) < W20_CREATE_RESERVATION_PREPARING_TTL_MS) return null;
    if (!current && prepareProps.getProperty(key)) return null;
    var clientKey = w20CreateClientV2Key_(taskId, clientHash);
    var lockedClient = w20ReadCreateClientV2_(prepareProps, clientKey);
    if (!lockedClient || lockedClient.expiresAt <= Date.now()) return null;
    var generation = current ? Number(current.generation) : Number(lockedClient.generations[normalizedSection] || 0) + 1;
    if (!Number.isSafeInteger(generation) || generation > 2147483647) throw new W19Error_('RESERVATION_GENERATION_EXHAUSTED', 'Лимит резервов исчерпан.', false);
    var now = Date.now();
    preparing = {
      schema: W20_CREATE_RESERVATION_V2_SCHEMA,
      status: 'preparing',
      taskId: task,
      clientHash: clientHash,
      section: normalizedSection,
      reservationId: current && current.reservationId || Utilities.getUuid().toLowerCase(),
      prepareAttemptId: Utilities.getUuid().toLowerCase(),
      generation: generation,
      navigateUntil: current ? Number(current.navigateUntil) : now + W20_CREATE_RESERVATION_V2_TTL_MS,
      at: now
    };
    lockedClient.generations[normalizedSection] = Math.max(Number(lockedClient.generations[normalizedSection] || 0), generation);
    lockedClient.expiresAt = Math.max(Number(lockedClient.expiresAt || 0), preparing.navigateUntil);
    var updates = {};
    updates[key] = JSON.stringify(preparing);
    updates[clientKey] = JSON.stringify(lockedClient);
    prepareProps.setProperties(updates);
  } finally {
    prepareLock.releaseLock();
  }
  var created = w20CreatePreparedReservationFileV2_(preparing, cfg);
  var stored = w20StorePreparedReservationV2_(key, preparing, created, cfg);
  return stored ? w20CreateReservationForClientV2_(stored.slot, cfg) : null;
}

function w20WarmCreatePoolV2_(taskId, clientId, cfg) {
  w20EnsureCreateClientV2_(taskId, clientId, cfg);
  var prepared = [];
  ['Docs', 'Sheets', 'Slides'].forEach(function (section) {
    try {
      var item = w20EnsurePreparedCreateV2_(taskId, clientId, section, cfg);
      if (item) prepared.push(item);
    } catch (err) {
      w19Audit_('create_reservation_v2_prepare_deferred', { section: section, code: String(err && err.code || 'DRIVE_ERROR') });
    }
  });
  return prepared;
}

function w20WarmCreateSectionV2_(taskId, clientId, section, cfg) {
  var normalizedSection = w20CreateReservationSection_(section);
  if (!normalizedSection) throw new W19Error_('INVALID_CREATE_TYPE', 'Можно подготовить только Google Docs, Sheets или Slides.', false);
  try {
    var item = w20EnsurePreparedCreateV2_(taskId, clientId, normalizedSection, cfg);
    return item ? [item] : [];
  } catch (err) {
    w19Audit_('create_reservation_v2_prepare_deferred', { section: normalizedSection, code: String(err && err.code || 'DRIVE_ERROR') });
    return [];
  }
}

function w20AcquireCreateReservationV2Cleanup_(key, expected) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w20ReadCreateReservationV2_(props, key);
    if (!current || ['prepared', 'cleaning'].indexOf(current.status) === -1 || current.reservationId !== expected.reservationId ||
        current.fileId !== expected.fileId || current.clientHash !== expected.clientHash || current.section !== expected.section ||
        current.generation !== expected.generation || current.navigateUntil !== expected.navigateUntil) return null;
    var now = Date.now();
    if (current.status === 'prepared' && current.navigateUntil > now) return null;
    if (current.status === 'cleaning') {
      var leaseAge = now - Number(current.at || 0);
      if (leaseAge >= -60000 && leaseAge < W20_CREATE_RESERVATION_V2_CLEANUP_LEASE_MS) return null;
    }
    current.status = 'cleaning';
    current.cleanupAttemptId = Utilities.getUuid().toLowerCase();
    current.at = now;
    delete current.reservationProof;
    props.setProperty(key, JSON.stringify(current));
    return current;
  } finally {
    lock.releaseLock();
  }
}

function w20RetireCreateReservationV2Cleanup_(key, cleaning) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w20ReadCreateReservationV2_(props, key);
    if (!current || current.status !== 'cleaning' || current.cleanupAttemptId !== cleaning.cleanupAttemptId ||
        current.reservationId !== cleaning.reservationId || current.fileId !== cleaning.fileId ||
        current.clientHash !== cleaning.clientHash || current.section !== cleaning.section ||
        current.generation !== cleaning.generation || current.navigateUntil !== cleaning.navigateUntil) return false;
    var clientKey = w20CreateClientV2Key_(current.taskId, current.clientHash);
    var client = w20ReadCreateClientV2_(props, clientKey);
    if (client) {
      client.generations[current.section] = Math.max(Number(client.generations[current.section] || 0), current.generation);
      props.setProperty(clientKey, JSON.stringify(client));
    }
    props.deleteProperty(key);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function w20PruneExpiredCreateClientsV2_(taskId) {
  var task = WidgetV19Core.compactUuid(taskId);
  if (!task) return 0;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  var removed = 0;
  try {
    var props = PropertiesService.getScriptProperties();
    var values = props.getProperties();
    var keys = Object.keys(values);
    w20CreateClientV2Records_(taskId, values).forEach(function (entry) {
      if (entry.value.expiresAt > Date.now()) return;
      var slotPrefix = W20_CREATE_RESERVATION_V2_PREFIX + task + ':' + entry.value.clientHash + ':';
      if (keys.some(function (key) { return key.indexOf(slotPrefix) === 0; })) return;
      var current = w20ReadCreateClientV2_(props, entry.key);
      if (current && current.expiresAt <= Date.now()) {
        props.deleteProperty(entry.key);
        removed += 1;
      }
    });
  } finally {
    lock.releaseLock();
  }
  return removed;
}

function w20CleanupExpiredCreateReservationsV2_(taskId, cfg, limit) {
  var task = WidgetV19Core.compactUuid(taskId);
  var root = w20SafeDriveId_(cfg && cfg.rootFolderId);
  var bounded = Math.max(0, Math.min(W20_CREATE_RESERVATION_V2_CLEANUP_LIMIT, Number(limit) || W20_CREATE_RESERVATION_V2_CLEANUP_LIMIT));
  if (!task || !root || !bounded) return 0;
  var props = PropertiesService.getScriptProperties();
  var values = props.getProperties();
  var prefix = W20_CREATE_RESERVATION_V2_PREFIX + task + ':';
  var snapshot = { getProperty: function (key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; } };
  var now = Date.now();
  var candidates = Object.keys(values).filter(function (key) { return key.indexOf(prefix) === 0; }).map(function (key) {
    return { key: key, slot: w20ReadCreateReservationV2_(snapshot, key) };
  }).filter(function (entry) {
    return entry.slot && (entry.slot.status === 'cleaning' || entry.slot.status === 'prepared' && entry.slot.navigateUntil <= now);
  }).slice(0, bounded);
  var removed = 0;
  candidates.forEach(function (entry) {
    var cleaning = w20AcquireCreateReservationV2Cleanup_(entry.key, entry.slot);
    if (!cleaning) return;
    var file;
    try { file = w19GetDriveMetadata_(cleaning.fileId); }
    catch (getError) {
      if (w19IsDriveNotFound_(getError) && w20RetireCreateReservationV2Cleanup_(entry.key, cleaning)) {
        w19Audit_('create_reservation_v2_cleanup_quarantined', { section: cleaning.section, reservationId: cleaning.reservationId });
      }
      return;
    }
    if (!w20PreparedCreateFileV2_(file, taskId, cleaning.section, cleaning.reservationId, cleaning.clientHash,
      cleaning.generation, cleaning.navigateUntil, root) || String(file.name || '') !== cleaning.preparedName ||
      !cleaning.preparedModifiedTime || String(file.modifiedTime || '') !== cleaning.preparedModifiedTime) {
      if (w20RetireCreateReservationV2Cleanup_(entry.key, cleaning)) {
        w19Audit_('create_reservation_v2_cleanup_quarantined', { section: cleaning.section, reservationId: cleaning.reservationId });
      }
      return;
    }
    var trashed;
    try {
      trashed = Drive.Files.update({ trashed: true }, cleaning.fileId, null, {
        fields: 'id,name,mimeType,ownedByMe,trashed,parents,appProperties'
      });
    } catch (_trashError) { return; }
    if (!trashed || trashed.trashed !== true) return;
    if (w20RetireCreateReservationV2Cleanup_(entry.key, cleaning)) removed += 1;
  });
  w20PruneExpiredCreateClientsV2_(taskId);
  return removed;
}

function w20CreateReservationV2DescriptorFromInput_(input, taskId, section, cfg) {
  var rawClientId = String(input && input.clientId || '');
  var clientId = w20CreateClientId_(rawClientId);
  var rawReservationId = String(input && input.reservationId || '');
  var reservationId = w20CreateReservationId_(rawReservationId);
  var openUrl = String(input && input.openUrl || '');
  var rawPreparedName = String(input && input.preparedName || '');
  var preparedName = w20CreatePreparedNameV2_(rawPreparedName);
  var generation = input && input.generation;
  var rawNavigateUntil = input && input.navigateUntil;
  var navigateUntil = typeof rawNavigateUntil === 'string' ? w20CreateNavigateUntil_(rawNavigateUntil) : 0;
  var reservationProof = String(input && input.reservationProof || '');
  var clientHash = w20CreateClientHash_(taskId, clientId);
  if (!clientId || rawClientId !== clientId || !reservationId || rawReservationId !== reservationId || !openUrl ||
      !preparedName || rawPreparedName !== preparedName || typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) || generation < 1 || generation > 2147483647 ||
      !navigateUntil || !/^[a-f0-9]{64}$/.test(reservationProof)) {
    throw new W19Error_('RESERVATION_V2_INVALID', 'Данные долгоживущего резерва повреждены.', false);
  }
  var payload = w20CreateReservationV2Payload_(taskId, clientHash, section, reservationId, openUrl, preparedName, generation,
    new Date(navigateUntil).toISOString());
  var expectedProof = w20CreateReservationV2Signature_(payload, cfg);
  if (!payload || !expectedProof || !WidgetV19Core.safeEqual(expectedProof, reservationProof)) {
    throw new W19Error_('RESERVATION_V2_PROOF_INVALID', 'Подпись резерва неверна.', false);
  }
  return {
    clientId: clientId,
    clientHash: clientHash,
    section: section,
    reservationId: reservationId,
    openUrl: openUrl,
    preparedName: preparedName,
    generation: generation,
    navigateUntil: navigateUntil,
    reservationProof: reservationProof
  };
}

function w20ResolveCreateReservationV2_(taskId, section, requestId, descriptor, idem, clientId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var canonicalHash = w19Hash_(idem);
  var durable = w20ReadClaimedReservation_(canonicalHash);
  if (durable) {
    if (durable.schema !== W20_CREATE_RESERVATION_V2_SCHEMA || durable.taskId !== task || durable.section !== section ||
        durable.createRequestId !== requestId || durable.reservationId !== requestId || durable.canonicalHash !== canonicalHash ||
        descriptor && (durable.clientHash !== descriptor.clientHash || durable.generation !== descriptor.generation ||
          durable.navigateUntil !== descriptor.navigateUntil || durable.reservationProof !== descriptor.reservationProof ||
          durable.preparedName !== descriptor.preparedName || w20CreateReservationOpenUrl_(durable.fileId, section) !== descriptor.openUrl)) {
      throw new W19Error_('RESERVATION_CONFLICT', 'Запрос уже привязан к другому резерву.', false);
    }
    return {
      clientHash: durable.clientHash,
      section: durable.section,
      reservationId: durable.reservationId,
      openUrl: w20CreateReservationOpenUrl_(durable.fileId, durable.section),
      preparedName: durable.preparedName,
      generation: durable.generation,
      navigateUntil: durable.navigateUntil,
      reservationProof: durable.reservationProof
    };
  }
  if (!descriptor) {
    var clientHash = w20CreateClientHash_(taskId, clientId);
    var existingKey = w20CreateReservationV2Key_(taskId, clientHash, section);
    var clientKey = w20CreateClientV2Key_(taskId, clientHash);
    var props = PropertiesService.getScriptProperties();
    var clientRecord = w20ReadCreateClientV2_(props, clientKey);
    if (existingKey && (props.getProperty(existingKey) || clientRecord && Number(clientRecord.generations[section] || 0) > 0)) {
      throw new W19Error_('RESERVATION_REQUIRED', 'Готовый файл требует точный подписанный резерв.', false);
    }
    return null;
  }
  if (descriptor.reservationId !== requestId) {
    throw new W19Error_('RESERVATION_REQUEST_MISMATCH', 'Запрос не совпал с одноразовым резервом.', false);
  }
  if (descriptor.navigateUntil <= Date.now()) {
    throw new W19Error_('RESERVATION_EXPIRED', 'Срок действия резерва истёк.', false);
  }
  var slotKey = w20CreateReservationV2Key_(taskId, descriptor.clientHash, section);
  var slot = w20ReadCreateReservationV2_(PropertiesService.getScriptProperties(), slotKey);
  if (!slot || slot.status !== 'prepared' || slot.taskId !== task || slot.clientHash !== descriptor.clientHash ||
      slot.section !== section || slot.reservationId !== descriptor.reservationId || slot.generation !== descriptor.generation ||
      slot.navigateUntil !== descriptor.navigateUntil || slot.reservationProof !== descriptor.reservationProof || slot.preparedName !== descriptor.preparedName ||
      w20CreateReservationOpenUrl_(slot.fileId, section) !== descriptor.openUrl) {
    throw new W19Error_('RESERVATION_STALE', 'Резерв файла больше не актуален.', false);
  }
  return descriptor;
}

function w20ClaimCreateReservationV2_(taskId, section, requestId, descriptor, idem, cfg, attemptId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var canonicalHash = w19Hash_(idem);
  var claimKey = w20CreateClaimKey_(canonicalHash);
  var slotKey = w20CreateReservationV2Key_(taskId, descriptor.clientHash, section);
  var props = PropertiesService.getScriptProperties();
  if (requestId !== descriptor.reservationId) throw new W19Error_('RESERVATION_REQUEST_MISMATCH', 'Запрос не совпал с резервом.', false);
  var durableClaim = w20ReadClaimedReservation_(canonicalHash);
  if (durableClaim) {
    if (durableClaim.schema !== W20_CREATE_RESERVATION_V2_SCHEMA || durableClaim.taskId !== task || durableClaim.section !== section ||
        durableClaim.reservationId !== descriptor.reservationId || durableClaim.createRequestId !== requestId ||
        durableClaim.canonicalHash !== canonicalHash || durableClaim.clientHash !== descriptor.clientHash ||
        durableClaim.generation !== descriptor.generation || durableClaim.navigateUntil !== descriptor.navigateUntil ||
        durableClaim.reservationProof !== descriptor.reservationProof || durableClaim.preparedName !== descriptor.preparedName) {
      throw new W19Error_('RESERVATION_CONFLICT', 'Резерв уже привязан к другому запросу.', false);
    }
    return { claim: durableClaim, taskMeta: null, recovered: true };
  }
  var slot = w20ReadCreateReservationV2_(props, slotKey);
  if (!slot || slot.status !== 'prepared' || slot.reservationId !== descriptor.reservationId ||
      slot.clientHash !== descriptor.clientHash || slot.generation !== descriptor.generation ||
      slot.navigateUntil !== descriptor.navigateUntil || slot.reservationProof !== descriptor.reservationProof || slot.preparedName !== descriptor.preparedName ||
      slot.navigateUntil <= Date.now()) {
    throw new W19Error_(slot && slot.navigateUntil <= Date.now() ? 'RESERVATION_EXPIRED' : 'RESERVATION_STALE',
      slot && slot.navigateUntil <= Date.now() ? 'Срок действия резерва истёк.' : 'Резерв файла больше не актуален.', false);
  }
  var preparedDrive = w19GetDriveMetadata_(slot.fileId);
  var preparedDriveVerifiedAt = Date.now();
  if (!w20PreparedCreateFileV2_(preparedDrive, taskId, section, descriptor.reservationId, descriptor.clientHash,
    descriptor.generation, descriptor.navigateUntil, cfg.rootFolderId)) {
    throw new W19Error_('RESERVATION_FILE_INVALID', 'Резервный файл изменён или недоступен.', false);
  }
  var createSlot = w20RegistryClaimCreateSlot_(taskId, section, cfg.rootFolderId);
  if (!createSlot || !createSlot.taskMeta || !w20SafeDriveId_(createSlot.taskMeta.folderId)) {
    throw new W19Error_('CREATE_CONTEXT_STALE', 'Контекст задачи требует обновления.', true);
  }
  var claim = {
    schema: W20_CREATE_RESERVATION_V2_SCHEMA,
    status: 'claimed',
    taskId: task,
    clientHash: descriptor.clientHash,
    section: section,
    reservationId: descriptor.reservationId,
    generation: descriptor.generation,
    navigateUntil: descriptor.navigateUntil,
    reservationProof: descriptor.reservationProof,
    fileId: slot.fileId,
    preparedName: descriptor.preparedName,
    at: Date.now(),
    claimedAt: Date.now(),
    createRequestId: requestId,
    canonicalHash: canonicalHash,
    attemptId: String(attemptId || '').toLowerCase(),
    folderId: createSlot.taskMeta.folderId,
    position: createSlot.position
  };
  if (!w20CreateReservationId_(claim.attemptId)) throw new W19Error_('RESERVATION_INVALID', 'Не удалось привязать резерв.', false);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new W19Error_('BUSY', 'Сервис занят привязкой файла.', true);
  try {
    var lockedProps = PropertiesService.getScriptProperties();
    var existingClaim = w20ReadCreateReservationV2_(lockedProps, claimKey);
    if (existingClaim) {
      if (existingClaim.status === 'claimed' && existingClaim.reservationId === descriptor.reservationId &&
          existingClaim.createRequestId === requestId && existingClaim.canonicalHash === canonicalHash &&
          existingClaim.fileId === slot.fileId && existingClaim.clientHash === descriptor.clientHash &&
          existingClaim.generation === descriptor.generation) return { claim: existingClaim, taskMeta: null, recovered: true };
      throw new W19Error_('RESERVATION_CONFLICT', 'Резерв уже привязан к другому запросу.', false);
    }
    var current = w20ReadCreateReservationV2_(lockedProps, slotKey);
    if (!current || current.status !== 'prepared' || current.reservationId !== descriptor.reservationId ||
        current.fileId !== slot.fileId || current.clientHash !== descriptor.clientHash ||
        current.generation !== descriptor.generation || current.navigateUntil !== descriptor.navigateUntil ||
        current.reservationProof !== descriptor.reservationProof || current.preparedName !== descriptor.preparedName || current.navigateUntil <= Date.now()) {
      throw new W19Error_('RESERVATION_STALE', 'Резерв уже изменился.', false);
    }
    var ledgerKey = w19IdempotencyLedgerKey_(idem);
    var ledger = w19ReadLedger_(lockedProps, ledgerKey);
    if (!ledger || ledger.status !== 'pending' || String(ledger.attemptId || '').toLowerCase() !== claim.attemptId) {
      throw new W19Error_('RESERVATION_LEDGER_STALE', 'Запрос на создание уже изменился.', true);
    }
    ledger.reservationRef = claimKey;
    var updates = {};
    updates[claimKey] = JSON.stringify(claim);
    updates[ledgerKey] = JSON.stringify(ledger);
    lockedProps.setProperties(updates);
    lockedProps.deleteProperty(slotKey);
  } finally {
    lock.releaseLock();
  }
  return { claim: claim, taskMeta: createSlot.taskMeta,
    preparedDrive: w20RecentlyVerifiedPreparedDrive_(preparedDrive, preparedDriveVerifiedAt, descriptor.preparedName), recovered: false };
}

function w20ReadClaimedReservation_(canonicalHash) {
  var key = w20CreateClaimKey_(canonicalHash);
  if (!key) return null;
  var props = PropertiesService.getScriptProperties();
  return w20ReadCreateReservationV2_(props, key) || w20ReadCreateReservation_(props, key);
}

function w20ClaimCreateReservation_(taskId, section, requestId, reservationId, idem, cfg, attemptId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var canonicalHash = w19Hash_(idem);
  var slotKey = w20CreateReservationKey_(taskId, section);
  var claimKey = w20CreateClaimKey_(canonicalHash);
  var props = PropertiesService.getScriptProperties();
  if (requestId !== reservationId) throw new W19Error_('RESERVATION_REQUEST_MISMATCH', 'Запрос не совпал с одноразовым резервом.', false);
  var durableClaim = w20ReadCreateReservation_(props, claimKey);
  if (durableClaim) {
    if ((durableClaim.status !== 'claimed' && durableClaim.status !== 'done') || durableClaim.taskId !== task || durableClaim.section !== section ||
        durableClaim.reservationId !== reservationId || durableClaim.createRequestId !== requestId ||
        durableClaim.canonicalHash !== canonicalHash) {
      throw new W19Error_('RESERVATION_CONFLICT', 'Резерв уже привязан к другому запросу.', false);
    }
    return { claim: durableClaim, taskMeta: null, recovered: true };
  }

  var slot = w20ReadCreateReservation_(props, slotKey);
  if (slot && slot.status === 'claimed') {
    if (slot.taskId === task && slot.section === section && slot.reservationId === reservationId &&
        slot.createRequestId === requestId && slot.canonicalHash === canonicalHash) return { claim: slot, taskMeta: null, recovered: true };
    throw new W19Error_('RESERVATION_CONFLICT', 'Резерв уже использован.', false);
  }
  if (!slot || slot.status !== 'prepared' || slot.taskId !== task || slot.section !== section || slot.reservationId !== reservationId) {
    throw new W19Error_('RESERVATION_STALE', 'Резерв файла больше не актуален.', false);
  }
  var preparedDrive = w19GetDriveMetadata_(slot.fileId);
  var preparedDriveVerifiedAt = Date.now();
  if (!w20PreparedCreateFile_(preparedDrive, taskId, section, reservationId, cfg.rootFolderId)) {
    throw new W19Error_('RESERVATION_FILE_INVALID', 'Резервный файл изменён или недоступен.', false);
  }
  var createSlot = w20RegistryClaimCreateSlot_(taskId, section, cfg.rootFolderId);
  if (!createSlot || !createSlot.taskMeta || !w20SafeDriveId_(createSlot.taskMeta.folderId)) {
    throw new W19Error_('CREATE_CONTEXT_STALE', 'Контекст задачи требует обновления.', true);
  }
  var claim = {
    schema: W20_CREATE_RESERVATION_SCHEMA,
    status: 'claimed',
    taskId: task,
    section: section,
    reservationId: reservationId,
    fileId: slot.fileId,
    preparedName: slot.preparedName,
    at: Date.now(),
    claimedAt: Date.now(),
    createRequestId: requestId,
    canonicalHash: canonicalHash,
    attemptId: String(attemptId || '').toLowerCase(),
    folderId: createSlot.taskMeta.folderId,
    position: createSlot.position
  };
  if (!w20CreateReservationId_(claim.attemptId)) throw new W19Error_('RESERVATION_INVALID', 'Не удалось привязать резерв.', false);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new W19Error_('BUSY', 'Сервис занят привязкой файла.', true);
  try {
    var lockedProps = PropertiesService.getScriptProperties();
    var existingClaim = w20ReadCreateReservation_(lockedProps, claimKey);
    if (existingClaim) {
      if (existingClaim.status === 'claimed' && existingClaim.reservationId === reservationId &&
          existingClaim.createRequestId === requestId && existingClaim.canonicalHash === canonicalHash && existingClaim.fileId === slot.fileId) {
        return { claim: existingClaim, taskMeta: null, recovered: true };
      }
      throw new W19Error_('RESERVATION_CONFLICT', 'Резерв уже привязан к другому запросу.', false);
    }
    var current = w20ReadCreateReservation_(lockedProps, slotKey);
    if (!current || current.status !== 'prepared' || current.reservationId !== reservationId || current.fileId !== slot.fileId ||
        current.taskId !== task || current.section !== section) {
      throw new W19Error_('RESERVATION_STALE', 'Резерв уже изменился.', false);
    }
    var ledgerKey = w19IdempotencyLedgerKey_(idem);
    var ledger = w19ReadLedger_(lockedProps, ledgerKey);
    if (!ledger || ledger.status !== 'pending' || String(ledger.attemptId || '').toLowerCase() !== claim.attemptId) {
      throw new W19Error_('RESERVATION_LEDGER_STALE', 'Запрос на создание уже изменился.', true);
    }
    ledger.reservationRef = claimKey;
    var serializedClaim = JSON.stringify(claim);
    var updates = {};
    updates[slotKey] = serializedClaim;
    updates[claimKey] = serializedClaim;
    updates[ledgerKey] = JSON.stringify(ledger);
    lockedProps.setProperties(updates);
  } finally {
    lock.releaseLock();
  }
  return { claim: claim, taskMeta: createSlot.taskMeta,
    preparedDrive: w20RecentlyVerifiedPreparedDrive_(preparedDrive, preparedDriveVerifiedAt, slot.preparedName), recovered: false };
}

function w20ResolveCreateReservation_(taskId, section, requestId, suppliedReservationId, idem) {
  var supplied = w20CreateReservationId_(suppliedReservationId);
  var canonicalHash = w19Hash_(idem);
  var expectedClaimKey = w20CreateClaimKey_(canonicalHash);
  var ledger = w19ReadIdempotencyStatus_(idem);
  var ledgerClaimRef = w20CreateReservationRef_(ledger && ledger.reservationRef);
  if (supplied && requestId !== supplied) {
    throw new W19Error_('RESERVATION_REQUEST_MISMATCH', 'Запрос не совпал с одноразовым резервом.', false);
  }
  var durable = w20ReadClaimedReservation_(canonicalHash);
  if (ledgerClaimRef && ledgerClaimRef !== expectedClaimKey) {
    throw new W19Error_('RESERVATION_CONFLICT', 'Журнал запроса ссылается на другой резерв.', false);
  }
  if (ledgerClaimRef && !durable) {
    throw new W19Error_('RESERVATION_CLAIM_MISSING', 'Точная привязка резерва недоступна; создание дубля заблокировано.', false);
  }
  if (durable) {
    if (durable.taskId !== WidgetV19Core.compactUuid(taskId) || durable.section !== section ||
        durable.createRequestId !== requestId || durable.reservationId !== requestId || durable.canonicalHash !== canonicalHash ||
        (supplied && durable.reservationId !== supplied)) {
      throw new W19Error_('RESERVATION_CONFLICT', 'Запрос уже привязан к другому резерву.', false);
    }
    return durable.reservationId;
  }
  var slot = w20ReadCreateReservation_(PropertiesService.getScriptProperties(), w20CreateReservationKey_(taskId, section));
  if (supplied) {
    if (!slot || slot.reservationId !== supplied) throw new W19Error_('RESERVATION_STALE', 'Резерв файла больше не актуален.', false);
    return supplied;
  }
  if (slot) {
    if (slot.status === 'prepared' && requestId === slot.reservationId) return slot.reservationId;
    if (slot.status === 'claimed' && slot.createRequestId === requestId && slot.canonicalHash === canonicalHash) return slot.reservationId;
    throw new W19Error_('RESERVATION_REQUIRED', 'Готовый файл уже подготовлен; обновите виджет перед созданием.', true);
  }
  var driveEvidence = w20FindPreparedReservationFiles_(taskId, section, '');
  if (driveEvidence.length) {
    throw new W19Error_('RESERVATION_REQUIRED', 'Готовый файл требует повторной синхронизации.', true);
  }
  return '';
}

function w20RecentlyVerifiedPreparedDrive_(drive, verifiedAt, preparedName) {
  var age = Date.now() - Number(verifiedAt || 0);
  var observedRename = drive && String(drive.name || '') !== String(preparedName || '');
  return observedRename && isFinite(age) && age >= 0 && age <= 1000 ? drive : null;
}

function w20TransitionClaimedReservationFile_(claim, name, cfg, preparedDrive) {
  var current = preparedDrive || w19GetDriveMetadata_(claim.fileId);
  var alreadyClaimed = w20ClaimedCreateFile_(current, claim);
  if (alreadyClaimed) return alreadyClaimed.file;
  var prepared = claim.schema === W20_CREATE_RESERVATION_V2_SCHEMA ?
    w20PreparedCreateFileV2_(current, claim.taskId, claim.section, claim.reservationId, claim.clientHash,
      claim.generation, claim.navigateUntil, cfg.rootFolderId) :
    w20PreparedCreateFile_(current, claim.taskId, claim.section, claim.reservationId, cfg.rootFolderId);
  if (!prepared) {
    throw new W19Error_('RESERVATION_FILE_INVALID', 'Резервный файл не прошёл точную проверку.', false);
  }
  var updateError = null;
  var updated = null;
  try {
    var updateResource = {
      appProperties: {
        widgetVersion: W20_DRIVE_MARKER,
        taskPageId: claim.taskId,
        widgetIdem: claim.canonicalHash.slice(0, 40),
        materialState: 'active',
        createReservationSection: null,
        createReservationId: null,
        createReservationState: null,
        createReservationClient: null,
        createReservationGeneration: null,
        createReservationNavigateUntil: null
      }
    };
    if (String(current.name || '') === String(claim.preparedName || '')) {
      updateResource.name = WidgetV19Core.cleanName(name, w19DefaultGoogleName_(claim.section));
    }
    updated = Drive.Files.update(updateResource, claim.fileId, null, {
      addParents: claim.folderId,
      removeParents: cfg.rootFolderId,
      fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,ownedByMe,trashed,parents,appProperties'
    });
  } catch (err) {
    updateError = err;
  }
  var verified = w20ClaimedCreateFile_(updated, claim);
  if (verified) return verified.file;
  var after = w19GetDriveMetadata_(claim.fileId);
  verified = w20ClaimedCreateFile_(after, claim);
  if (verified) return verified.file;
  throw new W19Error_('RESERVATION_TRANSITION_UNCERTAIN', 'Перенос резервного файла не подтверждён. Повтор продолжит тот же файл.', true, {
    reason: String(updateError && updateError.message || '').slice(0, 200)
  });
}

function w20TaskForClaimedReservation_(taskId, claim, taskMeta, cfg) {
  var meta = taskMeta || w20RegistryReadFreshTaskMeta_(taskId);
  if (meta && meta.folderId === claim.folderId) return w20TaskFromRegistryMeta_(taskId, meta);
  w19AssertSchema_(cfg);
  return w19AssertTaskPage_(taskId, cfg);
}

function w20CreateGoogleFromReservation_(taskId, section, name, requestId, reservationId, idem, cfg, idempotencyState, reservationV2) {
  var bound = reservationV2 ?
    w20ClaimCreateReservationV2_(taskId, section, requestId, reservationV2, idem, cfg, idempotencyState && idempotencyState.attemptId) :
    w20ClaimCreateReservation_(taskId, section, requestId, reservationId, idem, cfg, idempotencyState && idempotencyState.attemptId);
  var claim = bound.claim;
  if (bound.recovered || idempotencyState && idempotencyState.recovery) {
    w19AssertSchema_(cfg);
    var existing = w19FindMaterialByIdempotency_(taskId, idem, cfg);
    if (existing) {
      var existingMaterial = w19MaterialFromPage_(existing);
      if (existingMaterial.googleFileId !== claim.fileId || existingMaterial.section !== section ||
          existingMaterial.provider !== 'Google Drive' || existingMaterial.archived ||
          existingMaterial.syncStatus === 'deleting' || existingMaterial.syncStatus === 'deleted') {
        throw new W19Error_('RESERVATION_MATERIAL_CONFLICT', 'Резерв не совпал с сохранённым знанием.', false);
      }
      var existingDrive = w19GetDriveMetadata_(claim.fileId);
      if (!w20ClaimedCreateFile_(existingDrive, claim, existing.id)) {
        throw new W19Error_('RESERVATION_FILE_INVALID', 'Сохранённый файл не прошёл точную проверку.', false);
      }
      w19MarkDriveNotionPage_(existingDrive, taskId, claim.canonicalHash.slice(0, 40), existing.id, 'active');
      return { material: w20MaterialWithRuntimeMetadata_(existingMaterial, existingDrive), duplicate: true };
    }
  }
  var driveFile = w20TransitionClaimedReservationFile_(claim, name, cfg, bound.preparedDrive);
  if (!w20WriteCreateDriveReady_(idem, idempotencyState.attemptId, driveFile, section)) {
    throw new W19Error_('RESERVATION_LEDGER_STALE', 'Не удалось зафиксировать готовый файл.', true);
  }
  var task = w20TaskForClaimedReservation_(taskId, claim, bound.taskMeta, cfg);
  var page = w20CreateGoogleNotionPage_(task, driveFile, claim.folderId, section, driveFile.name || name, claim.position, idem, cfg);
  w19MarkDriveNotionPage_(driveFile, taskId, claim.canonicalHash.slice(0, 40), page.id, 'active');
  return { material: w20MaterialWithRuntimeMetadata_(w19MaterialFromPage_(page), driveFile), duplicate: false };
}

function w20ReleaseClaimedCreateReservation_(taskId, section, requestId, idem, material) {
  var canonicalHash = w19Hash_(idem);
  var claimKey = w20CreateClaimKey_(canonicalHash);
  var fileId = w20SafeDriveId_(material && material.googleFileId);
  var pageId = WidgetV19Core.normalizeUuid(material && material.id);
  if (!claimKey || !fileId || !pageId) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    var claim = w20ReadCreateReservationV2_(props, claimKey) || w20ReadCreateReservation_(props, claimKey);
    if (!claim || (claim.status !== 'claimed' && claim.status !== 'done') || claim.taskId !== WidgetV19Core.compactUuid(taskId) ||
        claim.section !== section || claim.createRequestId !== requestId || claim.canonicalHash !== canonicalHash || claim.fileId !== fileId) return false;
    var done = {};
    Object.keys(claim).forEach(function (key) { done[key] = claim[key]; });
    done.status = 'done';
    done.at = Date.now();
    done.notionPageId = pageId;
    props.setProperty(claimKey, JSON.stringify(done));
    if (claim.schema === W20_CREATE_RESERVATION_SCHEMA) {
      var slotKey = w20CreateReservationKey_(taskId, section);
      var slot = w20ReadCreateReservation_(props, slotKey);
      if (slot && slot.status === 'claimed' && slot.reservationId === claim.reservationId &&
          slot.createRequestId === requestId && slot.canonicalHash === canonicalHash && slot.fileId === fileId) props.deleteProperty(slotKey);
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

function w20RefreshKnownTaskFolderProof_(taskId, meta, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var compactTask = WidgetV19Core.compactUuid(task);
  var folderId = w20SafeDriveId_(meta && meta.folderId);
  var rootFolderId = w20SafeDriveId_(cfg && cfg.rootFolderId);
  if (!task || !compactTask || !folderId || !rootFolderId || !meta.folderVerified || meta.rootFolderId !== rootFolderId) return false;
  var folder = w19GetDriveMetadata_(folderId);
  var markers = folder && folder.appProperties || {};
  var parents = folder && Array.isArray(folder.parents) ? folder.parents : [];
  var markerOk = markers.widgetVersion === W20_DRIVE_MARKER || markers.widgetVersion === 'v19';
  if (!folder || folder.trashed || folder.ownedByMe !== true ||
      folder.mimeType !== 'application/vnd.google-apps.folder' || parents.indexOf(rootFolderId) === -1 ||
      !markerOk || markers.taskPageId !== compactTask) return false;
  return w20RegistryWriteFolderProof_(task, {
    folderId: folderId,
    rootFolderId: rootFolderId,
    folderVerified: true,
    folderValidatedAt: new Date().toISOString()
  });
}

function w20WarmTaskFolderProof_(taskId, cfg) {
  return w19WithMutationLock_(function () {
    var current = w20RegistryReadFreshTaskMeta_(taskId);
    if (!current) return false;
    if (w20RegistryFolderMetaFresh_(current, cfg.rootFolderId)) return true;
    if (w20RefreshKnownTaskFolderProof_(taskId, current, cfg)) return true;
    var task = w20TaskFromRegistryMeta_(taskId, current);
    var folder = w19EnsureTaskFolder_(task, cfg);
    return Boolean(w20RegistryWriteFolderProof_(taskId, {
      folderId: folder.id,
      rootFolderId: cfg.rootFolderId,
      folderVerified: true,
      folderValidatedAt: new Date().toISOString()
    }));
  });
}

function apiCreateGoogle(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var taskId = w20AssertAuthorizedTaskId_(input && input.taskPageId, cfg);
    var section = WidgetV19Core.assertSection(input && input.section);
    if (section === 'Drive') throw new W19Error_('INVALID_CREATE_TYPE', 'Карточка Drive открывает папку; для нового файла выберите Docs, Sheets или Slides.', false);
    var name = WidgetV19Core.cleanName(input && input.name, w19DefaultGoogleName_(section));
    var requestId = w19ValidateClientKey_(input && input.idempotencyKey).toLowerCase();
    var rawReservationId = String(input && input.reservationId || '').trim();
    var suppliedReservationId = w20CreateReservationId_(rawReservationId);
    var rawClientId = String(input && input.clientId || '');
    var clientId = w20CreateClientId_(rawClientId);
    var hasV2Tuple = Boolean(input && (input.openUrl || input.preparedName || input.generation !== undefined || input.navigateUntil || input.reservationProof));
    if (rawClientId && !clientId) throw new W19Error_('CREATE_CLIENT_INVALID', 'Идентификатор браузера повреждён.', false);
    if (rawReservationId && !suppliedReservationId) throw new W19Error_('RESERVATION_INVALID', 'Резерв файла повреждён.', false);
    if (suppliedReservationId && suppliedReservationId !== requestId) {
      throw new W19Error_('RESERVATION_REQUEST_MISMATCH', 'Запрос не совпал с одноразовым резервом.', false);
    }
    if (hasV2Tuple && (!clientId || !suppliedReservationId)) {
      throw new W19Error_('RESERVATION_V2_INVALID', 'Данные долгоживущего резерва неполные.', false);
    }
    if (clientId && suppliedReservationId && !hasV2Tuple) {
      throw new W19Error_('RESERVATION_V2_INVALID', 'Данные долгоживущего резерва неполные.', false);
    }
    var reservationV2 = clientId && suppliedReservationId ?
      w20CreateReservationV2DescriptorFromInput_(input, taskId, section, cfg) : null;
    var idem = w19CanonicalIdempotency_(taskId, 'create-google-' + section, requestId);
    var knownMaterial = w20RegistryFindCreateRequest_(taskId, section, requestId);
    if (knownMaterial) {
      w20ReleaseClaimedCreateReservation_(taskId, section, requestId, idem, knownMaterial);
      return { material: w20MaterialForClient_(knownMaterial, taskId, cfg), duplicate: true };
    }
    var resolvedV2 = clientId ? w20ResolveCreateReservationV2_(taskId, section, requestId, reservationV2, idem, clientId) : null;
    var reservationId = resolvedV2 ? resolvedV2.reservationId :
      clientId ? '' : w20ResolveCreateReservation_(taskId, section, requestId, suppliedReservationId, idem);
    var outcome = w19WithIdempotency_(idem, function (idempotencyState) {
      if (resolvedV2 || reservationId) {
        return w20CreateGoogleFromReservation_(taskId, section, name, requestId, reservationId, idem, cfg, idempotencyState, resolvedV2);
      }
      if (!(idempotencyState && idempotencyState.recovery)) {
        var slot = w20RegistryClaimCreateSlot_(taskId, section, cfg.rootFolderId);
        if (slot) return w20CreateGoogleHot_(taskId, section, name, idem, slot, cfg, idempotencyState.attemptId);
      }
      return w20CreateGoogleRecovery_(taskId, section, name, idem, cfg, idempotencyState.attemptId);
    });
    if (outcome && outcome.completed && !outcome.material) {
      var completedMaterial = w20RegistryFindCreateRequest_(taskId, section, requestId);
      if (completedMaterial) outcome = { material: completedMaterial, duplicate: true };
      else if (resolvedV2 || reservationId) {
        var completedClaim = w20ReadClaimedReservation_(w19Hash_(idem));
        if (!completedClaim) throw new W19Error_('RESERVATION_CLAIM_MISSING', 'Точная привязка резерва недоступна.', false);
        outcome = w20CreateGoogleFromReservation_(taskId, section, name, requestId, reservationId, idem, cfg, {
          recovery: true,
          attemptId: completedClaim.attemptId
        }, resolvedV2);
      } else outcome = w20CreateGoogleRecovery_(taskId, section, name, idem, cfg);
    }
    if (outcome && outcome.material) {
      w20ReleaseClaimedCreateReservation_(taskId, section, requestId, idem, outcome.material);
      outcome.material = w20MaterialForClient_(outcome.material, taskId, cfg);
      w20RegistryUpsert_(taskId, outcome.material);
    }
    return outcome;
  });
}

function apiGetCreateStatus(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var taskId = w20AssertAuthorizedTaskId_(input && input.taskPageId, cfg);
    var section = WidgetV19Core.assertSection(input && input.section);
    if (section === 'Drive') throw new W19Error_('INVALID_CREATE_TYPE', 'Нельзя создать файл в разделе Drive.', false);
    var requestId = w19ValidateClientKey_(input && input.createRequestId).toLowerCase();
    var idem = w19CanonicalIdempotency_(taskId, 'create-google-' + section, requestId);
    var ledger = w19ReadIdempotencyStatus_(idem);
    var material = null;
    var storedMaterial = null;
    if (ledger && ledger.status === 'done' && ledger.data && ledger.data.material) {
      storedMaterial = ledger.data.material;
      material = w20MaterialForClient_(storedMaterial, taskId, cfg);
    } else {
      var registryMaterial = w20RegistryFindCreateRequest_(taskId, section, requestId);
      if (registryMaterial) {
        storedMaterial = registryMaterial;
        material = w20MaterialForClient_(registryMaterial, taskId, cfg);
      }
    }
    if (material) {
      w20ReleaseClaimedCreateReservation_(taskId, section, requestId, idem, storedMaterial);
      return { status: 'done', material: material };
    }
    if (ledger && ledger.status === 'failed' && ledger.retryable !== true) {
      return { status: 'failed', retryable: false };
    }
    var driveReadyUrl = w20CreateDriveReadyUrl_(ledger);
    if (driveReadyUrl) return { status: 'drive_ready', openUrl: driveReadyUrl, retryable: true };
    var durableClaim = w20ReadClaimedReservation_(w19Hash_(idem));
    if (durableClaim && durableClaim.taskId === WidgetV19Core.compactUuid(taskId) && durableClaim.section === section &&
        durableClaim.createRequestId === requestId.toLowerCase() && durableClaim.reservationId === requestId.toLowerCase()) {
      var claimedFile = w19GetDriveMetadata_(durableClaim.fileId);
      var expectedPageId = durableClaim.status === 'done' ? durableClaim.notionPageId : undefined;
      var exactClaimed = w20ClaimedCreateFile_(claimedFile, durableClaim, expectedPageId);
      if (exactClaimed) return { status: 'drive_ready', openUrl: exactClaimed.openUrl, retryable: true };
    }
    if (!ledger) return { status: 'missing' };
    if (ledger.status === 'pending') {
      return { status: 'pending', retryable: true };
    }
    if (ledger.status === 'failed') return { status: 'failed', retryable: ledger.retryable === true };
    return { status: ledger.status === 'done' ? 'done' : 'missing' };
  });
}

function apiRepairCreateMarker(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var taskId = w20AssertAuthorizedTaskId_(input && input.taskPageId, cfg);
    var section = WidgetV19Core.assertSection(input && input.section);
    if (section === 'Drive') throw new W19Error_('INVALID_CREATE_TYPE', 'Нельзя создать файл в разделе Drive.', false);
    var requestId = w19ValidateClientKey_(input && input.createRequestId).toLowerCase();
    var idem = w19CanonicalIdempotency_(taskId, 'create-google-' + section, requestId);
    return w19WithMutationLock_(function () {
      var ledger = w19ReadIdempotencyStatus_(idem);
      var material = ledger && ledger.status === 'done' && ledger.data && ledger.data.material ||
        w20RegistryFindCreateRequest_(taskId, section, requestId);
      if (!material || !material.id || !material.googleFileId || material.provider !== 'Google Drive' ||
          (cfg.deniedPageIds && cfg.deniedPageIds[material.id])) return { repaired: false };
      var page = w19AssertMaterialForTask_(material.id, taskId, cfg);
      var current = w19MaterialFromPage_(page);
      if (current.idempotency !== idem || current.googleFileId !== material.googleFileId ||
          current.archived || current.syncStatus === 'deleting' || current.syncStatus === 'deleted') return { repaired: false };
      var drive = w19GetDriveMetadata_(current.googleFileId);
      var markers = drive && drive.appProperties || {};
      var idemHash = w19Hash_(idem).slice(0, 40);
      if (!drive || drive.trashed || markers.widgetVersion !== W20_DRIVE_MARKER ||
          markers.taskPageId !== WidgetV19Core.compactUuid(taskId) || markers.widgetIdem !== idemHash ||
          !w20IsDriveMaterialActive_(markers)) return { repaired: false };
      if (WidgetV19Core.compactUuid(markers.notionPageId) === WidgetV19Core.compactUuid(current.id)) return { repaired: true };
      return { repaired: w19MarkDriveNotionPage_(drive, taskId, idemHash, current.id, 'active') === true };
    });
  });
}

function apiWarmCreateContext(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var taskId = w20AssertAuthorizedTaskId_(input && input.taskPageId, cfg);
    var rawClientId = String(input && input.clientId || '');
    var clientId = w20CreateClientId_(rawClientId);
    if (rawClientId && !clientId) throw new W19Error_('CREATE_CLIENT_INVALID', 'Идентификатор браузера повреждён.', false);
    var proofOnly = Boolean(input && input.proofOnly === true);
    var requestedSection = '';
    if (input && Object.prototype.hasOwnProperty.call(input, 'section')) {
      requestedSection = w20CreateReservationSection_(input.section);
      if (!requestedSection) throw new W19Error_('INVALID_CREATE_TYPE', 'Можно подготовить только Google Docs, Sheets или Slides.', false);
    }
    if (proofOnly && requestedSection) {
      throw new W19Error_('INVALID_WARM_REQUEST', 'Проверка контекста и подготовка файла выполняются отдельными запросами.', false);
    }
    var meta = w20RegistryReadFreshTaskMeta_(taskId);
    if (!meta) return { ready: false, preparedCreates: [] };
    var folderWasCached = w20RegistryFolderMetaFresh_(meta, cfg.rootFolderId);
    if (!folderWasCached) {
      var folderReady = w20WarmTaskFolderProof_(taskId, cfg);
      if (!folderReady) return { ready: false, cached: false, preparedCreates: [] };
      meta = w20RegistryReadFreshTaskMeta_(taskId);
    }
    var registry = w20RegistryReadTaskResult_(taskId, null);
    var proof = w20RegistryActionProof_(meta, registry, cfg.rootFolderId);
    if (!proof.ready) return { ready: false, cached: folderWasCached, preparedCreates: [] };
    return {
      ready: true,
      cached: folderWasCached,
      folderUrl: 'https://drive.google.com/drive/folders/' + encodeURIComponent(meta.folderId),
      trustedUntil: proof.trustedUntil,
      preparedCreates: clientId ?
        (proofOnly ? w20PreparedCreatePoolV2Snapshot_(taskId, clientId, cfg) :
          requestedSection ? w20WarmCreateSectionV2_(taskId, clientId, requestedSection, cfg) : w20WarmCreatePoolV2_(taskId, clientId, cfg)) :
        (proofOnly ? w20PreparedCreatePoolSnapshot_(taskId) :
          requestedSection ? w20WarmCreateSection_(taskId, requestedSection, cfg) : w20WarmCreatePool_(taskId, cfg))
    };
  });
}

function w20AssertAuthorizedTaskId_(value, cfg) {
  var taskId = WidgetV19Core.normalizeUuid(value);
  if (!taskId) throw new W19Error_('TASK_ID_REQUIRED', 'В URL виджета отсутствует корректный task_page_id.', false);
  if (taskId !== cfg.authorizedTaskPageId || (cfg.deniedPageIds && cfg.deniedPageIds[taskId])) {
    throw new W19Error_('WRITE_BARRIER', 'Эта задача запрещена write barrier.', false);
  }
  return taskId;
}

function w20TaskFromRegistryMeta_(taskId, meta) {
  var context = meta && meta.context || {};
  var props = {};
  function relation(ids) {
    return { relation: (Array.isArray(ids) ? ids : []).map(function (id) { return { id: id }; }) };
  }
  props[W19_P.CONTEXT_SPHERE] = relation(context.sphereIds);
  props[W19_P.CONTEXT_DIRECTION] = relation(context.directionIds);
  props[W19_P.CONTEXT_PROJECT] = relation(context.projectIds);
  props[W19_P.CONTEXT_PATH] = w19Text_(context.path || '');
  props[W19_P.ANCESTOR_IDS] = w19Text_(context.ancestorIds || '');
  props[W19_P.DEPTH] = { number: Number(context.depth || 0) };
  return {
    id: taskId,
    name: WidgetV19Core.cleanName(meta && meta.taskName, 'Задача'),
    page: { properties: props }
  };
}

function w20CreateGoogleHot_(taskId, section, name, idem, slot, cfg, attemptId) {
  var task = w20TaskFromRegistryMeta_(taskId, slot.taskMeta);
  var idemHash = w19Hash_(idem).slice(0, 40);
  var driveFile = w19CreateGoogleFile_(task, slot.taskMeta.folderId, section, name, idemHash);
  w20WriteCreateDriveReady_(idem, attemptId, driveFile, section);
  var page = w20CreateGoogleNotionPage_(task, driveFile, slot.taskMeta.folderId, section, name, slot.position, idem, cfg);
  return { material: w20MaterialWithRuntimeMetadata_(w19MaterialFromPage_(page), driveFile), duplicate: false };
}

function w20CreateGoogleRecovery_(taskId, section, name, idem, cfg, attemptId) {
  w19AssertSchema_(cfg);
  var task = w19AssertTaskPage_(taskId, cfg);
  var taskValidatedAt = new Date().toISOString();
  return w19WithMutationLock_(function () {
    var idemHash = w19Hash_(idem).slice(0, 40);
    var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg);
    if (existing) {
      var existingMaterial = w19MaterialFromPage_(existing);
      if (existingMaterial.googleFileId && existingMaterial.widgetOwned) {
        var existingDrive = w19GetDriveMetadata_(existingMaterial.googleFileId);
        if (existingDrive) {
          w19MarkDriveNotionPage_(existingDrive, task.id, idemHash, existing.id, w20DriveStateForMaterial_(existingMaterial));
          existingMaterial = w20MaterialWithRuntimeMetadata_(existingMaterial, existingDrive);
        }
      }
      return { material: existingMaterial, duplicate: true };
    }

    var folder = w19EnsureTaskFolder_(task, cfg);
    w20RegistryWriteTaskMeta_(task.id, {
      taskName: task.name,
      folderId: folder.id,
      rootFolderId: cfg.rootFolderId,
      folderVerified: true,
      folderValidatedAt: new Date().toISOString(),
      taskValidatedAt: taskValidatedAt,
      context: w20TaskContextSnapshot_(task)
    });
    var driveFile = w19FindDriveByIdempotency_(task.id, idemHash);
    var driveWasExisting = Boolean(driveFile);
    if (!driveFile) driveFile = w19CreateGoogleFile_(task, folder.id, section, name, idemHash);

    if (driveWasExisting) {
      var byFile = w19FindMaterialByGoogleFile_(task.id, driveFile.id, cfg);
      if (byFile) {
        var byFileMaterial = w19MaterialFromPage_(byFile);
        w19MarkDriveNotionPage_(driveFile, task.id, idemHash, byFile.id, w20DriveStateForMaterial_(byFileMaterial));
        return { material: w20MaterialWithRuntimeMetadata_(byFileMaterial, driveFile), duplicate: true };
      }
    }

    w20WriteCreateDriveReady_(idem, attemptId, driveFile, section);
    var page = w20CreateGoogleNotionPage_(task, driveFile, folder.id, section, name,
      w19NextPosition_(task.id, section, cfg), idem, cfg);
    w19MarkDriveNotionPage_(driveFile, task.id, idemHash, page.id, 'active');
    return { material: w20MaterialWithRuntimeMetadata_(w19MaterialFromPage_(page), driveFile), duplicate: false };
  });
}

function w20CreateGoogleNotionPage_(task, driveFile, folderId, section, name, position, idem, cfg) {
  var format = section === 'Docs' ? 'Google Docs' : (section === 'Sheets' ? 'Google Sheets' : 'Google Slides');
  return w19CreateNotionMaterial_(task, {
    name: driveFile.name || name,
    sourceUrl: driveFile.webViewLink || WidgetV19Core.makeDriveOpenUrl(driveFile.id, format),
    normalizedUrl: '',
    knowledgeFormat: 'Файл',
    format: format,
    section: section,
    provider: 'Google Drive',
    googleFileId: driveFile.id,
    googleFolderId: folderId,
    mimeType: driveFile.mimeType || WidgetV19Core.GOOGLE_MIME[section],
    size: driveFile.size ? Number(driveFile.size) : null,
    driveMd5: driveFile.md5Checksum || '',
    downloadName: driveFile.name || name,
    position: position,
    idempotency: idem
  }, cfg);
}

function apiAddLink(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    w19AssertSchema_(cfg);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var normalized = WidgetV19Core.normalizeExternalUrl(input && input.url);
    if (!normalized) throw new W19Error_('INVALID_URL', 'Нужна корректная HTTPS-ссылка.', false);
    var googleFileId = WidgetV19Core.extractGoogleFileId(normalized) || '';
    if (WidgetV19Core.isGoogleDriveUrl(normalized) && !googleFileId) {
      throw new W19Error_('GOOGLE_LINK_INVALID', 'В Google-ссылке не найден ID документа или файла.', false);
    }
    var linkData;
    if (googleFileId) {
      linkData = w19ResolveGoogleLink_(googleFileId, normalized);
    } else {
      var detected = WidgetV19Core.classify({ url: normalized, isLink: true });
      linkData = {
        name: WidgetV19Core.cleanName(input && input.name, w19HostLabel_(normalized)),
        sourceUrl: normalized,
        normalizedUrl: normalized,
        knowledgeFormat: detected.knowledgeFormat,
        format: detected.format,
        section: input && input.section ? WidgetV19Core.assertSection(input.section) : detected.section,
        provider: detected.provider,
        googleFileId: '',
        mimeType: '',
        size: null,
        driveMd5: ''
      };
    }
    var idem = w19CanonicalIdempotency_(task.id, 'add-link', input && input.idempotencyKey);
    var outcome = w19WithIdempotency_(idem, function () {
      return w19WithMutationLock_(function () {
        var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg) ||
          (googleFileId ? w19FindMaterialByGoogleFile_(task.id, googleFileId, cfg) : null) ||
          w19FindMaterialBySourceUrl_(task.id, linkData.normalizedUrl, cfg);
        if (existing) {
          var existingMaterial = w19MaterialFromPage_(existing);
          if (existingMaterial.syncStatus === 'deleted') {
            throw new W19Error_('MATERIAL_DELETED', 'Эта ссылка относится к физически удалённому материалу и не может быть восстановлена.', false);
          }
          if (existingMaterial.archived) {
            var restoreProps = {};
            restoreProps[W19_P.ARCHIVE] = { checkbox: false };
            restoreProps[W19_P.SYNC_STATUS] = w19Select_('synced');
            restoreProps[W19_P.POSITION] = { number: w19NextPosition_(task.id, existingMaterial.section, cfg) };
            existing = w19UpdateNotionPage_(existing.id, restoreProps, cfg);
            return { material: w19MaterialFromPage_(existing), duplicate: true, restored: true };
          }
          return { material: existingMaterial, duplicate: true };
        }
        var page = w19CreateNotionMaterial_(task, {
          name: linkData.name,
          sourceUrl: linkData.sourceUrl,
          normalizedUrl: linkData.normalizedUrl,
          knowledgeFormat: linkData.knowledgeFormat,
          format: linkData.format,
          section: linkData.section,
          provider: linkData.provider,
          googleFileId: linkData.googleFileId,
          googleFolderId: '',
          mimeType: linkData.mimeType,
          size: linkData.size,
          driveMd5: linkData.driveMd5,
          downloadName: linkData.name,
          position: w19NextPosition_(task.id, linkData.section, cfg),
          idempotency: idem
        }, cfg);
        return { material: w19MaterialFromPage_(page), duplicate: false };
      });
    });
    if (outcome && outcome.material) {
      outcome.material = w20MaterialWithRuntimeMetadata_(outcome.material, linkData);
      outcome.material = w20MaterialForClient_(outcome.material, task.id, cfg);
      var registryStored = outcome.restored ? w20RegistryRestore_(task.id, outcome.material) :
        w20RegistryUpsert_(task.id, outcome.material);
      if (outcome.restored && !registryStored) {
        throw new W19Error_('BUSY', 'Восстановление ещё фиксируется. Повторите через несколько секунд.', true);
      }
    }
    return outcome;
  });
}

function apiUpload(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    w19AssertSchema_(cfg);
    var taskId = w20AssertAuthorizedTaskId_(input && input.taskPageId, cfg);
    var maxUploadBytes = Math.floor(Math.min(Number(cfg.maxUploadBytes) || W19_NOTION_SINGLE_PART_MAX_BYTES,
      W19_NOTION_SINGLE_PART_MAX_BYTES));
    var name = WidgetV19Core.cleanName(input && input.name, 'Файл');
    var mime = WidgetV19Core.cleanMime(input && input.mimeType);
    var base64 = String(input && input.dataBase64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new W19Error_('INVALID_UPLOAD', 'Файл не удалось прочитать.', false);
    var estimated = Math.floor(base64.length * 3 / 4);
    if (estimated > maxUploadBytes + 3) throw new W19Error_('FILE_TOO_LARGE', 'Размер файла превышает лимит ' + w19HumanBytes_(maxUploadBytes) + '.', false);
    var bytes = Utilities.base64Decode(base64);
    if (bytes.length > maxUploadBytes) throw new W19Error_('FILE_TOO_LARGE', 'Размер файла превышает лимит ' + w19HumanBytes_(maxUploadBytes) + '.', false);
    var detected = WidgetV19Core.classify({ name: name, mimeType: mime });
    var section = input && input.section ? WidgetV19Core.assertSection(input.section) : detected.section;
    var idem = w19CanonicalIdempotency_(taskId, 'upload', input && input.idempotencyKey);
    var pageForDownloadCache = null;
    var runtimeDriveMetadata = null;
    var outcome = w19WithIdempotency_(idem, function (idempotencyState) {
      return w19WithMutationLock_(function () {
        var idemHash = w19Hash_(idem).slice(0, 40);
        var recoveringAttempt = Boolean(idempotencyState && idempotencyState.recovery);
        var freshAttempt = !recoveringAttempt;
        var slot = freshAttempt ? w20RegistryClaimCreateSlot_(taskId, section, cfg.rootFolderId) : null;
        var task;
        var folder;
        var position;
        var driveFile = null;

        if (slot) {
          var slotFolderId = w20SafeDriveId_(slot.taskMeta && slot.taskMeta.folderId);
          var slotPosition = Number(slot.position);
          if (!slot.taskMeta || !slotFolderId || !isFinite(slotPosition) || slotPosition < 0 || Math.floor(slotPosition) !== slotPosition) {
            throw new W19Error_('UPLOAD_CONTEXT_STALE', 'Контекст загрузки требует обновления.', true);
          }
          task = w20TaskFromRegistryMeta_(taskId, slot.taskMeta);
          folder = { id: slotFolderId };
          position = slotPosition;
        } else {
          task = w19AssertTaskPage_(taskId, cfg);
          if (recoveringAttempt) {
            var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg);
            if (existing) {
              pageForDownloadCache = existing;
              var existingMaterial = w19MaterialFromPage_(existing);
              if (existingMaterial.googleFileId && existingMaterial.widgetOwned) {
                var existingDrive = w19GetDriveMetadata_(existingMaterial.googleFileId);
                if (existingDrive) {
                  runtimeDriveMetadata = existingDrive;
                  w19MarkDriveNotionPage_(existingDrive, task.id, idemHash, existing.id, w20DriveStateForMaterial_(existingMaterial));
                }
              }
              return { material: existingMaterial, duplicate: true };
            }
          }

          folder = w19EnsureTaskFolder_(task, cfg);
          if (recoveringAttempt) {
            driveFile = w19FindDriveByIdempotency_(task.id, idemHash);
          }
          if (driveFile) {
            var byFile = w19FindMaterialByGoogleFile_(task.id, driveFile.id, cfg);
            if (byFile) {
              pageForDownloadCache = byFile;
              var byFileMaterial = w19MaterialFromPage_(byFile);
              runtimeDriveMetadata = driveFile;
              w19MarkDriveNotionPage_(driveFile, task.id, idemHash, byFile.id, w20DriveStateForMaterial_(byFileMaterial));
              return { material: byFileMaterial, duplicate: true };
            }
          }
        }

        if (!driveFile) driveFile = w19CreateBinaryFile_(task, folder.id, name, mime, bytes, idemHash);
        runtimeDriveMetadata = driveFile;
        if (position === undefined) position = w19NextPosition_(task.id, section, cfg);
        var openUrl = driveFile.webViewLink || WidgetV19Core.makeDriveOpenUrl(driveFile.id, detected.format);
        var page = w19CreateNotionMaterial_(task, {
          name: driveFile.name || name,
          sourceUrl: openUrl,
          normalizedUrl: '',
          knowledgeFormat: 'Файл',
          format: detected.format,
          section: section,
          provider: 'Google Drive',
          googleFileId: driveFile.id,
          googleFolderId: folder.id,
          mimeType: driveFile.mimeType || mime,
          size: driveFile.size ? Number(driveFile.size) : bytes.length,
          driveMd5: driveFile.md5Checksum || '',
          downloadName: driveFile.name || name,
          attachments: [],
          position: position,
          idempotency: idem
        }, cfg);
        pageForDownloadCache = page;
        w19MarkDriveNotionPage_(driveFile, task.id, idemHash, page.id, 'active');
        return { material: w19MaterialFromPage_(page), duplicate: false };
      });
    });
    if (outcome && outcome.material && outcome.material.id) {
      if (outcome.material.widgetOwnedBinary && !outcome.material.hostedAttachment) {
        w20TryEnqueueAttachmentJob_(taskId, outcome.material, runtimeDriveMetadata);
      }
      outcome.material = w20MaterialWithRuntimeMetadata_(outcome.material, runtimeDriveMetadata);
      outcome.material = w20MaterialForClient_(outcome.material, taskId, cfg);
      if (pageForDownloadCache) w20CacheDownloadMaterials_(taskId, [pageForDownloadCache], cfg);
      w20RegistryUpsert_(taskId, outcome.material);
    }
    return outcome;
  });
}

function w20AttachmentJobKey_(taskId, pageId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var page = WidgetV19Core.compactUuid(pageId);
  return task && page ? W20_ATTACHMENT_JOB_PREFIX + w19Hash_(task + '|' + page).slice(0, 48) : '';
}

function w20ParseAttachmentJob_(value) {
  var source = value;
  if (typeof value === 'string') {
    try { source = JSON.parse(value); } catch (_parseError) { return null; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  var expected = ['attempts', 'createdAt', 'fileId', 'folderId', 'idemHash', 'lastCode', 'leaseToken', 'leaseUntil',
    'nextAt', 'notionUploadId', 'pageId', 'schema', 'sentMd5', 'sentSize', 'state', 'taskId', 'updatedAt'];
  var keys = Object.keys(source).sort();
  if (keys.length !== expected.length || keys.some(function (key, index) { return key !== expected[index]; })) return null;
  var taskId = WidgetV19Core.normalizeUuid(source.taskId);
  var pageId = WidgetV19Core.normalizeUuid(source.pageId);
  var fileId = w20SafeDriveId_(source.fileId);
  var folderId = w20SafeDriveId_(source.folderId);
  var uploadId = source.notionUploadId ? WidgetV19Core.normalizeUuid(source.notionUploadId) : '';
  var attempts = Number(source.attempts);
  var createdAt = Number(source.createdAt);
  var updatedAt = Number(source.updatedAt);
  var nextAt = Number(source.nextAt);
  var leaseUntil = Number(source.leaseUntil);
  var leaseToken = String(source.leaseToken || '').toLowerCase();
  var lastCode = String(source.lastCode || '');
  var sentMd5 = String(source.sentMd5 || '').toLowerCase();
  var sentSize = Number(source.sentSize);
  if (source.schema !== W20_ATTACHMENT_JOB_SCHEMA || !taskId || !pageId || !fileId || !folderId ||
      !/^[a-f0-9]{40}$/.test(String(source.idemHash || '')) ||
      ['pending', 'error'].indexOf(String(source.state || '')) === -1 ||
      !Number.isSafeInteger(attempts) || attempts < 0 || attempts > 1000 ||
      !Number.isSafeInteger(createdAt) || createdAt <= 0 || !Number.isSafeInteger(updatedAt) || updatedAt <= 0 ||
      !Number.isSafeInteger(nextAt) || nextAt < 0 || !Number.isSafeInteger(leaseUntil) || leaseUntil < 0 ||
      (leaseToken && !w20CreateReservationId_(leaseToken)) || (source.notionUploadId && !uploadId) ||
      (sentMd5 && !/^[a-f0-9]{32}$/.test(sentMd5)) || !Number.isSafeInteger(sentSize) || sentSize < 0 ||
      !/^[A-Z0-9_]{0,80}$/.test(lastCode)) return null;
  return {
    schema: W20_ATTACHMENT_JOB_SCHEMA,
    taskId: taskId,
    pageId: pageId,
    fileId: fileId,
    folderId: folderId,
    idemHash: String(source.idemHash),
    notionUploadId: uploadId,
    sentMd5: sentMd5,
    sentSize: sentSize,
    state: String(source.state),
    attempts: attempts,
    nextAt: nextAt,
    leaseToken: leaseToken,
    leaseUntil: leaseUntil,
    createdAt: createdAt,
    updatedAt: updatedAt,
    lastCode: lastCode
  };
}

function w20AttachmentJobMatches_(job, taskId, pageId, fileId, folderId, idemHash) {
  return Boolean(job && job.taskId === WidgetV19Core.normalizeUuid(taskId) && job.pageId === WidgetV19Core.normalizeUuid(pageId) &&
    job.fileId === w20SafeDriveId_(fileId) && job.folderId === w20SafeDriveId_(folderId) && job.idemHash === String(idemHash || ''));
}

function w20PruneAttachmentJobsUnlocked_(props, all, now) {
  var removed = 0;
  Object.keys(all || {}).forEach(function (key) {
    if (key.indexOf(W20_ATTACHMENT_JOB_PREFIX) !== 0) return;
    var job = w20ParseAttachmentJob_(all[key]);
    if (!job || now - job.createdAt > W20_ATTACHMENT_JOB_TTL_MS) {
      props.deleteProperty(key);
      delete all[key];
      removed += 1;
    }
  });
  return removed;
}

function w20PruneAttachmentJobs_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    return w20PruneAttachmentJobsUnlocked_(props, all, Date.now());
  } finally {
    lock.releaseLock();
  }
}

function w20EnqueueAttachmentJob_(taskId, material, drive) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(material && material.id);
  var fileId = w20SafeDriveId_(material && material.googleFileId);
  var folderId = w20SafeDriveId_(material && material.folderId);
  var canonicalIdem = String(material && material.idempotency || '');
  var idemHash = canonicalIdem ? w19Hash_(canonicalIdem).slice(0, 40) : '';
  var key = w20AttachmentJobKey_(task, page);
  if (!task || !page || !fileId || !folderId || !key || !/^[a-f0-9]{40}$/.test(idemHash) ||
      !material.widgetOwnedBinary || material.provider !== 'Google Drive' || material.archived ||
      ['deleting', 'deleted'].indexOf(String(material.syncStatus || '')) !== -1 ||
      drive && w20SafeDriveId_(drive.id) !== fileId) {
    throw new W19Error_('ATTACHMENT_JOB_INVALID', 'Не удалось поставить вложение в безопасную очередь.', false);
  }
  var now = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(100)) throw new W19Error_('BUSY', 'Очередь вложений занята. Повторите операцию.', true);
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    w20PruneAttachmentJobsUnlocked_(props, all, now);
    var existing = w20ParseAttachmentJob_(all[key]);
    if (existing) {
      if (!w20AttachmentJobMatches_(existing, task, page, fileId, folderId, idemHash)) {
        throw new W19Error_('ATTACHMENT_JOB_CONFLICT', 'Очередь уже привязана к другому файлу.', false);
      }
      return existing;
    }
    var count = Object.keys(all).filter(function (propertyKey) {
      return propertyKey.indexOf(W20_ATTACHMENT_JOB_PREFIX) === 0;
    }).length;
    if (count >= W20_ATTACHMENT_JOB_MAX) {
      throw new W19Error_('ATTACHMENT_QUEUE_FULL', 'Очередь вложений заполнена. Повторите позже.', true);
    }
    var job = {
      schema: W20_ATTACHMENT_JOB_SCHEMA,
      taskId: task,
      pageId: page,
      fileId: fileId,
      folderId: folderId,
      idemHash: idemHash,
      notionUploadId: '',
      sentMd5: '',
      sentSize: 0,
      state: 'pending',
      attempts: 0,
      nextAt: now,
      leaseToken: '',
      leaseUntil: 0,
      createdAt: now,
      updatedAt: now,
      lastCode: ''
    };
    props.setProperty(key, JSON.stringify(job));
    return job;
  } finally {
    lock.releaseLock();
  }
}

function w20TryEnqueueAttachmentJob_(taskId, material, drive) {
  try { return w20EnqueueAttachmentJob_(taskId, material, drive); }
  catch (queueError) {
    w19Audit_('attachment_queue_deferred', {
      code: String(queueError && queueError.code || 'QUEUE_UNAVAILABLE').replace(/[^A-Z0-9_]/gi, '').slice(0, 80)
    });
    return null;
  }
}

function w20ReadAttachmentJob_(taskId, pageId) {
  var key = w20AttachmentJobKey_(taskId, pageId);
  return key ? w20ParseAttachmentJob_(PropertiesService.getScriptProperties().getProperty(key)) : null;
}

function w20ClaimAttachmentJob_(taskId, pageId) {
  var key = w20AttachmentJobKey_(taskId, pageId);
  if (!key) return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var props = PropertiesService.getScriptProperties();
    var job = w20ParseAttachmentJob_(props.getProperty(key));
    var now = Date.now();
    if (!job || job.state !== 'pending' || job.nextAt > now || job.leaseUntil > now) return null;
    job.leaseToken = String(Utilities.getUuid()).toLowerCase();
    job.leaseUntil = now + W20_ATTACHMENT_JOB_LEASE_MS;
    job.updatedAt = now;
    props.setProperty(key, JSON.stringify(job));
    return { key: key, job: job };
  } finally {
    lock.releaseLock();
  }
}

function w20WriteClaimedAttachmentJob_(claimed, update) {
  if (!claimed || !claimed.key || !claimed.job || !w20CreateReservationId_(claimed.job.leaseToken)) return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w20ParseAttachmentJob_(props.getProperty(claimed.key));
    if (!current || current.leaseToken !== claimed.job.leaseToken ||
        !w20AttachmentJobMatches_(current, claimed.job.taskId, claimed.job.pageId, claimed.job.fileId,
          claimed.job.folderId, claimed.job.idemHash)) return null;
    Object.keys(update || {}).forEach(function (key) { current[key] = update[key]; });
    current.updatedAt = Date.now();
    var checked = w20ParseAttachmentJob_(current);
    if (!checked) return null;
    props.setProperty(claimed.key, JSON.stringify(checked));
    claimed.job = checked;
    return checked;
  } finally {
    lock.releaseLock();
  }
}

function w20CompleteAttachmentJob_(claimed) {
  if (!claimed || !claimed.key || !claimed.job) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w20ParseAttachmentJob_(props.getProperty(claimed.key));
    if (!current || current.leaseToken !== claimed.job.leaseToken ||
        !w20AttachmentJobMatches_(current, claimed.job.taskId, claimed.job.pageId, claimed.job.fileId,
          claimed.job.folderId, claimed.job.idemHash)) return false;
    props.deleteProperty(claimed.key);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function w20AttachmentRetryDelayMs_(attempts) {
  var delays = [5000, 30000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
  return delays[Math.min(Math.max(Number(attempts || 1) - 1, 0), delays.length - 1)];
}

function w20Md5Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes).map(function (value) {
    return ((Number(value) + 256) % 256).toString(16).padStart(2, '0');
  }).join('');
}

function w20FailAttachmentJob_(claimed, error) {
  var attempts = Number(claimed && claimed.job && claimed.job.attempts || 0) + 1;
  var retryable = !(error && error.retryable === false) && claimed && claimed.job &&
    Date.now() - Number(claimed.job.createdAt || 0) <= W20_ATTACHMENT_JOB_TTL_MS;
  var code = String(error && error.code || 'UNEXPECTED').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 80) || 'UNEXPECTED';
  return w20WriteClaimedAttachmentJob_(claimed, {
    state: retryable ? 'pending' : 'error',
    attempts: attempts,
    nextAt: retryable ? Date.now() + w20AttachmentRetryDelayMs_(attempts) : 0,
    leaseToken: '',
    leaseUntil: 0,
    lastCode: code
  });
}

function w20CancelAttachmentJob_(taskId, pageId) {
  var key = w20AttachmentJobKey_(taskId, pageId);
  if (!key) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    PropertiesService.getScriptProperties().deleteProperty(key);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function w20AttachmentClaimIsCurrent_(claimed) {
  if (!claimed || !claimed.key || !claimed.job || !w20CreateReservationId_(claimed.job.leaseToken)) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var current = w20ParseAttachmentJob_(PropertiesService.getScriptProperties().getProperty(claimed.key));
    return Boolean(current && current.leaseToken === claimed.job.leaseToken && current.leaseUntil > Date.now() &&
      w20AttachmentJobMatches_(current, claimed.job.taskId, claimed.job.pageId, claimed.job.fileId,
        claimed.job.folderId, claimed.job.idemHash));
  } finally {
    lock.releaseLock();
  }
}

function w20AttachmentPropertyFiles_(page) {
  var property = page && page.properties && page.properties[W19_P.ATTACHMENTS];
  return property && Array.isArray(property.files) ? property.files : [];
}

function w20AssertAttachmentJobPage_(job, cfg, allowArchived) {
  var denied = cfg.deniedPageIds || {};
  if (!job || job.taskId !== cfg.authorizedTaskPageId || denied[job.taskId] || denied[job.pageId]) {
    throw new W19Error_('WRITE_BARRIER', 'Задание вложения не принадлежит разрешённой задаче.', false);
  }
  var page = w19AssertMaterialForTask_(job.pageId, job.taskId, cfg, allowArchived === true);
  var material = w19MaterialFromPage_(page);
  var idemHash = material.idempotency ? w19Hash_(material.idempotency).slice(0, 40) : '';
  if (!w20AttachmentJobMatches_(job, job.taskId, material.id, material.googleFileId, material.folderId, idemHash) ||
      material.provider !== 'Google Drive' || !material.widgetOwnedBinary || material.syncStatus === 'deleting' ||
      material.syncStatus === 'deleted') {
    throw new W19Error_('ATTACHMENT_JOB_CONFLICT', 'Задание вложения больше не совпадает со знанием.', false);
  }
  if (material.archived) throw new W19Error_('ATTACHMENT_ARCHIVED', 'Скрытое знание будет обработано после восстановления.', true);
  return { page: page, material: material };
}

function w20FinalizeClaimedAttachmentJob_(claimed, cfg) {
  var job = claimed.job;
  var exact = w20AssertAttachmentJobPage_(job, cfg, true);
  var files = w20AttachmentPropertyFiles_(exact.page);
  var upload = job.notionUploadId ? w20GetNotionUpload_(job.notionUploadId, cfg, true) : null;
  if (files.length) {
    if (exact.material.hostedAttachment && job.notionUploadId &&
        upload && upload.status === 'uploaded' && upload.expiry_time === null) {
      if (!w20CompleteAttachmentJob_(claimed)) throw new W19Error_('BUSY', 'Завершение вложения ещё фиксируется.', true);
      return { status: 'attached' };
    }
    throw new W19Error_('ATTACHMENT_CONFLICT', 'Вложения знания были изменены вручную; автоматическая копия не перезаписана.', false);
  }
  if (!upload && job.notionUploadId) {
    if (!w20WriteClaimedAttachmentJob_(claimed, { notionUploadId: '', sentMd5: '', sentSize: 0 })) {
      throw new W19Error_('BUSY', 'Очередь вложений изменилась.', true);
    }
    job = claimed.job;
  }
  var drive = w19AssertOwnedBinary_(exact.material, { id: job.taskId, name: 'Задача' }, cfg);
  var markers = drive && drive.appProperties || {};
  if (w20SafeDriveId_(drive.id) !== job.fileId || markers.widgetIdem !== job.idemHash ||
      WidgetV19Core.compactUuid(markers.notionPageId) !== WidgetV19Core.compactUuid(job.pageId)) {
    throw new W19Error_('ATTACHMENT_DRIVE_CONFLICT', 'Файл больше не привязан к этому знанию.', false);
  }
  var driveMd5 = String(drive.md5Checksum || '').toLowerCase();
  var driveSize = Number(drive.size || 0);
  if (!/^[a-f0-9]{32}$/.test(driveMd5) || !Number.isSafeInteger(driveSize) || driveSize < 0) {
    throw new W19Error_('ATTACHMENT_DRIVE_FINGERPRINT', 'Не удалось подтвердить содержимое файла Google Drive.', true);
  }
  if (upload && (job.sentMd5 && (job.sentMd5 !== driveMd5 || job.sentSize !== driveSize) ||
      upload.status === 'uploaded' && !job.sentMd5)) {
    upload = null;
    if (!w20WriteClaimedAttachmentJob_(claimed, { notionUploadId: '', sentMd5: '', sentSize: 0 })) {
      throw new W19Error_('BUSY', 'Очередь вложений изменилась.', true);
    }
    job = claimed.job;
  }
  if (upload && ['expired', 'failed'].indexOf(upload.status) !== -1) {
    upload = null;
    if (!w20WriteClaimedAttachmentJob_(claimed, { notionUploadId: '', sentMd5: '', sentSize: 0 })) {
      throw new W19Error_('BUSY', 'Очередь вложений изменилась.', true);
    }
    job = claimed.job;
  }
  if (!upload) {
    upload = w20CreateNotionUpload_(drive.mimeType, drive.name, cfg);
    if (!w20WriteClaimedAttachmentJob_(claimed, { notionUploadId: upload.id })) {
      throw new W19Error_('BUSY', 'Не удалось сохранить продолжение загрузки.', true);
    }
    job = claimed.job;
  }
  if (upload.status === 'pending') {
    var effectiveUploadLimit = w19EffectiveUploadLimit_(cfg);
    if (driveSize > effectiveUploadLimit) {
      throw new W19Error_('FILE_TOO_LARGE', 'Фоновая копия превышает лимит файлов Notion.', false);
    }
    var blob = w19DriveRetry_(function () { return DriveApp.getFileById(drive.id).getBlob(); });
    var bytes = blob.getBytes();
    if (bytes.length !== driveSize || bytes.length > effectiveUploadLimit || w20Md5Hex_(bytes) !== driveMd5) {
      throw new W19Error_('ATTACHMENT_BYTES_MISMATCH', 'Содержимое файла изменилось во время фоновой загрузки.', true);
    }
    if (!job.sentMd5) {
      if (!w20WriteClaimedAttachmentJob_(claimed, { sentMd5: driveMd5, sentSize: driveSize })) {
        throw new W19Error_('BUSY', 'Не удалось сохранить отпечаток вложения.', true);
      }
      job = claimed.job;
    } else if (job.sentMd5 !== driveMd5 || job.sentSize !== driveSize) {
      throw new W19Error_('ATTACHMENT_BYTES_MISMATCH', 'Содержимое файла изменилось во время фоновой загрузки.', true);
    }
    var uploadBlob = Utilities.newBlob(bytes, WidgetV19Core.cleanMime(drive.mimeType), WidgetV19Core.cleanName(drive.name, 'Файл'));
    upload = w20SendNotionUploadBlob_(upload.id, uploadBlob, cfg);
  }
  if (!upload || upload.status !== 'uploaded') {
    throw new W19Error_('NOTION_UPLOAD_INCOMPLETE', 'Notion ещё не завершил загрузку вложения.', true);
  }
  if (!w20WriteClaimedAttachmentJob_(claimed, { leaseUntil: Date.now() + W20_ATTACHMENT_JOB_LEASE_MS })) {
    throw new W19Error_('BUSY', 'Задание вложения было отменено.', true);
  }
  w19WithMutationLock_(function () {
    var current = w20AssertAttachmentJobPage_(claimed.job, cfg, true);
    var currentDrive = w19AssertOwnedBinary_(current.material, { id: claimed.job.taskId, name: 'Задача' }, cfg);
    var currentMarkers = currentDrive && currentDrive.appProperties || {};
    if (w20SafeDriveId_(currentDrive && currentDrive.id) !== claimed.job.fileId ||
        String(currentDrive && currentDrive.md5Checksum || '').toLowerCase() !== claimed.job.sentMd5 ||
        Number(currentDrive && currentDrive.size || 0) !== claimed.job.sentSize ||
        currentMarkers.widgetIdem !== claimed.job.idemHash ||
        WidgetV19Core.compactUuid(currentMarkers.notionPageId) !== WidgetV19Core.compactUuid(claimed.job.pageId)) {
      throw new W19Error_('ATTACHMENT_DRIVE_CHANGED', 'Файл изменился во время фоновой загрузки; копия будет подготовлена заново.', true);
    }
    if (w20AttachmentPropertyFiles_(current.page).length) {
      var currentUpload = w20GetNotionUpload_(claimed.job.notionUploadId, cfg, true);
      if (current.material.hostedAttachment && currentUpload && currentUpload.status === 'uploaded' &&
          currentUpload.expiry_time === null) return;
      throw new W19Error_('ATTACHMENT_CONFLICT', 'Вложения знания были изменены вручную; автоматическая копия не перезаписана.', false);
    }
    if (!w20AttachmentClaimIsCurrent_(claimed)) throw new W19Error_('BUSY', 'Задание вложения было отменено.', true);
    var props = {};
    props[W19_P.ATTACHMENTS] = { files: [{
      name: WidgetV19Core.cleanName(drive.name, 'Файл'),
      type: 'file_upload',
      file_upload: { id: claimed.job.notionUploadId }
    }] };
    w19UpdateNotionPage_(claimed.job.pageId, props, cfg);
  });
  if (!w20CompleteAttachmentJob_(claimed)) throw new W19Error_('BUSY', 'Завершение вложения ещё фиксируется.', true);
  return { status: 'attached' };
}

function w20FinalizeAttachmentJob_(taskId, pageId, cfg) {
  var claimed = w20ClaimAttachmentJob_(taskId, pageId);
  if (!claimed) return { status: 'pending' };
  try {
    return w20FinalizeClaimedAttachmentJob_(claimed, cfg);
  } catch (error) {
    w20FailAttachmentJob_(claimed, error);
    throw error;
  }
}

function w20DueAttachmentJobs_(taskId, limit) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var now = Date.now();
  var out = [];
  var all = PropertiesService.getScriptProperties().getProperties();
  Object.keys(all).filter(function (key) { return key.indexOf(W20_ATTACHMENT_JOB_PREFIX) === 0; }).sort().some(function (key) {
    var job = w20ParseAttachmentJob_(all[key]);
    if (job && job.taskId === task && job.state === 'pending' && job.nextAt <= now && job.leaseUntil <= now &&
        now - job.createdAt <= W20_ATTACHMENT_JOB_TTL_MS) out.push(job);
    return out.length >= Math.max(1, Math.min(Number(limit) || 1, W20_ATTACHMENT_JOB_DRAIN_LIMIT));
  });
  return out;
}

function w20DrainAttachmentJobs_(cfg, limit) {
  w20PruneAttachmentJobs_();
  var jobs = w20DueAttachmentJobs_(cfg.authorizedTaskPageId, limit);
  var attached = 0;
  var errors = 0;
  jobs.forEach(function (job) {
    try {
      var result = w20FinalizeAttachmentJob_(job.taskId, job.pageId, cfg);
      if (result && result.status === 'attached') attached += 1;
    } catch (_error) { errors += 1; }
  });
  return { checked: jobs.length, attached: attached, errors: errors };
}

function w20EnsureAttachmentJobForPage_(taskId, pageId, cfg) {
  var existing = w20ReadAttachmentJob_(taskId, pageId);
  if (existing) return existing;
  var page = w19AssertMaterialForTask_(pageId, taskId, cfg, true);
  var material = w19MaterialFromPage_(page);
  if (material.archived || material.syncStatus === 'deleting' || material.syncStatus === 'deleted' ||
      !material.widgetOwnedBinary || material.provider !== 'Google Drive' || material.hostedAttachment) return null;
  return w20EnqueueAttachmentJob_(taskId, material, null);
}

function w20SweepMissingAttachmentJobs_(pages, cfg, limit) {
  var maximum = Math.max(1, Math.min(Number(limit) || 1, W20_ATTACHMENT_JOB_DRAIN_LIMIT));
  var values = PropertiesService.getScriptProperties().getProperties();
  var queued = 0;
  (pages || []).some(function (page) {
    var material = w19MaterialFromPage_(page);
    if (!material || !material.id || material.archived || material.syncStatus === 'deleting' ||
        material.syncStatus === 'deleted' || !material.widgetOwnedBinary || material.hostedAttachment) return false;
    var key = w20AttachmentJobKey_(cfg.authorizedTaskPageId, material.id);
    if (key && w20ParseAttachmentJob_(values[key])) return false;
    if (w20TryEnqueueAttachmentJob_(cfg.authorizedTaskPageId, material, null)) queued += 1;
    return queued >= maximum;
  });
  return { queued: queued };
}

function apiFinalizeUploadAttachment(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    w19AssertSchema_(cfg);
    var taskId = w20AssertAuthorizedTaskId_(input && input.taskPageId, cfg);
    var pageId = WidgetV19Core.normalizeUuid(input && input.pageId);
    if (!pageId || (cfg.deniedPageIds || {})[pageId]) throw new W19Error_('MATERIAL_ID_REQUIRED', 'Не указано точное знание.', false);
    var job = w20EnsureAttachmentJobForPage_(taskId, pageId, cfg);
    if (!job) return { status: 'complete' };
    if (job.taskId !== taskId || job.pageId !== pageId) throw new W19Error_('ATTACHMENT_JOB_CONFLICT', 'Очередь не совпала со знанием.', false);
    return w20FinalizeAttachmentJob_(taskId, pageId, cfg);
  });
}

function apiUpdateMaterial(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var materialId = WidgetV19Core.normalizeUuid(input && input.pageId);
    if (!materialId) throw new W19Error_('MATERIAL_ID_REQUIRED', 'Не указан материал.', false);
    var idem = w19CanonicalIdempotency_(task.id, 'update-material-' + materialId, input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      return w19WithMutationLock_(function () {
        var material = w19AssertMaterialForTask_(materialId, task.id, cfg);
        var props = {};
        var current = w19MaterialFromPage_(material);
        w20InvalidateDownloadMaterialCache_(task.id, materialId);
        var displayName = current.name;
        if (current.syncStatus === 'deleting') throw new W19Error_('BUSY', 'Материал сейчас удаляется. Повторите через несколько секунд.', true);
        if (current.syncStatus === 'deleted') throw new W19Error_('MATERIAL_DELETED', 'Физически удалённый материал нельзя изменить.', false);
        if (input && input.section) {
          var nextSection = WidgetV19Core.assertSection(input.section);
          props[W19_P.SECTION] = w19Select_(nextSection);
          if (nextSection !== current.section) props[W19_P.POSITION] = { number: w19NextPosition_(task.id, nextSection, cfg) };
        }
        if (input && Object.prototype.hasOwnProperty.call(input, 'name')) {
          var nextName = WidgetV19Core.cleanName(input.name, current.name);
          displayName = nextName;
          if (current.provider === 'Google Drive' && current.googleFileId && input.renameDrive !== false) {
            w19DriveRetry_(function () { Drive.Files.update({ name: nextName }, current.googleFileId, null, { fields: 'id,name' }); });
          }
          props[W19_P.NAME] = w19Title_(nextName);
        }
        if (input && Object.prototype.hasOwnProperty.call(input, 'url')) {
          if (current.provider !== 'External URL') throw new W19Error_('URL_REPLACE_FORBIDDEN', 'Ссылку Google Drive нельзя заменить как внешнюю URL.', false);
          var url = WidgetV19Core.normalizeExternalUrl(input.url);
          if (!url) throw new W19Error_('INVALID_URL', 'Нужна корректная HTTPS-ссылка.', false);
          var detected = WidgetV19Core.classify({ url: url, isLink: true });
          var googleFileId = WidgetV19Core.extractGoogleFileId(url) || '';
          var collision = w19FindMaterialCollision_(task.id, material.id, googleFileId, url, cfg);
          if (collision) {
            var collisionMaterial = w19MaterialFromPage_(collision);
            throw new W19Error_('DUPLICATE_MATERIAL', collisionMaterial.archived ?
              'Такая ссылка уже есть в архиве. Восстановите исходную карточку вместо создания дубля.' :
              'Такая ссылка уже сохранена в этой задаче.', false);
          }
          props[W19_P.SOURCE] = { url: url };
          props[W19_P.ATTACHMENTS] = { files: [{ name: WidgetV19Core.cleanName(displayName, 'Ссылка'), type: 'external', external: { url: url } }] };
          props[W19_P.KNOWLEDGE_FORMAT] = w19Select_(detected.knowledgeFormat);
          props[W19_P.FILE_FORMAT] = w19Select_(detected.format);
          props[W19_P.GOOGLE_FILE_ID] = w19Text_(googleFileId);
          props[W19_P.GOOGLE_FOLDER_ID] = w19Text_('');
          if (!(input && input.section)) {
            props[W19_P.SECTION] = w19Select_(detected.section);
            if (detected.section !== current.section) props[W19_P.POSITION] = { number: w19NextPosition_(task.id, detected.section, cfg) };
          }
        }
        props[W19_P.SYNC_STATUS] = w19Select_('synced');
        var updated = w19UpdateNotionPage_(material.id, props, cfg);
        var clientMaterial = w20MaterialForClient_(w19MaterialFromPage_(updated), task.id, cfg);
        w20RegistryUpsert_(task.id, clientMaterial);
        return { material: clientMaterial };
      });
    });
  });
}

function apiReorder(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var items = input && input.items;
    if (!Array.isArray(items) || !items.length || items.length > 500) throw new W19Error_('INVALID_ORDER', 'Некорректный список сортировки.', false);
    var seen = {};
    var normalized = items.map(function (item) {
      var id = WidgetV19Core.normalizeUuid(item && item.pageId);
      if (!id || seen[id]) throw new W19Error_('INVALID_ORDER', 'В сортировке есть неверный или повторяющийся ID.', false);
      seen[id] = true;
      var position = Number(item.position);
      if (!isFinite(position) || position < 0) throw new W19Error_('INVALID_ORDER', 'Позиция должна быть неотрицательным числом.', false);
      return { pageId: id, position: Math.round(position), section: WidgetV19Core.assertSection(item.section) };
    });
    var idem = w19CanonicalIdempotency_(task.id, 'reorder', input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      return w19WithMutationLock_(function () {
        normalized.forEach(function (item) {
          var current = w19MaterialFromPage_(w19AssertMaterialForTask_(item.pageId, task.id, cfg));
          if (current.syncStatus === 'deleting') throw new W19Error_('BUSY', 'Один из материалов сейчас удаляется. Повторите через несколько секунд.', true);
          if (current.syncStatus === 'deleted') throw new W19Error_('MATERIAL_DELETED', 'Физически удалённый материал нельзя перемещать.', false);
        });
        normalized.forEach(function (item) {
          var props = {};
          props[W19_P.POSITION] = { number: item.position };
          props[W19_P.SECTION] = w19Select_(item.section);
          w19UpdateNotionPage_(item.pageId, props, cfg);
        });
        w20RegistryApplyOrder_(task.id, normalized);
        return { count: normalized.length };
      });
    });
  });
}

function apiArchive(input) {
  return w19SetArchiveState_(input, true);
}

function apiRestore(input) {
  return w19SetArchiveState_(input, false);
}

function apiDeletePhysical(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var materialId = WidgetV19Core.normalizeUuid(input && input.pageId);
    if (!materialId) throw new W19Error_('MATERIAL_ID_REQUIRED', 'Не указан материал.', false);
    var idem = w19StableIdempotency_(task.id, 'delete-file-' + materialId, input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      return w19WithMutationLock_(function () {
      var page = w19AssertMaterialForTask_(materialId, task.id, cfg, true);
      var material = w19MaterialFromPage_(page);
      w20InvalidateDownloadMaterialCache_(task.id, materialId);
      if (material.archived && material.syncStatus === 'deleted') {
        if (!w20CancelAttachmentJob_(task.id, materialId)) throw new W19Error_('BUSY', 'Отмена фоновой копии ещё фиксируется.', true);
        w20SetDriveMaterialState_(material, task.id, 'deleted');
        w20RegistryRemove_(task.id, materialId);
        return { material: w20MaterialForClient_(material, task.id, cfg), deleted: true, duplicate: true };
      }
      if (material.provider !== 'Google Drive' || !material.googleFileId) throw new W19Error_('NO_PHYSICAL_FILE', 'У этой карточки нет физического файла Google Drive.', false);
      if (String(input && input.confirmName || '') !== material.name) throw new W19Error_('CONFIRMATION_REQUIRED', 'Для удаления нужно точно ввести название файла.', false);
      if (material.archived && material.syncStatus !== 'deleting') throw new W19Error_('MATERIAL_ARCHIVED', 'Материал уже архивирован.', false);

      var prepared = material.syncStatus === 'deleting';
      var driveFile = w19GetDriveMetadata_(material.googleFileId);
      var driveProps = driveFile && driveFile.appProperties || {};
      if (driveFile && ((driveProps.widgetVersion !== 'v19' && driveProps.widgetVersion !== W20_DRIVE_MARKER) || driveProps.taskPageId !== WidgetV19Core.compactUuid(task.id))) {
        throw new W19Error_('DELETE_NOT_OWNED_BY_WIDGET', 'Физически удалять можно только файлы, созданные этим виджетом для текущей задачи.', false);
      }
      if (!driveFile && !prepared) {
        throw new W19Error_('DELETE_NOT_OWNED_BY_WIDGET', 'Файл уже отсутствует, а подтверждённой операции удаления для него нет.', false);
      }
      if (!w20CancelAttachmentJob_(task.id, materialId)) throw new W19Error_('BUSY', 'Отмена фоновой копии ещё фиксируется.', true);
      w20SetDriveMaterialState_(material, task.id, 'deleting');
      if (!prepared) {
        var preparing = {};
        preparing[W19_P.SYNC_STATUS] = w19Select_('deleting');
        page = w19UpdateNotionPage_(page.id, preparing, cfg);
        material = w19MaterialFromPage_(page);
      }
      if (driveFile) {
        try { w19DriveRetry_(function () { Drive.Files.delete(material.googleFileId); }); }
        catch (err) {
          if (!w19IsDriveNotFound_(err)) throw err;
        }
      }
      var props = {};
      props[W19_P.ARCHIVE] = { checkbox: true };
      props[W19_P.ATTACHMENTS] = { files: [] };
      props[W19_P.SYNC_STATUS] = w19Select_('deleted');
      var updated = w19UpdateNotionPage_(page.id, props, cfg);
      w20RegistryRemove_(task.id, materialId);
      return { material: w20MaterialForClient_(w19MaterialFromPage_(updated), task.id, cfg), deleted: true };
      });
    });
  });
}

function apiPrepareDownload(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var taskId = WidgetV19Core.normalizeUuid(input && input.taskPageId);
    if (!taskId) throw new W19Error_('TASK_ID_REQUIRED', 'В URL виджета отсутствует корректный task_page_id.', false);
    if (taskId !== cfg.authorizedTaskPageId || cfg.deniedPageIds[taskId]) {
      throw new W19Error_('WRITE_BARRIER', 'Эта задача не разрешена для скачивания.', false);
    }
    var materialId = WidgetV19Core.normalizeUuid(input && input.pageId);
    if (!materialId) throw new W19Error_('MATERIAL_ID_REQUIRED', 'Не указан материал.', false);
    var grantEpoch = w20DownloadGrantEpoch_(taskId, materialId);
    if (grantEpoch === null) throw new W19Error_('BUSY', 'Не удалось проверить состояние скачивания. Повторите через несколько секунд.', true);
    var page = null;
    var cachedMaterial = w20GetCachedDownloadMaterial_(taskId, materialId, cfg);
    var registryProof = w20FreshRegistryDownloadProof_(taskId, materialId, cfg);
    var material = cachedMaterial || (registryProof && registryProof.material) || null;
    var task = { id: taskId, name: 'Задача' };
    var drive = material && registryProof ?
      w20FastPreparedDownloadDrive_(taskId, materialId, material, cfg, registryProof) : null;
    if (!drive) {
      if (!cachedMaterial) {
        page = w19AssertMaterialForTask_(materialId, taskId, cfg);
        material = w19MaterialFromPage_(page);
        w20CacheDownloadMaterials_(taskId, [page], cfg);
      }
      drive = w19AssertOwnedBinary_(material, task, cfg);
    }
    var directUrl = w20DriveDownloadUrl_(drive.id, cfg.allowedEmail);
    if (!directUrl) return { mode: 'proxy', proxyReason: 'metadata' };
    var direct = {
      mode: 'direct',
      url: directUrl,
      name: WidgetV19Core.cleanName(drive.name || material.downloadName || material.name, 'Файл'),
      mimeType: WidgetV19Core.cleanMime(drive.mimeType || material.mimeType),
      size: drive.size ? Number(drive.size) : material.size,
      expiresAt: new Date(Date.now() + W20_DRIVE_DIRECT_SOURCE_TTL_SECONDS * 1000).toISOString()
    };
    var issued = w20IssueDownloadGrant_(taskId, materialId, direct, cfg, grantEpoch);
    if (issued && issued.mode === 'grant' && /^[a-f0-9]{96}$/.test(String(issued.downloadGrant || ''))) {
      issued.directDownloadUrl = direct.url;
      issued.directDownloadExpiresAt = direct.expiresAt;
      issued.directDownloadName = w20FastDownloadName_(direct.name);
    }
    if (issued && issued.mode === 'proxy') issued.proxyReason = 'grant';
    return issued;
  });
}

function apiDownload(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var taskId = WidgetV19Core.normalizeUuid(input && input.taskPageId);
    if (!taskId) throw new W19Error_('TASK_ID_REQUIRED', 'В URL виджета отсутствует корректный task_page_id.', false);
    if (cfg.deniedPageIds[taskId]) throw new W19Error_('WRITE_BARRIER', 'Эта страница запрещена write barrier.', false);
    var materialId = WidgetV19Core.normalizeUuid(input && input.pageId);
    if (!materialId) throw new W19Error_('MATERIAL_ID_REQUIRED', 'Не указан материал.', false);
    var granted = w20GetDownloadGrant_(taskId, materialId, input && (input.downloadGrant || input.downloadTicket), cfg);
    if (granted) return granted;
    var material = w20GetCachedDownloadMaterial_(taskId, materialId, cfg);
    var task = { id: taskId, name: 'Задача' };
    if (!material) {
      material = w20FindOwnedBinaryMaterialByMarkers_(taskId, materialId, cfg);
    }
    if (!material) {
      task = w19AssertTaskPage_(taskId, cfg);
      var page = w19AssertMaterialForTask_(materialId, task.id, cfg);
      material = w19MaterialFromPage_(page);
    }
    var drive = w19AssertOwnedBinary_(material, task, cfg);
    var blob = w19DriveRetry_(function () {
      return DriveApp.getFileById(drive.id).getBlob();
    });
    var bytes = blob.getBytes();
    if (bytes.length > cfg.maxUploadBytes) throw new W19Error_('FILE_TOO_LARGE', 'Файл превышает безопасный лимит скачивания ' + w19HumanBytes_(cfg.maxUploadBytes) + '.', false);
    return {
      name: WidgetV19Core.cleanName(drive.name || material.name, 'Файл'),
      mimeType: WidgetV19Core.cleanMime(drive.mimeType || material.mimeType),
      size: bytes.length,
      base64: Utilities.base64Encode(bytes)
    };
  });
}

function apiPollDriveMetadata(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var taskId = WidgetV19Core.normalizeUuid(input && input.taskPageId);
    if (!taskId || taskId !== cfg.authorizedTaskPageId || cfg.deniedPageIds[taskId]) {
      throw new W19Error_('WRITE_BARRIER', 'Эта задача не разрешена для Drive-опроса.', false);
    }
    var materials = input && input.materials;
    if (!Array.isArray(materials) || materials.length > 50) {
      throw new W19Error_('INVALID_POLL', 'Некорректный список файлов для обновления.', false);
    }
    var seen = {};
    var updates = [];
    var refreshRequired = false;
    materials.forEach(function (row) {
      var pageId = WidgetV19Core.normalizeUuid(row && row.pageId);
      var googleFileId = w20SafeDriveId_(row && row.googleFileId);
      var pairKey = WidgetV19Core.compactUuid(pageId) + '|' + googleFileId;
      if (!pageId || !googleFileId || cfg.deniedPageIds[pageId] || seen[pairKey]) return;
      seen[pairKey] = true;
      var baseline = w20DrivePollBaseline_(row);
      var claimStatus = w20DrivePollClaimStatus_(taskId, pageId, googleFileId, baseline, row && row.claim, cfg);
      if (claimStatus === 'expired') { refreshRequired = true; return; }
      if (claimStatus !== 'valid') return;
      var drive = w19GetDriveMetadata_(googleFileId);
      if (!drive || drive.trashed) return;
      var data = WidgetV19Core.describeGoogleMetadata(drive, '');
      if (!/^Google (?:Docs|Sheets|Slides)$/.test(String(data.format || ''))) return;
      var baselineMaterial = {
        name: baseline.name,
        openUrl: baseline.openUrl,
        format: baseline.format,
        section: baseline.section,
        provider: 'Google Drive',
        knowledgeFormat: 'Файл',
        mimeType: baseline.mimeType,
        size: baseline.size,
        driveMd5: baseline.driveMd5,
        downloadName: baseline.downloadName,
        normalizedUrl: baseline.normalizedUrl,
        syncStatus: 'synced',
        error: '',
        integrity: 'ok'
      };
      if (w20DriveMetadataNeedsNotionWrite_(baselineMaterial, data)) {
        var props = {};
        var nameChanged = Boolean(data.name && data.name !== baseline.name);
        var urlChanged = Boolean(data.sourceUrl && data.sourceUrl !== baseline.openUrl);
        if (nameChanged) props[W19_P.NAME] = w19Title_(data.name);
        if (urlChanged) props[W19_P.SOURCE] = { url: data.sourceUrl };
        if ((nameChanged || urlChanged) && data.sourceUrl) {
          props[W19_P.ATTACHMENTS] = { files: [{ name: data.name, type: 'external', external: { url: data.sourceUrl } }] };
        }
        if (data.format !== baseline.format) props[W19_P.FILE_FORMAT] = w19Select_(data.format);
        if (data.section !== baseline.section) props[W19_P.SECTION] = w19Select_(data.section);
        props[W19_P.SYNC_STATUS] = w19Select_('synced');
        var updatedPage = w19WithMutationLock_(function () {
          return w19UpdateNotionPage_(pageId, props, cfg);
        });
        var updatedMaterial = w20MaterialForClient_(
          w20MaterialWithRuntimeMetadata_(w19MaterialFromPage_(updatedPage), data), taskId, cfg
        );
        w20RegistryUpsert_(taskId, updatedMaterial);
        updatedMaterial.pageId = updatedMaterial.id;
        updates.push(updatedMaterial);
        return;
      }
      var unchanged = {
        pageId: pageId,
        googleFileId: googleFileId,
        name: data.name,
        section: data.section,
        format: data.format,
        openUrl: data.sourceUrl,
        mimeType: data.mimeType || '',
        size: data.size,
        driveMd5: data.driveMd5 || '',
        downloadName: data.name,
        normalizedUrl: data.normalizedUrl || data.sourceUrl
      };
      unchanged.drivePollClaim = w20IssueDrivePollClaim_(taskId, pageId, googleFileId, unchanged, cfg);
      updates.push(unchanged);
    });
    return { materials: updates, refreshRequired: refreshRequired, polledAt: new Date().toISOString() };
  });
}

function apiSyncTask(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var registrySnapshotStartedAt = Date.now();
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var taskValidatedAt = new Date().toISOString();
    var pages = w19QueryTaskMaterials_(task.id, cfg);
    w20CacheDownloadMaterials_(task.id, pages, cfg);
    var materials = pages.map(function (page) {
      return w20MaterialForClient_(w19MaterialFromPage_(page), task.id, cfg);
    });
    materials = w20PreserveRegistryRuntimeMetadata_(task.id, materials);
    var previousMeta = w20RegistryReadTaskMeta_(task.id);
    var folderId = w20RegistryFolderId_(task.id, materials);
    var folderVerified = Boolean(previousMeta && previousMeta.folderId === folderId &&
      w20RegistryFolderMetaFresh_(previousMeta, cfg.rootFolderId));
    var folderValidatedAt = folderVerified ? previousMeta.folderValidatedAt : '';
    if (!folderVerified) {
      folderId = w19WithMutationLock_(function () {
        return w19EnsureTaskFolder_(task, cfg).id;
      });
      folderVerified = true;
      folderValidatedAt = new Date().toISOString();
    }
    var replacement = w20RegistryReplaceTaskResult_(task.id, materials, registrySnapshotStartedAt);
    if (!replacement.ok) throw new W19Error_('BUSY', 'Не удалось сохранить актуальный снимок карточек. Повторите обновление.', true);
    var registry = w20RegistryReadTaskResult_(task.id, cfg);
    if (!registry.ok || !registry.integrityOk || registry.activeCount !== replacement.activeCount) {
      throw new W19Error_('BUSY', 'Не удалось подтвердить актуальный снимок карточек. Повторите обновление.', true);
    }
    materials = registry.materials;
    var snapshotValidatedAt = new Date().toISOString();
    w20RegistryWriteTaskMeta_(task.id, {
      taskName: task.name,
      folderId: folderId,
      rootFolderId: cfg.rootFolderId,
      folderVerified: folderVerified,
      folderValidatedAt: folderValidatedAt,
      taskValidatedAt: taskValidatedAt,
      snapshotValidatedAt: snapshotValidatedAt,
      snapshotActiveCount: registry.activeCount,
      context: w20TaskContextSnapshot_(task)
    });
    var actionRegistry = w20RegistryReadTaskResult_(task.id, null);
    var actionProof = w20RegistryActionProof_(w20RegistryReadTaskMeta_(task.id), actionRegistry, cfg.rootFolderId);
    return {
      task: { id: task.id, name: task.name },
      folderUrl: folderId ? 'https://drive.google.com/drive/folders/' + encodeURIComponent(folderId) : null,
      serviceUrl: ScriptApp.getService().getUrl(),
      maxUploadBytes: cfg.maxUploadBytes,
      materials: materials,
      authoritative: true,
      actionReady: actionProof.ready,
      trustedUntil: actionProof.trustedUntil,
      fullySynced: true,
      syncedAt: new Date().toISOString()
    };
  });
}

/* ========================= Admin-only setup ========================= */

function adminSetupRootFolder() {
  var cfg = w19AdminConfig_();
  var props = PropertiesService.getScriptProperties();
  var existing = String(props.getProperty('ROOT_DRIVE_FOLDER_ID') || '').trim();
  if (existing) {
    var checked = w19GetDriveMetadata_(existing);
    if (checked && checked.mimeType === 'application/vnd.google-apps.folder' && !checked.trashed) return { ok: true, folderId: existing, reused: true };
  }
  var folder = w19DriveRetry_(function () {
    return Drive.Files.create({
      name: 'Notion Task Files Widget — v20',
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { widgetVersion: 'v20-root' }
    }, null, { fields: 'id,name,mimeType,trashed' });
  });
  props.setProperty('ROOT_DRIVE_FOLDER_ID', folder.id);
  return { ok: true, folderId: folder.id, reused: false, owner: cfg.allowedEmail };
}

function adminPreflight() {
  return w19ApiResult_(function () {
    var cfg = w19AdminConfig_();
    var schema = w19AssertSchema_(cfg, true);
    var root = w19AssertRootFolder_(cfg);
    return { version: W19_VERSION, dataSourceId: cfg.dataSourceId, rootFolderId: root.id, schema: schema };
  });
}

function adminInstallSyncTrigger() {
  w19AdminConfig_();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (['scheduledSync', 'scheduledFinalizeUploads'].indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('scheduledSync').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('scheduledFinalizeUploads').timeBased().everyMinutes(1).create();
  return { ok: true, handlers: ['scheduledSync', 'scheduledFinalizeUploads'], cadence: 'approximately every one to five minutes' };
}

function scheduledFinalizeUploads(event) {
  var cfg = w19Config_();
  w19AssertScheduledInvocation_(cfg, event, 'scheduledFinalizeUploads');
  w20PruneAttachmentJobs_();
  if (!w20DueAttachmentJobs_(cfg.authorizedTaskPageId, 1).length) {
    return { ok: true, checked: 0, attached: 0, errors: 0 };
  }
  w19AssertSchema_(cfg);
  var result = w20DrainAttachmentJobs_(cfg, W20_ATTACHMENT_JOB_DRAIN_LIMIT);
  w19Audit_('scheduled_attachment_finalize', result);
  return { ok: true, checked: result.checked, attached: result.attached, errors: result.errors };
}

function scheduledSync(event) {
  var cfg = w19Config_();
  w19AssertScheduledInvocation_(cfg, event);
  var lease = w19ClaimScheduledSync_();
  if (!lease) return { ok: true, skipped: true, reason: 'already_running' };
  var commitCursor = false;
  var nextCursor = lease.cursor;
  try {
    w19AssertSchema_(cfg);
    var registrySnapshotStartedAt = Date.now();
    var body = {
      page_size: 100,
      filter: {
        and: [
          { property: W19_P.TYPE, select: { equals: 'Знание' } },
          { property: W19_P.INSIDE, relation: { contains: cfg.authorizedTaskPageId } },
          { property: W19_P.ARCHIVE, checkbox: { equals: false } }
        ]
      },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }]
    };
    var startedAtBeginning = !lease.cursor;
    if (lease.cursor) body.start_cursor = lease.cursor;
    var result = null;
    var ok = 0;
    var errors = 0;
    var syncedPages = [];
    var checked = 0;
    var scheduledStartedAt = Date.now();
    var scheduledBatches = 0;
    do {
      scheduledBatches += 1;
      result = w19NotionRequest_('post', '/v1/data_sources/' + cfg.dataSourceId + '/query', body, cfg);
      if (body.start_cursor && result.has_more && body.start_cursor === result.next_cursor) break;
      var batch = result.results || [];
      checked += batch.length;
      batch.forEach(function (page) {
        try {
          var syncedPage = w19SyncOnePage_(page, cfg);
          syncedPages.push(syncedPage);
          ok += 1;
        }
        catch (err) { errors += 1; w19MarkSyncError_(page, err, cfg); }
      });
      if (!result.has_more || !result.next_cursor) break;
      body.start_cursor = result.next_cursor;
    } while (scheduledBatches < 20 && Date.now() - scheduledStartedAt < 4 * 60 * 1000);
    var fullSinglePageCycle = startedAtBeginning && !result.has_more && errors === 0;
    if (fullSinglePageCycle) {
      var task = w19AssertTaskPage_(cfg.authorizedTaskPageId, cfg);
      if (!task || task.id !== cfg.authorizedTaskPageId) {
        throw new W19Error_('WRITE_BARRIER', 'Фоновая сверка вернула другую задачу.', false);
      }
      var folder = w19WithMutationLock_(function () { return w19EnsureTaskFolder_(task, cfg); });
      var folderId = w20SafeDriveId_(folder && folder.id);
      var folderProps = folder && folder.appProperties || {};
      var folderMarkerOk = folderProps.widgetVersion === W20_DRIVE_MARKER || folderProps.widgetVersion === 'v19';
      if (!folderId || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder' || !folderMarkerOk ||
          folderProps.taskPageId !== WidgetV19Core.compactUuid(task.id)) {
        throw new W19Error_('TASK_FOLDER_INVALID', 'Папка фоновой сверки не прошла точную проверку.', false);
      }
      var snapshotCfg = { notionToken: cfg.notionToken, suppressDrivePollClaim: true };
      var materials = syncedPages.map(function (page) {
        return w20MaterialForClient_(w19MaterialFromPage_(page), task.id, snapshotCfg);
      });
      materials = w20PreserveRegistryRuntimeMetadata_(task.id, materials);
      var folderEvidence = w20RegistryFolderEvidence_(materials);
      if (!folderEvidence.consistent || (folderEvidence.folderId && folderEvidence.folderId !== folderId)) {
        throw new W19Error_('TASK_FOLDER_MISMATCH', 'Карточки фоновой сверки ссылаются на другую папку.', false);
      }
      var replacement = w20RegistryReplaceTaskResult_(task.id, materials, registrySnapshotStartedAt);
      if (!replacement.ok || !replacement.integrityOk) {
        throw new W19Error_('BUSY', 'Не удалось сохранить фоновый снимок карточек.', true);
      }
      var validatedAt = new Date().toISOString();
      var metaWrite = w20RegistryWriteTaskMetaResult_(task.id, {
        taskName: task.name,
        folderId: folderId,
        rootFolderId: cfg.rootFolderId,
        folderVerified: true,
        folderValidatedAt: validatedAt,
        taskValidatedAt: validatedAt,
        snapshotValidatedAt: validatedAt,
        snapshotActiveCount: replacement.activeCount,
        context: w20TaskContextSnapshot_(task)
      });
      var proof = metaWrite.ok ? w20RegistryActionProof_(metaWrite.meta, metaWrite.registry, cfg.rootFolderId) : { ready: false };
      if (!metaWrite.ok || !metaWrite.registry || !metaWrite.registry.ok || !metaWrite.registry.integrityOk ||
          metaWrite.registry.activeCount !== replacement.activeCount || !proof.ready) {
        throw new W19Error_('BUSY', 'Фоновый снимок не прошёл целостную проверку.', true);
      }
    } else {
      syncedPages.forEach(function (page) {
        w20RegistryUpsert_(cfg.authorizedTaskPageId, w19MaterialFromPage_(page));
      });
    }
    nextCursor = result.has_more && result.next_cursor ? result.next_cursor : null;
    commitCursor = true;
    w19PruneLedger_();
    try { w20CleanupExpiredCreateReservationsV2_(cfg.authorizedTaskPageId, cfg, W20_CREATE_RESERVATION_V2_CLEANUP_LIMIT); }
    catch (cleanupError) { w19Audit_('create_reservation_v2_cleanup_deferred', { code: String(cleanupError && cleanupError.code || 'DRIVE_ERROR') }); }
    try {
      var attachmentSweep = w20SweepMissingAttachmentJobs_(syncedPages, cfg, W20_ATTACHMENT_JOB_DRAIN_LIMIT);
      w19Audit_('scheduled_attachment_sweep', attachmentSweep);
    } catch (sweepError) {
      w19Audit_('scheduled_attachment_sweep_deferred', {
        code: String(sweepError && sweepError.code || 'QUEUE_UNAVAILABLE').replace(/[^A-Z0-9_]/gi, '').slice(0, 80)
      });
    }
    try {
      var attachmentDrain = w20DrainAttachmentJobs_(cfg, 1);
      w19Audit_('scheduled_attachment_fallback', attachmentDrain);
    } catch (attachmentError) {
      w19Audit_('scheduled_attachment_fallback_deferred', {
        code: String(attachmentError && attachmentError.code || 'QUEUE_UNAVAILABLE').replace(/[^A-Z0-9_]/gi, '').slice(0, 80)
      });
    }
    w19Audit_('scheduled_sync', { checked: checked, ok: ok, errors: errors });
    return { ok: true, checked: checked, synced: ok, errors: errors, proofRefreshed: fullSinglePageCycle };
  } finally {
    w19FinishScheduledSync_(lease.token, commitCursor, nextCursor);
  }
}

function w19ClaimScheduledSync_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var props = PropertiesService.getScriptProperties();
    var now = Date.now();
    var current = w19ReadLedger_(props, W19_SYNC_LEASE);
    if (current && now - Number(current.at || 0) < 10 * 60 * 1000) return null;
    var token = Utilities.getUuid();
    props.setProperty(W19_SYNC_LEASE, JSON.stringify({ token: token, at: now }));
    return { token: token, cursor: props.getProperty(W19_SYNC_CURSOR) || null };
  } finally {
    lock.releaseLock();
  }
}

function w19FinishScheduledSync_(token, commitCursor, nextCursor) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var current = w19ReadLedger_(props, W19_SYNC_LEASE);
    if (!current || current.token !== token) return;
    if (commitCursor) {
      if (nextCursor) props.setProperty(W19_SYNC_CURSOR, nextCursor);
      else props.deleteProperty(W19_SYNC_CURSOR);
    }
    props.deleteProperty(W19_SYNC_LEASE);
  } finally {
    lock.releaseLock();
  }
}

function w19AssertScheduledInvocation_(cfg, event, handlerName) {
  var activeEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (activeEmail && activeEmail === cfg.allowedEmail) return;
  var expectedHandler = String(handlerName || 'scheduledSync');
  if (['scheduledSync', 'scheduledFinalizeUploads'].indexOf(expectedHandler) === -1) {
    throw new W19Error_('FORBIDDEN', 'Неизвестный системный обработчик.', false);
  }
  var triggerUid = String(event && event.triggerUid || '');
  var validTrigger = Boolean(triggerUid && ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === expectedHandler && String(trigger.getUniqueId()) === triggerUid;
  }));
  if (!validTrigger) throw new W19Error_('FORBIDDEN', 'Синхронизацию может запускать только системный триггер или владелец.', false);
}

/* ========================= Authorization/config ========================= */

function w19AuthorizedConfig_(input) {
  var cfg = w19Config_();
  w19AssertViewer_(cfg, input || {});
  return cfg;
}

function w19AuthorizedConfigFromValues_(input, values) {
  var cfg = w19ConfigFromValues_(values);
  w19AssertViewer_(cfg, input || {});
  return cfg;
}

function w19AdminConfig_() {
  var cfg = w19Config_();
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email || email !== cfg.allowedEmail) throw new W19Error_('FORBIDDEN', 'Административный запуск разрешён только подтверждённому владельцу из ALLOWED_EMAIL.', false);
  return cfg;
}

function w19Config_() {
  var props = PropertiesService.getScriptProperties();
  var values = props.getProperties();
  return w19ConfigFromValues_(values);
}

function w19ConfigFromValues_(values) {
  values = values && typeof values === 'object' ? values : {};
  var allowedEmail = String(values.ALLOWED_EMAIL || '').trim().toLowerCase();
  var notionToken = String(values.NOTION_TOKEN || '').trim();
  var dataSourceId = WidgetV19Core.normalizeUuid(values.NOTION_DATA_SOURCE_ID);
  var authorizedTaskPageId = WidgetV19Core.normalizeUuid(values.AUTHORIZED_TASK_PAGE_ID);
  var accessTokenHash = String(values.WIDGET_ACCESS_TOKEN_SHA256 || '').trim().toLowerCase();
  if (!allowedEmail) throw new W19Error_('CONFIG_MISSING', 'Не задан ALLOWED_EMAIL.', false);
  if (!notionToken) throw new W19Error_('CONFIG_MISSING', 'Не задан NOTION_TOKEN в Script Properties.', false);
  if (!dataSourceId) throw new W19Error_('CONFIG_MISSING', 'Не задан корректный NOTION_DATA_SOURCE_ID.', false);
  if (!authorizedTaskPageId || !accessTokenHash) {
    throw new W19Error_('CONFIG_MISSING', 'Для iframe нужны AUTHORIZED_TASK_PAGE_ID и WIDGET_ACCESS_TOKEN_SHA256.', false);
  }
  if (accessTokenHash && !/^[a-f0-9]{64}$/.test(accessTokenHash)) {
    throw new W19Error_('CONFIG_INVALID', 'WIDGET_ACCESS_TOKEN_SHA256 должен быть SHA-256 в нижнем регистре.', false);
  }
  var maxUpload = Number(values.MAX_UPLOAD_BYTES || 8388608);
  if (!isFinite(maxUpload) || maxUpload < 1048576 || maxUpload > W19_NOTION_SINGLE_PART_MAX_BYTES) throw new W19Error_('CONFIG_INVALID', 'MAX_UPLOAD_BYTES должен быть от 1 до 20 MiB.', false);
  var cfg = {
    allowedEmail: allowedEmail,
    notionToken: notionToken,
    dataSourceId: dataSourceId,
    authorizedTaskPageId: authorizedTaskPageId,
    accessTokenHash: accessTokenHash,
    rootFolderId: String(values.ROOT_DRIVE_FOLDER_ID || '').trim(),
    notionVersion: String(values.NOTION_VERSION || W19_NOTION_DEFAULT_VERSION).trim(),
    maxUploadBytes: Math.floor(maxUpload),
    deniedPageIds: w19IdSet_(values.DENIED_NOTION_PAGE_IDS),
    deniedDataSourceIds: w19IdSet_(values.DENIED_NOTION_DATA_SOURCE_IDS)
  };
  w19AssertAllowedDataSource_(cfg.dataSourceId, cfg);
  return cfg;
}

function w19AssertViewer_(cfg, input) {
  var token = String(input && input.accessToken || '').trim();
  var taskId = WidgetV19Core.normalizeUuid(input && input.taskPageId);
  var tokenShapeOk = /^[A-Za-z0-9._~-]{32,256}$/.test(token);
  var tokenHash = tokenShapeOk ? w19Hash_(token) : '';
  var taskMatches = Boolean(taskId && cfg.authorizedTaskPageId && taskId === cfg.authorizedTaskPageId);
  var tokenMatches = Boolean(cfg.accessTokenHash && WidgetV19Core.safeEqual(tokenHash, cfg.accessTokenHash));
  if (taskMatches && tokenMatches) return 'capability';

  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (email && email === cfg.allowedEmail) return 'owner';

  if (email) throw new W19Error_('FORBIDDEN', 'У этой учётной записи нет доступа к виджету.', false);
  throw new W19Error_('AUTH_REQUIRED', 'Ссылка виджета не содержит действующий ключ доступа для этой задачи.', false);
}

function w20DrivePollBaseline_(source) {
  var value = source || {};
  var section = String(value.currentSection !== undefined ? value.currentSection : value.section || '');
  var format = String(value.currentFormat !== undefined ? value.currentFormat : value.format || '');
  if (['Drive', 'Docs', 'Sheets', 'Slides'].indexOf(section) === -1 || !/^Google (?:Docs|Sheets|Slides)$/.test(format)) return null;
  var rawSize = value.currentSize !== undefined ? value.currentSize : value.size;
  var size = rawSize === null || rawSize === undefined || rawSize === '' ? null : Number(rawSize);
  if (size !== null && (!isFinite(size) || size < 0)) return null;
  return {
    name: WidgetV19Core.cleanName(value.currentName !== undefined ? value.currentName : value.name, 'Без названия'),
    openUrl: String(value.currentOpenUrl !== undefined ? value.currentOpenUrl : value.openUrl || '').slice(0, 2048),
    format: format,
    section: section,
    mimeType: String(value.currentMimeType !== undefined ? value.currentMimeType : value.mimeType || '').slice(0, 300),
    size: size,
    driveMd5: String(value.currentDriveMd5 !== undefined ? value.currentDriveMd5 : value.driveMd5 || '').slice(0, 128),
    downloadName: WidgetV19Core.cleanName(value.currentDownloadName !== undefined ? value.currentDownloadName : value.downloadName || value.name, 'Без названия'),
    normalizedUrl: String(value.currentNormalizedUrl !== undefined ? value.currentNormalizedUrl : value.normalizedUrl || '').slice(0, 2048)
  };
}

function w20DrivePollPayload_(taskId, pageId, googleFileId, expiresAt, baseline) {
  var task = WidgetV19Core.compactUuid(taskId);
  var page = WidgetV19Core.compactUuid(pageId);
  var file = w20SafeDriveId_(googleFileId);
  var expires = Math.floor(Number(expiresAt));
  var current = w20DrivePollBaseline_(baseline);
  if (!task || !page || !file || !isFinite(expires) || expires <= 0 || !current) return '';
  return ['v1', task, page, file, expires, JSON.stringify([
    current.name, current.openUrl, current.format, current.section, current.mimeType,
    current.size, current.driveMd5, current.downloadName, current.normalizedUrl
  ])].join('|');
}

function w20DrivePollSignature_(payload, cfg) {
  if (!payload || !cfg || !cfg.notionToken) return '';
  return Utilities.computeHmacSha256Signature(String(payload), String(cfg.notionToken)).map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function w20IssueDrivePollClaim_(taskId, pageId, googleFileId, baseline, cfg) {
  var expiresAt = Math.floor(Date.now() / 1000) + W20_DRIVE_POLL_CLAIM_TTL_SECONDS;
  var payload = w20DrivePollPayload_(taskId, pageId, googleFileId, expiresAt, baseline);
  if (!payload) return '';
  return String(expiresAt) + '.' + w20DrivePollSignature_(payload, cfg);
}

function w20DrivePollClaimStatus_(taskId, pageId, googleFileId, baseline, claim, cfg) {
  var match = String(claim || '').match(/^(\d{10})\.([a-f0-9]{64})$/);
  if (!match) return 'invalid';
  var now = Math.floor(Date.now() / 1000);
  var expiresAt = Number(match[1]);
  if (!isFinite(expiresAt) || expiresAt > now + W20_DRIVE_POLL_CLAIM_TTL_SECONDS) return 'invalid';
  var payload = w20DrivePollPayload_(taskId, pageId, googleFileId, expiresAt, baseline);
  var expected = w20DrivePollSignature_(payload, cfg);
  if (!expected || !WidgetV19Core.safeEqual(expected, match[2])) return 'invalid';
  return expiresAt < now ? 'expired' : 'valid';
}

function w20MaterialWithRuntimeMetadata_(material, metadata) {
  var out = {};
  Object.keys(material || {}).forEach(function (key) { out[key] = material[key]; });
  var source = metadata || {};
  var mimeType = String(source.mimeType || out.mimeType || '').trim();
  if (mimeType && mimeType.length <= 300 && /^[a-z0-9][a-z0-9!#$&^_.+\-]*\/[a-z0-9][a-z0-9!#$&^_.+\-]*$/i.test(mimeType)) {
    out.mimeType = mimeType.toLowerCase();
  }
  var rawSize = Object.prototype.hasOwnProperty.call(source, 'size') ? source.size : out.size;
  var size = rawSize === null || rawSize === undefined || rawSize === '' ? null : Number(rawSize);
  out.size = size !== null && isFinite(size) && size >= 0 ? size : null;
  var driveMd5 = String(source.md5Checksum || source.driveMd5 || out.driveMd5 || '').trim();
  out.driveMd5 = driveMd5.slice(0, 128);
  out.downloadName = WidgetV19Core.cleanName(source.name || source.downloadName || out.downloadName || out.name, 'Файл');
  var normalizedUrl = WidgetV19Core.normalizeExternalUrl(source.normalizedUrl || source.sourceUrl || out.normalizedUrl || out.openUrl || '');
  out.normalizedUrl = normalizedUrl || '';
  return out;
}

function w20PreserveRegistryRuntimeMetadata_(taskId, materials) {
  var current = w20RegistryReadTaskResult_(taskId, null);
  if (!current || !current.ok || !current.integrityOk) return materials;
  var byId = {};
  current.materials.forEach(function (material) { byId[material.id] = material; });
  return (Array.isArray(materials) ? materials : []).map(function (material) {
    var stored = material && byId[material.id];
    if (!stored || stored.googleFileId !== material.googleFileId || stored.folderId !== material.folderId ||
        stored.format !== material.format || stored.provider !== material.provider || stored.openUrl !== material.openUrl) return material;
    return w20MaterialWithRuntimeMetadata_(material, {
      mimeType: stored.mimeType,
      size: stored.size,
      driveMd5: stored.driveMd5,
      downloadName: stored.name === material.name ? stored.downloadName : material.name,
      normalizedUrl: stored.normalizedUrl
    });
  });
}

function w20NavigationBinding_(material, taskId, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(material && material.id);
  var secret = String(cfg && cfg.notionToken || '');
  if (!task || !page || !secret) return '';
  var fileId = w20SafeDriveId_(material && material.googleFileId) || '';
  var openUrl = WidgetV19Core.normalizeExternalUrl(material && material.openUrl || '') || '';
  var normalizedUrl = WidgetV19Core.normalizeExternalUrl(material && material.normalizedUrl || '') || '';
  var updatedAt = String(material && material.updatedAt || '').trim().slice(0, 100);
  var payload = [
    W20_NAVIGATION_BINDING_DOMAIN,
    WidgetV19Core.compactUuid(task),
    WidgetV19Core.compactUuid(page),
    fileId,
    openUrl,
    normalizedUrl,
    updatedAt,
    String(material && material.section || ''),
    String(material && material.format || '')
  ].join('\u0000');
  try {
    return Utilities.computeHmacSha256Signature(payload, secret).map(function (byte) {
      return (byte & 255).toString(16).padStart(2, '0');
    }).join('');
  } catch (_error) { return ''; }
}

function w20MaterialForClient_(material, taskId, cfg) {
  var out = {};
  Object.keys(material || {}).forEach(function (key) { out[key] = material[key]; });
  delete out.registryStoredAt;
  delete out.navigationBinding;
  var canonicalIdempotency = String(out.idempotency || '');
  delete out.idempotency;
  var eligible = out.provider === 'Google Drive' && w20SafeDriveId_(out.googleFileId) &&
    /^Google (?:Docs|Sheets|Slides)$/.test(String(out.format || '')) && !out.archived &&
    out.syncStatus !== 'deleting' && out.syncStatus !== 'deleted';
  if (eligible) {
    var parts = canonicalIdempotency.split('|');
    if (parts.length === 3 && parts[0] === WidgetV19Core.compactUuid(taskId) &&
        parts[1] === 'create-google-' + out.section &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parts[2])) {
      out.createRequestId = parts[2].toLowerCase();
    }
  }
  if (eligible && !(cfg && cfg.suppressDrivePollClaim === true)) out.drivePollClaim = w20IssueDrivePollClaim_(taskId, out.id, out.googleFileId, out, cfg);
  var navigationBinding = w20NavigationBinding_(out, taskId, cfg);
  if (navigationBinding) out.navigationBinding = navigationBinding;
  return out;
}

function w19AssertAllowedDataSource_(id, cfg) {
  var normalized = WidgetV19Core.normalizeUuid(id);
  if (!normalized || normalized !== cfg.dataSourceId || cfg.deniedDataSourceIds[normalized]) {
    throw new W19Error_('WRITE_BARRIER', 'Запись в этот data source запрещена write barrier.', false);
  }
  return normalized;
}

function w19IdSet_(csv) {
  var out = {};
  String(csv || '').split(',').forEach(function (part) {
    var id = WidgetV19Core.normalizeUuid(part);
    if (id) out[id] = true;
  });
  return out;
}

/* ========================= Common result/error helpers ========================= */

function w19ApiResult_(fn) {
  try { return { ok: true, data: fn() }; }
  catch (err) {
    var known = err instanceof W19Error_;
    var error = {
      code: known ? err.code : 'UNEXPECTED',
      message: known ? err.message : 'Операция не выполнена. Повторите попытку или откройте диагностику staging.',
      retryable: known ? err.retryable : true
    };
    w19Audit_('api_error', { code: error.code, retryable: error.retryable, stack: String(err && err.stack || '').slice(0, 1200) });
    return { ok: false, error: error };
  }
}

function w19SetArchiveState_(input, archived) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var materialId = WidgetV19Core.normalizeUuid(input && input.pageId);
    if (!materialId) throw new W19Error_('MATERIAL_ID_REQUIRED', 'Не указан материал.', false);
    var idem = w19CanonicalIdempotency_(task.id, (archived ? 'archive-' : 'restore-') + materialId, input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      return w19WithMutationLock_(function () {
        var page = w19AssertMaterialForTask_(materialId, task.id, cfg, true);
        if (page.in_trash) throw new W19Error_('MATERIAL_ARCHIVED', 'Материал находится в корзине.', false);
        var material = w19MaterialFromPage_(page);
        w20InvalidateDownloadMaterialCache_(task.id, materialId);
        if (material.syncStatus === 'deleting') throw new W19Error_('BUSY', 'Материал сейчас удаляется. Повторите через несколько секунд.', true);
        if (material.syncStatus === 'deleted') {
          if (!archived) throw new W19Error_('MATERIAL_DELETED', 'Физически удалённый материал нельзя восстановить.', false);
          if (!w20CancelAttachmentJob_(task.id, materialId)) throw new W19Error_('BUSY', 'Отмена фоновой копии ещё фиксируется.', true);
          w20SetDriveMaterialState_(material, task.id, 'deleted');
          w20RegistryRemove_(task.id, materialId);
          return { material: w20MaterialForClient_(material, task.id, cfg), archived: true, deleted: true, duplicate: true };
        }
        if (material.archived === archived) {
          if (archived && !w20CancelAttachmentJob_(task.id, materialId)) {
            throw new W19Error_('BUSY', 'Отмена фоновой копии ещё фиксируется.', true);
          }
          w20SetDriveMaterialState_(material, task.id, archived ? 'archived' : 'active');
          if (archived) w20RegistryRemove_(task.id, materialId);
          else {
            if (material.widgetOwnedBinary && !material.hostedAttachment) w20TryEnqueueAttachmentJob_(task.id, material, null);
            material = w20MaterialForClient_(material, task.id, cfg);
            if (!w20RegistryRestore_(task.id, material)) {
              throw new W19Error_('BUSY', 'Восстановление ещё фиксируется. Повторите через несколько секунд.', true);
            }
          }
          return { material: w20MaterialForClient_(material, task.id, cfg), archived: archived, duplicate: true };
        }
        var props = {};
        props[W19_P.ARCHIVE] = { checkbox: archived };
        props[W19_P.SYNC_STATUS] = w19Select_(archived ? 'archived' : 'synced');
        if (!archived) props[W19_P.POSITION] = { number: w19NextPosition_(task.id, material.section, cfg) };
        if (archived) {
          if (!w20CancelAttachmentJob_(task.id, materialId)) throw new W19Error_('BUSY', 'Отмена фоновой копии ещё фиксируется.', true);
          w20SetDriveMaterialState_(material, task.id, 'archived');
        }
        var updated = w19UpdateNotionPage_(page.id, props, cfg);
        var updatedRawMaterial = w19MaterialFromPage_(updated);
        if (!archived) {
          w20SetDriveMaterialState_(updatedRawMaterial, task.id, 'active');
          if (updatedRawMaterial.widgetOwnedBinary && !updatedRawMaterial.hostedAttachment) {
            w20TryEnqueueAttachmentJob_(task.id, updatedRawMaterial, null);
          }
        }
        var updatedMaterial = w20MaterialForClient_(updatedRawMaterial, task.id, cfg);
        if (archived) w20RegistryRemove_(task.id, materialId);
        else if (!w20RegistryRestore_(task.id, updatedMaterial)) {
          throw new W19Error_('BUSY', 'Восстановление ещё фиксируется. Повторите через несколько секунд.', true);
        }
        return { material: updatedMaterial, archived: archived };
      });
    });
  });
}

function w19Audit_(eventName, data) {
  var safe = data || {};
  console.log(JSON.stringify({ at: new Date().toISOString(), version: W19_VERSION, event: eventName, data: safe }));
}

function w19HumanBytes_(bytes) {
  if (bytes >= 1048576) return Math.round(bytes / 1048576 * 10) / 10 + ' MiB';
  return Math.round(bytes / 1024) + ' KiB';
}

function w19HostLabel_(url) {
  var match = String(url || '').match(/^https:\/\/([^/]+)/i);
  return match ? match[1].replace(/^www\./i, '') : 'Ссылка';
}

function w19ResolveGoogleLink_(fileId, originalUrl) {
  var drive;
  try { drive = w19GetDriveMetadata_(fileId); }
  catch (err) {
    var reason = String(err && err.details && err.details.reason || '');
    if (err && (err.code === 'DRIVE_NOT_FOUND' || (err.code === 'DRIVE_ERROR' && /permission|forbidden|access denied|not authorized|insufficient/i.test(reason)))) {
      throw new W19Error_('GOOGLE_LINK_NOT_ACCESSIBLE', 'Нет доступа к этому объекту Google Drive. Проверьте ссылку и откройте доступ владельцу виджета.', false);
    }
    throw err;
  }
  if (!drive || drive.trashed) {
    throw new W19Error_('GOOGLE_LINK_NOT_ACCESSIBLE', 'Объект Google Drive не найден, удалён или не открыт владельцу виджета.', false);
  }
  var data = WidgetV19Core.describeGoogleMetadata(drive, originalUrl);
  if (!data.id || !data.sourceUrl) {
    throw new W19Error_('GOOGLE_LINK_NOT_ACCESSIBLE', 'Google Drive не вернул данные, необходимые для сохранения ссылки.', false);
  }
  data.googleFileId = data.id;
  return data;
}

function w19DefaultGoogleName_(section) {
  var label = section === 'Docs' ? 'Документ' : (section === 'Sheets' ? 'Таблица' : 'Презентация');
  return label + ' — ' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd HH:mm');
}

/* ========================= Notion layer ========================= */

function w19AssertSchema_(cfg, force) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'w20:schema:' + cfg.dataSourceId + ':' + cfg.notionVersion;
  if (!force) {
    var cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }
  var source = w19NotionRequest_('get', '/v1/data_sources/' + cfg.dataSourceId, null, cfg);
  var missing = [];
  Object.keys(W19_REQUIRED_SCHEMA).forEach(function (name) {
    var property = source.properties && source.properties[name];
    var expected = W19_REQUIRED_SCHEMA[name];
    if (!property) missing.push(name + ' (нет свойства)');
    else if (property.type !== expected) missing.push(name + ' (ожидался ' + expected + ', найден ' + property.type + ')');
  });
  var result = { ok: missing.length === 0, checked: Object.keys(W19_REQUIRED_SCHEMA).length, missing: missing };
  if (missing.length) throw new W19Error_('SCHEMA_MISMATCH', 'Схема «Элементы» не готова для v20: ' + missing.slice(0, 4).join('; ') + (missing.length > 4 ? '…' : ''), false, result);
  cache.put(cacheKey, JSON.stringify(result), 300);
  return result;
}

function w19ReserveNotionRequestSlot_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(W19_NOTION_RATE_LOCK_WAIT_MS)) {
    throw new W19Error_('NOTION_RATE_LIMIT_BUSY', 'Очередь запросов Notion занята. Повторите через несколько секунд.', true);
  }
  var waitMs = 0;
  try {
    var cache = CacheService.getScriptCache();
    var now = Date.now();
    var previousAt = Number(cache.get(W19_NOTION_RATE_CACHE_KEY));
    if (!isFinite(previousAt) || previousAt <= 0) previousAt = 0;
    if (previousAt > now + W19_NOTION_RATE_LOCK_WAIT_MS) {
      throw new W19Error_('NOTION_RATE_LIMIT_BUSY', 'Очередь запросов Notion занята. Повторите через несколько секунд.', true);
    }
    var reservedAt = previousAt ? Math.max(now, previousAt + W19_NOTION_RATE_INTERVAL_MS) : now;
    waitMs = Math.max(0, reservedAt - now);
    cache.put(W19_NOTION_RATE_CACHE_KEY, String(reservedAt), 120);
  } finally {
    lock.releaseLock();
  }
  if (waitMs) Utilities.sleep(waitMs);
}

function w19NotionRequest_(method, path, body, cfg, requestOptions) {
  var url = 'https://api.notion.com' + path;
  var lastError;
  var maxAttempts = requestOptions && requestOptions.noRetry ? 1 : 4;
  for (var attempt = 0; attempt < maxAttempts; attempt += 1) {
    var options = {
      method: method,
      muteHttpExceptions: true,
      headers: {
        Authorization: 'Bearer ' + cfg.notionToken,
        'Notion-Version': cfg.notionVersion,
        Accept: 'application/json'
      }
    };
    if (body !== null && body !== undefined) {
      options.contentType = 'application/json';
      options.payload = JSON.stringify(body);
    }
    var response;
    w19ReserveNotionRequestSlot_();
    try { response = UrlFetchApp.fetch(url, options); }
    catch (networkErr) {
      lastError = networkErr;
      var networkMessage = String(networkErr && networkErr.message || networkErr || '');
      if (/service invoked too many times.*urlfetch|urlfetch.*too many times/i.test(networkMessage)) {
        throw new W19Error_('GOOGLE_URLFETCH_QUOTA', 'Google временно исчерпал дневной лимит соединения с Notion. Виджет автоматически продолжит работу после обновления лимита.', true);
      }
      if (attempt + 1 < maxAttempts) { Utilities.sleep(400 * Math.pow(2, attempt) + Math.floor(Math.random() * 200)); continue; }
      throw new W19Error_('NOTION_UNAVAILABLE', 'Notion API временно недоступен.', true, { reason: networkMessage.slice(0, 300) });
    }
    var status = response.getResponseCode();
    var text = response.getContentText() || '{}';
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (_parseErr) { parsed = { message: 'Invalid JSON response' }; }
    if (status >= 200 && status < 300) return parsed;
    lastError = parsed;
    if ((status === 429 || status >= 500) && attempt + 1 < maxAttempts) {
      var retryHeader = Number(response.getHeaders()['Retry-After'] || 0);
      var retryDelay = Math.max(retryHeader * 1000, 500 * Math.pow(2, attempt));
      Utilities.sleep(Math.min(retryDelay, W19_NOTION_MAX_RETRY_DELAY_MS) + Math.floor(Math.random() * 250));
      continue;
    }
    if (status === 401 || status === 403) throw new W19Error_('NOTION_FORBIDDEN', 'Notion connection не имеет нужного доступа.', false);
    if (status === 404) throw new W19Error_('NOTION_NOT_FOUND', 'Объект Notion не найден или не открыт connection.', false);
    if (status === 409) throw new W19Error_('NOTION_CONFLICT', 'Notion сообщил о конфликте. Повторите операцию.', true);
    throw new W19Error_('NOTION_ERROR', 'Notion отклонил операцию (' + status + ').', status === 429 || status >= 500, { code: parsed.code || null });
  }
  throw new W19Error_('NOTION_UNAVAILABLE', 'Notion API временно недоступен.', true, { reason: String(lastError || '') });
}

function w20NormalizeNotionUpload_(upload, expectedId) {
  var uploadId = WidgetV19Core.normalizeUuid(upload && upload.id);
  var expected = expectedId ? WidgetV19Core.normalizeUuid(expectedId) : uploadId;
  var status = String(upload && upload.status || '');
  if (!uploadId || uploadId !== expected || upload.object !== 'file_upload' ||
      ['pending', 'uploaded', 'expired', 'failed'].indexOf(status) === -1) {
    throw new W19Error_('NOTION_UPLOAD_INVALID', 'Notion вернул некорректное состояние загрузки.', true);
  }
  return {
    id: uploadId,
    status: status,
    expiry_time: upload.expiry_time === null ? null : String(upload.expiry_time || '')
  };
}

function w20CreateNotionUpload_(mimeType, filename, cfg) {
  var name = WidgetV19Core.cleanName(filename, 'Файл');
  var mime = WidgetV19Core.cleanMime(mimeType);
  var upload = w19NotionRequest_('post', '/v1/file_uploads', {
    mode: 'single_part',
    filename: name,
    content_type: mime
  }, cfg);
  var normalized = w20NormalizeNotionUpload_(upload);
  if (normalized.status !== 'pending') {
    throw new W19Error_('NOTION_UPLOAD_INVALID', 'Notion не подготовил загрузку файла.', true);
  }
  var canonicalUrl = 'https://api.notion.com/v1/file_uploads/' + encodeURIComponent(normalized.id) + '/send';
  var uploadUrl = String(upload.upload_url || canonicalUrl).trim();
  if (uploadUrl !== canonicalUrl && uploadUrl.indexOf(canonicalUrl + '?') !== 0) {
    throw new W19Error_('NOTION_UPLOAD_INVALID', 'Notion вернул небезопасный адрес загрузки.', false);
  }
  return normalized;
}

function w20GetNotionUpload_(uploadId, cfg, allowMissing) {
  var normalizedId = WidgetV19Core.normalizeUuid(uploadId);
  if (!normalizedId) throw new W19Error_('NOTION_UPLOAD_INVALID', 'Не указан идентификатор загрузки Notion.', false);
  try {
    return w20NormalizeNotionUpload_(
      w19NotionRequest_('get', '/v1/file_uploads/' + encodeURIComponent(normalizedId), null, cfg), normalizedId);
  } catch (error) {
    if (allowMissing === true && error && error.code === 'NOTION_NOT_FOUND') return null;
    throw error;
  }
}

function w20SendNotionUploadBlob_(uploadId, blob, cfg) {
  var normalizedId = WidgetV19Core.normalizeUuid(uploadId);
  if (!normalizedId || !blob) throw new W19Error_('NOTION_UPLOAD_INVALID', 'Не подготовлен файл для загрузки Notion.', false);
  var uploadUrl = 'https://api.notion.com/v1/file_uploads/' + encodeURIComponent(normalizedId) + '/send';

  for (var attempt = 0; attempt < 3; attempt += 1) {
    var response;
    try {
      response = UrlFetchApp.fetch(uploadUrl, {
        method: 'post',
        muteHttpExceptions: true,
        headers: {
          Authorization: 'Bearer ' + cfg.notionToken,
          'Notion-Version': cfg.notionVersion,
          Accept: 'application/json'
        },
        payload: { file: blob }
      });
    } catch (_networkErr) {
      var uploadNetworkMessage = String(_networkErr && _networkErr.message || _networkErr || '');
      if (/service invoked too many times.*urlfetch|urlfetch.*too many times/i.test(uploadNetworkMessage)) {
        throw new W19Error_('GOOGLE_URLFETCH_QUOTA', 'Google временно исчерпал дневной лимит соединения с Notion. Загрузка автоматически станет доступна после обновления лимита.', true);
      }
      var uncertain = w20GetNotionUpload_(normalizedId, cfg, true);
      if (uncertain && uncertain.status === 'uploaded') return uncertain;
      if (attempt < 2) {
        Utilities.sleep(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
        continue;
      }
      throw new W19Error_('NOTION_UPLOAD_UNAVAILABLE', 'Notion временно не принял файл.', true);
    }

    var status = response.getResponseCode();
    var text = response.getContentText() || '{}';
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (_parseErr) { parsed = {}; }
    if (status >= 200 && status < 300) {
      var sent = w20NormalizeNotionUpload_(parsed, normalizedId);
      if (sent.status === 'uploaded') return sent;
      throw new W19Error_('NOTION_UPLOAD_INCOMPLETE', 'Notion не завершил загрузку файла.', true);
    }
    var observed = status !== 401 && status !== 403 ? w20GetNotionUpload_(normalizedId, cfg, true) : null;
    if (observed && observed.status === 'uploaded') {
      return observed;
    }
    if ((status === 429 || status >= 500) && attempt < 2) {
      var retryHeader = Number(response.getHeaders()['Retry-After'] || 0);
      var retryDelay = Math.max(retryHeader * 1000, 500 * Math.pow(2, attempt));
      Utilities.sleep(Math.min(retryDelay, W19_NOTION_MAX_RETRY_DELAY_MS) + Math.floor(Math.random() * 250));
      continue;
    }
    if (status === 401 || status === 403) throw new W19Error_('NOTION_FORBIDDEN', 'Notion connection не имеет права загружать файлы.', false);
    if (status === 404) throw new W19Error_('NOTION_UPLOAD_EXPIRED', 'Срок подготовленной загрузки Notion истёк.', true);
    throw new W19Error_('NOTION_UPLOAD_FAILED', 'Notion отклонил загрузку файла (' + status + ').', status >= 500, { code: parsed.code || null });
  }
  throw new W19Error_('NOTION_UPLOAD_UNAVAILABLE', 'Notion временно не принял файл.', true);
}

function w19CreateAndSendNotionUpload_(bytes, mimeType, filename, cfg) {
  var name = WidgetV19Core.cleanName(filename, 'Файл');
  var mime = WidgetV19Core.cleanMime(mimeType);
  var created = w20CreateNotionUpload_(mime, name, cfg);
  var sent = w20SendNotionUploadBlob_(created.id, Utilities.newBlob(bytes, mime, name), cfg);
  return { id: sent.id, name: name, mimeType: mime };
}

function w19NotionUploadIsComplete_(uploadId, cfg) {
  try {
    var upload = w20GetNotionUpload_(uploadId, cfg, false);
    return Boolean(upload && upload.status === 'uploaded');
  } catch (_err) {
    return false;
  }
}

function w19EffectiveUploadLimit_(cfg) {
  var configured = Math.min(Number(cfg.maxUploadBytes) || W19_NOTION_SINGLE_PART_MAX_BYTES, W19_NOTION_SINGLE_PART_MAX_BYTES);
  var cache = CacheService.getScriptCache();
  var cacheKey = 'w20:notion-upload-limit:' + String(cfg.dataSourceId || cfg.notionVersion || 'workspace');
  var cached = Number(cache.get(cacheKey));
  if (isFinite(cached) && cached > 0) return Math.floor(Math.min(configured, cached));

  var me = w19NotionRequest_('get', '/v1/users/me', null, cfg);
  var workspaceLimit = Number(me && me.bot && me.bot.workspace_limits && me.bot.workspace_limits.max_file_upload_size_in_bytes);
  if (!isFinite(workspaceLimit) || workspaceLimit <= 0) workspaceLimit = W19_NOTION_SINGLE_PART_MAX_BYTES;
  var effective = Math.floor(Math.min(configured, workspaceLimit, W19_NOTION_SINGLE_PART_MAX_BYTES));
  cache.put(cacheKey, String(effective), 600);
  return effective;
}

function w19AssertTaskPage_(value, cfg) {
  var id = WidgetV19Core.normalizeUuid(value);
  if (!id) throw new W19Error_('TASK_ID_REQUIRED', 'В URL виджета отсутствует корректный task_page_id.', false);
  if (cfg.deniedPageIds[id]) throw new W19Error_('WRITE_BARRIER', 'Эта страница запрещена write barrier.', false);
  var page = w19NotionRequest_('get', '/v1/pages/' + id, null, cfg);
  if (page.in_trash) throw new W19Error_('TASK_ARCHIVED', 'Задача находится в корзине.', false);
  var parentId = page.parent && (page.parent.data_source_id || (page.parent.type === 'data_source_id' && page.parent[page.parent.type]));
  w19AssertAllowedDataSource_(parentId, cfg);
  var type = w19SelectValue_(page.properties && page.properties[W19_P.TYPE]);
  if (type !== 'Задача') throw new W19Error_('NOT_A_TASK', 'Виджет можно открывать только внутри записи Тип = Задача.', false);
  if (w19CheckboxValue_(page.properties && page.properties[W19_P.ARCHIVE])) throw new W19Error_('TASK_ARCHIVED', 'Задача помечена как архивная.', false);
  return { id: WidgetV19Core.normalizeUuid(page.id), name: w19TitleValue_(page.properties && page.properties[W19_P.NAME]) || 'Задача', page: page };
}

function w20DownloadMaterialCacheKey_(taskId, pageId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var page = WidgetV19Core.compactUuid(pageId);
  if (!task || !page) return '';
  return W20_DOWNLOAD_MATERIAL_CACHE_PREFIX + w19Hash_(task + '|' + page).slice(0, 48);
}

function w20SafeDriveId_(value) {
  var id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : '';
}

function w20DownloadCacheEntryFromPage_(taskId, page, cfg, now) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var pageId = WidgetV19Core.normalizeUuid(page && page.id);
  var dataSourceId = WidgetV19Core.normalizeUuid(cfg && cfg.dataSourceId);
  if (!task || !pageId || !dataSourceId || !page || page.in_trash ||
      (cfg.deniedPageIds && cfg.deniedPageIds[pageId])) return null;
  var parentId = page.parent && (page.parent.data_source_id || (page.parent.type === 'data_source_id' && page.parent[page.parent.type]));
  if (WidgetV19Core.normalizeUuid(parentId) !== dataSourceId) return null;
  var props = page.properties || {};
  if (w19SelectValue_(props[W19_P.TYPE]) !== 'Знание' ||
      w19RelationIds_(props[W19_P.INSIDE]).indexOf(task) === -1 ||
      w19CheckboxValue_(props[W19_P.ARCHIVE])) return null;
  var material = w19MaterialFromPage_(page);
  var googleFileId = w20SafeDriveId_(material.googleFileId);
  var folderId = w20SafeDriveId_(material.folderId);
  if (!material.widgetOwnedBinary || material.provider !== 'Google Drive' || !googleFileId || !folderId ||
      material.syncStatus === 'deleting' || material.syncStatus === 'deleted') return null;
  return {
    schema: W20_DOWNLOAD_MATERIAL_CACHE_SCHEMA,
    taskId: WidgetV19Core.compactUuid(task),
    pageId: WidgetV19Core.compactUuid(pageId),
    dataSourceId: WidgetV19Core.compactUuid(dataSourceId),
    googleFileId: googleFileId,
    folderId: folderId,
    expiresAt: Number(now) + W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS * 1000
  };
}

function w20CacheDownloadMaterials_(taskId, pages, cfg) {
  var entries = {};
  var removals = [];
  var invalidPageIds = [];
  var now = Date.now();
  (Array.isArray(pages) ? pages : []).forEach(function (page) {
    var entry = w20DownloadCacheEntryFromPage_(taskId, page, cfg, now);
    var key = w20DownloadMaterialCacheKey_(taskId, page && page.id);
    if (!key) return;
    if (entry) entries[key] = JSON.stringify(entry);
    else {
      removals.push(key);
      if (page && page.id) invalidPageIds.push(page.id);
    }
  });
  var keys = Object.keys(entries);
  if (!keys.length && !removals.length) return 0;
  try {
    var cache = CacheService.getScriptCache();
    if (removals.length) {
      if (typeof cache.removeAll === 'function') cache.removeAll(removals);
      else if (typeof cache.remove === 'function') removals.forEach(function (key) { cache.remove(key); });
    }
    if (keys.length && typeof cache.putAll === 'function') cache.putAll(entries, W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS);
    else keys.forEach(function (key) { cache.put(key, entries[key], W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS); });
    invalidPageIds.forEach(function (pageId) {
      w20InvalidateDownloadMaterialCache_(taskId, pageId, false);
    });
    return keys.length;
  } catch (_cacheErr) {
    return 0;
  }
}

function w20CacheDownloadRegistryMaterials_(taskId, materials, cfg, trustedUntil) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var dataSourceId = WidgetV19Core.normalizeUuid(cfg && cfg.dataSourceId);
  var proofExpiry = Date.parse(String(trustedUntil || ''));
  var now = Date.now();
  var expiresAt = Math.min(now + W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS * 1000, proofExpiry);
  var cacheTtlSeconds = Math.floor((expiresAt - now) / 1000);
  if (!task || !dataSourceId || !isFinite(proofExpiry) || cacheTtlSeconds <= 0) return 0;
  var entries = {};
  (Array.isArray(materials) ? materials : []).forEach(function (material) {
    var pageId = WidgetV19Core.normalizeUuid(material && material.id);
    var googleFileId = w20SafeDriveId_(material && material.googleFileId);
    var folderId = w20SafeDriveId_(material && material.folderId);
    var key = w20DownloadMaterialCacheKey_(task, pageId);
    if (!pageId || !googleFileId || !folderId || !key ||
        (cfg.deniedPageIds && cfg.deniedPageIds[pageId]) || !material.widgetOwnedBinary ||
        material.provider !== 'Google Drive' || material.archived ||
        material.syncStatus === 'deleting' || material.syncStatus === 'deleted') return;
    entries[key] = JSON.stringify({
      schema: W20_DOWNLOAD_MATERIAL_CACHE_SCHEMA,
      taskId: WidgetV19Core.compactUuid(task),
      pageId: WidgetV19Core.compactUuid(pageId),
      dataSourceId: WidgetV19Core.compactUuid(dataSourceId),
      googleFileId: googleFileId,
      folderId: folderId,
      expiresAt: expiresAt
    });
  });
  var keys = Object.keys(entries);
  if (!keys.length) return 0;
  try {
    var cache = CacheService.getScriptCache();
    if (typeof cache.putAll === 'function') cache.putAll(entries, cacheTtlSeconds);
    else keys.forEach(function (key) { cache.put(key, entries[key], cacheTtlSeconds); });
    return keys.length;
  } catch (_registryDownloadCacheError) {
    return 0;
  }
}

function w20GetCachedDownloadMaterial_(taskId, pageId, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  var dataSourceId = WidgetV19Core.normalizeUuid(cfg && cfg.dataSourceId);
  var key = w20DownloadMaterialCacheKey_(task, page);
  if (!task || !page || !dataSourceId || !key || (cfg.deniedPageIds && cfg.deniedPageIds[page])) return null;
  var cache;
  var raw;
  try {
    cache = CacheService.getScriptCache();
    raw = cache.get(key);
  } catch (_cacheReadErr) {
    return null;
  }
  if (!raw) return null;
  var entry;
  try { entry = JSON.parse(raw); }
  catch (_parseErr) { entry = null; }
  var now = Date.now();
  var expiresAt = Number(entry && entry.expiresAt || 0);
  var valid = Boolean(entry && entry.schema === W20_DOWNLOAD_MATERIAL_CACHE_SCHEMA &&
    entry.taskId === WidgetV19Core.compactUuid(task) &&
    entry.pageId === WidgetV19Core.compactUuid(page) &&
    entry.dataSourceId === WidgetV19Core.compactUuid(dataSourceId) &&
    expiresAt > now && expiresAt - now <= W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS * 1000 &&
    w20SafeDriveId_(entry.googleFileId) === entry.googleFileId &&
    w20SafeDriveId_(entry.folderId) === entry.folderId);
  if (!valid) {
    try { if (cache && typeof cache.remove === 'function') cache.remove(key); } catch (_cacheRemoveErr) {}
    return null;
  }
  return {
    id: page,
    provider: 'Google Drive',
    googleFileId: entry.googleFileId,
    folderId: entry.folderId
  };
}

function w20FreshRegistryDownloadProof_(taskId, pageId, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  var compactTask = WidgetV19Core.compactUuid(task);
  var compactPage = WidgetV19Core.compactUuid(page);
  if (!task || !page || !compactTask || !compactPage || !cfg ||
      task !== cfg.authorizedTaskPageId || (cfg.deniedPageIds && cfg.deniedPageIds[page])) return null;
  var values;
  try { values = PropertiesService.getScriptProperties().getProperties(); }
  catch (_propertyError) { return null; }
  var registry;
  var meta;
  try {
    registry = w20RegistryReadTaskResultFromValues_(task, null, values);
    meta = w20RegistryParseTaskMeta_(task, values[w20RegistryMetaKey_(task)]);
  } catch (_registryError) {
    return null;
  }
  var proof = w20RegistryActionProof_(meta, registry, cfg.rootFolderId);
  var registryMaterials = registry && Array.isArray(registry.materials) ? registry.materials : [];
  if (!proof.ready || !meta || !registry || !registry.ok || !registry.integrityOk ||
      registry.activeCount !== registryMaterials.length || registry.activeCount !== meta.snapshotActiveCount) return null;
  var exact = null;
  var exactCount = 0;
  registryMaterials.forEach(function (candidate) {
    if (WidgetV19Core.normalizeUuid(candidate && candidate.id) !== page) return;
    exact = candidate;
    exactCount += 1;
  });
  if (exactCount !== 1 || !exact) return null;
  return {
    taskId: compactTask,
    pageId: compactPage,
    meta: meta,
    registry: registry,
    proof: proof,
    material: exact
  };
}

function w20FastPreparedDownloadDrive_(taskId, pageId, material, cfg, registryProof) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  var compactTask = WidgetV19Core.compactUuid(task);
  var compactPage = WidgetV19Core.compactUuid(page);
  var fileId = w20SafeDriveId_(material && material.googleFileId);
  var folderId = w20SafeDriveId_(material && material.folderId);
  if (!task || !page || !compactTask || !compactPage || !material ||
      WidgetV19Core.normalizeUuid(material.id) !== page || material.provider !== 'Google Drive' ||
      !fileId || fileId !== material.googleFileId || !folderId || folderId !== material.folderId ||
      (cfg.deniedPageIds && cfg.deniedPageIds[page])) return null;

  var snapshot = registryProof || null;
  var meta = snapshot && snapshot.meta;
  var registry = snapshot && snapshot.registry;
  var proof = snapshot && snapshot.proof;
  var registryMaterials = registry && Array.isArray(registry.materials) ? registry.materials : [];
  if (!snapshot || snapshot.taskId !== compactTask || snapshot.pageId !== compactPage ||
      !proof || !proof.ready || !meta || meta.folderId !== folderId ||
      registry.activeCount !== registryMaterials.length || registry.activeCount !== meta.snapshotActiveCount) return null;

  var exact = snapshot.material;
  if (!exact || WidgetV19Core.normalizeUuid(exact.id) !== page || exact.widgetOwnedBinary !== true || exact.provider !== 'Google Drive' ||
      exact.archived || exact.googleFileId !== fileId || exact.folderId !== folderId) return null;

  var drive = w19GetDriveMetadata_(fileId);
  var driveProps = drive && drive.appProperties || {};
  var driveParents = drive && Array.isArray(drive.parents) ? drive.parents : [];
  var markerOk = driveProps.widgetVersion === W20_DRIVE_MARKER || driveProps.widgetVersion === 'v19';
  var materialState = String(driveProps.materialState || '').trim().toLowerCase();
  var rawSize = drive && drive.size !== null && drive.size !== undefined ? String(drive.size).trim() : '';
  var size = Number(rawSize);
  var maxSize = Number(cfg.maxUploadBytes);
  if (!drive || drive.id !== fileId || drive.ownedByMe !== true || drive.trashed || !markerOk ||
      materialState !== 'active' || driveProps.taskPageId !== compactTask ||
      WidgetV19Core.compactUuid(driveProps.notionPageId) !== compactPage ||
      driveParents.length !== 1 || driveParents[0] !== folderId ||
      /^application\/vnd\.google-apps\./.test(String(drive.mimeType || '')) ||
      !/^\d+$/.test(rawSize) || !isFinite(size) || size < 0 || !isFinite(maxSize) || maxSize < 0 || size > maxSize) return null;
  return drive;
}

function w20DownloadGrantEpochKey_(taskId, pageId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var page = WidgetV19Core.compactUuid(pageId);
  if (!task || !page) return '';
  return W20_DOWNLOAD_GRANT_EPOCH_PREFIX + w19Hash_(task + '|' + page).slice(0, 48);
}

function w20ParseDownloadGrantEpoch_(value) {
  var raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return 0;
  if (!/^\d{1,12}$/.test(raw)) return null;
  var epoch = Number(raw);
  return isFinite(epoch) && epoch >= 0 && Math.floor(epoch) === epoch ? epoch : null;
}

function w20DownloadGrantEpoch_(taskId, pageId) {
  var key = w20DownloadGrantEpochKey_(taskId, pageId);
  if (!key) return null;
  try {
    return w20ParseDownloadGrantEpoch_(PropertiesService.getScriptProperties().getProperty(key));
  } catch (_propertiesError) {
    return null;
  }
}

function w20InvalidateDownloadMaterialCache_(taskId, pageId, strict) {
  var key = w20DownloadMaterialCacheKey_(taskId, pageId);
  var grantKey = w20DownloadGrantCacheKey_(taskId, pageId);
  var epochKey = w20DownloadGrantEpochKey_(taskId, pageId);
  if (!key || !grantKey || !epochKey) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    if (strict === false) return false;
    throw new W19Error_('BUSY', 'Не удалось отозвать ссылку скачивания. Повторите операцию.', true);
  }
  try {
    var properties = PropertiesService.getScriptProperties();
    var currentEpoch = w20ParseDownloadGrantEpoch_(properties.getProperty(epochKey));
    if (currentEpoch === null) currentEpoch = 0;
    properties.setProperty(epochKey, String(currentEpoch + 1));
    var cache = CacheService.getScriptCache();
    if (typeof cache.removeAll === 'function') cache.removeAll([key, grantKey]);
    else if (typeof cache.remove === 'function') [key, grantKey].forEach(function (item) { cache.remove(item); });
    return true;
  } catch (error) {
    if (strict === false) return false;
    if (error instanceof W19Error_) throw error;
    throw new W19Error_('BUSY', 'Не удалось отозвать ссылку скачивания. Повторите операцию.', true);
  } finally {
    lock.releaseLock();
  }
}

function w19AssertMaterialForTask_(pageId, taskId, cfg, allowArchived) {
  var id = WidgetV19Core.normalizeUuid(pageId);
  if (!id) throw new W19Error_('MATERIAL_ID_REQUIRED', 'Не указан материал.', false);
  if (cfg.deniedPageIds[id]) throw new W19Error_('WRITE_BARRIER', 'Материал запрещён write barrier.', false);
  var page = w19NotionRequest_('get', '/v1/pages/' + id, null, cfg);
  var parentId = page.parent && (page.parent.data_source_id || (page.parent.type === 'data_source_id' && page.parent[page.parent.type]));
  w19AssertAllowedDataSource_(parentId, cfg);
  if (w19SelectValue_(page.properties && page.properties[W19_P.TYPE]) !== 'Знание') throw new W19Error_('NOT_A_MATERIAL', 'Запись не является знанием.', false);
  var relations = w19RelationIds_(page.properties && page.properties[W19_P.INSIDE]);
  if (relations.indexOf(WidgetV19Core.normalizeUuid(taskId)) === -1) throw new W19Error_('MATERIAL_TASK_MISMATCH', 'Материал не принадлежит этой задаче.', false);
  if (!allowArchived && (page.in_trash || w19CheckboxValue_(page.properties && page.properties[W19_P.ARCHIVE]))) throw new W19Error_('MATERIAL_ARCHIVED', 'Материал уже архивирован.', false);
  return page;
}

function w19QueryTaskMaterials_(taskId, cfg) {
  var pages = [];
  var cursor = null;
  do {
    var body = {
      page_size: 100,
      filter: {
        and: [
          { property: W19_P.TYPE, select: { equals: 'Знание' } },
          { property: W19_P.INSIDE, relation: { contains: taskId } },
          { property: W19_P.ARCHIVE, checkbox: { equals: false } }
        ]
      },
      sorts: [
        { property: W19_P.POSITION, direction: 'ascending' },
        { timestamp: 'created_time', direction: 'ascending' }
      ]
    };
    if (cursor) body.start_cursor = cursor;
    var result = w19NotionRequest_('post', '/v1/data_sources/' + cfg.dataSourceId + '/query', body, cfg);
    pages = pages.concat(result.results || []);
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor && pages.length < 1000);
  return pages;
}

function w19FindMaterialByIdempotency_(taskId, key, cfg) {
  return w19FindOneMaterial_(taskId, { property: W19_P.IDEMPOTENCY, rich_text: { equals: key } }, cfg);
}

function w19FindMaterialByGoogleFile_(taskId, fileId, cfg) {
  if (!fileId) return null;
  return w19FindOneMaterial_(taskId, { property: W19_P.GOOGLE_FILE_ID, rich_text: { equals: fileId } }, cfg);
}

function w19FindMaterialBySourceUrl_(taskId, url, cfg) {
  if (!url) return null;
  return w19FindOneMaterial_(taskId, { property: W19_P.SOURCE, url: { equals: url } }, cfg);
}

function w19FindMaterialCollision_(taskId, currentPageId, fileId, url, cfg) {
  var alternatives = [];
  if (fileId) alternatives.push({ property: W19_P.GOOGLE_FILE_ID, rich_text: { equals: fileId } });
  if (url) alternatives.push({ property: W19_P.SOURCE, url: { equals: url } });
  if (!alternatives.length) return null;
  var result = w19NotionRequest_('post', '/v1/data_sources/' + cfg.dataSourceId + '/query', {
    page_size: 20,
    filter: {
      and: [
        { property: W19_P.TYPE, select: { equals: 'Знание' } },
        { property: W19_P.INSIDE, relation: { contains: taskId } },
        alternatives.length === 1 ? alternatives[0] : { or: alternatives }
      ]
    }
  }, cfg);
  var currentId = WidgetV19Core.normalizeUuid(currentPageId);
  var pages = result.results || [];
  for (var i = 0; i < pages.length; i += 1) {
    if (WidgetV19Core.normalizeUuid(pages[i].id) !== currentId) return pages[i];
  }
  return null;
}

function w19FindOneMaterial_(taskId, extraFilter, cfg) {
  var result = w19NotionRequest_('post', '/v1/data_sources/' + cfg.dataSourceId + '/query', {
    page_size: 2,
    filter: {
      and: [
        { property: W19_P.TYPE, select: { equals: 'Знание' } },
        { property: W19_P.INSIDE, relation: { contains: taskId } },
        extraFilter
      ]
    }
  }, cfg);
  return result.results && result.results.length ? result.results[0] : null;
}

function w19NextPosition_(taskId, section, cfg) {
  var normalizedSection = WidgetV19Core.assertSection(section);
  var result = w19NotionRequest_('post', '/v1/data_sources/' + cfg.dataSourceId + '/query', {
    page_size: 1,
    filter: {
      and: [
        { property: W19_P.TYPE, select: { equals: 'Знание' } },
        { property: W19_P.INSIDE, relation: { contains: taskId } },
        { property: W19_P.ARCHIVE, checkbox: { equals: false } },
        { property: W19_P.SECTION, select: { equals: normalizedSection } }
      ]
    },
    sorts: [
      { property: W19_P.POSITION, direction: 'descending' },
      { timestamp: 'created_time', direction: 'descending' }
    ]
  }, cfg);
  var page = result.results && result.results.length ? result.results[0] : null;
  var notionNext = w19NumberValue_(page && page.properties && page.properties[W19_P.POSITION], -1) + 1;
  return w20RegistryReservePosition_(taskId, normalizedSection, notionNext);
}

function w19CreateNotionMaterial_(task, data, cfg) {
  var props = {};
  props[W19_P.NAME] = w19Title_(data.name);
  props[W19_P.TYPE] = w19Select_('Знание');
  props[W19_P.INSIDE] = { relation: [{ id: task.id }] };
  props[W19_P.SOURCE] = { url: data.sourceUrl || null };
  props[W19_P.ATTACHMENTS] = Array.isArray(data.attachments) ? { files: data.attachments } : (data.sourceUrl ? {
    files: [{ name: WidgetV19Core.cleanName(data.downloadName || data.name, 'Файл'), type: 'external', external: { url: data.sourceUrl } }]
  } : { files: [] });
  props[W19_P.KNOWLEDGE_FORMAT] = w19Select_(data.knowledgeFormat || 'Файл');
  props[W19_P.ARCHIVE] = { checkbox: false };
  props[W19_P.FILE_FORMAT] = w19Select_(data.format || 'Other File');
  props[W19_P.SECTION] = w19Select_(WidgetV19Core.assertSection(data.section));
  props[W19_P.GOOGLE_FILE_ID] = w19Text_(data.googleFileId || '');
  props[W19_P.GOOGLE_FOLDER_ID] = w19Text_(data.googleFolderId || '');
  props[W19_P.POSITION] = { number: Number(data.position || 0) };
  props[W19_P.SYNC_STATUS] = w19Select_('synced');
  props[W19_P.IDEMPOTENCY] = w19Text_(data.idempotency || '');
  w19AppendContextProperties_(props, task, data.name);
  var createBody = {
    parent: { type: 'data_source_id', data_source_id: cfg.dataSourceId },
    properties: props
  };
  try {
    return w19NotionRequest_('post', '/v1/pages', createBody, cfg, { noRetry: true });
  } catch (err) {
    if (!data.idempotency || !(err && err.retryable)) throw err;
    for (var attempt = 0; attempt < 3; attempt += 1) {
      var existing = null;
      try { existing = w19FindMaterialByIdempotency_(task.id, data.idempotency, cfg); }
      catch (_lookupError) { existing = null; }
      if (existing) return existing;
      if (attempt < 2) Utilities.sleep(350 * Math.pow(2, attempt));
    }
    throw err;
  }
}

function w19AppendContextProperties_(props, task, materialName) {
  var taskProps = task.page.properties || {};
  [W19_P.CONTEXT_SPHERE, W19_P.CONTEXT_DIRECTION, W19_P.CONTEXT_PROJECT].forEach(function (name) {
    var ids = w19RelationIds_(taskProps[name]);
    if (ids.length) props[name] = { relation: ids.map(function (id) { return { id: id }; }) };
  });
  var taskPath = w19TextValue_(taskProps[W19_P.CONTEXT_PATH]);
  if (taskPath) props[W19_P.CONTEXT_PATH] = w19Text_((taskPath + ' / ' + WidgetV19Core.cleanName(materialName, 'Материал')).slice(0, 1900));
  var ancestors = w19TextValue_(taskProps[W19_P.ANCESTOR_IDS]);
  var compactTask = WidgetV19Core.compactUuid(task.id);
  var parts = ancestors ? ancestors.split(/[\s,;|>]+/).filter(Boolean) : [];
  if (parts.indexOf(compactTask) === -1) parts.push(compactTask);
  props[W19_P.ANCESTOR_IDS] = w19Text_(parts.join('|').slice(0, 1900));
  var depth = w19NumberValue_(taskProps[W19_P.DEPTH], 0);
  props[W19_P.DEPTH] = { number: depth + 1 };
  props[W19_P.CONTEXT_UPDATED] = w19DateNow_();
}

function w20TaskContextSnapshot_(task) {
  var taskProps = task && task.page && task.page.properties || {};
  return {
    sphereIds: w19RelationIds_(taskProps[W19_P.CONTEXT_SPHERE]),
    directionIds: w19RelationIds_(taskProps[W19_P.CONTEXT_DIRECTION]),
    projectIds: w19RelationIds_(taskProps[W19_P.CONTEXT_PROJECT]),
    path: w19TextValue_(taskProps[W19_P.CONTEXT_PATH]),
    ancestorIds: w19TextValue_(taskProps[W19_P.ANCESTOR_IDS]),
    depth: w19NumberValue_(taskProps[W19_P.DEPTH], 0)
  };
}

function w19UpdateNotionPage_(pageId, properties, cfg) {
  return w19NotionRequest_('patch', '/v1/pages/' + pageId, { properties: properties }, cfg);
}

function w20TrustedHostedDownloadUrl_(value) {
  var raw = String(value || '').trim();
  if (!raw || raw.length > 6000 || raw.indexOf('#') !== -1) return '';
  var match = /^https:\/\/([^\/?#]+)(\/[^#]*)$/i.exec(raw);
  if (!match) return '';
  var host = String(match[1] || '').toLowerCase();
  var notionHost = host === 'secure.notion-static.com' || host === 'file.notion.so';
  var notionS3Host = /^prod-files-secure\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(host);
  return notionHost || notionS3Host ? raw : '';
}

function w20DriveDownloadUrl_(fileId, email) {
  var id = w20SafeDriveId_(fileId);
  var account = String(email || '').trim().toLowerCase();
  if (!id || account.length > 254 || !/^[^\s@]{1,64}@[^\s@]{1,189}$/.test(account)) return '';
  return 'https://drive.google.com/uc?export=download&authuser=' + encodeURIComponent(account) + '&id=' + encodeURIComponent(id);
}

function w20TrustedDirectDownloadUrl_(value) {
  var raw = String(value || '').trim();
  var hosted = w20TrustedHostedDownloadUrl_(raw);
  if (hosted) return hosted;
  var match = /^https:\/\/drive\.google\.com\/uc\?export=download&authuser=([^&#]{3,760})&id=([A-Za-z0-9_-]{10,200})$/.exec(raw);
  if (!match) return '';
  try {
    var account = decodeURIComponent(match[1]);
    return w20DriveDownloadUrl_(match[2], account) === raw ? raw : '';
  } catch (_decodeDriveUrlError) {
    return '';
  }
}

function w20DownloadDispositionFilename_(value) {
  var header = String(value || '').trim();
  if (!/^attachment(?:\s*;|$)/i.test(header)) return '';
  var encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return WidgetV19Core.cleanName(decodeURIComponent(String(encoded[1] || '').trim()), '');
    } catch (_decodeError) {
      return '';
    }
  }
  var quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
  if (quoted) return WidgetV19Core.cleanName(String(quoted[1] || '').replace(/\\([\\"])/g, '$1'), '');
  var plain = /(?:^|;)\s*filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? WidgetV19Core.cleanName(String(plain[1] || '').trim(), '') : '';
}

function w20DownloadGrantCacheKey_(taskId, pageId) {
  var task = WidgetV19Core.compactUuid(taskId);
  var page = WidgetV19Core.compactUuid(pageId);
  if (!task || !page) return '';
  return W20_DOWNLOAD_GRANT_CACHE_PREFIX + w19Hash_(task + '|' + page).slice(0, 48);
}

function w20DownloadGrantDirect_(value) {
  var source = value || {};
  var url = w20TrustedDirectDownloadUrl_(source.url);
  var directExpiry = Date.parse(String(source.expiresAt || ''));
  var rawSize = source.size;
  var size = rawSize === null || rawSize === undefined || rawSize === '' ? null : Number(rawSize);
  if (!url || !isFinite(directExpiry) || directExpiry <= Date.now() + 30000 ||
      (size !== null && (!isFinite(size) || size < 0))) return null;
  return {
    mode: 'direct',
    url: url,
    name: WidgetV19Core.cleanName(source.name, 'Файл'),
    mimeType: WidgetV19Core.cleanMime(source.mimeType),
    size: size,
    expiresAt: new Date(directExpiry).toISOString()
  };
}

function w20DownloadGrantPayload_(taskId, pageId, expiresAt, nonce, direct, cfg, epoch) {
  var task = WidgetV19Core.compactUuid(taskId);
  var page = WidgetV19Core.compactUuid(pageId);
  var source = w20DownloadGrantDirect_(direct);
  var expiry = Math.floor(Number(expiresAt));
  var random = String(nonce || '').toLowerCase();
  var dataSource = WidgetV19Core.compactUuid(cfg && cfg.dataSourceId);
  var grantEpoch = w20ParseDownloadGrantEpoch_(epoch);
  if (!task || !page || !source || !dataSource || grantEpoch === null || !/^[a-f0-9]{32}$/.test(random) || !isFinite(expiry)) return '';
  return ['v2', task, page, dataSource, grantEpoch, expiry, random, w19Hash_(JSON.stringify([
    source.url, source.name, source.mimeType, source.size, source.expiresAt
  ]))].join('|');
}

function w20DownloadGrantSignature_(payload, cfg) {
  if (!payload || !cfg || !cfg.notionToken) return '';
  return Utilities.computeHmacSha256Signature(String(payload), String(cfg.notionToken)).map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function w20FastDownloadName_(value) {
  var name = WidgetV19Core.cleanName(value, 'Файл')
    .replace(/[\\/\\\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (name || 'Файл').slice(0, 180);
}

function w20FastDownloadPackage_(direct, now) {
  var source = w20DownloadGrantDirect_(direct);
  var issuedAt = Math.floor(Number(now));
  if (!source || w20TrustedHostedDownloadUrl_(source.url) !== source.url || !isFinite(issuedAt) || issuedAt <= 0) return null;
  var expiresAt = issuedAt + W20_FAST_DOWNLOAD_PACKAGE_TTL_SECONDS * 1000;
  if (Date.parse(source.expiresAt) <= expiresAt + 30000) return null;
  var payload = {
    url: source.url,
    name: w20FastDownloadName_(source.name),
    expiresAt: new Date(expiresAt).toISOString()
  };
  var encoded = '';
  try {
    encoded = String(Utilities.base64EncodeWebSafe(
      Utilities.newBlob(JSON.stringify(payload), 'application/json').getBytes()
    ) || '').replace(/=+$/g, '');
  } catch (_packageEncodeError) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{40,9000}$/.test(encoded)) return null;
  return { downloadPackage: encoded, packageExpiresAt: payload.expiresAt };
}

function w20DownloadGrantResponse_(token, expiresAt, direct, now) {
  var result = {
    mode: 'grant',
    downloadGrant: String(token || ''),
    expiresAt: new Date(Number(expiresAt)).toISOString()
  };
  var fast = w20FastDownloadPackage_(direct, now);
  if (fast) {
    result.downloadPackage = fast.downloadPackage;
    result.packageExpiresAt = fast.packageExpiresAt;
  }
  return result;
}

function w20IssueDownloadGrant_(taskId, pageId, direct, cfg, expectedEpoch) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  var safeDirect = w20DownloadGrantDirect_(direct);
  var key = w20DownloadGrantCacheKey_(task, page);
  var epochKey = w20DownloadGrantEpochKey_(task, page);
  if (!task || !page || !safeDirect || !key || !cfg || !cfg.notionToken ||
      task !== cfg.authorizedTaskPageId ||
      (cfg.deniedPageIds && (cfg.deniedPageIds[task] || cfg.deniedPageIds[page]))) return { mode: 'proxy' };
  var requestedEpoch = expectedEpoch === undefined ? w20DownloadGrantEpoch_(task, page) : w20ParseDownloadGrantEpoch_(expectedEpoch);
  if (requestedEpoch === null) return { mode: 'proxy' };
  var now = Date.now();
  var expiresAt = now + W20_DOWNLOAD_GRANT_TTL_SECONDS * 1000;
  if (Date.parse(safeDirect.expiresAt) <= expiresAt + 30000) return { mode: 'proxy' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { mode: 'proxy' };
  try {
    var properties = PropertiesService.getScriptProperties();
    var currentEpoch = w20ParseDownloadGrantEpoch_(properties.getProperty(epochKey));
    if (currentEpoch === null || currentEpoch !== requestedEpoch) return { mode: 'proxy' };
    var cache = CacheService.getScriptCache();
    var existingRaw = cache.get(key);
    var existing = null;
    try { existing = existingRaw ? JSON.parse(existingRaw) : null; } catch (_existingParseError) {}
    var existingExpiry = Number(existing && existing.expiresAt || 0);
    var existingDirect = w20DownloadGrantDirect_(existing && existing.direct);
    if (existing && existing.schema === W20_DOWNLOAD_GRANT_SCHEMA && existing.epoch === currentEpoch &&
        existing.taskId === WidgetV19Core.compactUuid(task) && existing.pageId === WidgetV19Core.compactUuid(page) &&
        existing.dataSourceId === WidgetV19Core.compactUuid(cfg.dataSourceId) && existingExpiry > now + 10000 &&
        /^[a-f0-9]{96}$/.test(String(existing.token || '')) && existingDirect &&
        JSON.stringify(existingDirect) === JSON.stringify(safeDirect)) {
      var existingPayload = w20DownloadGrantPayload_(task, page, existingExpiry, existing.nonce, existingDirect, cfg, currentEpoch);
      var expectedToken = String(existing.nonce || '') + w20DownloadGrantSignature_(existingPayload, cfg);
      if (WidgetV19Core.safeEqual(expectedToken, String(existing.token))) {
        return w20DownloadGrantResponse_(existing.token, existingExpiry, existingDirect, now);
      }
    }
    var nonce = String(Utilities.getUuid()).replace(/-/g, '').toLowerCase();
    var payload = w20DownloadGrantPayload_(task, page, expiresAt, nonce, safeDirect, cfg, currentEpoch);
    var signature = w20DownloadGrantSignature_(payload, cfg);
    if (!payload || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return { mode: 'proxy' };
    var token = nonce + signature;
    var entry = {
      schema: W20_DOWNLOAD_GRANT_SCHEMA,
      taskId: WidgetV19Core.compactUuid(task),
      pageId: WidgetV19Core.compactUuid(page),
      dataSourceId: WidgetV19Core.compactUuid(cfg.dataSourceId),
      epoch: currentEpoch,
      expiresAt: expiresAt,
      nonce: nonce,
      token: token,
      direct: safeDirect
    };
    cache.put(key, JSON.stringify(entry), W20_DOWNLOAD_GRANT_TTL_SECONDS);
    return w20DownloadGrantResponse_(token, expiresAt, safeDirect, now);
  } catch (_grantError) {
    return { mode: 'proxy' };
  } finally {
    lock.releaseLock();
  }
}

function w20GetDownloadGrant_(taskId, pageId, token, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  var supplied = String(token || '').toLowerCase();
  var key = w20DownloadGrantCacheKey_(task, page);
  var epochKey = w20DownloadGrantEpochKey_(task, page);
  if (!task || !page || !key || !/^[a-f0-9]{96}$/.test(supplied) || !cfg || !cfg.notionToken ||
      task !== cfg.authorizedTaskPageId || (cfg.deniedPageIds && (cfg.deniedPageIds[task] || cfg.deniedPageIds[page]))) return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return null;
  var cache;
  var raw;
  try {
    cache = CacheService.getScriptCache();
    raw = cache.get(key);
    if (!raw) return null;
    var entry;
    try { entry = JSON.parse(raw); }
    catch (_parseError) { entry = null; }
    var currentEpoch = w20ParseDownloadGrantEpoch_(PropertiesService.getScriptProperties().getProperty(epochKey));
    var now = Date.now();
    var expiresAt = Number(entry && entry.expiresAt || 0);
    var direct = w20DownloadGrantDirect_(entry && entry.direct);
    var validStructure = Boolean(entry && entry.schema === W20_DOWNLOAD_GRANT_SCHEMA && currentEpoch !== null &&
      entry.epoch === currentEpoch && entry.taskId === WidgetV19Core.compactUuid(task) && entry.pageId === WidgetV19Core.compactUuid(page) &&
      entry.dataSourceId === WidgetV19Core.compactUuid(cfg.dataSourceId) &&
      expiresAt > now && expiresAt - now <= W20_DOWNLOAD_GRANT_TTL_SECONDS * 1000 &&
      /^[a-f0-9]{32}$/.test(String(entry.nonce || '')) && /^[a-f0-9]{96}$/.test(String(entry.token || '')) && direct);
    if (!validStructure) {
      try { if (cache && typeof cache.remove === 'function') cache.remove(key); } catch (_removeError) {}
      return null;
    }
    var payload = w20DownloadGrantPayload_(task, page, expiresAt, entry.nonce, direct, cfg, currentEpoch);
    var expected = String(entry.nonce) + w20DownloadGrantSignature_(payload, cfg);
    if (!WidgetV19Core.safeEqual(expected, String(entry.token)) || !WidgetV19Core.safeEqual(expected, supplied)) return null;
    return direct;
  } catch (_grantReadError) {
    return null;
  } finally {
    lock.releaseLock();
  }
}

function w19MaterialFromPage_(page) {
  var props = page.properties || {};
  var format = w19SelectValue_(props[W19_P.FILE_FORMAT]) || 'Other File';
  var fileId = w19TextValue_(props[W19_P.GOOGLE_FILE_ID]);
  var folderId = w19TextValue_(props[W19_P.GOOGLE_FOLDER_ID]);
  var provider = fileId ? 'Google Drive' : 'External URL';
  var name = w19TitleValue_(props[W19_P.NAME]) || 'Без названия';
  var syncStatus = w19SelectValue_(props[W19_P.SYNC_STATUS]) || 'synced';
  var sourceUrl = w19UrlValue_(props[W19_P.SOURCE]) || WidgetV19Core.makeDriveOpenUrl(fileId, format);
  var nativeGoogle = /^Google (Docs|Sheets|Slides)$/.test(format);
  var widgetOwned = Boolean(fileId && folderId);
  var widgetOwnedBinary = Boolean(provider === 'Google Drive' && widgetOwned && !nativeGoogle);
  var attachment = w19AttachmentValue_(props[W19_P.ATTACHMENTS]);
  var hasHostedAttachment = Boolean(attachment.type === 'file' && /^https:\/\//i.test(attachment.url));
  var hostedDownloadUrl = widgetOwnedBinary && hasHostedAttachment ? attachment.url : null;
  var driveDownloadUrl = provider === 'Google Drive' && fileId && !nativeGoogle ? WidgetV19Core.makeDownloadUrl(fileId) : null;
  return {
    id: WidgetV19Core.normalizeUuid(page.id),
    notionUrl: page.url || null,
    name: name,
    section: w19SelectValue_(props[W19_P.SECTION]) || 'Drive',
    format: format,
    provider: provider,
    openUrl: sourceUrl,
    downloadUrl: hostedDownloadUrl || driveDownloadUrl,
    canDownload: Boolean(hostedDownloadUrl || driveDownloadUrl),
    hostedAttachment: Boolean(hostedDownloadUrl),
    attachmentType: attachment.type || null,
    attachmentUrl: attachment.url || null,
    attachmentName: attachment.name || null,
    attachmentExpiry: attachment.expiryTime || null,
    googleFileId: fileId || null,
    folderId: folderId || null,
    widgetOwned: widgetOwned,
    widgetOwnedBinary: widgetOwnedBinary,
    mimeType: null,
    size: null,
    driveMd5: '',
    downloadName: name,
    normalizedUrl: sourceUrl || '',
    knowledgeFormat: w19SelectValue_(props[W19_P.KNOWLEDGE_FORMAT]) || 'Файл',
    integrity: syncStatus === 'error' ? 'sync_error' : 'ok',
    idempotency: w19TextValue_(props[W19_P.IDEMPOTENCY]) || '',
    position: w19NumberValue_(props[W19_P.POSITION], 0),
    syncStatus: syncStatus,
    error: syncStatus === 'error' ? 'Не удалось синхронизировать данные Google Drive.' : null,
    archived: w19CheckboxValue_(props[W19_P.ARCHIVE]),
    updatedAt: page.last_edited_time || null
  };
}

function w19Title_(value) {
  return { title: [{ type: 'text', text: { content: WidgetV19Core.cleanName(value, 'Без названия') } }] };
}

function w19Text_(value) {
  var text = String(value || '');
  return { rich_text: text ? [{ type: 'text', text: { content: text.slice(0, 2000) } }] : [] };
}

function w19Select_(value) {
  return { select: value ? { name: String(value) } : null };
}

function w19DateNow_() {
  return { date: { start: new Date().toISOString() } };
}

function w19TitleValue_(property) {
  return w19PlainRichText_(property && property.title);
}

function w19TextValue_(property) {
  return w19PlainRichText_(property && property.rich_text);
}

function w19PlainRichText_(items) {
  return (items || []).map(function (item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
}

function w19SelectValue_(property) {
  return property && property.select ? property.select.name : null;
}

function w19CheckboxValue_(property) {
  return Boolean(property && property.checkbox);
}

function w19NumberValue_(property, fallback) {
  return property && property.number !== null && property.number !== undefined ? Number(property.number) : fallback;
}

function w19UrlValue_(property) {
  return property && property.url ? String(property.url) : null;
}

function w19AttachmentValue_(property) {
  var files = property && property.files || [];
  var item = null;
  for (var i = 0; i < files.length; i += 1) {
    if (files[i] && files[i].type === 'file' && files[i].file && files[i].file.url) {
      item = files[i];
      break;
    }
  }
  if (!item && files.length) item = files[0];
  if (!item) return { type: '', name: '', url: '', expiryTime: '' };
  var type = String(item.type || (item.file ? 'file' : (item.external ? 'external' : (item.file_upload ? 'file_upload' : ''))));
  var value = type && item[type] || {};
  return {
    type: type,
    name: String(item.name || ''),
    url: String(value.url || ''),
    expiryTime: String(value.expiry_time || '')
  };
}

function w19RelationIds_(property) {
  return (property && property.relation || []).map(function (item) { return WidgetV19Core.normalizeUuid(item.id); }).filter(Boolean);
}

/* ========================= Durable idempotency ========================= */

function w19WithMutationLock_(fn) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(30000)) throw new W19Error_('BUSY', 'Другая операция ещё фиксирует изменения. Повторите через несколько секунд.', true);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function w19CanonicalIdempotency_(taskId, operation, clientKey) {
  var key = w19ValidateClientKey_(clientKey);
  return WidgetV19Core.compactUuid(taskId) + '|' + String(operation).slice(0, 100) + '|' + key;
}

function w19StableIdempotency_(taskId, operation, clientKey) {
  w19ValidateClientKey_(clientKey);
  return WidgetV19Core.compactUuid(taskId) + '|' + String(operation).slice(0, 100) + '|stable';
}

function w19ValidateClientKey_(clientKey) {
  var key = String(clientKey || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new W19Error_('IDEMPOTENCY_REQUIRED', 'Операции создания и изменения требуют новый idempotency key.', false);
  return key;
}

function w19IdempotencyLedgerKey_(canonicalKey) {
  return W19_LEDGER_PREFIX + w19Hash_(canonicalKey).slice(0, 44);
}

function w19WithIdempotency_(canonicalKey, fn) {
  var props = PropertiesService.getScriptProperties();
  var ledgerKey = w19IdempotencyLedgerKey_(canonicalKey);
  var attemptId = Utilities.getUuid();
  var recovery = false;
  var previousStatus = 'missing';
  var reservationRef = '';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new W19Error_('BUSY', 'Сервис занят другой операцией. Повторите через несколько секунд.', true);
  try {
    var existingRaw = props.getProperty(ledgerKey);
    if (existingRaw) {
      var existing;
      try { existing = JSON.parse(existingRaw); } catch (_err) { existing = null; }
      if (existing && existing.status === 'done' && existing.data) return existing.data;
      if (existing && existing.status === 'pending' && Date.now() - Number(existing.at || 0) < W19_IDEMPOTENCY_PENDING_TTL_MS) {
        throw new W19Error_('OPERATION_IN_PROGRESS', 'Эта операция уже выполняется. Обновите список через несколько секунд.', true);
      }
      recovery = true;
      previousStatus = existing && String(existing.status || '') || 'invalid';
      reservationRef = w20CreateReservationRef_(existing && existing.reservationRef);
    }
    var pending = { status: 'pending', at: Date.now(), attemptId: attemptId };
    if (reservationRef) pending.reservationRef = reservationRef;
    props.setProperty(ledgerKey, JSON.stringify(pending));
  } finally {
    lock.releaseLock();
  }

  try {
    var data = fn({ recovery: recovery, previousStatus: previousStatus, attemptId: attemptId });
    lock.waitLock(15000);
    try {
      var currentDone = w19ReadLedger_(props, ledgerKey);
      if (currentDone && currentDone.status === 'pending' && currentDone.attemptId === attemptId) {
        var done = { status: 'done', at: Date.now(), attemptId: attemptId, data: data };
        var doneReservationRef = w20CreateReservationRef_(currentDone.reservationRef);
        if (doneReservationRef) done.reservationRef = doneReservationRef;
        var serialized = JSON.stringify(done);
        if (serialized.length > 8500) {
          done.data = { completed: true };
          serialized = JSON.stringify(done);
        }
        props.setProperty(ledgerKey, serialized);
      }
    } finally { lock.releaseLock(); }
    return data;
  } catch (err) {
    lock.waitLock(15000);
    try {
      var currentFailed = w19ReadLedger_(props, ledgerKey);
      if (currentFailed && currentFailed.status === 'pending' && currentFailed.attemptId === attemptId) {
        var failed = { status: 'failed', at: Date.now(), attemptId: attemptId, code: err && err.code || 'UNEXPECTED', retryable: Boolean(err && err.retryable) };
        if (currentFailed.driveReady && currentFailed.driveReadyAt) {
          failed.driveReady = currentFailed.driveReady;
          failed.driveReadyAt = currentFailed.driveReadyAt;
        }
        var failedReservationRef = w20CreateReservationRef_(currentFailed.reservationRef);
        if (failedReservationRef) failed.reservationRef = failedReservationRef;
        props.setProperty(ledgerKey, JSON.stringify(failed));
      }
    }
    finally { lock.releaseLock(); }
    throw err;
  }
}

function w19ReadIdempotencyStatus_(canonicalKey) {
  var props = PropertiesService.getScriptProperties();
  return w19ReadLedger_(props, w19IdempotencyLedgerKey_(canonicalKey));
}

function w19ReadLedger_(props, ledgerKey) {
  var raw = props.getProperty(ledgerKey);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_err) { return null; }
}

function w19PruneLedger_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(W20_CREATE_CLAIM_PREFIX) === 0) {
      try {
        var claim = JSON.parse(all[key]);
        if (claim && (claim.schema === W20_CREATE_RESERVATION_SCHEMA || claim.schema === W20_CREATE_RESERVATION_V2_SCHEMA) && claim.status === 'done' &&
            Number(claim.at || 0) < cutoff) props.deleteProperty(key);
      } catch (_claimParseError) {}
      return;
    }
    if (key.indexOf(W19_LEDGER_PREFIX) !== 0) return;
    try {
      var entry = JSON.parse(all[key]);
      if (Number(entry.at || 0) < cutoff) props.deleteProperty(key);
    } catch (_err) { props.deleteProperty(key); }
  });
}

function w19Hash_(value) {
  return w19DigestHex_(String(value), Utilities.DigestAlgorithm.SHA_256);
}

function w19DigestHex_(value, algorithm) {
  var bytes = typeof value === 'string' ? Utilities.newBlob(value).getBytes() : value;
  return Utilities.computeDigest(algorithm, bytes).map(function (byte) {
    var n = byte < 0 ? byte + 256 : byte;
    return ('0' + n.toString(16)).slice(-2);
  }).join('');
}

/* ========================= Google Drive layer ========================= */

function w19AssertRootFolder_(cfg) {
  if (!cfg.rootFolderId) throw new W19Error_('ROOT_FOLDER_MISSING', 'Сначала запустите adminSetupRootFolder().', false);
  var file = w19GetDriveMetadata_(cfg.rootFolderId);
  if (!file || file.trashed || file.mimeType !== 'application/vnd.google-apps.folder') {
    throw new W19Error_('ROOT_FOLDER_INVALID', 'ROOT_DRIVE_FOLDER_ID не указывает на доступную папку.', false);
  }
  return file;
}

function w19EnsureTaskFolder_(task, cfg) {
  var root = w19AssertRootFolder_(cfg);
  var compactTask = WidgetV19Core.compactUuid(task.id);
  var q = "'" + w19DriveQueryEscape_(root.id) + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and " +
    "appProperties has { key='taskPageId' and value='" + w19DriveQueryEscape_(compactTask) + "' } and (" +
    "appProperties has { key='widgetVersion' and value='" + W20_DRIVE_MARKER + "' } or " +
    "appProperties has { key='widgetVersion' and value='v19' })";
  var found = w19DriveRetry_(function () {
    return Drive.Files.list({ q: q, pageSize: 2, spaces: 'drive', fields: 'files(id,name,mimeType,trashed,appProperties)' });
  });
  if (found.files && found.files.length) return found.files[0];
  return w19DriveRetry_(function () {
    return Drive.Files.create({
      name: WidgetV19Core.cleanName('Task — ' + task.name + ' — ' + compactTask.slice(0, 8), 'Task — ' + compactTask.slice(0, 8)),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [root.id],
      appProperties: { widgetVersion: W20_DRIVE_MARKER, taskPageId: compactTask }
    }, null, { fields: 'id,name,mimeType,trashed,appProperties' });
  });
}

function w19FindDriveByIdempotency_(taskId, idemHash) {
  var compactTask = WidgetV19Core.compactUuid(taskId);
  var q = "trashed = false and appProperties has { key='taskPageId' and value='" + w19DriveQueryEscape_(compactTask) + "' } and appProperties has { key='widgetIdem' and value='" + w19DriveQueryEscape_(idemHash) + "' }";
  var found = w19DriveRetry_(function () {
    return Drive.Files.list({
      q: q,
      pageSize: 2,
      spaces: 'drive',
      fields: 'files(id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,trashed,appProperties)'
    });
  });
  return found.files && found.files.length ? found.files[0] : null;
}

function w20CreateDriveFileOnce_(taskId, idemHash, createFn) {
  try { return createFn(); }
  catch (err) {
    for (var attempt = 0; attempt < 3; attempt += 1) {
      var recovered = null;
      try { recovered = w19FindDriveByIdempotency_(taskId, idemHash); }
      catch (_lookupError) { recovered = null; }
      if (recovered) return recovered;
      if (attempt < 2) Utilities.sleep(350 * Math.pow(2, attempt));
    }
    var message = String(err && err.message || err || '');
    throw new W19Error_('DRIVE_CREATE_UNCERTAIN', 'Google Drive не подтвердил создание файла. Повтор безопасно продолжит эту же операцию.', true, { reason: message.slice(0, 300) });
  }
}

function w19CreateGoogleFile_(task, folderId, section, name, idemHash) {
  var mime = WidgetV19Core.GOOGLE_MIME[section];
  if (!mime) throw new W19Error_('INVALID_CREATE_TYPE', 'Неизвестный тип Google-файла.', false);
  return w20CreateDriveFileOnce_(task.id, idemHash, function () {
    return Drive.Files.create({
      name: name,
      mimeType: mime,
      parents: [folderId],
      appProperties: {
        widgetVersion: W20_DRIVE_MARKER,
        taskPageId: WidgetV19Core.compactUuid(task.id),
        widgetIdem: idemHash,
        materialState: 'active'
      }
    }, null, { fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,trashed,appProperties' });
  });
}

function w19CreateBinaryFile_(task, folderId, name, mime, bytes, idemHash) {
  var blob = Utilities.newBlob(bytes, mime, name);
  return w20CreateDriveFileOnce_(task.id, idemHash, function () {
    return Drive.Files.create({
      name: name,
      mimeType: mime,
      parents: [folderId],
      appProperties: {
        widgetVersion: W20_DRIVE_MARKER,
        taskPageId: WidgetV19Core.compactUuid(task.id),
        widgetIdem: idemHash,
        materialState: 'active'
      }
    }, blob, { fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,trashed,appProperties' });
  });
}

function w20DriveStateForMaterial_(material) {
  if (material && material.syncStatus === 'deleted') return 'deleted';
  if (material && material.syncStatus === 'deleting') return 'deleting';
  if (material && material.archived) return 'archived';
  return 'active';
}

function w19MarkDriveNotionPage_(driveFile, taskId, idemHash, notionPageId, materialState) {
  if (!driveFile || !driveFile.id || !notionPageId) return false;
  var compactTask = WidgetV19Core.compactUuid(taskId);
  var compactPage = WidgetV19Core.compactUuid(notionPageId);
  if (!compactTask || !compactPage) return false;
  var currentProperties = driveFile.appProperties || {};
  var currentState = String(currentProperties.materialState || '').trim().toLowerCase();
  var nextState = ['active', 'archived', 'deleting', 'deleted'].indexOf(String(materialState || '').trim().toLowerCase()) === -1 ?
    'active' : String(materialState).trim().toLowerCase();
  if (currentState && currentState !== 'active' && nextState === 'active') nextState = currentState;
  try {
    w19DriveRetry_(function () {
      return Drive.Files.update({
        appProperties: {
          widgetVersion: W20_DRIVE_MARKER,
          taskPageId: compactTask,
          widgetIdem: String(idemHash || '').slice(0, 40),
          notionPageId: compactPage,
          materialState: nextState
        }
      }, driveFile.id, null, { fields: 'id,appProperties' });
    });
    return true;
  } catch (err) {
    w19Audit_('drive_marker_deferred', { code: String(err && err.code || 'DRIVE_ERROR') });
    return false;
  }
}

function w19GetDriveMetadata_(fileId) {
  try {
    return w19DriveRetry_(function () {
      return Drive.Files.get(String(fileId), {
        fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,ownedByMe,trashed,parents,appProperties'
      });
    });
  } catch (err) {
    if (w19IsDriveNotFound_(err)) return null;
    throw err;
  }
}

function w20IsDriveMaterialActive_(appProperties) {
  var state = String(appProperties && appProperties.materialState || '').trim().toLowerCase();
  return !state || state === 'active';
}

function w20SetDriveMaterialState_(material, taskId, state) {
  var normalizedState = String(state || '').trim().toLowerCase();
  if (['active', 'archived', 'deleting', 'deleted'].indexOf(normalizedState) === -1) {
    throw new W19Error_('INVALID_MATERIAL_STATE', 'Некорректное состояние файла.', false);
  }
  if (!material || !material.widgetOwned || !material.googleFileId || !material.id) return;
  var compactTask = WidgetV19Core.compactUuid(taskId);
  var compactPage = WidgetV19Core.compactUuid(material.id);
  if (!compactTask || !compactPage) return;
  var drive = w19GetDriveMetadata_(material.googleFileId);
  if (!drive) return;
  var current = drive.appProperties || {};
  var markerOk = current.widgetVersion === W20_DRIVE_MARKER || current.widgetVersion === 'v19';
  var markedPage = WidgetV19Core.compactUuid(current.notionPageId);
  if (!markerOk || current.taskPageId !== compactTask || (markedPage && markedPage !== compactPage)) return;
  var next = {};
  Object.keys(current).forEach(function (key) { next[key] = current[key]; });
  next.widgetVersion = W20_DRIVE_MARKER;
  next.taskPageId = compactTask;
  next.notionPageId = compactPage;
  next.materialState = normalizedState;
  w19DriveRetry_(function () {
    return Drive.Files.update({ appProperties: next }, drive.id, null, { fields: 'id,appProperties' });
  });
}

function w20FindOwnedBinaryMaterialByMarkers_(taskId, pageId, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  if (!task || !page || (cfg.deniedPageIds && cfg.deniedPageIds[page])) return null;
  var compactTask = WidgetV19Core.compactUuid(task);
  var compactPage = WidgetV19Core.compactUuid(page);
  var root = w19AssertRootFolder_(cfg);
  var q = "trashed = false and appProperties has { key='taskPageId' and value='" +
    w19DriveQueryEscape_(compactTask) + "' } and appProperties has { key='notionPageId' and value='" +
    w19DriveQueryEscape_(compactPage) + "' }";
  var result = w19DriveRetry_(function () {
    return Drive.Files.list({
      q: q,
      pageSize: 3,
      spaces: 'drive',
      fields: 'files(id,name,mimeType,size,trashed,parents,appProperties)'
    });
  });
  var matches = [];
  (result.files || []).forEach(function (file) {
    var driveProps = file && file.appProperties || {};
    var markerOk = driveProps.widgetVersion === W20_DRIVE_MARKER || driveProps.widgetVersion === 'v19';
    if (!file || file.trashed || !markerOk || !w20IsDriveMaterialActive_(driveProps) || driveProps.taskPageId !== compactTask ||
        WidgetV19Core.compactUuid(driveProps.notionPageId) !== compactPage ||
        /^application\/vnd\.google-apps\./.test(String(file.mimeType || ''))) return;
    (file.parents || []).forEach(function (folderId) {
      var folder = w19GetDriveMetadata_(folderId);
      var folderProps = folder && folder.appProperties || {};
      var folderMarkerOk = folderProps.widgetVersion === W20_DRIVE_MARKER || folderProps.widgetVersion === 'v19';
      if (!folder || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder' ||
          !folderMarkerOk || folderProps.taskPageId !== compactTask ||
          (folder.parents || []).indexOf(root.id) === -1) return;
      matches.push({ file: file, folderId: folder.id });
    });
  });
  if (matches.length > 1) {
    throw new W19Error_('DOWNLOAD_PROVENANCE_AMBIGUOUS', 'Для этой карточки найдено несколько файлов. Скачивание остановлено.', false);
  }
  if (!matches.length) return null;
  var match = matches[0];
  return {
    id: page,
    name: WidgetV19Core.cleanName(match.file.name, 'Файл'),
    provider: 'Google Drive',
    googleFileId: match.file.id,
    folderId: match.folderId,
    mimeType: WidgetV19Core.cleanMime(match.file.mimeType),
    size: Number(match.file.size || 0)
  };
}

function w19AssertOwnedBinary_(material, task, cfg) {
  if (material.provider !== 'Google Drive' || !material.googleFileId || !material.folderId) {
    throw new W19Error_('DOWNLOAD_NOT_OWNED', 'Скачивать через виджет можно только загруженные им файлы.', false);
  }
  var root = w19AssertRootFolder_(cfg);
  var folder = w19GetDriveMetadata_(material.folderId);
  var compactTask = WidgetV19Core.compactUuid(task.id);
  var folderProps = folder && folder.appProperties || {};
  var folderParents = folder && folder.parents || [];
  var folderMarkerOk = folderProps.widgetVersion === W20_DRIVE_MARKER || folderProps.widgetVersion === 'v19';
  if (!folder || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder' || !folderMarkerOk ||
      folderProps.taskPageId !== compactTask || folderParents.indexOf(root.id) === -1) {
    throw new W19Error_('DOWNLOAD_NOT_OWNED', 'Папка файла не принадлежит этой задаче виджета.', false);
  }

  var drive = w19GetDriveMetadata_(material.googleFileId);
  var driveProps = drive && drive.appProperties || {};
  var driveParents = drive && drive.parents || [];
  var markerOk = driveProps.widgetVersion === W20_DRIVE_MARKER || driveProps.widgetVersion === 'v19';
  var notionMarker = WidgetV19Core.compactUuid(driveProps.notionPageId);
  if (!drive || drive.trashed || !markerOk || !w20IsDriveMaterialActive_(driveProps) || driveProps.taskPageId !== compactTask ||
      driveParents.indexOf(folder.id) === -1 || (notionMarker && notionMarker !== WidgetV19Core.compactUuid(material.id))) {
    throw new W19Error_('DOWNLOAD_NOT_OWNED', 'Файл не принадлежит этой карточке и задаче виджета.', false);
  }
  if (/^application\/vnd\.google-apps\./.test(String(drive.mimeType || ''))) {
    throw new W19Error_('DOWNLOAD_NATIVE_GOOGLE_FILE', 'Google Docs, Sheets и Slides открываются как документы и не скачиваются этим способом.', false);
  }
  var size = Number(drive.size || 0);
  if (!isFinite(size) || size < 0 || size > cfg.maxUploadBytes) {
    throw new W19Error_('FILE_TOO_LARGE', 'Файл превышает безопасный лимит скачивания ' + w19HumanBytes_(cfg.maxUploadBytes) + '.', false);
  }
  return drive;
}

function w19IsDriveNotFound_(err) {
  var detail = err && err.details && err.details.reason;
  var text = String(err && err.message || err || '') + ' ' + String(detail || '');
  return Boolean(err && err.code === 'DRIVE_NOT_FOUND') || /not.?found|file not found|\b404\b/i.test(text);
}

function w19DriveRetry_(fn) {
  var last;
  for (var attempt = 0; attempt < 3; attempt += 1) {
    try { return fn(); }
    catch (err) {
      last = err;
      var driveMessage = String(err && err.message || err);
      if (/not.?found|file not found|\b404\b/i.test(driveMessage)) {
        throw new W19Error_('DRIVE_NOT_FOUND', 'Файл Google Drive не найден.', false, { reason: driveMessage.slice(0, 300) });
      }
      if (attempt < 2 && /rate|quota|backend|internal|timeout|temporar|service unavailable/i.test(driveMessage)) {
        Utilities.sleep(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
        continue;
      }
      throw new W19Error_('DRIVE_ERROR', 'Google Drive не выполнил операцию.', attempt < 2, { reason: driveMessage.slice(0, 300) });
    }
  }
  throw last;
}

function w19DriveQueryEscape_(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* ========================= Metadata synchronization ========================= */

function w19SyncPageList_(pages, cfg, limit) {
  var out = [];
  pages.forEach(function (page, index) {
    if (index >= limit) { out.push(page); return; }
    try { out.push(w19SyncOnePage_(page, cfg)); }
    catch (err) { out.push(w19MarkSyncError_(page, err, cfg)); }
  });
  return out;
}

function w19SyncOnePage_(page, cfg) {
  var snapshot = w19MaterialFromPage_(page);
  if (snapshot.provider !== 'Google Drive' || !snapshot.googleFileId || snapshot.archived || snapshot.syncStatus === 'deleting') return page;
  var drive = w19GetDriveMetadata_(snapshot.googleFileId);
  if (!drive || drive.trashed) throw new W19Error_('DRIVE_FILE_MISSING', 'Файл не найден или перемещён в корзину Google Drive.', false);
  var driveData = WidgetV19Core.describeGoogleMetadata(drive, snapshot.openUrl);
  if (!w20DriveMetadataNeedsNotionWrite_(snapshot, driveData) &&
      !w20DriveNotionMarkerNeedsRepair_(page, snapshot, drive, cfg)) return page;
  return w19WithMutationLock_(function () {
    var current = w19NotionRequest_('get', '/v1/pages/' + page.id, null, cfg);
    return w19SyncOnePageUnlocked_(current, cfg, null);
  });
}

function w20DriveNotionMarkerNeedsRepair_(page, material, drive, cfg) {
  var markers = drive && drive.appProperties || {};
  var parentId = page && page.parent && (page.parent.data_source_id ||
    (page.parent.type === 'data_source_id' && page.parent[page.parent.type]));
  var taskIds = w19RelationIds_(page && page.properties && page.properties[W19_P.INSIDE]);
  var taskId = taskIds.length === 1 ? taskIds[0] : '';
  var compactPage = WidgetV19Core.compactUuid(material && material.id);
  if (!taskId || !compactPage || !material || !page || page.in_trash ||
      WidgetV19Core.normalizeUuid(parentId) !== WidgetV19Core.normalizeUuid(cfg && cfg.dataSourceId) ||
      w19SelectValue_(page.properties && page.properties[W19_P.TYPE]) !== 'Знание' ||
      material.archived || material.syncStatus === 'deleting' ||
      material.syncStatus === 'deleted' || !drive || !drive.id || drive.trashed || !w20IsDriveMaterialActive_(markers) ||
      (markers.widgetVersion !== W20_DRIVE_MARKER && markers.widgetVersion !== 'v19') ||
      markers.taskPageId !== WidgetV19Core.compactUuid(taskId)) return false;
  return WidgetV19Core.compactUuid(markers.notionPageId) !== compactPage;
}

function w20RepairDriveNotionMarkerFromPage_(page, material, drive, cfg) {
  if (!w20DriveNotionMarkerNeedsRepair_(page, material, drive, cfg)) return false;
  var markers = drive && drive.appProperties || {};
  var taskIds = w19RelationIds_(page && page.properties && page.properties[W19_P.INSIDE]);
  var taskId = taskIds.length === 1 ? taskIds[0] : '';
  return w19MarkDriveNotionPage_(drive, taskId, String(markers.widgetIdem || '').slice(0, 40), material.id, w20DriveStateForMaterial_(material)) === true;
}

function w20DriveMetadataNeedsNotionWrite_(material, driveData) {
  return Boolean(
    (driveData.name && driveData.name !== material.name) ||
    (driveData.sourceUrl && driveData.sourceUrl !== material.openUrl) ||
    driveData.format !== material.format ||
    driveData.section !== material.section ||
    material.knowledgeFormat !== 'Файл' ||
    material.syncStatus !== 'synced'
  );
}

function w19SyncOnePageUnlocked_(page, cfg, knownDrive) {
  var material = w19MaterialFromPage_(page);
  if (material.provider !== 'Google Drive' || !material.googleFileId || material.archived) return page;
  if (material.syncStatus === 'deleting') return page;
  var drive = knownDrive && knownDrive.id === material.googleFileId ? knownDrive : w19GetDriveMetadata_(material.googleFileId);
  if (!drive || drive.trashed) throw new W19Error_('DRIVE_FILE_MISSING', 'Файл не найден или перемещён в корзину Google Drive.', false);
  w20RepairDriveNotionMarkerFromPage_(page, material, drive, cfg);
  var driveData = WidgetV19Core.describeGoogleMetadata(drive, material.openUrl);
  var props = {};
  var nameChanged = Boolean(driveData.name && driveData.name !== material.name);
  var urlChanged = Boolean(driveData.sourceUrl && driveData.sourceUrl !== material.openUrl);
  if (nameChanged) props[W19_P.NAME] = w19Title_(driveData.name);
  if (urlChanged) props[W19_P.SOURCE] = { url: driveData.sourceUrl };
  if ((nameChanged || urlChanged) && driveData.sourceUrl && !material.widgetOwnedBinary && !material.hostedAttachment) {
    props[W19_P.ATTACHMENTS] = { files: [{ name: driveData.name, type: 'external', external: { url: driveData.sourceUrl } }] };
  }
  if (driveData.format !== material.format) props[W19_P.FILE_FORMAT] = w19Select_(driveData.format);
  if (driveData.section !== material.section) {
    props[W19_P.SECTION] = w19Select_(driveData.section);
    var taskIds = w19RelationIds_(page.properties && page.properties[W19_P.INSIDE]);
    if (taskIds.length) props[W19_P.POSITION] = { number: w19NextPosition_(taskIds[0], driveData.section, cfg) };
  }
  if (material.knowledgeFormat !== 'Файл') props[W19_P.KNOWLEDGE_FORMAT] = w19Select_('Файл');
  if (material.syncStatus !== 'synced') props[W19_P.SYNC_STATUS] = w19Select_('synced');
  if (!Object.keys(props).length) return page;
  return w19UpdateNotionPage_(page.id, props, cfg);
}

function w19MarkSyncError_(page, err, cfg) {
  try {
    return w19WithMutationLock_(function () {
      var current = w19NotionRequest_('get', '/v1/pages/' + page.id, null, cfg);
      var material = w19MaterialFromPage_(current);
      if (material.archived || material.syncStatus === 'deleting' || material.syncStatus === 'deleted') return current;
      if (material.syncStatus === 'error') return current;
      var props = {};
      props[W19_P.SYNC_STATUS] = w19Select_('error');
      return w19UpdateNotionPage_(current.id, props, cfg);
    });
  } catch (_updateErr) { return page; }
}
