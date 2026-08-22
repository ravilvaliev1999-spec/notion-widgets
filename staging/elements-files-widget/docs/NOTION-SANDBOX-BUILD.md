# Сборка отдельного Notion sandbox

## Gate A — до любой миграции

1. Войти в Notion UI и создать отдельный workspace, не страницу в original workspace.
2. Выполнить официальный export original workspace и положить архив в Drive/01_Backup.
3. Импортировать export в отдельный workspace.
4. Создать sandbox integration и дать ей доступ только к sandbox root.
5. Снять полный ID map original→sandbox для Сфер, Направлений, Проектов, Задач, шаблонов, wrappers и views.
6. Проверить, что ни одна relation, rollup, formula, linked view, synced block или embed не ссылается на original.

Простая копия опасна: шаблоны Сферы, Направления и Проекта содержат linked views original data sources. Они должны быть пересозданы с sandbox IDs. Копии production embeds также удаляются/заменяются только в sandbox.

## Базовая структура

Сохранить 5 sandbox-сфер для полноты, но на Main показывать четыре:

- Работа;
- Развитие и продуктивность;
- Личное;
- Финансы и активы.

«Идеи» не удалять: скрыть из Main и перенести семантику в global Inbox/Idea views.

Сохранить 13 направлений и 45 проектов. Deleted «Петрович» и deleted task из manifest не восстанавливать автоматически; оставить reconciliation entries.

## Создание «Элементы»

1. Скопировать sandbox Tasks data source, чтобы сохранить task formulas/rollups.
2. Перепривязать 3. Проекты к sandbox Projects.
3. Пересоздать Parent/Sub-item как self-relation target «Элементы».
4. Добавить properties из config/elements-schema.contract.json.
5. Скрыть SYS/MIG свойства из обычных views.
6. До regression gate не переписывать исходные task formulas.

## Миграция

Два прохода для 128 tasks:

1. Создать skeleton pages и ledger source→target.
2. Перенести свойства/body, затем восстановить mapped relations.

Для Статус=Знание: преобразовать в Тип=Знание, назначить одно место, очистить task-only поля. Option «Знание» удалять только после проверки.

Для 16 Knowledge pointers:

1. Перейти по Источник к legacy source page.
2. Рекурсивно скопировать body и всё поддерево; текущие карточки не являются полной копией.
3. Перенести Избранное, тип/категорию, URL и files.
4. Выбрать одно наиболее конкретное direct placement: Task > Project > Direction > Sphere.
5. Более широкие legacy relations считать inherited context, не direct placements.
6. Неоднозначность на одном уровне отправить в Inbox + MIG needs_review.

Не объявлять полноту, пока недоступны:

- old Knowledge DS c43dbf41… и 20 target pages;
- Files DS 2d90f52d…;
- более глубокие поддеревья 16 legacy source pages.

## Views

Создать:

- Входящие — Тип empty, Архив=false;
- Задачи — Тип=Задача;
- Сегодня / В работе / Бэклог / Идеи — Тип=Задача плюс task filter;
- Знания — Тип=Знание, Архив=false;
- Разделы — Тип=Раздел, Архив=false;
- Ошибки размещения;
- Ошибки типа;
- SYS Widget sync errors;
- SYS Migration control / Needs review / Archive.

В Sphere/Direction/Project templates показывать только direct knowledge relation соответствующего уровня. В Task template показывать Knowledge with Внутри=current task. Inherited context не использовать в локальном фильтре.

## Templates

- Задача: Тип=Задача, Статус=Бэклог, описание/шаги, подзадачи и материалы.
- Знание: Тип=Знание.
- Раздел знаний: Тип=Раздел, непосредственные подразделы/материалы.
- Раздел-список: Тип=Раздел, непосредственные задачи.
- Входящие: пустой Тип.

Backend webhook добавляет task-specific widget embed в sandbox-задачу идемпотентно.

## Gate A exit

- 128/16/5/13/45 reconciled.
- Initial Elements=144 до legacy files/dedup.
- Все target relations указывают только на sandbox.
- Body/subtree/files checks зафиксированы.
- Original counts и last_edited timestamps не изменились.
- Пять tasks с 19 projects вынесены на бизнес-review; автоматической правки нет.
