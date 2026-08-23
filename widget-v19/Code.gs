/* global Drive, HtmlService, Session, PropertiesService, CacheService, LockService,
          ScriptApp, UrlFetchApp, Utilities, WidgetV19Core */

var W19_VERSION = 'v19-test';
var W19_NOTION_DEFAULT_VERSION = '2026-03-11';
var W19_LEDGER_PREFIX = 'w19:idem:';
var W19_SYNC_CURSOR = 'w19:sync:cursor';

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
  PROVIDER: '[SYS] Провайдер',
  GOOGLE_FILE_ID: '[SYS] Google File ID',
  GOOGLE_FOLDER_ID: '[SYS] Google Folder ID',
  POSITION: '[SYS] Позиция',
  SYNC_STATUS: '[SYS] Sync status',
  LAST_SYNC: '[SYS] Последняя синхронизация',
  IDEMPOTENCY: '[SYS] Idempotency key',
  MIME: '[SYS] MIME type',
  SIZE: '[SYS] Размер байт',
  DRIVE_MD5: '[SYS] Drive MD5',
  SHA256: '[SYS] SHA-256',
  DOWNLOAD_NAME: '[SYS] Download name',
  NORMALIZED_URL: '[SYS] Normalized URL',
  SYNC_ERROR: '[SYS] Ошибка sync',
  INTEGRITY: '[SYS] Integrity',
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
  '[SYS] Провайдер': 'select',
  '[SYS] Google File ID': 'rich_text',
  '[SYS] Google Folder ID': 'rich_text',
  '[SYS] Позиция': 'number',
  '[SYS] Sync status': 'select',
  '[SYS] Последняя синхронизация': 'date',
  '[SYS] Idempotency key': 'rich_text',
  '[SYS] MIME type': 'rich_text',
  '[SYS] Размер байт': 'number',
  '[SYS] Drive MD5': 'rich_text',
  '[SYS] SHA-256': 'rich_text',
  '[SYS] Download name': 'rich_text',
  '[SYS] Normalized URL': 'rich_text',
  '[SYS] Ошибка sync': 'rich_text',
  '[SYS] Integrity': 'select'
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

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Файлы задачи — v19 TEST')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ========================= Public client API ========================= */

function apiBootstrap(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_();
    w19AssertSchema_(cfg);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var folder = w19EnsureTaskFolder_(task, cfg);
    var pages = w19QueryTaskMaterials_(task.id, cfg);
    pages = w19SyncPageList_(pages, cfg, 30);
    return {
      version: W19_VERSION,
      task: { id: task.id, name: task.name },
      folderUrl: 'https://drive.google.com/drive/folders/' + encodeURIComponent(folder.id),
      maxUploadBytes: cfg.maxUploadBytes,
      materials: pages.map(w19MaterialFromPage_)
    };
  });
}

function apiCreateGoogle(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_();
    w19AssertSchema_(cfg);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var section = WidgetV19Core.assertSection(input && input.section);
    if (section === 'Drive') throw new W19Error_('INVALID_CREATE_TYPE', 'Карточка Drive открывает папку; для нового файла выберите Docs, Sheets или Slides.', false);
    var name = WidgetV19Core.cleanName(input && input.name, w19DefaultGoogleName_(section));
    var idem = w19CanonicalIdempotency_(task.id, 'create-google-' + section, input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg);
      if (existing) return { material: w19MaterialFromPage_(existing), duplicate: true };

      var folder = w19EnsureTaskFolder_(task, cfg);
      var idemHash = w19Hash_(idem).slice(0, 40);
      var driveFile = w19FindDriveByIdempotency_(task.id, idemHash);
      if (!driveFile) driveFile = w19CreateGoogleFile_(task, folder.id, section, name, idemHash);

      var byFile = w19FindMaterialByGoogleFile_(task.id, driveFile.id, cfg);
      if (byFile) return { material: w19MaterialFromPage_(byFile), duplicate: true };

      var format = section === 'Docs' ? 'Google Docs' : (section === 'Sheets' ? 'Google Sheets' : 'Google Slides');
      var page = w19CreateNotionMaterial_(task, {
        name: driveFile.name || name,
        sourceUrl: driveFile.webViewLink || WidgetV19Core.makeDriveOpenUrl(driveFile.id, format),
        normalizedUrl: '',
        knowledgeFormat: 'Файл',
        format: format,
        section: section,
        provider: 'Google Drive',
        googleFileId: driveFile.id,
        googleFolderId: folder.id,
        mimeType: driveFile.mimeType || WidgetV19Core.GOOGLE_MIME[section],
        size: driveFile.size ? Number(driveFile.size) : null,
        driveMd5: driveFile.md5Checksum || '',
        sha256: '',
        downloadName: driveFile.name || name,
        position: w19NextPosition_(task.id, section, cfg),
        idempotency: idem
      }, cfg);
      return { material: w19MaterialFromPage_(page), duplicate: false };
    });
  });
}

