/**
 * Good Dog — модуль приёма поставок. Настройки.
 * Все секреты и настройки читаются только из Script Properties.
 */

var SUPPLY_CONST = {
  SHEET_STATE: 'SUPPLY_STATE',
  SHEET_DIR: 'Справочник накладных',
  SHEET_JOURNAL: 'Журнал поставок',
  SHEET_SUPPLIERS: 'Поставщики',
  SHEET_STAFF: 'Сотрудники',
  SHEET_RULES: 'Правила сопоставления',
  SHEET_REQUESTS: 'SUPPLY_REQUESTS', // скрытый служебный лист: время заявок и молчание после отказа

  PROP_OFFSET: 'SUPPLY_TG_OFFSET',
  PROP_SEEN: 'SUPPLY_SEEN_IDS',          // последние обработанные update_id (защита от дублей)
  PROP_WATCHDOG: 'SUPPLY_WATCHDOG_STATE', // что сторож уже сообщал владельцу
  SEEN_MAX: 100,
  LOCK_WAIT_WEBHOOK_MS: 50000,           // сколько webhook-запрос ждёт замок

  POLL_BUDGET_MS: 45000,   // максимум времени одного запуска supplyPoll
  TG_BATCH: 50,            // сколько апдейтов забирать за один getUpdates

  DEFAULT_MODEL: 'claude-haiku-5-5',
  FALLBACK_MODEL: 'claude-sonnet-5-5',
  CLAUDE_MAX_TOKENS: 2000,
  ANTHROPIC_VERSION: '2023-06-01',

  POSTER_HOST: 'good-dog2.joinposter.com',
  POSTER_STORAGE_ID: 1,
  TYPE_INGREDIENT: 4,           // type ингредиента в createSupply
  POSTER_PRICE_DECIMALS: 6,      // знаков в цене, если точное разбиение по тиынам невозможно (одна строка S/Q)
  ING_CACHE_TTL_SEC: 6 * 3600,

  STATUS_ACCEPTED: 'принято',    // блокирует повторную отправку документа
  STATUS_DRYRUN: 'dry-run',      // учитывается при поиске дублей
  STATUS_POSTER_ERROR: 'ошибка Poster', // Poster не принял поставку; в дубли не считается, повторная отправка возможна

  MODE_DIRECT: 'прямо',
  MODE_COEF: 'коэффициент',
  MODE_PIECES: 'ввод штук',
  MODE_SKIP: 'пропускать',
  MODE_ASK_PACK: 'спросить упаковку',    // бот спрашивает, сколько в одной упаковке; на склад = кол-во упаковок × ответ
  MODE_ASK_QTY: 'спросить количество',   // бот спрашивает итоговое количество в единицах склада (соусы, сливки)
  MODE_JARS: 'банки',                    // бот спрашивает чистый вес одной банки; на склад = вес × число банок

  STAFF_ACTIVE: 'активен',
  STAFF_DISABLED: 'отключён',
  STAFF_CACHE_KEY: 'SUPPLY_STAFF_V1',
  STAFF_CACHE_SEC: 60,                  // список сотрудников кэшируется на 60 секунд
  REQUEST_COOLDOWN_MS: 3600 * 1000,     // повторные заявки от одного id — не чаще раза в час
  REJECT_SILENCE_MS: 24 * 3600 * 1000,  // после отказа бот молчит 24 часа

  PIECE_WEIGHT_TOL: 0.15,        // допустимое отклонение веса на штуку
  SUPPLIER_FUZZY_MIN: 0.85,      // порог схожести названия поставщика с листом «Поставщики»
  FUZZY_MIN: 0.8,               // порог схожести названий для нечёткого сопоставления
  PRICE_TOL: 0.25,              // допустимое отклонение цены от последней (±25%: мелкие колебания не беспокоят)
  VAT_FACTOR: 1.16,             // НДС 16%: у части накладных цена без НДС, а сумма строки с НДС
  QTY_MIN_DELIVERIES: 3,         // проверка диапазона количества включается с 3-й поставки
  QTY_FACTOR: 3,                 // «сильно выходит»: больше среднего ×3 или меньше ÷3

  IMG_MAX_PX: 1500,             // длинная сторона после сжатия
  IMG_MAX_BYTES: 5 * 1024 * 1024, // лимит Claude на одно изображение
  PDF_MAX_BYTES: 30 * 1024 * 1024,
  TG_DOWNLOAD_MAX_BYTES: 20 * 1024 * 1024 // лимит Bot API на скачивание
};

