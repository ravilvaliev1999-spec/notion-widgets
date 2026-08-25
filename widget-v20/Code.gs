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
var W20_DRIVE_POLL_CLAIM_TTL_SECONDS = 60;
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
  '[SYS] Integrity': 'select',
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
  return HtmlService.createHtmlOutputFromFile(isDownloadCourier ? 'Download' : 'Index')
    .setTitle(isDownloadCourier ? 'Скачивание файла' : 'Файлы задачи')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ========================= Public client API ========================= */

function apiBootstrap(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    try {
      w19AssertSchema_(cfg);
      var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
      var maxUploadBytes = w19EffectiveUploadLimit_(cfg);
      var folder = w19WithMutationLock_(function () {
        return w19EnsureTaskFolder_(task, cfg);
      });
      var pages = w19QueryTaskMaterials_(task.id, cfg);
      pages = w19SyncPageList_(pages, cfg, 30);
      w20CacheDownloadMaterials_(task.id, pages, cfg);
      var materials = pages.map(function (page) {
        return w20MaterialForClient_(w19MaterialFromPage_(page), task.id, cfg);
      });
      w20RegistryReplaceTask_(task.id, materials);
      return {
        version: W19_VERSION,
        task: { id: task.id, name: task.name },
        folderUrl: 'https://drive.google.com/drive/folders/' + encodeURIComponent(folder.id),
        serviceUrl: ScriptApp.getService().getUrl(),
        maxUploadBytes: maxUploadBytes,
        materials: materials
      };
    } catch (err) {
      if (err && (err.code === 'GOOGLE_URLFETCH_QUOTA' || err.code === 'NOTION_UNAVAILABLE' || err.code === 'NOTION_RATE_LIMIT_BUSY')) {
        return w20BootstrapFromRegistry_(input, cfg, err);
      }
      throw err;
    }
  });
}

function apiCreateGoogle(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    w19AssertSchema_(cfg);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var section = WidgetV19Core.assertSection(input && input.section);
    if (section === 'Drive') throw new W19Error_('INVALID_CREATE_TYPE', 'Карточка Drive открывает папку; для нового файла выберите Docs, Sheets или Slides.', false);
    var name = WidgetV19Core.cleanName(input && input.name, w19DefaultGoogleName_(section));
    var idem = w19CanonicalIdempotency_(task.id, 'create-google-' + section, input && input.idempotencyKey);
    var outcome = w19WithIdempotency_(idem, function () {
      return w19WithMutationLock_(function () {
        var idemHash = w19Hash_(idem).slice(0, 40);
        var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg);
        if (existing) {
          var existingMaterial = w19MaterialFromPage_(existing);
          if (existingMaterial.googleFileId && existingMaterial.widgetOwned) {
            var existingDrive = w19GetDriveMetadata_(existingMaterial.googleFileId);
            if (existingDrive) w19MarkDriveNotionPage_(existingDrive, task.id, idemHash, existing.id, w20DriveStateForMaterial_(existingMaterial));
          }
          return { material: existingMaterial, duplicate: true };
        }

        var folder = w19EnsureTaskFolder_(task, cfg);
        var driveFile = w19FindDriveByIdempotency_(task.id, idemHash);
        if (!driveFile) driveFile = w19CreateGoogleFile_(task, folder.id, section, name, idemHash);

        var byFile = w19FindMaterialByGoogleFile_(task.id, driveFile.id, cfg);
        if (byFile) {
          var byFileMaterial = w19MaterialFromPage_(byFile);
          w19MarkDriveNotionPage_(driveFile, task.id, idemHash, byFile.id, w20DriveStateForMaterial_(byFileMaterial));
          return { material: byFileMaterial, duplicate: true };
        }

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
        w19MarkDriveNotionPage_(driveFile, task.id, idemHash, page.id, 'active');
        return { material: w19MaterialFromPage_(page), duplicate: false };
      });
    });
    if (outcome && outcome.material) {
      outcome.material = w20MaterialForClient_(outcome.material, task.id, cfg);
      w20RegistryUpsert_(task.id, outcome.material);
    }
    return outcome;
  });
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
          w19FindMaterialByNormalizedUrl_(task.id, linkData.normalizedUrl, cfg);
        if (existing) {
          var existingMaterial = w19MaterialFromPage_(existing);
          if (existingMaterial.syncStatus === 'deleted') {
            throw new W19Error_('MATERIAL_DELETED', 'Эта ссылка относится к физически удалённому материалу и не может быть восстановлена.', false);
          }
          if (existingMaterial.archived) {
            var restoreProps = {};
            restoreProps[W19_P.ARCHIVE] = { checkbox: false };
            restoreProps[W19_P.SYNC_STATUS] = w19Select_('synced');
            restoreProps[W19_P.SYNC_ERROR] = w19Text_('');
            restoreProps[W19_P.LAST_SYNC] = w19DateNow_();
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
          sha256: '',
          downloadName: linkData.name,
          position: w19NextPosition_(task.id, linkData.section, cfg),
          idempotency: idem
        }, cfg);
        return { material: w19MaterialFromPage_(page), duplicate: false };
      });
    });
    if (outcome && outcome.material) {
      outcome.material = w20MaterialForClient_(outcome.material, task.id, cfg);
      w20RegistryUpsert_(task.id, outcome.material);
    }
    return outcome;
  });
}