function apiAddLink(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_();
    w19AssertSchema_(cfg);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var normalized = WidgetV19Core.normalizeExternalUrl(input && input.url);
    if (!normalized) throw new W19Error_('INVALID_URL', 'Нужна корректная HTTPS-ссылка.', false);
    var detected = WidgetV19Core.classify({ url: normalized, isLink: true });
    var section = input && input.section ? WidgetV19Core.assertSection(input.section) : detected.section;
    var name = WidgetV19Core.cleanName(input && input.name, w19HostLabel_(normalized));
    var idem = w19CanonicalIdempotency_(task.id, 'add-link', input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg) || w19FindMaterialByNormalizedUrl_(task.id, normalized, cfg);
      if (existing) return { material: w19MaterialFromPage_(existing), duplicate: true };
      var page = w19CreateNotionMaterial_(task, {
        name: name,
        sourceUrl: normalized,
        normalizedUrl: normalized,
        knowledgeFormat: 'Ссылка',
        format: detected.format,
        section: section,
        provider: detected.provider,
        googleFileId: WidgetV19Core.extractGoogleFileId(normalized) || '',
        googleFolderId: '',
        mimeType: '',
        size: null,
        driveMd5: '',
        sha256: '',
        downloadName: name,
        position: w19NextPosition_(task.id, section, cfg),
        idempotency: idem
      }, cfg);
      return { material: w19MaterialFromPage_(page), duplicate: false };
    });
  });
}

function apiUpload(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_();
    w19AssertSchema_(cfg);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var name = WidgetV19Core.cleanName(input && input.name, 'Файл');
    var mime = WidgetV19Core.cleanMime(input && input.mimeType);
    var base64 = String(input && input.dataBase64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new W19Error_('INVALID_UPLOAD', 'Файл не удалось прочитать.', false);
    var estimated = Math.floor(base64.length * 3 / 4);
    if (estimated > cfg.maxUploadBytes + 3) throw new W19Error_('FILE_TOO_LARGE', 'Размер файла превышает лимит ' + w19HumanBytes_(cfg.maxUploadBytes) + '.', false);
    var bytes = Utilities.base64Decode(base64);
    if (bytes.length > cfg.maxUploadBytes) throw new W19Error_('FILE_TOO_LARGE', 'Размер файла превышает лимит ' + w19HumanBytes_(cfg.maxUploadBytes) + '.', false);
    var detected = WidgetV19Core.classify({ name: name, mimeType: mime });
    var section = input && input.section ? WidgetV19Core.assertSection(input.section) : detected.section;
    var idem = w19CanonicalIdempotency_(task.id, 'upload', input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg);
      if (existing) return { material: w19MaterialFromPage_(existing), duplicate: true };

      var folder = w19EnsureTaskFolder_(task, cfg);
      var idemHash = w19Hash_(idem).slice(0, 40);
      var driveFile = w19FindDriveByIdempotency_(task.id, idemHash);
      var sha256 = w19DigestHex_(bytes, Utilities.DigestAlgorithm.SHA_256);
      if (!driveFile) driveFile = w19CreateBinaryFile_(task, folder.id, name, mime, bytes, idemHash);

      var byFile = w19FindMaterialByGoogleFile_(task.id, driveFile.id, cfg);
      if (byFile) return { material: w19MaterialFromPage_(byFile), duplicate: true };
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
        sha256: sha256,
        downloadName: driveFile.name || name,
        position: w19NextPosition_(task.id, section, cfg),
        idempotency: idem
      }, cfg);
      return { material: w19MaterialFromPage_(page), duplicate: false };
    });
  });
}

