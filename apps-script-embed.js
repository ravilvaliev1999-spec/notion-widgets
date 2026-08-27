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
  const SNAPSHOT_CLASS = { Drive: 'gray', Docs: 'blue', Sheets: 'green', Slides: 'orange' };
  let earlyBridgeEvents = [];
  let earlyBridgeListener = null;
  const earlyEmbedNonce = (() => {
    try {
      const early = window.__notionWidgetEarlyBridge;
      const value = String(early && early.nonce || '').toLowerCase();
      if (/^[0-9a-f]{32}$/.test(value)) {
        earlyBridgeEvents = Array.isArray(early.events) ? early.events : [];
        earlyBridgeListener = typeof early.listener === 'function' ? early.listener : null;
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

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    const allowed = new URLSearchParams({ task, accessToken, embedNonce });
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
      if (!rawName || rawName.length > 180 || rawFormat.length > 100 || !Number.isFinite(position) || position < 0 || position > 10000) return null;
      rows.push({ name: rawName, section, format: rawFormat || 'Файл', position: Math.round(position) });
    }
    return rows.sort((left, right) => SECTIONS.indexOf(left.section) - SECTIONS.indexOf(right.section) || left.position - right.position || left.name.localeCompare(right.name));
  }

  function snapshotFingerprint(rows) {
    return JSON.stringify(rows);
  }

  function renderSafeSnapshotMaterials(rows, fingerprint) {
    if (!snapshotGrid) return false;
    if (fingerprint && fingerprint === lastRenderedSnapshotFingerprint) return true;
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
        const card = document.createElement('article');
        card.className = `snapshot-card ${SNAPSHOT_CLASS[section]}`;
        if (sourceIcon) card.appendChild(sourceIcon.cloneNode(true));
        const meta = document.createElement('span');
        meta.className = 'skeleton-meta';
        const title = document.createElement('span');
        title.className = 'skeleton-title';
        title.textContent = row.name;
        const sub = document.createElement('span');
        sub.className = 'skeleton-sub';
        sub.textContent = row.format;
        meta.append(title, sub);
        card.appendChild(meta);
        column.appendChild(card);
      });
      snapshotGrid.appendChild(column);
    });
    lastRenderedSnapshotFingerprint = fingerprint || snapshotFingerprint(rows);
    document.body.classList.add('snapshot-ready');
    snapshotGrid.hidden = false;
    return true;
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
    interactionGrid.hidden = false;
    lastGeometryAckAt = Date.now();
    return true;
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
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        url.hostname === 'drive.google.com' && /^\/drive\/folders\/[A-Za-z0-9_-]{10,}$/.test(url.pathname) ? url.href : '';
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

  function safePreparedCreate(value) {
    const section = String(value && value.section || '');
    const reservationId = String(value && value.reservationId || '').toLowerCase();
    if (!['Docs', 'Sheets', 'Slides'].includes(section) || !validCreateRequestId(reservationId)) return null;
    try {
      const url = new URL(String(value && value.openUrl || ''));
      const segment = section === 'Docs' ? 'document' : section === 'Sheets' ? 'spreadsheets' : 'presentation';
      if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password || url.search || url.hash ||
          !new RegExp(`^/${segment}/d/[A-Za-z0-9_-]{10,200}/edit$`).test(url.pathname)) return null;
      return { section, reservationId, openUrl: url.href };
    } catch (_error) {
      return null;
    }
  }

  function preparedCreateMap(value) {
    const result = {};
    (Array.isArray(value) ? value : []).slice(0, 3).forEach((row) => {
      const prepared = safePreparedCreate(row);
      if (prepared && !result[prepared.section]) result[prepared.section] = prepared;
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
    if (!params || !bridge || bridge.actionReady !== true || !['Docs', 'Sheets', 'Slides'].includes(section)) return '';
    const prepared = bridge.preparedCreates && bridge.preparedCreates[section] || null;
    let existing = createRequests.get(section);
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
        const record = { section, requestId: prepared.reservationId, reservationId: prepared.reservationId, href: prepared.openUrl, actionStarted: false };
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
    const href = section === 'Drive' ? bridge && bridge.folderUrl || '' : createCourierHref(section);
    if (href) control.href = href;
    else control.removeAttribute('href');
    return href;
  }

  function refreshAllControlHrefs() {
    interactionGrid.querySelectorAll('[data-section]').forEach(refreshControlHref);
  }

  function completeCreateRequests(value) {
    const completed = new Set((Array.isArray(value) ? value : []).slice(0, 100).map((item) => String(item || '').toLowerCase())
      .filter((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item)));
    ['Docs','Sheets','Slides'].forEach((section)=>{if(completed.has(rememberedCreateRequest(section)))forgetCreateRequest(section);});
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
    record.lastNavigationAt = now;
    record.navigationCommitted = true;
    return true;
  }

  function createActionMessage(record) {
    const message = { type: 'notion-widget-v20-primary-action', section: record.section, requestId: record.requestId };
    if (record.reservationId) message.reservationId = record.reservationId;
    return message;
  }

  function dispatchCreateAction(record) {
    if (!record || !sendToBridge(createActionMessage(record))) return false;
    record.ackAttempts = Number(record.ackAttempts || 0) + 1;
    if (record.ackTimer) window.clearTimeout(record.ackTimer);
    record.ackTimer = window.setTimeout(() => {
      record.ackTimer = 0;
      if (record.actionAcknowledged || createRequests.get(record.section) !== record) return;
      if (record.ackAttempts < 2 && dispatchCreateAction(record)) return;
      record.actionStarted = false;
      record.lastNavigationAt = 0;
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
    record.actionStarted = false;
    return false;
  }


  function handleWidgetMessage(event) {
    const data = event.data;
    if (!data || data.embedNonce !== embedNonce || !isGoogleScriptOrigin(event.origin)) return;
    if (data.type === 'notion-widget-v20-snapshot-ready') {
      if (!isWidgetDescendant(event.source)) return;
      acceptSnapshotMaterials(data.materials, !document.body.classList.contains('widget-action-ready'));
      return;
    }
    if (data.type === 'notion-widget-v20-bridge-ready') {
      if (!isWidgetDescendant(event.source) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(data.instanceId || ''))) return;
      bridge = { source: event.source, origin: event.origin, instanceId: data.instanceId, authoritative: data.authoritative === true, actionReady: data.actionReady === true, folderUrl: allowedDriveFolderUrl(data.folderUrl), preparedCreates: data.authoritative === true && data.actionReady === true ? preparedCreateMap(data.preparedCreates) : {} };
      geometryRequestId = 0;
      latestGeometryResponseId = 0;
      lastGeometryAckAt = 0;
      fatal.hidden = true;
      document.body.classList.add('widget-ready');
      if (bridge.authoritative && bridge.actionReady) document.body.classList.add('widget-action-ready');
      applyPrimaryGeometry(data.geometry, data.viewport);
      acceptSnapshotMaterials(data.snapshotMaterials, !(bridge.authoritative && bridge.actionReady));
      completeCreateRequests(data.completedCreateRequestIds);
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
  restoreSnapshotMaterials();
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
