(() => {
  'use strict';

  const FLEX_VERSION = 1;
  const baseRender = render;
  const baseRenderItem = renderItem;

  const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const CHEVRON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  const MORE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  const UP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="18 15 12 9 6 15"/></svg>';
  const DOWN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>';
  const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H7l-3 3V4z"/><path d="M8 8h8M8 12h5"/></svg>';
  const HEADING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M5 4v16M19 4v16M5 12h14"/></svg>';
  const DIVIDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18"/></svg>';

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function ensureFlexibleState() {
    if (!state || !Array.isArray(state.columns)) return;
    state.columns.forEach(col => {
      if (!Array.isArray(col.metrics)) col.metrics = [];
      if (!Array.isArray(col.marketplaces)) col.marketplaces = [];
      if (!Array.isArray(col.items)) col.items = [];
      if (col.collapsed == null) col.collapsed = false;
      col.items.forEach(item => {
        if (!item.kind) item.kind = 'link';
        if (item.checked == null) item.checked = false;
      });
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function flexibleItemShell(item, colId, inner, extraClass = '', click = '') {
    return `
      <div class="item flex-item ${extraClass}"
           data-item-id="${item.id}"
           ${click}
           draggable="true"
           ondragstart="onItemDragStart(event, '${colId}', '${item.id}')"
           ondragend="onDragEnd(event)"
           ondragover="onItemDragOver(event, '${colId}', '${item.id}')"
           ondrop="onItemDrop(event, '${colId}', '${item.id}')"
           ondragleave="onDragLeave(event)">
        ${inner}
        <div class="item-actions flex-actions" onclick="event.stopPropagation()">
          <button class="icon-btn" onclick="duplicateItem('${colId}', '${item.id}')" title="Дублировать">${COPY_ICON}</button>
          ${item.kind !== 'divider' ? `<button class="icon-btn" onclick="editFlexibleItem('${colId}', '${item.id}')" title="Изменить">${EDIT_ICON}</button>` : ''}
          <button class="icon-btn delete" onclick="deleteItem('${colId}', '${item.id}')" title="Удалить">${TRASH_ICON}</button>
        </div>
      </div>`;
  }

  renderItem = function(item, colId) {
    const kind = item.kind || 'link';
    if (kind === 'link') return baseRenderItem(item, colId);

    if (kind === 'heading') {
      return flexibleItemShell(item, colId,
        `<div class="flex-heading-text">${escapeHtml(item.name || 'Заголовок')}</div>`,
        'flex-heading');
    }

    if (kind === 'note') {
      return flexibleItemShell(item, colId,
        `<div class="item-icon" style="background:${COLORS[item.color] || COLORS.graphite}">${NOTE_ICON}</div>
         <div class="item-info"><div class="item-name">${escapeHtml(item.name || 'Заметка')}</div><div class="flex-note-text">${escapeHtml(item.text || '')}</div></div>`,
        'flex-note');
    }

    if (kind === 'checklist') {
      const checked = !!item.checked;
      return flexibleItemShell(item, colId,
        `<button class="flex-check ${checked ? 'checked' : ''}" onclick="event.stopPropagation();toggleFlexCheck('${colId}','${item.id}')" aria-label="Переключить">${checked ? '✓' : ''}</button>
         <div class="item-info"><div class="item-name ${checked ? 'is-done' : ''}">${escapeHtml(item.name || 'Пункт')}</div></div>`,
        'flex-checklist',
        `onclick="toggleFlexCheck('${colId}','${item.id}')"`);
    }

    if (kind === 'divider') {
      return flexibleItemShell(item, colId, '<div class="flex-divider-line"></div>', 'flex-divider');
    }

    return baseRenderItem(item, colId);
  };

  render = function() {
    baseRender();
    enhanceBoard();
  };

  function enhanceBoard() {
    document.querySelectorAll('.column[data-col-id]').forEach((columnEl, index) => {
      const colId = columnEl.dataset.colId;
      const col = state.columns.find(c => c.id === colId);
      if (!col) return;

      columnEl.classList.toggle('is-collapsed', !!col.collapsed);
      const menu = columnEl.querySelector('.column-menu');
      if (menu && !menu.querySelector('.flex-add-head')) {
        menu.insertAdjacentHTML('afterbegin', `
          <button class="icon-btn flex-add-head" onclick="event.stopPropagation();openAddMenu('${colId}')" title="Добавить элемент">${PLUS_ICON}</button>
          <button class="icon-btn" onclick="event.stopPropagation();duplicateColumn('${colId}')" title="Дублировать столбец">${COPY_ICON}</button>
          <button class="icon-btn flex-collapse-btn" onclick="event.stopPropagation();toggleColumn('${colId}')" title="Свернуть / развернуть">${CHEVRON_ICON}</button>`);
      }

      const resizer = columnEl.querySelector('.col-resizer');
      if (resizer && !columnEl.querySelector('.column-quick-add')) {
        resizer.insertAdjacentHTML('beforebegin', `
          <button class="column-quick-add" onclick="event.stopPropagation();openAddMenu('${colId}')">
            ${PLUS_ICON}<span>Добавить</span>
          </button>`);
      }

      columnEl.querySelectorAll('.metric-cell').forEach((metricEl, metricIndex) => {
        if (metricEl.querySelector('.metric-actions')) return;
        metricEl.insertAdjacentHTML('beforeend', `
          <div class="metric-actions">
            <button onclick="event.stopPropagation();moveMetric('${colId}',${metricIndex},-1)" title="Влево">${UP_ICON}</button>
            <button onclick="event.stopPropagation();moveMetric('${colId}',${metricIndex},1)" title="Вправо">${DOWN_ICON}</button>
            <button onclick="event.stopPropagation();openFlexEditor('metric','${colId}',${metricIndex})" title="Изменить">${EDIT_ICON}</button>
            <button class="delete" onclick="event.stopPropagation();deleteMetric('${colId}',${metricIndex})" title="Удалить">${TRASH_ICON}</button>
          </div>`);
      });

      columnEl.querySelectorAll('.item[data-item-id]').forEach(itemEl => {
        const itemId = itemEl.dataset.itemId;
        const actions = itemEl.querySelector('.item-actions');
        if (actions && !actions.querySelector('.flex-copy-item')) {
          actions.insertAdjacentHTML('afterbegin', `<button class="icon-btn flex-copy-item" onclick="duplicateItem('${colId}','${itemId}')" title="Дублировать">${COPY_ICON}</button>`);
        }
      });

      columnEl.querySelectorAll('.mp-row[data-mp-id]').forEach(mpEl => {
        const mpId = mpEl.dataset.mpId;
        const actions = mpEl.querySelector('.mp-actions');
        if (actions && !actions.querySelector('.flex-copy-mp')) {
          actions.insertAdjacentHTML('afterbegin', `<button class="icon-btn flex-copy-mp" onclick="duplicateMarketplace('${colId}','${mpId}')" title="Дублировать">${COPY_ICON}</button>`);
        }
      });
    });
  }

  function createUi() {
    const style = document.createElement('style');
    style.textContent = `
      .column-menu { opacity: 1 !important; }
      .column-quick-add {
        width:100%; display:flex; align-items:center; justify-content:center; gap:6px;
        border:1px dashed var(--divider); background:transparent; color:var(--text-secondary);
        border-radius:9px; min-height:28px; cursor:pointer; font:500 11px inherit;
      }
      .column-quick-add:hover { background:var(--hover-bg); color:var(--text-primary); border-color:var(--text-secondary); }
      .column-quick-add svg { width:13px; height:13px; }
      .column.is-collapsed > :not(.column-head):not(.col-resizer) { display:none !important; }
      .column.is-collapsed .column-head { border-bottom:none !important; padding-bottom:3px !important; }
      .column.is-collapsed .flex-collapse-btn svg { transform:rotate(-90deg); }
      .metric-cell { position:relative; }
      .metric-actions { position:absolute; right:3px; top:3px; display:flex; gap:1px; opacity:0; pointer-events:none; background:var(--card-bg); border-radius:7px; padding:1px; }
      .metric-cell:hover .metric-actions { opacity:1; pointer-events:auto; }
      .metric-actions button { width:19px; height:19px; border:0; border-radius:5px; display:flex; align-items:center; justify-content:center; background:transparent; color:var(--text-secondary); cursor:pointer; }
      .metric-actions button:hover { background:var(--hover-bg); color:var(--text-primary); }
      .metric-actions button.delete:hover { color:var(--danger); }
      .metric-actions svg { width:10px; height:10px; }
      .flex-heading { min-height:26px !important; background:transparent !important; border:0 !important; padding:4px 2px !important; }
      .flex-heading-text { font-size:12px; font-weight:700; color:var(--text-primary); text-transform:uppercase; letter-spacing:.03em; padding-right:64px; }
      .flex-note { align-items:flex-start !important; }
      .flex-note-text { font-size:10px; color:var(--text-secondary); line-height:1.25; margin-top:2px; white-space:pre-wrap; }
      .flex-check { width:22px; height:22px; border:1px solid var(--divider); border-radius:7px; background:var(--input-bg); color:white; cursor:pointer; flex:0 0 auto; font-weight:700; }
      .flex-check.checked { background:#34c759; border-color:#34c759; }
      .item-name.is-done { text-decoration:line-through; opacity:.55; }
      .flex-divider { min-height:13px !important; padding:5px 2px !important; background:transparent !important; border:0 !important; }
      .flex-divider-line { height:1px; background:var(--divider); width:100%; }
      .flex-divider .item-actions { top:50%; }
      .flex-modal-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .flex-type-btn { min-height:68px; padding:10px; border:1px solid var(--divider); border-radius:12px; background:var(--input-bg); color:var(--text-primary); cursor:pointer; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:5px; text-align:left; }
      .flex-type-btn:hover { border-color:var(--accent); background:rgba(10,132,255,.08); }
      .flex-type-btn svg { width:18px; height:18px; color:var(--accent); }
      .flex-type-btn strong { font-size:12px; }
      .flex-type-btn span { font-size:9.5px; color:var(--text-secondary); line-height:1.2; }
      .flex-editor-textarea { width:100%; min-height:88px; resize:vertical; padding:11px 14px; background:var(--input-bg); border:1px solid transparent; border-radius:11px; font:13px inherit; color:var(--text-primary); outline:none; }
      .flex-editor-textarea:focus { border-color:var(--accent); }
      .fab-manage { position:fixed; right:64px; bottom:14px; width:38px; height:38px; border-radius:50%; border:1px solid var(--card-border); background:var(--card-bg); color:var(--text-secondary); cursor:pointer; display:flex; align-items:center; justify-content:center; z-index:51; box-shadow:var(--card-shadow); }
      .fab-manage:hover { color:var(--accent); transform:translateY(-1px); }
      .fab-manage svg { width:18px; height:18px; }
      .flex-manage-actions { display:grid; gap:7px; }
      .flex-manage-actions button { width:100%; text-align:left; padding:11px 13px; border:1px solid var(--divider); border-radius:10px; background:var(--input-bg); color:var(--text-primary); cursor:pointer; font:500 12px inherit; }
      .flex-manage-actions button:hover { border-color:var(--accent); }
      .flex-toast { position:fixed; left:50%; bottom:18px; transform:translate(-50%,12px); opacity:0; pointer-events:none; z-index:200; background:rgba(20,20,22,.94); color:#fff; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:8px 12px; font:500 11px inherit; transition:.2s; }
      .flex-toast.show { opacity:1; transform:translate(-50%,0); }
      @media (max-width:700px) { .flex-modal-grid{grid-template-columns:1fr;} .column-menu .icon-btn:nth-child(2){display:none;} }
    `;
    document.head.appendChild(style);

    document.body.insertAdjacentHTML('beforeend', `
      <button class="fab-manage" onclick="openManageModal()" title="Управление и резервная копия">${MORE_ICON}</button>

      <div class="modal-overlay" id="flexAddModal">
        <div class="modal">
          <h2>Добавить в столбец</h2>
          <div class="flex-modal-grid">
            <button class="flex-type-btn" onclick="addFlexType('metric')">${ICONS.bars}<strong>Показатель</strong><span>Название, значение и привязка к ячейке</span></button>
            <button class="flex-type-btn" onclick="addFlexType('marketplace')">${ICONS.chart}<strong>Маркетплейс</strong><span>Строка с тремя показателями</span></button>
            <button class="flex-type-btn" onclick="addFlexType('link')">${ICONS.link}<strong>Ссылка</strong><span>Таблица, страница, файл или сервис</span></button>
            <button class="flex-type-btn" onclick="addFlexType('heading')">${HEADING_ICON}<strong>Заголовок</strong><span>Разделитель смысловых блоков</span></button>
            <button class="flex-type-btn" onclick="addFlexType('note')">${NOTE_ICON}<strong>Заметка</strong><span>Короткий текст прямо в карточке</span></button>
            <button class="flex-type-btn" onclick="addFlexType('checklist')">${ICONS.checklist}<strong>Чек-лист</strong><span>Отмечаемый пункт</span></button>
            <button class="flex-type-btn" onclick="addFlexType('divider')">${DIVIDER_ICON}<strong>Разделитель</strong><span>Тонкая линия между элементами</span></button>
          </div>
          <div class="modal-actions"><button class="btn btn-secondary" onclick="closeFlexModal('flexAddModal')">Закрыть</button></div>
        </div>
      </div>

      <div class="modal-overlay" id="flexEditorModal">
        <div class="modal">
          <h2 id="flexEditorTitle">Редактирование</h2>
          <div class="form-group" id="flexNameGroup"><label id="flexNameLabel">Название</label><input id="flexEditorName" type="text" autocomplete="off"></div>
          <div class="form-group" id="flexTextGroup"><label>Текст</label><textarea id="flexEditorText" class="flex-editor-textarea"></textarea></div>
          <div class="form-group" id="flexValueGroup"><label>Значение</label><input id="flexEditorValue" type="text" autocomplete="off"></div>
          <div class="form-group" id="flexCellGroup"><label>Ячейка Google Sheets</label><input id="flexEditorCell" type="text" placeholder="B2 или Свод!B2" autocomplete="off"></div>
          <div class="modal-actions">
            <button class="btn btn-secondary" onclick="closeFlexModal('flexEditorModal')">Отмена</button>
            <button class="btn btn-primary" onclick="saveFlexEditor()">Сохранить</button>
          </div>
        </div>
      </div>

      <div class="modal-overlay" id="flexManageModal">
        <div class="modal">
          <h2>Управление виджетом</h2>
          <div class="flex-manage-actions">
            <button onclick="expandAllColumns()">Развернуть все столбцы</button>
            <button onclick="collapseAllColumns()">Свернуть все столбцы</button>
            <button onclick="resetColWidths();showFlexToast('Ширина столбцов сброшена')">Сбросить ширину столбцов</button>
            <button onclick="exportFlexConfig()">Сохранить резервную копию JSON</button>
            <button onclick="document.getElementById('flexImportInput').click()">Восстановить из JSON</button>
          </div>
          <input id="flexImportInput" type="file" accept="application/json" style="display:none">
          <div class="modal-actions"><button class="btn btn-secondary" onclick="closeFlexModal('flexManageModal')">Закрыть</button></div>
        </div>
      </div>
      <div class="flex-toast" id="flexToast">Сохранено</div>`);

    ['flexAddModal','flexEditorModal','flexManageModal'].forEach(id => {
      document.getElementById(id).addEventListener('click', event => {
        if (event.target.id === id) closeFlexModal(id);
      });
    });

    document.getElementById('flexImportInput').addEventListener('change', importFlexConfig);
  }

  let activeAddColumnId = null;
  let editorCtx = null;

  window.openAddMenu = function(colId) {
    activeAddColumnId = colId;
    document.getElementById('flexAddModal').classList.add('active');
  };

  window.closeFlexModal = function(id) {
    document.getElementById(id)?.classList.remove('active');
  };

  window.addFlexType = function(type) {
    const colId = activeAddColumnId;
    const col = state.columns.find(c => c.id === colId);
    if (!col) return;
    closeFlexModal('flexAddModal');

    if (type === 'link') return openItemModal(colId);
    if (type === 'marketplace') {
      col.hideMarketplaces = false;
      save();
      return openMpModal(colId);
    }
    if (type === 'divider') {
      col.items.push({ id: uid(), kind:'divider', name:'', url:'', icon:'link', color:'graphite', shape:'square', customLogo:null });
      save();
      showFlexToast('Разделитель добавлен');
      return;
    }
    openFlexEditor(type, colId, null);
  };

  window.openFlexEditor = function(type, colId, indexOrId) {
    const col = state.columns.find(c => c.id === colId);
    if (!col) return;
    editorCtx = { type, colId, indexOrId };

    const nameGroup = document.getElementById('flexNameGroup');
    const textGroup = document.getElementById('flexTextGroup');
    const valueGroup = document.getElementById('flexValueGroup');
    const cellGroup = document.getElementById('flexCellGroup');
    nameGroup.style.display = '';
    textGroup.style.display = 'none';
    valueGroup.style.display = 'none';
    cellGroup.style.display = 'none';

    let title = 'Новый элемент';
    let name = '';
    let text = '';
    let value = '';
    let cell = '';

    if (type === 'metric') {
      const metric = Number.isInteger(indexOrId) ? col.metrics[indexOrId] : null;
      title = metric ? 'Изменить показатель' : 'Новый показатель';
      name = metric?.label || '';
      value = metric?.value || '';
      cell = metric?.cell || '';
      valueGroup.style.display = '';
      cellGroup.style.display = '';
      document.getElementById('flexNameLabel').textContent = 'Название показателя';
    } else {
      const item = indexOrId ? col.items.find(i => i.id === indexOrId) : null;
      title = item ? 'Изменить элемент' : (type === 'heading' ? 'Новый заголовок' : type === 'note' ? 'Новая заметка' : 'Новый пункт');
      name = item?.name || '';
      text = item?.text || '';
      document.getElementById('flexNameLabel').textContent = type === 'note' ? 'Заголовок заметки' : 'Название';
      if (type === 'note') textGroup.style.display = '';
    }

    document.getElementById('flexEditorTitle').textContent = title;
    document.getElementById('flexEditorName').value = name;
    document.getElementById('flexEditorText').value = text;
    document.getElementById('flexEditorValue').value = value;
    document.getElementById('flexEditorCell').value = cell;
    document.getElementById('flexEditorModal').classList.add('active');
    setTimeout(() => document.getElementById('flexEditorName').focus(), 60);
  };

  window.saveFlexEditor = function() {
    if (!editorCtx) return;
    const { type, colId, indexOrId } = editorCtx;
    const col = state.columns.find(c => c.id === colId);
    if (!col) return;
    const name = document.getElementById('flexEditorName').value.trim();
    if (!name && type !== 'note') return;

    if (type === 'metric') {
      const payload = {
        label: name || 'Показатель',
        value: document.getElementById('flexEditorValue').value.trim(),
        cell: document.getElementById('flexEditorCell').value.trim()
      };
      if (Number.isInteger(indexOrId)) col.metrics[indexOrId] = { ...col.metrics[indexOrId], ...payload };
      else col.metrics.push(payload);
    } else {
      const payload = {
        kind: type,
        name: name || 'Заметка',
        text: document.getElementById('flexEditorText').value.trim(),
        checked: false,
        url: '',
        icon: type === 'checklist' ? 'checklist' : type === 'note' ? 'notion' : 'bars',
        color: type === 'checklist' ? 'green' : type === 'note' ? 'graphite' : 'blue',
        shape: 'square',
        customLogo: null
      };
      const item = indexOrId ? col.items.find(i => i.id === indexOrId) : null;
      if (item) Object.assign(item, payload, { checked: item.checked });
      else col.items.push({ id: uid(), ...payload });
    }

    closeFlexModal('flexEditorModal');
    editorCtx = null;
    save();
    showFlexToast('Сохранено автоматически');
  };

  window.editFlexibleItem = function(colId, itemId) {
    const col = state.columns.find(c => c.id === colId);
    const item = col?.items.find(i => i.id === itemId);
    if (!item) return;
    if ((item.kind || 'link') === 'link') return openItemModal(colId, itemId);
    if (item.kind === 'divider') return;
    openFlexEditor(item.kind, colId, itemId);
  };

  window.toggleFlexCheck = function(colId, itemId) {
    const item = state.columns.find(c => c.id === colId)?.items.find(i => i.id === itemId);
    if (!item) return;
    item.checked = !item.checked;
    save();
  };

  window.deleteItem = function(colId, itemId) {
    if (!confirm('Удалить этот элемент?')) return;
    const col = state.columns.find(c => c.id === colId);
    if (!col) return;
    col.items = col.items.filter(i => i.id !== itemId);
    save();
  };

  window.duplicateItem = function(colId, itemId) {
    const col = state.columns.find(c => c.id === colId);
    const index = col?.items.findIndex(i => i.id === itemId) ?? -1;
    if (index < 0) return;
    const copy = deepClone(col.items[index]);
    copy.id = uid();
    copy.name = copy.name ? `${copy.name} — копия` : copy.name;
    col.items.splice(index + 1, 0, copy);
    save();
    showFlexToast('Элемент продублирован');
  };

  window.duplicateMarketplace = function(colId, mpId) {
    const col = state.columns.find(c => c.id === colId);
    const index = col?.marketplaces.findIndex(mp => mp.id === mpId) ?? -1;
    if (index < 0) return;
    const copy = deepClone(col.marketplaces[index]);
    copy.id = uid();
    copy.name = `${copy.name || 'Маркетплейс'} — копия`;
    col.marketplaces.splice(index + 1, 0, copy);
    save();
  };

  window.duplicateColumn = function(colId) {
    const index = state.columns.findIndex(c => c.id === colId);
    if (index < 0) return;
    const copy = deepClone(state.columns[index]);
    copy.id = uid();
    copy.title = `${copy.title} — копия`;
    copy.marketplaces.forEach(mp => { mp.id = uid(); });
    copy.items.forEach(item => { item.id = uid(); });
    state.columns.splice(index + 1, 0, copy);
    save();
    showFlexToast('Столбец продублирован');
  };

  window.toggleColumn = function(colId) {
    const col = state.columns.find(c => c.id === colId);
    if (!col) return;
    col.collapsed = !col.collapsed;
    save();
  };

  window.moveMetric = function(colId, index, direction) {
    const col = state.columns.find(c => c.id === colId);
    if (!col) return;
    const next = index + direction;
    if (next < 0 || next >= col.metrics.length) return;
    [col.metrics[index], col.metrics[next]] = [col.metrics[next], col.metrics[index]];
    save();
  };

  window.deleteMetric = function(colId, index) {
    if (!confirm('Удалить показатель?')) return;
    const col = state.columns.find(c => c.id === colId);
    if (!col) return;
    col.metrics.splice(index, 1);
    save();
  };

  window.addMpFromSettings = function() {
    const colId = colCtx?.id;
    if (!colId) return;
    saveColumn();
    setTimeout(() => openMpModal(colId), 0);
  };

  window.addItemFromSettings = function() {
    const colId = colCtx?.id;
    if (!colId) return;
    saveColumn();
    setTimeout(() => openItemModal(colId), 0);
  };

  window.openManageModal = function() {
    document.getElementById('flexManageModal').classList.add('active');
  };

  window.expandAllColumns = function() {
    state.columns.forEach(col => { col.collapsed = false; });
    save();
    closeFlexModal('flexManageModal');
  };

  window.collapseAllColumns = function() {
    state.columns.forEach(col => { col.collapsed = true; });
    save();
    closeFlexModal('flexManageModal');
  };

  window.exportFlexConfig = function() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finance-widget-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showFlexToast('Резервная копия сохранена');
  };

  window.importFlexConfig = function(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!imported || !Array.isArray(imported.columns)) throw new Error('Неверный формат');
        state = imported;
        ensureFlexibleState();
        render();
        closeFlexModal('flexManageModal');
        showFlexToast('Резервная копия восстановлена');
      } catch (error) {
        alert('Не удалось восстановить файл: ' + error.message);
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  };

  let toastTimer = null;
  window.showFlexToast = function(text) {
    const toast = document.getElementById('flexToast');
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
  };

  const originalSave = save;
  save = function() {
    originalSave();
  };

  ensureFlexibleState();
  createUi();
  render();
})();