function apiUpload(input) {
  return w19ApiResult_(function () {
    var cfg = w19AuthorizedConfig_(input);
    w19AssertSchema_(cfg);
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var maxUploadBytes = w19EffectiveUploadLimit_(cfg);
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
    var idem = w19CanonicalIdempotency_(task.id, 'upload', input && input.idempotencyKey);
    var outcome = w19WithIdempotency_(idem, function () {
      return w19WithMutationLock_(function () {
        var idemHash = w19Hash_(idem).slice(0, 40);
        var existing = w19FindMaterialByIdempotency_(task.id, idem, cfg);
        if (existing) {
          var existingMaterial = w19MaterialFromPage_(existing);
          if (existingMaterial.googleFileId && existingMaterial.widgetOwned) {
            var existingDrive = w19GetDriveMetadata_(existingMaterial.googleFileId);
            if (existingDrive) w19MarkDriveNotionPage_(existingDrive, task.id, idemHash, existing.id, w20DriveStateForMaterial_(existingMaterial));
          }
          return { material: existingMaterial, duplicate: true };
        }

        var folder = w19EnsureTaskFolder_(task, cfg);
        var driveFile = w19FindDriveByIdempotency_(task.id, idemHash);
        var sha256 = w19DigestHex_(bytes, Utilities.DigestAlgorithm.SHA_256);
        if (!driveFile) driveFile = w19CreateBinaryFile_(task, folder.id, name, mime, bytes, idemHash);

        var byFile = w19FindMaterialByGoogleFile_(task.id, driveFile.id, cfg);
        if (byFile) {
          var byFileMaterial = w19MaterialFromPage_(byFile);
          w19MarkDriveNotionPage_(driveFile, task.id, idemHash, byFile.id, w20DriveStateForMaterial_(byFileMaterial));
          return { material: byFileMaterial, duplicate: true };
        }
        var openUrl = driveFile.webViewLink || WidgetV19Core.makeDriveOpenUrl(driveFile.id, detected.format);
        var notionUpload = w19CreateAndSendNotionUpload_(bytes, driveFile.mimeType || mime, driveFile.name || name, cfg);
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
          attachments: [{
            name: WidgetV19Core.cleanName(driveFile.name || name, 'Файл'),
            type: 'file_upload',
            file_upload: { id: notionUpload.id }
          }],
          position: w19NextPosition_(task.id, section, cfg),
          idempotency: idem
        }, cfg);
        w19MarkDriveNotionPage_(driveFile, task.id, idemHash, page.id, 'active');
        return { material: w19MaterialFromPage_(page), duplicate: false };
      });
    });
    if (outcome && outcome.material && outcome.material.id) {
      var freshPage = w19AssertMaterialForTask_(outcome.material.id, task.id, cfg, true);
      outcome.material = w20MaterialForClient_(w19MaterialFromPage_(freshPage), task.id, cfg);
      w20CacheDownloadMaterials_(task.id, [freshPage], cfg);
      w20RegistryUpsert_(task.id, outcome.material);
    }
    return outcome;
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
          props[W19_P.DOWNLOAD_NAME] = w19Text_(nextName);
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
          props[W19_P.NORMALIZED_URL] = w19Text_(url);
          props[W19_P.KNOWLEDGE_FORMAT] = w19Select_(detected.knowledgeFormat);
          props[W19_P.FILE_FORMAT] = w19Select_(detected.format);
          props[W19_P.PROVIDER] = w19Select_(detected.provider);
          props[W19_P.GOOGLE_FILE_ID] = w19Text_(googleFileId);
          props[W19_P.GOOGLE_FOLDER_ID] = w19Text_('');
          props[W19_P.MIME] = w19Text_('');
          props[W19_P.SIZE] = { number: null };
          props[W19_P.DRIVE_MD5] = w19Text_('');
          props[W19_P.SHA256] = w19Text_('');
          props[W19_P.DOWNLOAD_NAME] = w19Text_(displayName);
          props[W19_P.INTEGRITY] = w19Select_('ok');
          if (!(input && input.section)) {
            props[W19_P.SECTION] = w19Select_(detected.section);
            if (detected.section !== current.section) props[W19_P.POSITION] = { number: w19NextPosition_(task.id, detected.section, cfg) };
          }
        }
        props[W19_P.SYNC_STATUS] = w19Select_('synced');
        props[W19_P.SYNC_ERROR] = w19Text_('');
        props[W19_P.LAST_SYNC] = w19DateNow_();
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
          props[W19_P.LAST_SYNC] = w19DateNow_();
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
        w20SetDriveMaterialState_(material, task.id, 'deleted');
        w20RegistryRemove_(task.id, materialId);
        return { material: material, deleted: true, duplicate: true };
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
      w20SetDriveMaterialState_(material, task.id, 'deleting');
      if (!prepared) {
        var preparing = {};
        preparing[W19_P.SYNC_STATUS] = w19Select_('deleting');
        preparing[W19_P.SYNC_ERROR] = w19Text_('');
        preparing[W19_P.LAST_SYNC] = w19DateNow_();
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
      props[W19_P.SYNC_ERROR] = w19Text_('');
      props[W19_P.LAST_SYNC] = w19DateNow_();
      var updated = w19UpdateNotionPage_(page.id, props, cfg);
      w20RegistryRemove_(task.id, materialId);
      return { material: w19MaterialFromPage_(updated), deleted: true };
      });
    });
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
        if ((data.mimeType || '') !== (baseline.mimeType || '')) props[W19_P.MIME] = w19Text_(data.mimeType || '');
        if (data.size !== baseline.size) props[W19_P.SIZE] = { number: data.size };
        if (data.driveMd5 !== baseline.driveMd5) props[W19_P.DRIVE_MD5] = w19Text_(data.driveMd5);
        if (data.name !== baseline.downloadName) props[W19_P.DOWNLOAD_NAME] = w19Text_(data.name);
        if (data.normalizedUrl !== baseline.normalizedUrl) props[W19_P.NORMALIZED_URL] = w19Text_(data.normalizedUrl);
        props[W19_P.SYNC_STATUS] = w19Select_('synced');
        props[W19_P.SYNC_ERROR] = w19Text_('');
        props[W19_P.INTEGRITY] = w19Select_('ok');
        props[W19_P.LAST_SYNC] = w19DateNow_();
        var updatedPage = w19WithMutationLock_(function () {
          return w19UpdateNotionPage_(pageId, props, cfg);
        });
        var updatedMaterial = w20MaterialForClient_(w19MaterialFromPage_(updatedPage), taskId, cfg);
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
    var task = w19AssertTaskPage_(input && input.taskPageId, cfg);
    var pages = w19QueryTaskMaterials_(task.id, cfg);
    pages = w19SyncPageList_(pages, cfg, 100);
    w20CacheDownloadMaterials_(task.id, pages, cfg);
    var materials = pages.map(function (page) {
      return w20MaterialForClient_(w19MaterialFromPage_(page), task.id, cfg);
    });
    w20RegistryReplaceTask_(task.id, materials);
    return {
      materials: materials,
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
    if (trigger.getHandlerFunction() === 'scheduledSync') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('scheduledSync').timeBased().everyMinutes(5).create();
  return { ok: true, handler: 'scheduledSync', cadence: 'approximately every five minutes' };
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
    var body = {
      page_size: 50,
      filter: {
        and: [
          { property: W19_P.TYPE, select: { equals: 'Знание' } },
          { property: W19_P.PROVIDER, select: { equals: 'Google Drive' } },
          { property: W19_P.INSIDE, relation: { contains: cfg.authorizedTaskPageId } },
          { property: W19_P.ARCHIVE, checkbox: { equals: false } }
        ]
      },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }]
    };
    if (lease.cursor) body.start_cursor = lease.cursor;
    var result = w19NotionRequest_('post', '/v1/data_sources/' + cfg.dataSourceId + '/query', body, cfg);
    var ok = 0;
    var errors = 0;
    (result.results || []).forEach(function (page) {
      try {
        var syncedPage = w19SyncOnePage_(page, cfg);
        w20RegistryUpsert_(cfg.authorizedTaskPageId, w19MaterialFromPage_(syncedPage));
        ok += 1;
      }
      catch (err) { errors += 1; w19MarkSyncError_(page, err, cfg); }
    });
    nextCursor = result.has_more && result.next_cursor ? result.next_cursor : null;
    commitCursor = true;
    w19PruneLedger_();
    w19Audit_('scheduled_sync', { checked: (result.results || []).length, ok: ok, errors: errors });
    return { ok: true, checked: (result.results || []).length, synced: ok, errors: errors };
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

