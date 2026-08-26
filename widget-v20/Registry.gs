/* global LockService, PropertiesService, ScriptApp, WidgetV19Core, W19Error_ */

var W20_REGISTRY_PREFIX = 'w20:material-registry:';
var W20_REGISTRY_SCHEMA = 1;
var W20_REGISTRY_TOMBSTONE_RECORD = 'tombstone';
var W20_REGISTRY_META_PREFIX = 'w20:bootstrap-meta:';
var W20_REGISTRY_META_SCHEMA = 2;
var W20_REGISTRY_CREATE_POSITION_PREFIX = 'w20:create-position:';
var W20_REGISTRY_ACTION_MAX_AGE_MS = 2 * 60 * 1000;
var W20_REGISTRY_FOLDER_MAX_AGE_MS = 15 * 60 * 1000;
var W20_REGISTRY_TOMBSTONE_GRACE_MS = 15 * 60 * 1000;

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

function w20RegistryStoredProperty_(props, key, values) {
  if (props && typeof props.getProperty === 'function') return props.getProperty(key);
  var stored = values || props && typeof props.getProperties === 'function' && props.getProperties() || {};
  return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null;
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

function w20RegistryIsActiveRecord_(taskId, pageId, record) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var page = WidgetV19Core.normalizeUuid(pageId);
  if (!task || !page || !record || record.schema !== W20_REGISTRY_SCHEMA ||
      record.taskId !== WidgetV19Core.compactUuid(task) || WidgetV19Core.normalizeUuid(record.id) !== page ||
      w20RegistryIsTombstone_(task, page, record)) return false;
  try { return Boolean(w20RegistrySafeMaterial_(task, record)); }
  catch (_err) { return false; }
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
    var existing = w20RegistryParseRecord_(existingRaw);
    if (w20RegistryIsTombstone_(taskId, material.id, existing)) return false;
    props.setProperty(key, JSON.stringify(safe));
    if (!w20RegistryIsActiveRecord_(taskId, material.id, existing)) w20RegistryUpdateSnapshotCountUnlocked_(props, taskId);
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
    var props = PropertiesService.getScriptProperties();
    var existing = w20RegistryParseRecord_(w20RegistryStoredProperty_(props, key));
    props.setProperty(key, JSON.stringify(safe));
    if (!w20RegistryIsActiveRecord_(taskId, material.id, existing)) w20RegistryUpdateSnapshotCountUnlocked_(props, taskId);
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
    var props = PropertiesService.getScriptProperties();
    props.setProperty(key, JSON.stringify(tombstone));
    w20RegistryUpdateSnapshotCountUnlocked_(props, taskId);
    return true;
  } catch (_err) { return false; }
  finally { lock.releaseLock(); }
}

function w20RegistryReplaceTaskResult_(taskId, materials, preserveAfter) {
  var prefix = w20RegistryTaskPrefix_(taskId);
  if (!prefix) return { ok: false, materials: [], activeCount: 0, tombstoneCount: 0, error: 'INVALID_TASK' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, materials: [], activeCount: 0, tombstoneCount: 0, error: 'LOCK_BUSY' };
  try {
    var props = PropertiesService.getScriptProperties();
    var existing = props.getProperties();
    if (!w20RegistryInvalidateSnapshotUnlocked_(props, taskId, existing)) {
      return { ok: false, materials: [], activeCount: 0, tombstoneCount: 0, error: 'META_INVALIDATION_FAILED' };
    }
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
        var removedAt = Date.parse(String(parsed.removedAt || parsed.registryStoredAt || ''));
        var removalAge = Date.now() - removedAt;
        var concurrentRemoval = isFinite(cutoff) && cutoff > 0 && isFinite(removedAt) && removedAt >= cutoff;
        var protectedRemoval = isFinite(removalAge) && removalAge >= -60000 && removalAge <= W20_REGISTRY_TOMBSTONE_GRACE_MS;
        if (concurrentRemoval || protectedRemoval) next[key] = existing[key];
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
    var verified = w20RegistryReadTaskResultFromValues_(taskId, null, props.getProperties());
    if (!verified.ok || !verified.integrityOk) {
      return { ok: false, materials: [], activeCount: 0, tombstoneCount: 0, error: 'VERIFY_FAILED' };
    }
    verified.replacedAt = new Date().toISOString();
    return verified;
  } catch (_err) {
    return { ok: false, materials: [], activeCount: 0, tombstoneCount: 0, error: 'STORAGE_ERROR' };
  }
  finally { lock.releaseLock(); }
}