function apiUpdateMaterial(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_();
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var material = w19AssertMaterialForTask_(input && input.pageId, task.id, cfg);
    var idem = w19CanonicalIdempotency_(task.id, 'update-material-' + material.id, input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      material = w19AssertMaterialForTask_(material.id, task.id, cfg);
      var props = {};
      var current = w19MaterialFromPage_(material);
      if (input && input.section) {
        var nextSection = WidgetV19Core.assertSection(input.section);
        props[W19_P.SECTION] = w19Select_(nextSection);
        if (nextSection !== current.section) props[W19_P.POSITION] = { number: w19NextPosition_(task.id, nextSection, cfg) };
      }
      if (input && Object.prototype.hasOwnProperty.call(input, 'name')) {
        var nextName = WidgetV19Core.cleanName(input.name, current.name);
        if (current.provider === 'Google Drive' && current.googleFileId && input.renameDrive !== false) {
          w19DriveRetry_(function () { Drive.Files.update({ name: nextName }, current.googleFileId, null, { fields: 'id,name' }); });
        }
        props[W19_P.NAME] = w19Title_(nextName);
        props[W19_P.DOWNLOAD_NAME] = w19Text_(nextName);
      }
      if (input && Object.prototype.hasOwnProperty.call(input, 'url')) {
        if (current.provider !== 'External URL') throw new W19Error_('URL_REPLACE_FORBIDDEN', 'Ссылку Google Drive нельзя заменить как внешнюю URL.', false);
        var url = WidgetV19Core.normalizeExternalUrl(input.url);
        if (!url) throw new W19Error_('INVALID_URL', 'Нужна корректная HTTPS-ссылка.', false);
        props[W19_P.SOURCE] = { url: url };
        props[W19_P.NORMALIZED_URL] = w19Text_(url);
      }
      props[W19_P.SYNC_STATUS] = w19Select_('synced');
      props[W19_P.SYNC_ERROR] = w19Text_('');
      props[W19_P.LAST_SYNC] = w19DateNow_();
      var updated = w19UpdateNotionPage_(material.id, props, cfg);
      return { material: w19MaterialFromPage_(updated) };
    });
  });
}

function apiReorder(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_();
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var items = input && input.items;
    if (!Array.isArray(items) || !items.length || items.length > 500) throw new W19Error_('INVALID_ORDER', 'Некорректный список сортировки.', false);
    var seen = {};
    var normalized = items.map(function (item) {
      var id = WidgetV19Core.normalizeUuid(item && item.pageId);
      if (!id || seen[id]) throw new W19Error_('INVALID_ORDER', 'В сортировке есть неверный или повторяющийся ID.', false);
      seen[id] = true;
      w19AssertMaterialForTask_(id, task.id, cfg);
      var position = Number(item.position);
      if (!isFinite(position) || position < 0) throw new W19Error_('INVALID_ORDER', 'Позиция должна быть неотрицательным числом.', false);
      return { pageId: id, position: Math.round(position), section: WidgetV19Core.assertSection(item.section) };
    });
    var idem = w19CanonicalIdempotency_(task.id, 'reorder', input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      normalized.forEach(function (item) {
        var props = {};
        props[W19_P.POSITION] = { number: item.position };
        props[W19_P.SECTION] = w19Select_(item.section);
        props[W19_P.LAST_SYNC] = w19DateNow_();
        w19UpdateNotionPage_(item.pageId, props, cfg);
      });
      return { count: normalized.length };
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
    var cfg = w19AuthorizedConfig_();
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var page = w19AssertMaterialForTask_(input && input.pageId, task.id, cfg);
    var material = w19MaterialFromPage_(page);
    if (material.provider !== 'Google Drive' || !material.googleFileId) throw new W19Error_('NO_PHYSICAL_FILE', 'У этой карточки нет физического файла Google Drive.', false);
    if (String(input && input.confirmName || '') !== material.name) throw new W19Error_('CONFIRMATION_REQUIRED', 'Для удаления нужно точно ввести название файла.', false);
    var driveFile = w19GetDriveMetadata_(material.googleFileId);
    var driveProps = driveFile && driveFile.appProperties || {};
    if (!driveFile || driveProps.widgetVersion !== 'v19' || driveProps.taskPageId !== WidgetV19Core.compactUuid(task.id)) {
      throw new W19Error_('DELETE_NOT_OWNED_BY_WIDGET', 'Физически удалять можно только файлы, созданные этим виджетом v19 для текущей задачи.', false);
    }
    var idem = w19CanonicalIdempotency_(task.id, 'delete-file-' + material.id, input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      try { w19DriveRetry_(function () { Drive.Files.delete(material.googleFileId); }); }
      catch (err) {
        if (!/not.?found|File not found/i.test(String(err && err.message || err))) throw err;
      }
      var props = {};
      props[W19_P.ARCHIVE] = { checkbox: true };
      props[W19_P.SYNC_STATUS] = w19Select_('deleted');
      props[W19_P.SYNC_ERROR] = w19Text_('');
      props[W19_P.LAST_SYNC] = w19DateNow_();
      var updated = w19UpdateNotionPage_(page.id, props, cfg);
      return { material: w19MaterialFromPage_(updated), deleted: true };
    });
  });
}