function w19AssertScheduledInvocation_(cfg, event) {
  var activeEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (activeEmail && activeEmail === cfg.allowedEmail) return;
  var triggerUid = String(event && event.triggerUid || '');
  var validTrigger = Boolean(triggerUid && ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'scheduledSync' && String(trigger.getUniqueId()) === triggerUid;
  }));
  if (!validTrigger) throw new W19Error_('FORBIDDEN', 'Синхронизацию может запускать только системный триггер или владелец.', false);
}

/* ========================= Authorization/config ========================= */

function w19AuthorizedConfig_(input) {
  var cfg = w19Config_();
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
  var allowedEmail = String(props.getProperty('ALLOWED_EMAIL') || '').trim().toLowerCase();
  var notionToken = String(props.getProperty('NOTION_TOKEN') || '').trim();
  var dataSourceId = WidgetV19Core.normalizeUuid(props.getProperty('NOTION_DATA_SOURCE_ID'));
  var authorizedTaskPageId = WidgetV19Core.normalizeUuid(props.getProperty('AUTHORIZED_TASK_PAGE_ID'));
  var accessTokenHash = String(props.getProperty('WIDGET_ACCESS_TOKEN_SHA256') || '').trim().toLowerCase();
  if (!allowedEmail) throw new W19Error_('CONFIG_MISSING', 'Не задан ALLOWED_EMAIL.', false);
  if (!notionToken) throw new W19Error_('CONFIG_MISSING', 'Не задан NOTION_TOKEN в Script Properties.', false);
  if (!dataSourceId) throw new W19Error_('CONFIG_MISSING', 'Не задан корректный NOTION_DATA_SOURCE_ID.', false);
  if (!authorizedTaskPageId || !accessTokenHash) {
    throw new W19Error_('CONFIG_MISSING', 'Для iframe нужны AUTHORIZED_TASK_PAGE_ID и WIDGET_ACCESS_TOKEN_SHA256.', false);
  }
  if (accessTokenHash && !/^[a-f0-9]{64}$/.test(accessTokenHash)) {
    throw new W19Error_('CONFIG_INVALID', 'WIDGET_ACCESS_TOKEN_SHA256 должен быть SHA-256 в нижнем регистре.', false);
  }
  var maxUpload = Number(props.getProperty('MAX_UPLOAD_BYTES') || 8388608);
  if (!isFinite(maxUpload) || maxUpload < 1048576 || maxUpload > W19_NOTION_SINGLE_PART_MAX_BYTES) throw new W19Error_('CONFIG_INVALID', 'MAX_UPLOAD_BYTES должен быть от 1 до 20 MiB.', false);
  var cfg = {
    allowedEmail: allowedEmail,
    notionToken: notionToken,
    dataSourceId: dataSourceId,
    authorizedTaskPageId: authorizedTaskPageId,
    accessTokenHash: accessTokenHash,
    rootFolderId: String(props.getProperty('ROOT_DRIVE_FOLDER_ID') || '').trim(),
    notionVersion: String(props.getProperty('NOTION_VERSION') || W19_NOTION_DEFAULT_VERSION).trim(),
    maxUploadBytes: Math.floor(maxUpload),
    deniedPageIds: w19IdSet_(props.getProperty('DENIED_NOTION_PAGE_IDS')),
    deniedDataSourceIds: w19IdSet_(props.getProperty('DENIED_NOTION_DATA_SOURCE_IDS'))
  };
  w19AssertAllowedDataSource_(cfg.dataSourceId, cfg);
  return cfg;
}

