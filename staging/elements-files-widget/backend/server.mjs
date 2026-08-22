import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { AppError, asAppError, invariant } from './lib/errors.mjs';
import { assertWriteGate, loadConfig, normalizeId } from './lib/config.mjs';
import { bearer, issueTaskToken, signToken, verifyToken } from './lib/auth.mjs';
import { DriveClient } from './lib/drive.mjs';
import {
  NotionClient,
  assertSandboxTask,
  pageParentDataSource,
  propertySelect,
  propertyText
} from './lib/notion.mjs';
import { P, RecordRepository, classifyFile, normalizeExternalUrl } from './lib/records.mjs';
import { startRenameSync } from './lib/sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, '..', 'frontend');
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const SECTION_VALUES = new Set(['Drive', 'Docs', 'Sheets', 'Slides']);
const FORMAT_VALUES = new Set(['Google Docs', 'Word', 'Google Sheets', 'Excel', 'CSV', 'Google Slides', 'PowerPoint', 'Link', 'Other File']);
const GOOGLE_KIND_FORMAT = Object.freeze({ docs: 'Google Docs', sheets: 'Google Sheets', slides: 'Google Slides' });

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function readBody(request, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError(413, 'payload_too_large', 'Тело запроса слишком большое'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const body = await readBody(request);
  if (!body.length) return {};
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new AppError(400, 'invalid_json', 'Некорректный JSON'); }
}

function cleanName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  invariant(name.length >= 1 && name.length <= 180, 422, 'invalid_name', 'Имя должно содержать от 1 до 180 символов');
  return name;
}

function idempotencyKey(request, body) {
  const key = String(request.headers['idempotency-key'] || body.idempotencyKey || '').trim();
  invariant(/^[A-Za-z0-9._:-]{8,128}$/.test(key), 422, 'invalid_idempotency_key', 'Нужен Idempotency-Key длиной 8–128 символов');
  return key;
}

function clientAddress(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function createLimiter(limit = 90, windowMs = 60_000) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    invariant(current.count <= limit, 429, 'rate_limited', 'Слишком много запросов; повторите позже');
  };
}

function safeOriginSet(config) {
  const origins = new Set(config.allowedOrigins);
  for (const value of [config.publicBaseUrl, config.widgetPublicUrl]) {
    try { origins.add(new URL(value).origin); } catch {}
  }
  return origins;
}

function applyApiCors(request, response, allowedOrigins) {
  const origin = String(request.headers.origin || '');
  if (origin) invariant(allowedOrigins.has(origin), 403, 'origin_blocked', 'Origin не разрешён');
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Credentials', 'false');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Upload-Token, X-Delete-Token');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
}

function verifyNotionWebhook(rawBody, signatureHeader, verificationToken) {
  invariant(verificationToken, 503, 'webhook_not_configured', 'Notion webhook verification token не настроен');
  const expected = 'sha256=' + createHmac('sha256', verificationToken).update(rawBody).digest('hex');
  const actual = String(signatureHeader || '');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  invariant(a.length === b.length && timingSafeEqual(a, b), 401, 'invalid_webhook_signature', 'Подпись Notion webhook не совпала');
}