function w20RegistryReplaceTask_(taskId, materials, preserveAfter) {
  var result = w20RegistryReplaceTaskResult_(taskId, materials, preserveAfter);
  return result.ok ? result.activeCount : 0;
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

function w20RegistryReadTaskResultFromValues_(taskId, cfg, values) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var prefix = w20RegistryTaskPrefix_(task);
  if (!task || !prefix || !values || typeof values !== 'object') {
    return { ok: false, integrityOk: false, materials: [], activeCount: 0, tombstoneCount: 0, invalidCount: 0, error: 'INVALID_READ' };
  }
  var out = [];
  var tombstoneCount = 0;
  var invalidCount = 0;
  Object.keys(values).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;
    var parsed = w20RegistryParseRecord_(values[key]);
    if (parsed && parsed.recordType === W20_REGISTRY_TOMBSTONE_RECORD) {
      if (w20RegistryIsTombstone_(task, parsed.id, parsed) && w20RegistryKey_(task, parsed.id) === key) tombstoneCount += 1;
      else invalidCount += 1;
      return;
    }
    if (!parsed || parsed.schema !== W20_REGISTRY_SCHEMA || parsed.taskId !== WidgetV19Core.compactUuid(task) ||
        w20RegistryKey_(task, parsed.id) !== key) {
      invalidCount += 1;
      return;
    }
    var safe = w20RegistrySafeMaterial_(task, parsed);
    if (!safe) {
      invalidCount += 1;
      return;
    }
    out.push(cfg ? w20MaterialForClient_(safe, task, cfg) : safe);
  });
  out.sort(function (a, b) {
    if (a.section !== b.section) return String(a.section).localeCompare(String(b.section));
    return Number(a.position || 0) - Number(b.position || 0);
  });
  return {
    ok: true,
    integrityOk: invalidCount === 0,
    materials: out,
    activeCount: out.length,
    tombstoneCount: tombstoneCount,
    invalidCount: invalidCount,
    error: invalidCount ? 'INVALID_RECORDS' : null
  };
}

function w20RegistryReadTaskResult_(taskId, cfg) {
  var values;
  try { values = PropertiesService.getScriptProperties().getProperties(); }
  catch (_err) {
    return { ok: false, integrityOk: false, materials: [], activeCount: 0, tombstoneCount: 0, invalidCount: 0, error: 'STORAGE_ERROR' };
  }
  try { return w20RegistryReadTaskResultFromValues_(taskId, cfg, values); }
  catch (_err2) {
    return { ok: false, integrityOk: false, materials: [], activeCount: 0, tombstoneCount: 0, invalidCount: 0, error: 'PARSE_ERROR' };
  }
}

function w20RegistryReadTask_(taskId, cfg) {
  return w20RegistryReadTaskResult_(taskId, cfg).materials;
}

function w20RegistryFolderEvidence_(materials) {
  var found = {};
  (Array.isArray(materials) ? materials : []).forEach(function (material) {
    var folderId = w20SafeDriveId_(material && material.folderId);
    if (folderId && material && material.widgetOwned) found[folderId] = true;
  });
  var ids = Object.keys(found);
  return { consistent: ids.length <= 1, folderId: ids.length === 1 ? ids[0] : '', ownedFolderCount: ids.length };
}

function w20RegistryUniqueFolderId_(materials) {
  var evidence = w20RegistryFolderEvidence_(materials);
  return evidence.consistent ? evidence.folderId : '';
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

function w20RegistrySafeIso_(value) {
  var parsed = Date.parse(String(value || ''));
  return isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function w20RegistrySafeCount_(value) {
  if (value === null || value === undefined || value === '') return null;
  var count = Number(value);
  return isFinite(count) && count >= 0 && Math.floor(count) === count ? count : null;
}

function w20RegistryTaskMetaRecord_(taskId, meta) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  if (!task || !meta) return null;
  return {
    schema: W20_REGISTRY_META_SCHEMA,
    taskId: WidgetV19Core.compactUuid(task),
    taskName: WidgetV19Core.cleanName(meta.taskName, 'Задача'),
    folderId: w20SafeDriveId_(meta.folderId) || '',
    rootFolderId: w20SafeDriveId_(meta.rootFolderId) || '',
    folderVerified: meta.folderVerified === true,
    folderValidatedAt: w20RegistrySafeIso_(meta.folderValidatedAt),
    taskValidatedAt: w20RegistrySafeIso_(meta.taskValidatedAt),
    snapshotValidatedAt: w20RegistrySafeIso_(meta.snapshotValidatedAt),
    snapshotActiveCount: w20RegistrySafeCount_(meta.snapshotActiveCount),
    authoritative: meta.authoritative === true,
    context: w20RegistrySafeTaskContext_(meta.context),
    updatedAt: w20RegistrySafeIso_(meta.updatedAt) || new Date().toISOString()
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
    folderValidatedAt: w20RegistrySafeIso_(parsed.folderValidatedAt),
    taskValidatedAt: w20RegistrySafeIso_(parsed.taskValidatedAt),
    snapshotValidatedAt: w20RegistrySafeIso_(parsed.snapshotValidatedAt),
    snapshotActiveCount: w20RegistrySafeCount_(parsed.snapshotActiveCount),
    authoritative: parsed.authoritative === true,
    context: w20RegistrySafeTaskContext_(parsed.context),
    updatedAt: w20RegistrySafeIso_(parsed.updatedAt)
  };
}

function w20RegistryInvalidateSnapshotUnlocked_(props, taskId, values) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var key = w20RegistryMetaKey_(task);
  if (!task || !key) return false;
  var existing = w20RegistryParseTaskMeta_(task, w20RegistryStoredProperty_(props, key, values));
  if (!existing) return true;
  existing.snapshotValidatedAt = '';
  existing.snapshotActiveCount = null;
  existing.authoritative = false;
  existing.updatedAt = new Date().toISOString();
  props.setProperty(key, JSON.stringify(w20RegistryTaskMetaRecord_(task, existing)));
  return true;
}

