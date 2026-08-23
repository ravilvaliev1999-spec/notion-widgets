# Безопасность

## Вывод аудита Legacy

Действующий публичный task-files контур нельзя повторно использовать как
backend staging-виджета. В нём обнаружены общий browser credential,
недостаточная изоляция task/file и слишком широкие полномочия старого
Drive/Notion контура. Значения секретов в этом репозитории не публикуются.

Legacy-виджет, Apps Script и production deployment остаются неизменными до
итоговой приёмки. Ротация или отзыв старого контура — отдельная production-
операция с собственным rollback.

## Новые барьеры

- Только `APP_ENV=staging`.
- `DRY_RUN=true` и `WRITE_GATE=closed` по умолчанию.
- Notion allowlist содержит точный ID основной «Элементы», одну canary-задачу
  и затем один явно выбранный шаблон; unknown ID запрещён.
- Все остальные основные/Legacy databases, data sources, templates и pages
  остаются вне write-scope.
- До первой mutation сверяются все 19 widget-полей.
- Массового обхода страниц и массовой замены embed нет.
- Повторяющиеся widget embed-блоки не удаляются: один детерминированный блок
  может быть обновлён, остальные сохраняются, а task получает
  `Integrity=duplicate`.
- Access token подписан и ограничен `task_page_id`.
- CORS — точный список origin; wildcard отсутствует.
- Notion webhook проверяется HMAC-SHA256 по raw body.
- Drive file проверяется по folder parent и `appProperties`.
- Перед первой mutation проверяются ожидаемый Google account, точный staging
  root, marker и отсутствие anyone/domain permissions.
- До итоговой приёмки unlink с очисткой relation, перемещение в Drive Trash и
  permanent delete заблокированы.
- JSONP, shared browser key, Apps Script fallback и whole-Drive scan
  отсутствуют.
- Upload ограничен по размеру; размер и SHA-256 проверяются.
- Crash recovery принимает Drive-файл только с server-written verified marker
  либо после повторной проверки содержимого.
- Server secrets исключаются из frontend, логов и Git.

## Перед canary deploy

1. Проверить точные Elements data source, canary page и template page ID.
2. Ограничить Notion integration минимально необходимым доступом к основной
   «Элементы»; не открывать ей Legacy-контуры.
3. Проверить схему 19 widget-полей и baseline counts/relations/views.
4. Создать отдельный Google Cloud OAuth client для staging.
5. Ограничить redirect URI и consent screen staging-доменом.
6. Хранить refresh token только в server-side secret store.
7. Развернуть staging backend по HTTPS с точным `ALLOWED_ORIGINS`.
8. Сгенерировать отдельный `TOKEN_SIGNING_SECRET`.
9. Настроить и проверить Notion webhook secret.
10. Проверить staging Drive root ID, boundary marker и permissions.
11. Выполнить negative tests allowlist/denylist до открытия gate.
12. Выполнить duplicate-task host-binding test.

OAuth, hosting и live E2E на момент написания остаются gates; этот документ не
утверждает, что они пройдены.

## Запрещённые cleanup-пути до приёмки

- удаление Legacy-баз, страниц, свойств, статусов или relations;
- автоматическое обнуление `Внутри` при unlink;
- удаление повторяющихся embed-блоков вместо маркировки `duplicate`;
- массовое удаление/замена embed-блоков;
- Drive Trash и permanent delete;
- любые изменения production-виджета, Apps Script, ветки `main` или их
  deployment.

## Production remediation — только после Gate B

- ротировать Legacy shared key;
- отозвать или ограничить старый Apps Script deployment;
- убрать публичные Drive permissions;
- защитить `main` required checks;
- исключить diagnostic/Legacy HTML из Pages publish.

Очистка Git history и Legacy-данных всегда рассматривается отдельно: она
разрушительна и не заменяет ротацию секретов.
