# Acceptance и regression

## Барьеры

- WRITE_GATE closed: любая mutation возвращает отказ до внешнего вызова.
- DRY_RUN true: migration ничего не записывает.
- original ID как target: процесс не стартует.
- unknown target: отказ.
- allowlist∩denylist: отказ.
- source token не экспонирует write methods.

## Модель

- 128 tasks и 16 knowledge sources reconciled.
- Knowledge/Section имеет ровно одно direct placement.
- Inbox имеет ноль placements и ноль task-only полей.
- Knowledge не использует 3. Проекты или Parent/Sub-item.
- Section inside указывает только на Section; цикл отклоняется.
- Task metrics до/после добавления Knowledge совпадают.
- Main показывает четыре сферы; пятая сохранена для reconciliation.

## Виджет

1. Создать три Docs: три разных File ID и три Knowledge rows.
2. Повторить для Sheets и Slides.
3. Загрузить DOCX/XLSX/CSV/PPTX без конвертации.
4. Скачать и сравнить размер + SHA-256.
5. Переименовать в Drive: Name обновляется не позднее 60 секунд, дубля нет.
6. Очистить localStorage: список восстанавливается из Notion.
7. Открыть второе устройство: список и порядок совпадают.
8. Перетащить элементы: порядок сохраняется после reload.
9. Повторить запрос с тем же Idempotency-Key: новая строка/файл не появляется.
10. Archive: файл остаётся в Drive.
11. Unlink: файл остаётся, запись покидает task и становится Inbox/audit record.
12. Move to Drive Trash: только после отдельного confirmation; чужой File ID отклоняется; permanent delete не вызывается.
13. Duplicate task получает независимый task_page_id и пустой список.
14. Dark/light, 4/2/1 columns, iPhone portrait, клавиатурная навигация.

## Webhooks и sync

- Неверная X-Notion-Signature отклоняется.
- Event вне sandbox игнорируется.
- Повтор event не создаёт второй embed.
- Drive parent/appProperties mismatch переводит record в error и не скачивает/удаляет файл.
- Rename cycle укладывается в 60 секунд.

Пункт 13 является блокирующим security acceptance: webhook-исправление URL недостаточно, если copied embed успевает обратиться с токеном исходной задачи. До подтверждённого host-attestation/fail-closed поведения gate остаётся закрытым.

## Production regression

После всех sandbox tests:

- original 5/13/45/128/16 counts не изменились;
- original templates/embed URLs не изменились;
- main commit и live Apps Script deployment не изменились;
- никаких staging IDs в production и production IDs в sandbox relations.
