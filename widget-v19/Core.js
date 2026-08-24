/*
 * Pure, dependency-free helpers shared by the Apps Script backend and local
 * Node tests. This file intentionally contains no environment configuration.
 */
var WidgetV19Core = (function () {
  'use strict';

  var SECTIONS = ['Drive', 'Docs', 'Sheets', 'Slides'];
  var GOOGLE_MIME = {
    Docs: 'application/vnd.google-apps.document',
    Sheets: 'application/vnd.google-apps.spreadsheet',
    Slides: 'application/vnd.google-apps.presentation'
  };

  function normalizeUuid(value) {
    var raw = String(value || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (!/^[0-9a-f]{32}$/.test(raw)) return null;
    return raw.slice(0, 8) + '-' + raw.slice(8, 12) + '-' + raw.slice(12, 16) + '-' +
      raw.slice(16, 20) + '-' + raw.slice(20);
  }

  function compactUuid(value) {
    var id = normalizeUuid(value);
    return id ? id.replace(/-/g, '') : null;
  }

  function cleanName(value, fallback) {
    var name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) name = String(fallback || 'Без названия');
    return name.slice(0, 180);
  }

  function cleanMime(value) {
    var mime = String(value || 'application/octet-stream').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+\-]*\/[a-z0-9][a-z0-9!#$&^_.+\-]*$/.test(mime)) return 'application/octet-stream';
    if (/^application\/vnd\.google-apps\./.test(mime)) return 'application/octet-stream';
    return mime;
  }

  function normalizeExternalUrl(value) {
    var raw = String(value || '').trim();
    if (!/^https:\/\//i.test(raw)) return null;
    var fragment = '';
    var hashIndex = raw.indexOf('#');
    if (hashIndex >= 0) {
      fragment = raw.slice(hashIndex);
      raw = raw.slice(0, hashIndex);
    }
    var match = raw.match(/^(https:\/\/)([^/?#]+)([^?#]*)(?:\?([^#]*))?$/i);
    if (!match) return null;
    var host = match[2].toLowerCase().replace(/:443$/, '');
    if (!host || /[\s\\]/.test(host)) return null;
    var path = match[3] || '/';
    path = path.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    var query = [];
    if (match[4]) {
      match[4].split('&').forEach(function (pair) {
        if (!pair) return;
        var key = pair.split('=')[0] || '';
        var decodedKey;
        try { decodedKey = decodeURIComponent(key.replace(/\+/g, ' ')).toLowerCase(); }
        catch (_err) { decodedKey = key.toLowerCase(); }
        if (/^utm_/.test(decodedKey) || /^(fbclid|gclid|yclid|mc_cid|mc_eid)$/.test(decodedKey)) return;
        query.push(pair);
      });
      query.sort();
    }
    return 'https://' + host + path + (query.length ? '?' + query.join('&') : '') + fragment;
  }

  function extractGoogleFileId(value) {
    var url = String(value || '');
    var hostMatch = url.match(/^https:\/\/([^/?#]+)/i);
    var host = hostMatch ? hostMatch[1].toLowerCase().replace(/:443$/, '') : '';
    if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
    var patterns = [
      /\/d\/([a-zA-Z0-9_-]{10,})/,
      /[?&]id=([a-zA-Z0-9_-]{10,})/,
      /\/folders\/([a-zA-Z0-9_-]{10,})/
    ];
    for (var i = 0; i < patterns.length; i += 1) {
      var match = url.match(patterns[i]);
      if (match) return match[1];
    }
    return null;
  }

  function googleHost(value) {
    var match = String(value || '').match(/^https:\/\/([^/?#]+)/i);
    var host = match ? match[1].toLowerCase().replace(/:443$/, '') : '';
    return host === 'drive.google.com' || host === 'docs.google.com' ? host : '';
  }

  function classify(input) {
    input = input || {};
    var name = String(input.name || '').toLowerCase();
    var mime = String(input.mimeType || '').toLowerCase();
    var url = String(input.url || '').toLowerCase();
    var host = googleHost(url);

    if ((host === 'docs.google.com' && /\/document\//.test(url)) || mime === GOOGLE_MIME.Docs) {
      return { section: 'Docs', format: 'Google Docs', provider: 'Google Drive', knowledgeFormat: 'Файл' };
    }
    if ((host === 'docs.google.com' && /\/spreadsheets\//.test(url)) || mime === GOOGLE_MIME.Sheets) {
      return { section: 'Sheets', format: 'Google Sheets', provider: 'Google Drive', knowledgeFormat: 'Файл' };
    }
    if ((host === 'docs.google.com' && /\/presentation\//.test(url)) || mime === GOOGLE_MIME.Slides) {
      return { section: 'Slides', format: 'Google Slides', provider: 'Google Drive', knowledgeFormat: 'Файл' };
    }
    if (/\.(doc|docx|odt|rtf)(?:$|[?#])/.test(name) || /wordprocessingml|msword/.test(mime)) {
      return { section: 'Docs', format: 'Word', provider: 'Google Drive', knowledgeFormat: 'Файл' };
    }
    if (/\.csv(?:$|[?#])/.test(name) || mime === 'text/csv') {
      return { section: 'Sheets', format: 'CSV', provider: 'Google Drive', knowledgeFormat: 'Файл' };
    }
    if (/\.(xls|xlsx|ods)(?:$|[?#])/.test(name) || /spreadsheetml|ms-excel/.test(mime)) {
      return { section: 'Sheets', format: 'Excel', provider: 'Google Drive', knowledgeFormat: 'Файл' };
    }
    if (/\.(ppt|pptx|odp)(?:$|[?#])/.test(name) || /presentationml|ms-powerpoint/.test(mime)) {
      return { section: 'Slides', format: 'PowerPoint', provider: 'Google Drive', knowledgeFormat: 'Файл' };
    }
    if (url && !host) {
      return { section: 'Drive', format: 'Link', provider: 'External URL', knowledgeFormat: 'Ссылка' };
    }
    return { section: 'Drive', format: input.isLink ? 'Link' : 'Other File', provider: input.isLink ? 'External URL' : 'Google Drive', knowledgeFormat: input.isLink ? 'Ссылка' : 'Файл' };
  }

  function assertSection(value) {
    var normalized = String(value || '');
    if (SECTIONS.indexOf(normalized) === -1) throw new Error('INVALID_SECTION');
    return normalized;
  }

  function makeDriveOpenUrl(fileId, format) {
    var id = String(fileId || '');
    if (!id) return null;
    if (format === 'Google Docs') return 'https://docs.google.com/document/d/' + id + '/edit';
    if (format === 'Google Sheets') return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
    if (format === 'Google Slides') return 'https://docs.google.com/presentation/d/' + id + '/edit';
    return 'https://drive.google.com/file/d/' + id + '/view';
  }

  function makeDownloadUrl(fileId) {
    return fileId ? 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(String(fileId)) : null;
  }

  return Object.freeze({
    SECTIONS: SECTIONS.slice(),
    GOOGLE_MIME: Object.freeze(GOOGLE_MIME),
    normalizeUuid: normalizeUuid,
    compactUuid: compactUuid,
    cleanName: cleanName,
    cleanMime: cleanMime,
    normalizeExternalUrl: normalizeExternalUrl,
    extractGoogleFileId: extractGoogleFileId,
    classify: classify,
    assertSection: assertSection,
    makeDriveOpenUrl: makeDriveOpenUrl,
    makeDownloadUrl: makeDownloadUrl
  });
}());
