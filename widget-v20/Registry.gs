/* global LockService, PropertiesService, ScriptApp, WidgetV19Core, W19Error_ */

var W20_REGISTRY_PREFIX = 'w20:material-registry:';
var W20_REGISTRY_SCHEMA = 1;
var W20_REGISTRY_TOMBSTONE_RECORD = 'tombstone';
var W20_REGISTRY_META_PREFIX = 'w20:bootstrap-meta:';
var W20_REGISTRY_META_SCHEMA = 1;
var W20_REGISTRY_CREATE_POSITION_PREFIX = 'w20:create-position:';
var W20_REGISTRY_META_MAX_AGE_MS = 15 * 60 * 1000;
var W20_REGISTRY_FOLDER_MAX_AGE_MS = 15 * 60 * 1000;

function w20RegistryTaskPrefix_(taskId) {
  var compactTask = WidgetV19Core.compactUuid(taskId);
  return compactTask ? W20_REGISTRY_PREFIX + compactTask + ':' : '';
}

function w20RegistryKey_(taskId, pageId) {
  var prefix = w20RegistryTaskPrefix_(taskId);
  var compactPage = WidgetV19Core.compactUuid(pageId);
  return prefix && compactPage ? prefix + compactPage : '';
}

function w20RegistryMetaKey_(taskId) {
  var compactTask = WidgetV19Core.compactUuid(taskId);
  return compactTask ? W20_REGISTRY_META_PREFIX + compactTask : '';
}

function w20RegistryCreatePositionKey_(taskId, section) {
  var compactTask = WidgetV19Core.compactUuid(taskId);
  var normalizedSection;
  try { normalizedSection = WidgetV19Core.assertSection(section); }
  catch (_err) { return ''; }
  return compactTask ? W20_REGISTRY_CREATE_POSITION_PREFIX + compactTask + ':' + normalizedSection : '';
}

function w20RegistryHttps_(value) {
  var url = String(value || '').trim();
  return /^https:\/\/[^\s\\]{1,3900}$/i.test(url) ? url : '';
}

function w20RegistryStoredAt_(value) {
  var parsed = Date.parse(String(value || ''));
  return isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function w20RegistryParseRecord_(raw) {
  try { return raw ? JSON.parse(raw) : null; }
  catch (_err) { return null; }
}

function w20RegistryTombstone_(taskId, pageId) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  if (!task || !page) return null;
  var storedAt = new Date().toISOString();
  return {
    schema: W20_REGISTRY_SCHEMA,
    recordType: W20_REGISTRY_TOMBSTONE_RECORD,
    taskId: WidgetV19Core.compactUuid(task),
    id: page,
    registryStoredAt: storedAt,
    removedAt: storedAt
  };
}

function w20RegistryIsTombstone_(taskId, pageId, record) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  return Boolean(task && page && record && record.schema === W20_REGISTRY_SCHEMA &&
    record.recordType === W20_REGISTRY_TOMBSTONE_RECORD &&
    record.taskId === WidgetV19Core.compactUuid(task) && record.id === page);
}

