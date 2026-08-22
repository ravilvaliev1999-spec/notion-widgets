# Архитектура staging

## Источник истины

Одна физическая data source «Элементы» содержит:

- Тип=Задача — существующие task-свойства, Parent/Sub-item и связи с sandbox Projects.
- Тип=Знание — материалы, ссылки и записи файлов.
- Тип=Раздел — узлы навигации.
- пустой Тип — Входящие.

Файл или URL виджета — отдельная запись Тип=Знание с Внутри=current task. Поэтому список, порядок и состояние одинаковы на разных устройствах. localStorage хранит только последний успешный ответ для мгновенной отрисовки.

## Размещение

Knowledge/Section имеет ровно одно прямое место:

- Внутри: task или section;
- либо Знание: Проект;
- либо Знание: Направление;
- либо Знание: Сфера.

Контекст вверх по иерархии материализуется в скрытые SYS-поля. Он не превращается в дополнительные прямые связи и не используется как локальный display-filter.

Parent/Sub-item и 3. Проекты остаются task-only. Метрики проектов должны учитывать только Тип=Задача.

## Виджет

Первая staging-версия разворачивается на одном origin: этот Node backend отдаёт и статический widget, и `/api`. Раздельные frontend/backend origins намеренно не поддерживаются CSP и клиентской проверкой URL.

Браузер получает только:

- task_page_id;
- подписанный, ограниченный одной задачей access token;
- публичный API base URL.

Google refresh token, OAuth secret, Notion token и webhook verification token существуют только на backend.

Основные потоки:

1. page.created/properties_updated webhook видит новую sandbox-задачу.
2. Backend проверяет parent data source и Тип=Задача.
3. В страницу один раз добавляется embed с task-scoped token во fragment URL.
4. Виджет читает записи Тип=Знание + Внутри=current task.
5. Создание Docs/Sheets/Slides идёт через Drive API в стабильную task-folder.
6. Upload передаётся backend потоково без конвертации; Google resumable session URL хранится только в памяти backend, браузер получает opaque signed upload ID.
7. Backend создаёт запись «Элементы» только после успешного Drive ответа, проверки parent/appProperties, фактического SHA-256 и server-only verified marker.
8. Интерфейс сохраняет Idempotency-Key незавершённой логической операции в sessionStorage; retry с тем же payload восстанавливает существующий файл/запись, а другой payload получает conflict.

## Drive

В staging root создаётся одна папка на task_page_id. Имя папки может меняться, идентичность — нет. Каждый файл содержит appProperties с task_page_id и idempotency key.

До первой записи backend сверяет OAuth principal, точный root ID, staging marker (appProperties либо единственный marker-файл) и отсутствие anyone/domain permissions. Несовпадение закрывает write gate.

Скачивание разрешается только если одновременно совпадают:

- запись Knowledge принадлежит task;
- File ID совпадает с записью;
- parent — сохранённая task-folder;
- appProperties.task_page_id совпадает.

Backend выдаёт короткоживущую download-ссылку. Google-native файл открывается по webViewLink; бинарный файл отдаётся через alt=media без конвертации.

Подтверждённое «удаление файла» в staging перемещает объект в корзину Drive. Безвозвратный purge не входит в runtime виджета.

## Rename sync

Раз в 45 секунд backend сверяет активные Google-records по File ID. Чужой parent, удалённый файл или неверные appProperties переводят запись в error. Изменившееся имя обновляется в Notion без создания новой строки.

## Границы адаптеров

- Source Notion client — read-only.
- Sandbox Notion client — write только по allowlist.
- Drive client — только staging root и созданные task-folders.
- Migration harness — offline JSON; сетевого клиента нет.
- Production GitHub Pages, Apps Script и original templates не входят в staging runtime.

## Ограничение host binding

Внешний iframe не получает криптографически подтверждённый ID страницы-хоста от Notion. Проверка page ID из referrer блокирует явное несовпадение, но referrer может содержать только origin. Поэтому `WRITE_GATE` остаётся закрытым до acceptance-теста дублирования и выбора механизма host attestation/одноразовой привязки. Webhook исправляет copied embed идемпотентно, однако сам по себе не доказывает отсутствие короткого окна до доставки события.