function apiSyncTask(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_();
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var pages = w19QueryTaskMaterials_(task.id, cfg);
    pages = w19SyncPageList_(pages, cfg, 100);
    return { materials: pages.map(w19MaterialFromPage_), syncedAt: new Date().toISOString() };
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
      name: 'Notion Widget v19 — TEST',
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { widgetVersion: 'v19-root' }
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
    if (trigger.getHandlerFunction() === 'scheduledSync') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('scheduledSync').timeBased().everyMinutes(1).create();
  return { ok: true, handler: 'scheduledSync', cadence: 'approximately every minute' };
}

function scheduledSync() {
  var cfg = w19Config_();
  w19AssertSchema_(cfg);
  var props = PropertiesService.getScriptProperties();
  var cursor = props.getProperty(W19_SYNC_CURSOR) || null;
  var body = {
    page_size: 50,
    filter: {
      and: [
        { property: W19_P.TYPE, select: { equals: 'Знание' } },
        { property: W19_P.PROVIDER, select: { equals: 'Google Drive' } },
        { property: W19_P.ARCHIVE, checkbox: { equals: false } }
      ]
    },
    sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }]
  };
  if (cursor) body.start_cursor = cursor;
  var result = w19NotionRequest_('post', '/v1/data_sources/' + cfg.dataSourceId + '/query', body, cfg);
  var ok = 0;
  var errors = 0;
  (result.results || []).forEach(function (page) {
    try { w19SyncOnePage_(page, cfg); ok += 1; }
    catch (err) { errors += 1; w19MarkSyncError_(page, err, cfg); }
  });
  if (result.has_more && result.next_cursor) props.setProperty(W19_SYNC_CURSOR, result.next_cursor);
  else props.deleteProperty(W19_SYNC_CURSOR);
  w19PruneLedger_();
  w19Audit_('scheduled_sync', { checked: (result.results || []).length, ok: ok, errors: errors });
  return { ok: true, checked: (result.results || []).length, synced: ok, errors: errors };
}

/* ========================= Authorization/config ========================= */

function w19AuthorizedConfig_() {
  var cfg = w19Config_();
  w19AssertViewer_(cfg);
  return cfg;
}

function w19AdminConfig_() {
  var cfg = w19Config_();
  var email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!email || email !== cfg.allowedEmail) throw new W19Error_('FORBIDDEN', 'Запуск разрешён только владельцу из ALLOWED_EMAIL.', false);
  return cfg;
}

function w19Config_() {
  var props = PropertiesService.getScriptProperties();
  var allowedEmail = String(props.getProperty('ALLOWED_EMAIL') || '').trim().toLowerCase();
  var notionToken = String(props.getProperty('NOTION_TOKEN') || '').trim();
  var dataSourceId = WidgetV19Core.normalizeUuid(props.getProperty('NOTION_DATA_SOURCE_ID'));
  if (!allowedEmail) throw new W19Error_('CONFIG_MISSING', 'Не задан ALLOWED_EMAIL.', false);
  if (!notionToken) throw new W19Error_('CONFIG_MISSING', 'Не задан NOTION_TOKEN в Script Properties.', false);
  if (!dataSourceId) throw new W19Error_('CONFIG_MISSING', 'Не задан корректный NOTION_DATA_SOURCE_ID.', false);
  var maxUpload = Number(props.getProperty('MAX_UPLOAD_BYTES') || 8388608);
  if (!isFinite(maxUpload) || maxUpload < 1048576 || maxUpload > 26214400) throw new W19Error_('CONFIG_INVALID', 'MAX_UPLOAD_BYTES должен быть от 1 до 25 MiB.', false);
  var cfg = {
    allowedEmail: allowedEmail,
    notionToken: notionToken,
    dataSourceId: dataSourceId,
    rootFolderId: String(props.getProperty('ROOT_DRIVE_FOLDER_ID') || '').trim(),
    notionVersion: String(props.getProperty('NOTION_VERSION') || W19_NOTION_DEFAULT_VERSION).trim(),
    maxUploadBytes: Math.floor(maxUpload),
    deniedPageIds: w19IdSet_(props.getProperty('DENIED_NOTION_PAGE_IDS')),
    deniedDataSourceIds: w19IdSet_(props.getProperty('DENIED_NOTION_DATA_SOURCE_IDS'))
  };
  w19AssertAllowedDataSource_(cfg.dataSourceId, cfg);
  return cfg;
}