function w20RegistrySafeMaterial_(taskId, material) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(material && material.id);
  if (!task || !page || !material || material.archived ||
      material.syncStatus === 'deleting' || material.syncStatus === 'deleted') return null;
  var googleFileId = w20SafeDriveId_(material.googleFileId);
  var folderId = w20SafeDriveId_(material.folderId);
  var format = String(material.format || 'Other File').slice(0, 100);
  var provider = String(material.provider || 'External URL').slice(0, 100);
  var nativeGoogle = /^Google (?:Docs|Sheets|Slides)$/.test(format);
  var widgetOwned = Boolean(googleFileId && folderId);
  var widgetOwnedBinary = Boolean(provider === 'Google Drive' && widgetOwned && !nativeGoogle);
  var createRequestId = String(material.createRequestId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(createRequestId)) createRequestId = '';
  return {
    schema: W20_REGISTRY_SCHEMA,
    taskId: WidgetV19Core.compactUuid(task),
    id: page,
    name: WidgetV19Core.cleanName(material.name, 'Без названия'),
    section: WidgetV19Core.assertSection(material.section),
    format: format,
    provider: provider,
    openUrl: w20RegistryHttps_(material.openUrl) || null,
    downloadUrl: null,
    canDownload: widgetOwnedBinary,
    hostedAttachment: false,
    googleFileId: googleFileId || null,
    folderId: folderId || null,
    widgetOwned: widgetOwned,
    widgetOwnedBinary: widgetOwnedBinary,
    mimeType: String(material.mimeType || '').slice(0, 300) || null,
    size: Number.isFinite(Number(material.size)) && Number(material.size) >= 0 ? Number(material.size) : null,
    driveMd5: String(material.driveMd5 || '').slice(0, 128),
    downloadName: WidgetV19Core.cleanName(material.downloadName || material.name, 'Файл'),
    normalizedUrl: w20RegistryHttps_(material.normalizedUrl),
    knowledgeFormat: String(material.knowledgeFormat || 'Файл').slice(0, 100),
    integrity: String(material.integrity || 'ok').slice(0, 100),
    position: Number.isFinite(Number(material.position)) && Number(material.position) >= 0 ? Math.round(Number(material.position)) : 0,
    syncStatus: 'synced',
    error: null,
    archived: false,
    createRequestId: createRequestId || null,
    registryStoredAt: w20RegistryStoredAt_(material.registryStoredAt),
    updatedAt: String(material.updatedAt || new Date().toISOString()).slice(0, 100)
  };
}

function w20RegistryUpsert_(taskId, material) {
  var safe = w20RegistrySafeMaterial_(taskId, material);
  var key = w20RegistryKey_(taskId, material && material.id);
  if (!safe || !key) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    var existingRaw = typeof props.getProperty === 'function' ? props.getProperty(key) : props.getProperties()[key];
    if (w20RegistryIsTombstone_(taskId, material.id, w20RegistryParseRecord_(existingRaw))) return false;
    props.setProperty(key, JSON.stringify(safe));
    return true;
  } catch (_err) { return false; }
  finally { lock.releaseLock(); }
}

function w20RegistryRestore_(taskId, material) {
  var safe = w20RegistrySafeMaterial_(taskId, material);
  var key = w20RegistryKey_(taskId, material && material.id);
  if (!safe || !key) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(safe));
    return true;
  } catch (_err) { return false; }
  finally { lock.releaseLock(); }
}

function w20RegistryRemove_(taskId, pageId) {
  var key = w20RegistryKey_(taskId, pageId);
  var tombstone = w20RegistryTombstone_(taskId, pageId);
  if (!key || !tombstone) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(tombstone));
    return true;
  } catch (_err) { return false; }
  finally { lock.releaseLock(); }
}

function w20RegistryReplaceTask_(taskId, materials, preserveAfter) {
  var prefix = w20RegistryTaskPrefix_(taskId);
  if (!prefix) return 0;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  try {
    var props = PropertiesService.getScriptProperties();
    var existing = props.getProperties();
    var next = {};
    (Array.isArray(materials) ? materials : []).forEach(function (material) {
      var safe = w20RegistrySafeMaterial_(taskId, material);
      var key = w20RegistryKey_(taskId, material && material.id);
      if (safe && key) next[key] = JSON.stringify(safe);
    });
    var cutoff = Number(preserveAfter || 0);
    Object.keys(existing).forEach(function (key) {
      if (key.indexOf(prefix) !== 0) return;
      var parsed = w20RegistryParseRecord_(existing[key]);
      if (w20RegistryIsTombstone_(taskId, parsed && parsed.id, parsed)) {
        next[key] = existing[key];
        return;
      }
      var storedAt = Date.parse(String(parsed && parsed.registryStoredAt || ''));
      if (isFinite(cutoff) && cutoff > 0 && isFinite(storedAt) && storedAt >= cutoff) next[key] = existing[key];
    });
    Object.keys(existing).forEach(function (key) {
      if (key.indexOf(prefix) === 0 && !Object.prototype.hasOwnProperty.call(next, key)) props.deleteProperty(key);
    });
    var nextKeys = Object.keys(next);
    if (nextKeys.length) props.setProperties(next, false);
    return nextKeys.filter(function (key) {
      var parsed = w20RegistryParseRecord_(next[key]);
      return parsed && parsed.schema === W20_REGISTRY_SCHEMA &&
        parsed.taskId === WidgetV19Core.compactUuid(taskId) && w20RegistryKey_(taskId, parsed.id) === key &&
        !w20RegistryIsTombstone_(taskId, parsed.id, parsed);
    }).length;
  } catch (_err) { return 0; }
  finally { lock.releaseLock(); }
}