/** Значение Script Property или '' (пустая строка), если не задано. */
function supplyProp_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  return v === null || v === undefined ? '' : String(v).trim();
}

/** DRY_RUN: безопасный режим по умолчанию. В Poster пишем только при явном DRY_RUN=false. */
function supplyIsDryRun_() {
  return supplyProp_('DRY_RUN').toLowerCase() !== 'false';
}

/** ALLOWED_CHAT_IDS (через запятую) -> массив строк. */
function supplyAllowedChats_() {
  return supplyProp_('ALLOWED_CHAT_IDS')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });
}

// supplyIsAllowedChat_ (владелец, ALLOWED_CHAT_IDS, активные сотрудники из листа «Сотрудники») — в SupplyStaff.gs.

function supplyIsOwnerChat_(chatId) {
  var owner = supplyOwnerChat_();
  return owner !== '' && owner === String(chatId);
}

/** Владелец (получает сводки dry-run и ошибки): SUPPLY_OWNER_CHAT_ID. */
function supplyOwnerChat_() {
  return supplyProp_('SUPPLY_OWNER_CHAT_ID');
}

/**
 * SUPPLY_POSTER_SUM_MULTIPLIER (по умолчанию 1): множитель цены за единицу при записи в Poster.
 * Поставить 100, если Poster принимает цены в тиынах.
 */
function supplyPosterSumMultiplier_() {
  var v = Number(supplyProp_('SUPPLY_POSTER_SUM_MULTIPLIER'));
  return isFinite(v) && v > 0 ? v : 1;
}

/** «true» / «да» / 1 (регистр не важен) — для флагов в Script Properties. */
function supplyFlagTrue_(v) {
  return /^(true|да|yes|1)$/i.test(String(v === null || v === undefined ? '' : v).trim());
}

/**
 * SUPPLY_SPLIT_LINES (по умолчанию false): разбивать позицию на две строки createSupply, чтобы итог совпадал
 * до тиына (supplySplitLineT_). По умолчанию одна позиция накладной = одна строка, цена за единицу = S/Q на 6 знаков.
 */
function supplySplitLinesEnabled_() {
  return supplyFlagTrue_(supplyProp_('SUPPLY_SPLIT_LINES'));
}

/**
 * SUPPLY_DEFAULT_SUPPLIER (по умолчанию «Закупка»): запасной поставщик для документов без поставщика/магазина
 * (скриншоты заказов из приложений доставки). Его supplier_id берётся с листа «Поставщики» по этому названию.
 */
function supplyDefaultSupplierName_() {
  return supplyProp_('SUPPLY_DEFAULT_SUPPLIER') || 'Закупка';
}

/**
 * SUPPLY_POSTER_PRODUCT_TYPE (по умолчанию 1): type строки-товара в storage.createSupply. По документации Poster:
 * «товар, производимая техкарта или производимый полуфабрикат — 1, ингредиент — 4, модификатор товара — 5»,
 * id строки-товара — product_id. Проверка на ручной поставке: supplyPosterCheckSupply(<ID поставки>).
 */
function supplyPosterProductType_() {
  var v = Number(supplyProp_('SUPPLY_POSTER_PRODUCT_TYPE'));
  return isFinite(v) && v > 0 ? v : 1;
}

