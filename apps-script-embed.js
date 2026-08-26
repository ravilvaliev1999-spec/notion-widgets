(() => {
  'use strict';

  const DEPLOYMENT_URL = 'https://script.google.com/macros/s/AKfycbxrGUXhfRsvqjUrLSDFyhmjl3bJjbx-XtOjicHh7E7dAUVJW6Qi2F_K889ckvOCzu7KiQ/exec';
  const CREATE_COURIER_URL = 'https://ravilvaliev1999-spec.github.io/notion-widgets/create-courier.html';
  const SECTIONS = ['Drive', 'Docs', 'Sheets', 'Slides'];
  const widget = document.getElementById('widget');
  const interactionGrid = document.getElementById('interactionGrid');
  const fatal = document.getElementById('fatal');
  const createRequests = new Map();
  const embedNonce = randomId().replace(/-/g, '');
  let bridge = null;
  let noticeTimer = 0;
  let geometryRequestId = 0;
  let latestGeometryResponseId = 0;
  let lastGeometryAckAt = 0;

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
    if (!params || !bridge || !(bridge.actionReady || bridge.authoritative) || !['Docs', 'Sheets', 'Slides'].includes(section)) return '';
    const existing = createRequests.get(section);
    if (existing) return existing.href;
    try {
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
    return true;
  }

  function beginNativeCreate(record) {
    if (!record) return false;
    if (record.actionStarted) return true;
    record.actionStarted = true;
    if (sendToBridge({ type: 'notion-widget-v20-primary-action', section: record.section, requestId: record.requestId })) return true;
    record.actionStarted = false;
    return false;
  }


  function handleWidgetMessage(event) {
    const data = event.data;
    if (!data || data.embedNonce !== embedNonce || !isGoogleScriptOrigin(event.origin)) return;
    if (data.type === 'notion-widget-v20-bridge-ready') {
      if (!isWidgetDescendant(event.source) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(data.instanceId || ''))) return;
      bridge = { source: event.source, origin: event.origin, instanceId: data.instanceId, authoritative: data.authoritative === true, actionReady: data.actionReady === true, folderUrl: allowedDriveFolderUrl(data.folderUrl) };
      geometryRequestId = 0;
      latestGeometryResponseId = 0;
      lastGeometryAckAt = 0;
      applyPrimaryGeometry(data.geometry, data.viewport);
      fatal.hidden = true;
      document.body.classList.add('widget-ready');
      completeCreateRequests(data.completedCreateRequestIds);
      refreshAllControlHrefs();
      requestPrimaryGeometry();
      return;
    }
    if (!isCurrentBridgeEvent(event)) return;
    if (data.type === 'notion-widget-v20-primary-result' && validCreateRequestId(data.requestId) && data.ok === false) {
      createRequests.forEach((record) => {
        if (record.requestId !== String(data.requestId).toLowerCase()) return;
        record.actionStarted = false;record.lastNavigationAt = 0;
      });
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
  window.addEventListener('resize', refreshPrimaryGeometry);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshPrimaryGeometry(); });
  if (window.ResizeObserver) new ResizeObserver(refreshPrimaryGeometry).observe(widget);
  window.setInterval(runGeometryHeartbeat, 750);
  widget.src = `${DEPLOYMENT_URL}?${params.toString()}`;
})();