function w20RegistryApplyOrder_(taskId, items) {
  var materials = w20RegistryReadTask_(taskId, null);
  var byId = {};
  materials.forEach(function (material) { byId[material.id] = material; });
  (Array.isArray(items) ? items : []).forEach(function (item) {
    var id = WidgetV19Core.normalizeUuid(item && item.pageId);
    if (!id || !byId[id]) return;
    byId[id].position = Math.max(0, Math.round(Number(item.position) || 0));
    byId[id].section = WidgetV19Core.assertSection(item.section);
    w20RegistryUpsert_(taskId, byId[id]);
  });
}

function w20RegistryReadTask_(taskId, cfg) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var prefix = w20RegistryTaskPrefix_(task);
  if (!task || !prefix) return [];
  var out = [];
  var values;
  try { values = PropertiesService.getScriptProperties().getProperties(); }
  catch (_err) { return out; }
  Object.keys(values).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;
    var parsed = w20RegistryParseRecord_(values[key]);
    if (parsed && parsed.recordType === W20_REGISTRY_TOMBSTONE_RECORD) return;
    if (!parsed || parsed.schema !== W20_REGISTRY_SCHEMA || parsed.taskId !== WidgetV19Core.compactUuid(task) ||
        w20RegistryKey_(task, parsed.id) !== key) return;
    var safe = w20RegistrySafeMaterial_(task, parsed);
    if (!safe) return;
    out.push(cfg ? w20MaterialForClient_(safe, task, cfg) : safe);
  });
  return out.sort(function (a, b) {
    if (a.section !== b.section) return String(a.section).localeCompare(String(b.section));
    return Number(a.position || 0) - Number(b.position || 0);
  });
}

function w20RegistryUniqueFolderId_(materials) {
  var found = {};
  (Array.isArray(materials) ? materials : []).forEach(function (material) {
    var folderId = w20SafeDriveId_(material && material.folderId);
    if (folderId && material && material.widgetOwned) found[folderId] = true;
  });
  var ids = Object.keys(found);
  return ids.length === 1 ? ids[0] : '';
}

function w20RegistrySafeTaskContext_(context) {
  var source = context || {};
  function ids(value) {
    var found = {};
    return (Array.isArray(value) ? value : []).map(function (id) {
      return WidgetV19Core.normalizeUuid(id);
    }).filter(function (id) {
      if (!id || found[id]) return false;
      found[id] = true;
      return true;
    }).slice(0, 25);
  }
  var depth = Number(source.depth);
  return {
    sphereIds: ids(source.sphereIds),
    directionIds: ids(source.directionIds),
    projectIds: ids(source.projectIds),
    path: String(source.path || '').slice(0, 1900),
    ancestorIds: String(source.ancestorIds || '').slice(0, 1900),
    depth: isFinite(depth) && depth >= 0 ? Math.floor(depth) : 0
  };
}

function w20RegistryParseTaskMeta_(taskId, raw) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var parsed;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_err) { parsed = null; }
  if (!task || !parsed || parsed.schema !== W20_REGISTRY_META_SCHEMA ||
      parsed.taskId !== WidgetV19Core.compactUuid(task)) return null;
  return {
    taskName: WidgetV19Core.cleanName(parsed.taskName, 'Задача'),
    folderId: w20SafeDriveId_(parsed.folderId) || '',
    rootFolderId: w20SafeDriveId_(parsed.rootFolderId) || '',
    folderVerified: parsed.folderVerified === true,
    folderValidatedAt: String(parsed.folderValidatedAt || '').slice(0, 100),
    authoritative: parsed.authoritative === true,
    validatedAt: String(parsed.validatedAt || '').slice(0, 100),
    context: w20RegistrySafeTaskContext_(parsed.context),
    updatedAt: String(parsed.updatedAt || '').slice(0, 100)
  };
}

