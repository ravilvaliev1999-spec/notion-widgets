# Notion «Элементы» + файловый виджет — staging

Это изолированная staging-реализация новой системы. Она не заменяет текущий GitHub Pages, Apps Script, шаблон задач или базы исходного Notion.

## Текущий результат

- Проверены доступы к Notion, GitHub и Google Drive.
- Четыре исходных DOCX полностью прочитаны, визуально проверены, хэши и резервные копии зафиксированы.
- Оригинальный Notion проаудирован только на чтение: 5 сфер, 13 направлений, 45 проектов, 128 задач, 16 текущих записей знаний и несколько legacy-контуров.
- Создана отдельная GitHub-ветка staging/notion-elements-widget-v2; main не менялся.
- Подготовлен fail-closed backend без секретов в браузере.
- Подготовлен новый интерфейс четырёх карточек Drive / Docs / Sheets / Slides.
- Notion «Элементы» является источником истины; локальное хранилище используется только как кэш.
- Создание Google-native файлов возвращает Drive File ID сразу.
- Office-файлы загружаются без конвертации, с SHA-256, размером и оригинальным скачиванием.
- Порядок, переименование, замена внешней ссылки, архив, отвязка и подтверждённое перемещение в корзину разделены.
- Rename reconciliation запускается не реже одного раза в 60 секунд.
- Offline migration harness по умолчанию не умеет делать внешние записи и защищён allowlist/denylist.

## Жёсткая граница

Сервис стартует только с APP_ENV=staging. Любая запись требует одновременно:

    WRITE_GATE=open
    DRY_RUN=false

Sandbox workspace, root page и data source «Элементы» обязаны быть явно заданы и не могут совпадать ни с одним original/production ID. Неизвестный target отклоняется.

## Локальная проверка

Из этой папки:

    node --test backend/test/*.test.mjs frontend/test/*.test.mjs migration/test/*.test.mjs
    node scripts/secret-scan.mjs

Для безопасного запуска health/static UI оставьте WRITE_GATE=closed и DRY_RUN=true. Полный server start требует заполненного server-side OAuth и отдельного sandbox Notion.

## Навигация

- docs/ARCHITECTURE.md — модель данных и потоки.
- docs/SECURITY.md — найденные риски и новые барьеры.
- docs/NOTION-SANDBOX-BUILD.md — порядок сборки отдельного workspace.
- docs/TEST-PLAN.md — acceptance-набор.
- docs/CUTOVER.md — Gate B, production cutover и rollback.
- docs/DEPLOYMENT-GATES.md — честный список блокеров открытия записи.
- config/elements-schema.contract.json — полный контракт «Элементы».
- audit/baseline-summary-2026-08-22.json — агрегированный публично безопасный baseline.
- migration/README.md — offline migration harness.

## Что ещё требует внешней среды

Полный live acceptance нельзя честно объявить завершённым до появления:

1. отдельного Notion workspace и официального экспорта исходника;
2. отдельной sandbox integration с write-доступом только к sandbox;
3. отдельного Google OAuth client и staging backend URL;
4. доступа/экспорта недоступной old Knowledge DS c43dbf41… и Files DS 2d90f52d…;
5. рекурсивной копии поддеревьев 16 legacy source pages;
6. Gate B после прохождения тестов.

До этого production остаётся без изменений.
