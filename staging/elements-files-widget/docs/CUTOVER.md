# Gate B, cutover и rollback

## Gate B

Production change запрещён, пока нет всех пунктов:

- официальный export + восстановление проверены;
- отдельный sandbox workspace полностью собран;
- inaccessible old Knowledge/Files контуры либо получены, либо зафиксировано письменное исключение;
- migration ledger и reconciliation зелёные;
- task regression зелёный;
- widget acceptance зелёный на desktop/web/mobile;
- security negative tests зелёные;
- staging backend/OAuth/Drive изолированы;
- владелец явно подтвердил cutover.

## Безопасная последовательность cutover

1. Заморозить короткое окно изменений original.
2. Сделать свежий export и incremental reconciliation.
3. Зафиксировать last-known-good live URLs и deployment IDs.
4. Ротировать legacy shared key и подготовить отзыв старого backend.
5. Обновить только sandbox/production target, выбранный владельцем.
6. Сначала один pilot template/task.
7. Наблюдать минимум один полный рабочий цикл.
8. Расширять поэтапно; не удалять old bases.

## Rollback

- Вернуть сохранённый прежний embed URL/template.
- Закрыть новый WRITE_GATE.
- Остановить webhook/rename worker.
- Не удалять созданные Drive files; оставить их для reconciliation.
- Использовать ledger, чтобы отличить созданные staging/production rows.
- Восстановить из свежего export только после отдельного решения.

Историю Git, original databases и Drive folders не удалять в рамках rollback. Destructive cleanup — отдельный проект после периода стабильности.