function w19AssertViewer_(cfg) {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) throw new W19Error_('AUTH_REQUIRED', 'Google не передал подтверждённую учётную запись. Откройте staging URL в обычной вкладке и авторизуйтесь.', true);
  if (email !== cfg.allowedEmail) throw new W19Error_('FORBIDDEN', 'Эта тестовая версия доступна только владельцу.', false);
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
    var cfg = w19AuthorizedConfig_();
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var page = w19AssertMaterialForTask_(input && input.pageId, task.id, cfg, true);
    var idem = w19CanonicalIdempotency_(task.id, (archived ? 'archive-' : 'restore-') + page.id, input && input.idempotencyKey);
    return w19WithIdempotency_(idem, function () {
      var props = {};
      props[W19_P.ARCHIVE] = { checkbox: archived };
      props[W19_P.SYNC_STATUS] = w19Select_(archived ? 'archived' : 'synced');
      props[W19_P.SYNC_ERROR] = w19Text_('');
      props[W19_P.LAST_SYNC] = w19DateNow_();
      var updated = w19UpdateNotionPage_(page.id, props, cfg);
      return { material: w19MaterialFromPage_(updated), archived: archived };
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

function w19DefaultGoogleName_(section) {
  var label = section === 'Docs' ? 'Документ' : (section === 'Sheets' ? 'Таблица' : 'Презентация');
  return label + ' — ' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd HH:mm');
}

/* ========================= Notion layer ========================= */

function w19AssertSchema_(cfg, force) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'w19:schema:' + cfg.dataSourceId + ':' + cfg.notionVersion;
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
  if (missing.length) throw new W19Error_('SCHEMA_MISMATCH', 'Схема «Элементы» не готова для v19: ' + missing.slice(0, 4).join('; ') + (missing.length > 4 ? '…' : ''), false, result);
  cache.put(cacheKey, JSON.stringify(result), 300);
  return result;
}

function w19NotionRequest_(method, path, body, cfg) {
  var url = 'https://api.notion.com' + path;
  var lastError;
  for (var attempt = 0; attempt < 4; attempt += 1) {
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
    try { response = UrlFetchApp.fetch(url, options); }
    catch (networkErr) {
      lastError = networkErr;
      if (attempt < 3) { Utilities.sleep(400 * Math.pow(2, attempt) + Math.floor(Math.random() * 200)); continue; }
      throw new W19Error_('NOTION_UNAVAILABLE', 'Notion API временно недоступен.', true);
    }
    var status = response.getResponseCode();
    var text = response.getContentText() || '{}';
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (_parseErr) { parsed = { message: 'Invalid JSON response' }; }
    if (status >= 200 && status < 300) return parsed;
    lastError = parsed;
    if ((status === 429 || status >= 500) && attempt < 3) {
      var retryHeader = Number(response.getHeaders()['Retry-After'] || 0);
      Utilities.sleep(Math.max(retryHeader * 1000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250));
      continue;
    }
    if (status === 401 || status === 403) throw new W19Error_('NOTION_FORBIDDEN', 'Notion connection не имеет нужного доступа.', false);
    if (status === 404) throw new W19Error_('NOTION_NOT_FOUND', 'Объект Notion не найден или не открыт connection.', false);
    if (status === 409) throw new W19Error_('NOTION_CONFLICT', 'Notion сообщил о конфликте. Повторите операцию.', true);
    throw new W19Error_('NOTION_ERROR', 'Notion отклонил операцию (' + status + ').', status >= 500, { code: parsed.code || null });
  }
  throw new W19Error_('NOTION_UNAVAILABLE', 'Notion API временно недоступен.', true, { reason: String(lastError || '') });
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

function w19FindMaterialByNormalizedUrl_(taskId, url, cfg) {
  if (!url) return null;
  return w19FindOneMaterial_(taskId, { property: W19_P.NORMALIZED_URL, rich_text: { equals: url } }, cfg);
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
  var pages = w19QueryTaskMaterials_(taskId, cfg);
  var max = -1;
  pages.forEach(function (page) {
    if (w19SelectValue_(page.properties && page.properties[W19_P.SECTION]) === section) {
      max = Math.max(max, w19NumberValue_(page.properties && page.properties[W19_P.POSITION], -1));
    }
  });
  return max + 1;
}

function w19CreateNotionMaterial_(task, data, cfg) {
  var props = {};
  props[W19_P.NAME] = w19Title_(data.name);
  props[W19_P.TYPE] = w19Select_('Знание');
  props[W19_P.INSIDE] = { relation: [{ id: task.id }] };
  props[W19_P.SOURCE] = { url: data.sourceUrl || null };
  props[W19_P.ATTACHMENTS] = data.sourceUrl ? {
    files: [{ name: WidgetV19Core.cleanName(data.downloadName || data.name, 'Файл'), type: 'external', external: { url: data.sourceUrl } }]
  } : { files: [] };
  props[W19_P.KNOWLEDGE_FORMAT] = w19Select_(data.knowledgeFormat || 'Файл');
  props[W19_P.ARCHIVE] = { checkbox: false };
  props[W19_P.FILE_FORMAT] = w19Select_(data.format || 'Other File');
  props[W19_P.SECTION] = w19Select_(WidgetV19Core.assertSection(data.section));
  props[W19_P.PROVIDER] = w19Select_(data.provider || 'Google Drive');
  props[W19_P.GOOGLE_FILE_ID] = w19Text_(data.googleFileId || '');
  props[W19_P.GOOGLE_FOLDER_ID] = w19Text_(data.googleFolderId || '');
  props[W19_P.POSITION] = { number: Number(data.position || 0) };
  props[W19_P.SYNC_STATUS] = w19Select_('synced');
  props[W19_P.LAST_SYNC] = w19DateNow_();
  props[W19_P.IDEMPOTENCY] = w19Text_(data.idempotency || '');
  props[W19_P.MIME] = w19Text_(data.mimeType || '');
  props[W19_P.SIZE] = { number: data.size === null || data.size === undefined ? null : Number(data.size) };
  props[W19_P.DRIVE_MD5] = w19Text_(data.driveMd5 || '');
  props[W19_P.SHA256] = w19Text_(data.sha256 || '');
  props[W19_P.DOWNLOAD_NAME] = w19Text_(data.downloadName || data.name || '');
  props[W19_P.NORMALIZED_URL] = w19Text_(data.normalizedUrl || '');
  props[W19_P.SYNC_ERROR] = w19Text_('');
  props[W19_P.INTEGRITY] = w19Select_('ok');
  w19AppendContextProperties_(props, task, data.name);
  return w19NotionRequest_('post', '/v1/pages', {
    parent: { type: 'data_source_id', data_source_id: cfg.dataSourceId },
    properties: props
  }, cfg);
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

function w19UpdateNotionPage_(pageId, properties, cfg) {
  return w19NotionRequest_('patch', '/v1/pages/' + pageId, { properties: properties }, cfg);
}

function w19MaterialFromPage_(page) {
  var props = page.properties || {};
  var format = w19SelectValue_(props[W19_P.FILE_FORMAT]) || 'Other File';
  var provider = w19SelectValue_(props[W19_P.PROVIDER]) || 'External URL';
  var fileId = w19TextValue_(props[W19_P.GOOGLE_FILE_ID]);
  var sourceUrl = w19UrlValue_(props[W19_P.SOURCE]) || WidgetV19Core.makeDriveOpenUrl(fileId, format);
  var nativeGoogle = /^Google (Docs|Sheets|Slides)$/.test(format);
  return {
    id: WidgetV19Core.normalizeUuid(page.id),
    notionUrl: page.url || null,
    name: w19TitleValue_(props[W19_P.NAME]) || 'Без названия',
    section: w19SelectValue_(props[W19_P.SECTION]) || 'Drive',
    format: format,
    provider: provider,
    openUrl: sourceUrl,
    downloadUrl: provider === 'Google Drive' && fileId && !nativeGoogle ? WidgetV19Core.makeDownloadUrl(fileId) : null,
    canDownload: Boolean(provider === 'Google Drive' && fileId && !nativeGoogle),
    googleFileId: fileId || null,
    folderId: w19TextValue_(props[W19_P.GOOGLE_FOLDER_ID]) || null,
    widgetOwned: Boolean(fileId && w19TextValue_(props[W19_P.GOOGLE_FOLDER_ID])),
    mimeType: w19TextValue_(props[W19_P.MIME]) || null,
    size: w19NumberValue_(props[W19_P.SIZE], null),
    position: w19NumberValue_(props[W19_P.POSITION], 0),
    syncStatus: w19SelectValue_(props[W19_P.SYNC_STATUS]) || 'synced',
    error: w19TextValue_(props[W19_P.SYNC_ERROR]) || null,
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

function w19RelationIds_(property) {
  return (property && property.relation || []).map(function (item) { return WidgetV19Core.normalizeUuid(item.id); }).filter(Boolean);
}

/* ========================= Durable idempotency ========================= */

function w19CanonicalIdempotency_(taskId, operation, clientKey) {
  var key = String(clientKey || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new W19Error_('IDEMPOTENCY_REQUIRED', 'Операции создания и изменения требуют новый idempotency key.', false);
  return WidgetV19Core.compactUuid(taskId) + '|' + String(operation).slice(0, 100) + '|' + key;
}

function w19WithIdempotency_(canonicalKey, fn) {
  var props = PropertiesService.getScriptProperties();
  var ledgerKey = W19_LEDGER_PREFIX + w19Hash_(canonicalKey).slice(0, 44);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new W19Error_('BUSY', 'Сервис занят другой операцией. Повторите через несколько секунд.', true);
  try {
    var existingRaw = props.getProperty(ledgerKey);
    if (existingRaw) {
      var existing;
      try { existing = JSON.parse(existingRaw); } catch (_err) { existing = null; }
      if (existing && existing.status === 'done' && existing.data) return existing.data;
      if (existing && existing.status === 'pending' && Date.now() - Number(existing.at || 0) < 120000) {
        throw new W19Error_('OPERATION_IN_PROGRESS', 'Эта операция уже выполняется. Обновите список через несколько секунд.', true);
      }
    }
    props.setProperty(ledgerKey, JSON.stringify({ status: 'pending', at: Date.now() }));
  } finally {
    lock.releaseLock();
  }

  try {
    var data = fn();
    lock.waitLock(15000);
    try {
      var serialized = JSON.stringify({ status: 'done', at: Date.now(), data: data });
      if (serialized.length > 8500) serialized = JSON.stringify({ status: 'done', at: Date.now(), data: { completed: true } });
      props.setProperty(ledgerKey, serialized);
    } finally { lock.releaseLock(); }
    return data;
  } catch (err) {
    lock.waitLock(15000);
    try { props.setProperty(ledgerKey, JSON.stringify({ status: 'failed', at: Date.now(), code: err && err.code || 'UNEXPECTED' })); }
    finally { lock.releaseLock(); }
    throw err;
  }
}

function w19PruneLedger_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  Object.keys(all).forEach(function (key) {
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
  var q = "'" + w19DriveQueryEscape_(root.id) + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='taskPageId' and value='" + w19DriveQueryEscape_(compactTask) + "' }";
  var found = w19DriveRetry_(function () {
    return Drive.Files.list({ q: q, pageSize: 2, spaces: 'drive', fields: 'files(id,name,mimeType,trashed,appProperties)' });
  });
  if (found.files && found.files.length) return found.files[0];
  return w19DriveRetry_(function () {
    return Drive.Files.create({
      name: WidgetV19Core.cleanName('Task — ' + task.name + ' — ' + compactTask.slice(0, 8), 'Task — ' + compactTask.slice(0, 8)),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [root.id],
      appProperties: { widgetVersion: 'v19', taskPageId: compactTask }
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

function w19CreateGoogleFile_(task, folderId, section, name, idemHash) {
  var mime = WidgetV19Core.GOOGLE_MIME[section];
  if (!mime) throw new W19Error_('INVALID_CREATE_TYPE', 'Неизвестный тип Google-файла.', false);
  return w19DriveRetry_(function () {
    return Drive.Files.create({
      name: name,
      mimeType: mime,
      parents: [folderId],
      appProperties: {
        widgetVersion: 'v19',
        taskPageId: WidgetV19Core.compactUuid(task.id),
        widgetIdem: idemHash
      }
    }, null, { fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,trashed,appProperties' });
  });
}

function w19CreateBinaryFile_(task, folderId, name, mime, bytes, idemHash) {
  var blob = Utilities.newBlob(bytes, mime, name);
  return w19DriveRetry_(function () {
    return Drive.Files.create({
      name: name,
      mimeType: mime,
      parents: [folderId],
      appProperties: {
        widgetVersion: 'v19',
        taskPageId: WidgetV19Core.compactUuid(task.id),
        widgetIdem: idemHash
      }
    }, blob, { fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,trashed,appProperties' });
  });
}

function w19GetDriveMetadata_(fileId) {
  try {
    return w19DriveRetry_(function () {
      return Drive.Files.get(String(fileId), {
        fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,trashed,parents,appProperties'
      });
    });
  } catch (err) {
    if (/not.?found|File not found/i.test(String(err && err.message || err))) return null;
    throw err;
  }
}

function w19DriveRetry_(fn) {
  var last;
  for (var attempt = 0; attempt < 3; attempt += 1) {
    try { return fn(); }
    catch (err) {
      last = err;
      if (attempt < 2 && /rate|quota|backend|internal|timeout|temporar|service unavailable/i.test(String(err && err.message || err))) {
        Utilities.sleep(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
        continue;
      }
      throw new W19Error_('DRIVE_ERROR', 'Google Drive не выполнил операцию.', attempt < 2, { reason: String(err && err.message || err).slice(0, 300) });
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
  var material = w19MaterialFromPage_(page);
  if (material.provider !== 'Google Drive' || !material.googleFileId || material.archived) return page;
  var drive = w19GetDriveMetadata_(material.googleFileId);
  if (!drive || drive.trashed) throw new W19Error_('DRIVE_FILE_MISSING', 'Файл не найден или перемещён в корзину Google Drive.', false);
  var detected = WidgetV19Core.classify({ name: drive.name, mimeType: drive.mimeType, url: drive.webViewLink || material.openUrl });
  var props = {};
  if (drive.name && drive.name !== material.name) props[W19_P.NAME] = w19Title_(drive.name);
  var openUrl = drive.webViewLink || WidgetV19Core.makeDriveOpenUrl(drive.id, detected.format);
  if (openUrl && openUrl !== material.openUrl) {
    props[W19_P.SOURCE] = { url: openUrl };
    props[W19_P.ATTACHMENTS] = { files: [{ name: WidgetV19Core.cleanName(drive.name, 'Файл'), type: 'external', external: { url: openUrl } }] };
  }
  props[W19_P.FILE_FORMAT] = w19Select_(detected.format);
  props[W19_P.MIME] = w19Text_(drive.mimeType || '');
  props[W19_P.SIZE] = { number: drive.size ? Number(drive.size) : null };
  props[W19_P.DRIVE_MD5] = w19Text_(drive.md5Checksum || '');
  props[W19_P.DOWNLOAD_NAME] = w19Text_(drive.name || material.name);
  props[W19_P.SYNC_STATUS] = w19Select_('synced');
  props[W19_P.SYNC_ERROR] = w19Text_('');
  props[W19_P.LAST_SYNC] = w19DateNow_();
  props[W19_P.INTEGRITY] = w19Select_('ok');
  return w19UpdateNotionPage_(page.id, props, cfg);
}

function w19MarkSyncError_(page, err, cfg) {
  var props = {};
  props[W19_P.SYNC_STATUS] = w19Select_('error');
  props[W19_P.SYNC_ERROR] = w19Text_(String(err && err.message || 'Ошибка синхронизации').slice(0, 500));
  props[W19_P.LAST_SYNC] = w19DateNow_();
  props[W19_P.INTEGRITY] = w19Select_('sync_error');
  try { return w19UpdateNotionPage_(page.id, props, cfg); }
  catch (_updateErr) { return page; }
}
