# Deployment gates

Код, offline migration и интерфейс готовы к staging-интеграции, но запись намеренно закрыта. Это не список «ручной работы», а перечень внешних доказательств, без которых безопасный запуск нельзя утверждать.

## Блокирует WRITE_GATE=open

1. Отдельный Notion workspace ещё не создан: в доступной браузерной сессии нет авторизации, а создавать sandbox-страницу внутри original workspace запрещено.
2. Нет отдельной sandbox Notion integration и её server-side token.
3. Нет отдельного deployment Google OAuth client/refresh token. Staging root должен получить уникальный `elementsStagingBoundary` marker.
4. Duplicate-task isolation требует доказанного host binding. Copied embed нельзя считать безопасным только потому, что webhook позже обновляет URL.
5. Нужен live acceptance на desktop/web/mobile, включая rename ≤60 секунд, duplicate task, загрузку/скачивание с SHA-256 и восстановление после сбоя.

## Блокирует заявление о полной миграции

- официальный export original workspace не получен;
- old Knowledge data source и её 20 targets недоступны интеграции;
- Files data source недоступна;
- 16 текущих Knowledge cards являются pointers: требуется рекурсивная копия legacy page bodies и дочерних страниц;
- неоднозначные task relations (5 задач по 19 проектов) требуют бизнес-решения, а не автоматического исправления.

## Ограничения первой staging-версии

- запускать один backend replica; process-local inflight lock дополняется Drive idempotency recovery, но не заменяет распределённый operation ledger;
- rename worker использует reconciliation polling; 60-секундный SLA должен быть доказан на реальном объёме;
- permanent Drive purge отсутствует намеренно; удаление из UI перемещает файл в корзину;
- production main, Apps Script, original templates и original Notion остаются неизменными до отдельного Gate B.
