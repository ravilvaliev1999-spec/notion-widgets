import { AppError, invariant } from './errors.mjs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const STAGING_MARKER_FILE = '.elements-staging-boundary.json';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 30_000);
  return Math.min(500 * (2 ** attempt), 8000) + Math.floor(Math.random() * 250);
}

export const GOOGLE_MIME = Object.freeze({
  docs: 'application/vnd.google-apps.document',
  sheets: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation'
});

export class DriveClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.cachedToken = null;
    this.expiresAt = 0;
    this.tokenPromise = null;
  }

  async accessToken() {
    if (this.cachedToken && Date.now() < this.expiresAt - 60_000) return this.cachedToken;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.refreshAccessToken();
    try { return await this.tokenPromise; } finally { this.tokenPromise = null; }
  }

  async refreshAccessToken() {
    const form = new URLSearchParams({
      client_id: this.config.googleClientId,
      client_secret: this.config.googleClientSecret,
      refresh_token: this.config.googleRefreshToken,
      grant_type: 'refresh_token'
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response;
      try {
        response = await this.fetch(GOOGLE_TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
          signal: AbortSignal.timeout(15_000)
        });
      } catch (error) {
        if (attempt === 3) throw new AppError(502, 'google_oauth_error', 'Не удалось обновить Google OAuth');
        await wait(retryDelay(null, attempt));
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.access_token) {
        this.cachedToken = payload.access_token;
        this.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
        return this.cachedToken;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await wait(retryDelay(response, attempt));
        continue;
      }
      throw new AppError(502, 'google_oauth_error', 'Не удалось обновить Google OAuth', { googleError: payload.error });
    }
    throw new AppError(502, 'google_oauth_error', 'Не удалось обновить Google OAuth');
  }

  async assertStagingRoot({ folderId, expectedAccountEmail, expectedMarker }) {
    const about = await this.request(DRIVE_API + '/about?fields=' + encodeURIComponent('user(emailAddress,permissionId)'));
    invariant(String(about.user?.emailAddress || '').toLowerCase() === String(expectedAccountEmail || '').toLowerCase(),
      503, 'wrong_google_principal', 'Google OAuth принадлежит не ожидаемому staging-аккаунту');
    const fields = 'id,name,mimeType,trashed,parents,appProperties,owners(emailAddress),permissions(id,type,emailAddress,domain,role,allowFileDiscovery)';
    const root = await this.request(DRIVE_API + '/files/' + encodeURIComponent(folderId) + '?fields=' + encodeURIComponent(fields));
    invariant(root.id === folderId && root.mimeType === 'application/vnd.google-apps.folder' && root.trashed !== true,
      503, 'unsafe_drive_root', 'Staging Drive root отсутствует, удалён или не является папкой');
    invariant(Array.isArray(root.permissions), 503, 'drive_permissions_unverified', 'Google Drive не вернул permission metadata для staging root');
    const unsafePermission = (root.permissions || []).find((permission) => permission.type === 'anyone' || permission.type === 'domain');
    invariant(!unsafePermission, 503, 'public_drive_boundary', 'Staging Drive root имеет публичный или доменный доступ');
    let markerVerified = root.appProperties?.elementsStagingBoundary === expectedMarker;
    if (!markerVerified) {
      const safe = (value) => String(value || '').replace(/'/g, "\\'");
      const markerFiles = await this.request(DRIVE_API + '/files?' + new URLSearchParams({
        q: "'" + safe(folderId) + "' in parents and trashed = false and name = '" + safe(STAGING_MARKER_FILE) + "'",
        pageSize: '2',
        spaces: 'drive',
        fields: 'files(id,name,mimeType,size,parents)'
      }).toString());
      invariant(markerFiles.files?.length === 1, 503, 'drive_marker_missing', 'В staging Drive root нужен ровно один boundary marker');
      const markerFile = markerFiles.files[0];
      invariant(Number(markerFile.size || 0) > 0 && Number(markerFile.size) <= 4096 && !String(markerFile.mimeType || '').startsWith('application/vnd.google-apps.'),
        503, 'drive_marker_invalid', 'Boundary marker имеет недопустимый формат или размер');
      const markerResponse = await this.downloadFile(markerFile.id);
      const markerText = await markerResponse.text();
      let marker;
      try { marker = JSON.parse(markerText); } catch { marker = null; }
      markerVerified = marker?.schema === 1 && marker?.rootFolderId === folderId && marker?.marker === expectedMarker;
    }
    invariant(markerVerified, 503, 'drive_marker_mismatch', 'Маркер staging Drive root не совпал');
    return { root, principal: about.user };
  }

  async request(url, options = {}, responseMode = 'json') {
    const method = String(options.method || 'GET').toUpperCase();
    const retrySafe = options.retrySafe === true || method === 'GET' || method === 'PATCH';
    const { retrySafe: _retrySafe, ...fetchOptions } = options;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = await this.accessToken();
      let response;
      try {
        response = await this.fetch(url, {
          ...fetchOptions,
          signal: fetchOptions.signal || AbortSignal.timeout(30_000),
          headers: { Authorization: 'Bearer ' + token, ...(fetchOptions.headers || {}) }
        });
      } catch (error) {
        if (!retrySafe || attempt === 4) throw new AppError(502, 'drive_network_error', 'Google Drive API недоступен после повторных попыток');
        await wait(retryDelay(null, attempt));
        continue;
      }
      if (response.ok) {
        if (responseMode === 'response') return response;
        if (response.status === 204) return null;
        return response.json();
      }
      if (response.status === 401 && attempt < 4) {
        await response.arrayBuffer().catch(() => {});
        this.cachedToken = null;
        this.expiresAt = 0;
        await wait(100);
        continue;
      }
      if (retrySafe && (response.status === 429 || response.status >= 500) && attempt < 4) {
        await response.arrayBuffer().catch(() => {});
        await wait(retryDelay(response, attempt));
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      throw new AppError(response.status, 'drive_api_error', payload.error?.message || 'Ошибка Google Drive API');
    }
    throw new AppError(502, 'drive_api_error', 'Google Drive API недоступен');
  }

  createNative({ name, kind, folderId, taskId, idempotencyKey }) {
    const mimeType = GOOGLE_MIME[kind];
    invariant(mimeType, 422, 'invalid_google_kind', 'Поддерживаются только Docs, Sheets и Slides');
    const fields = 'id,name,mimeType,webViewLink,modifiedTime,size,md5Checksum,parents,appProperties';
    return this.request(DRIVE_API + '/files?fields=' + encodeURIComponent(fields), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType,
        parents: [folderId],
        appProperties: { elementsTaskPageId: taskId, elementsIdempotencyKey: idempotencyKey }
      })
    });
  }

  async findFileByIdempotency({ folderId, taskId, idempotencyKey }) {
    const safe = (value) => String(value || '').replace(/'/g, "\\'");
    const query = [
      "'" + safe(folderId) + "' in parents",
      'trashed = false',
      "appProperties has { key='elementsTaskPageId' and value='" + safe(taskId) + "' }",
      "appProperties has { key='elementsIdempotencyKey' and value='" + safe(idempotencyKey) + "' }"
    ].join(' and ');
    const result = await this.request(DRIVE_API + '/files?' + new URLSearchParams({
      q: query,
      pageSize: '2',
      spaces: 'drive',
      fields: 'files(id,name,mimeType,webViewLink,modifiedTime,size,md5Checksum,parents,appProperties)'
    }).toString());
    return result.files && result.files[0] ? result.files[0] : null;
  }

  async ensureTaskFolder(rootFolderId, taskId, taskName) {
    const safeTaskId = String(taskId).replace(/[^a-f0-9]/gi, '');
    const query = [
      "'" + rootFolderId.replace(/'/g, "\\'") + "' in parents",
      "mimeType = 'application/vnd.google-apps.folder'",
      'trashed = false',
      "appProperties has { key='elementsTaskPageId' and value='" + safeTaskId + "' }"
    ].join(' and ');
    const existing = await this.request(DRIVE_API + '/files?' + new URLSearchParams({
      q: query,
      pageSize: '2',
      spaces: 'drive',
      fields: 'files(id,name,parents,appProperties)'
    }).toString());
    if (existing.files && existing.files[0]) return existing.files[0];
    const label = String(taskName || 'Task').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80);
    return this.request(DRIVE_API + '/files?fields=' + encodeURIComponent('id,name,parents,appProperties'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: (label || 'Task') + ' — ' + safeTaskId.slice(-8),
        mimeType: 'application/vnd.google-apps.folder',
        parents: [rootFolderId],
        appProperties: { elementsTaskPageId: safeTaskId }
      })
    });
  }

  async initiateResumable({ name, mimeType, size, folderId, taskId, idempotencyKey, sha256, payloadFingerprint }) {
    const response = await this.request(DRIVE_UPLOAD + '/files?uploadType=resumable&fields=' + encodeURIComponent('id,name,mimeType,webViewLink,modifiedTime,size,md5Checksum,parents,appProperties'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(size)
      },
      body: JSON.stringify({
        name,
        mimeType,
        parents: [folderId],
        appProperties: {
          elementsTaskPageId: taskId,
          elementsIdempotencyKey: idempotencyKey,
          elementsDeclaredSha256: sha256,
          elementsPayloadFingerprint: payloadFingerprint
        }
      }),
      retrySafe: true
    }, 'response');
    const sessionUrl = response.headers.get('location');
    invariant(sessionUrl, 502, 'missing_upload_session', 'Google Drive не вернул resumable session');
    return sessionUrl;
  }

  markFileVerified({ fileId, taskId, idempotencyKey, payloadFingerprint, sha256, size }) {
    return this.request(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent('id,name,mimeType,webViewLink,modifiedTime,size,md5Checksum,parents,appProperties'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appProperties: {
          elementsTaskPageId: taskId,
          elementsIdempotencyKey: idempotencyKey,
          elementsPayloadFingerprint: payloadFingerprint,
          elementsDeclaredSha256: sha256,
          elementsVerifiedSha256: sha256,
          elementsVerifiedSize: String(size),
          elementsVerified: 'v1'
        }
      })
    });
  }

  async uploadSession(sessionUrl, stream, size, mimeType, signal) {
    const response = await this.fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(size), 'Content-Type': mimeType },
      body: stream,
      duplex: 'half',
      signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError(response.status, 'drive_upload_error', payload.error?.message || 'Загрузка в Google Drive не завершена');
    return payload;
  }

  getFile(fileId) {
    const fields = 'id,name,mimeType,webViewLink,modifiedTime,size,md5Checksum,trashed,parents,appProperties';
    return this.request(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent(fields));
  }

  renameFile(fileId, name) {
    return this.request(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent('id,name,modifiedTime'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  }

  deleteFile(fileId) {
    return this.request(DRIVE_API + '/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
  }

  trashFile(fileId) {
    return this.request(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent('id,trashed'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
  }

  downloadFile(fileId) {
    return this.request(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?alt=media', {}, 'response');
  }
}
