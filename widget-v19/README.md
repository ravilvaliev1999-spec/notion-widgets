# Файловый виджет v19 — изолированный стенд

Эта папка — новый контур. Она не заменяет и не импортирует старые HTML/Apps Script-файлы. Никакие секреты, deployment URL или OAuth-токены здесь не хранятся.

## Выбранная архитектура

- Один owner-only Apps Script web app обслуживает HTML и backend в одном origin. Клиент вызывает сервер только через `google.script.run`; публичного «секрета» в браузере нет.
- Источник истины — база Notion «Элементы». Каждый самостоятельно управляемый файл или URL является записью `Тип = Знание`, а единственное прямое размещение — `Внутри = task_page_id`.
- Google Drive хранит физические файлы. Нативные Docs/Sheets/Slides создаются через Advanced Drive API; Office-файлы сохраняются без конвертации.
- Список, порядок, названия и sync state читаются из Notion, поэтому очистка браузерного cache и другое устройство не меняют данные.
- Любая запись проверяет пользователя, allowlisted data source, тип страницы задачи и принадлежность материала этой задаче. Неизвестный или запрещённый ID отклоняется.
- Создание защищено idempotency key в трёх слоях: durable ledger Apps Script, private `appProperties` Drive и `[SYS] Idempotency key` Notion.

Текущая реализация ориентируется на Notion API `2026-03-11` и endpoints data sources. Официальные справки: [Notion data sources](https://developers.notion.com/reference/data-source), [Apps Script web apps](https://developers.google.com/apps-script/guides/web), [HTML Service client/server](https://developers.google.com/apps-script/guides/html/communication), [Drive appProperties](https://developers.google.com/workspace/drive/api/guides/properties).

## Новые файлы

- `Index.html` — адаптивный интерфейс, состояния загрузки/ошибок, drag-and-drop, сортировка, добавление ссылок, архивирование и подтверждённое физическое удаление.
- `Code.gs` — owner-only backend, Notion CRUD, Drive CRUD, idempotency, sync и write barriers.
- `Core.js` — чистые функции классификации и нормализации.
- `appsscript.json` — минимальные OAuth scopes и Advanced Drive v3.
- `ScriptProperties.example.json` — только названия конфигурации и безопасные placeholders.
- `tests/*` — локальные unit/security-contract тесты.

## Одноразовая настройка staging

1. Создать **новый** standalone Apps Script project и добавить туда `Code.gs`, `Core.js`, `Index.html`, `appsscript.json` из этой папки. Не менять существующий production project.
2. В Project Settings → Script properties добавить значения по образцу `ScriptProperties.example.json`:
   - `ALLOWED_EMAIL` — только email владельца;
   - `NOTION_TOKEN` — токен внутренней Notion connection, которой открыт только нужный data source;
   - `NOTION_DATA_SOURCE_ID` — UUID data source «Элементы»;
   - `DENIED_NOTION_PAGE_IDS` / `DENIED_NOTION_DATA_SOURCE_IDS` — необязательные denylist через запятую;
   - `MAX_UPLOAD_BYTES` — явный лимит; по умолчанию 8 MiB;
   - `NOTION_VERSION` — `2026-03-11`.
3. В редакторе вручную запустить `adminSetupRootFolder()`. Функция создаст отдельную папку `Notion Widget v19 — STAGING`, сохранит её ID в Script Properties и не сделает папку публичной.
4. Запустить `adminPreflight()`. Ожидаемый результат: `ok: true`, schema check без отсутствующих свойств.
5. При необходимости фоновой сверки переименований раз в минуту запустить `adminInstallSyncTrigger()`.
6. Deploy → New deployment → Web app. Настройки: **Execute as user accessing the web app**, **Who has access: Only myself**. Не выбирать anonymous access.
7. Сначала открыть staging URL в обычной вкладке и пройти Google authorization. Затем вставить на отдельную тестовую страницу Notion embed URL вида:

   `https://script.google.com/macros/s/STAGING_DEPLOYMENT/exec?task=NOTION_TASK_PAGE_ID`

`task` обязателен и должен быть UUID страницы записи `Тип = Задача` в allowlisted «Элементы». По названию, referrer, времени создания или «последней задаче» v19 ничего не угадывает.

## Свойства «Элементы», используемые v19

Пользовательские: `Name`, `Тип`, `Внутри`, `Ссылка`, `Вложения`, `Формат знания`, `Архив`.

Скрытые технические: `[SYS] Формат файла`, `[SYS] Раздел виджета`, `[SYS] Провайдер`, `[SYS] Google File ID`, `[SYS] Google Folder ID`, `[SYS] Позиция`, `[SYS] Sync status`, `[SYS] Последняя синхронизация`, `[SYS] Idempotency key`, `[SYS] MIME type`, `[SYS] Размер байт`, `[SYS] Drive MD5`, `[SYS] SHA-256`, `[SYS] Download name`, `[SYS] Normalized URL`, `[SYS] Ошибка sync`, `[SYS] Integrity`, `[SYS] Context path`, `[SYS] Ancestor IDs`, `[SYS] Глубина`, `[SYS] Контекст:*`.

`Code.gs` делает schema preflight и прекращает запись, если обязательное поле отсутствует или имеет неожиданный тип.

## Локальная проверка

Тесты не требуют npm install:

```powershell
node --test tests/*.test.mjs
```

Для безопасного UI-preview можно локально открыть:

`Index.html?mock=1&task=11111111-1111-4111-8111-111111111111`

Mock включается только для `file:`/localhost и точного canary-домена `ravilvaliev1999-spec.github.io`. На экране нет служебной метки `TEST`; режим не обращается к Notion или Drive и не является проверкой реальной интеграции.

## Известные границы этой минимально безопасной версии

- Обычное дублирование страницы Notion копирует embed URL вместе со старым `task_page_id`. V19 намеренно не угадывает новый ID. До отдельной staging-автоматизации, которая патчит embed после `page.created`, продублированную задачу нужно перепривязать новым URL. Это реальный blocker полного Duplicate Task acceptance test.
- Загрузка через HTML Service передаёт файл одним вызовом и имеет явный лимит 8 MiB по умолчанию. Для больших файлов нужен следующий backend-вариант с resumable Drive upload; скрытого «успеха» или локального сохранения нет.
- Background trigger Apps Script запускается приблизительно, а не как realtime webhook. Открытие/кнопка «Обновить» всегда делает принудительную сверку; автоматический SLA зависит от квот и планировщика Apps Script.
- Google sign-in внутри third-party iframe может быть ограничен политикой cookies браузера. Первую авторизацию нужно пройти в обычной вкладке; если браузер всё равно блокирует owner-only session в embed, безопасный следующий шаг — same-origin Cloud Run backend с top-level OAuth, а не anonymous Apps Script.

## Rollback

Удалить новый embed с тестовой страницы и отключить staging deployment/trigger. Старые файлы и production deployment не менялись. Записи v19 имеют `[SYS] Sync status` и `[SYS] Idempotency key`, поэтому их можно отфильтровать и архивировать отдельно; физические Drive-файлы не удаляются при обычном архивировании карточки.