function w20RegistryWriteTaskMeta_(taskId, meta) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var key = w20RegistryMetaKey_(task);
  if (!task || !key) return false;
  var folderValidatedAt = String(meta && meta.folderValidatedAt || '').slice(0, 100);
  if (!isFinite(Date.parse(folderValidatedAt))) folderValidatedAt = '';
  var folderId = w20SafeDriveId_(meta && meta.folderId) || '';
  var rootFolderId = w20SafeDriveId_(meta && meta.rootFolderId) || '';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    var existing = w20RegistryParseTaskMeta_(task, props.getProperty(key));
    if (existing && existing.folderId === folderId && existing.rootFolderId === rootFolderId &&
        existing.folderVerified && Date.parse(existing.folderValidatedAt) > Date.parse(folderValidatedAt)) {
      folderValidatedAt = existing.folderValidatedAt;
    }
  var safe = {
    schema: W20_REGISTRY_META_SCHEMA,
    taskId: WidgetV19Core.compactUuid(task),
    taskName: WidgetV19Core.cleanName(meta && meta.taskName, 'Задача'),
    folderId: folderId,
    rootFolderId: rootFolderId,
    folderVerified: Boolean(folderId && rootFolderId && folderValidatedAt &&
      (meta && meta.folderVerified === true || existing && existing.folderId === folderId && existing.rootFolderId === rootFolderId && existing.folderVerified)),
    folderValidatedAt: folderValidatedAt,
    authoritative: true,
    validatedAt: new Date().toISOString(),
    context: w20RegistrySafeTaskContext_(meta && meta.context),
    updatedAt: new Date().toISOString()
  };
    props.setProperty(key, JSON.stringify(safe));
    return true;
  } catch (_err) { return false; }
  finally { lock.releaseLock(); }
}

function w20RegistryReadTaskMeta_(taskId) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var key = w20RegistryMetaKey_(task);
  if (!task || !key) return null;
  var raw;
  try { raw = PropertiesService.getScriptProperties().getProperty(key); }
  catch (_err) { return null; }
  return w20RegistryParseTaskMeta_(task, raw);
}

function w20RegistryTaskMetaFresh_(meta) {
  var validatedAt = Date.parse(String(meta && meta.validatedAt || ''));
  var age = Date.now() - validatedAt;
  return Boolean(meta && meta.authoritative && isFinite(validatedAt) && age >= -60000 && age <= W20_REGISTRY_META_MAX_AGE_MS);
}

function w20RegistryFolderMetaFresh_(meta, expectedRootFolderId) {
  var validatedAt = Date.parse(String(meta && meta.folderValidatedAt || ''));
  var rootFolderId = w20SafeDriveId_(expectedRootFolderId);
  var age = Date.now() - validatedAt;
  return Boolean(meta && meta.folderVerified && meta.folderId && rootFolderId && meta.rootFolderId === rootFolderId && isFinite(validatedAt) &&
    age >= -60000 && age <= W20_REGISTRY_FOLDER_MAX_AGE_MS);
}

function w20RegistryReadFreshTaskMeta_(taskId) {
  var meta = w20RegistryReadTaskMeta_(taskId);
  return w20RegistryTaskMetaFresh_(meta) ? meta : null;
}

function w20RegistryReservePositionUnlocked_(props, taskId, section, minimumNext, values) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var normalizedSection = WidgetV19Core.assertSection(section);
  var prefix = w20RegistryTaskPrefix_(task);
  var positionKey = w20RegistryCreatePositionKey_(task, normalizedSection);
  if (!task || !prefix || !positionKey) throw new W19Error_('TASK_ID_REQUIRED', 'Не удалось зарезервировать позицию материала.', false);
  var highest = -1;
  var stored = values || props.getProperties();
  Object.keys(stored).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;
    var parsed;
    try { parsed = JSON.parse(stored[key]); } catch (_err) { parsed = null; }
    if (!parsed || parsed.schema !== W20_REGISTRY_SCHEMA || parsed.taskId !== WidgetV19Core.compactUuid(task) ||
        parsed.section !== normalizedSection || parsed.archived) return;
    var itemPosition = Number(parsed.position);
    if (isFinite(itemPosition) && itemPosition >= 0) highest = Math.max(highest, Math.round(itemPosition));
  });
  var reserved = Number(props.getProperty(positionKey));
  if (!isFinite(reserved) || reserved < 0) reserved = 0;
  var floor = Number(minimumNext);
  if (!isFinite(floor) || floor < 0) floor = 0;
  var position = Math.max(highest + 1, Math.round(reserved), Math.round(floor));
  props.setProperty(positionKey, String(position + 1));
  return position;
}