function w19AssertViewer_(cfg, input) {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (email && email === cfg.allowedEmail) return 'owner';

  var token = String(input && input.accessToken || '').trim();
  var taskId = WidgetV19Core.normalizeUuid(input && input.taskPageId);
  var tokenShapeOk = /^[A-Za-z0-9._~-]{32,256}$/.test(token);
  var tokenHash = tokenShapeOk ? w19Hash_(token) : '';
  var taskMatches = Boolean(taskId && cfg.authorizedTaskPageId && taskId === cfg.authorizedTaskPageId);
  var tokenMatches = Boolean(cfg.accessTokenHash && WidgetV19Core.safeEqual(tokenHash, cfg.accessTokenHash));
  if (taskMatches && tokenMatches) return 'capability';

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

function w20MaterialForClient_(material, taskId, cfg) {
  var out = {};
  Object.keys(material || {}).forEach(function (key) { out[key] = material[key]; });
  var eligible = out.provider === 'Google Drive' && w20SafeDriveId_(out.googleFileId) &&
    /^Google (?:Docs|Sheets|Slides)$/.test(String(out.format || '')) && !out.archived &&
    out.syncStatus !== 'deleting' && out.syncStatus !== 'deleted';
  if (eligible) out.drivePollClaim = w20IssueDrivePollClaim_(taskId, out.id, out.googleFileId, out, cfg);
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
          w20SetDriveMaterialState_(material, task.id, 'deleted');
          w20RegistryRemove_(task.id, materialId);
          return { material: material, archived: true, deleted: true, duplicate: true };
        }
        if (material.archived === archived) {
          w20SetDriveMaterialState_(material, task.id, archived ? 'archived' : 'active');
          if (archived) w20RegistryRemove_(task.id, materialId);
          else {
            material = w20MaterialForClient_(material, task.id, cfg);
            w20RegistryUpsert_(task.id, material);
          }
          return { material: material, archived: archived, duplicate: true };
        }
        var props = {};
        props[W19_P.ARCHIVE] = { checkbox: archived };
        props[W19_P.SYNC_STATUS] = w19Select_(archived ? 'archived' : 'synced');
        props[W19_P.SYNC_ERROR] = w19Text_('');
        props[W19_P.LAST_SYNC] = w19DateNow_();
        if (!archived) props[W19_P.POSITION] = { number: w19NextPosition_(task.id, material.section, cfg) };
        if (archived) w20SetDriveMaterialState_(material, task.id, 'archived');
        var updated = w19UpdateNotionPage_(page.id, props, cfg);
        var updatedMaterial = w20MaterialForClient_(w19MaterialFromPage_(updated), task.id, cfg);
        if (!archived) w20SetDriveMaterialState_(updatedMaterial, task.id, 'active');
        if (archived) w20RegistryRemove_(task.id, materialId);
        else w20RegistryUpsert_(task.id, updatedMaterial);
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
  try {
    var cache = CacheService.getScriptCache();
    var now = Date.now();
    var previousAt = Number(cache.get(W19_NOTION_RATE_CACHE_KEY));
    if (!isFinite(previousAt) || previousAt <= 0 || previousAt > now + W19_NOTION_RATE_INTERVAL_MS) previousAt = 0;
    var earliestAt = previousAt + W19_NOTION_RATE_INTERVAL_MS;
    while (previousAt && now < earliestAt) {
      Utilities.sleep(earliestAt - now);
      now = Date.now();
    }
    cache.put(W19_NOTION_RATE_CACHE_KEY, String(now), 120);
  } finally {
    lock.releaseLock();
  }
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
    w19ReserveNotionRequestSlot_();
    try { response = UrlFetchApp.fetch(url, options); }
    catch (networkErr) {
      lastError = networkErr;
      var networkMessage = String(networkErr && networkErr.message || networkErr || '');
      if (/service invoked too many times.*urlfetch|urlfetch.*too many times/i.test(networkMessage)) {
        throw new W19Error_('GOOGLE_URLFETCH_QUOTA', 'Google временно исчерпал дневной лимит соединения с Notion. Виджет автоматически продолжит работу после обновления лимита.', true);
      }
      if (attempt < 3) { Utilities.sleep(400 * Math.pow(2, attempt) + Math.floor(Math.random() * 200)); continue; }
      throw new W19Error_('NOTION_UNAVAILABLE', 'Notion API временно недоступен.', true, { reason: networkMessage.slice(0, 300) });
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
      var retryDelay = Math.max(retryHeader * 1000, 500 * Math.pow(2, attempt));
      Utilities.sleep(Math.min(retryDelay, W19_NOTION_MAX_RETRY_DELAY_MS) + Math.floor(Math.random() * 250));
      continue;
    }
    if (status === 401 || status === 403) throw new W19Error_('NOTION_FORBIDDEN', 'Notion connection не имеет нужного доступа.', false);
    if (status === 404) throw new W19Error_('NOTION_NOT_FOUND', 'Объект Notion не найден или не открыт connection.', false);
    if (status === 409) throw new W19Error_('NOTION_CONFLICT', 'Notion сообщил о конфликте. Повторите операцию.', true);
    throw new W19Error_('NOTION_ERROR', 'Notion отклонил операцию (' + status + ').', status >= 500, { code: parsed.code || null });
  }
  throw new W19Error_('NOTION_UNAVAILABLE', 'Notion API временно недоступен.', true, { reason: String(lastError || '') });
}

