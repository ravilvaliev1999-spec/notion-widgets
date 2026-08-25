# Google Files Hub v20

Финальная версия виджета файлов для записи-задачи в базе Notion «Элементы».

## Что работает

- создание Google Docs, Sheets и Slides с немедленным созданием записи `Тип = Знание`;
- чтение настоящего имени существующего Google-файла по вставленной ссылке;
- загрузка бинарных файлов одновременно в закрытую папку Google Drive и как настоящее вложение знания Notion;
- прямое скачивание загруженных файлов из закрытой папки Google Drive без Google Drive Preview и без промежуточной страницы файла;
- нейтральный top-level courier: capability token и Apps Script URL находятся только в очищаемом fragment, скрытый Apps Script iframe работает без Google cookies, техническая вкладка закрывается автоматически;
- проверка переименований Google-файлов каждые пять секунд через Drive-only API; Notion вызывается только при реальном изменении имени или метаданных;
- фоновая сверка каждые пять минут без лишнего Notion GET для неизменённых файлов;
- единый источник истины в Notion, поэтому список одинаков на разных устройствах;
- безопасный серверный реестр карточек позволяет открыть виджет и скачать уже прикреплённый файл даже во время временного исчерпания внешней квоты Notion;
- архивирование немедленно отзывает старые ссылки courier через приватное состояние файла в Drive;
- дизайн и четыре колонки исходного `google-buttons-widget.html`.

## Безопасность

Apps Script выполняется от имени владельца. Публичный iframe не зависит от Google cookies: каждый вызов требует случайный capability token, его SHA-256 хранится в Script Properties, а сам token привязан к единственному `AUTHORIZED_TASK_PAGE_ID`. Backend дополнительно проверяет data source, тип задачи, relation каждого знания и принадлежность Drive-файла корневой папке виджета. Пятиисекундный опрос использует короткоживущую HMAC-подпись серверно подтверждённой пары task/page/file и текущих метаданных, поэтому клиент не может подменить карточку или заставить backend бесконечно записывать в Notion.

Секреты и URL развертывания не входят в репозиторий.

## Файлы

- `Index.html` — точный интерфейс, загрузка, добавление ссылок, обновление и скачивание.
- `Download.html` — изолированный top-level courier для финализации браузерного скачивания.
- `Code.gs` — Apps Script API, Notion/Drive CRUD, синхронизация и write barriers.
- `Registry.gs` — безопасный серверный fallback-реестр карточек без токенов и временных download URL.
- `Core.js` — чистые функции URL, MIME и классификации.
- `appsscript.json` — V8, Drive v3 и web-app deployment.
- `ScriptProperties.example.json` — перечень обязательных свойств без секретов.
- `tests/` — исполняемые regression/security contracts.

## Script Properties

Обязательны:

- `ALLOWED_EMAIL`
- `NOTION_TOKEN`
- `NOTION_DATA_SOURCE_ID`
- `AUTHORIZED_TASK_PAGE_ID`
- `WIDGET_ACCESS_TOKEN_SHA256`
- `ROOT_DRIVE_FOLDER_ID` — создаётся `adminSetupRootFolder()`
- `MAX_UPLOAD_BYTES` — от 1 до 20 MiB; фактический лимит также учитывает тариф рабочего пространства Notion
- `NOTION_VERSION`

Опциональны `DENIED_NOTION_PAGE_IDS` и `DENIED_NOTION_DATA_SOURCE_IDS`.

## Развертывание

1. Загрузить `Code.gs`, `Registry.gs`, `Core.js`, `Index.html`, `Download.html` и `appsscript.json` в отдельный Apps Script project.
2. Записать Script Properties.
3. Выполнить `adminSetupRootFolder()`, затем `adminPreflight()` и `adminInstallSyncTrigger()`.
4. Развернуть web app как `USER_DEPLOYING` с доступом `ANYONE_ANONYMOUS`.
5. Встроить URL вида `.../exec?task=<TASK_UUID>&accessToken=<RANDOM_TOKEN>` только в авторизованную задачу Notion.

## Проверка

```sh
node --test tests/*.test.mjs
```

Текущий regression/security suite: 87 тестов.

Локальный безопасный preview:

`Index.html?mock=1&task=11111111-1111-4111-8111-111111111111`

Mock не обращается к Notion или Drive и не является live-проверкой интеграции.
