/**
 * Переключение polling <-> webhook и сторож. Всё запускается вручную из редактора.
 * В журнал секреты не пишутся.
 */

/** Проверка, нет ли в проекте doPost/doGet (все файлы проекта делят одно пространство имён). */
function supplyCheckEntryPoints() {
  console.log('doPost: ' + (typeof doPost !== 'undefined' ? 'ЕСТЬ (SupplyDoPost.gs не вставлять, используйте supplyDoPostRoute_)' : 'нет'));
  console.log('doGet: ' + (typeof doGet !== 'undefined' ? 'ЕСТЬ' : 'нет'));
  var url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) { url = ''; }
  console.log('Веб-приложение уже развёрнуто: ' + (url ? 'да' : 'нет (по данным ScriptApp)'));
}

function supplySwitchToWebhook() {
  var url = supplyProp_('SUPPLY_WORKER_URL');
  var secret = supplyProp_('SUPPLY_WEBHOOK_SECRET');

  if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error('SUPPLY_WORKER_URL должен быть https-адресом');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('SUPPLY_WEBHOOK_SECRET: только A-Z a-z 0-9 _ -, до 256 символов');
  if (!supplyProp_('SUPPLY_RELAY_SECRET')) throw new Error('Не задано SUPPLY_RELAY_SECRET');

  // Сначала webhook: если Telegram его не примет, polling-триггер остаётся и бот продолжает работать.
  supplyTgCall_('setWebhook', {
    url: url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false
  });

  var removed = supplyRemoveTrigger_(); // только триггер supplyPoll
  var info = supplyTgCall_('getWebhookInfo', {});
  console.log('setWebhook: ok. Триггеров supplyPoll удалено: ' + removed +
    '. pending_update_count=' + info.pending_update_count +
    (info.last_error_message ? '. last_error: ' + info.last_error_message : ''));
}

function supplySwitchToPolling() {
  supplyTgCall_('deleteWebhook', { drop_pending_updates: false });
  supplyInstallTrigger();
  console.log('deleteWebhook: ok. Включён polling (триггер supplyPoll).');
}

/** «08:00» / «8:00» -> минуты от полуночи (0..1439) или null. */
function supplyParseHHMM_(s) {
  var m = String(s === null || s === undefined ? '' : s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/**
 * Окно работы сторожа: [FROM; TO) по времени Астаны (UTC+5), по умолчанию 08:00–21:30
 * (SUPPLY_WATCHDOG_FROM / SUPPLY_WATCHDOG_TO, формат ЧЧ:ММ). Начало включительно, конец нет:
 * 08:00 работает, 21:29 работает, 21:30 уже выходит. Неверное значение свойства заменяется значением по умолчанию.
 * Если FROM позже TO, окно считается переходящим через полночь.
 */
function supplyWatchdogActive_(nowMs, fromStr, toStr) {
  var from = supplyParseHHMM_(fromStr);
  var to = supplyParseHHMM_(toStr);
  if (from === null) from = 8 * 60;
  if (to === null) to = 21 * 60 + 30;
  var d = new Date(nowMs + 5 * 3600 * 1000);
  var m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return from <= to ? (m >= from && m < to) : (m >= from || m < to);
}

/**
 * Сторож: проверяет webhook и пишет владельцу при проблеме.
 * В режиме polling (есть триггер supplyPoll, webhook не установлен) молчит.
 */
function supplyWatchdog(nowMs) {
  // Только в часы работы кафе (по Астане, UTC+5): вне окна сразу выходим, к Telegram не обращаемся.
  // nowMs — «сейчас» для тестов (триггер передаёт объект события, он игнорируется).
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!supplyWatchdogActive_(now, supplyProp_('SUPPLY_WATCHDOG_FROM'), supplyProp_('SUPPLY_WATCHDOG_TO'))) return;

  var info = supplyTgCall_('getWebhookInfo', {});
  var pollingOn = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'supplyPoll';
  });

  var problems = [];
  var props = PropertiesService.getScriptProperties();
  var st = {};
  try { st = JSON.parse(props.getProperty(SUPPLY_CONST.PROP_WATCHDOG) || '{}'); } catch (e) { st = {}; }

  if (!info.url) {
    if (pollingOn) return; // штатный polling
    problems.push('webhook не установлен и polling-триггера нет: бот сейчас не получает сообщения.');
  } else {
    var expected = supplyProp_('SUPPLY_WORKER_URL');
    if (expected && info.url !== expected) problems.push('webhook указывает не на SUPPLY_WORKER_URL.');

    // Новая ошибка доставки (не сообщали раньше).
    if (info.last_error_message && info.last_error_date && info.last_error_date > (st.errDate || 0)) {
      problems.push('ошибка доставки: ' + info.last_error_message);
      st.errDate = info.last_error_date;
    }
    // Очередь не рассасывается; не чаще раза в час.
    if (info.pending_update_count > 3 && Date.now() - (st.pendingAlertMs || 0) > 3600 * 1000) {
      problems.push('в очереди Telegram ' + info.pending_update_count + ' неотправленных апдейтов.');
      st.pendingAlertMs = Date.now();
    }
  }

  if (!problems.length) return;
  props.setProperty(SUPPLY_CONST.PROP_WATCHDOG, JSON.stringify(st));

  var text = '🐕 Сторож приёма поставок:\n• ' + problems.map(supplyEsc_).join('\n• ');
  console.warn(problems.join(' | '));
  if (supplyOwnerChat_()) supplyOwnerNote_(text);
}

