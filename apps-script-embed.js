(() => {
  'use strict';

  const DEPLOYMENT_URL = 'https://script.google.com/macros/s/AKfycbxrGUXhfRsvqjUrLSDFyhmjl3bJjbx-XtOjicHh7E7dAUVJW6Qi2F_K889ckvOCzu7KiQ/exec';
  const SECTIONS = ['Drive', 'Docs', 'Sheets', 'Slides'];
  const widget = document.getElementById('widget');
  const interactionGrid = document.getElementById('interactionGrid');
  const fatal = document.getElementById('fatal');
  const pendingActions = new Map();
  const embedNonce = randomId().replace(/-/g, '');
  let bridge = null;
  let noticeTimer = 0;

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

  function applyPrimaryGeometry(value) {
    const rows = Array.isArray(value) ? value : [];
    if (rows.length !== SECTIONS.length) return false;
    const bySection = new Map(rows.map((row) => [row && row.section, row]));
    for (const section of SECTIONS) {
      const row = bySection.get(section);
      const numbers = row && [row.left, row.top, row.width, row.height].map(Number);
      const pencil = row && row.pencil;
      const pencilNumbers = pencil && [pencil.left, pencil.top, pencil.width, pencil.height].map(Number);
      if (!numbers || !pencilNumbers || numbers.concat(pencilNumbers).some((number) => !Number.isFinite(number) || Math.abs(number) > 100000) || numbers[2] < 40 || numbers[3] < 30 || pencilNumbers[2] < 16 || pencilNumbers[3] < 16) return false;
      const relativeLeft = pencilNumbers[0] - numbers[0];
      const relativeTop = pencilNumbers[1] - numbers[1];
      if (relativeLeft < 0 || relativeTop < 0 || relativeLeft + pencilNumbers[2] > numbers[2] || relativeTop + pencilNumbers[3] > numbers[3]) return false;
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

  function sendPending(record) {
    if (!bridge || record.sentInstance === bridge.instanceId) return;
    if (sendToBridge(record.message)) record.sentInstance = bridge.instanceId;
  }

  function sendAllPending() {
    pendingActions.forEach(sendPending);
  }

  function setSectionDisabled(section, disabled) {
    interactionGrid.querySelectorAll(`[data-section="${section}"]`).forEach((control) => { control.disabled = disabled; });
  }

  function allowedGoogleOpenUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        (url.hostname === 'docs.google.com' || url.hostname === 'drive.google.com');
    } catch (_error) {
      return false;
    }
  }

  function finishPrimaryAction(data) {
    const record = pendingActions.get(String(data.requestId || ''));
    if (!record) return;
    window.clearTimeout(record.timeout);
    pendingActions.delete(record.message.requestId);
    setSectionDisabled(record.message.section, false);
    if (data.ok && allowedGoogleOpenUrl(data.openUrl)) {
      try {
        record.popup.opener = null;
        record.popup.location.replace(data.openUrl);
      } catch (_error) {
        try { record.popup.close(); } catch (_closeError) {}
        showNotice('Файл создан. Нажмите его карточку, чтобы открыть.');
      }
      return;
    }
    try { record.popup.close(); } catch (_error) {}
    showNotice(String(data.message || 'Не удалось выполнить действие. Повторите ещё раз.'));
  }

  function handleWidgetMessage(event) {
    const data = event.data;
    if (!data || data.embedNonce !== embedNonce || !isGoogleScriptOrigin(event.origin)) return;
    if (data.type === 'notion-widget-v20-bridge-ready') {
      if (!isWidgetDescendant(event.source) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(data.instanceId || ''))) return;
      bridge = { source: event.source, origin: event.origin, instanceId: data.instanceId };
      interactionGrid.hidden = !applyPrimaryGeometry(data.geometry);
      fatal.hidden = true;
      sendAllPending();
      return;
    }
    if (!isCurrentBridgeEvent(event)) return;
    if (data.type === 'notion-widget-v20-primary-geometry') {
      applyPrimaryGeometry(data.geometry);
      return;
    }
    if (data.type === 'notion-widget-v20-primary-result') finishPrimaryAction(data);
  }

  function writePlaceholder(popup, section) {
    const label = section === 'Drive' ? 'Открываю папку…' : 'Создаю файл…';
    try {
      popup.document.open();
      popup.document.write(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${label}</title><body style="margin:0;background:#191919;color:#e6e6e4;font:14px system-ui;display:grid;place-items:center;min-height:100vh;text-align:center"><p role="status" style="margin:24px;max-width:340px">${label}</p></body></html>`);
      popup.document.close();
    } catch (_error) {}
  }

  function startPrimaryAction(section) {
    const existing = Array.from(pendingActions.values()).find((record) => record.message.section === section);
    if (!bridge || !SECTIONS.includes(section) || (existing && !existing.timedOut)) return;
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      showNotice('Браузер заблокировал новую вкладку. Разрешите всплывающие окна для Notion и повторите.');
      return;
    }
    writePlaceholder(popup, section);
    const requestId = existing ? existing.message.requestId : randomId();
    const message = existing ? existing.message : { type: 'notion-widget-v20-primary-action', requestId, section };
    const record = existing || { message, popup, sentInstance: '', timeout: 0, timedOut: false };
    record.popup = popup;
    record.sentInstance = '';
    record.timedOut = false;
    record.timeout = window.setTimeout(() => {
      if (!pendingActions.has(requestId)) return;
      record.timedOut = true;
      try { popup.close(); } catch (_error) {}
      setSectionDisabled(section, false);
      showNotice('Ответ не получен. Повторите нажатие — тот же запрос продолжится без создания дубля.');
    }, 410000);
    pendingActions.set(requestId, record);
    setSectionDisabled(section, true);
    sendPending(record);
  }

  function installInteractionControls() {
    interactionGrid.querySelectorAll('[data-slot]').forEach((slot) => {
      const section = slot.dataset.slot;
      if (!SECTIONS.includes(section)) return;
      ['main', 'pencil-top', 'pencil-right', 'pencil-bottom'].forEach((region, index) => {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = `primary-control primary-control-${region}`;
        control.dataset.section = section;
        if (index === 0) {
          control.setAttribute('aria-label', section === 'Drive' ? 'Открыть папку задачи' : `Создать новый файл ${section}`);
        } else {
          control.tabIndex = -1;
          control.setAttribute('aria-hidden', 'true');
        }
        control.addEventListener('click', () => startPrimaryAction(section));
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
  widget.src = `${DEPLOYMENT_URL}?${params.toString()}`;
})();
