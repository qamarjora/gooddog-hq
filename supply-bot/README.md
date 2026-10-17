# Бот приёма поставок Good Dog (Apps Script)

Telegram-бот для кафе Good Dog (Астана): сотрудник присылает фото накладной, скриншот или PDF чека, бот читает документ
через Claude, сопоставляет позиции со справочником, собирает сводку, и после подтверждения записывает поставку в Poster
(в режиме `DRY_RUN=true` в Poster ничего не отправляется, владельцу приходит «🧪 Оприходовал бы…»).

Код — Google Apps Script (V8), привязанный к таблице «Управленческий учёт 2026». Файлы вставляются в редактор вручную
(без `clasp push`), все имена функций и констант с префиксом `supply` / `SUPPLY_`, чтобы не пересекаться со старым кодом проекта.

**Секретов в репозитории нет.** Токены, ключи и chat id хранятся только в Script Properties проекта. В эмуляции и самотестах
все значения (токены, chat id `111` / `999` / `555`, id поставщиков и ингредиентов) вымышленные.

## Файлы

### Apps Script (вставлять в проект)

| Файл | Назначение |
|---|---|
| `SupplyConfig.gs` | Константы, чтение Script Properties, флаги (`DRY_RUN`, `SUPPLY_SPLIT_LINES` и др.), экранирование, маскирование секретов в ошибках |
| `SupplyMain.gs` | Точка входа: `supplyPoll`, общая обработка апдейтов, `/myid`, `supplyInit`, установка триггера |
| `SupplyTelegram.gs` | Bot API: отправка/правка сообщений, скачивание файлов, повторы при сбоях (3 попытки, 5xx/429) |
| `SupplyWebhook.gs` | Приём апдейтов от ретранслятора (webhook), защита от дублей `update_id` |
| `SupplyDoPost.gs` | Простая обёртка `doPost` (вставлять, только если в проекте нет своего `doPost`) |
| `SupplyWebhookAdmin.gs` | Переключение polling ⇄ webhook, сторож `supplyWatchdog` (08:00–21:30 по Астане) |
| `SupplyState.gs` | Состояние диалога на скрытом листе `SUPPLY_STATE` |
| `SupplyStaff.gs` | Доступ сотрудников: лист «Сотрудники», заявки владельцу, `/staff`, кэш 60 с |
| `SupplyImage.gs` | Выбор размера фото из Telegram, разбор файла (фото / картинка / PDF), `file_unique_id` |
| `SupplyClaude.gs` | Промпт и вызов Claude (модель + откат), разбор JSON, поставщик по умолчанию, слияние позиций |
| `SupplyDirectory.gs` | Лист «Справочник накладных»: артикул, нечёткие названия, группы по `supplier_id`, статистика, синонимы |
| `SupplySuppliers.gs` | Лист «Поставщики»: сопоставление источника с `supplier_id`, флаг «несколько в день» |
| `SupplyRules.gs` | Лист «Правила сопоставления» (товары по ключевым словам, исключения) |
| `SupplyMatch.gs` | Сопоставление позиций документа, пересчёт в единицы склада (режимы прямо / коэффициент / ввод штук) |
| `SupplyChecks.gs` | Проверки ⚠️: арифметика, цена ±10%, диапазон количества, вес на штуку |
| `SupplySummary.gs` | Сводка для сотрудника и кнопки |
| `SupplyFlow.gs` | Диалог сотрудника: файл → чтение → дубль → вопросы → сводка → ✅ → запись |
| `SupplyOwner.gs` | Вопросы владельцу: новый поставщик, новая позиция, расхождение сумм |
| `SupplyJournal.gs` | Лист «Журнал поставок», ключ документа, поиск дублей, `file_unique_id` |
| `SupplyRecord.gs` | Запись: Poster (`storage.createSupply`), журнал, статистика, сообщения; разбиение по типам |
| `SupplyPoster.gs` | Poster API: ингредиенты и товары, поставщики, POST `createSupply`, проверка поставки |
| `worker.js` | Cloudflare Worker — ретранслятор webhook Telegram → Apps Script |

### Эмуляция и самотесты (запускаются локально, в Apps Script не вставляются)

| Файл | Назначение |
|---|---|
| `emulation/harness.js` | Эмуляция Apps Script: листы в памяти, Script Properties, кэш, Lock, Telegram / Claude / Poster как заглушки с внедрением сбоев |
| `emulation/run-selftests.js` | Запуск всех самотестов |
| `emulation/scenarios/scenario17.js` | Скриншот заказа без поставщика → поставщик по умолчанию «Закупка», слияние строк |
| `emulation/scenarios/scenario18.js` | Товары Poster по правилам, исключение «швепс», «N другое», смешанная поставка |
| `emulation/scenarios/scenario19.js` | Вода любого объёма, товары всегда «прямо» / шт |

