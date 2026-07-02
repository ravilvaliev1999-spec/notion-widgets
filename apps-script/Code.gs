/**
 * Виджет «Файлы задачи» — серверная часть (Google Apps Script).
 * Работает в паре с task-files-widget-v18.html.
 *
 * Команды:
 *   GET  ?after=<ms>              — файлы Google, созданные после метки времени (авто-добавление)
 *   GET  ?action=download&id=…    — байты файла из Drive (base64) для мгновенного скачивания
 *   GET  ?action=tag&self=<url>   — автопривязка: пометить embed-блоки Notion меткой #task=
 *   POST {action:'upload', …}     — загрузить файл в Drive (папка «Notion — файлы задач/<задача>»)
 *
 * Установка:
 *   1. script.google.com → откройте существующий проект виджета → замените код этим файлом.
 *   2. Проверьте SECRET — он должен совпадать с WIDGET_KEY в HTML виджета.
 *   3. Для автопривязки: Project Settings → Script properties → NOTION_TOKEN = токен интеграции Notion.
 *   4. Разверните: Deploy → Manage deployments → ✏ → Version: New version → Deploy.
 *      (Web app, Execute as: Me, Who has access: Anyone.)
 *      Без пункта 4 изменения кода НЕ попадают в рабочий URL.
 */

var SECRET = 'Mbg8jvthj931bwqgdYZXwyCWpfBTEXOo';
var FOLDER_NAME = 'Notion — файлы задач';
var MAX_DOWNLOAD = 30 * 1024 * 1024; // 30 МБ на скачивание через скрипт

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.key !== SECRET) {
      out = { error: 'bad key' };
    } else if (p.action === 'download') {
      out = download_(p.id);
    } else if (p.action === 'tag') {
      out = tag_(p.self || '');
    } else {
      out = recent_(Number(p.after) || 0);
    }
  } catch (err) {
    out = { error: 'doGet: ' + String(err) };
  }
  return respond_(out, p.callback);
}

function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.key !== SECRET) out = { error: 'bad key' };
    else if (body.action === 'upload') out = upload_(body);
    else out = { error: 'unknown action' };
  } catch (err) {
    out = { error: 'doPost: ' + String(err) };
  }
  return respond_(out, null);
}

function respond_(data, callback) {
  var json = JSON.stringify(data);
  if (callback && /^[\w$.]+$/.test(callback)) { // JSONP для песочниц, где закрыт CORS
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- последние созданные файлы (для авто-добавления после docs.new и т.п.) ---------- */
function recent_(afterMs) {
  var sinceMs = Math.max(afterMs || 0, Date.now() - 15 * 60 * 1000);
  var iso = new Date(sinceMs).toISOString().slice(0, 19); // UTC без миллисекунд
  // в поиске Drive нет поля createdDate — ищем по modifiedDate
  // (у только что созданного файла они совпадают), а дату создания проверяем в коде
  var it = DriveApp.searchFiles("modifiedDate > '" + iso + "' and trashed = false");
  var list = [];
  var checked = 0;
  while (it.hasNext() && checked < 50 && list.length < 25) {
    var f = it.next();
    checked++;
    if (f.getDateCreated().getTime() < sinceMs) continue; // старый файл, просто отредактирован
    list.push({
      name: f.getName(),
      url: f.getUrl(),
      mimeType: f.getMimeType(),
      created: f.getDateCreated().getTime()
    });
  }
  return list;
}

/* ---------- загрузка файла в Drive ---------- */
function upload_(body) {
  try {
    var bytes = Utilities.base64Decode(body.data || '');
    var blob = Utilities.newBlob(bytes, body.mime || 'application/octet-stream', body.name || 'file');
    var file = taskFolder_(String(body.task || '')).createFile(blob); // формат не конвертируется
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (ignored) {} // в корпоративных доменах внешний доступ может быть запрещён
    return { ok: true, id: file.getId(), url: file.getUrl(), name: file.getName() };
  } catch (err) {
    return { error: 'upload: ' + String(err) };
  }
}

function taskFolder_(task) {
  var rootIt = DriveApp.getFoldersByName(FOLDER_NAME);
  var root = rootIt.hasNext() ? rootIt.next() : DriveApp.createFolder(FOLDER_NAME);
  var name = (task.replace(/^[tp]_/, '').slice(0, 80)) || 'без задачи';
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

/* ---------- скачивание оригинала файла (base64 в JSON) ---------- */
function download_(id) {
  try {
    if (!id) return { error: 'нет id файла' };
    var file = DriveApp.getFileById(id);
    if (file.getSize() > MAX_DOWNLOAD) {
      return { error: 'файл больше 30 МБ — откройте его в Drive' };
    }
    var blob = file.getBlob();
    return {
      ok: true,
      name: file.getName(),
      mime: blob.getContentType() || 'application/octet-stream',
      data: Utilities.base64Encode(blob.getBytes())
    };
  } catch (err) {
    return { error: 'download: ' + String(err) };
  }
}

/* ---------- автопривязка: помечаем embed-блоки Notion меткой #task=<id страницы> ---------- */
function tag_(self) {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) return { error: 'NOTION_TOKEN не задан в свойствах скрипта' };
  if (!self) return { error: 'нет параметра self' };
  var headers = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/search', {
    method: 'post',
    headers: headers,
    muteHttpExceptions: true,
    payload: JSON.stringify({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 15
    })
  });
  if (resp.getResponseCode() >= 300) {
    return { error: 'Notion search: HTTP ' + resp.getResponseCode() };
  }
  var pages = JSON.parse(resp.getContentText()).results || [];
  var scanned = 0;
  var tagged = 0;
  for (var i = 0; i < pages.length; i++) {
    var pageId = pages[i].id.replace(/-/g, '');
    var blocks = children_(pages[i].id, headers, 0);
    for (var j = 0; j < blocks.length; j++) {
      var b = blocks[j];
      scanned++;
      var url = (b.type === 'embed' && b.embed) ? b.embed.url : null;
      if (!url || url.indexOf('#task=') > -1) continue;
      if (url.split('#')[0].split('?')[0] !== self) continue;
      var up = UrlFetchApp.fetch('https://api.notion.com/v1/blocks/' + b.id, {
        method: 'patch',
        headers: headers,
        muteHttpExceptions: true,
        payload: JSON.stringify({ embed: { url: self + '#task=' + pageId } })
      });
      if (up.getResponseCode() < 300) tagged++;
    }
  }
  return { ok: true, tagged: tagged, scanned: scanned };
}

function children_(blockId, headers, depth) {
  var out = [];
  var resp = UrlFetchApp.fetch(
    'https://api.notion.com/v1/blocks/' + blockId + '/children?page_size=100',
    { headers: headers, muteHttpExceptions: true }
  );
  if (resp.getResponseCode() >= 300) return out;
  var results = JSON.parse(resp.getContentText()).results || [];
  for (var i = 0; i < results.length; i++) {
    var b = results[i];
    out.push(b);
    // embed может лежать внутри колонок/тогглов — заглядываем на пару уровней
    if (depth < 2 && b.has_children &&
        ['column_list', 'column', 'toggle', 'synced_block', 'callout'].indexOf(b.type) > -1) {
      out = out.concat(children_(b.id, headers, depth + 1));
    }
  }
  return out;
}