/**
 * SUPPLY_POSTER_SPLIT_BY_TYPE (по умолчанию false): всегда делить поставку на две (товары и ингредиенты отдельно).
 * По умолчанию товары и ингредиенты уходят одной поставкой; если Poster определённо отвечает ошибкой,
 * поставка автоматически повторяется как две отдельные (владелец уведомляется).
 */
function supplySplitByTypeEnabled_() {
  return supplyFlagTrue_(supplyProp_('SUPPLY_POSTER_SPLIT_BY_TYPE'));
}

/**
 * SUPPLY_ASK_ACTUAL (по умолчанию false): после «✅ Верно» спрашивать сотрудника «Фактически всё совпало с документом?».
 * По умолчанию вопроса нет: после ✅ документ сразу записывается.
 */
function supplyAskActualEnabled_() {
  return supplyFlagTrue_(supplyProp_('SUPPLY_ASK_ACTUAL'));
}

/**
 * SUPPLY_RECENT_CHECK (по умолчанию false): вторая проверка дубля «тот же поставщик и та же сумма за 7 дней».
 * Выключена: у хлеба и других ежедневных поставок сумма часто повторяется, и бот зря спрашивал «какой это документ».
 * Остаются: тот же снимок (file_unique_id) и ключ «поставщик + сегодня» (+ сумма у «несколько в день» = да).
 */
function supplyRecentCheckEnabled_() {
  return supplyFlagTrue_(supplyProp_('SUPPLY_RECENT_CHECK'));
}

function supplyModel_() {
  return supplyProp_('MODEL') || SUPPLY_CONST.DEFAULT_MODEL;
}

/**
 * Общий замок для polling и webhook. Документный; если в контексте веб-приложения
 * его нет — запасной скриптовый. Возвращает замок или null, если занят.
 */
function supplyLockAcquire_(waitMs) {
  var lock = null;
  try { lock = LockService.getDocumentLock(); } catch (e) { lock = null; }
  if (!lock) lock = LockService.getScriptLock();
  return lock.tryLock(waitMs) ? lock : null;
}

/** Убирает из текста значения секретов (токены, ключи) и типовые шаблоны токенов. */
function supplySanitizeSecrets_(text) {
  var s = String(text === null || text === undefined ? '' : text);
  ['TELEGRAM_TOKEN_INVOICES', 'CLAUDE_API_KEY', 'POSTER_TOKEN', 'SUPPLY_RELAY_SECRET', 'SUPPLY_WEBHOOK_SECRET']
    .forEach(function (name) {
      var v = supplyProp_(name);
      if (v.length >= 4) s = s.split(v).join('***');
    });
  return s
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/(token["']?\s*[=:]\s*["']?)[^&"'\s,}]+/gi, '$1***');
}

/**
 * Где упало: первые maxLines строк стека вида «at функция (файл:строка:символ)», без секретов.
 * Если стека нет (исключение не Error), возвращает пустую строку.
 */
function supplyErrDetails_(e, maxLines) {
  var stack = e && e.stack ? String(e.stack) : '';
  if (!stack) return '';
  var lines = stack.split('\n').map(function (l) { return l.trim(); });
  var at = lines.filter(function (l) { return /^at\s/.test(l); });
  if (!at.length) at = lines.slice(1);
  return supplySanitizeSecrets_(at.slice(0, maxLines || 3).join('\n'));
}

/** Экранирование для parse_mode=HTML в Telegram. */
function supplyEsc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Режимы, при которых бот спрашивает число у сотрудника (ввод штук — прежний режим). */
function supplyModeAsks_(mode) {
  return mode === SUPPLY_CONST.MODE_PIECES || mode === SUPPLY_CONST.MODE_ASK_PACK ||
    mode === SUPPLY_CONST.MODE_ASK_QTY || mode === SUPPLY_CONST.MODE_JARS;
}