function embedUrl(config, taskId) {
  const token = issueTaskToken(taskId, config.elementsDataSourceId, config.signingSecret);
  const base = config.widgetPublicUrl || config.publicBaseUrl + '/';
  return base.replace(/#.*$/, '') + '#task=' + normalizeId(taskId) + '&access=' + encodeURIComponent(token);
}

function validEmbedForTask(urlValue, taskId, config) {
  try {
    const url = new URL(urlValue);
    const expectedBase = new URL(config.widgetPublicUrl || config.publicBaseUrl + '/');
    if (url.origin !== expectedBase.origin || url.pathname !== expectedBase.pathname) return false;
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (normalizeId(params.get('task')) !== normalizeId(taskId)) return false;
    const access = verifyToken(params.get('access'), config.signingSecret, { aud: 'widget', taskId });
    return Number(access.exp) > Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  } catch {
    return false;
  }
}

function safeFileNameForHeader(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}

function uploadFingerprint({ name, mimeType, size, sha256 }) {
  return createHash('sha256').update(JSON.stringify([String(name), String(mimeType), Number(size), String(sha256)])).digest('hex');
}

export function createApplication(config = loadConfig(), dependencies = {}) {
  const notion = dependencies.notion || new NotionClient(config);
  const drive = dependencies.drive || new DriveClient(config);
  const records = dependencies.records || new RecordRepository(config, notion);
  const logger = dependencies.logger || console;
  const allowedOrigins = safeOriginSet(config);
  const limitWrite = createLimiter();
  const folderCache = new Map();
  const mutationInflight = new Map();
  const uploadSessions = new Map();
  let writePreflight;

  async function onceMutation(key, operation) {
    if (mutationInflight.has(key)) return mutationInflight.get(key);
    const pending = Promise.resolve().then(operation);
    mutationInflight.set(key, pending);
    try { return await pending; } finally { mutationInflight.delete(key); }
  }

  async function requireTask(request, taskId) {
    const access = verifyToken(bearer(request.headers), config.signingSecret, { aud: 'widget', taskId });
    invariant(normalizeId(access.dataSourceId) === normalizeId(config.elementsDataSourceId), 403, 'wrong_data_source', 'Token выпущен для другой базы');
    const page = await notion.retrievePage(normalizeId(taskId));
    assertSandboxTask(page, config.elementsDataSourceId);
    return page;
  }

  async function ensureWriteReady() {
    assertWriteGate(config);
    if (!writePreflight) {
      writePreflight = drive.assertStagingRoot({
        folderId: config.stagingDriveFolderId,
        expectedAccountEmail: config.googleExpectedAccountEmail,
        expectedMarker: config.stagingDriveMarker
      }).catch((error) => { writePreflight = null; throw error; });
    }
    return writePreflight;
  }

  async function requireWrite(request, taskId) {
    limitWrite(clientAddress(request) + ':' + normalizeId(taskId));
    await ensureWriteReady();
  }

  async function taskFolder(taskPage, taskId) {
    const key = normalizeId(taskId);
    if (folderCache.has(key)) return folderCache.get(key);
    const name = propertyText(taskPage.properties && taskPage.properties.Name) || 'Task';
    const pending = drive.ensureTaskFolder(config.stagingDriveFolderId, key, name);
    folderCache.set(key, pending);
    try { return await pending; }
    catch (error) { folderCache.delete(key); throw error; }
  }

  function assertNativeMatch(existing, { name, kind }) {
    invariant(existing.provider === 'Google Drive' && existing.name === name && existing.format === GOOGLE_KIND_FORMAT[kind],
      409, 'idempotency_conflict', 'Idempotency-Key уже использован для другого Google-файла');
  }

  function assertLinkMatch(existing, { name, section, url }) {
    invariant(existing.provider === 'External URL' && existing.name === name && existing.section === section && existing.url === url,
      409, 'idempotency_conflict', 'Idempotency-Key уже использован для другой ссылки');
  }

  function assertUploadRecordMatch(existing, expected) {
    invariant(existing.provider === 'Google Drive' && existing.name === expected.name && existing.mimeType === expected.mimeType &&
      Number(existing.size) === Number(expected.size) && existing.sha256 === expected.sha256,
    409, 'idempotency_conflict', 'Idempotency-Key уже использован для другого файла');
  }

  async function recoverUploadFile(file, expected, restartOnMismatch = false) {
    invariant(file?.id && (file.parents || []).includes(expected.folderId), 502, 'unsafe_drive_parent', 'Recovered Drive file находится вне task folder');
    invariant(normalizeId(file.appProperties?.elementsTaskPageId) === normalizeId(expected.taskId) &&
      file.appProperties?.elementsIdempotencyKey === expected.idempotencyKey,
    502, 'unsafe_drive_metadata', 'Recovered Drive file не привязан к операции');
    invariant(file.name === expected.name && file.mimeType === expected.mimeType &&
      file.appProperties?.elementsPayloadFingerprint === expected.payloadFingerprint &&
      file.appProperties?.elementsDeclaredSha256 === expected.sha256,
    409, 'idempotency_conflict', 'Idempotency-Key уже использован для другого upload payload');

    const metadataSize = Number(file.size);
    const verified = file.appProperties?.elementsVerified === 'v1' &&
      file.appProperties?.elementsVerifiedSha256 === expected.sha256 &&
      file.appProperties?.elementsVerifiedSize === String(expected.size) && metadataSize === expected.size;
    if (verified) return { file, sha256: expected.sha256 };

    let actualSize = 0;
    const hash = createHash('sha256');
    if (Number.isFinite(metadataSize) && metadataSize !== expected.size) {
      await drive.trashFile(file.id);
      if (restartOnMismatch) return null;
      throw new AppError(422, 'upload_recovery_size_mismatch', 'Recovered Drive file имеет другой размер; начните загрузку заново');
    }
    const source = await drive.downloadFile(file.id);
    invariant(source?.body, 502, 'drive_download_empty', 'Google Drive не вернул поток recovered file');
    let exceededSize = false;
    for await (const chunk of Readable.fromWeb(source.body)) {
      actualSize += chunk.length;
      if (actualSize > MAX_UPLOAD_BYTES || actualSize > expected.size) { exceededSize = true; break; }
      hash.update(chunk);
    }
    const actualSha256 = hash.digest('hex');
    if (exceededSize || actualSize !== expected.size || actualSha256 !== expected.sha256) {
      await drive.trashFile(file.id);
      if (restartOnMismatch) return null;
      throw new AppError(422, 'upload_recovery_checksum_mismatch', 'Recovered Drive file не прошёл SHA-256; начните загрузку заново');
    }
    const marked = await drive.markFileVerified({
      fileId: file.id,
      taskId: normalizeId(expected.taskId),
      idempotencyKey: expected.idempotencyKey,
      payloadFingerprint: expected.payloadFingerprint,
      sha256: actualSha256,
      size: actualSize
    });
    return { file: { ...file, ...marked }, sha256: actualSha256 };
  }

  async function createNativeFile(request, taskId) {
    await requireWrite(request, taskId);
    const task = await requireTask(request, taskId);
    const body = await readJson(request);
    const key = idempotencyKey(request, body);
    const kind = String(body.kind || '');
    invariant(['docs', 'sheets', 'slides'].includes(kind), 422, 'invalid_google_kind', 'Неизвестный Google-формат');
    const name = cleanName(body.name || ({ docs: 'Новый документ', sheets: 'Новая таблица', slides: 'Новая презентация' })[kind]);
    return onceMutation('native:' + normalizeId(taskId) + ':' + key, async () => {
      const existing = await records.findByIdempotency(taskId, key);
      if (existing) { assertNativeMatch(existing, { name, kind }); return existing; }
      const folder = await taskFolder(task, taskId);
      const recovered = await drive.findFileByIdempotency({ folderId: folder.id, taskId: normalizeId(taskId), idempotencyKey: key });
      const file = recovered || await drive.createNative({ name, kind, folderId: folder.id, taskId: normalizeId(taskId), idempotencyKey: key });
      const classified = classifyFile(file.name, file.mimeType);
      invariant((file.parents || []).includes(folder.id) && normalizeId(file.appProperties?.elementsTaskPageId) === normalizeId(taskId) &&
        file.appProperties?.elementsIdempotencyKey === key && file.name === name && classified.format === GOOGLE_KIND_FORMAT[kind],
      502, 'unsafe_native_file', 'Google Drive вернул native file вне ожидаемой операции');
      return await records.create(taskId, {
        name: file.name,
        section: classified.section,
        format: classified.format,
        provider: 'Google Drive',
        googleFileId: file.id,
        googleFolderId: folder.id,
        url: file.webViewLink,
        mimeType: file.mimeType,
        size: null,
        md5: '',
        sha256: '',
        idempotencyKey: key
      });
    });
  }

  async function addLink(request, taskId) {
    await requireWrite(request, taskId);
    await requireTask(request, taskId);
    const body = await readJson(request);
    const key = idempotencyKey(request, body);
    const url = normalizeExternalUrl(body.url);
    const section = SECTION_VALUES.has(body.section) ? body.section : 'Drive';
    const name = cleanName(body.name || new URL(url).hostname);
    const existing = await records.findByIdempotency(taskId, key);
    if (existing) { assertLinkMatch(existing, { name, section, url }); return existing; }
    return records.create(taskId, {
      name,
      section,
      format: 'Link',
      provider: 'External URL',
      googleFileId: '',
      googleFolderId: '',
      url,
      mimeType: 'text/uri-list',
      size: null,
      md5: '',
      sha256: '',
      idempotencyKey: key
    });
  }

  async function initiateUpload(request, taskId) {
    await requireWrite(request, taskId);
    const task = await requireTask(request, taskId);
    const body = await readJson(request);
    const key = idempotencyKey(request, body);
    const name = cleanName(body.name);
    const mimeType = String(body.mimeType || 'application/octet-stream').slice(0, 150);
    const size = Number(body.size);
    invariant(Number.isSafeInteger(size) && size >= 0 && size <= MAX_UPLOAD_BYTES, 422, 'invalid_upload_size', 'Файл превышает staging-лимит 512 МБ');
    const sha256 = String(body.sha256 || '').toLowerCase();
    invariant(/^[a-f0-9]{64}$/.test(sha256), 422, 'invalid_sha256', 'Для upload обязателен SHA-256');
    const payloadFingerprint = uploadFingerprint({ name, mimeType, size, sha256 });
    const operationKey = normalizeId(taskId) + ':' + key;
    const cached = uploadSessions.get(operationKey);
    if (cached && cached.expiresAt > Date.now()) {
      invariant(cached.name === name && cached.mimeType === mimeType && cached.size === size && cached.sha256 === sha256,
        409, 'idempotency_conflict', 'Idempotency-Key уже используется для другого файла');
      return cached.response;
    }
    return onceMutation('upload-init:' + operationKey, async () => {
      const existing = await records.findByIdempotency(taskId, key);
      if (existing) { assertUploadRecordMatch(existing, { name, mimeType, size, sha256 }); return { completed: true, record: existing }; }
      const folder = await taskFolder(task, taskId);
      const recovered = await drive.findFileByIdempotency({ folderId: folder.id, taskId: normalizeId(taskId), idempotencyKey: key });
      if (recovered) {
        const recovery = await recoverUploadFile(recovered, {
          taskId, folderId: folder.id, idempotencyKey: key, payloadFingerprint, name, mimeType, size, sha256
        }, true);
        if (!recovery) return initiateUploadSession();
        const safeFile = recovery.file;
        const classified = classifyFile(safeFile.name, safeFile.mimeType);
        const record = await records.create(taskId, {
          name: safeFile.name,
          section: classified.section,
          format: classified.format,
          provider: 'Google Drive',
          googleFileId: safeFile.id,
          googleFolderId: folder.id,
          url: safeFile.webViewLink || '',
          mimeType: safeFile.mimeType,
          size,
          md5: safeFile.md5Checksum || '',
          sha256: recovery.sha256,
          idempotencyKey: key
        });
        return { completed: true, record };
      }
      return initiateUploadSession();

      async function initiateUploadSession() {
        const classified = classifyFile(name, mimeType);
        const sessionUrl = await drive.initiateResumable({
          name, mimeType, size, folderId: folder.id, taskId: normalizeId(taskId), idempotencyKey: key, sha256, payloadFingerprint
        });
        const uploadId = randomUUID();
        const upload = {
          uploadId, sessionUrl, name, mimeType, size, sha256, payloadFingerprint,
          section: classified.section, format: classified.format, folderId: folder.id, idempotencyKey: key, taskId: normalizeId(taskId)
        };
        const uploadToken = signToken({ aud: 'upload', taskId: normalizeId(taskId), uploadId, idempotencyKey: key }, config.signingSecret, 3600);
        const response = { completed: false, uploadToken, expiresIn: 3600 };
        uploadSessions.set(operationKey, { response, upload, uploadId, name, mimeType, size, sha256, expiresAt: Date.now() + 3600_000 });
        return response;
      }
    });
  }

  async function completeUpload(request, taskId, uploadToken) {
    await requireWrite(request, taskId);
    await requireTask(request, taskId);
    const claims = verifyToken(uploadToken, config.signingSecret, { aud: 'upload', taskId });
    const operationKey = normalizeId(taskId) + ':' + claims.idempotencyKey;
    const session = uploadSessions.get(operationKey);
    invariant(session && session.expiresAt > Date.now() && session.uploadId === claims.uploadId,
      410, 'upload_session_expired', 'Сессия загрузки истекла; начните загрузку заново');
    const upload = session.upload;
    const inflightKey = 'upload-complete:' + operationKey;
    if (mutationInflight.has(inflightKey)) {
      request.resume();
      return mutationInflight.get(inflightKey);
    }
    return onceMutation(inflightKey, async () => {
      const existing = await records.findByIdempotency(taskId, upload.idempotencyKey);
      if (existing) {
        request.resume();
        assertUploadRecordMatch(existing, upload);
        return { record: existing, sha256: existing.sha256 };
      }
      const recovered = await drive.findFileByIdempotency({ folderId: upload.folderId, taskId: normalizeId(taskId), idempotencyKey: upload.idempotencyKey });
      if (recovered) {
        request.resume();
        let recovery;
        try { recovery = await recoverUploadFile(recovered, upload, false); }
        catch (error) {
          if (error?.code === 'upload_recovery_size_mismatch' || error?.code === 'upload_recovery_checksum_mismatch') uploadSessions.delete(operationKey);
          throw error;
        }
        const safeFile = recovery.file;
        const classified = classifyFile(safeFile.name, safeFile.mimeType);
        const record = await records.create(taskId, {
          name: safeFile.name,
          section: classified.section,
          format: classified.format,
          provider: 'Google Drive',
          googleFileId: safeFile.id,
          googleFolderId: upload.folderId,
          url: safeFile.webViewLink || '',
          mimeType: safeFile.mimeType,
          size: upload.size,
          md5: safeFile.md5Checksum || '',
          sha256: recovery.sha256,
          idempotencyKey: upload.idempotencyKey
        });
        uploadSessions.delete(operationKey);
        return { record, sha256: recovery.sha256 };
      }
      const length = Number(request.headers['content-length']);
      invariant(Number.isSafeInteger(length) && length === upload.size, 422, 'upload_size_mismatch', 'Content-Length не совпадает с объявленным размером');
      const hash = createHash('sha256');
      const tee = new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      const uploadAbort = new AbortController();
      const abortUpload = () => uploadAbort.abort();
      request.once('aborted', abortUpload);
      request.pipe(tee);
      let file;
      try {
        file = await drive.uploadSession(upload.sessionUrl, tee, upload.size, upload.mimeType,
          AbortSignal.any([uploadAbort.signal, AbortSignal.timeout(30 * 60 * 1000)]));
      } finally {
        request.removeListener('aborted', abortUpload);
      }
      const actualSha256 = hash.digest('hex');
      if (upload.sha256 && upload.sha256 !== actualSha256) {
        if (file.id) await drive.trashFile(file.id).catch(() => {});
        uploadSessions.delete(operationKey);
        throw new AppError(422, 'sha256_mismatch', 'Контрольная сумма загруженного файла не совпала');
      }
      invariant(file.id && (file.parents || []).includes(upload.folderId), 502, 'unsafe_drive_parent', 'Drive вернул файл вне task folder');
      invariant(normalizeId(file.appProperties?.elementsTaskPageId) === normalizeId(taskId), 502, 'unsafe_drive_metadata', 'Drive вернул файл без task binding');
      invariant(file.appProperties?.elementsIdempotencyKey === upload.idempotencyKey &&
        file.appProperties?.elementsPayloadFingerprint === upload.payloadFingerprint && file.name === upload.name && file.mimeType === upload.mimeType && Number(file.size) === upload.size,
      502, 'unsafe_drive_metadata', 'Drive вернул файл вне ожидаемой upload operation');
      await drive.markFileVerified({
        fileId: file.id,
        taskId: normalizeId(taskId),
        idempotencyKey: upload.idempotencyKey,
        payloadFingerprint: upload.payloadFingerprint,
        sha256: actualSha256,
        size: upload.size
      });
      const record = await records.create(taskId, {
        name: file.name || upload.name,
        section: upload.section,
        format: upload.format,
        provider: 'Google Drive',
        googleFileId: file.id,
        googleFolderId: upload.folderId,
        url: file.webViewLink || '',
        mimeType: file.mimeType || upload.mimeType,
        size: Number(file.size || upload.size),
        md5: file.md5Checksum || '',
        sha256: actualSha256,
        idempotencyKey: upload.idempotencyKey
      });
      uploadSessions.delete(operationKey);
      return { record, sha256: actualSha256 };
    });
  }

  async function patchRecord(request, taskId, recordId) {
    await requireWrite(request, taskId);
    await requireTask(request, taskId);
    const body = await readJson(request);
    const changes = {};
    if (body.name !== undefined) {
      changes.name = cleanName(body.name);
    }
    if (body.section !== undefined) {
      invariant(SECTION_VALUES.has(body.section), 422, 'invalid_section', 'Некорректный раздел');
      changes.section = body.section;
    }
    if (body.format !== undefined) {
      invariant(FORMAT_VALUES.has(body.format), 422, 'invalid_format', 'Некорректный формат');
      changes.format = body.format;
    }
    if (body.url !== undefined) changes.url = normalizeExternalUrl(body.url);
    const current = await records.getForTask(taskId, recordId);
    if (changes.url !== undefined) {
      invariant(current.provider === 'External URL', 422, 'not_external_link', 'Заменить URL можно только у внешней ссылки');
    }
    if (changes.name !== undefined && current.provider === 'Google Drive' && current.googleFileId) {
      await drive.renameFile(current.googleFileId, changes.name);
    }
    changes.syncedAt = new Date();
    return records.patch(taskId, recordId, changes);
  }

  async function reorder(request, taskId) {
    await requireWrite(request, taskId);
    await requireTask(request, taskId);
    const body = await readJson(request);
    invariant(Array.isArray(body.ids) && body.ids.length <= 500, 422, 'invalid_order', 'Некорректный порядок');
    const ids = body.ids.map(normalizeId);
    invariant(new Set(ids).size === ids.length, 422, 'duplicate_order_id', 'В порядке есть дубли');
    const current = await records.listForTask(taskId);
    const currentIds = new Set(current.map((item) => item.id));
    invariant(ids.length === current.length, 422, 'incomplete_order', 'Порядок должен содержать все активные карточки задачи');
    for (const id of ids) invariant(currentIds.has(id), 422, 'foreign_order_id', 'Порядок содержит чужую запись');
    const previousPositions = new Map(current.map((item) => [item.id, item.position]));
    const updated = [];
    try {
      for (let index = 0; index < ids.length; index += 1) {
        await records.patch(taskId, ids[index], { position: index + 1 });
        updated.push(ids[index]);
      }
    } catch (error) {
      await Promise.allSettled(updated.map((id) => records.patch(taskId, id, { position: previousPositions.get(id) })));
      throw error;
    }
    return records.listForTask(taskId);
  }

  async function recordAction(request, taskId, recordId, action) {
    await requireWrite(request, taskId);
    await requireTask(request, taskId);
    if (action === 'archive') return records.patch(taskId, recordId, { status: 'archived', archive: true, syncedAt: new Date() });
    if (action === 'unlink') return records.patch(taskId, recordId, { status: 'unlinked', type: null, taskId: null, syncedAt: new Date() });
    throw new AppError(404, 'unknown_action', 'Неизвестное действие');
  }

  async function deletionIntent(request, taskId, recordId) {
    await requireWrite(request, taskId);
    await requireTask(request, taskId);
    const record = await records.getForTask(taskId, recordId);
    invariant(record.provider === 'Google Drive' && record.googleFileId, 422, 'not_physical_file', 'У записи нет физического Google-файла');
    const file = await drive.getFile(record.googleFileId);
    invariant((file.parents || []).includes(record.googleFolderId), 403, 'unsafe_physical_delete', 'Файл находится вне task folder');
    invariant(normalizeId(file.appProperties?.elementsTaskPageId) === normalizeId(taskId), 403, 'unsafe_physical_delete', 'File ID не привязан к задаче');
    invariant(file.name === record.name, 409, 'file_name_out_of_sync', 'Имя файла ещё синхронизируется; повторите позже');
    const deleteToken = signToken({
      aud: 'delete', taskId: normalizeId(taskId), recordId: normalizeId(recordId),
      fileId: record.googleFileId, folderId: record.googleFolderId, name: record.name
    }, config.signingSecret, 60);
    return { deleteToken, expiresIn: 60, item: { id: record.id, name: record.name } };
  }

  async function physicalDelete(request, taskId, recordId) {
    await requireWrite(request, taskId);
    await requireTask(request, taskId);
    const deletion = verifyToken(String(request.headers['x-delete-token'] || ''), config.signingSecret, { aud: 'delete', taskId, recordId });
    const record = await records.getForTask(taskId, recordId);
    invariant(record.googleFileId === deletion.fileId && record.googleFolderId === deletion.folderId && record.name === deletion.name,
      409, 'delete_intent_stale', 'Файл изменился после подтверждения удаления');
    const file = await drive.getFile(record.googleFileId);
    invariant((file.parents || []).includes(record.googleFolderId), 403, 'unsafe_physical_delete', 'Файл находится вне task folder');
    invariant(normalizeId(file.appProperties?.elementsTaskPageId) === normalizeId(taskId), 403, 'unsafe_physical_delete', 'File ID не привязан к задаче');
    if (!file.trashed) await drive.trashFile(record.googleFileId);
    return records.patch(taskId, recordId, { status: 'deleted', type: null, archive: true, taskId: null, syncedAt: new Date() });
  }

  async function downloadLink(request, taskId, recordId) {
    await requireTask(request, taskId);
    const record = await records.getForTask(taskId, recordId);
    invariant(record.provider === 'Google Drive' && record.googleFileId, 422, 'not_downloadable', 'Запись не является загруженным файлом');
    invariant(!String(record.mimeType || '').startsWith('application/vnd.google-apps.'), 422, 'google_native_file', 'Google-native файл нужно открыть по ссылке');
    const token = signToken({ aud: 'download', taskId: normalizeId(taskId), recordId: normalizeId(recordId), fileId: record.googleFileId }, config.signingSecret, 60);
    return { url: config.publicBaseUrl.replace(/\/$/, '') + '/api/v1/download/' + normalizeId(recordId) + '?access=' + encodeURIComponent(token), expiresIn: 60 };
  }

  async function streamDownload(request, response, recordId, url) {
    const token = verifyToken(url.searchParams.get('access'), config.signingSecret, { aud: 'download', recordId });
    const task = await notion.retrievePage(token.taskId);
    assertSandboxTask(task, config.elementsDataSourceId);
    const record = await records.getForTask(token.taskId, recordId);
    invariant(record.googleFileId === token.fileId, 403, 'wrong_file', 'Download token не совпадает с File ID');
    const file = await drive.getFile(record.googleFileId);
    invariant((file.parents || []).includes(record.googleFolderId), 403, 'unsafe_download', 'Файл находится вне task folder');
    invariant(normalizeId(file.appProperties?.elementsTaskPageId) === record.taskId, 403, 'unsafe_download', 'Файл не привязан к задаче');
    const source = await drive.downloadFile(record.googleFileId);
    response.writeHead(200, {
      'Content-Type': source.headers.get('content-type') || record.mimeType || 'application/octet-stream',
      ...(source.headers.get('content-length') ? { 'Content-Length': source.headers.get('content-length') } : {}),
      'Content-Disposition': "attachment; filename*=UTF-8''" + safeFileNameForHeader(record.name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    Readable.fromWeb(source.body).pipe(response);
  }

  async function ensureWidgetEmbed(page) {
    if (pageParentDataSource(page) !== normalizeId(config.elementsDataSourceId)) return false;
    if (page.in_trash === true || page.archived === true || propertySelect(page.properties && page.properties[P.type]) !== 'Задача') return false;
    const children = await notion.listBlockChildren(page.id);
    const expectedBase = (config.widgetPublicUrl || config.publicBaseUrl).replace(/#.*$/, '');
    const widgetEmbeds = children.filter((block) => block.type === 'embed' && String(block.embed?.url || '').startsWith(expectedBase));
    const valid = widgetEmbeds.find((block) => validEmbedForTask(block.embed?.url, page.id, config));
    const keeper = valid || widgetEmbeds[0];
    if (keeper) {
      if (!valid) await notion.updateEmbedBlock(keeper.id, embedUrl(config, page.id));
      const duplicates = widgetEmbeds.filter((block) => block.id !== keeper.id);
      await Promise.all(duplicates.map((block) => notion.trashBlock(block.id)));
      return !valid || duplicates.length > 0;
    }
    await notion.appendBlockChildren(page.id, [{ object: 'block', type: 'embed', embed: { url: embedUrl(config, page.id) } }]);
    return true;
  }

  async function renewEmbeds() {
    await ensureWriteReady();
    const pages = await notion.queryDataSource(config.elementsDataSourceId, {
      filter: { property: P.type, select: { equals: 'Задача' } }
    });
    let changed = 0;
    for (const page of pages) {
      const didChange = await onceMutation('webhook:' + normalizeId(page.id), () => ensureWidgetEmbed(page));
      if (didChange) changed += 1;
    }
    return { scanned: pages.length, changed };
  }

  async function handleNotionWebhook(request, response) {
    const raw = await readBody(request);
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new AppError(400, 'invalid_json', 'Некорректный webhook JSON'); }
    if (event.verification_token) {
      logger.info('[notion-webhook] verification token received; store it in the secret manager');
      sendJson(response, 200, { ok: true });
      return;
    }
    verifyNotionWebhook(raw, request.headers['x-notion-signature'], config.notionWebhookVerificationToken);
    if (!['page.created', 'page.properties_updated', 'page.content_updated'].includes(event.type) || !event.entity?.id) {
      sendJson(response, 200, { ok: true });
      return;
    }
    await onceMutation('webhook:' + normalizeId(event.entity.id), async () => {
      const page = await notion.retrievePage(event.entity.id);
      if (pageParentDataSource(page) !== normalizeId(config.elementsDataSourceId) || page.in_trash === true || page.archived === true ||
        propertySelect(page.properties && page.properties[P.type]) !== 'Задача') return;
      await ensureWriteReady();
      await ensureWidgetEmbed(page);
    });
    sendJson(response, 200, { ok: true });
  }

  async function serveStatic(response, pathname) {
    const table = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8']
    };
    if (pathname === '/config.js') {
      const body = 'window.ELEMENTS_WIDGET_CONFIG=' + JSON.stringify({ apiBase: config.publicBaseUrl.replace(/\/$/, '') }) + ';';
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
      return true;
    }
    const item = table[pathname];
    if (!item) return false;
    const body = await readFile(join(frontendDir, item[0]));
    response.writeHead(200, {
      'Content-Type': item[1],
      'Content-Length': body.length,
      'Cache-Control': pathname === '/' || pathname === '/index.html' ? 'no-store' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors https://www.notion.so https://www.notion.site https://*.notion.site",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    response.end(body);
    return true;
  }

  async function handler(request, response) {
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(request.url, config.publicBaseUrl || 'http://localhost:' + config.port);
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/webhooks/notion') {
        if (await serveStatic(response, url.pathname)) return;
      }
      if (url.pathname.startsWith('/api/')) {
        applyApiCors(request, response, allowedOrigins);
        if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/healthz') {
        sendJson(response, 200, { ok: true, environment: config.appEnv, dryRun: config.dryRun, writeGate: config.writeGate, notionVersion: config.notionVersion });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/notion') {
        await handleNotionWebhook(request, response);
        return;
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'download' && parts[3] && request.method === 'GET') {
        await streamDownload(request, response, parts[3], url);
        return;
      }
      invariant(parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'tasks' && parts[3], 404, 'not_found', 'Маршрут не найден');
      const taskId = normalizeId(parts[3]);
      invariant(taskId.length === 32, 422, 'invalid_task_id', 'Некорректный task_page_id');
      if (parts[4] === 'files' && !parts[5] && request.method === 'GET') {
        await requireTask(request, taskId);
        sendJson(response, 200, { items: await records.listForTask(taskId) });
        return;
      }
      if (parts[4] === 'google-native' && request.method === 'POST') {
        sendJson(response, 201, { item: await createNativeFile(request, taskId) });
        return;
      }
      if (parts[4] === 'links' && request.method === 'POST') {
        sendJson(response, 201, { item: await addLink(request, taskId) });
        return;
      }
      if (parts[4] === 'uploads' && !parts[5] && request.method === 'POST') {
        sendJson(response, 200, await initiateUpload(request, taskId));
        return;
      }
      if (parts[4] === 'uploads' && !parts[5] && request.method === 'PUT') {
        const uploadToken = String(request.headers['x-upload-token'] || '');
        invariant(uploadToken, 401, 'missing_upload_token', 'Нет X-Upload-Token');
        sendJson(response, 201, await completeUpload(request, taskId, uploadToken));
        return;
      }
      if (parts[4] === 'order' && request.method === 'PATCH') {
        sendJson(response, 200, { items: await reorder(request, taskId) });
        return;
      }
      if (parts[4] === 'files' && parts[5] && !parts[6] && request.method === 'PATCH') {
        sendJson(response, 200, { item: await patchRecord(request, taskId, parts[5]) });
        return;
      }
      if (parts[4] === 'files' && parts[5] && parts[6] === 'download-link' && request.method === 'POST') {
        sendJson(response, 200, await downloadLink(request, taskId, parts[5]));
        return;
      }
      if (parts[4] === 'files' && parts[5] && ['archive', 'unlink'].includes(parts[6]) && request.method === 'POST') {
        sendJson(response, 200, { item: await recordAction(request, taskId, parts[5], parts[6]) });
        return;
      }
      if (parts[4] === 'files' && parts[5] && parts[6] === 'physical-delete-intent' && request.method === 'POST') {
        sendJson(response, 200, await deletionIntent(request, taskId, parts[5]));
        return;
      }
      if (parts[4] === 'files' && parts[5] && parts[6] === 'physical-delete' && request.method === 'POST') {
        sendJson(response, 200, { item: await physicalDelete(request, taskId, parts[5]) });
        return;
      }
      throw new AppError(404, 'not_found', 'Маршрут не найден');
    } catch (error) {
      const appError = asAppError(error);
      if (!response.headersSent) sendJson(response, appError.status, { error: { code: appError.code, message: appError.message, details: appError.details, requestId } });
      else response.destroy();
      if (appError.status >= 500) logger.error('[request]', { requestId, code: appError.code, message: error.message });
    }
  }

  return { handler, notion, drive, records, renewEmbeds };
}

function startEmbedRenewal(config, app, logger = console) {
  if (config.writeGate !== 'open' || config.dryRun) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { logger.info('[embed-renewal]', await app.renewEmbeds()); }
    catch (error) { logger.error('[embed-renewal] failed', { code: error.code, message: error.message }); }
    finally { running = false; }
  };
  const timer = setInterval(tick, config.embedRenewalMs);
  timer.unref();
  setTimeout(tick, 5000).unref();
  return () => clearInterval(timer);
}

export function startServer(config = loadConfig()) {
  const app = createApplication(config);
  const stopSync = startRenameSync(config, app.notion, app.drive, app.records);
  const stopRenewal = startEmbedRenewal(config, app);
  const server = createServer(app.handler);
  server.listen(config.port, () => console.info('[staging] listening on port ' + config.port));
  const close = () => { stopSync(); stopRenewal(); server.close(); };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) startServer();
