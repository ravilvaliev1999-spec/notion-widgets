(() => {
  'use strict';

  const DEPLOYMENT_URL = 'https://script.google.com/macros/s/AKfycbxrGUXhfRsvqjUrLSDFyhmjl3bJjbx-XtOjicHh7E7dAUVJW6Qi2F_K889ckvOCzu7KiQ/exec';
  const CREATE_COURIER_URL = 'https://ravilvaliev1999-spec.github.io/notion-widgets/create-courier.html';
  const SECTIONS = ['Drive', 'Docs', 'Sheets', 'Slides'];
  const widget = document.getElementById('widget');
  const interactionGrid = document.getElementById('interactionGrid');
  const snapshotGrid = document.getElementById('snapshotGrid');
  const fatal = document.getElementById('fatal');
  const createRequests = new Map();
  const SNAPSHOT_CACHE_SCHEMA = 1;
  const SNAPSHOT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const ACTION_CACHE_SCHEMA = 1;
  const ACTION_CACHE_MAX_TTL_MS = 2 * 60 * 1000;
  const ACTION_CACHE_USED_TTL_MS = 15 * 60 * 1000;
  const ACTION_CACHE_HOST = 'ravilvaliev1999-spec.github.io';
  const ACTION_DESCRIPTOR_V1_KEYS = ['section', 'reservationId', 'openUrl'];
  const ACTION_CACHE_V2_SCHEMA = 2;
  const ACTION_CACHE_V2_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const ACTION_CACHE_V2_USED_TTL_MS = 31 * 24 * 60 * 60 * 1000;
  const ACTION_DESCRIPTOR_V2_KEYS = ['section', 'reservationId', 'openUrl', 'generation', 'navigateUntil', 'reservationProof', 'preparedName'];
  const NAVIGATION_CACHE_SCHEMA = 2;
  const NAVIGATION_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const NAVIGATION_DIRECT_MAX_TTL_MS = 60 * 1000;
  const SNAPSHOT_CLASS = { Drive: 'gray', Docs: 'blue', Sheets: 'green', Slides: 'orange' };
  let earlyBridgeEvents = [];
  let earlyBridgeListener = null;
  let earlyClientId = '';
  const earlyEmbedNonce = (() => {
    try {
      const early = window.__notionWidgetEarlyBridge;
      const value = String(early && early.nonce || '').toLowerCase();
      if (/^[0-9a-f]{32}$/.test(value)) {
        earlyBridgeEvents = Array.isArray(early.events) ? early.events : [];
        earlyBridgeListener = typeof early.listener === 'function' ? early.listener : null;
        const candidateClientId = String(early.clientId || '');
        if (validClientId(candidateClientId)) earlyClientId = candidateClientId;
      }
      delete window.__notionWidgetEarlyBridge;
      return /^[0-9a-f]{32}$/.test(value) ? value : '';
    } catch (_error) {
      return '';
    }
  })();
  const embedNonce = earlyEmbedNonce || randomId().replace(/-/g, '');
  let bridge = null;
  let noticeTimer = 0;
  let geometryRequestId = 0;
  let latestGeometryResponseId = 0;
  let lastGeometryAckAt = 0;
  let snapshotMessageSeen = false;
  let snapshotCacheContextPromise = null;
  let lastRenderedSnapshotFingerprint = '';
  let lastPersistedSnapshotFingerprint = '';
  let snapshotPersistGeneration = 0;
  let snapshotCachePruned = false;
  let actionCacheContextPromise = null;
  let actionCacheContextValue = null;
  let actionCacheChannel = null;
  let actionCacheV2ContextPromise = null;
  let actionCacheV2ContextValue = null;
  let actionCacheV2Channel = null;
  let actionCacheGeneration = 0;
  let actionCacheFingerprint = '';
  let actionCacheFingerprintSchema = 0;
  let actionCachePruned = false;
  let cachedPreparedCreates = {};
  let cachedActionTrustedUntil = 0;
  const blockedActionDigests = new Map();
  const optimisticCreateCards = new Map();
  let confirmedSnapshotRows = [];
  let navigationCacheContextPromise = null;
  let navigationCacheContextValue = null;
  let navigationCacheEntries = new Map();
  let navigationCacheSnapshotFingerprint = '';
  let navigationCacheFolderUrl = '';
  let navigationCacheFolderExpiresAt = 0;
  let navigationCachePersistFingerprint = '';
  let navigationCacheWriteGeneration = 0;
  let navigationViewGeneration = 0;
  let navigationCachePruned = false;

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function validClientId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value || ''));
  }

  function stableClientId(task) {
    const slot = `notion-widget-client-v1:${task}`;
    let stored = '';
    try { stored = String(window.localStorage.getItem(slot) || ''); } catch (_error) {}
    const clientId = validClientId(stored) ? stored : validClientId(earlyClientId) ? earlyClientId : randomId();
    if (!validClientId(clientId)) return '';
    try { window.localStorage.setItem(slot, clientId); } catch (_error) {}
    return clientId;
  }

  function parseRuntimeParams() {
    if (location.hash.length <= 1) return null;
    const source = new URLSearchParams(location.hash.slice(1));
    const task = String(source.get('task') || source.get('taskPageId') || '').toLowerCase();
    const accessToken = String(source.get('accessToken') || '');
    const release = String(source.get('release') || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(task)) return null;
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(accessToken)) return null;
    if (release && !/^[A-Za-z0-9._-]{1,80}$/.test(release)) return null;
    const clientId = stableClientId(task);
    if (!clientId) return null;
    const allowed = new URLSearchParams({ task, accessToken, embedNonce, clientId });
    if (release) allowed.set('release', release);
    return allowed;
  }

  function safeSnapshotMaterials(value) {
    if (!Array.isArray(value) || value.length > 100) return null;
    const rows = [];
    for (const source of value) {
      const section = String(source && source.section || '');
      if (!SECTIONS.includes(section)) return null;
      const rawName = String(source && source.name || '').replace(/\s+/g, ' ').trim();
      const rawFormat = String(source && source.format || '').replace(/\s+/g, ' ').trim();
      const position = Number(source && source.position);
      const navigationBinding = String(source && source.navigationBinding || '').toLowerCase();
      if (!rawName || rawName.length > 180 || rawFormat.length > 100 || !Number.isFinite(position) || position < 0 || position > 10000 ||
          navigationBinding && !/^[a-f0-9]{64}$/.test(navigationBinding)) return null;
      const row = { name: rawName, section, format: rawFormat || 'Файл', position: Math.round(position) };
      if (navigationBinding) row.navigationBinding = navigationBinding;
      rows.push(row);
    }
    return rows.sort((left, right) => SECTIONS.indexOf(left.section) - SECTIONS.indexOf(right.section) || left.position - right.position || left.name.localeCompare(right.name) || String(left.navigationBinding || '').localeCompare(String(right.navigationBinding || '')));
  }

  function snapshotFingerprint(rows) {
    return JSON.stringify(rows);
  }

  function optimisticCreateFormat(section) {
    return section === 'Docs' ? 'Google Docs' : section === 'Sheets' ? 'Google Sheets' : 'Google Slides';
  }

  function renderSnapshotView(fingerprint) {
    if (!snapshotGrid) return false;
    window.__notionWidgetSnapshotRuntimeOwned = true;
    const pendingRows = Array.from(optimisticCreateCards.values()).map((entry) => ({
      name: entry.preparedName,
      section: entry.section,
      format: optimisticCreateFormat(entry.section),
      position: 10001,
      openUrl: entry.openUrl,
      navigateUntil: entry.navigateUntil,
      pending: true
    }));
    const rows = confirmedSnapshotRows.concat(pendingRows);
    const viewFingerprint = `${fingerprint || snapshotFingerprint(confirmedSnapshotRows)}\u0000${JSON.stringify(pendingRows)}\u0000${navigationViewGeneration}`;
    if (viewFingerprint === lastRenderedSnapshotFingerprint) return true;
    snapshotGrid.replaceChildren();
    SECTIONS.forEach((section) => {
      const sectionRows = rows.filter((row) => row.section === section);
      const column = document.createElement('section');
      column.className = 'snapshot-column';
      column.dataset.snapshotColumn = section;
      const sourceTop = document.querySelector(`[data-snapshot-section="${section}"]`);
      const sourceIcon = sourceTop && sourceTop.querySelector('.skeleton-icon');
      if (sourceTop) {
        const top = sourceTop.cloneNode(true);
        top.classList.add('snapshot-top');
        const count = top.querySelector('.skeleton-count');
        if (count) count.textContent = String(sectionRows.length);
        column.appendChild(top);
      }
      sectionRows.forEach((row) => {
        const navigationHref = row.pending ? optimisticCreateHref(row) : navigationHrefForRow(row);
        const card = document.createElement(navigationHref ? 'a' : 'article');
        card.className = `snapshot-card ${SNAPSHOT_CLASS[section]}${row.pending ? ' optimistic-create' : ''}`;
        if (navigationHref) {
          card.href = navigationHref;
          card.target = '_blank';
          card.rel = 'noopener noreferrer';
          card.referrerPolicy = 'no-referrer';
          card.setAttribute('aria-label', `Открыть ${row.name}`);
          const refreshNavigation = () => {
            const current = row.pending ? optimisticCreateHref(row) : navigationHrefForRow(row);
            if (current) card.href = current;
            else card.removeAttribute('href');
            return current;
          };
          card.addEventListener('pointerdown', refreshNavigation);
          card.addEventListener('click', (event) => { if (!refreshNavigation()) event.preventDefault(); });
          card.addEventListener('auxclick', (event) => { if (event.button === 1 && !refreshNavigation()) event.preventDefault(); });
        }
        if (row.pending) {
          card.setAttribute('aria-busy', 'true');
          card.setAttribute('aria-label', `${row.name}. Создаётся`);
        }
        if (sourceIcon) card.appendChild(sourceIcon.cloneNode(true));
        const meta = document.createElement('span');
        meta.className = 'skeleton-meta';
        const title = document.createElement('span');
        title.className = 'skeleton-title';
        title.textContent = row.name;
        const sub = document.createElement('span');
        sub.className = 'skeleton-sub';
        sub.textContent = row.pending ? `${row.format} · Создаётся…` : row.format;
        meta.append(title, sub);
        card.appendChild(meta);
        column.appendChild(card);
      });
      snapshotGrid.appendChild(column);
    });
    lastRenderedSnapshotFingerprint = viewFingerprint;
    document.body.classList.add('snapshot-ready');
    snapshotGrid.hidden = false;
    if (cachedPrimaryActionsUsable()) scheduleCachedPrimaryGeometry();
    return true;
  }

  function renderSafeSnapshotMaterials(rows, fingerprint) {
    confirmedSnapshotRows = rows.map((row) => Object.assign({}, row));
    return renderSnapshotView(fingerprint || snapshotFingerprint(rows));
  }

  function addOptimisticCreate(record) {
    if (!record || record.cacheSchema !== ACTION_CACHE_V2_SCHEMA || !validPreparedName(record.preparedName) ||
        safeSavedGoogleOpenUrl(record.href, record.section) !== record.href || !Number.isFinite(parseCanonicalNavigateUntil(record.navigateUntil))) return false;
    if (!optimisticCreateCards.has(record.requestId)) {
      optimisticCreateCards.set(record.requestId, { section: record.section, preparedName: record.preparedName, openUrl: record.href, navigateUntil: record.navigateUntil });
      renderSnapshotView(snapshotFingerprint(confirmedSnapshotRows));
    }
    return true;
  }

  function removeOptimisticCreate(requestId) {
    const removed = optimisticCreateCards.delete(String(requestId || '').toLowerCase());
    if (removed) renderSnapshotView(snapshotFingerprint(confirmedSnapshotRows));
    return removed;
  }

  function renderSnapshotMaterials(value) {
    const rows = safeSnapshotMaterials(value);
    return rows ? renderSafeSnapshotMaterials(rows, snapshotFingerprint(rows)) : false;
  }

  function snapshotCacheStore() {
    try {
      const store = window.localStorage;
      if (!snapshotCachePruned) {
        snapshotCachePruned = true;
        pruneExpiredSnapshotEnvelopes(store);
      }
      return store;
    } catch (_error) { return null; }
  }

  function pruneExpiredSnapshotEnvelopes(store) {
    if (!store || !Number.isSafeInteger(Number(store.length)) || typeof store.key !== 'function') return;
    const now = Date.now();
    for (let index = Number(store.length) - 1; index >= 0; index -= 1) {
      const key = String(store.key(index) || '');
      if (!key.startsWith('notion-widget-preview-v1:')) continue;
      let envelope = null;
      try { envelope = JSON.parse(String(store.getItem(key) || '')); } catch (_error) {}
      const savedAt = Number(envelope && envelope.savedAt);
      if (!envelope || envelope.schema !== SNAPSHOT_CACHE_SCHEMA || !Number.isFinite(savedAt) || now - savedAt < -60000 || now - savedAt > SNAPSHOT_CACHE_MAX_AGE_MS) {
        try { store.removeItem(key); } catch (_removeError) {}
      }
    }
  }

  function bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const source = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,100000}$/.test(source)) throw new Error('INVALID_SNAPSHOT_ENCODING');
    const padded = source.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - source.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function snapshotCacheContext() {
    if (snapshotCacheContextPromise) return snapshotCacheContextPromise;
    snapshotCacheContextPromise = (async () => {
      if (!window.crypto || !window.crypto.subtle || !params) return null;
      const task = params.get('task');
      const token = params.get('accessToken');
      const release = params.get('release') || '';
      if (!task || !token) return null;
      const encoder = new TextEncoder();
      const keyDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-preview-key-v1\u0000${task}\u0000${token}`)));
      const slotDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-preview-slot-v1\u0000${task}\u0000${token}`)));
      const key = await window.crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      return { key, slot: `notion-widget-preview-v1:${bytesToBase64Url(slotDigest.slice(0, 18))}`, aad: encoder.encode(`notion-widget-preview-v1\u0000${task}\u0000${release}`) };
    })().catch(() => null);
    return snapshotCacheContextPromise;
  }

  async function persistSafeSnapshotMaterials(rows, fingerprint, generation) {
    const store = snapshotCacheStore();
    const context = await snapshotCacheContext();
    if (!store || !context || generation !== snapshotPersistGeneration) return false;
    try {
      const iv = new Uint8Array(12);
      window.crypto.getRandomValues(iv);
      const savedAt = Date.now();
      const plaintext = new TextEncoder().encode(JSON.stringify({ schema: SNAPSHOT_CACHE_SCHEMA, savedAt, materials: rows }));
      const ciphertext = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, plaintext));
      if (generation !== snapshotPersistGeneration || fingerprint !== lastPersistedSnapshotFingerprint) return false;
      store.setItem(context.slot, JSON.stringify({ schema: SNAPSHOT_CACHE_SCHEMA, savedAt, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) }));
      return true;
    } catch (_error) {
      if (generation === snapshotPersistGeneration && fingerprint === lastPersistedSnapshotFingerprint) lastPersistedSnapshotFingerprint = '';
      return false;
    }
  }

  function persistSafeSnapshotSoon(rows, fingerprint) {
    if (fingerprint === lastPersistedSnapshotFingerprint) return false;
    lastPersistedSnapshotFingerprint = fingerprint;
    const generation = ++snapshotPersistGeneration;
    persistSafeSnapshotMaterials(rows, fingerprint, generation);
    return true;
  }

  async function restoreSnapshotMaterials() {
    const store = snapshotCacheStore();
    const context = await snapshotCacheContext();
    if (!store || !context || snapshotMessageSeen) return false;
    let raw = '';
    try { raw = String(store.getItem(context.slot) || ''); } catch (_error) { return false; }
    if (!raw || raw.length > 100000) return false;
    try {
      const envelope = JSON.parse(raw);
      if (!envelope || envelope.schema !== SNAPSHOT_CACHE_SCHEMA) throw new Error('INVALID_SNAPSHOT_SCHEMA');
      const envelopeSavedAt = Number(envelope.savedAt);
      if (!Number.isFinite(envelopeSavedAt) || Date.now() - envelopeSavedAt < -60000 || Date.now() - envelopeSavedAt > SNAPSHOT_CACHE_MAX_AGE_MS) throw new Error('STALE_SNAPSHOT');
      const iv = base64UrlToBytes(envelope.iv);
      const ciphertext = base64UrlToBytes(envelope.ciphertext);
      if (iv.length !== 12 || ciphertext.length > 75000) throw new Error('INVALID_SNAPSHOT_SIZE');
      const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, ciphertext);
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      const savedAt = Number(payload && payload.savedAt);
      if (!payload || payload.schema !== SNAPSHOT_CACHE_SCHEMA || savedAt !== envelopeSavedAt || !Number.isFinite(savedAt) || Date.now() - savedAt < -60000 || Date.now() - savedAt > SNAPSHOT_CACHE_MAX_AGE_MS) throw new Error('STALE_SNAPSHOT');
      const rows = safeSnapshotMaterials(payload.materials);
      if (!rows || snapshotMessageSeen) return false;
      return renderSafeSnapshotMaterials(rows, snapshotFingerprint(rows));
    } catch (_error) {
      try { store.removeItem(context.slot); } catch (_removeError) {}
      return false;
    }
  }

  function acceptSnapshotMaterials(value, render) {
    const rows = safeSnapshotMaterials(value);
    if (!rows) return false;
    snapshotMessageSeen = true;
    const fingerprint = snapshotFingerprint(rows);
    if (render !== false) renderSafeSnapshotMaterials(rows, fingerprint);
    persistSafeSnapshotSoon(rows, fingerprint);
    return true;
  }

  function hasExactObjectKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = expected.slice().sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  }

  function navigationCardKey(row) {
    return JSON.stringify([String(row && row.navigationBinding || ''), String(row && row.name || ''), String(row && row.section || ''), String(row && row.format || ''), Number(row && row.position)]);
  }

  function navigationRowFromKey(value) {
    try {
      const tuple = JSON.parse(String(value || ''));
      if (!Array.isArray(tuple) || tuple.length !== 5 || !/^[a-f0-9]{64}$/.test(String(tuple[0] || ''))) return null;
      const rows = safeSnapshotMaterials([{ navigationBinding: tuple[0], name: tuple[1], section: tuple[2], format: tuple[3], position: tuple[4] }]);
      return rows && rows.length === 1 && navigationCardKey(rows[0]) === value ? rows[0] : null;
    } catch (_error) { return null; }
  }

  function safeSavedGoogleOpenUrl(value, section) {
    const raw = String(value || '');
    const segment = section === 'Docs' ? 'document' : section === 'Sheets' ? 'spreadsheets' : section === 'Slides' ? 'presentation' : '';
    if (!segment) return '';
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && url.hostname === 'docs.google.com' && !url.port && !url.username && !url.password &&
        !url.search && !url.hash && raw === url.href && new RegExp(`^/${segment}/d/[A-Za-z0-9_-]{10,200}/edit$`).test(url.pathname) ? raw : '';
    } catch (_error) { return ''; }
  }

  function safeDirectDriveDownloadUrl(value) {
    const raw = String(value || '');
    if (!raw || raw.length > 900) return '';
    try {
      const url = new URL(raw), entries = Array.from(url.searchParams.entries()), keys = entries.map(([key]) => key);
      return url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.port && !url.username && !url.password &&
        url.pathname === '/uc' && !url.hash && raw === url.href && entries.length === 3 && new Set(keys).size === 3 &&
        keys.join('|') === 'export|authuser|id' && url.searchParams.get('export') === 'download' &&
        /^[^\s@]{1,64}@[^\s@]{1,189}$/.test(url.searchParams.get('authuser') || '') &&
        /^[A-Za-z0-9_-]{10,200}$/.test(url.searchParams.get('id') || '') ? raw : '';
    } catch (_error) { return ''; }
  }

  function safeNavigationMaterials(value, snapshotRows, now) {
    if (!Array.isArray(value) || value.length > 100) return null;
    const allowed = new Set(snapshotRows.map(navigationCardKey)), seen = new Set(), entries = [];
    for (const source of value) {
      const google = hasExactObjectKeys(source, ['name', 'section', 'format', 'position', 'navigationBinding', 'openUrl']);
      const direct = hasExactObjectKeys(source, ['name', 'section', 'format', 'position', 'navigationBinding', 'directDownloadUrl', 'directDownloadExpiresAt']);
      if (google === direct) return null;
      const presentation = safeSnapshotMaterials([{ navigationBinding: source.navigationBinding, name: source.name, section: source.section, format: source.format, position: source.position }]);
      if (!presentation || presentation.length !== 1) return null;
      const row = presentation[0], cardKey = navigationCardKey(row);
      if (source.name !== row.name || source.section !== row.section || source.format !== row.format ||
          source.navigationBinding !== row.navigationBinding || !/^[a-f0-9]{64}$/.test(row.navigationBinding) ||
          typeof source.position !== 'number' || !Number.isSafeInteger(source.position) || source.position !== row.position) return null;
      if (!allowed.has(cardKey) || seen.has(cardKey)) return null;
      seen.add(cardKey);
      if (google) {
        const url = safeSavedGoogleOpenUrl(source.openUrl, row.section);
        if (!url) return null;
        entries.push({ cardKey, kind: 'google', url, expiresAt: Number(now) + NAVIGATION_CACHE_MAX_AGE_MS });
      } else {
        const url = safeDirectDriveDownloadUrl(source.directDownloadUrl);
        const expiresAt = parseCanonicalNavigateUntil(source.directDownloadExpiresAt);
        if (!url || !Number.isFinite(expiresAt) || expiresAt <= Number(now) + 1000 || expiresAt - Number(now) > NAVIGATION_DIRECT_MAX_TTL_MS) return null;
        entries.push({ cardKey, kind: 'direct', url, expiresAt });
      }
    }
    return entries;
  }

  function validNavigationCacheTimes(savedAt, expiresAt, now) {
    const saved = Number(savedAt), expires = Number(expiresAt), current = Number(now);
    return Number.isSafeInteger(saved) && Number.isSafeInteger(expires) && Number.isFinite(current) &&
      saved <= current + 5000 && current - saved <= NAVIGATION_CACHE_MAX_AGE_MS && expires > current &&
      expires > saved && expires - saved <= NAVIGATION_CACHE_MAX_AGE_MS;
  }

  function navigationCacheStore() {
    try {
      const store = window.localStorage;
      if (!navigationCachePruned && Number.isSafeInteger(Number(store.length)) && typeof store.key === 'function') {
        navigationCachePruned = true;
        const now = Date.now();
        for (let index = Number(store.length) - 1; index >= 0; index -= 1) {
          const key = String(store.key(index) || '');
          if (key.startsWith('notion-widget-navigation-v1:')) { try { store.removeItem(key); } catch (_removeLegacyError) {} continue; }
          if (!key.startsWith('notion-widget-navigation-v2:')) continue;
          let envelope = null;
          try { envelope = JSON.parse(String(store.getItem(key) || '')); } catch (_error) {}
          if (!hasExactObjectKeys(envelope, ['schema', 'savedAt', 'expiresAt', 'iv', 'ciphertext']) ||
              envelope.schema !== NAVIGATION_CACHE_SCHEMA || !validNavigationCacheTimes(envelope.savedAt, envelope.expiresAt, now)) {
            try { store.removeItem(key); } catch (_removeError) {}
          }
        }
      }
      return store;
    } catch (_error) { return null; }
  }

  function navigationCacheContext() {
    if (navigationCacheContextPromise) return navigationCacheContextPromise;
    navigationCacheContextPromise = (async () => {
      const host = actionCachePublicHost();
      if (!host || !window.crypto || !window.crypto.subtle || !params) return null;
      const task = String(params.get('task') || ''), token = String(params.get('accessToken') || ''), clientId = String(params.get('clientId') || '');
      if (!task || !token || !validClientId(clientId)) return null;
      const encoder = new TextEncoder(), domain = `${host}\u0000${task}\u0000${token}\u0000${clientId}`;
      const keyDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-navigation-key-v2\u0000${domain}`)));
      const slotDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-navigation-slot-v2\u0000${domain}`)));
      const key = await window.crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const context = {
        key, host, task, clientId,
        slot: `notion-widget-navigation-v2:${bytesToBase64Url(slotDigest.slice(0, 18))}`,
        aad: encoder.encode(`notion-widget-navigation-v2\u0000${domain}`)
      };
      navigationCacheContextValue = context;
      return context;
    })().catch(() => null);
    return navigationCacheContextPromise;
  }

  function navigationHrefForRow(row) {
    if (!row || navigationCacheSnapshotFingerprint !== snapshotFingerprint(confirmedSnapshotRows)) return '';
    const entry = navigationCacheEntries.get(navigationCardKey(row));
    if (!entry || entry.expiresAt <= Date.now() + (entry.kind === 'direct' ? 1000 : 0)) return '';
    return entry.kind === 'google' ? safeSavedGoogleOpenUrl(entry.url, row.section) : safeDirectDriveDownloadUrl(entry.url);
  }

  function optimisticCreateHref(row) {
    const navigateUntil = parseCanonicalNavigateUntil(row && row.navigateUntil);
    const openUrl = safeSavedGoogleOpenUrl(row && row.openUrl, row && row.section);
    return Number.isFinite(navigateUntil) && navigateUntil > Date.now() && openUrl ? openUrl : '';
  }

  function cachedNavigationFolderHref() {
    return navigationCacheFolderExpiresAt > Date.now() ? allowedDriveFolderUrl(navigationCacheFolderUrl) : '';
  }

  function activateNavigationCache(entries, snapshotValue, folderUrl, folderExpiresAt) {
    navigationCacheEntries = new Map(entries.map((entry) => [entry.cardKey, entry]));
    navigationCacheSnapshotFingerprint = String(snapshotValue || '');
    navigationCacheFolderUrl = String(folderUrl || '');
    navigationCacheFolderExpiresAt = Number(folderExpiresAt) || 0;
    navigationViewGeneration += 1;
    if (document.body.classList.contains('snapshot-ready')) renderSnapshotView(snapshotFingerprint(confirmedSnapshotRows));
    refreshAllControlHrefs();
  }

  function clearNavigationCacheState() {
    navigationCacheEntries = new Map();
    navigationCacheSnapshotFingerprint = '';
    navigationCacheFolderUrl = '';
    navigationCacheFolderExpiresAt = 0;
    navigationCachePersistFingerprint = '';
    navigationViewGeneration += 1;
    if (document.body.classList.contains('snapshot-ready')) renderSnapshotView(snapshotFingerprint(confirmedSnapshotRows));
    refreshAllControlHrefs();
  }

  function invalidateNavigationCache() {
    const store = navigationCacheStore(), context = navigationCacheContextValue;
    navigationCacheWriteGeneration += 1;
    if (store && context) { try { store.removeItem(context.slot); } catch (_error) {} }
    else if (store) navigationCacheContext().then((resolved) => { if (resolved) { try { store.removeItem(resolved.slot); } catch (_error) {} } });
    clearNavigationCacheState();
  }

  function safeCachedNavigationEntry(value, payload, now) {
    if (!hasExactObjectKeys(value, ['cardKey', 'kind', 'url', 'expiresAt']) || !['google', 'direct'].includes(value.kind)) return null;
    const row = navigationRowFromKey(value.cardKey), expiresAt = Number(value.expiresAt);
    if (!row || !Number.isSafeInteger(expiresAt) || expiresAt <= Number(payload.savedAt) || expiresAt > Number(payload.savedAt) + NAVIGATION_CACHE_MAX_AGE_MS) return null;
    if (value.kind === 'google') {
      const url = safeSavedGoogleOpenUrl(value.url, row.section);
      return url ? { cardKey: value.cardKey, kind: value.kind, url, expiresAt } : null;
    }
    const url = safeDirectDriveDownloadUrl(value.url);
    if (!url || expiresAt - Number(payload.savedAt) > NAVIGATION_DIRECT_MAX_TTL_MS) return null;
    return expiresAt > Number(now) + 1000 ? { cardKey: value.cardKey, kind: value.kind, url, expiresAt } : false;
  }

  async function restoreNavigationCache() {
    const generation = ++navigationCacheWriteGeneration, store = navigationCacheStore(), context = await navigationCacheContext();
    if (!store || !context || generation !== navigationCacheWriteGeneration) return false;
    let raw = '';
    try { raw = String(store.getItem(context.slot) || ''); } catch (_error) { return false; }
    if (!raw || raw.length > 100000) return false;
    try {
      const envelope = JSON.parse(raw);
      if (!hasExactObjectKeys(envelope, ['schema', 'savedAt', 'expiresAt', 'iv', 'ciphertext']) || envelope.schema !== NAVIGATION_CACHE_SCHEMA ||
          !validNavigationCacheTimes(envelope.savedAt, envelope.expiresAt, Date.now())) throw new Error('INVALID_NAVIGATION_ENVELOPE');
      const iv = base64UrlToBytes(envelope.iv), ciphertext = base64UrlToBytes(envelope.ciphertext);
      if (iv.length !== 12 || ciphertext.length > 75000) throw new Error('INVALID_NAVIGATION_SIZE');
      const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, ciphertext);
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      if (!hasExactObjectKeys(payload, ['schema', 'host', 'task', 'clientId', 'savedAt', 'expiresAt', 'snapshotFingerprint', 'folderUrl', 'folderExpiresAt', 'entries']) ||
          payload.schema !== NAVIGATION_CACHE_SCHEMA || payload.host !== context.host || payload.task !== context.task || payload.clientId !== context.clientId ||
          payload.savedAt !== envelope.savedAt || payload.expiresAt !== envelope.expiresAt || !validNavigationCacheTimes(payload.savedAt, payload.expiresAt, Date.now()) ||
          typeof payload.snapshotFingerprint !== 'string' || payload.snapshotFingerprint.length > 50000 || !Array.isArray(payload.entries) || payload.entries.length > 100) {
        throw new Error('INVALID_NAVIGATION_PAYLOAD');
      }
      const folderUrl = payload.folderUrl ? allowedDriveFolderUrl(payload.folderUrl) : '';
      const folderExpiresAt = Number(payload.folderExpiresAt);
      if ((payload.folderUrl && !folderUrl) || (!folderUrl && folderExpiresAt !== 0) || (folderUrl && (!Number.isSafeInteger(folderExpiresAt) || folderExpiresAt <= Date.now() || folderExpiresAt > Number(payload.savedAt) + NAVIGATION_CACHE_MAX_AGE_MS))) {
        throw new Error('INVALID_NAVIGATION_FOLDER');
      }
      const entries = [], seen = new Set(), allExpiries = folderUrl ? [folderExpiresAt] : [];
      for (const row of payload.entries) {
        const safe = safeCachedNavigationEntry(row, payload, Date.now());
        if (safe === null || seen.has(row.cardKey)) throw new Error('INVALID_NAVIGATION_ENTRY');
        seen.add(row.cardKey);allExpiries.push(Number(row.expiresAt));if (safe) entries.push(safe);
      }
      if (!allExpiries.length || Math.max(...allExpiries) !== Number(payload.expiresAt)) throw new Error('INVALID_NAVIGATION_EXPIRY');
      if (generation !== navigationCacheWriteGeneration) return false;
      navigationCachePersistFingerprint = JSON.stringify({ snapshotFingerprint: payload.snapshotFingerprint, folderUrl, folderExpiresAt, entries: payload.entries });
      activateNavigationCache(entries, payload.snapshotFingerprint, folderUrl, folderExpiresAt);
      return true;
    } catch (_error) {
      if (generation === navigationCacheWriteGeneration) { try { store.removeItem(context.slot); } catch (_removeError) {} }
      return false;
    }
  }

  async function persistNavigationCache(value, folderValue, snapshotValue) {
    const generation = ++navigationCacheWriteGeneration, store = navigationCacheStore(), context = await navigationCacheContext();
    if (!store || !context || generation !== navigationCacheWriteGeneration) return false;
    const now = Date.now(), snapshotRows = safeSnapshotMaterials(snapshotValue), folderUrl = folderValue ? allowedDriveFolderUrl(folderValue) : '';
    const entries = snapshotRows && safeNavigationMaterials(value, snapshotRows, now);
    if (!snapshotRows || !entries || (folderValue && !folderUrl)) { invalidateNavigationCache(); return false; }
    const folderExpiresAt = folderUrl ? now + NAVIGATION_CACHE_MAX_AGE_MS : 0;
    const expiries = entries.map((entry) => entry.expiresAt).concat(folderUrl ? [folderExpiresAt] : []);
    if (!expiries.length) { invalidateNavigationCache(); return false; }
    const expiresAt = Math.max(...expiries), snapshotValueFingerprint = snapshotFingerprint(snapshotRows);
    const fingerprint = JSON.stringify({ snapshotFingerprint: snapshotValueFingerprint, folderUrl, folderExpiresAt, entries });
    activateNavigationCache(entries, snapshotValueFingerprint, folderUrl, folderExpiresAt);
    if (fingerprint === navigationCachePersistFingerprint) return true;
    navigationCachePersistFingerprint = fingerprint;
    try {
      const iv = new Uint8Array(12);window.crypto.getRandomValues(iv);
      const payload = { schema: NAVIGATION_CACHE_SCHEMA, host: context.host, task: context.task, clientId: context.clientId, savedAt: now, expiresAt, snapshotFingerprint: snapshotValueFingerprint, folderUrl, folderExpiresAt, entries };
      const ciphertext = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, new TextEncoder().encode(JSON.stringify(payload))));
      if (generation !== navigationCacheWriteGeneration || fingerprint !== navigationCachePersistFingerprint) return false;
      store.setItem(context.slot, JSON.stringify({ schema: NAVIGATION_CACHE_SCHEMA, savedAt: now, expiresAt, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) }));
      return true;
    } catch (_error) {
      if (generation === navigationCacheWriteGeneration && fingerprint === navigationCachePersistFingerprint) navigationCachePersistFingerprint = '';
      return false;
    }
  }

  function handleNavigationCacheStorage(event) {
    const context = navigationCacheContextValue;
    if (!context || !event || event.key !== context.slot) return;
    if (!event.newValue) clearNavigationCacheState();
    else restoreNavigationCache();
  }

  function actionCachePublicHost() {
    try {
      return String(location.protocol || '').toLowerCase() === 'https:' && !String(location.port || '') &&
        String(location.hostname || '').toLowerCase() === ACTION_CACHE_HOST ? ACTION_CACHE_HOST : '';
    } catch (_error) { return ''; }
  }

  function actionCacheStore() {
    try {
      const store = window.localStorage;
      if (!actionCachePruned) {
        actionCachePruned = true;
        pruneExpiredActionCacheEntries(store);
      }
      return store;
    } catch (_error) { return null; }
  }

  function validActionCacheTimes(savedAt, trustedUntil, now) {
    const saved = Number(savedAt), trusted = Number(trustedUntil), current = Number(now);
    return Number.isSafeInteger(saved) && Number.isSafeInteger(trusted) && Number.isFinite(current) &&
      saved <= current + 5000 && current - saved <= ACTION_CACHE_MAX_TTL_MS && trusted > current &&
      trusted > saved && trusted - saved <= ACTION_CACHE_MAX_TTL_MS;
  }

  function parseActionTrustedUntil(value) {
    const source = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source)) return NaN;
    return Date.parse(source);
  }

  function validActionDigest(value) {
    return /^[A-Za-z0-9_-]{43}$/.test(String(value || ''));
  }

  function safeUsedActionEntries(value, now) {
    if (!hasExactObjectKeys(value, ['schema', 'updatedAt', 'entries']) || value.schema !== ACTION_CACHE_SCHEMA ||
        !Number.isSafeInteger(Number(value.updatedAt)) || !Array.isArray(value.entries) || value.entries.length > 12) return [];
    const current = Number(now), unique = new Map();
    value.entries.forEach((entry) => {
      if (!hasExactObjectKeys(entry, ['digest', 'expiresAt'])) return;
      const digest = String(entry.digest || ''), expiresAt = Number(entry.expiresAt);
      if (!validActionDigest(digest) || !Number.isSafeInteger(expiresAt) || expiresAt <= current ||
          expiresAt > current + ACTION_CACHE_USED_TTL_MS + 60000) return;
      unique.set(digest, expiresAt);
    });
    return Array.from(unique, ([digest, expiresAt]) => ({ digest, expiresAt })).slice(-12);
  }

  function safeUsedActionEntriesV2(value, now) {
    if (!hasExactObjectKeys(value, ['schema', 'updatedAt', 'entries']) || value.schema !== ACTION_CACHE_V2_SCHEMA ||
        !Number.isSafeInteger(Number(value.updatedAt)) || !Array.isArray(value.entries) || value.entries.length > 12) return [];
    const current = Number(now), unique = new Map();
    value.entries.forEach((entry) => {
      if (!hasExactObjectKeys(entry, ['digest', 'expiresAt'])) return;
      const digest = String(entry.digest || ''), expiresAt = Number(entry.expiresAt);
      if (!validActionDigest(digest) || !Number.isSafeInteger(expiresAt) || expiresAt <= current ||
          expiresAt > current + ACTION_CACHE_V2_USED_TTL_MS + 60000) return;
      unique.set(digest, expiresAt);
    });
    return Array.from(unique, ([digest, expiresAt]) => ({ digest, expiresAt })).slice(-12);
  }

  function pruneExpiredActionCacheEntries(store) {
    if (!store || !Number.isSafeInteger(Number(store.length)) || typeof store.key !== 'function') return;
    const now = Date.now();
    for (let index = Number(store.length) - 1; index >= 0; index -= 1) {
      const key = String(store.key(index) || '');
      if (!key.startsWith('notion-widget-action-v1:') && !key.startsWith('notion-widget-action-used-v1:') &&
          !key.startsWith('notion-widget-action-v2:') && !key.startsWith('notion-widget-action-used-v2:')) continue;
      let value = null;
      try { value = JSON.parse(String(store.getItem(key) || '')); } catch (_error) {}
      const valid = key.startsWith('notion-widget-action-used-v2:') ? safeUsedActionEntriesV2(value, now).length > 0 :
        key.startsWith('notion-widget-action-used-v1:') ? safeUsedActionEntries(value, now).length > 0 :
        key.startsWith('notion-widget-action-v2:') ? hasExactObjectKeys(value, ['schema', 'savedAt', 'expiresAt', 'iv', 'ciphertext']) &&
          value.schema === ACTION_CACHE_V2_SCHEMA && validActionCacheV2Times(value.savedAt, value.expiresAt, now) :
          hasExactObjectKeys(value, ['schema', 'savedAt', 'trustedUntil', 'iv', 'ciphertext']) &&
            value.schema === ACTION_CACHE_SCHEMA && validActionCacheTimes(value.savedAt, value.trustedUntil, now);
      if (!valid) {
        try { store.removeItem(key); } catch (_removeError) {}
      }
    }
  }

  function actionCacheContext() {
    if (actionCacheContextPromise) return actionCacheContextPromise;
    actionCacheContextPromise = (async () => {
      const host = actionCachePublicHost();
      if (!host || !window.crypto || !window.crypto.subtle || !params) return null;
      const task = String(params.get('task') || '');
      const token = String(params.get('accessToken') || '');
      const release = String(params.get('release') || '');
      if (!task || !token || (release && !/^[A-Za-z0-9._-]{1,80}$/.test(release))) return null;
      const encoder = new TextEncoder();
      const keyDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-action-key-v1\u0000${host}\u0000${task}\u0000${token}`)));
      const slotDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-action-slot-v1\u0000${host}\u0000${task}\u0000${token}\u0000${release}`)));
      const usedSlotDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-action-used-slot-v1\u0000${host}\u0000${task}\u0000${token}\u0000${release}`)));
      const key = await window.crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const suffix = bytesToBase64Url(slotDigest.slice(0, 18));
      const context = {
        schema: ACTION_CACHE_SCHEMA,
        key,
        host,
        task,
        release,
        slot: `notion-widget-action-v1:${suffix}`,
        usedSlot: `notion-widget-action-used-v1:${bytesToBase64Url(usedSlotDigest.slice(0, 18))}`,
        channel: `notion-widget-action-v1:${suffix}`,
        aad: encoder.encode(`notion-widget-action-v1\u0000${host}\u0000${task}\u0000${release}`)
      };
      actionCacheContextValue = context;
      installActionCacheChannel(context);
      return context;
    })().catch(() => null);
    return actionCacheContextPromise;
  }

  function validActionCacheV2Times(savedAt, expiresAt, now) {
    const saved = Number(savedAt), expires = Number(expiresAt), current = Number(now);
    return Number.isSafeInteger(saved) && Number.isSafeInteger(expires) && Number.isFinite(current) &&
      saved <= current + 5000 && current - saved <= ACTION_CACHE_V2_MAX_TTL_MS && expires > current &&
      expires > saved && expires - saved <= ACTION_CACHE_V2_MAX_TTL_MS;
  }

  function actionCacheV2Context() {
    if (actionCacheV2ContextPromise) return actionCacheV2ContextPromise;
    actionCacheV2ContextPromise = (async () => {
      const host = actionCachePublicHost();
      if (!host || !window.crypto || !window.crypto.subtle || !params) return null;
      const task = String(params.get('task') || '');
      const token = String(params.get('accessToken') || '');
      const clientId = String(params.get('clientId') || '');
      if (!task || !token || !validClientId(clientId)) return null;
      const encoder = new TextEncoder();
      const domain = `${host}\u0000${task}\u0000${token}\u0000${clientId}`;
      const keyDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-action-key-v2\u0000${domain}`)));
      const slotDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-action-slot-v2\u0000${domain}`)));
      const usedSlotDigest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', encoder.encode(`notion-widget-action-used-slot-v2\u0000${domain}`)));
      const key = await window.crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const suffix = bytesToBase64Url(slotDigest.slice(0, 18));
      const context = {
        schema: ACTION_CACHE_V2_SCHEMA,
        key,
        host,
        task,
        token,
        clientId,
        slot: `notion-widget-action-v2:${suffix}`,
        usedSlot: `notion-widget-action-used-v2:${bytesToBase64Url(usedSlotDigest.slice(0, 18))}`,
        channel: `notion-widget-action-v2:${suffix}`,
        aad: encoder.encode(`notion-widget-action-v2\u0000${domain}`)
      };
      actionCacheV2ContextValue = context;
      installActionCacheChannel(context);
      return context;
    })().catch(() => null);
    return actionCacheV2ContextPromise;
  }

  async function actionDescriptorDigest(context, prepared) {
    const encoder = new TextEncoder();
    if (context.schema === ACTION_CACHE_V2_SCHEMA) {
      const digest = await window.crypto.subtle.digest('SHA-256', encoder.encode(
        `notion-widget-action-used-v2\u0000${context.host}\u0000${context.task}\u0000${context.clientId}\u0000${prepared.section}\u0000${prepared.reservationId}\u0000${prepared.openUrl}\u0000${prepared.generation}\u0000${prepared.navigateUntil}\u0000${prepared.reservationProof}\u0000${prepared.preparedName}`
      ));
      return bytesToBase64Url(new Uint8Array(digest));
    }
    const digest = await window.crypto.subtle.digest('SHA-256', encoder.encode(
      `notion-widget-action-used-v1\u0000${context.host}\u0000${context.task}\u0000${context.release}\u0000${prepared.section}\u0000${prepared.reservationId}\u0000${prepared.openUrl}`
    ));
    return bytesToBase64Url(new Uint8Array(digest));
  }

  function readUsedActionEntries(store, context) {
    let parsed = null;
    try { parsed = JSON.parse(String(store.getItem(context.usedSlot) || '')); } catch (_error) {}
    const entries = context.schema === ACTION_CACHE_V2_SCHEMA ? safeUsedActionEntriesV2(parsed, Date.now()) : safeUsedActionEntries(parsed, Date.now());
    blockedActionDigests.forEach((expiresAt, digest) => { if (expiresAt <= Date.now()) blockedActionDigests.delete(digest); });
    entries.forEach((entry) => blockedActionDigests.set(entry.digest, entry.expiresAt));
    return entries;
  }

  function removeCachedActionRecords(keepRecord) {
    createRequests.forEach((record, section) => {
      if (!record.fromActionCache || record === keepRecord || record.navigationCommitted || record.actionStarted) return;
      createRequests.delete(section);
      forgetCreateRequest(section);
    });
  }

  function clearCachedActionState(keepRecord, deferVisualRefresh) {
    actionCacheGeneration += 1;
    actionCacheFingerprint = '';
    actionCacheFingerprintSchema = 0;
    cachedPreparedCreates = {};
    cachedActionTrustedUntil = 0;
    removeCachedActionRecords(keepRecord || null);
    const refresh = () => {
      if (!hasLiveActionBridge()) {
        document.body.classList.toggle('action-cache-ready', false);
        if (!keepRecord) interactionGrid.hidden = true;
      }
      refreshAllControlHrefs();
    };
    if (deferVisualRefresh) window.setTimeout(refresh, 0);
    else refresh();
  }

  function receiveActionCacheInvalidation(value) {
    if (!value || !hasExactObjectKeys(value, ['schema', 'type', 'digest', 'expiresAt']) ||
        ![ACTION_CACHE_SCHEMA, ACTION_CACHE_V2_SCHEMA].includes(value.schema) || !['used', 'invalidate'].includes(value.type)) return false;
    const expiresAt = Number(value.expiresAt);
    const usedTtl = value.schema === ACTION_CACHE_V2_SCHEMA ? ACTION_CACHE_V2_USED_TTL_MS : ACTION_CACHE_USED_TTL_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + usedTtl + 60000) return false;
    if (value.type === 'invalidate') {
      if (value.digest !== '') return false;
      if (cachedActionStateHasSchema(value.schema) || actionCacheFingerprintSchema === value.schema) clearCachedActionState(null, false);
      return true;
    }
    if (!validActionDigest(value.digest)) return false;
    blockedActionDigests.set(value.digest, expiresAt);
    const blocked = Object.values(cachedPreparedCreates).some((entry) => entry.actionDigest === value.digest);
    if (blocked) clearCachedActionState(null, false);
    return true;
  }

  function installActionCacheChannel(context) {
    if (!context || typeof window.BroadcastChannel !== 'function') return;
    if (context.schema === ACTION_CACHE_V2_SCHEMA ? actionCacheV2Channel : actionCacheChannel) return;
    try {
      const channel = new window.BroadcastChannel(context.channel);
      if (context.schema === ACTION_CACHE_V2_SCHEMA) actionCacheV2Channel = channel;
      else actionCacheChannel = channel;
      const receive = (event) => receiveActionCacheInvalidation(event && event.data);
      if (typeof channel.addEventListener === 'function') channel.addEventListener('message', receive);
      else channel.onmessage = receive;
    } catch (_error) {
      if (context.schema === ACTION_CACHE_V2_SCHEMA) actionCacheV2Channel = null;
      else actionCacheChannel = null;
    }
  }

  function handleActionCacheStorage(event) {
    if (!event) return;
    const context = [actionCacheV2ContextValue, actionCacheContextValue].find((candidate) => candidate && (event.key === candidate.slot || event.key === candidate.usedSlot));
    if (!context) return;
    if (event.key === context.usedSlot) {
      const store = actionCacheStore();
      if (!store) return;
      const entries = readUsedActionEntries(store, context);
      if (entries.some((entry) => Object.values(cachedPreparedCreates).some((prepared) => prepared.actionDigest === entry.digest))) {
        clearCachedActionState(null, false);
      }
      return;
    }
    if (!event.newValue) {
      if (cachedActionStateHasSchema(context.schema) || actionCacheFingerprintSchema === context.schema) clearCachedActionState(null, false);
    } else if (!hasLiveActionBridge()) restorePreparedCreateActions();
  }

  function actionEnvelopePayloadValid(payload, envelope, context) {
    return hasExactObjectKeys(payload, ['schema', 'host', 'task', 'release', 'savedAt', 'trustedUntil', 'preparedCreates']) &&
      payload.schema === ACTION_CACHE_SCHEMA && payload.host === context.host && payload.task === context.task &&
      payload.release === context.release && payload.savedAt === envelope.savedAt && payload.trustedUntil === envelope.trustedUntil &&
      validActionCacheTimes(payload.savedAt, payload.trustedUntil, Date.now()) && Array.isArray(payload.preparedCreates) &&
      payload.preparedCreates.length > 0 && payload.preparedCreates.length <= 3;
  }

  function actionEnvelopePayloadV2Valid(payload, envelope, context) {
    return hasExactObjectKeys(payload, ['schema', 'host', 'task', 'clientId', 'savedAt', 'expiresAt', 'preparedCreates']) &&
      payload.schema === ACTION_CACHE_V2_SCHEMA && payload.host === context.host && payload.task === context.task &&
      payload.clientId === context.clientId && payload.savedAt === envelope.savedAt && payload.expiresAt === envelope.expiresAt &&
      validActionCacheV2Times(payload.savedAt, payload.expiresAt, Date.now()) && Array.isArray(payload.preparedCreates) &&
      payload.preparedCreates.length > 0 && payload.preparedCreates.length <= 3;
  }

  async function restorePreparedCreateActionsV2(generation) {
    const store = actionCacheStore();
    const context = await actionCacheV2Context();
    if (!store || !context || hasLiveActionBridge() || generation !== actionCacheGeneration) return false;
    readUsedActionEntries(store, context);
    let raw = '';
    try { raw = String(store.getItem(context.slot) || ''); } catch (_error) { return false; }
    if (!raw || raw.length > 30000) return false;
    try {
      const envelope = JSON.parse(raw);
      if (!hasExactObjectKeys(envelope, ['schema', 'savedAt', 'expiresAt', 'iv', 'ciphertext']) ||
          envelope.schema !== ACTION_CACHE_V2_SCHEMA || !validActionCacheV2Times(envelope.savedAt, envelope.expiresAt, Date.now())) {
        throw new Error('INVALID_ACTION_ENVELOPE');
      }
      const iv = base64UrlToBytes(envelope.iv), ciphertext = base64UrlToBytes(envelope.ciphertext);
      if (iv.length !== 12 || ciphertext.length > 20000) throw new Error('INVALID_ACTION_SIZE');
      const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, ciphertext);
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      if (!actionEnvelopePayloadV2Valid(payload, envelope, context)) throw new Error('INVALID_ACTION_PAYLOAD');
      const allPrepared = [];
      for (const row of payload.preparedCreates) {
        const safe = safePreparedCreateV2(row, Date.now());
        if (!safe) throw new Error('INVALID_ACTION_DESCRIPTOR');
        safe.actionDigest = await actionDescriptorDigest(context, safe);
        allPrepared.push(safe);
      }
      if (Math.min(...allPrepared.map((row) => row.navigateUntilMs)) !== Number(payload.expiresAt)) throw new Error('INVALID_ACTION_EXPIRY');
      const prepared = allPrepared.filter((row) => !blockedActionDigests.has(row.actionDigest));
      if (hasLiveActionBridge() || generation !== actionCacheGeneration || !prepared.length) return false;
      cachedPreparedCreates = cachedPreparedCreateMap(prepared);
      cachedActionTrustedUntil = Number(payload.expiresAt);
      actionCacheFingerprint = JSON.stringify({ schema: ACTION_CACHE_V2_SCHEMA, expiresAt: cachedActionTrustedUntil, preparedCreates: payload.preparedCreates });
      actionCacheFingerprintSchema = ACTION_CACHE_V2_SCHEMA;
      document.body.classList.add('action-cache-ready');
      interactionGrid.hidden = false;
      refreshAllControlHrefs();
      scheduleCachedPrimaryGeometry();
      return true;
    } catch (_error) {
      if (generation === actionCacheGeneration) {
        try { store.removeItem(context.slot); } catch (_removeError) {}
      }
      return false;
    }
  }

  async function restorePreparedCreateActionsV1(generation) {
    const store = actionCacheStore();
    const context = await actionCacheContext();
    if (!store || !context || bridge || generation !== actionCacheGeneration) return false;
    readUsedActionEntries(store, context);
    let raw = '';
    try { raw = String(store.getItem(context.slot) || ''); } catch (_error) { return false; }
    if (!raw || raw.length > 30000) return false;
    try {
      const envelope = JSON.parse(raw);
      if (!hasExactObjectKeys(envelope, ['schema', 'savedAt', 'trustedUntil', 'iv', 'ciphertext']) ||
          envelope.schema !== ACTION_CACHE_SCHEMA || !validActionCacheTimes(envelope.savedAt, envelope.trustedUntil, Date.now())) {
        throw new Error('INVALID_ACTION_ENVELOPE');
      }
      const iv = base64UrlToBytes(envelope.iv), ciphertext = base64UrlToBytes(envelope.ciphertext);
      if (iv.length !== 12 || ciphertext.length > 20000) throw new Error('INVALID_ACTION_SIZE');
      const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, ciphertext);
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      if (!actionEnvelopePayloadValid(payload, envelope, context)) throw new Error('INVALID_ACTION_PAYLOAD');
      const prepared = [];
      for (const row of payload.preparedCreates) {
        const safe = safeCachedPreparedCreateV1(row);
        if (!safe) throw new Error('INVALID_ACTION_DESCRIPTOR');
        Object.defineProperty(safe, 'cacheSchema', { value: ACTION_CACHE_SCHEMA, enumerable: false });
        safe.actionDigest = await actionDescriptorDigest(context, safe);
        if (!blockedActionDigests.has(safe.actionDigest)) prepared.push(safe);
      }
      if (bridge || generation !== actionCacheGeneration || !prepared.length) return false;
      cachedPreparedCreates = cachedPreparedCreateMap(prepared);
      cachedActionTrustedUntil = Number(payload.trustedUntil);
      actionCacheFingerprint = JSON.stringify({ schema: ACTION_CACHE_SCHEMA, trustedUntil: cachedActionTrustedUntil, preparedCreates: payload.preparedCreates });
      actionCacheFingerprintSchema = ACTION_CACHE_SCHEMA;
      document.body.classList.add('action-cache-ready');
      interactionGrid.hidden = false;
      refreshAllControlHrefs();
      scheduleCachedPrimaryGeometry();
      return true;
    } catch (_error) {
      if (generation === actionCacheGeneration) {
        try { store.removeItem(context.slot); } catch (_removeError) {}
      }
      return false;
    }
  }

  async function restorePreparedCreateActions() {
    const generation = ++actionCacheGeneration;
    blockedActionDigests.clear();
    if (await restorePreparedCreateActionsV2(generation)) return true;
    if (generation !== actionCacheGeneration) return false;
    return restorePreparedCreateActionsV1(generation);
  }

  function preparedCreateForCacheV2(row) {
    return {
      section: row.section,
      reservationId: row.reservationId,
      openUrl: row.openUrl,
      generation: row.generation,
      navigateUntil: row.navigateUntil,
      reservationProof: row.reservationProof,
      preparedName: row.preparedName
    };
  }

  async function persistPreparedCreateActionsV2(prepared, generation) {
    const store = actionCacheStore();
    const context = await actionCacheV2Context();
    if (!store || !context || generation !== actionCacheGeneration) return false;
    const now = Date.now();
    const verified = prepared.map((row) => safePreparedCreateV2(row, now));
    if (verified.some((row) => !row)) {
      try { store.removeItem(context.slot); } catch (_removeError) {}
      return false;
    }
    const expiresAt = Math.min(...verified.map((row) => row.navigateUntilMs));
    if (!validActionCacheV2Times(now, expiresAt, now)) {
      try { store.removeItem(context.slot); } catch (_removeError) {}
      return false;
    }
    readUsedActionEntries(store, context);
    const filtered = [];
    for (const row of verified) {
      const actionDigest = await actionDescriptorDigest(context, row);
      if (!blockedActionDigests.has(actionDigest)) filtered.push(preparedCreateForCacheV2(row));
    }
    if (generation !== actionCacheGeneration) return false;
    if (!filtered.length) {
      try { store.removeItem(context.slot); } catch (_removeError) {}
      return false;
    }
    const filteredExpiresAt = Math.min(...filtered.map((row) => parseCanonicalNavigateUntil(row.navigateUntil)));
    const fingerprint = JSON.stringify({ schema: ACTION_CACHE_V2_SCHEMA, expiresAt: filteredExpiresAt, preparedCreates: filtered });
    if (fingerprint === actionCacheFingerprint) return true;
    actionCacheFingerprint = fingerprint;
    actionCacheFingerprintSchema = ACTION_CACHE_V2_SCHEMA;
    try {
      const iv = new Uint8Array(12);
      window.crypto.getRandomValues(iv);
      const payload = { schema: ACTION_CACHE_V2_SCHEMA, host: context.host, task: context.task, clientId: context.clientId, savedAt: now, expiresAt: filteredExpiresAt, preparedCreates: filtered };
      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      const ciphertext = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, plaintext));
      if (generation !== actionCacheGeneration || fingerprint !== actionCacheFingerprint) return false;
      store.setItem(context.slot, JSON.stringify({ schema: ACTION_CACHE_V2_SCHEMA, savedAt: now, expiresAt: filteredExpiresAt, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) }));
      actionCacheContext().then((legacy) => { if (legacy) { try { store.removeItem(legacy.slot); } catch (_error) {} } });
      return true;
    } catch (_error) {
      if (generation === actionCacheGeneration && fingerprint === actionCacheFingerprint) {
        actionCacheFingerprint = '';
        actionCacheFingerprintSchema = 0;
      }
      return false;
    }
  }

  async function persistPreparedCreateActionsV1(prepared, trustedUntilValue, generation) {
    const store = actionCacheStore();
    const context = await actionCacheContext();
    if (!store || !context || generation !== actionCacheGeneration) return false;
    const now = Date.now();
    const serverTrustedUntil = parseActionTrustedUntil(trustedUntilValue);
    const trustedUntil = Math.min(serverTrustedUntil, now + ACTION_CACHE_MAX_TTL_MS);
    if (!Number.isFinite(serverTrustedUntil) || !validActionCacheTimes(now, trustedUntil, now) || !prepared.length) {
      try { store.removeItem(context.slot); } catch (_removeError) {}
      return false;
    }
    readUsedActionEntries(store, context);
    const filtered = [];
    for (const row of prepared) {
      const actionDigest = await actionDescriptorDigest(context, row);
      if (!blockedActionDigests.has(actionDigest)) filtered.push({ section: row.section, reservationId: row.reservationId, openUrl: row.openUrl });
    }
    if (generation !== actionCacheGeneration) return false;
    if (!filtered.length) {
      try { store.removeItem(context.slot); } catch (_removeError) {}
      return false;
    }
    const fingerprint = JSON.stringify({ trustedUntil, preparedCreates: filtered });
    if (fingerprint === actionCacheFingerprint) return true;
    actionCacheFingerprint = fingerprint;
    actionCacheFingerprintSchema = ACTION_CACHE_SCHEMA;
    try {
      const iv = new Uint8Array(12);
      window.crypto.getRandomValues(iv);
      const payload = { schema: ACTION_CACHE_SCHEMA, host: context.host, task: context.task, release: context.release, savedAt: now, trustedUntil, preparedCreates: filtered };
      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      const ciphertext = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context.aad }, context.key, plaintext));
      if (generation !== actionCacheGeneration || fingerprint !== actionCacheFingerprint) return false;
      store.setItem(context.slot, JSON.stringify({ schema: ACTION_CACHE_SCHEMA, savedAt: now, trustedUntil, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) }));
      return true;
    } catch (_error) {
      if (generation === actionCacheGeneration && fingerprint === actionCacheFingerprint) {
        actionCacheFingerprint = '';
        actionCacheFingerprintSchema = 0;
      }
      return false;
    }
  }

  async function persistPreparedCreateActions(value, trustedUntilValue) {
    const generation = ++actionCacheGeneration;
    const prepared = Object.values(preparedCreateMap(value));
    if (!prepared.length) return false;
    const v2 = prepared.every((row) => row.cacheSchema === ACTION_CACHE_V2_SCHEMA);
    const v1 = prepared.every((row) => row.cacheSchema !== ACTION_CACHE_V2_SCHEMA);
    if (v2) return persistPreparedCreateActionsV2(prepared, generation);
    if (v1) return persistPreparedCreateActionsV1(prepared, trustedUntilValue, generation);
    invalidateStoredActionCache(true);
    return false;
  }

  function cachedActionStateHasSchema(schema) {
    if (Object.values(cachedPreparedCreates).some((entry) => entry && entry.cacheSchema === schema)) return true;
    let found = false;
    createRequests.forEach((record) => {
      if (record && (record.fromActionCache || record.cachedActionConsumed) && record.cacheSchema === schema) found = true;
    });
    return found;
  }

  function invalidateStoredActionCache(broadcast, onlySchema) {
    const store = actionCacheStore();
    const schemas = onlySchema === ACTION_CACHE_SCHEMA || onlySchema === ACTION_CACHE_V2_SCHEMA ? [onlySchema] : [ACTION_CACHE_V2_SCHEMA, ACTION_CACHE_SCHEMA];
    const contexts = schemas.map((schema) => schema === ACTION_CACHE_V2_SCHEMA ? actionCacheV2ContextValue : actionCacheContextValue);
    const contextPromises = schemas.map((schema) => schema === ACTION_CACHE_V2_SCHEMA ? actionCacheV2Context() : actionCacheContext());
    if (store) {
      contexts.forEach((context) => {
        if (!context) return;
        try { store.removeItem(context.slot); } catch (_error) {}
      });
      contextPromises.forEach((promise) => promise.then((context) => {
        if (!context) return;
        try { store.removeItem(context.slot); } catch (_error) {}
      }));
    }
    if (!onlySchema || cachedActionStateHasSchema(onlySchema) || actionCacheFingerprintSchema === onlySchema) clearCachedActionState(null, false);
    if (broadcast && schemas.includes(ACTION_CACHE_SCHEMA) && actionCacheChannel) {
      try { actionCacheChannel.postMessage({ schema: ACTION_CACHE_SCHEMA, type: 'invalidate', digest: '', expiresAt: Date.now() + 5000 }); } catch (_error) {}
    }
    if (broadcast && schemas.includes(ACTION_CACHE_V2_SCHEMA) && actionCacheV2Channel) {
      try { actionCacheV2Channel.postMessage({ schema: ACTION_CACHE_V2_SCHEMA, type: 'invalidate', digest: '', expiresAt: Date.now() + 5000 }); } catch (_error) {}
    }
  }

  function consumeCachedPreparedCreate(record) {
    if (!record || !record.fromActionCache) return true;
    const prepared = cachedPreparedCreates[record.section];
    const isV2 = record.cacheSchema === ACTION_CACHE_V2_SCHEMA;
    const context = isV2 ? actionCacheV2ContextValue : actionCacheContextValue;
    const store = actionCacheStore();
    if (!prepared || !preparedTupleMatches(record, prepared) ||
        prepared.actionDigest !== record.actionDigest || !validActionDigest(record.actionDigest) ||
        cachedActionTrustedUntil <= Date.now() || (isV2 && prepared.navigateUntilMs <= Date.now()) || !context || !store) return false;
    const expiresAt = Date.now() + (isV2 ? ACTION_CACHE_V2_USED_TTL_MS : ACTION_CACHE_USED_TTL_MS);
    try {
      const entries = readUsedActionEntries(store, context);
      if (entries.some((entry) => entry.digest === record.actionDigest)) return false;
      entries.push({ digest: record.actionDigest, expiresAt });
      store.setItem(context.usedSlot, JSON.stringify({ schema: context.schema, updatedAt: Date.now(), entries: entries.slice(-12) }));
      try { store.removeItem(context.slot); } catch (_removeError) {}
    } catch (_error) { return false; }
    blockedActionDigests.set(record.actionDigest, expiresAt);
    record.cachedActionConsumed = true;
    record.liveConfirmed = false;
    if (isV2) addOptimisticCreate(record);
    clearCachedActionState(record, true);
    const channel = isV2 ? actionCacheV2Channel : actionCacheChannel;
    if (channel) {
      try { channel.postMessage({ schema: context.schema, type: 'used', digest: record.actionDigest, expiresAt }); } catch (_error) {}
    }
    return true;
  }

  function showFatal(message) {
    fatal.textContent = message;
    fatal.hidden = false;
    interactionGrid.hidden = true;
  }

  function showNotice(message) {
    window.clearTimeout(noticeTimer);
    fatal.textContent = message;
    fatal.hidden = false;
    noticeTimer = window.setTimeout(() => {
      fatal.hidden = true;
      fatal.textContent = '';
    }, 5000);
  }

  function isGoogleScriptOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' && (url.hostname === 'script.google.com' || url.hostname.endsWith('.googleusercontent.com'));
    } catch (_error) {
      return false;
    }
  }

  function isWidgetDescendant(source) {
    const root = widget.contentWindow;
    if (!root || !source) return false;
    const visit = (target, depth) => {
      if (target === source) return true;
      if (depth >= 4) return false;
      let length = 0;
      try { length = Math.min(Number(target.length) || 0, 8); } catch (_error) { return false; }
      for (let index = 0; index < length; index += 1) {
        try { if (visit(target.frames[index], depth + 1)) return true; } catch (_error) {}
      }
      return false;
    };
    return visit(root, 0);
  }

  function isCurrentBridgeEvent(event) {
    return Boolean(bridge && event.source === bridge.source && event.origin === bridge.origin);
  }

  function rejectPrimaryGeometry() {
    interactionGrid.hidden = true;
    return false;
  }

  function widgetViewport() {
    let rect = null;
    try { rect = widget.getBoundingClientRect(); } catch (_error) {}
    return {
      width: Number(widget.clientWidth) || Number(rect && rect.width) || Number(interactionGrid.clientWidth) || 0,
      height: Number(widget.clientHeight) || Number(rect && rect.height) || Number(interactionGrid.clientHeight) || 0
    };
  }

  function reportedViewportMatches(value, viewport) {
    if (!value) return true;
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
    const tolerance = 8;
    if (viewport.width > 0 && Math.abs(width - viewport.width) > tolerance) return false;
    if (viewport.height > 0 && Math.abs(height - viewport.height) > tolerance) return false;
    return true;
  }

  function applyPrimaryGeometry(value, reportedViewport) {
    const rows = Array.isArray(value) ? value : [];
    if (rows.length !== SECTIONS.length) return rejectPrimaryGeometry();
    const viewport = widgetViewport();
    if (!reportedViewportMatches(reportedViewport, viewport)) return rejectPrimaryGeometry();
    const bySection = new Map(rows.map((row) => [row && row.section, row]));
    for (const section of SECTIONS) {
      const row = bySection.get(section);
      const numbers = row && [row.left, row.top, row.width, row.height].map(Number);
      const pencil = row && row.pencil;
      const pencilNumbers = pencil && [pencil.left, pencil.top, pencil.width, pencil.height].map(Number);
      if (!numbers || !pencilNumbers || numbers.concat(pencilNumbers).some((number) => !Number.isFinite(number) || Math.abs(number) > 100000) || numbers[2] < 24 || numbers[3] < 30 || pencilNumbers[2] < 16 || pencilNumbers[3] < 16) return rejectPrimaryGeometry();
      const relativeLeft = pencilNumbers[0] - numbers[0];
      const relativeTop = pencilNumbers[1] - numbers[1];
      if (relativeLeft < 0 || relativeTop < 0 || relativeLeft + pencilNumbers[2] > numbers[2] || relativeTop + pencilNumbers[3] > numbers[3]) return rejectPrimaryGeometry();
      const tolerance = 8;
      if (viewport.width > 0 && (numbers[0] < -tolerance || numbers[0] + numbers[2] > viewport.width + tolerance)) return rejectPrimaryGeometry();
      if (viewport.height > 0 && (numbers[1] < -tolerance || numbers[1] + numbers[3] > viewport.height + tolerance)) return rejectPrimaryGeometry();
    }
    document.body.classList.toggle('action-cache-ready', false);
    document.body.classList.toggle('action-cache-measured', false);
    positionPrimarySlots(rows);
    interactionGrid.hidden = false;
    lastGeometryAckAt = Date.now();
    return true;
  }

  function positionPrimarySlots(rows) {
    const bySection = new Map(rows.map((row) => [row && row.section, row]));
    interactionGrid.querySelectorAll('[data-slot]').forEach((slot) => {
      const row = bySection.get(slot.dataset.slot);
      const left=Number(row.left),top=Number(row.top),width=Number(row.width),height=Number(row.height);
      const pencilLeft=Number(row.pencil.left)-left,pencilTop=Number(row.pencil.top)-top;
      const pencilWidth=Number(row.pencil.width),pencilHeight=Number(row.pencil.height);
      const pencilRight=pencilLeft+pencilWidth,pencilBottom=pencilTop+pencilHeight;
      slot.style.left = `${left}px`;
      slot.style.top = `${top}px`;
      slot.style.width = `${width}px`;
      slot.style.height = `${height}px`;
      const regions=[
        {left:0,top:0,width:pencilLeft,height},
        {left:pencilLeft,top:0,width:width-pencilLeft,height:pencilTop},
        {left:pencilRight,top:pencilTop,width:width-pencilRight,height:pencilHeight},
        {left:pencilLeft,top:pencilBottom,width:width-pencilLeft,height:height-pencilBottom}
      ];
      Array.from(slot.children).forEach((control,index)=>{
        const region=regions[index];if(!region)return;
        control.style.left=`${region.left}px`;control.style.top=`${region.top}px`;
        control.style.width=`${Math.max(0,region.width)}px`;control.style.height=`${Math.max(0,region.height)}px`;
      });
    });
  }

  function applyCachedPrimaryGeometry() {
    if (!cachedPrimaryActionsUsable() || !interactionGrid || typeof interactionGrid.getBoundingClientRect !== 'function') return false;
    let rootRect;
    try { rootRect = interactionGrid.getBoundingClientRect(); } catch (_error) { return false; }
    if (!rootRect) return false;
    const rows = [];
    for (const section of SECTIONS) {
      let source = null;
      try {
        if (snapshotGrid && snapshotGrid.hidden === false && typeof snapshotGrid.querySelector === 'function') {
          source = snapshotGrid.querySelector(`[data-snapshot-section="${section}"]`);
        }
        if (!source) source = document.querySelector(`[data-snapshot-section="${section}"]`);
      } catch (_error) { source = null; }
      if (!source || typeof source.getBoundingClientRect !== 'function') return false;
      const pencil = typeof source.querySelector === 'function' && source.querySelector('.skeleton-pencil');
      if (!pencil || typeof pencil.getBoundingClientRect !== 'function') return false;
      const rect = source.getBoundingClientRect(), pencilRect = pencil.getBoundingClientRect();
      const numbers = [rect.left, rect.top, rect.width, rect.height, pencilRect.left, pencilRect.top, pencilRect.width, pencilRect.height].map(Number);
      if (numbers.some((number) => !Number.isFinite(number)) || rect.width < 24 || rect.height < 30) return false;
      rows.push({
        section,
        left: Number(rect.left) - Number(rootRect.left || 0),
        top: Number(rect.top) - Number(rootRect.top || 0),
        width: Number(rect.width),
        height: Number(rect.height),
        pencil: {
          left: Number(pencilRect.left) - Number(rootRect.left || 0),
          top: Number(pencilRect.top) - Number(rootRect.top || 0),
          width: Number(pencilRect.width),
          height: Number(pencilRect.height)
        }
      });
    }
    document.body.classList.add('action-cache-measured');
    positionPrimarySlots(rows);
    interactionGrid.hidden = false;
    return true;
  }

  function scheduleCachedPrimaryGeometry() {
    applyCachedPrimaryGeometry();
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(applyCachedPrimaryGeometry);
  }

  function sendToBridge(message) {
    if (!bridge) return false;
    try {
      bridge.source.postMessage(Object.assign({}, message, { embedNonce }), bridge.origin);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function requestPrimaryGeometry() {
    if (!bridge) return false;
    geometryRequestId += 1;
    return sendToBridge({ type: 'notion-widget-v20-primary-geometry-request', requestId: geometryRequestId });
  }

  function refreshPrimaryGeometry() {
    if (cachedPrimaryActionsUsable()) {
      applyCachedPrimaryGeometry();
      return;
    }
    interactionGrid.hidden = true;
    requestPrimaryGeometry();
  }

  function runGeometryHeartbeat() {
    if (document.visibilityState === 'hidden') return;
    if (bridge && Date.now() - lastGeometryAckAt > 2000) interactionGrid.hidden = true;
    requestPrimaryGeometry();
  }

  function allowedDriveFolderUrl(value) {
    try {
      const raw = String(value || '');
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        url.hostname === 'drive.google.com' && !url.search && !url.hash && raw === url.href &&
        /^\/drive\/folders\/[A-Za-z0-9_-]{10,200}$/.test(url.pathname) ? raw : '';
    } catch (_error) {
      return '';
    }
  }

  function encodeCourierFragment(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function createRequestStore() {
    try { return window['session' + 'Storage']; } catch (_error) { return null; }
  }

  function validCreateRequestId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value || '').toLowerCase());
  }

  function safePreparedCreateBase(value) {
    const section = String(value && value.section || '');
    const reservationId = String(value && value.reservationId || '').toLowerCase();
    if (!['Docs', 'Sheets', 'Slides'].includes(section) || !validCreateRequestId(reservationId)) return null;
    try {
      const openUrl = String(value && value.openUrl || '');
      const url = new URL(openUrl);
      const segment = section === 'Docs' ? 'document' : section === 'Sheets' ? 'spreadsheets' : 'presentation';
      if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password || url.search || url.hash ||
          openUrl !== url.href || !new RegExp(`^/${segment}/d/[A-Za-z0-9_-]{10,200}/edit$`).test(url.pathname)) return null;
      return { section, reservationId, openUrl: url.href };
    } catch (_error) {
      return null;
    }
  }

  function validPreparedName(value) {
    const source = String(value || '');
    return source.length >= 1 && source.length <= 180 && source === source.replace(/\s+/g, ' ').trim();
  }

  function parseCanonicalNavigateUntil(value) {
    const source = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(source)) return NaN;
    const parsed = Date.parse(source);
    try { return Number.isFinite(parsed) && new Date(parsed).toISOString() === source ? parsed : NaN; } catch (_error) { return NaN; }
  }

  function safePreparedCreateV1(value) {
    return hasExactObjectKeys(value, ACTION_DESCRIPTOR_V1_KEYS) ? safePreparedCreateBase(value) : null;
  }

  function safePreparedCreateV2(value, now) {
    if (!hasExactObjectKeys(value, ACTION_DESCRIPTOR_V2_KEYS)) return null;
    const base = safePreparedCreateBase(value);
    const generation = value && value.generation;
    const navigateUntil = String(value && value.navigateUntil || '');
    const navigateUntilMs = parseCanonicalNavigateUntil(navigateUntil);
    const reservationProof = String(value && value.reservationProof || '');
    const preparedName = String(value && value.preparedName || '');
    const current = Number(now);
    if (!base || !Number.isSafeInteger(generation) || generation < 1 || generation > 2147483647 ||
        !Number.isFinite(current) || !Number.isFinite(navigateUntilMs) || navigateUntilMs <= current ||
        navigateUntilMs - current > ACTION_CACHE_V2_MAX_TTL_MS || !/^[0-9a-f]{64}$/.test(reservationProof) ||
        !validPreparedName(preparedName)) return null;
    const prepared = Object.assign(base, { generation, navigateUntil, reservationProof, preparedName });
    Object.defineProperties(prepared, {
      navigateUntilMs: { value: navigateUntilMs, enumerable: false },
      cacheSchema: { value: ACTION_CACHE_V2_SCHEMA, enumerable: false }
    });
    return prepared;
  }

  function safePreparedCreate(value) {
    return hasExactObjectKeys(value, ACTION_DESCRIPTOR_V2_KEYS) ? safePreparedCreateV2(value, Date.now()) : safePreparedCreateV1(value);
  }

  function safeCachedPreparedCreateV1(value) {
    return hasExactObjectKeys(value, ACTION_DESCRIPTOR_V1_KEYS) ? safePreparedCreateBase(value) : null;
  }

  function preparedTupleMatches(left, right) {
    const leftOpenUrl = left && String(left.openUrl || left.href || '');
    const rightOpenUrl = right && String(right.openUrl || right.href || '');
    if (!left || !right || left.section !== right.section || left.reservationId !== right.reservationId || leftOpenUrl !== rightOpenUrl) return false;
    const leftV2 = left.cacheSchema === ACTION_CACHE_V2_SCHEMA;
    const rightV2 = right.cacheSchema === ACTION_CACHE_V2_SCHEMA;
    if (leftV2 !== rightV2) return false;
    return !leftV2 || left.generation === right.generation && left.navigateUntil === right.navigateUntil &&
      left.reservationProof === right.reservationProof && left.preparedName === right.preparedName;
  }

  function preparedCreateMap(value) {
    const result = {};
    (Array.isArray(value) ? value : []).slice(0, 3).forEach((row) => {
      const prepared = safePreparedCreate(row);
      if (prepared && !result[prepared.section]) result[prepared.section] = prepared;
    });
    return result;
  }

  function cachedPreparedCreateMap(value) {
    const result = {};
    (Array.isArray(value) ? value : []).slice(0, 3).forEach((prepared) => {
      if (prepared && ['Docs', 'Sheets', 'Slides'].includes(prepared.section) && validActionDigest(prepared.actionDigest) && !result[prepared.section]) {
        result[prepared.section] = prepared;
      }
    });
    return result;
  }

  function createRequestSlot(section) {
    const task = params && params.get('task');
    return task && ['Docs', 'Sheets', 'Slides'].includes(section) ? `notion-widget-v20:create:${task}:${section}` : '';
  }

  function rememberedCreateRequest(section) {
    const store = createRequestStore(), slot = createRequestSlot(section);
    if (!store || !slot) return '';
    try {
      const value = String(store.getItem(slot) || '').toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : '';
    } catch (_error) { return ''; }
  }

  function hasLiveActionBridge() {
    return Boolean(bridge && bridge.authoritative === true && bridge.actionReady === true);
  }

  function cachedPrimaryActionsUsable() {
    const prepared = Object.values(cachedPreparedCreates);
    if (!prepared.length || hasLiveActionBridge()) return false;
    return !bridge || prepared.every((entry) => entry && entry.cacheSchema === ACTION_CACHE_V2_SCHEMA);
  }

  function rememberCreateRequest(section, requestId) {
    const store = createRequestStore(), slot = createRequestSlot(section);
    if (!store || !slot) return;
    try { store.setItem(slot, requestId); } catch (_error) {}
  }

  function forgetCreateRequest(section) {
    const store = createRequestStore(), slot = createRequestSlot(section);
    if (!store || !slot) return;
    try { store.removeItem(slot); } catch (_error) {}
  }

  function createCourierHref(section) {
    if (!params || !['Docs', 'Sheets', 'Slides'].includes(section)) return '';
    if (cachedActionTrustedUntil && cachedActionTrustedUntil <= Date.now()) clearCachedActionState(null, false);
    const liveReady = hasLiveActionBridge();
    let livePrepared = liveReady && bridge.preparedCreates && bridge.preparedCreates[section] || null;
    if (livePrepared && livePrepared.cacheSchema === ACTION_CACHE_V2_SCHEMA && livePrepared.navigateUntilMs <= Date.now()) livePrepared = null;
    const cachedCandidate = !livePrepared && cachedPreparedCreates[section] || null;
    const cachedPrepared = cachedCandidate && (!bridge || !liveReady && cachedCandidate.cacheSchema === ACTION_CACHE_V2_SCHEMA) ? cachedCandidate : null;
    const prepared = livePrepared || cachedPrepared;
    let existing = createRequests.get(section);
    if (existing && existing.cachedActionConsumed && existing.liveConfirmed !== true) return '';
    if (!liveReady && !cachedPrepared) return '';
    if (existing && !existing.actionStarted && !existing.navigationCommitted) {
      const expectedReservationId = prepared && prepared.reservationId || '';
      if (String(existing.reservationId || '') !== expectedReservationId) {
        createRequests.delete(section);
        forgetCreateRequest(section);
        existing = null;
      }
    }
    if (existing) return existing.href;
    try {
      if (prepared) {
        const record = {
          section,
          requestId: prepared.reservationId,
          reservationId: prepared.reservationId,
          href: prepared.openUrl,
          actionStarted: false,
          fromActionCache: Boolean(cachedPrepared),
          actionDigest: cachedPrepared && cachedPrepared.actionDigest || '',
          cacheSchema: prepared.cacheSchema || ACTION_CACHE_SCHEMA
        };
        if (record.cacheSchema === ACTION_CACHE_V2_SCHEMA) {
          record.generation = prepared.generation;
          record.navigateUntil = prepared.navigateUntil;
          record.reservationProof = prepared.reservationProof;
          record.preparedName = prepared.preparedName;
        }
        createRequests.set(section, record);
        rememberCreateRequest(section, record.requestId);
        return record.href;
      }
      const requestId = rememberedCreateRequest(section) || randomId();
      if (!validCreateRequestId(requestId)) return '';
      const service = new URL(DEPLOYMENT_URL);
      if (service.protocol !== 'https:' || service.hostname !== 'script.google.com' || service.search || service.hash ||
          !/^\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(service.pathname)) return '';
      service.searchParams.set('task', params.get('task'));
      service.searchParams.set('accessToken', params.get('accessToken'));
      service.searchParams.set('createSection', section);
      service.searchParams.set('createRequestId', requestId);
      if (Array.from(service.searchParams.keys()).length !== 4) return '';
      const courier = new URL(CREATE_COURIER_URL);
      if (courier.origin !== 'https://ravilvaliev1999-spec.github.io' || courier.pathname !== '/notion-widgets/create-courier.html' || courier.search || courier.hash) return '';
      const record = { section, requestId, href: `${courier.href}#v2=${encodeCourierFragment(service.href)}`, actionStarted: false };
      createRequests.set(section, record);
      rememberCreateRequest(section, requestId);
      return record.href;
    } catch (_error) {
      return '';
    }
  }

  function refreshControlHref(control) {
    const section = control && control.dataset.section;
    const href = section === 'Drive' ? bridge && bridge.folderUrl || cachedNavigationFolderHref() : createCourierHref(section);
    if (href) control.href = href;
    else control.removeAttribute('href');
    return href;
  }

  function refreshAllControlHrefs() {
    interactionGrid.querySelectorAll('[data-section]').forEach(refreshControlHref);
  }

  function safeCompletedCreateIds(value) {
    return new Set((Array.isArray(value) ? value : []).slice(0, 100).map((item) => String(item || '').toLowerCase())
      .filter((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item)));
  }

  function authoritativeBridgeInvalidatesV2(value) {
    if (!bridge || bridge.authoritative !== true) return false;
    const completed = safeCompletedCreateIds(value), cached = [];
    Object.values(cachedPreparedCreates).forEach((record) => { if (record && record.cacheSchema === ACTION_CACHE_V2_SCHEMA) cached.push(record); });
    createRequests.forEach((record) => {
      if (record && (record.fromActionCache || record.cachedActionConsumed) && record.cacheSchema === ACTION_CACHE_V2_SCHEMA && !cached.includes(record)) cached.push(record);
    });
    if (cached.some((record) => completed.has(record.reservationId || record.requestId))) return true;
    if (bridge.actionReady !== true) return false;
    const live = Object.values(bridge.preparedCreates || {});
    if (!live.length || live.some((record) => record.cacheSchema !== ACTION_CACHE_V2_SCHEMA)) return true;
    return cached.some((record) => record.fromActionCache !== false && !preparedTupleMatches(record, bridge.preparedCreates[record.section]));
  }

  function completeCreateRequests(value) {
    const completed = safeCompletedCreateIds(value);
    ['Docs','Sheets','Slides'].forEach((section)=>{if(completed.has(rememberedCreateRequest(section)))forgetCreateRequest(section);});
    completed.forEach(removeOptimisticCreate);
    createRequests.forEach((record, section) => {
      if (!completed.has(record.requestId)) return;
      if (record.ackTimer) window.clearTimeout(record.ackTimer);
      createRequests.delete(section);forgetCreateRequest(section);
    });
  }

  function claimCreateNavigation(section) {
    const record = createRequests.get(section);
    if (!record) return false;
    if (record.actionStarted) return false;
    const now = Date.now();
    if (record.lastNavigationAt && now - record.lastNavigationAt < 1500) return false;
    if (!consumeCachedPreparedCreate(record)) return false;
    record.lastNavigationAt = now;
    record.navigationCommitted = true;
    return true;
  }

  function createActionMessage(record) {
    const message = { type: 'notion-widget-v20-primary-action', section: record.section, requestId: record.requestId };
    if (record.reservationId) message.reservationId = record.reservationId;
    if (record.cacheSchema === ACTION_CACHE_V2_SCHEMA) {
      message.openUrl = record.href;
      message.generation = record.generation;
      message.navigateUntil = record.navigateUntil;
      message.reservationProof = record.reservationProof;
      message.preparedName = record.preparedName;
    }
    return message;
  }

  function dispatchCreateAction(record) {
    if (!record || !bridge || bridge.authoritative !== true || bridge.actionReady !== true ||
        (record.cachedActionConsumed && record.liveConfirmed !== true) || !sendToBridge(createActionMessage(record))) return false;
    record.actionQueued = false;
    record.ackAttempts = Number(record.ackAttempts || 0) + 1;
    if (record.ackTimer) window.clearTimeout(record.ackTimer);
    record.ackTimer = window.setTimeout(() => {
      record.ackTimer = 0;
      if (record.actionAcknowledged || createRequests.get(record.section) !== record) return;
      if (record.ackAttempts < 2 && dispatchCreateAction(record)) return;
      record.actionStarted = false;
      record.lastNavigationAt = 0;
      removeOptimisticCreate(record.requestId);
      showNotice('Документ открыт, но фоновая привязка не подтверждена. Повторите нажатие — откроется тот же файл.');
    }, 1000);
    return true;
  }

  function beginNativeCreate(record) {
    if (!record) return false;
    if (record.actionStarted) return true;
    record.actionStarted = true;
    record.actionAcknowledged = false;
    record.ackAttempts = 0;
    if (dispatchCreateAction(record)) return true;
    if (record.cachedActionConsumed) {
      record.actionQueued = true;
      return true;
    }
    record.actionStarted = false;
    return false;
  }

  function adoptLivePreparedRecords() {
    if (!bridge || !bridge.actionReady) return;
    createRequests.forEach((record, section) => {
      if (!record.fromActionCache) return;
      const prepared = bridge.preparedCreates && bridge.preparedCreates[section];
      if (prepared && preparedTupleMatches(record, prepared)) {
        if (record.cachedActionConsumed) addOptimisticCreate(record);
        record.fromActionCache = false;
        record.liveConfirmed = true;
        record.actionDigest = '';
      } else if (prepared && record.cachedActionConsumed && !record.cacheMismatchNotified) {
        record.cacheMismatchNotified = true;
        removeOptimisticCreate(record.requestId);
        showNotice('Документ открыт, но его защищённая фоновая привязка изменилась. Виджет обновит карточку после проверки.');
      }
    });
  }


  function handleWidgetMessage(event) {
    const data = event.data;
    if (!data || data.embedNonce !== embedNonce || !isGoogleScriptOrigin(event.origin)) return;
    if (data.type === 'notion-widget-v20-snapshot-ready') {
      if (!isWidgetDescendant(event.source)) return;
      window.__notionWidgetLiveSnapshotSeen = true;
      acceptSnapshotMaterials(data.materials, !document.body.classList.contains('widget-action-ready'));
      return;
    }
    if (data.type === 'notion-widget-v20-bridge-ready') {
      if (!isWidgetDescendant(event.source) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(data.instanceId || ''))) return;
      window.__notionWidgetLiveSnapshotSeen = true;
      bridge = { source: event.source, origin: event.origin, instanceId: data.instanceId, authoritative: data.authoritative === true, actionReady: data.actionReady === true, folderUrl: allowedDriveFolderUrl(data.folderUrl), preparedCreates: data.authoritative === true && data.actionReady === true ? preparedCreateMap(data.preparedCreates) : {}, trustedUntil: String(data.trustedUntil || '') };
      geometryRequestId = 0;
      latestGeometryResponseId = 0;
      lastGeometryAckAt = 0;
      fatal.hidden = true;
      document.body.classList.add('widget-ready');
      document.body.classList.toggle('widget-action-ready', bridge.authoritative && bridge.actionReady);
      const completedCreateRequestIds = bridge.authoritative ? data.completedCreateRequestIds : [];
      if (authoritativeBridgeInvalidatesV2(completedCreateRequestIds)) invalidateStoredActionCache(true, ACTION_CACHE_V2_SCHEMA);
      completeCreateRequests(completedCreateRequestIds);
      adoptLivePreparedRecords();
      applyPrimaryGeometry(data.geometry, data.viewport);
      if (cachedPrimaryActionsUsable()) scheduleCachedPrimaryGeometry();
      acceptSnapshotMaterials(data.snapshotMaterials, !(bridge.authoritative && bridge.actionReady));
      if (bridge.authoritative && bridge.actionReady) persistNavigationCache(data.navigationMaterials, data.navigationFolderUrl, data.snapshotMaterials);
      // A stale bridge cannot revoke an independently authenticated read-only navigation cache.
      invalidateStoredActionCache(true, ACTION_CACHE_SCHEMA);
      if (bridge.authoritative && bridge.actionReady) persistPreparedCreateActions(Object.values(bridge.preparedCreates), bridge.trustedUntil);
      refreshAllControlHrefs();
      createRequests.forEach((record) => { if (record.actionStarted && !record.actionAcknowledged && Number(record.ackAttempts || 0) < 2) dispatchCreateAction(record); });
      requestPrimaryGeometry();
      return;
    }
    if (!isCurrentBridgeEvent(event)) return;
    if (data.type === 'notion-widget-v20-primary-started' && validCreateRequestId(data.requestId)) {
      createRequests.forEach((record) => {
        if (record.requestId !== String(data.requestId).toLowerCase()) return;
        record.actionAcknowledged = true;
        if (record.ackTimer) window.clearTimeout(record.ackTimer);
        record.ackTimer = 0;
      });
      return;
    }
    if (data.type === 'notion-widget-v20-primary-result' && validCreateRequestId(data.requestId) && data.ok === false) {
      const terminalSections = [];
      createRequests.forEach((record, section) => {
        if (record.requestId !== String(data.requestId).toLowerCase()) return;
        if (record.ackTimer) window.clearTimeout(record.ackTimer);
        removeOptimisticCreate(record.requestId);
        if (data.retryable === false) { createRequests.delete(section);forgetCreateRequest(section);terminalSections.push(section);return; }
        record.actionStarted = false;record.actionAcknowledged = false;record.lastNavigationAt = 0;record.ackTimer = 0;
      });
      if (terminalSections.length) terminalSections.forEach((section)=>interactionGrid.querySelectorAll(`[data-section="${section}"]`).forEach((control)=>control.removeAttribute('href')));
      else refreshAllControlHrefs();
      showNotice(String(data.message || 'Файл не удалось создать. Повторите нажатие.').slice(0, 300));
      return;
    }
    if (data.type === 'notion-widget-v20-primary-geometry') {
      if (data.requestId !== undefined) {
        const responseId = Number(data.requestId);
        if (!Number.isSafeInteger(responseId) || responseId <= latestGeometryResponseId || responseId > geometryRequestId) return;
        latestGeometryResponseId = responseId;
      }
      applyPrimaryGeometry(data.geometry, data.viewport);
      return;
    }
  }

  function installInteractionControls() {
    interactionGrid.querySelectorAll('[data-slot]').forEach((slot) => {
      const section = slot.dataset.slot;
      if (!SECTIONS.includes(section)) return;
      ['main', 'pencil-top', 'pencil-right', 'pencil-bottom'].forEach((region, index) => {
        const control = document.createElement('a');
        control.className = `primary-control primary-control-${region}`;
        control.dataset.section = section;
        control.target = '_blank';
        control.rel = 'noopener noreferrer';
        control.referrerPolicy = 'no-referrer';
        if (index === 0) {
          control.setAttribute('aria-label', section === 'Drive' ? 'Открыть папку задачи' : `Создать новый файл ${section}`);
        } else {
          control.tabIndex = -1;
          control.setAttribute('aria-hidden', 'true');
        }
        const prepare = () => refreshControlHref(control);
        control.addEventListener('pointerdown', prepare);
        control.addEventListener('keydown', (event) => { if (event.key === 'Enter') prepare(); });
        control.addEventListener('click', (event) => {
          if (refreshControlHref(control)) {
            if (section === 'Drive') return;
            if (claimCreateNavigation(section)) {
              const record = createRequests.get(section);
              if (record) beginNativeCreate(record);
              return;
            }
            event.preventDefault();
            return;
          }
          event.preventDefault();
          showNotice(section === 'Drive' ? 'Папка задачи ещё синхронизируется.' : 'Не удалось подготовить защищённое создание файла.');
        });
        control.addEventListener('auxclick', (event) => {
          if (event.button !== 1 || section === 'Drive') return;
          if (refreshControlHref(control) && claimCreateNavigation(section)) {
            const record = createRequests.get(section);
            if (record) beginNativeCreate(record);
            return;
          }
          event.preventDefault();
          showNotice('Создание этого файла уже выполняется.');
        });
        control.addEventListener('pointerenter', () => sendToBridge({ type: 'notion-widget-v20-primary-hover', section, active: true }));
        control.addEventListener('pointerleave', () => sendToBridge({ type: 'notion-widget-v20-primary-hover', section, active: false }));
        slot.appendChild(control);
      });
    });
  }

  const params = parseRuntimeParams();
  if (!params) {
    showFatal('Ссылка виджета неполная или повреждена. Секретный ключ должен находиться после символа #.');
    return;
  }
  installInteractionControls();
  window.addEventListener('message', handleWidgetMessage);
  window.addEventListener('storage', handleActionCacheStorage);
  window.addEventListener('storage', handleNavigationCacheStorage);
  restoreSnapshotMaterials();
  restoreNavigationCache();
  restorePreparedCreateActions();
  if (earlyBridgeListener && typeof window.removeEventListener === 'function') window.removeEventListener('message', earlyBridgeListener);
  earlyBridgeEvents.forEach(handleWidgetMessage);
  earlyBridgeEvents = [];
  window.addEventListener('resize', refreshPrimaryGeometry);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshPrimaryGeometry(); });
  if (window.ResizeObserver) new ResizeObserver(refreshPrimaryGeometry).observe(widget);
  window.setInterval(runGeometryHeartbeat, 750);
  const widgetUrl = `${DEPLOYMENT_URL}?${params.toString()}`;
  if (window.__notionWidgetDeferChild !== true && widget.src !== widgetUrl) widget.src = widgetUrl;
})();