function w20RegistryUpdateSnapshotCountUnlocked_(props, taskId, values) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var key = w20RegistryMetaKey_(task);
  if (!task || !key) return false;
  var existing = w20RegistryParseTaskMeta_(task, w20RegistryStoredProperty_(props, key, values));
  if (!existing || !existing.snapshotValidatedAt || existing.snapshotActiveCount === null) return true;
  var current;
  try { current = w20RegistryReadTaskResultFromValues_(task, null, values || props.getProperties()); }
  catch (_err) { current = null; }
  if (!current || !current.ok || !current.integrityOk) return w20RegistryInvalidateSnapshotUnlocked_(props, task);
  existing.snapshotActiveCount = current.activeCount;
  existing.authoritative = Boolean(existing.taskValidatedAt && existing.snapshotValidatedAt);
  existing.updatedAt = new Date().toISOString();
  props.setProperty(key, JSON.stringify(w20RegistryTaskMetaRecord_(task, existing)));
  return true;
}

function w20RegistryWriteTaskMeta_(taskId, meta) {
  var task = WidgetV19Core.normalizeUuid(taskId);
  var key = w20RegistryMetaKey_(task);
  if (!task || !key) return false;
  var source = meta || {};
  var owns = Object.prototype.hasOwnProperty;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    var existing = w20RegistryParseTaskMeta_(task, props.getProperty(key));
    var folderId = owns.call(source, 'folderId') ? w20SafeDriveId_(source.folderId) || '' : existing && existing.folderId || '';
    var rootFolderId = owns.call(source, 'rootFolderId') ? w20SafeDriveId_(source.rootFolderId) || '' : existing && existing.rootFolderId || '';
    var folderValidatedAt = owns.call(source, 'folderValidatedAt') ? w20RegistrySafeIso_(source.folderValidatedAt) : existing && existing.folderValidatedAt || '';
    if (existing && existing.folderId === folderId && existing.rootFolderId === rootFolderId &&
        existing.folderVerified && Date.parse(existing.folderValidatedAt) > Date.parse(folderValidatedAt)) {
      folderValidatedAt = existing.folderValidatedAt;
    }
    var taskValidatedAt = owns.call(source, 'taskValidatedAt') ? w20RegistrySafeIso_(source.taskValidatedAt) : existing && existing.taskValidatedAt || '';
    var snapshotValidatedAt = owns.call(source, 'snapshotValidatedAt') ? w20RegistrySafeIso_(source.snapshotValidatedAt) : existing && existing.snapshotValidatedAt || '';
    var snapshotActiveCount = owns.call(source, 'snapshotActiveCount') ? w20RegistrySafeCount_(source.snapshotActiveCount) : existing && existing.snapshotActiveCount;
    if (!snapshotValidatedAt || snapshotActiveCount === null || snapshotActiveCount === undefined) {
      snapshotValidatedAt = '';
      snapshotActiveCount = null;
    } else {
      var registry = w20RegistryReadTaskResultFromValues_(task, null, props.getProperties());
      if (!registry.ok || !registry.integrityOk || registry.activeCount !== snapshotActiveCount) {
        snapshotValidatedAt = '';
        snapshotActiveCount = null;
      }
    }
    var safe = {
      taskName: owns.call(source, 'taskName') ? source.taskName : existing && existing.taskName,
      folderId: folderId,
      rootFolderId: rootFolderId,
      folderVerified: Boolean(folderId && rootFolderId && folderValidatedAt &&
        (source.folderVerified === true || existing && existing.folderId === folderId && existing.rootFolderId === rootFolderId && existing.folderVerified)),
      folderValidatedAt: folderValidatedAt,
      taskValidatedAt: taskValidatedAt,
      snapshotValidatedAt: snapshotValidatedAt,
      snapshotActiveCount: snapshotActiveCount,
      authoritative: Boolean(taskValidatedAt && snapshotValidatedAt && snapshotActiveCount !== null),
      context: owns.call(source, 'context') ? source.context : existing && existing.context,
      updatedAt: new Date().toISOString()
    };
    props.setProperty(key, JSON.stringify(w20RegistryTaskMetaRecord_(task, safe)));
    return true;
  } catch (_err) { return false; }
  finally { lock.releaseLock(); }
}

