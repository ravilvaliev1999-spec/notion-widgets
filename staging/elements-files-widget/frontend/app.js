(function () {
  "use strict";

  var SECTIONS = ["Drive", "Docs", "Sheets", "Slides"];
  var SECTION_KIND = { Drive: "file", Docs: "docs", Sheets: "sheets", Slides: "slides" };
  var SECTION_LABEL = { Drive: "Drive", Docs: "Docs", Sheets: "Sheets", Slides: "Slides" };
  var FORMAT_SHORT = {
    "Google Docs": "GDOC",
    Word: "DOCX",
    "Google Sheets": "GSHT",
    Excel: "XLSX",
    CSV: "CSV",
    "Google Slides": "GSLD",
    PowerPoint: "PPTX",
    Link: "URL",
    "Other File": "FILE"
  };
  var NATIVE_KIND = { Docs: "docs", Sheets: "sheets", Slides: "slides" };
  var MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
  var CACHE_VERSION = 1;
  var REFRESH_INTERVAL_MS = 60000;
  var HASH_CHUNK_BYTES = 4 * 1024 * 1024;

  var dom = {};
  var context = readContext();
  var state = {
    items: [],
    jobs: [],
    loaded: false,
    cachedAt: 0,
    refreshing: false,
    dragId: "",
    dragTargetId: "",
    dragTargetSection: "",
    addMode: "link",
    confirm: null,
    refreshTimer: null
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function readContext() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    var taskId = String(params.get("task") || "").replace(/-/g, "").toLowerCase();
    var access = String(params.get("access") || "");
    var referrerTaskId = extractNotionPageId(document.referrer);
    var configured = window.ELEMENTS_WIDGET_CONFIG && window.ELEMENTS_WIDGET_CONFIG.apiBase;
    var apiBase = window.location.origin;

    if (configured) {
      try {
        var configuredUrl = new URL(configured, window.location.origin);
        if (configuredUrl.origin === window.location.origin) apiBase = configuredUrl.href.replace(/\/$/, "");
      } catch (_) {
        apiBase = window.location.origin;
      }
    }

    return {
      taskId: taskId,
      access: access,
      apiBase: apiBase,
      validTask: /^[a-f0-9]{32}$/.test(taskId),
      validAccess: access.length >= 16 && access.length <= 4096,
      referrerTaskId: referrerTaskId,
      validBinding: !referrerTaskId || referrerTaskId === taskId
    };
  }

  function extractNotionPageId(referrer) {
    if (!referrer) return "";
    try {
      var url = new URL(referrer);
      if (!/(^|\.)notion\.(so|site|com)$/i.test(url.hostname)) return "";
      var idPattern = /[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig;
      var pathCandidates = url.pathname.match(idPattern);
      if (pathCandidates && pathCandidates.length) {
        return pathCandidates[pathCandidates.length - 1].replace(/-/g, "").toLowerCase();
      }
      var knownPageParams = ["p", "page", "page_id"];
      for (var index = 0; index < knownPageParams.length; index += 1) {
        var candidate = String(url.searchParams.get(knownPageParams[index]) || "");
        var match = candidate.match(idPattern);
        if (match && match.length) return match[match.length - 1].replace(/-/g, "").toLowerCase();
      }
      return "";
    } catch (_) {
      return "";
    }
  }

  function initDom() {
    dom.app = byId("app");
    dom.main = byId("widget-main");
    dom.syncStatus = byId("sync-status");
    dom.syncStatusText = byId("sync-status-text");
    dom.syncDetail = byId("sync-detail");
    dom.cacheAge = byId("cache-age");
    dom.networkBanner = byId("network-banner");
    dom.contextError = byId("context-error");
    dom.contextErrorTitle = byId("context-error-title");
    dom.contextErrorMessage = byId("context-error-message");
    dom.refreshButton = byId("refresh-button");
    dom.themeButton = byId("theme-button");
    dom.addButton = byId("add-button");
    dom.addDialog = byId("add-dialog");
    dom.addForm = byId("add-form");
    dom.addSection = byId("add-section");
    dom.linkUrl = byId("link-url");
    dom.linkName = byId("link-name");
    dom.fileInput = byId("file-input");
    dom.fileSelection = byId("file-selection");
    dom.addSubmit = byId("add-submit");
    dom.addFormError = byId("add-form-error");
    dom.editDialog = byId("edit-dialog");
    dom.editForm = byId("edit-form");
    dom.editRecordId = byId("edit-record-id");
    dom.editName = byId("edit-name");
    dom.editUrlRow = byId("edit-url-row");
    dom.editUrl = byId("edit-url");
    dom.editSection = byId("edit-section");
    dom.editFormat = byId("edit-format");
    dom.editSubmit = byId("edit-submit");
    dom.editFormError = byId("edit-form-error");
    dom.confirmDialog = byId("confirm-dialog");
    dom.confirmForm = byId("confirm-form");
    dom.confirmTitle = byId("confirm-dialog-title");
    dom.confirmMessage = byId("confirm-dialog-message");
    dom.confirmInputRow = byId("confirm-input-row");
    dom.confirmInput = byId("confirm-input");
    dom.confirmSubmit = byId("confirm-submit");
    dom.confirmError = byId("confirm-form-error");
    dom.toastRegion = byId("toast-region");
    dom.skeletonTemplate = byId("skeleton-template");
  }

  function initialise() {
    initDom();
    applySavedTheme();
    restoreExpandedState();
    bindEvents();
    updateNetworkState();

    if (!context.validBinding) {
      showContextError(
        "Виджет привязан к другой задаче",
        "Идентификатор страницы Notion не совпадает с задачей в защищённой ссылке. Обновите встраивание виджета для этой страницы."
      );
      setSync("danger", "Нужна перепривязка");
      renderEmpty();
      return;
    }

    if (!context.validTask || !context.validAccess) {
      showContextError(
        "Не хватает безопасного доступа",
        "Откройте виджет из страницы задачи: идентификатор задачи и временный доступ должны быть переданы после знака #."
      );
      setSync("danger", "Нет доступа");
      renderEmpty();
      return;
    }

    if (!hashSelfTest()) {
      showContextError("Проверка целостности недоступна", "Браузер не прошёл локальную проверку SHA-256. Загрузка файлов отключена.");
      setSync("danger", "Ошибка проверки");
      renderEmpty();
      return;
    }

    var cached = readCache();
    if (cached) {
      state.items = cached.items;
      state.cachedAt = cached.savedAt;
      state.loaded = true;
      render();
      setSync("warning", navigator.onLine ? "Проверка…" : "Локальная копия");
    } else {
      renderSkeletons();
    }

    refresh({ quiet: Boolean(cached) });
    state.refreshTimer = window.setInterval(function () {
      if (document.visibilityState === "visible" && navigator.onLine) refresh({ quiet: true });
    }, REFRESH_INTERVAL_MS);
    updateCacheAge();
    window.setInterval(updateCacheAge, 30000);
    postHeight();
  }

  function bindEvents() {
    dom.themeButton.addEventListener("click", cycleTheme);
    dom.refreshButton.addEventListener("click", function () { refresh({ quiet: false }); });
    dom.addButton.addEventListener("click", function () { openAddDialog("Drive", "link"); });

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeOpenMenus();
    });

    dom.addForm.addEventListener("submit", submitAddForm);
    dom.editForm.addEventListener("submit", submitEditForm);
    dom.confirmForm.addEventListener("submit", submitConfirmation);
    dom.fileInput.addEventListener("change", updateFileSelection);

    all("[data-add-mode]").forEach(function (button) {
      button.addEventListener("click", function () { setAddMode(button.dataset.addMode); });
    });

    all("dialog").forEach(function (dialog) {
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog) closeDialog(dialog);
      });
      dialog.addEventListener("close", function () {
        clearFormErrors();
        if (dialog === dom.confirmDialog) state.confirm = null;
      });
    });

    all("[data-list]").forEach(function (list) {
      list.addEventListener("dragstart", handleDragStart);
      list.addEventListener("dragend", clearDragState);
      list.addEventListener("dragover", handleDragOver);
      list.addEventListener("drop", handleDrop);
    });
    all("[data-drop-section]").forEach(function (panel) {
      panel.addEventListener("dragenter", handlePanelDragEnter);
      panel.addEventListener("dragover", handlePanelDragOver);
      panel.addEventListener("dragleave", handlePanelDragLeave);
      panel.addEventListener("drop", handlePanelDrop);
    });

    window.addEventListener("online", function () {
      updateNetworkState();
      toast("Соединение восстановлено", "success");
      refresh({ quiet: true });
    });
    window.addEventListener("offline", updateNetworkState);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && navigator.onLine) refresh({ quiet: true });
    });
    window.addEventListener("storage", function (event) {
      if (event.key === themeKey()) applySavedTheme();
    });

    if ("ResizeObserver" in window) {
      new ResizeObserver(postHeight).observe(document.documentElement);
    } else {
      window.addEventListener("resize", postHeight);
    }
  }

  function handleDocumentClick(event) {
    var closeButton = event.target.closest("[data-close-dialog]");
    if (closeButton) {
      closeDialog(byId(closeButton.dataset.closeDialog));
      return;
    }

    var toggle = event.target.closest("[data-toggle-section]");
    if (toggle) {
      toggleSection(toggle.dataset.toggleSection);
      return;
    }

    var add = event.target.closest("[data-add-section]");
    if (add) {
      openAddDialog(add.dataset.addSection, "file");
      return;
    }

    var primary = event.target.closest("[data-primary-section]");
    if (primary) {
      primaryAction(primary.dataset.primarySection);
      return;
    }

    var action = event.target.closest("[data-item-action]");
    if (action) {
      handleItemAction(action.dataset.itemAction, action.dataset.recordId);
      return;
    }

    if (!event.target.closest(".action-menu")) closeOpenMenus();
  }

  function showContextError(title, message) {
    dom.contextErrorTitle.textContent = title;
    dom.contextErrorMessage.textContent = message;
    dom.contextError.hidden = false;
    dom.addButton.disabled = true;
    dom.refreshButton.disabled = true;
    all("[data-primary-section], [data-add-section]").forEach(function (button) { button.disabled = true; });
  }

  function setSync(tone, textValue, detail) {
    dom.syncStatus.dataset.tone = tone;
    dom.syncStatusText.textContent = textValue;
    if (detail) dom.syncDetail.textContent = detail;
  }

  function updateNetworkState() {
    var offline = !navigator.onLine;
    dom.networkBanner.hidden = !offline;
    if (offline && state.loaded) setSync("warning", "Локальная копия");
  }

  function renderSkeletons() {
    SECTIONS.forEach(function (section) {
      var list = document.querySelector('[data-list="' + section + '"]');
      list.replaceChildren();
      for (var index = 0; index < 2; index += 1) {
        list.appendChild(dom.skeletonTemplate.content.cloneNode(true));
      }
      document.querySelector('[data-empty="' + section + '"]').hidden = true;
    });
  }

  function renderEmpty() {
    state.loaded = true;
    state.items = [];
    render();
  }

  function render() {
    SECTIONS.forEach(function (section) {
      var list = document.querySelector('[data-list="' + section + '"]');
      var items = state.items.filter(function (item) { return item.section === section; });
      var jobs = state.jobs.filter(function (job) { return job.section === section; });
      list.replaceChildren();
      items.forEach(function (item) { list.appendChild(renderItem(item)); });
      jobs.forEach(function (job) { list.appendChild(renderUploadJob(job)); });
      document.querySelector('[data-count="' + section + '"]').textContent = String(items.length + jobs.length);
      document.querySelector('[data-empty="' + section + '"]').hidden = items.length + jobs.length !== 0;
    });
    updateCacheAge();
    postHeight();
  }

  function renderItem(item) {
    var li = element("li", "file-item");
    li.dataset.recordId = item.id;
    li.draggable = true;

    var badge = element("span", "file-badge");
    badge.dataset.kind = badgeKind(item);
    badge.textContent = FORMAT_SHORT[item.format] || extensionLabel(item.name);
    badge.setAttribute("aria-hidden", "true");

    var main = element("button", "item-main");
    main.type = "button";
    main.dataset.itemAction = isDownloadable(item) ? "download" : "open";
    main.dataset.recordId = item.id;
    main.title = isDownloadable(item) ? "Скачать " + item.name : "Открыть " + item.name;

    var name = element("span", "item-name");
    name.textContent = item.name || "Без названия";
    var meta = element("span", "item-meta");
    meta.appendChild(textSpan(item.format || "Файл"));
    meta.appendChild(separator());
    meta.appendChild(textSpan(metadataLabel(item)));
    main.append(name, meta);

    var actions = element("div", "item-actions");
    var quick = iconButton(isDownloadable(item) ? "download" : "open", item.id, isDownloadable(item) ? "Скачать" : "Открыть", isDownloadable(item) ? "download" : "external");
    actions.appendChild(quick);

    var menu = element("details", "action-menu");
    var summary = document.createElement("summary");
    summary.setAttribute("aria-label", "Действия с " + (item.name || "файлом"));
    var dots = element("span", "more-dots");
    dots.textContent = "···";
    summary.appendChild(dots);
    var popover = element("div", "action-popover");
    appendAction(popover, "edit", item.id, "Переименовать и изменить");
    appendAction(popover, "move-up", item.id, "Поднять выше");
    appendAction(popover, "move-down", item.id, "Опустить ниже");
    appendAction(popover, isDownloadable(item) ? "download" : "open", item.id, isDownloadable(item) ? "Скачать" : "Открыть");
    popover.appendChild(element("span", "action-divider"));
    appendAction(popover, "archive", item.id, "Архивировать");
    appendAction(popover, "unlink", item.id, "Отвязать от задачи");
    if (canPhysicallyDelete(item)) appendAction(popover, "physical-delete", item.id, "Переместить файл в корзину", true);
    menu.append(summary, popover);
    actions.appendChild(menu);

    li.append(badge, main, actions);
    return li;
  }

  function renderUploadJob(job) {
    var li = element("li", "file-item upload-item");
    li.dataset.jobId = job.id;
    var badge = element("span", "file-badge");
    badge.dataset.kind = SECTION_KIND[job.section] || "file";
    badge.textContent = extensionLabel(job.name);

    var copy = element("div", "upload-copy");
    var name = element("span", "upload-name");
    name.textContent = job.name;
    var meta = element("span", "item-meta");
    meta.appendChild(textSpan(job.stage));
    meta.appendChild(separator());
    meta.appendChild(textSpan(Math.round(job.progress * 100) + "%"));
    var progress = element("progress", "upload-progress");
    progress.max = 1;
    progress.value = Math.max(0, Math.min(1, job.progress));
    progress.setAttribute("aria-label", job.stage + ": " + job.name);
    copy.append(name, meta, progress);

    var controls = element("div", "item-actions");
    if (job.retryable) {
      var retry = element("button", "item-icon-button");
      retry.type = "button";
      retry.dataset.itemAction = "retry-upload";
      retry.dataset.recordId = job.id;
      retry.setAttribute("aria-label", "Повторить загрузку " + job.name);
      retry.textContent = "↻";
      controls.appendChild(retry);
    }
    var cancel = element("button", "item-icon-button");
    cancel.type = "button";
    cancel.dataset.itemAction = "cancel-upload";
    cancel.dataset.recordId = job.id;
    cancel.setAttribute("aria-label", "Отменить загрузку " + job.name);
    cancel.textContent = "×";
    controls.appendChild(cancel);
    li.append(badge, copy, controls);
    return li;
  }

  function element(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function textSpan(value) {
    var span = document.createElement("span");
    span.textContent = value;
    return span;
  }

  function separator() {
    var span = element("span", "meta-separator");
    span.textContent = "•";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  function iconButton(action, recordId, label, icon) {
    var button = element("button", "item-icon-button");
    button.type = "button";
    button.dataset.itemAction = action;
    button.dataset.recordId = recordId;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.appendChild(makeIcon(icon));
    return button;
  }

  function makeIcon(kind) {
    var paths = {
      external: ["M14 5h5v5", "M10 14 19 5", "M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"],
      download: ["M12 4v11", "m7 10 5 5 5-5", "M5 20h14"]
    };
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    (paths[kind] || paths.external).forEach(function (pathValue) {
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathValue);
      svg.appendChild(path);
    });
    return svg;
  }

  function appendAction(parent, action, recordId, label, danger) {
    var button = document.createElement("button");
    button.type = "button";
    button.dataset.itemAction = action;
    button.dataset.recordId = recordId;
    if (danger) button.dataset.danger = "true";
    button.textContent = label;
    parent.appendChild(button);
  }

  function badgeKind(item) {
    if (item.format === "Link") return "link";
    if (/Docs|Word/.test(item.format || "")) return "docs";
    if (/Sheets|Excel|CSV/.test(item.format || "")) return "sheets";
    if (/Slides|PowerPoint/.test(item.format || "")) return "slides";
    return SECTION_KIND[item.section] || "file";
  }

  function extensionLabel(name) {
    var match = String(name || "").match(/\.([a-z0-9]{1,5})$/i);
    return match ? match[1].slice(0, 4).toUpperCase() : "FILE";
  }

  function metadataLabel(item) {
    if (item.provider === "External URL") {
      try { return new URL(item.url).hostname; } catch (_) { return "HTTPS-ссылка"; }
    }
    if (Number.isFinite(item.size)) return formatBytes(item.size);
    return item.provider || "Google Drive";
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return bytes + " Б";
    var units = ["КБ", "МБ", "ГБ"];
    var value = bytes;
    var unit = -1;
    do {
      value /= 1024;
      unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return value.toLocaleString("ru-RU", { maximumFractionDigits: value >= 10 ? 1 : 2 }) + " " + units[unit];
  }

  function isNative(item) {
    return String(item.mimeType || "").indexOf("application/vnd.google-apps.") === 0 ||
      /^Google (Docs|Sheets|Slides)$/.test(item.format || "");
  }

  function isDownloadable(item) {
    return item.provider === "Google Drive" && Boolean(item.googleFileId) && !isNative(item);
  }

  function canPhysicallyDelete(item) {
    return item.provider === "Google Drive" && Boolean(item.googleFileId);
  }

  async function refresh(options) {
    if (state.refreshing || !context.validTask || !context.validAccess || !context.validBinding || !navigator.onLine) return;
    state.refreshing = true;
    dom.refreshButton.disabled = true;
    dom.refreshButton.setAttribute("aria-busy", "true");
    if (!options.quiet) setSync("neutral", "Обновление…");
    try {
      var payload = await api("/api/v1/tasks/" + context.taskId + "/files");
      if (!payload || !Array.isArray(payload.items)) throw new WidgetError("invalid_response", "Сервер вернул неизвестный формат списка.");
      state.items = normaliseItems(payload.items);
      state.cachedAt = Date.now();
      state.loaded = true;
      writeCache();
      render();
      setSync("success", "Синхронизировано", "Каталог sandbox «Элементы»");
    } catch (error) {
      handleError(error, state.loaded ? "Показана последняя локальная копия." : "Не удалось получить список файлов.");
      if (!state.loaded) renderEmpty();
    } finally {
      state.refreshing = false;
      dom.refreshButton.disabled = false;
      dom.refreshButton.removeAttribute("aria-busy");
    }
  }

  function normaliseItems(items) {
    return items
      .map(sanitiseItem)
      .filter(function (item) { return item && SECTIONS.indexOf(item.section) !== -1; })
      .sort(function (a, b) {
        var positionA = Number.isFinite(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
        var positionB = Number.isFinite(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
        return positionA - positionB || a.name.localeCompare(b.name, "ru");
      });
  }

  function sanitiseItem(raw) {
    if (!raw || !/^[a-f0-9]{32}$/i.test(String(raw.id || "").replace(/-/g, ""))) return null;
    return {
      id: String(raw.id).replace(/-/g, "").toLowerCase(),
      name: String(raw.name || "Без названия").slice(0, 240),
      taskId: String(raw.taskId || "").replace(/-/g, "").toLowerCase(),
      section: String(raw.section || "Drive"),
      format: String(raw.format || "Other File"),
      provider: String(raw.provider || ""),
      googleFileId: String(raw.googleFileId || "").slice(0, 300),
      googleFolderId: String(raw.googleFolderId || "").slice(0, 300),
      position: raw.position === null || raw.position === undefined || raw.position === "" ? null : Number(raw.position),
      status: String(raw.status || "active"),
      url: String(raw.url || "").slice(0, 4096),
      mimeType: String(raw.mimeType || "").slice(0, 180),
      size: raw.size === null || raw.size === undefined ? null : Number(raw.size),
      sha256: /^[a-f0-9]{64}$/i.test(String(raw.sha256 || "")) ? String(raw.sha256).toLowerCase() : "",
      md5: /^[a-f0-9]{32}$/i.test(String(raw.md5 || "")) ? String(raw.md5).toLowerCase() : "",
      notionUrl: String(raw.notionUrl || "").slice(0, 4096),
      lastEditedTime: String(raw.lastEditedTime || "").slice(0, 80)
    };
  }

  function api(path, options) {
    options = options || {};
    if (!context.validTask || !context.validAccess || !context.validBinding) {
      return Promise.reject(new WidgetError("invalid_task_binding", "Запрос заблокирован: виджет не привязан к текущей странице Notion."));
    }
    var headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + context.access);
    headers.set("Accept", "application/json");
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    var controller = new AbortController();
    var timedOut = false;
    var externalSignal = options.signal;
    var abortFromExternal = function () { controller.abort(); };
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
    var timeout = window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, options.timeout || 30000);
    return fetch(apiUrl(path), {
      method: options.method || "GET",
      headers: headers,
      body: options.body,
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    }).then(async function (response) {
      window.clearTimeout(timeout);
      var data = null;
      try { data = await response.json(); } catch (_) { data = null; }
      if (!response.ok) {
        var errorPayload = data && data.error && typeof data.error === "object" ? data.error : data;
        var detail = errorPayload && (errorPayload.message || errorPayload.code);
        throw new WidgetError(errorPayload && errorPayload.code || "http_" + response.status, detail || "Ошибка сервера (" + response.status + ").", response.status);
      }
      return data;
    }).catch(function (error) {
      window.clearTimeout(timeout);
      if (error && error.name === "AbortError" && timedOut) throw new WidgetError("timeout", "Сервер не ответил вовремя.");
      throw error;
    }).finally(function () {
      if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
    });
  }

  function apiUrl(path) {
    var url = new URL(path, context.apiBase + "/");
    if (url.origin !== window.location.origin) throw new WidgetError("unsafe_api_origin", "Запрос к неизвестному серверу заблокирован.");
    return url.href;
  }

  function WidgetError(code, message, status) {
    this.name = "WidgetError";
    this.code = code;
    this.message = message;
    this.status = status || 0;
  }
  WidgetError.prototype = Object.create(Error.prototype);

  function handleError(error, fallback) {
    var message = error && error.message ? error.message : fallback;
    if (!navigator.onLine) {
      setSync("warning", "Локальная копия");
      return;
    }
    setSync("danger", "Ошибка синхронизации");
    toast(message || fallback, "danger", 6500);
  }

  function primaryAction(section) {
    if (section === "Drive") {
      var folder = state.items.find(function (item) { return item.googleFolderId; });
      if (folder) {
        safeOpen("https://drive.google.com/drive/folders/" + encodeURIComponent(folder.googleFolderId));
      } else {
        openAddDialog("Drive", "file");
      }
      return;
    }
    createNative(section);
  }

  async function createNative(section) {
    var kind = NATIVE_KIND[section];
    if (!kind) return;
    var placeholder = openPlaceholder();
    var operationSlot = "native:" + kind;
    var operationFingerprint = JSON.stringify({ kind: kind });
    var idempotencyKey = pendingIdempotencyKey(operationSlot, operationFingerprint);
    setSync("neutral", "Создание…");
    try {
      var payload = await api("/api/v1/tasks/" + context.taskId + "/google-native", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ kind: kind, idempotencyKey: idempotencyKey })
      });
      var item = payload && payload.item;
      if (item) {
        var normalisedItem = sanitiseItem(item);
        if (normalisedItem) {
          upsertItem(normalisedItem);
          writeCache();
          render();
        }
      }
      var url = item && item.url;
      if (placeholder && isSafeOpenUrl(url)) {
        placeholder.location.replace(url);
      } else {
        if (placeholder) placeholder.close();
        if (url) safeOpen(url);
      }
      toast("Создан новый " + SECTION_LABEL[section], "success");
      clearPendingOperation(operationSlot, operationFingerprint);
      await refresh({ quiet: true });
    } catch (error) {
      if (error && error.code === "idempotency_conflict") clearPendingOperation(operationSlot, operationFingerprint);
      if (placeholder) placeholder.close();
      handleError(error, "Не удалось создать Google-файл.");
    }
  }

  function openPlaceholder() {
    var opened = window.open("", "_blank");
    if (opened) {
      try {
        opened.opener = null;
        opened.document.title = "Создание файла…";
        opened.document.body.textContent = "Создаём файл в защищённой папке задачи…";
      } catch (_) {}
    }
    return opened;
  }

  function handleItemAction(action, recordId) {
    closeOpenMenus();
    if (action === "cancel-upload") {
      cancelUpload(recordId);
      return;
    }
    if (action === "retry-upload") {
      retryUpload(recordId);
      return;
    }
    var item = state.items.find(function (candidate) { return candidate.id === recordId; });
    if (!item) return;
    if (action === "open") openItem(item);
    else if (action === "download") downloadItem(item);
    else if (action === "edit") openEditDialog(item);
    else if (action === "move-up") moveItem(item, -1);
    else if (action === "move-down") moveItem(item, 1);
    else if (action === "archive") openConfirmation(item, "archive");
    else if (action === "unlink") openConfirmation(item, "unlink");
    else if (action === "physical-delete") openConfirmation(item, "physical-delete");
  }

  function openItem(item) {
    if (!isSafeOpenUrl(item.url)) {
      toast("Безопасная ссылка для открытия отсутствует.", "warning");
      return;
    }
    safeOpen(item.url);
  }

  async function downloadItem(item) {
    if (!isDownloadable(item)) {
      openItem(item);
      return;
    }
    var placeholder = openPlaceholder();
    try {
      var payload = await api("/api/v1/tasks/" + context.taskId + "/files/" + item.id + "/download-link", { method: "POST" });
      if (!payload || !isSafeDownloadUrl(payload.url)) throw new WidgetError("unsafe_download_url", "Сервер вернул небезопасную ссылку загрузки.");
      if (placeholder) placeholder.location.replace(payload.url);
      else safeOpen(payload.url, true);
    } catch (error) {
      if (placeholder) placeholder.close();
      handleError(error, "Не удалось подготовить скачивание.");
    }
  }

  function isSafeOpenUrl(value) {
    try {
      var url = new URL(value);
      return url.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  function isSafeDownloadUrl(value) {
    try {
      var url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && /^\/api\/v1\/download\/[a-f0-9]{32}$/i.test(url.pathname) && Boolean(url.searchParams.get("access"));
    } catch (_) {
      return false;
    }
  }

  function safeOpen(value) {
    if (!isSafeOpenUrl(value) && !isSafeDownloadUrl(value)) {
      toast("Переход по небезопасной ссылке заблокирован.", "danger");
      return;
    }
    var opened = window.open(value, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  }

  function openAddDialog(section, mode) {
    if (!context.validTask || !context.validAccess || !context.validBinding) return;
    dom.addForm.reset();
    dom.addSection.value = SECTIONS.indexOf(section) === -1 ? "Drive" : section;
    setAddMode(mode || "link");
    updateFileSelection();
    clearFormErrors();
    showDialog(dom.addDialog);
    window.setTimeout(function () {
      if (state.addMode === "link") dom.linkUrl.focus();
      else dom.fileInput.focus();
    }, 0);
  }

  function setAddMode(mode) {
    state.addMode = mode === "file" ? "file" : "link";
    all("[data-add-mode]").forEach(function (button) {
      button.setAttribute("aria-selected", String(button.dataset.addMode === state.addMode));
    });
    all("[data-add-pane]").forEach(function (pane) {
      pane.hidden = pane.dataset.addPane !== state.addMode;
    });
    dom.linkUrl.required = state.addMode === "link";
    dom.addSubmit.textContent = state.addMode === "link" ? "Добавить ссылку" : "Загрузить";
  }

  function updateFileSelection() {
    var files = Array.prototype.slice.call(dom.fileInput.files || []);
    if (!files.length) dom.fileSelection.textContent = "Файлы не выбраны";
    else if (files.length === 1) dom.fileSelection.textContent = files[0].name + " · " + formatBytes(files[0].size);
    else dom.fileSelection.textContent = "Выбрано файлов: " + files.length;
  }

  async function submitAddForm(event) {
    event.preventDefault();
    clearFormErrors();
    if (state.addMode === "file") {
      var files = Array.prototype.slice.call(dom.fileInput.files || []);
      if (!files.length) {
        showFormError(dom.addFormError, "Выберите хотя бы один файл.");
        return;
      }
      var section = dom.addSection.value;
      closeDialog(dom.addDialog);
      files.forEach(function (file) { queueUpload(file, section); });
      return;
    }

    var url;
    try {
      url = new URL(dom.linkUrl.value.trim());
      if (url.protocol !== "https:") throw new Error("not_https");
    } catch (_) {
      showFormError(dom.addFormError, "Укажите полную HTTPS-ссылку.");
      dom.linkUrl.focus();
      return;
    }

    setFormBusy(dom.addForm, true);
    var linkInput = { url: url.href, name: dom.linkName.value.trim() || "", section: dom.addSection.value };
    var operationSlot = "link";
    var operationFingerprint = JSON.stringify(linkInput);
    var idempotencyKey = pendingIdempotencyKey(operationSlot, operationFingerprint);
    try {
      var payload = await api("/api/v1/tasks/" + context.taskId + "/links", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          url: url.href,
          name: dom.linkName.value.trim() || undefined,
          section: dom.addSection.value,
          idempotencyKey: idempotencyKey
        })
      });
      var normalisedLink = sanitiseItem(payload && payload.item);
      if (normalisedLink) upsertItem(normalisedLink);
      writeCache();
      render();
      closeDialog(dom.addDialog);
      toast("Ссылка добавлена", "success");
      clearPendingOperation(operationSlot, operationFingerprint);
      await refresh({ quiet: true });
    } catch (error) {
      if (error && error.code === "idempotency_conflict") clearPendingOperation(operationSlot, operationFingerprint);
      showFormError(dom.addFormError, error.message || "Не удалось добавить ссылку.");
    } finally {
      setFormBusy(dom.addForm, false);
    }
  }

  function queueUpload(file, section) {
    if (!(file instanceof File)) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast(file.name + ": файл больше 512 МБ.", "danger", 6500);
      return;
    }
    var targetSection = SECTIONS.indexOf(section) === -1 ? classifySection(file) : section;
    var operationFingerprint = JSON.stringify({ name: file.name, size: file.size, type: file.type || "application/octet-stream", lastModified: file.lastModified, section: targetSection });
    var operationSlot = "upload:" + stableStringHash(operationFingerprint);
    if (state.jobs.some(function (candidate) { return candidate.operationSlot === operationSlot && candidate.operationFingerprint === operationFingerprint; })) {
      toast(file.name + ": эта загрузка уже в очереди.", "warning");
      return;
    }
    var job = {
      id: "upload-" + randomId(),
      file: file,
      name: file.name,
      section: targetSection,
      operationSlot: operationSlot,
      operationFingerprint: operationFingerprint,
      idempotencyKey: pendingIdempotencyKey(operationSlot, operationFingerprint),
      stage: "Подготовка",
      progress: 0,
      aborted: false,
      controller: new AbortController(),
      xhr: null,
      retryable: false
    };
    state.jobs.push(job);
    render();
    runUpload(job);
  }

  async function runUpload(job) {
    try {
      job.retryable = false;
      job.stage = "SHA-256";
      render();
      var sha256 = await hashFile(job.file, job);
      if (job.aborted) return;
      job.stage = "Создание сессии";
      job.progress = Math.max(job.progress, 0.28);
      render();
      var initiation = await api("/api/v1/tasks/" + context.taskId + "/uploads", {
        method: "POST",
        headers: { "Idempotency-Key": job.idempotencyKey },
        body: JSON.stringify({
          name: job.file.name,
          mimeType: job.file.type || "application/octet-stream",
          size: job.file.size,
          sha256: sha256,
          idempotencyKey: job.idempotencyKey
        }),
        signal: job.controller.signal,
        timeout: 60000
      });
      if (job.aborted) return;

      var record;
      if (initiation.completed && initiation.record) {
        record = initiation.record;
      } else {
        if (!initiation.uploadToken) throw new WidgetError("missing_upload_token", "Сервер не выдал безопасную сессию загрузки.");
        job.stage = "Загрузка";
        job.progress = 0.3;
        render();
        var completion = await uploadBinary(job, initiation.uploadToken);
        record = completion && completion.record;
      }
      if (!record) throw new WidgetError("missing_upload_record", "Сервер не вернул карточку загруженного файла.");
      var normalised = sanitiseItem(record);
      if (normalised && normalised.section !== job.section) {
        var patched = await api("/api/v1/tasks/" + context.taskId + "/files/" + normalised.id, {
          method: "PATCH",
          body: JSON.stringify({ section: job.section })
        });
        normalised = sanitiseItem(patched && patched.item || patched || normalised);
      }
      removeJob(job.id);
      clearPendingOperation(job.operationSlot, job.operationFingerprint);
      if (normalised) upsertItem(normalised);
      writeCache();
      render();
      toast(job.name + " загружен и проверен", "success");
      await refresh({ quiet: true });
    } catch (error) {
      if (job.aborted || error.name === "AbortError") {
        clearPendingOperation(job.operationSlot, job.operationFingerprint);
        removeJob(job.id);
        render();
        toast("Загрузка отменена: " + job.name, "warning");
      } else {
        if (error && error.code === "idempotency_conflict") {
          clearPendingOperation(job.operationSlot, job.operationFingerprint);
          job.idempotencyKey = pendingIdempotencyKey(job.operationSlot, job.operationFingerprint);
        }
        job.retryable = true;
        job.stage = "Ошибка — повторить";
        job.progress = Math.min(job.progress, 0.98);
        job.controller = new AbortController();
        job.xhr = null;
        render();
        handleError(error, "Не удалось загрузить " + job.name + ".");
      }
    }
  }

  function uploadBinary(job, uploadToken) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      job.xhr = xhr;
      xhr.open("PUT", apiUrl("/api/v1/tasks/" + context.taskId + "/uploads"));
      xhr.responseType = "json";
      xhr.timeout = 30 * 60 * 1000;
      xhr.setRequestHeader("Authorization", "Bearer " + context.access);
      xhr.setRequestHeader("X-Upload-Token", uploadToken);
      xhr.setRequestHeader("Content-Type", job.file.type || "application/octet-stream");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.addEventListener("progress", function (event) {
        if (!event.lengthComputable) return;
        job.progress = 0.3 + (event.loaded / event.total) * 0.68;
        render();
      });
      xhr.addEventListener("load", function () {
        job.xhr = null;
        var payload = xhr.response;
        if (typeof payload === "string") {
          try { payload = JSON.parse(payload); } catch (_) { payload = null; }
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          job.progress = 1;
          resolve(payload);
        } else {
          var errorPayload = payload && payload.error && typeof payload.error === "object" ? payload.error : payload;
          reject(new WidgetError(errorPayload && errorPayload.code || "upload_http_" + xhr.status, errorPayload && (errorPayload.message || errorPayload.code) || "Ошибка загрузки (" + xhr.status + ").", xhr.status));
        }
      });
      xhr.addEventListener("error", function () { reject(new WidgetError("upload_network", "Сеть прервала загрузку файла.")); });
      xhr.addEventListener("timeout", function () { reject(new WidgetError("upload_timeout", "Загрузка не завершилась вовремя.")); });
      xhr.addEventListener("abort", function () { reject(new DOMException("Upload aborted", "AbortError")); });
      xhr.send(job.file);
    });
  }

  function cancelUpload(jobId) {
    var job = state.jobs.find(function (candidate) { return candidate.id === jobId; });
    if (!job) return;
    job.aborted = true;
    job.controller.abort();
    if (job.xhr) job.xhr.abort();
    clearPendingOperation(job.operationSlot, job.operationFingerprint);
    removeJob(jobId);
    render();
  }

  function retryUpload(jobId) {
    var job = state.jobs.find(function (candidate) { return candidate.id === jobId; });
    if (!job || !job.retryable) return;
    job.aborted = false;
    job.retryable = false;
    job.stage = "Повторная попытка";
    job.controller = new AbortController();
    job.xhr = null;
    render();
    runUpload(job);
  }

  function removeJob(jobId) {
    state.jobs = state.jobs.filter(function (job) { return job.id !== jobId; });
  }

  function classifySection(file) {
    var name = file.name.toLowerCase();
    var type = String(file.type || "");
    if (/\.(doc|docx|odt|rtf|txt|md|pdf)$/.test(name) || /^text\//.test(type)) return "Docs";
    if (/\.(xls|xlsx|ods|csv|tsv)$/.test(name) || /spreadsheet|csv/.test(type)) return "Sheets";
    if (/\.(ppt|pptx|odp|key)$/.test(name) || /presentation|powerpoint/.test(type)) return "Slides";
    return "Drive";
  }

  async function hashFile(file, job) {
    var hasher = new Sha256();
    var offset = 0;
    if (file.size === 0) return hasher.hex();
    while (offset < file.size) {
      if (job.aborted) throw new DOMException("Hashing aborted", "AbortError");
      var end = Math.min(offset + HASH_CHUNK_BYTES, file.size);
      var bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      hasher.update(bytes);
      offset = end;
      job.progress = (offset / file.size) * 0.26;
      render();
      await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
    }
    return hasher.hex();
  }

  function Sha256() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.finished = false;
  }

  Sha256.K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);

  Sha256.prototype.update = function (data) {
    if (this.finished) throw new Error("SHA-256 already finalised");
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bytesHashed += bytes.length;
    var position = 0;
    while (position < bytes.length) {
      var take = Math.min(bytes.length - position, 64 - this.bufferLength);
      this.buffer.set(bytes.subarray(position, position + take), this.bufferLength);
      this.bufferLength += take;
      position += take;
      if (this.bufferLength === 64) {
        this.process(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  };

  Sha256.prototype.process = function (chunk) {
    var words = new Uint32Array(64);
    var index;
    for (index = 0; index < 16; index += 1) {
      var offset = index * 4;
      words[index] = ((chunk[offset] << 24) | (chunk[offset + 1] << 16) | (chunk[offset + 2] << 8) | chunk[offset + 3]) >>> 0;
    }
    for (index = 16; index < 64; index += 1) {
      var x = words[index - 15];
      var y = words[index - 2];
      var s0 = (rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)) >>> 0;
      var s1 = (rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)) >>> 0;
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    var a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3];
    var e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];
    for (index = 0; index < 64; index += 1) {
      var sigma1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      var choice = ((e & f) ^ (~e & g)) >>> 0;
      var temp1 = (h + sigma1 + choice + Sha256.K[index] + words[index]) >>> 0;
      var sigma0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      var majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var temp2 = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  };

  Sha256.prototype.hex = function () {
    if (!this.finished) {
      var bitLength = this.bytesHashed * 8;
      this.buffer[this.bufferLength] = 0x80;
      this.bufferLength += 1;
      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength);
        this.process(this.buffer);
        this.bufferLength = 0;
      }
      this.buffer.fill(0, this.bufferLength, 56);
      var high = Math.floor(bitLength / 0x100000000);
      var low = bitLength >>> 0;
      this.buffer[56] = high >>> 24;
      this.buffer[57] = high >>> 16;
      this.buffer[58] = high >>> 8;
      this.buffer[59] = high;
      this.buffer[60] = low >>> 24;
      this.buffer[61] = low >>> 16;
      this.buffer[62] = low >>> 8;
      this.buffer[63] = low;
      this.process(this.buffer);
      this.finished = true;
    }
    var output = "";
    for (var index = 0; index < this.h.length; index += 1) output += this.h[index].toString(16).padStart(8, "0");
    return output;
  };

  function rotateRight(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function hashSelfTest() {
    try {
      var result = new Sha256().update(new TextEncoder().encode("abc")).hex();
      return result === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    } catch (_) {
      return false;
    }
  }

  function openEditDialog(item) {
    dom.editRecordId.value = item.id;
    dom.editName.value = item.name;
    dom.editUrlRow.hidden = item.provider !== "External URL";
    dom.editUrl.required = item.provider === "External URL";
    dom.editUrl.value = item.provider === "External URL" ? item.url : "";
    dom.editSection.value = item.section;
    dom.editFormat.value = FORMAT_SHORT[item.format] ? item.format : "Other File";
    clearFormErrors();
    showDialog(dom.editDialog);
    window.setTimeout(function () { dom.editName.select(); }, 0);
  }

  async function submitEditForm(event) {
    event.preventDefault();
    clearFormErrors();
    var id = dom.editRecordId.value;
    var item = state.items.find(function (candidate) { return candidate.id === id; });
    if (!item) return;
    var name = dom.editName.value.trim();
    if (!name) {
      showFormError(dom.editFormError, "Название не может быть пустым.");
      return;
    }
    setFormBusy(dom.editForm, true);
    try {
      var changes = { name: name, section: dom.editSection.value, format: dom.editFormat.value };
      if (item.provider === "External URL") {
        if (!/^https:\/\//i.test(dom.editUrl.value.trim())) {
          showFormError(dom.editFormError, "Новая ссылка должна начинаться с https://");
          return;
        }
        changes.url = dom.editUrl.value.trim();
      }
      var payload = await api("/api/v1/tasks/" + context.taskId + "/files/" + id, {
        method: "PATCH",
        body: JSON.stringify(changes)
      });
      var updated = sanitiseItem(payload && payload.item || payload);
      if (updated) replaceItem(updated);
      writeCache();
      render();
      closeDialog(dom.editDialog);
      toast("Изменения сохранены", "success");
      await refresh({ quiet: true });
    } catch (error) {
      showFormError(dom.editFormError, error.message || "Не удалось сохранить изменения.");
    } finally {
      setFormBusy(dom.editForm, false);
    }
  }

  function openConfirmation(item, action) {
    var definitions = {
      archive: {
        title: "Архивировать карточку?",
        message: "Карточка «" + item.name + "» исчезнет из виджета. Сам файл или ссылка останутся на месте.",
        button: "Архивировать",
        typed: false
      },
      unlink: {
        title: "Отвязать от задачи?",
        message: "Связь карточки «" + item.name + "» с текущей задачей будет удалена. Сам материал не удаляется.",
        button: "Отвязать",
        typed: false
      },
      "physical-delete": {
        title: "Переместить файл в корзину Drive?",
        message: "Физический файл «" + item.name + "» будет перемещён в корзину из защищённой папки задачи. Карточка исчезнет из виджета.",
        button: "Переместить в корзину",
        typed: true
      }
    };
    var definition = definitions[action];
    if (!definition) return;
    state.confirm = { item: item, action: action, typed: definition.typed };
    dom.confirmTitle.textContent = definition.title;
    dom.confirmMessage.textContent = definition.message;
    dom.confirmSubmit.textContent = definition.button;
    dom.confirmInputRow.hidden = !definition.typed;
    dom.confirmInput.value = "";
    clearFormErrors();
    showDialog(dom.confirmDialog);
    if (definition.typed) window.setTimeout(function () { dom.confirmInput.focus(); }, 0);
  }

  async function submitConfirmation(event) {
    event.preventDefault();
    clearFormErrors();
    if (!state.confirm) return;
    var current = state.confirm;
    if (current.typed && dom.confirmInput.value !== current.item.name) {
      showFormError(dom.confirmError, "Введите название точно: " + current.item.name);
      return;
    }
    setFormBusy(dom.confirmForm, true);
    try {
      if (current.action === "physical-delete") {
        var intent = await api("/api/v1/tasks/" + context.taskId + "/files/" + current.item.id + "/physical-delete-intent", { method: "POST" });
        if (!intent || !intent.deleteToken || !intent.item || intent.item.name !== current.item.name) {
          throw new WidgetError("invalid_delete_intent", "Сервер не подтвердил точное имя удаляемого файла.");
        }
        await api("/api/v1/tasks/" + context.taskId + "/files/" + current.item.id + "/physical-delete", {
          method: "POST",
          headers: { "X-Delete-Token": intent.deleteToken }
        });
      } else {
        await api("/api/v1/tasks/" + context.taskId + "/files/" + current.item.id + "/" + current.action, { method: "POST" });
      }
      state.items = state.items.filter(function (item) { return item.id !== current.item.id; });
      writeCache();
      render();
      closeDialog(dom.confirmDialog);
      var labels = { archive: "Карточка архивирована", unlink: "Материал отвязан", "physical-delete": "Файл перемещён в корзину" };
      toast(labels[current.action], "success");
      await refresh({ quiet: true });
    } catch (error) {
      showFormError(dom.confirmError, error.message || "Действие не выполнено.");
    } finally {
      setFormBusy(dom.confirmForm, false);
    }
  }

  function moveItem(item, delta) {
    var previous = state.items.slice();
    var sectionItems = state.items.filter(function (candidate) { return candidate.section === item.section; });
    var currentIndex = sectionItems.findIndex(function (candidate) { return candidate.id === item.id; });
    var nextIndex = currentIndex + delta;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sectionItems.length) {
      toast(delta < 0 ? "Карточка уже первая" : "Карточка уже последняя", "neutral");
      return;
    }
    var swap = sectionItems[currentIndex];
    sectionItems[currentIndex] = sectionItems[nextIndex];
    sectionItems[nextIndex] = swap;
    applySectionOrder(item.section, sectionItems);
    persistOrder(previous);
  }

  function applySectionOrder(section, ordered) {
    var map = new Map(ordered.map(function (item, index) { return [item.id, index]; }));
    var rebuilt = [];
    SECTIONS.forEach(function (sectionName) {
      var group = state.items.filter(function (item) { return item.section === sectionName; });
      if (sectionName === section) group.sort(function (a, b) { return map.get(a.id) - map.get(b.id); });
      rebuilt = rebuilt.concat(group);
    });
    state.items = rebuilt;
    render();
  }

  async function persistOrder(previousItems) {
    var rollback = previousItems || state.items.slice();
    var ids = state.items.map(function (item) { return item.id; });
    try {
      var payload = await api("/api/v1/tasks/" + context.taskId + "/order", {
        method: "PATCH",
        body: JSON.stringify({ ids: ids })
      });
      if (payload && Array.isArray(payload.items)) state.items = normaliseItems(payload.items);
      writeCache();
      render();
    } catch (error) {
      state.items = rollback;
      render();
      handleError(error, "Не удалось сохранить порядок.");
    }
  }

  function handleDragStart(event) {
    var row = event.target.closest("[data-record-id]");
    if (!row) return;
    state.dragId = row.dataset.recordId;
    row.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.dragId);
  }

  function handleDragOver(event) {
    if (!state.dragId) return;
    event.preventDefault();
    event.stopPropagation();
    var row = event.target.closest("[data-record-id]");
    clearDropMarkers();
    if (row && row.dataset.recordId !== state.dragId) {
      row.classList.add("is-drop-before");
      state.dragTargetId = row.dataset.recordId;
      state.dragTargetSection = row.closest("[data-list]").dataset.list;
    }
    event.dataTransfer.dropEffect = "move";
  }

  function handleDrop(event) {
    if (!state.dragId) return;
    event.preventDefault();
    event.stopPropagation();
    var list = event.currentTarget;
    completeDrop(list.dataset.list, state.dragTargetId);
  }

  function handlePanelDragEnter(event) {
    if (!containsFiles(event.dataTransfer) && !state.dragId) return;
    event.currentTarget.classList.add("is-drop-target");
  }

  function handlePanelDragOver(event) {
    if (!containsFiles(event.dataTransfer) && !state.dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = state.dragId ? "move" : "copy";
    event.currentTarget.classList.add("is-drop-target");
  }

  function handlePanelDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove("is-drop-target");
  }

  function handlePanelDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove("is-drop-target");
    var section = event.currentTarget.dataset.dropSection;
    if (state.dragId) {
      if (event.target.closest("[data-list]")) return;
      completeDrop(section, "");
      return;
    }
    Array.prototype.slice.call(event.dataTransfer.files || []).forEach(function (file) { queueUpload(file, section); });
  }

  function containsFiles(dataTransfer) {
    return dataTransfer && Array.prototype.indexOf.call(dataTransfer.types || [], "Files") !== -1;
  }

  async function completeDrop(section, beforeId) {
    var previous = state.items.slice();
    var moved = state.items.find(function (item) { return item.id === state.dragId; });
    if (!moved || SECTIONS.indexOf(section) === -1) {
      clearDragState();
      return;
    }
    var originalSection = moved.section;
    moved = Object.assign({}, moved, { section: section });
    var without = state.items.filter(function (item) { return item.id !== moved.id; });
    var targetIndex = beforeId ? without.findIndex(function (item) { return item.id === beforeId; }) : -1;
    if (targetIndex < 0) {
      var lastTarget = -1;
      without.forEach(function (item, index) { if (item.section === section) lastTarget = index; });
      targetIndex = lastTarget + 1;
    }
    without.splice(targetIndex, 0, moved);
    state.items = regroup(without);
    clearDragState();
    render();
    try {
      if (originalSection !== section) {
        var payload = await api("/api/v1/tasks/" + context.taskId + "/files/" + moved.id, {
          method: "PATCH",
          body: JSON.stringify({ section: section })
        });
        var updated = sanitiseItem(payload && payload.item || payload);
        if (updated) replaceItem(updated);
      }
      await persistOrder(previous);
    } catch (error) {
      state.items = previous;
      render();
      handleError(error, "Не удалось переместить карточку.");
    }
  }

  function regroup(items) {
    var result = [];
    SECTIONS.forEach(function (section) {
      result = result.concat(items.filter(function (item) { return item.section === section; }));
    });
    return result;
  }

  function clearDragState() {
    state.dragId = "";
    state.dragTargetId = "";
    state.dragTargetSection = "";
    all(".is-dragging, .is-drop-before, .is-drop-target").forEach(function (node) {
      node.classList.remove("is-dragging", "is-drop-before", "is-drop-target");
    });
  }

  function clearDropMarkers() {
    all(".is-drop-before").forEach(function (node) { node.classList.remove("is-drop-before"); });
  }

  function replaceItem(updated) {
    state.items = state.items.map(function (item) { return item.id === updated.id ? updated : item; });
  }

  function upsertItem(updated) {
    var found = false;
    state.items = state.items.map(function (item) {
      if (item.id !== updated.id) return item;
      found = true;
      return updated;
    });
    if (!found) state.items.push(updated);
  }

  function toggleSection(section) {
    var button = document.querySelector('[data-toggle-section="' + section + '"]');
    var panel = document.querySelector('[data-panel="' + section + '"]');
    var expanded = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", (expanded ? "Свернуть " : "Развернуть ") + section);
    panel.hidden = !expanded;
    try { localStorage.setItem(expandedKey(section), expanded ? "1" : "0"); } catch (_) {}
    postHeight();
  }

  function restoreExpandedState() {
    SECTIONS.forEach(function (section) {
      try {
        var saved = localStorage.getItem(expandedKey(section));
        if (saved === "0") {
          var button = document.querySelector('[data-toggle-section="' + section + '"]');
          var panel = document.querySelector('[data-panel="' + section + '"]');
          button.setAttribute("aria-expanded", "false");
          button.setAttribute("aria-label", "Развернуть " + section);
          panel.hidden = true;
        }
      } catch (_) {}
    });
  }

  function cacheKey() {
    return "elements-files-widget:v1:cache:" + (context.validTask ? context.taskId : "invalid");
  }

  function expandedKey(section) {
    return "elements-files-widget:v1:expanded:" + (context.validTask ? context.taskId : "invalid") + ":" + section;
  }

  function themeKey() {
    return "elements-files-widget:v1:theme";
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(cacheKey());
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.items) || !Number.isFinite(parsed.savedAt)) return null;
      return { items: normaliseItems(parsed.items), savedAt: parsed.savedAt };
    } catch (_) {
      return null;
    }
  }

  function writeCache() {
    if (!context.validTask) return;
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({
        version: CACHE_VERSION,
        savedAt: state.cachedAt || Date.now(),
        items: state.items.map(sanitiseItem).filter(Boolean)
      }));
    } catch (_) {
      toast("Локальный кэш переполнен; серверные данные не затронуты.", "warning");
    }
  }

  function updateCacheAge() {
    if (!dom.cacheAge) return;
    if (!state.cachedAt) {
      dom.cacheAge.textContent = "";
      return;
    }
    var seconds = Math.max(0, Math.floor((Date.now() - state.cachedAt) / 1000));
    if (seconds < 20) dom.cacheAge.textContent = "Обновлено только что";
    else if (seconds < 60) dom.cacheAge.textContent = "Обновлено " + seconds + " сек. назад";
    else dom.cacheAge.textContent = "Обновлено " + Math.floor(seconds / 60) + " мин. назад";
  }

  function applySavedTheme() {
    var theme = "auto";
    try { theme = localStorage.getItem(themeKey()) || "auto"; } catch (_) {}
    if (["auto", "light", "dark"].indexOf(theme) === -1) theme = "auto";
    document.documentElement.dataset.theme = theme;
    if (dom.themeButton) dom.themeButton.setAttribute("aria-label", "Тема: " + ({ auto: "системная", light: "светлая", dark: "тёмная" })[theme] + ". Сменить");
  }

  function cycleTheme() {
    var themes = ["auto", "light", "dark"];
    var current = themes.indexOf(document.documentElement.dataset.theme);
    var next = themes[(current + 1) % themes.length];
    try { localStorage.setItem(themeKey(), next); } catch (_) {}
    applySavedTheme();
  }

  function showDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function setFormBusy(form, busy) {
    all("button, input, select", form).forEach(function (control) { control.disabled = busy; });
    form.setAttribute("aria-busy", String(busy));
  }

  function showFormError(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function clearFormErrors() {
    [dom.addFormError, dom.editFormError, dom.confirmError].forEach(function (node) {
      if (!node) return;
      node.textContent = "";
      node.hidden = true;
    });
  }

  function closeOpenMenus() {
    all(".action-menu[open]").forEach(function (menu) { menu.open = false; });
  }

  function toast(message, tone, duration) {
    var node = element("div", "toast");
    node.dataset.tone = tone || "neutral";
    node.setAttribute("role", tone === "danger" ? "alert" : "status");
    var dot = element("span", "toast-dot");
    var copy = element("span", "toast-message");
    copy.textContent = message;
    var close = element("button", "toast-close");
    close.type = "button";
    close.setAttribute("aria-label", "Закрыть уведомление");
    close.textContent = "×";
    close.addEventListener("click", function () { node.remove(); });
    node.append(dot, copy, close);
    dom.toastRegion.appendChild(node);
    window.setTimeout(function () { node.remove(); }, duration || 4200);
  }

  function makeIdempotencyKey() {
    return "widget-" + randomId() + "-" + Date.now().toString(36);
  }

  function pendingIdempotencyKey(slot, fingerprint) {
    var storageKey = "elements-files-widget:v1:pending:" + context.taskId + ":" + slot;
    try {
      var saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (saved && saved.fingerprint === fingerprint && /^[A-Za-z0-9._:-]{8,128}$/.test(saved.key)) return saved.key;
      var key = makeIdempotencyKey();
      sessionStorage.setItem(storageKey, JSON.stringify({ key: key, fingerprint: fingerprint, savedAt: Date.now() }));
      return key;
    } catch (_) {
      return makeIdempotencyKey();
    }
  }

  function clearPendingOperation(slot, fingerprint) {
    var storageKey = "elements-files-widget:v1:pending:" + context.taskId + ":" + slot;
    try {
      var saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (!saved || saved.fingerprint === fingerprint) sessionStorage.removeItem(storageKey);
    } catch (_) {}
  }

  function stableStringHash(value) {
    var hash = 2166136261;
    for (var index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  }

  function postHeight() {
    try {
      if (window.parent === window) return;
      window.parent.postMessage({
        type: "elements-files-widget:resize",
        height: Math.ceil(document.documentElement.scrollHeight)
      }, "*");
    } catch (_) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialise);
  else initialise();
}());
