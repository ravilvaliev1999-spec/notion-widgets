# Deployment gates

Staging frontend/backend и staging Drive предназначены для явно разрешённой
основной Notion data source «Элементы». Отдельный Notion sandbox workspace не
является требованием этого rollout. Запись остаётся закрытой до появления
внешних доказательств ниже.

## Блокирует `WRITE_GATE=open`

1. Не подтверждены точный Elements data source ID и минимальный Notion
   write-scope только для него.
2. Не сверены в live-схеме имена, типы, options и формулы всех 19 widget-полей.
3. Не зафиксированы точные ID одной canary-задачи и одного тестового шаблона;
   unknown page должен fail closed.
4. Нет готового staging backend hosting/HTTPS и отдельного server-side Google
   OAuth client/refresh token.
5. Staging Drive root должен иметь точный ID, уникальный boundary marker и не
   иметь anyone/domain permissions.
6. Duplicate-task isolation требует доказанного host binding. Исправление
   copied embed постфактум не считается достаточной защитой.
7. Нужен live E2E на desktop/web/mobile: create/upload/download, SHA-256,
   rename, reorder, idempotent retry и recovery.

Локальные unit/offline tests не закрывают OAuth, hosting или live E2E gates.

## Ограничение охвата до приёмки

- сначала одна canary-задача;
- после успешной сверки — один тестовый шаблон;
- массовый embed sweep отсутствует;
- production-виджет, Apps Script, ветка `main` и deployment неизменны;
- старые базы, страницы, свойства, статусы и связи сохраняются как Legacy или
  скрываются;
- unlink с очисткой relation, Drive Trash и permanent delete заблокированы.

## Проверка после каждого шага

После canary и после теста шаблона повторно сверяются:

- общее количество и типы записей;
- `Внутри`, direct placement и task-only relations;
- формулы и значения 19 widget-полей;
- системные и пользовательские views;
- Drive parent, appProperties, MIME, размер и контрольные суммы;
- отсутствие изменений в production и Legacy-контурах.

Любое необъяснённое расхождение закрывает gate и переводит затронутые canary-
объекты в `needs_review` без очистки или удаления.

## После приёмки

Любой охват шире одного шаблона, включение unlink/Trash либо production
cutover требует отдельного решения владельца и нового плана проверки.
