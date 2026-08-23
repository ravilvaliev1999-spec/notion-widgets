# Canary, acceptance и regression

Этот файл описывает ещё не завершённый live acceptance. Локальные tests могут
проверить guard-логику, но не заменяют OAuth, hosting, Notion/Drive E2E и
проверку на реальных устройствах.

## Нулевой baseline

До записи зафиксировать:

- точный ID основной Notion data source «Элементы»;
- общее количество записей и количество Task/Knowledge/Section/Inbox;
- количество placement/type errors;
- схемы relations, formulas и views;
- наличие, типы, options и formulas всех 19 widget-полей, core/context полей и
  relation targets Projects/Directions/Spheres;
- ID одной canary-задачи, одной canary Knowledge row, одного тестового шаблона
  и, для фазы `test-task`, точный ID одной созданной из него задачи;
- отсутствие canary ID в production-виджете, Apps Script и ветке `main`.

Старые базы, страницы, свойства, статусы и связи в baseline помечаются Legacy
или скрываются, но не удаляются.

## Fail-closed барьеры

- `WRITE_GATE=closed`: mutation отклоняется до внешнего вызова.
- `DRY_RUN=true`: migration ничего не записывает.
- target data source не равен точному main Elements ID: отказ.
- page ID не равен текущей canary/template allowlist: отказ.
- allowlist пересекается с защищённым Legacy/production denylist: отказ.
- отсутствует/отличается runtime property, relation target либо output одной
  из двух canary-формул: отказ.
- отсутствует, не разбирается, не принадлежит Notion или не совпадает с token
  referrer page ID: отказ до fetch/cache.
- source/read-only adapter не экспонирует write methods.
- unlink-clear, Drive Trash и permanent delete: отказ до отдельного
  post-acceptance разрешения.

## Модель данных

- Knowledge/Section имеет ровно одно direct placement.
- Inbox имеет ноль placements и ноль task-only полей.
- Knowledge не использует `3. Проекты` или Parent/Sub-item.
- Section inside указывает только на Section; цикл отклоняется.
- Task metrics до/после добавления Knowledge совпадают.
- Main показывает четыре сферы; Legacy-структуры и связи сохранены.
- Все 19 widget-полей дают ожидаемые значения на canary Knowledge-record.

## Этап 1 — одна canary-задача

1. Показать, что затрагивается ровно одна задача и исходно ноль её widget-
   записей/embed, либо зафиксировать существующее количество.
2. Добавить embed только в allowlisted canary page.
3. Создать по три Docs, Sheets и Slides; каждый объект должен иметь отдельный
   File ID и отдельную Knowledge row.
4. Загрузить DOCX/XLSX/CSV/PPTX без конвертации.
5. Скачать и сравнить MIME, имя, размер и SHA-256.
6. Переименовать в Drive; после reconciliation имя меняется без дубля.
7. Очистить `localStorage`; список восстанавливается из Notion.
8. Проверить второе устройство и порядок после reload.
9. Повторить запрос с тем же `Idempotency-Key`; дубль не появляется.
10. Archive оставляет файл в Drive.
11. Unlink с очисткой связи отклоняется.
12. Move to Drive Trash и permanent delete отклоняются.
13. Duplicate task получает независимый `task_page_id` и не может читать
    список исходной задачи.
14. Проверить dark/light, 4/2/1 columns, iPhone portrait и клавиатуру.

После этапа повторить baseline: counts, relations, formulas, views, 19 полей и
Legacy должны совпасть с ожидаемой дельтой canary. Любое другое изменение
закрывает gate.

## Этап 2 — один шаблон

Только после успешного этапа 1:

1. Показать, что будет изменён ровно один allowlisted шаблон.
2. Добавить embed в этот шаблон без обхода существующих страниц.
3. Создать одну тестовую задачу из шаблона, зафиксировать её точный ID и только
   после приёмки включить `TASK_WRITE_SCOPE=test-task` и embed-фазу
   `test-task` для CRUD/refresh и перепривязки retained embed. Scope `elements`
   на этом этапе запрещён.
4. Повторить host-binding, create/upload/download, rename, idempotency и
   recovery tests.
5. Снова сверить counts, relations, formulas, views и Legacy.

Массовый embed sweep не входит ни в один этап.

## Webhooks и sync

- неверная `X-Notion-Signature` отклоняется;
- event вне точной Elements/canary/template allowlist игнорируется;
- повтор event не создаёт второй embed;
- Drive parent/appProperties mismatch переводит record в error и не выдаёт
  содержимое;
- изменение size/MD5 сохранённого бинарного baseline даёт
  `needs_review/drive_content_changed`, не меняет baseline/время успеха и
  блокирует download;
- rename cycle измеряется live; SLA нельзя считать доказанным заранее.

## Production regression

После каждого этапа подтвердить:

- production-виджет, Apps Script, deployment и ветка `main` не изменились;
- существующие Legacy-базы/страницы/свойства/статусы/relations не удалены и не
  очищены;
- изменения Notion ограничены ожидаемой canary/template дельтой;
- staging Drive не вышел за точный root;
- unlink-clear, Trash и permanent delete не выполнялись.