function w20RegistryWriteFolderProof_(taskId, meta) {
  return w20RegistryWriteTaskMeta_(taskId, {
    folderId: meta && meta.folderId,
    rootFolderId: meta && meta.rootFolderId,
    folderVerified: meta && meta.folderVerified === true,
    folderValidatedAt: meta && meta.folderValidatedAt
  });
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
  var taskValidatedAt = Date.parse(String(meta && meta.taskValidatedAt || ''));
  var snapshotValidatedAt = Date.parse(String(meta && meta.snapshotValidatedAt || ''));
  var taskAge = Date.now() - taskValidatedAt;
  var snapshotAge = Date.now() - snapshotValidatedAt;
  return Boolean(meta && meta.authoritative && meta.snapshotActiveCount !== null &&
    isFinite(taskValidatedAt) && taskAge >= -60000 && taskAge <= W20_REGISTRY_ACTION_MAX_AGE_MS &&
    isFinite(snapshotValidatedAt) && snapshotAge >= -60000 && snapshotAge <= W20_REGISTRY_ACTION_MAX_AGE_MS);
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
  var registry = w20RegistryReadTaskResult_(taskId, null);
  return w20RegistryTaskMetaFresh_(meta) && registry.ok && registry.integrityOk &&
    registry.activeCount === meta.snapshotActiveCount ? meta : null;
}

function w20RegistryActionProof_(meta, registry, expectedRootFolderId) {
  var folderEvidence = w20RegistryFolderEvidence_(registry && registry.materials);
  var ready = Boolean(w20RegistryTaskMetaFresh_(meta) && registry && registry.ok && registry.integrityOk &&
    registry.activeCount === meta.snapshotActiveCount && folderEvidence.consistent &&
    (!folderEvidence.folderId || folderEvidence.folderId === meta.folderId) &&
    w20RegistryFolderMetaFresh_(meta, expectedRootFolderId));
  if (!ready) return { ready: false, trustedUntil: null };
  var trustedUntil = Math.min(
    Date.parse(meta.taskValidatedAt) + W20_REGISTRY_ACTION_MAX_AGE_MS,
    Date.parse(meta.snapshotValidatedAt) + W20_REGISTRY_ACTION_MAX_AGE_MS,
    Date.parse(meta.folderValidatedAt) + W20_REGISTRY_FOLDER_MAX_AGE_MS
  );
  return { ready: true, trustedUntil: new Date(trustedUntil).toISOString() };
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
    var values = props.getProperties();
    var meta = w20RegistryParseTaskMeta_(task, values[metaKey]);
    var registry;
    try { registry = w20RegistryReadTaskResultFromValues_(task, null, values); }
    catch (_registryError) { return null; }
    if (!w20RegistryActionProof_(meta, registry, rootFolderId).ready) return null;
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
  var registry = w20RegistryReadTaskResult_(taskId, cfg);
  if (!registry.ok || !registry.integrityOk) return null;
  var stored = registry.materials;
  var meta = w20RegistryReadTaskMeta_(taskId);
  if (!meta && !stored.length) return null;
  var task = { id: taskId, name: meta && meta.taskName || 'Задача' };
  var folderReady = w20RegistryFolderMetaFresh_(meta, cfg.rootFolderId);
  var actionProof = w20RegistryActionProof_(meta, registry, cfg.rootFolderId);
  if (actionProof.ready) w20CacheDownloadRegistryMaterials_(taskId, stored, cfg, actionProof.trustedUntil);
  return {
    version: W19_VERSION,
    task: task,
    folderUrl: folderReady ? 'https://drive.google.com/drive/folders/' + encodeURIComponent(meta.folderId) : null,
    serviceUrl: ScriptApp.getService().getUrl(),
    maxUploadBytes: cfg.maxUploadBytes,
    materials: stored,
    cached: true,
    authoritative: false,
    actionReady: actionProof.ready,
    trustedUntil: actionProof.trustedUntil,
    fullySynced: false,
    refreshRequired: true,
    degraded: Boolean(reason),
    degradedReason: reason ? String(reason.code || 'NOTION_UNAVAILABLE') : null
  };
}