function w19CreateAndSendNotionUpload_(bytes, mimeType, filename, cfg) {
  var name = WidgetV19Core.cleanName(filename, 'Файл');
  var mime = WidgetV19Core.cleanMime(mimeType);
  var upload = w19NotionRequest_('post', '/v1/file_uploads', {
    mode: 'single_part',
    filename: name,
    content_type: mime
  }, cfg);
  var uploadId = WidgetV19Core.normalizeUuid(upload && upload.id);
  if (!uploadId || upload.object !== 'file_upload' || upload.status !== 'pending') {
    throw new W19Error_('NOTION_UPLOAD_INVALID', 'Notion не подготовил загрузку файла.', true);
  }

  var canonicalUrl = 'https://api.notion.com/v1/file_uploads/' + encodeURIComponent(uploadId) + '/send';
  var uploadUrl = String(upload.upload_url || canonicalUrl).trim();
  if (uploadUrl !== canonicalUrl && uploadUrl.indexOf(canonicalUrl + '?') !== 0) {
    throw new W19Error_('NOTION_UPLOAD_INVALID', 'Notion вернул небезопасный адрес загрузки.', false);
  }

  var blob = Utilities.newBlob(bytes, mime, name);
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
      if (w19NotionUploadIsComplete_(uploadId, cfg)) return { id: uploadId, name: name, mimeType: mime };
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
      var sentId = WidgetV19Core.normalizeUuid(parsed && parsed.id);
      if (parsed.object === 'file_upload' && parsed.status === 'uploaded' && sentId === uploadId) {
        return { id: uploadId, name: name, mimeType: mime };
      }
      throw new W19Error_('NOTION_UPLOAD_INCOMPLETE', 'Notion не завершил загрузку файла.', true);
    }
    if (status !== 401 && status !== 403 && w19NotionUploadIsComplete_(uploadId, cfg)) {
      return { id: uploadId, name: name, mimeType: mime };
    }
    if ((status === 429 || status >= 500) && attempt < 2) {
      var retryHeader = Number(response.getHeaders()['Retry-After'] || 0);
      var retryDelay = Math.max(retryHeader * 1000, 500 * Math.pow(2, attempt));
      Utilities.sleep(Math.min(retryDelay, W19_NOTION_MAX_RETRY_DELAY_MS) + Math.floor(Math.random() * 250));
      continue;
    }
    if (status === 401 || status === 403) throw new W19Error_('NOTION_FORBIDDEN', 'Notion connection не имеет права загружать файлы.', false);
    throw new W19Error_('NOTION_UPLOAD_FAILED', 'Notion отклонил загрузку файла (' + status + ').', status >= 500, { code: parsed.code || null });
  }
  throw new W19Error_('NOTION_UPLOAD_UNAVAILABLE', 'Notion временно не принял файл.', true);
}

