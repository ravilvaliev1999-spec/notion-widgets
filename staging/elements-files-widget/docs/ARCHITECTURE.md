# Архитектура staging

## Источник истины и граница записи

Одна основная Notion data source «Элементы» содержит задачи, знания, разделы и
входящие. Staging frontend/backend работает с ней только через точный allowlist
data source и page ID. Это явное исключение для текущего проекта, а не право
писать в остальные основные базы.

- `Тип=Задача` — task-свойства, Parent/Sub-item и существующие связи.
- `Тип=Знание` — материалы, ссылки и записи файлов.
- `Тип=Раздел` — узлы навигации.
- пустой `Тип` — Входящие.

Старые базы, страницы, свойства, статусы и связи сохраняются как Legacy либо
скрываются. До итоговой приёмки backend их не удаляет и не очищает.

Файл или URL виджета — отдельная запись `Тип=Знание` с
`Внутри=current task`. Поэтому список, порядок и состояние одинаковы на
разных устройствах. `localStorage` хранит только последний успешный ответ для
быстрой отрисовки.

## Размещение

Knowledge/Section имеет ровно одно прямое место:

- `Внутри`: task или section;
- либо `Знание: Проект`;
- либо `Знание: Направление`;
- либо `Знание: Сфера`.

Контекст вверх по иерархии материализуется в скрытые SYS-поля. Он не
превращается в дополнительные прямые связи и не используется как локальный
display-filter. Parent/Sub-item и `3. Проекты` остаются task-only. Метрики
проектов учитывают только `Тип=Задача`.

Для подзадачи backend идёт по единственной цепочке Parent item до первого
однозначного проекта, затем проверяет единственные направление и сферу
проекта. Несколько значений, `has_more`, цикл, чужой data source или
не-task parent останавливают операцию до Drive/Notion mutation с диагностикой
`needs_review/context_error`.

## Контракт виджета

Схема содержит 19 скрытых widget-полей: раздел, формат, провайдер, Google File
ID, Google Folder ID, MIME type, download name, размер, SHA-256, Drive MD5,
позиция, sync status, время и текст ошибки sync, normalized URL, idempotency
key, Task Page ID, Knowledge key и Integrity. Перед canary проверяются имена,
типы, select options и формулы всех 19 полей.

## Виджет

Первая staging-версия разворачивается на одном origin: Node backend отдаёт и
static widget, и `/api`. Браузер получает только:

- `task_page_id`;
- подписанный ограниченный одной задачей access token;
- публичный API base URL.

Google refresh token, OAuth secret, Notion token и webhook verification token
существуют только на backend.

Основной canary-поток:

1. Владелец заранее указывает одну тестовую задачу в основной «Элементы».
2. Backend проверяет точный parent data source, `Тип=Задача` и page allowlist.
3. Embed добавляется только в эту canary-задачу.
4. После полной проверки тот же поток разрешается ровно для одного выбранного
   шаблона задачи.
5. Массовый поиск/замена embed по существующим страницам не выполняется.
6. Виджет читает `Тип=Знание + Внутри=current task`.
7. Docs/Sheets/Slides создаются в стабильной task-folder staging Drive.
8. Запись «Элементы» создаётся только после проверки ответа Drive,
   parent/appProperties и контрольных сумм.
9. Retry с тем же `Idempotency-Key` восстанавливает ту же операцию, а другой
   payload получает conflict.

## Drive

Staging Drive root задаётся точным ID. В нём создаётся одна папка на
`task_page_id`; идентичность папки не зависит от имени задачи. До первой записи
backend сверяет OAuth principal, root ID, staging marker и отсутствие
anyone/domain permissions.

Скачивание разрешается, только если Knowledge принадлежит текущей задаче,
File ID совпадает с записью, parent совпадает с task-folder и
`appProperties.task_page_id` совпадает. HTTP filename берётся из неизменяемого
`[SYS] Download name`, поэтому последующее переименование в Drive не меняет
имя скачиваемого исходника.

До итоговой приёмки разрешены чтение, создание canary-файлов, переименование,
reorder и archive без удаления файла. Unlink с очисткой `Внутри`, перемещение в
Drive Trash и permanent delete заблокированы. Их нельзя включить косвенно через
cleanup или recovery.

## Task-scoped metadata sync

Ручной refresh и периодическая canary-сверка работают только для одной
allowlisted задачи; whole-data-source sweep отсутствует. По File ID обновляются
Name, canonical URL, MIME, size и Drive MD5, а после восстановления очищаются
`sync_error`/`Ошибка sync`. `Download name`, SHA-256, idempotency key,
категория, позиция, `Тип` и `Внутри` не перезаписываются. Чужой parent,
удалённый файл или неверные appProperties переводят запись в
`error/sync_error`. SLA не считается подтверждённым до live E2E.

## Границы адаптеров

- Main Notion client — запись только в точную «Элементы» и только по
  canary/template page allowlist.
- Legacy Notion-контуры — read-only.
- Drive client — только staging root и созданные canary task-folders.
- Migration harness — offline JSON; сетевого клиента нет.
- Production GitHub Pages/widget, Apps Script, ветка `main` и действующие
  embeds не входят в staging runtime.

## Ограничение host binding

Внешний iframe не получает криптографически подтверждённый ID страницы-хоста
от Notion. Поэтому `WRITE_GATE` остаётся закрытым до live-теста дублирования и
выбора fail-closed host attestation. Webhook может исправить copied embed, но
сам по себе не доказывает отсутствие короткого окна до доставки события.
