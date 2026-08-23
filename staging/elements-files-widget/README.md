# Notion «Элементы» + файловый виджет — staging

Это staging-реализация нового файлового виджета. Её Notion-цель — явно
разрешённая основная data source «Элементы». Отдельный Notion workspace для
этого этапа не создаётся. Production-виджет, действующий Apps Script,
GitHub-ветка `main` и их deployment остаются без изменений до итоговой
приёмки.

## Граница этапа

- Notion-запись разрешается только для точного ID основной data source
  «Элементы» и заранее перечисленных canary/template/test-task page ID.
- Сначала проверяется одна тестовая запись, затем один шаблон задачи.
- Массового обхода страниц и массовой замены embed нет.
- Старые базы, страницы, свойства, статусы и связи не удаляются и не
  очищаются: до приёмки они сохраняются как Legacy либо скрываются.
- До приёмки заблокированы unlink с очисткой связи, перемещение Drive-файла в
  корзину и permanent delete.
- Staging Drive использует отдельный точный root allowlist и не изменяет
  production Drive-контур.

## Модель данных виджета

Notion «Элементы» остаётся источником истины, а локальное хранилище браузера —
только кэшем. Контракт виджета содержит 19 скрытых полей:

1. `[SYS] Раздел виджета`
2. `[SYS] Формат файла`
3. `[SYS] Провайдер`
4. `[SYS] Google File ID`
5. `[SYS] Google Folder ID`
6. `[SYS] MIME type`
7. `[SYS] Download name`
8. `[SYS] Размер байт`
9. `[SYS] SHA-256`
10. `[SYS] Drive MD5`
11. `[SYS] Позиция`
12. `[SYS] Sync status`
13. `[SYS] Последняя синхронизация`
14. `[SYS] Ошибка sync`
15. `[SYS] Normalized URL`
16. `[SYS] Idempotency key`
17. `[SYS] Task Page ID`
18. `[SYS] Knowledge key`
19. `[SYS] Integrity`

Карточки Drive / Docs / Sheets / Slides работают через fail-closed backend:
секреты Google и Notion не передаются в браузер. Google-native файл получает
Drive File ID сразу; Office-файл сохраняется без конвертации, с размером и
контрольными суммами.

## Жёсткая граница запуска

Сервис стартует только с `APP_ENV=staging`. Любая разрешённая запись требует
одновременно:

    WRITE_GATE=open
    DRY_RUN=false

Этого недостаточно само по себе: точные Notion и Drive ID должны пройти
allowlist, а операция должна относиться к утверждённой canary-записи или
к отдельному точному rollout шаблона embed. До приёмки embed-фазы ограничены
`disabled|canary`, а файловые mutations остаются canary-only. После приёмки
`TASK_WRITE_SCOPE=test-task` и embed-фаза `test-task` требуют отдельный точный
ID скопированной задачи; scope `elements` зарезервирован для более позднего
явного полного cutover. Неизвестная цель отклоняется.

Перед открытием записи backend сверяет не только 19 widget-полей, но и все
используемые core/context properties, точные relation targets трёх контекстных
data sources и значения обеих формул на точном canary material. Виджет не
читает task-cache и не вызывает API без parseable Notion referrer с тем же
page ID, что и подписанный task token.

## Локальная проверка

Из этой папки:

    node --test backend/test/*.test.mjs frontend/test/*.test.mjs migration/test/*.test.mjs
    node scripts/secret-scan.mjs

Для безопасного просмотра health/static UI оставьте `WRITE_GATE=closed` и
`DRY_RUN=true`. Эти команды не являются live E2E и не доказывают готовность
OAuth, hosting, Notion webhook или реальной синхронизации Drive.

## Навигация

- `docs/ARCHITECTURE.md` — модель данных и потоки.
- `docs/SECURITY.md` — риски и защитные барьеры.
- `docs/NOTION-SANDBOX-BUILD.md` — исторический Legacy-план; не активная
  инструкция.
- `docs/TEST-PLAN.md` — canary, acceptance и regression.
- `docs/CUTOVER.md` — переход после итоговой приёмки и rollback.
- `docs/DEPLOYMENT-GATES.md` — блокеры открытия live-записи.
- `config/elements-schema.contract.json` — контракт «Элементы».
- `migration/README.md` — offline migration harness.

## Что остаётся воротами

Live acceptance нельзя считать завершённым, пока не готовы и не проверены:

1. server-side Google OAuth для staging и точный Drive root;
2. staging backend URL/hosting и HTTPS;
3. минимально необходимый Notion write-доступ к основной «Элементы»;
4. canary E2E на desktop/web/mobile, включая duplicate-task isolation,
   rename, upload/download и recovery;
5. отдельное подтверждение владельца на любые действия шире одного шаблона.

До этого production-виджет, Apps Script, `main`, массовые embeds и Legacy
остаются без изменений.
