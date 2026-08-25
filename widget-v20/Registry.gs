/* global PropertiesService, ScriptApp, WidgetV19Core */

var W20_REGISTRY_PREFIX = 'w20:material-registry:';
var W20_REGISTRY_SCHEMA = 1;

function w20RegistryTaskPrefix_(taskId) {
  var compactTask = WidgetV19Core.compactUuid(taskId);
  return compactTask ? W20_REGISTRY_PREFIX + compactTask + ':' : '';
}

function w20RegistryKey_(taskId, pageId) {
  var prefix = w20RegistryTaskPrefix_(taskId);
  var compactPage = WidgetV19Core.compactUuid(pageId);
  return prefix && compactPage ? prefix + compactPage : '';
}

function w20RegistryHttps_(value) {
  var url = String(value || '').trim();
  return /^https:\/\/[^\s\\]{1,3900}$/i.test(url) ? url : '';
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
    updatedAt: String(material.updatedAt || new Date().toISOString()).slice(0, 100)
  };
}

function w20RegistryUpsert_(taskId, material) {
  var safe = w20RegistrySafeMaterial_(taskId, material);
  var key = w20RegistryKey_(taskId, material && material.id);
  if (!safe || !key) return false;
  try {
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(safe));
    return true;
  } catch (_err) { return false; }
}

function w20RegistryRemove_(taskId, pageId) {
  var key = w20RegistryKey_(taskId, pageId);
  if (!key) return false;
  try {
    PropertiesService.getScriptProperties().deleteProperty(key);
    return true;
  } catch (_err) { return false; }
}

function w20RegistryReplaceTask_(taskId, materials) {
  var prefix = w20RegistryTaskPrefix_(taskId);
  if (!prefix) return 0;
  try {
    var props = PropertiesService.getScriptProperties();
    var existing = props.getProperties();
    var next = {};
    (Array.isArray(materials) ? materials : []).forEach(function (material) {
      var safe = w20RegistrySafeMaterial_(taskId, material);
      var key = w20RegistryKey_(taskId, material && material.id);
      if (safe && key) next[key] = JSON.stringify(safe);
    });
    Object.keys(existing).forEach(function (key) {
      if (key.indexOf(prefix) === 0 && !Object.prototype.hasOwnProperty.call(next, key)) props.deleteProperty(key);
    });
    if (Object.keys(next).length) props.setProperties(next, false);
    return Object.keys(next).length;
  } catch (_err) { return 0; }
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
    var parsed;
    try { parsed = JSON.parse(values[key]); } catch (_err) { parsed = null; }
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

function w20BootstrapFromRegistry_(input, cfg, reason) {
  var taskId = WidgetV19Core.normalizeUuid(input && input.taskPageId);
  if (!taskId || taskId !== cfg.authorizedTaskPageId || (cfg.deniedPageIds && cfg.deniedPageIds[taskId])) {
    throw new W19Error_('WRITE_BARRIER', 'Эта задача не разрешена для резервного запуска.', false);
  }
  var task = { id: taskId, name: 'Задача' };
  var folder = w19WithMutationLock_(function () { return w19EnsureTaskFolder_(task, cfg); });
  return {
    version: W19_VERSION,
    task: task,
    folderUrl: 'https://drive.google.com/drive/folders/' + encodeURIComponent(folder.id),
    serviceUrl: ScriptApp.getService().getUrl(),
    maxUploadBytes: cfg.maxUploadBytes,
    materials: w20RegistryReadTask_(taskId, cfg),
    degraded: true,
    degradedReason: String(reason && reason.code || 'NOTION_UNAVAILABLE')
  };
}