function w20RegistryReservePosition_(taskId, section, minimumNext) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new W19Error_('BUSY', 'Сервис занят другой операцией. Повторите через несколько секунд.', true);
  try {
    var props = PropertiesService.getScriptProperties();
    return w20RegistryReservePositionUnlocked_(props, taskId, section, minimumNext, props.getProperties());
  } finally {
    lock.releaseLock();
  }
}

function w20RegistryClaimCreateSlot_(taskId, section, rootFolderId) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var prefix = w20RegistryTaskPrefix_(task);
  var metaKey = w20RegistryMetaKey_(task);
  var positionKey = w20RegistryCreatePositionKey_(task, section);
  if (!task || !prefix || !metaKey || !positionKey) return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new W19Error_('BUSY', 'Сервис занят другой операцией. Повторите через несколько секунд.', true);
  try {
    var props = PropertiesService.getScriptProperties();
    var meta = w20RegistryParseTaskMeta_(task, props.getProperty(metaKey));
    if (!w20RegistryTaskMetaFresh_(meta) || !w20RegistryFolderMetaFresh_(meta, rootFolderId)) return null;

    var values = props.getProperties();
    var position = w20RegistryReservePositionUnlocked_(props, task, section, 0, values);
    return { taskMeta: meta, position: position };
  } finally {
    lock.releaseLock();
  }
}

function w20RegistryFindCreateRequest_(taskId, section, requestId) {
  var normalizedRequest = String(requestId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalizedRequest)) return null;
  var materials = w20RegistryReadTask_(taskId, null);
  for (var i = 0; i < materials.length; i += 1) {
    if (materials[i].section === section && materials[i].createRequestId === normalizedRequest) return materials[i];
  }
  return null;
}

function w20RegistryFolderId_(taskId, materials) {
  var live = w20RegistryUniqueFolderId_(materials);
  if (live) return live;
  var meta = w20RegistryReadTaskMeta_(taskId);
  if (meta && meta.folderId) return meta.folderId;
  return w20RegistryUniqueFolderId_(w20RegistryReadTask_(taskId, null));
}

function w20BootstrapFromRegistry_(input, cfg, reason) {
  var taskId = WidgetV19Core.normalizeUuid(input && input.taskPageId);
  if (!taskId || taskId !== cfg.authorizedTaskPageId || (cfg.deniedPageIds && cfg.deniedPageIds[taskId])) {
    throw new W19Error_('WRITE_BARRIER', 'Эта задача не разрешена для резервного запуска.', false);
  }
  var stored = w20RegistryReadTask_(taskId, null);
  var meta = w20RegistryReadTaskMeta_(taskId);
  if (!meta && !stored.length) return null;
  var task = { id: taskId, name: meta && meta.taskName || 'Задача' };
  var materials = stored.map(function (material) {
    return {
      id: material.id,
      name: material.name,
      section: material.section,
      format: material.format,
      provider: material.provider,
      position: material.position,
      syncStatus: 'synced',
      archived: false,
      provisional: true
    };
  });
  return {
    version: W19_VERSION,
    task: task,
    folderUrl: null,
    serviceUrl: ScriptApp.getService().getUrl(),
    maxUploadBytes: cfg.maxUploadBytes,
    materials: materials,
    cached: true,
    authoritative: false,
    refreshRequired: true,
    degraded: Boolean(reason),
    degradedReason: reason ? String(reason.code || 'NOTION_UNAVAILABLE') : null
  };
}
