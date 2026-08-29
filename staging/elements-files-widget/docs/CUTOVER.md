# Gate B, приёмка и rollback

Текущий rollout уже нацелен на явно разрешённую основную Notion data source
«Элементы». Gate B относится не к переносу Notion в другой workspace, а к
расширению staging-canary и возможному будущему переключению production-
виджета. Production-виджет, Apps Script, ветка `main` и действующие embeds до
этого не меняются.

## Gate B

Расширение дальше одной canary-задачи и одного шаблона запрещено, пока нет
всех пунктов:

- точный Elements data source ID и canary/template page ID закреплены в
  allowlist;
- типы, options и формулы всех 19 widget-полей сверены;
- baseline количества записей, связей, формул и views сохранён и повторно
  совпал после canary;
- Legacy-базы, страницы, свойства, статусы и связи остались на месте;
- backend hosting, HTTPS, OAuth и отдельный staging Drive root готовы;
- migration ledger/reconciliation и task regression зелёные;
- widget acceptance и security negative tests пройдены live на
  desktop/web/mobile;
- duplicate-task isolation и host binding доказаны;
- владелец явно подтвердил следующий охват.

В репозитории нет утверждения, что эти live-проверки уже пройдены.

## Безопасная последовательность

1. Снять read-only baseline основной «Элементы» и проверить 19 полей.
2. Выполнить операцию на одной заранее выбранной canary-задаче.
3. Сверить количество записей, direct placement, формулы, views и Drive
   metadata; при расхождении закрыть gate.
4. Включить embed только в одном тестовом шаблоне задачи.
5. Создать задачу из шаблона и повторить полный E2E.
6. Наблюдать не меньше одного полного рабочего цикла.
7. Получить отдельное подтверждение владельца перед любым расширением.

Массовый обход или замена embed на существующих страницах не является шагом
этой процедуры.

## До приёмки запрещено

- удалять или очищать Legacy-данные;
- очищать `Внутри`/task linkage при unlink;
- перемещать Drive-файлы в корзину;
- выполнять permanent delete;
- менять production-виджет, Apps Script, `main` или production deployment.

## Rollback canary

- Немедленно закрыть `WRITE_GATE`.
- Отключить staging webhook/rename worker.
- Убрать только canary/template embed, добавленный этим rollout, если это
  подтверждено по журналу.
- Не очищать связи и не удалять созданные записи/файлы: пометить их
  `needs_review`/Legacy для reconciliation.
- Сверить baseline и зафиксировать расхождения до дальнейших действий.

Destructive cleanup возможен только как отдельная, явно подтверждённая работа
после итоговой приёмки.
