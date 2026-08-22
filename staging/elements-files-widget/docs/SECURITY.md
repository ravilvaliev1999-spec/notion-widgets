# Безопасность

## Вывод аудита legacy

Текущий публичный task-files контур нельзя переносить как backend. Аудит выявил опубликованный общий credential, недостаточную изоляцию task/file и слишком широкие полномочия старого Drive/Notion контура. Кроме того, заявленный live taskfileswidgetv18.html на main фактически является другим интерфейсом.

Технические детали и значения ключей намеренно не публикуются в этом открытом репозитории; полный отчёт хранится в закрытом Backup/Handoff. Опубликованный общий ключ следует считать скомпрометированным и ротировать отдельной production-операцией после готового rollback.

## Новые барьеры

- Только APP_ENV=staging.
- DRY_RUN=true и WRITE_GATE=closed по умолчанию.
- Sandbox allowlist обязателен; unknown ID запрещён.
- Original workspace, databases, data sources, templates, deleted IDs и source rows входят в denylist.
- Пересечение allowlist/denylist останавливает процесс.
- Access token подписан и ограничен task_page_id.
- CORS — точный список origin; wildcard отсутствует.
- Notion webhook проверяется HMAC-SHA256 по raw body.
- Drive file проверяется по folder parent и appProperties.
- Перед первой mutation проверяются ожидаемый Google account, точный staging root, marker и отсутствие anyone/domain permissions.
- Удаление файла — двухшаговый intent/confirm с 60-секундным token; runtime перемещает файл в корзину, а не вызывает permanent delete.
- Нет public permissions и вызовов permissions.create.
- JSONP, shared browser key, Apps Script fallback и whole-Drive scan отсутствуют.
- Upload limit 512 MiB; размер и SHA-256 проверяются.
- Crash recovery принимает Drive-файл только с server-written verified marker либо повторно скачивает и хэширует его; непрошедший файл не превращается в Notion-карточку.
- Server secrets исключены из frontend, логов и Git.

## Перед staging deploy

1. Создать отдельный Google Cloud project/OAuth client.
2. Redirect URI и consent screen ограничить staging-доменом.
3. Refresh token хранить в secret manager.
4. Создать отдельную Notion integration только для sandbox.
5. Разрешить integration только sandbox root/data sources.
6. Включить HTTPS и точный ALLOWED_ORIGINS.
7. Сгенерировать TOKEN_SIGNING_SECRET минимум 32 случайных байта.
8. Настроить Notion webhook и сохранить verification token как secret.
9. Проверить, что staging Drive folder не имеет anyone/domain permissions.
10. Установить уникальный `appProperties.elementsStagingBoundary` либо один `.elements-staging-boundary.json` в root и тот же `STAGING_DRIVE_MARKER` в secrets.
11. Задать `GOOGLE_EXPECTED_ACCOUNT_EMAIL` и original Drive denylist.
12. Выполнить duplicate-task isolation acceptance; без доказанного host binding write gate не открывать.
13. Запустить negative tests allowlist/denylist до открытия gate.

## Production remediation — только после Gate B

- Ротировать legacy shared key.
- Отозвать старый Apps Script deployment или ограничить его.
- Удалить Anyone access и public-by-link side effects.
- Защитить main required checks.
- Исключить diagnostic/legacy HTML из Pages publish.
- Очистку Git history выполнять отдельно: это разрушительная операция и не заменяет ротацию.