function w19NotionUploadIsComplete_(uploadId, cfg) {
  try {
    var upload = w19NotionRequest_('get', '/v1/file_uploads/' + encodeURIComponent(uploadId), null, cfg);
    return Boolean(upload && upload.object === 'file_upload' && upload.status === 'uploaded' &&
      WidgetV19Core.normalizeUuid(upload.id) === WidgetV19Core.normalizeUuid(uploadId));
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
  var now = Date.now();
  (Array.isArray(pages) ? pages : []).forEach(function (page) {
    var entry = w20DownloadCacheEntryFromPage_(taskId, page, cfg, now);
    var key = w20DownloadMaterialCacheKey_(taskId, page && page.id);
    if (!key) return;
    if (entry) entries[key] = JSON.stringify(entry);
    else removals.push(key);
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
    return keys.length;
  } catch (_cacheErr) {
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

function w20InvalidateDownloadMaterialCache_(taskId, pageId) {
  var key = w20DownloadMaterialCacheKey_(taskId, pageId);
  if (!key) return;
  try {
    var cache = CacheService.getScriptCache();
    if (typeof cache.remove === 'function') cache.remove(key);
  } catch (_cacheErr) {}
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

function w19FindMaterialCollision_(taskId, currentPageId, fileId, url, cfg) {
  var alternatives = [];
  if (fileId) alternatives.push({ property: W19_P.GOOGLE_FILE_ID, rich_text: { equals: fileId } });
  if (url) alternatives.push({ property: W19_P.NORMALIZED_URL, rich_text: { equals: url } });
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
  props[W19_P.ATTACHMENTS] = Array.isArray(data.attachments) ? { files: data.attachments } : (data.sourceUrl ? {
    files: [{ name: WidgetV19Core.cleanName(data.downloadName || data.name, 'Файл'), type: 'external', external: { url: data.sourceUrl } }]
  } : { files: [] });
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
  var folderId = w19TextValue_(props[W19_P.GOOGLE_FOLDER_ID]);
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
    name: w19TitleValue_(props[W19_P.NAME]) || 'Без названия',
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
    mimeType: w19TextValue_(props[W19_P.MIME]) || null,
    size: w19NumberValue_(props[W19_P.SIZE], null),
    driveMd5: w19TextValue_(props[W19_P.DRIVE_MD5]) || '',
    downloadName: w19TextValue_(props[W19_P.DOWNLOAD_NAME]) || '',
    normalizedUrl: w19TextValue_(props[W19_P.NORMALIZED_URL]) || '',
    knowledgeFormat: w19SelectValue_(props[W19_P.KNOWLEDGE_FORMAT]) || 'Файл',
    integrity: w19SelectValue_(props[W19_P.INTEGRITY]) || '',
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

function w19WithIdempotency_(canonicalKey, fn) {
  var props = PropertiesService.getScriptProperties();
  var ledgerKey = W19_LEDGER_PREFIX + w19Hash_(canonicalKey).slice(0, 44);
  var attemptId = Utilities.getUuid();
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
    props.setProperty(ledgerKey, JSON.stringify({ status: 'pending', at: Date.now(), attemptId: attemptId }));
  } finally {
    lock.releaseLock();
  }

  try {
    var data = fn();
    lock.waitLock(15000);
    try {
      var currentDone = w19ReadLedger_(props, ledgerKey);
      if (currentDone && currentDone.status === 'pending' && currentDone.attemptId === attemptId) {
        var serialized = JSON.stringify({ status: 'done', at: Date.now(), attemptId: attemptId, data: data });
        if (serialized.length > 8500) serialized = JSON.stringify({ status: 'done', at: Date.now(), attemptId: attemptId, data: { completed: true } });
        props.setProperty(ledgerKey, serialized);
      }
    } finally { lock.releaseLock(); }
    return data;
  } catch (err) {
    lock.waitLock(15000);
    try {
      var currentFailed = w19ReadLedger_(props, ledgerKey);
      if (currentFailed && currentFailed.status === 'pending' && currentFailed.attemptId === attemptId) {
        props.setProperty(ledgerKey, JSON.stringify({ status: 'failed', at: Date.now(), attemptId: attemptId, code: err && err.code || 'UNEXPECTED' }));
      }
    }
    finally { lock.releaseLock(); }
    throw err;
  }
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

function w19CreateGoogleFile_(task, folderId, section, name, idemHash) {
  var mime = WidgetV19Core.GOOGLE_MIME[section];
  if (!mime) throw new W19Error_('INVALID_CREATE_TYPE', 'Неизвестный тип Google-файла.', false);
  return w19DriveRetry_(function () {
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
  return w19DriveRetry_(function () {
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
  if (!driveFile || !driveFile.id || !notionPageId) return;
  var compactTask = WidgetV19Core.compactUuid(taskId);
  var compactPage = WidgetV19Core.compactUuid(notionPageId);
  if (!compactTask || !compactPage) return;
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
  } catch (err) {
    w19Audit_('drive_marker_deferred', { code: String(err && err.code || 'DRIVE_ERROR') });
  }
}

function w19GetDriveMetadata_(fileId) {
  try {
    return w19DriveRetry_(function () {
      return Drive.Files.get(String(fileId), {
        fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,trashed,parents,appProperties'
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
  if (!w20DriveMetadataNeedsNotionWrite_(snapshot, driveData)) return page;
  return w19WithMutationLock_(function () {
    var current = w19NotionRequest_('get', '/v1/pages/' + page.id, null, cfg);
    return w19SyncOnePageUnlocked_(current, cfg, drive);
  });
}

function w20DriveMetadataNeedsNotionWrite_(material, driveData) {
  return Boolean(
    (driveData.name && driveData.name !== material.name) ||
    (driveData.sourceUrl && driveData.sourceUrl !== material.openUrl) ||
    driveData.format !== material.format ||
    driveData.section !== material.section ||
    material.provider !== 'Google Drive' ||
    material.knowledgeFormat !== 'Файл' ||
    (driveData.mimeType || '') !== (material.mimeType || '') ||
    driveData.size !== material.size ||
    driveData.driveMd5 !== material.driveMd5 ||
    driveData.name !== material.downloadName ||
    driveData.normalizedUrl !== material.normalizedUrl ||
    material.syncStatus !== 'synced' ||
    material.error ||
    material.integrity !== 'ok'
  );
}

function w19SyncOnePageUnlocked_(page, cfg, knownDrive) {
  var material = w19MaterialFromPage_(page);
  if (material.provider !== 'Google Drive' || !material.googleFileId || material.archived) return page;
  if (material.syncStatus === 'deleting') return page;
  var drive = knownDrive && knownDrive.id === material.googleFileId ? knownDrive : w19GetDriveMetadata_(material.googleFileId);
  if (!drive || drive.trashed) throw new W19Error_('DRIVE_FILE_MISSING', 'Файл не найден или перемещён в корзину Google Drive.', false);
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
  if (material.provider !== 'Google Drive') props[W19_P.PROVIDER] = w19Select_('Google Drive');
  if (material.knowledgeFormat !== 'Файл') props[W19_P.KNOWLEDGE_FORMAT] = w19Select_('Файл');
  if ((driveData.mimeType || '') !== (material.mimeType || '')) props[W19_P.MIME] = w19Text_(driveData.mimeType || '');
  if (driveData.size !== material.size) props[W19_P.SIZE] = { number: driveData.size };
  if (driveData.driveMd5 !== material.driveMd5) props[W19_P.DRIVE_MD5] = w19Text_(driveData.driveMd5);
  if (driveData.name !== material.downloadName) props[W19_P.DOWNLOAD_NAME] = w19Text_(driveData.name);
  if (driveData.normalizedUrl !== material.normalizedUrl) props[W19_P.NORMALIZED_URL] = w19Text_(driveData.normalizedUrl);
  if (material.syncStatus !== 'synced') props[W19_P.SYNC_STATUS] = w19Select_('synced');
  if (material.error) props[W19_P.SYNC_ERROR] = w19Text_('');
  if (material.integrity !== 'ok') props[W19_P.INTEGRITY] = w19Select_('ok');
  if (!Object.keys(props).length) return page;
  props[W19_P.LAST_SYNC] = w19DateNow_();
  return w19UpdateNotionPage_(page.id, props, cfg);
}

function w19MarkSyncError_(page, err, cfg) {
  try {
    return w19WithMutationLock_(function () {
      var current = w19NotionRequest_('get', '/v1/pages/' + page.id, null, cfg);
      var material = w19MaterialFromPage_(current);
      if (material.archived || material.syncStatus === 'deleting' || material.syncStatus === 'deleted') return current;
      var message = String(err && err.message || 'Ошибка синхронизации').slice(0, 500);
      if (material.syncStatus === 'error' && material.error === message && material.integrity === 'sync_error') return current;
      var props = {};
      props[W19_P.SYNC_STATUS] = w19Select_('error');
      props[W19_P.SYNC_ERROR] = w19Text_(message);
      props[W19_P.LAST_SYNC] = w19DateNow_();
      props[W19_P.INTEGRITY] = w19Select_('sync_error');
      return w19UpdateNotionPage_(current.id, props, cfg);
    });
  } catch (_updateErr) { return page; }
}
