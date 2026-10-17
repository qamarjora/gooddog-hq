/**
 * Точка входа polling и общая обработка апдейтов (её же использует webhook, см. SupplyWebhook.gs).
 */

function supplyPoll() {
  var lock = supplyLockAcquire_(1000);
  if (!lock) return; // предыдущий запуск ещё идёт
  try {
    supplyPollLoop_();
  } finally {
    lock.releaseLock();
  }
}

function supplyPollLoop_() {
  var started = Date.now();
  while (Date.now() - started < SUPPLY_CONST.POLL_BUDGET_MS) {
    var updates;
    try {
      updates = supplyTgGetUpdates_();
    } catch (e) {
      console.error('supplyPoll getUpdates: ' + e.message);
      return;
    }
    if (!updates.length) return;

    for (var i = 0; i < updates.length; i++) {
      var u = updates[i];
      supplyProcessUpdate_(u);
      // Offset двигаем после каждого апдейта, чтобы упавший не зацикливался.
      supplyTgSetOffset_(u.update_id + 1);
      if (Date.now() - started >= SUPPLY_CONST.POLL_BUDGET_MS) return;
    }
  }
}

/**
 * Единая обработка апдейта для polling и webhook. Вызывать под замком.
 * Дубль (update_id уже обрабатывался) пропускается. Возвращает true, если апдейт обработан.
 */
function supplyProcessUpdate_(u) {
  if (!u || typeof u.update_id !== 'number') return false;
  if (supplySeenCheckAndAdd_(u.update_id)) {
    console.log('supplyProcessUpdate_: дубль update_id=' + u.update_id + ', пропуск');
    return false;
  }
  try {
    supplyHandleUpdate_(u);
  } catch (e) {
    console.error('supplyHandleUpdate update_id=' + u.update_id + ': ' + supplySanitizeSecrets_(e.message) +
      '\n' + supplyErrDetails_(e, 10));
    supplyNotifyError_(u, e);
  }
  return true;
}

/**
 * Защита от дублей: храним последние SEEN_MAX update_id. Не «последний id и всё меньше пропускаем»,
 * потому что параллельные webhook-запросы могут прийти не по порядку.
 * Возвращает true, если id уже был.
 */
function supplySeenCheckAndAdd_(id) {
  var props = PropertiesService.getScriptProperties();
  var seen = [];
  try {
    seen = JSON.parse(props.getProperty(SUPPLY_CONST.PROP_SEEN) || '[]');
  } catch (e) {
    seen = [];
  }
  if (seen.indexOf(id) !== -1) return true;
  seen.push(id);
  if (seen.length > SUPPLY_CONST.SEEN_MAX) seen = seen.slice(-SUPPLY_CONST.SEEN_MAX);
  props.setProperty(SUPPLY_CONST.PROP_SEEN, JSON.stringify(seen));
  return false;
}

function supplyHandleUpdate_(u) {
  if (u.message) return supplyHandleMessage_(u.message);
  if (u.callback_query) return supplyHandleCallback_(u.callback_query);
}

function supplyHandleMessage_(msg) {
  var chatId = msg.chat.id;
  var text = (msg.text || '').trim();
  var command = text.charAt(0) === '/' ? text.split(/[\s@]/)[0].toLowerCase() : '';

  // /myid доступна любому отправителю.
  if (command === '/myid') {
    supplyTgSend_(chatId, 'Ваш chat id: <code>' + supplyEsc_(chatId) + '</code>', { replyTo: msg.message_id });
    return;
  }

  // /staff — только владельцу, остальным бот не отвечает (и заявку из-за этой команды не создаёт).
  if (command === '/staff') {
    if (supplyIsOwnerChat_(chatId)) supplyStaffCommand_(msg);
    return;
  }

  // Нет доступа: заявка владельцу (повторные не чаще раза в час, после отказа молчим 24 часа).
  if (!supplyIsAllowedChat_(chatId)) {
    supplyAccessRequest_(msg);
    return;
  }

  supplyFlowOnMessage_(msg, command);
}

function supplyHandleCallback_(cq) {
  // Кнопки заявок и /staff: «Разрешить» / «Отклонить» / «Отключить» — действуют только от владельца (проверка внутри).
  if (String(cq.data || '').indexOf('stf:') === 0) return supplyStaffOnCallback_(cq);

  var chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  if (chatId === null || !supplyIsAllowedChat_(chatId)) return;
  supplyFlowOnCallback_(cq);
}

/** Ошибку показываем разрешённому чату (коротко) и владельцу (с текстом). */
function supplyNotifyError_(u, err) {
  try {
    var chatId = null;
    if (u.message) chatId = u.message.chat.id;
    else if (u.callback_query && u.callback_query.message) chatId = u.callback_query.message.chat.id;

    if (chatId !== null && supplyIsAllowedChat_(chatId)) {
      supplyTgSend_(chatId, '⚠️ Что-то пошло не так, попробуйте ещё раз. Владельцу отправлено уведомление.');
    }
    var owner = supplyOwnerChat_();
    if (owner) {
      var where = supplyErrDetails_(err, 3);
      supplyTgSend_(owner, '❗ Ошибка модуля поставок (update ' + supplyEsc_(u.update_id) + '):\n<code>' +
        supplyEsc_(supplySanitizeSecrets_(err.message)) + '</code>' +
        (where ? '\n<code>' + supplyEsc_(where) + '</code>' : ''));
    }
  } catch (e2) {
    console.error('supplyNotifyError_: ' + e2.message);
  }
}

// ---------------------------------------------------------------------------
// Разовые служебные функции (запускаются вручную из редактора)
// ---------------------------------------------------------------------------

/** Подготовка: служебный лист и проверка свойств. Значения секретов в лог не пишутся. */
function supplyInit() {
  supplyStateSheet_();
  supplyStaffSheet_(); // лист «Сотрудники» (создаётся и при первом обращении)
  supplyRulesSheet_(); // лист «Правила сопоставления»

  var names = ['TELEGRAM_TOKEN_INVOICES', 'ALLOWED_CHAT_IDS', 'SUPPLY_OWNER_CHAT_ID', 'DRY_RUN',
               'CLAUDE_API_KEY', 'MODEL', 'POSTER_TOKEN',
               'SUPPLY_RELAY_SECRET', 'SUPPLY_WEBHOOK_SECRET', 'SUPPLY_WORKER_URL'];
  names.forEach(function (n) {
    console.log(n + ': ' + (supplyProp_(n) ? 'задано' : 'НЕ ЗАДАНО'));
  });
  console.log('Режим DRY_RUN: ' + (supplyIsDryRun_() ? 'ВКЛ (в Poster не пишем)' : 'ВЫКЛ'));

  var me = supplyTgCall_('getMe', {});
  console.log('Бот: @' + me.username);
  var info = supplyTgCall_('getWebhookInfo', {});
  console.log(info.url
    ? 'Режим приёма: WEBHOOK (pending: ' + info.pending_update_count + ')'
    : 'Режим приёма: POLLING (webhook не установлен)');
}

function supplyRemoveTrigger_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'supplyPoll') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/** Создаёт ровно один триггер на supplyPoll раз в минуту (повторный запуск дубль не создаёт). */
function supplyInstallTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'supplyPoll';
  });
  if (exists) {
    console.log('Триггер supplyPoll уже есть, ничего не меняю.');
    return;
  }
  ScriptApp.newTrigger('supplyPoll').timeBased().everyMinutes(1).create();
  console.log('Триггер supplyPoll создан (раз в минуту).');
}