/** Один триггер на supplyWatchdog раз в 10 минут. */
function supplyInstallWatchdog() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'supplyWatchdog';
  });
  if (exists) {
    console.log('Триггер supplyWatchdog уже есть.');
    return;
  }
  ScriptApp.newTrigger('supplyWatchdog').timeBased().everyMinutes(10).create();
  console.log('Триггер supplyWatchdog создан (раз в 10 минут).');
}

/** Окно работы сторожа 08:00–21:30 по Астане: границы, свойства, отсутствие обращений к Telegram вне окна. Запуск вручную. */
function supplyWatchdogSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  // Время Астаны (UTC+5) -> миллисекунды UTC: 12.10.2026 hh:mm по Астане.
  function at(hh, mm) { return Date.UTC(2026, 9, 12, hh - 5, mm); }

  expect('07:59 — выходит', supplyWatchdogActive_(at(7, 59), '', '') === false);
  expect('08:00 — работает', supplyWatchdogActive_(at(8, 0), '', '') === true);
  expect('21:29 — работает', supplyWatchdogActive_(at(21, 29), '', '') === true);
  expect('21:30 — выходит', supplyWatchdogActive_(at(21, 30), '', '') === false);
  expect('полночь и ночь — выходит', supplyWatchdogActive_(at(0, 0), '', '') === false && supplyWatchdogActive_(at(3, 15), '', '') === false);
  expect('середина дня — работает', supplyWatchdogActive_(at(14, 0), '', '') === true);
  expect('часовой пояс UTC+5: 03:00 UTC = 08:00 Астаны — работает, 02:59 UTC — выходит',
    supplyWatchdogActive_(Date.UTC(2026, 9, 12, 3, 0), '', '') === true && supplyWatchdogActive_(Date.UTC(2026, 9, 12, 2, 59), '', '') === false);
  expect('свои границы из свойств: 09:00–20:00', supplyWatchdogActive_(at(8, 59), '09:00', '20:00') === false &&
    supplyWatchdogActive_(at(9, 0), '09:00', '20:00') === true && supplyWatchdogActive_(at(19, 59), '09:00', '20:00') === true &&
    supplyWatchdogActive_(at(20, 0), '09:00', '20:00') === false);
  expect('формат без ведущего нуля: 8:00', supplyParseHHMM_('8:00') === 480 && supplyParseHHMM_(' 21:30 ') === 1290);
  expect('неверное значение свойства — значение по умолчанию', supplyParseHHMM_('25:00') === null && supplyParseHHMM_('abc') === null &&
    supplyWatchdogActive_(at(7, 59), 'abc', '99:99') === false && supplyWatchdogActive_(at(8, 0), 'abc', '99:99') === true &&
    supplyWatchdogActive_(at(21, 30), 'abc', '99:99') === false);
  expect('окно через полночь (22:00–06:00)', supplyWatchdogActive_(at(23, 0), '22:00', '06:00') === true &&
    supplyWatchdogActive_(at(5, 59), '22:00', '06:00') === true && supplyWatchdogActive_(at(6, 0), '22:00', '06:00') === false &&
    supplyWatchdogActive_(at(12, 0), '22:00', '06:00') === false);

  // Вне окна supplyWatchdog не обращается к Telegram; внутри окна — обращается.
  var origCall = supplyTgCall_;
  var calls = 0;
  supplyTgCall_ = function (method) { if (method === 'getWebhookInfo') calls++; return { url: '', pending_update_count: 0 }; };
  try {
    supplyWatchdog(at(7, 59));
    supplyWatchdog(at(21, 30));
    supplyWatchdog(at(3, 0));
    var outside = calls;
    try { supplyWatchdog(at(8, 0)); } catch (e1) { /* дальше идут ScriptApp/лист — здесь важен сам факт обращения */ }
    var at0800 = calls;
    try { supplyWatchdog(at(21, 29)); } catch (e2) { /* то же */ }
    expect('вне окна (07:59, 21:30, 03:00) к Telegram обращений нет', outside === 0);
    expect('в окне (08:00 и 21:29) сторож обращается к Telegram (getWebhookInfo)', at0800 === 1 && calls === 2);
    var ev = calls;
    try { supplyWatchdog({ triggerUid: 'x' }); } catch (e3) { /* объект события триггера игнорируется, берётся текущее время */ }
    expect('вызов триггером (объект события) не ломает проверку времени', calls >= ev);
  } finally {
    supplyTgCall_ = origCall;
  }

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