## Запуск самотестов в эмуляции

Нужен Node.js (проверено на v24), зависимостей нет.

```bash
cd supply-bot
node emulation/run-selftests.js            # итог по наборам; код выхода 1, если есть провалы
VERBOSE=1 node emulation/run-selftests.js  # со всеми строками OK / FAIL
node emulation/scenarios/scenario18.js     # сквозной сценарий диалога
```

Самотесты (функции в `.gs`, их же можно запускать вручную в редакторе Apps Script):

`supplyClaudeSelfTest`, `supplyChecksSelfTest`, `supplyMatchSelfTest`, `supplyDupSelfTest`, `supplyStage4SelfTest`,
`supplyAccessSelfTest`, `supplyProductsSelfTest`, `supplyWatchdogSelfTest` — всего 323 проверки.

Эмуляция в `harness.js` загружает все `Supply*.gs` (кроме `SupplyDoPost.gs`) в один контекст, как в Apps Script. Телеграм, Claude и
Poster отвечают заготовленными данными; сбои сети внедряются через `faults`. Реальных запросов нет.

## Script Properties (только имена)

Обязательные: `TELEGRAM_TOKEN_INVOICES`, `CLAUDE_API_KEY`, `POSTER_TOKEN`, `SUPPLY_OWNER_CHAT_ID`, `DRY_RUN`
(боевая запись — только при явном `DRY_RUN=false`).

Необязательные: `MODEL`, `ALLOWED_CHAT_IDS` (запасной список; основной доступ — лист «Сотрудники»),
`SUPPLY_DEFAULT_SUPPLIER`, `SUPPLY_POSTER_SUM_MULTIPLIER`, `SUPPLY_POSTER_PRODUCT_TYPE`, `SUPPLY_POSTER_SPLIT_BY_TYPE`,
`SUPPLY_SPLIT_LINES`, `SUPPLY_WATCHDOG_FROM`, `SUPPLY_WATCHDOG_TO`; для webhook — `SUPPLY_RELAY_SECRET`,
`SUPPLY_WEBHOOK_SECRET`, `SUPPLY_WORKER_URL`.

## Листы таблицы (создаются ботом)

«Справочник накладных», «Журнал поставок», «Поставщики», «Сотрудники», «Правила сопоставления» и скрытые служебные
`SUPPLY_STATE`, `SUPPLY_REQUESTS`.

## Запуск в продакшене

1. Вставить файлы `Supply*.gs` в проект Apps Script, заполнить Script Properties.
2. `supplyInit()` — проверка свойств и создание служебных листов; `supplyPosterResolveIds()` — заполнить `ingredient_id`.
3. Polling: `supplyInstallTrigger()` (раз в минуту). Webhook: развернуть веб-приложение, задать Worker (`worker.js`),
   `supplySwitchToWebhook()`, `supplyInstallWatchdog()`.
4. Перед боевым режимом: тестовая поставка на 1–2 штуки и сверка цены и итога в Poster.

## Изменения от 17.10.2026 (меньше текста и лишних вопросов)

- **НДС:** строка сходится и при «кол-во × цена × 1,16 = сумма строки» (цена без НДС, сумма с НДС). Ложных ⚠️ нет.
- **Допуск цены ±25%** (было ±10%).
- **Дубли:** проверка «тот же поставщик и та же сумма за 7 дней» выключена (`SUPPLY_RECENT_CHECK=true` включает обратно). Остаются: тот же снимок и ключ «поставщик + сегодня» (+ сумма у «несколько в день» = да).
- **Без вопроса «Фактически всё совпало?»** (`SUPPLY_ASK_ACTUAL=true` возвращает). После «✅ Верно» сразу запись и «✅ Принято · сумма».
- **Владельцу:** не шлются сообщения про откат на Sonnet и про неуверенность в номере документа; пометки «(по правилу)» / «(товар)» только в dry-run.
- **Вечерний отчёт владельцу** (`SupplyDigest.gs`): число накладных и сумма за день, поставщики, ошибки Poster. В день без поставок сообщения нет. Триггер: запустить вручную `supplyInstallDigest()` (ежедневно около 21:30 по Астане).
- **Проверка:** `node emulation/run-selftests.js` запускает 9 наборов самотестов и сценарии `emulation/scenarios/check-regression.js` (22 проверки).

## Каталог Poster для заполнения (SupplyCatalog.gs)

`supplyCatalogExport()` выгружает все ингредиенты и товары (type=3) на лист «Каталог Poster». Владелец в колонке F выбирает из списка, как позиция считается на складе (1 к 1 / пересчёт / вес→штуки / не оприходовать), при необходимости пишет коэффициент (G) и заметку (H). Из «Справочника накладных» подставляется то, что бот уже знает. Повторный запуск ответы не стирает. `supplyCatalogProgress()` показывает, сколько осталось заполнить.
