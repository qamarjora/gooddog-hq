/**
 * Управление доступом сотрудников без правки Script Properties.
 *
 * Лист «Сотрудники»: chat id | имя | username | статус (активен / отключён) | дата добавления.
 * Создаётся ботом при первом обращении. Статус можно менять и вручную: изменение подхватывается не позже чем через
 * минуту (список кэшируется на 60 секунд; бот сбрасывает кэш сам, когда меняет статус).
 *
 * Допущен тот, кто: владелец (SUPPLY_OWNER_CHAT_ID), либо в ALLOWED_CHAT_IDS (запасной вариант), либо в листе
 * «Сотрудники» со статусом «активен». Явный статус «отключён» в листе важнее ALLOWED_CHAT_IDS (иначе «Отключить»
 * не действовало бы на тех, кто в ALLOWED_CHAT_IDS); владельца отключить нельзя.
 *
 * Неизвестный пользователь, написавший боту (/start или любое сообщение), получает «Заявка отправлена владельцу…»,
 * владельцу уходит «Новый сотрудник: имя, @username, id …» с кнопками «✅ Разрешить» / «❌ Отклонить».
 * Повторные заявки от одного id — не чаще раза в час (остальные игнорируются). Отклонённому бот молчит 24 часа.
 * Кнопки (stf:ok / stf:no / stf:off) действуют только от владельца. /staff — список активных с кнопкой «Отключить»
 * (только владельцу; остальным бот не отвечает).
 *
 * Логика вынесена в функции, получающие io (хранилища и отправку сообщений), поэтому проверяется в supplyAccessSelfTest().
 * Служебный скрытый лист SUPPLY_REQUESTS хранит время последней заявки и срок молчания после отказа.
 */

// ---------------------------------------------------------------------------
// Листы
// ---------------------------------------------------------------------------

function supplyStaffSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CONST.SHEET_STAFF);
  if (sh) return sh;

  sh = ss.insertSheet(SUPPLY_CONST.SHEET_STAFF);
  sh.getRange(1, 1, 1, 5).setValues([['chat id', 'имя', 'username', 'статус', 'дата добавления']]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('E:E').setNumberFormat('dd.MM.yyyy HH:mm');
  sh.getRange(2, 4, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList([SUPPLY_CONST.STAFF_ACTIVE, SUPPLY_CONST.STAFF_DISABLED], true)
      .setAllowInvalid(true).build());
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(3, 160);
  sh.setColumnWidth(5, 150);
  return sh;
}

/** Строки листа «Сотрудники» -> [{row, chatId, name, username, status (нижний регистр), added}]. */
function supplyStaffReadRows_() {
  var sh = supplyStaffSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  sh.getRange(2, 1, last - 1, 5).getValues().forEach(function (r, i) {
    var id = String(r[0] === null || r[0] === undefined ? '' : r[0]).trim();
    if (!id) return;
    var added = (r[4] && typeof r[4].getTime === 'function')
      ? Utilities.formatDate(r[4], SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'dd.MM.yyyy HH:mm')
      : String(r[4] || '');
    out.push({
      row: i + 2, chatId: id, name: String(r[1] || ''), username: String(r[2] || '').replace(/^@/, ''),
      status: String(r[3] || '').trim().toLowerCase(), added: added
    });
  });
  return out;
}

/** Меняет строку сотрудника или добавляет новую. patch: {status, name?, username?}. */
function supplyStaffUpsertRow_(chatId, patch) {
  var sh = supplyStaffSheet_();
  var id = String(chatId);
  var found = supplyStaffReadRows_().filter(function (r) { return r.chatId === id; })[0];
  if (found) {
    sh.getRange(found.row, 4).setValue(patch.status);
    if (patch.name) sh.getRange(found.row, 2).setValue(patch.name);
    if (patch.username) sh.getRange(found.row, 3).setValue(patch.username);
    return;
  }
  sh.getRange(sh.getLastRow() + 1, 1, 1, 5).setValues([[id, patch.name || '', patch.username || '', patch.status, new Date()]]);
}

function supplyReqSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CONST.SHEET_REQUESTS);
  if (!sh) {
    sh = ss.insertSheet(SUPPLY_CONST.SHEET_REQUESTS);
    sh.getRange(1, 1, 1, 5).setValues([['chat_id', 'last_request_ms', 'rejected_until_ms', 'name', 'username']]);
    sh.getRange('A:A').setNumberFormat('@');
    sh.hideSheet();
  }
  return sh;
}

/** Хранилище заявок: get(id) -> {chatId, lastRequestMs, rejectedUntilMs, name, username} | null; set(id, rec). */
function supplyReqStore_() {
  function rowOf(sh, id) {
    var last = sh.getLastRow();
    if (last < 2) return 0;
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
    return 0;
  }
  return {
    get: function (id) {
      id = String(id);
      var sh = supplyReqSheet_();
      var row = rowOf(sh, id);
      if (!row) return null;
      var r = sh.getRange(row, 1, 1, 5).getValues()[0];
      return { chatId: id, lastRequestMs: Number(r[1]) || 0, rejectedUntilMs: Number(r[2]) || 0, name: String(r[3] || ''), username: String(r[4] || '') };
    },
    set: function (id, rec) {
      id = String(id);
      var sh = supplyReqSheet_();
      var row = rowOf(sh, id) || sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, 5).setValues([[id, rec.lastRequestMs || 0, rec.rejectedUntilMs || 0, rec.name || '', rec.username || '']]);
    }
  };
}

// ---------------------------------------------------------------------------
// Хранилище сотрудников с кэшем на 60 секунд
// ---------------------------------------------------------------------------

/** Реальные кэш (CacheService) и лист. В тестах подменяется. */
function supplyStaffBackend_() {
  return {
    cacheGet: function () {
      var c = CacheService.getScriptCache().get(SUPPLY_CONST.STAFF_CACHE_KEY);
      if (!c) return null;
      try { return JSON.parse(c); } catch (e) { return null; }
    },
    cachePut: function (rows, sec) { CacheService.getScriptCache().put(SUPPLY_CONST.STAFF_CACHE_KEY, JSON.stringify(rows), sec); },
    cacheRemove: function () { CacheService.getScriptCache().remove(SUPPLY_CONST.STAFF_CACHE_KEY); },
    readRows: supplyStaffReadRows_,
    upsert: supplyStaffUpsertRow_
  };
}

/**
 * Хранилище: rows() — список из кэша или листа (кэш на 60 с), statusOf(id) — 'активен' / 'отключён' / '',
 * setStatus(...) — запись в лист со сбросом кэша.
 */
function supplyStaffMakeStore_(be) {
  var store = {
    rows: function () {
      var cached = be.cacheGet();
      if (cached) return cached;
      var rows = be.readRows();
      be.cachePut(rows, SUPPLY_CONST.STAFF_CACHE_SEC);
      return rows;
    },
    statusOf: function (id) {
      var r = store.rows().filter(function (x) { return x.chatId === String(id); })[0];
      return r ? r.status : '';
    },
    setStatus: function (id, status, name, username) {
      be.upsert(String(id), { status: status, name: name || '', username: username || '' });
      be.cacheRemove(); // при смене статуса бот сбрасывает кэш: действует сразу
    }
  };
  return store;
}

function supplyStaffStore_() {
  return supplyStaffMakeStore_(supplyStaffBackend_());
}

// ---------------------------------------------------------------------------
// Правила доступа (чистые функции)
// ---------------------------------------------------------------------------

/**
 * Допущен ли chatId. ctx: {ownerId, allowedIds[], status ('активен' | 'отключён' | '')}.
 * Владелец — всегда; явное «отключён» важнее ALLOWED_CHAT_IDS; затем ALLOWED_CHAT_IDS; затем «активен» в листе.
 */
function supplyAccessAllowed_(chatId, ctx) {
  var id = String(chatId);
  if (ctx.ownerId && ctx.ownerId === id) return true;
  if (ctx.status === SUPPLY_CONST.STAFF_DISABLED) return false;
  if (ctx.allowedIds.indexOf(id) !== -1) return true;
  return ctx.status === SUPPLY_CONST.STAFF_ACTIVE;
}

/** Решение по новой заявке: 'request' | 'silent' (отклонён, молчим 24 ч) | 'throttled' (заявка уже была в течение часа). */
function supplyAccessDecide_(rec, nowMs) {
  if (rec && rec.rejectedUntilMs > nowMs) return 'silent';
  if (rec && rec.lastRequestMs && nowMs - rec.lastRequestMs < SUPPLY_CONST.REQUEST_COOLDOWN_MS) return 'throttled';
  return 'request';
}

/** Кнопку нажал владелец (id нажавшего и чат сообщения совпадают с владельцем). */
function supplyIsOwnerCallback_(cq, ownerId) {
  if (!ownerId || !cq || !cq.from || !cq.message || !cq.message.chat) return false;
  return String(cq.from.id) === ownerId && String(cq.message.chat.id) === ownerId;
}

function supplyStaffLabel_(r) {
  return (r.name || '—') + (r.username ? ', @' + r.username : '') + ', id ' + r.chatId;
}

// ---------------------------------------------------------------------------
// Заявки, кнопки владельца, /staff
// ---------------------------------------------------------------------------

/** Реальные зависимости: хранилища и отправка сообщений. */
function supplyAccessIo_() {
  var owner = supplyOwnerChat_();
  return {
    ownerId: owner,
    allowedIds: supplyAllowedChats_(),
    now: function () { return Date.now(); },
    store: supplyStaffStore_(),
    reqStore: supplyReqStore_(),
    sendOwner: function (html, keyboard) { return supplyTgSend_(owner, html, keyboard ? { keyboard: keyboard } : {}); },
    sendUser: function (id, html) { return supplyTgSend_(id, html); },
    editOwner: function (messageId, html, keyboard) { return supplyTgEdit_(owner, messageId, html, keyboard); },
    answer: supplyTgAnswerCb_,
    discard: function (id) {
      var st = supplyStateGet_(id);
      if (st) supplyFlowDiscard_(st);
    }
  };
}

/**
 * Сообщение от пользователя без доступа: заявка владельцу. Возвращает 'requested' | 'throttled' | 'silent' |
 * 'no-owner' | 'ignored' | 'owner-send-failed'.
 */
function supplyAccessRequestCore_(msg, io) {
  var chat = msg.chat || {};
  if (chat.type && chat.type !== 'private') return 'ignored'; // заявки только из личных чатов
  var id = String(chat.id);
  if (!io.ownerId) return 'no-owner';

  var now = io.now();
  var rec = io.reqStore.get(id);
  var decision = supplyAccessDecide_(rec, now);
  if (decision !== 'request') return decision;

  var from = msg.from || {};
  var name = [from.first_name, from.last_name].filter(function (x) { return x; }).join(' ').trim() || chat.title || '';
  var username = from.username || chat.username || '';
  var info = { chatId: id, name: name, username: username };
  var wasDisabled = io.store.statusOf(id) === SUPPLY_CONST.STAFF_DISABLED;

  // Сначала владельцу: если не дошло, заявку не фиксируем и пользователю ничего не обещаем.
  try {
    io.sendOwner('🆕 Новый сотрудник: ' + supplyEsc_(supplyStaffLabel_(info)) + (wasDisabled ? ' (ранее отключён)' : ''), [[
      { text: '✅ Разрешить', callback_data: 'stf:ok:' + id },
      { text: '❌ Отклонить', callback_data: 'stf:no:' + id }
    ]]);
  } catch (e) {
    console.error('supplyAccessRequestCore_: не отправлено владельцу: ' + supplySanitizeSecrets_(e.message));
    return 'owner-send-failed';
  }
  io.reqStore.set(id, { chatId: id, lastRequestMs: now, rejectedUntilMs: 0, name: name, username: username });
  try {
    io.sendUser(id, 'Заявка отправлена владельцу, подождите подтверждения');
  } catch (e2) {
    console.error('supplyAccessRequestCore_: не отправлено заявителю: ' + supplySanitizeSecrets_(e2.message));
  }
  return 'requested';
}

/** Список активных сотрудников с кнопкой «Отключить» у каждого. */
function supplyStaffListView_(io) {
  var owner = io.ownerId;
  var rows = io.store.rows();
  var entries = rows.filter(function (r) { return r.status === SUPPLY_CONST.STAFF_ACTIVE && r.chatId !== owner; });
  var seen = {};
  entries.forEach(function (r) { seen[r.chatId] = true; });
  // Запасной список ALLOWED_CHAT_IDS: тоже можно отключить (запишется статус «отключён» в лист).
  io.allowedIds.forEach(function (id) {
    if (id === owner || seen[id] || io.store.statusOf(id) === SUPPLY_CONST.STAFF_DISABLED) return;
    seen[id] = true;
    entries.push({ chatId: id, name: '', username: '', added: '', fromEnv: true });
  });

  if (!entries.length) return { text: '👥 Активных сотрудников нет.', keyboard: null };
  var lines = ['👥 <b>Активные сотрудники</b>'];
  var kb = [];
  entries.forEach(function (r, i) {
    lines.push((i + 1) + '. ' + supplyEsc_(supplyStaffLabel_(r)) + (r.added ? ' · с ' + supplyEsc_(r.added) : '') +
      (r.fromEnv ? ' · из ALLOWED_CHAT_IDS' : ''));
    kb.push([{ text: 'Отключить: ' + (r.name || r.chatId).substring(0, 30), callback_data: 'stf:off:' + r.chatId }]);
  });
  return { text: lines.join('\n'), keyboard: kb };
}

/** /staff: только владельцу; остальным бот не отвечает. Возвращает 'listed' | 'silent'. */
function supplyStaffCommandCore_(msg, io) {
  var chatId = String(msg.chat && msg.chat.id);
  if (!io.ownerId || chatId !== io.ownerId) return 'silent';
  var view = supplyStaffListView_(io);
  io.sendOwner(view.text, view.keyboard);
  return 'listed';
}

/**
 * Кнопки владельца: stf:ok:<id> разрешить, stf:no:<id> отклонить, stf:off:<id> отключить.
 * Возвращает 'approved' | 'already' | 'rejected' | 'disabled' | 'denied' | 'ignored'.
 */
function supplyStaffDecisionCore_(cq, io) {
  var parts = String(cq.data || '').split(':');
  var action = parts[1];
  var id = String(parts[2] || '');

  if (!supplyIsOwnerCallback_(cq, io.ownerId)) {
    io.answer(cq.id, 'Только владелец');
    return 'denied';
  }
  io.answer(cq.id);
  if (!id) return 'ignored';

  var mid = cq.message.message_id;
  var rec = io.reqStore.get(id) || { chatId: id, lastRequestMs: 0, rejectedUntilMs: 0, name: '', username: '' };
  var label = supplyStaffLabel_({ chatId: id, name: rec.name, username: rec.username });

  if (action === 'ok') {
    if (io.store.statusOf(id) === SUPPLY_CONST.STAFF_ACTIVE) {
      io.editOwner(mid, '✅ Уже активен: ' + supplyEsc_(label));
      return 'already';
    }
    io.store.setStatus(id, SUPPLY_CONST.STAFF_ACTIVE, rec.name, rec.username);
    io.reqStore.set(id, { chatId: id, lastRequestMs: rec.lastRequestMs, rejectedUntilMs: 0, name: rec.name, username: rec.username });
    try { io.sendUser(id, 'Доступ открыт. Присылайте накладные фото'); } catch (e) { console.error('stf:ok уведомление: ' + supplySanitizeSecrets_(e.message)); }
    io.editOwner(mid, '✅ Разрешено: ' + supplyEsc_(label)); // без кнопок
    return 'approved';
  }

  if (action === 'no') {
    io.reqStore.set(id, { chatId: id, lastRequestMs: rec.lastRequestMs, rejectedUntilMs: io.now() + SUPPLY_CONST.REJECT_SILENCE_MS,
      name: rec.name, username: rec.username });
    io.editOwner(mid, '❌ Отклонено: ' + supplyEsc_(label) + ' (бот молчит 24 часа)');
    return 'rejected';
  }

  if (action === 'off') {
    if (id === io.ownerId) {
      io.editOwner(mid, 'Владельца отключить нельзя.');
      return 'ignored';
    }
    var known = io.store.rows().filter(function (r) { return r.chatId === id; })[0];
    io.store.setStatus(id, SUPPLY_CONST.STAFF_DISABLED, known ? '' : rec.name, known ? '' : rec.username);
    try { io.discard(id); } catch (e2) { console.error('stf:off очистка диалога: ' + supplySanitizeSecrets_(e2.message)); }
    try { io.sendUser(id, 'Доступ закрыт'); } catch (e3) { console.error('stf:off уведомление: ' + supplySanitizeSecrets_(e3.message)); }
    var view = supplyStaffListView_(io);
    io.editOwner(mid, view.text, view.keyboard || undefined);
    return 'disabled';
  }
  return 'ignored';
}

// Точки входа для SupplyMain.gs

function supplyAccessRequest_(msg) {
  return supplyAccessRequestCore_(msg, supplyAccessIo_());
}

function supplyStaffCommand_(msg) {
  return supplyStaffCommandCore_(msg, supplyAccessIo_());
}

function supplyStaffOnCallback_(cq) {
  return supplyStaffDecisionCore_(cq, supplyAccessIo_());
}

/** Допущен ли чат (владелец, ALLOWED_CHAT_IDS или активный сотрудник из листа). Сбой чтения листа доступ владельца и ALLOWED не отнимает. */
function supplyIsAllowedChat_(chatId) {
  var status = '';
  try {
    status = supplyStaffStore_().statusOf(chatId);
  } catch (e) {
    console.error('supplyIsAllowedChat_: лист «Сотрудники» недоступен: ' + supplySanitizeSecrets_(e.message));
  }
  return supplyAccessAllowed_(chatId, { ownerId: supplyOwnerChat_(), allowedIds: supplyAllowedChats_(), status: status });
}

// ---------------------------------------------------------------------------
// Самотест
// ---------------------------------------------------------------------------

/** Доступ сотрудников без Telegram и листов (хранилища и отправка заменены заглушками). Запуск вручную. */
function supplyAccessSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }

  var OWNER = '999', H = 3600000, BASE = 10 * H; // «сейчас» в тестах не с нуля (0 в данных означает «заявки не было»)

  function mkBackend(initial) {
    var be = {
      db: (initial || []).map(function (r) { return JSON.parse(JSON.stringify(r)); }),
      clock: BASE, reads: 0, cache: null, cacheExp: 0,
      cacheGet: function () { return be.cache && be.clock < be.cacheExp ? JSON.parse(be.cache) : null; },
      cachePut: function (rows, sec) { be.cache = JSON.stringify(rows); be.cacheExp = be.clock + sec * 1000; },
      cacheRemove: function () { be.cache = null; },
      readRows: function () { be.reads++; return JSON.parse(JSON.stringify(be.db)); },
      upsert: function (id, patch) {
        var r = be.db.filter(function (x) { return x.chatId === id; })[0];
        if (r) {
          r.status = patch.status;
          if (patch.name) r.name = patch.name;
          if (patch.username) r.username = patch.username;
        } else {
          be.db.push({ chatId: id, name: patch.name || '', username: patch.username || '', status: patch.status, added: 'now' });
        }
      }
    };
    return be;
  }
  function mkIo(initial, allowedIds) {
    var be = mkBackend(initial);
    var reqs = {};
    var io = {
      be: be, ownerId: OWNER, allowedIds: allowedIds || [],
      now: function () { return be.clock; },
      store: supplyStaffMakeStore_(be),
      reqStore: { get: function (id) { return reqs[id] ? JSON.parse(JSON.stringify(reqs[id])) : null; }, set: function (id, r) { reqs[id] = JSON.parse(JSON.stringify(r)); } },
      ownerMsgs: [], userMsgs: [], edits: [], answers: [], discarded: [],
      sendOwner: function (t, kb) { io.ownerMsgs.push({ text: t, kb: kb }); },
      sendUser: function (id, t) { io.userMsgs.push({ id: id, text: t }); },
      editOwner: function (mid, t, kb) { io.edits.push({ mid: mid, text: t, kb: kb }); },
      answer: function (id, t) { io.answers.push(t || ''); },
      discard: function (id) { io.discarded.push(id); }
    };
    return io;
  }
  function allowed(io, id) {
    return supplyAccessAllowed_(id, { ownerId: io.ownerId, allowedIds: io.allowedIds, status: io.store.statusOf(id) });
  }
  function msgFrom(id, text, extra) {
    var m = { chat: { id: Number(id), type: 'private' }, from: { id: Number(id), first_name: 'Иван', last_name: 'Петров', username: 'ivan' }, text: text };
    Object.keys(extra || {}).forEach(function (k) { m[k] = extra[k]; });
    return m;
  }
  function cqFrom(fromId, data, chatId) {
    return { id: 'cb', data: data, from: { id: Number(fromId) }, message: { message_id: 77, chat: { id: Number(chatId || fromId) } } };
  }

  // --- 1. Неизвестный id получает заявку, а не доступ ---
  var io = mkIo();
  expect('неизвестный id не допущен', allowed(io, '555') === false);
  var r1 = supplyAccessRequestCore_(msgFrom('555', '/start'), io);
  expect('неизвестный id: заявка отправлена', r1 === 'requested');
  expect('заявителю: «Заявка отправлена владельцу, подождите подтверждения»',
    io.userMsgs.length === 1 && io.userMsgs[0].id === '555' && io.userMsgs[0].text === 'Заявка отправлена владельцу, подождите подтверждения');
  expect('владельцу: «Новый сотрудник: имя, @username, id …» с кнопками «✅ Разрешить» и «❌ Отклонить»',
    io.ownerMsgs.length === 1 && io.ownerMsgs[0].text.indexOf('Новый сотрудник: Иван Петров, @ivan, id 555') !== -1 &&
    io.ownerMsgs[0].kb[0][0].text === '✅ Разрешить' && io.ownerMsgs[0].kb[0][0].callback_data === 'stf:ok:555' &&
    io.ownerMsgs[0].kb[0][1].text === '❌ Отклонить' && io.ownerMsgs[0].kb[0][1].callback_data === 'stf:no:555');
  expect('после заявки доступа всё ещё нет', allowed(io, '555') === false && io.store.statusOf('555') === '');
  var ioG = mkIo();
  expect('любое сообщение (фото) тоже даёт заявку', supplyAccessRequestCore_(msgFrom('556', '', { photo: [{}] }), ioG) === 'requested');

  // --- 2. Повторная заявка в течение часа игнорируется ---
  io.be.clock = BASE + 59 * 60000;
  var r2 = supplyAccessRequestCore_(msgFrom('555', 'эй'), io);
  expect('повторная заявка через 59 минут игнорируется (владельцу и заявителю ничего)',
    r2 === 'throttled' && io.ownerMsgs.length === 1 && io.userMsgs.length === 1);
  io.be.clock = BASE + 61 * 60000;
  expect('через 61 минуту заявка снова принимается', supplyAccessRequestCore_(msgFrom('555', 'эй'), io) === 'requested' && io.ownerMsgs.length === 2);

  // --- 3. Одобрение только от владельца ---
  var ioA = mkIo();
  supplyAccessRequestCore_(msgFrom('555', '/start'), ioA);
  var dSelf = supplyStaffDecisionCore_(cqFrom('555', 'stf:ok:555', '555'), ioA);
  expect('одобрение от самого заявителя отклонено, доступ не открыт', dSelf === 'denied' && ioA.store.statusOf('555') === '' &&
    allowed(ioA, '555') === false && ioA.userMsgs.length === 1 && ioA.answers[0] === 'Только владелец');
  var dOther = supplyStaffDecisionCore_(cqFrom('777', 'stf:ok:555', '777'), ioA);
  expect('одобрение от другого сотрудника отклонено', dOther === 'denied' && ioA.store.statusOf('555') === '');
  var dGroup = supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:ok:555', '12345'), ioA);
  expect('нажатие владельца не из его чата отклонено (проверяются id нажавшего и чат сообщения)',
    dGroup === 'denied' && ioA.store.statusOf('555') === '');
  var dOwner = supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:ok:555'), ioA);
  expect('одобрение владельцем: статус «активен», доступ открыт', dOwner === 'approved' &&
    ioA.store.statusOf('555') === 'активен' && allowed(ioA, '555') === true);
  expect('сотруднику: «Доступ открыт. Присылайте накладные фото»',
    ioA.userMsgs[ioA.userMsgs.length - 1].text === 'Доступ открыт. Присылайте накладные фото' && ioA.userMsgs[ioA.userMsgs.length - 1].id === '555');
  expect('у сообщения владельца кнопки убраны (редактирование без клавиатуры), в листе имя и username',
    ioA.edits.length === 1 && ioA.edits[0].kb === undefined && ioA.edits[0].text.indexOf('Разрешено') !== -1 &&
    ioA.be.db[0].name === 'Иван Петров' && ioA.be.db[0].username === 'ivan');
  expect('повторное «Разрешить» ничего не дублирует', supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:ok:555'), ioA) === 'already' && ioA.be.db.length === 1);

  // --- 4. Отклонение: бот молчит 24 часа ---
  var ioR = mkIo();
  supplyAccessRequestCore_(msgFrom('600', '/start'), ioR);
  expect('«Отклонить» от не-владельца не действует', supplyStaffDecisionCore_(cqFrom('600', 'stf:no:600'), ioR) === 'denied');
  expect('«Отклонить» владельцем', supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:no:600'), ioR) === 'rejected' && ioR.store.statusOf('600') === '');
  ioR.be.clock = BASE + 2 * H;
  var rr = supplyAccessRequestCore_(msgFrom('600', 'пустите'), ioR);
  expect('отклонённому бот молчит (через 2 часа заявки нет и ответа нет)', rr === 'silent' && ioR.ownerMsgs.length === 1 && ioR.userMsgs.length === 1);
  ioR.be.clock = BASE + 23 * H;
  expect('молчание держится 23 часа', supplyAccessRequestCore_(msgFrom('600', 'пустите'), ioR) === 'silent');
  ioR.be.clock = BASE + 24 * H + 60000;
  expect('через 24 часа заявка снова возможна', supplyAccessRequestCore_(msgFrom('600', 'пустите'), ioR) === 'requested' && ioR.ownerMsgs.length === 2);

  // --- 5. Отключение, отключённый не допущен, кэш сбрасывается ---
  var ioD = mkIo([{ chatId: '555', name: 'Иван Петров', username: 'ivan', status: 'активен', added: 'x' }], []);
  ioD.be.clock = BASE + 1000;
  expect('активный из листа допущен', allowed(ioD, '555') === true);
  var readsBefore = ioD.be.reads;
  allowed(ioD, '555'); allowed(ioD, '555');
  expect('повторные проверки идут из кэша (лист не перечитывается)', ioD.be.reads === readsBefore);
  expect('отключить может только владелец', supplyStaffDecisionCore_(cqFrom('555', 'stf:off:555'), ioD) === 'denied' && allowed(ioD, '555') === true);
  var off = supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:off:555'), ioD);
  expect('«Отключить» владельцем: статус «отключён»', off === 'disabled' && ioD.be.db[0].status === 'отключён');
  expect('кэш сброшен при отключении: доступ закрыт сразу, лист перечитан', allowed(ioD, '555') === false && ioD.be.reads === readsBefore + 1);
  expect('отключённому: «Доступ закрыт», диалог сброшен',
    ioD.userMsgs[ioD.userMsgs.length - 1].text === 'Доступ закрыт' && ioD.discarded[0] === '555');
  expect('отключённый не может отправлять документы (нет доступа)', allowed(ioD, '555') === false);
  expect('отключённый, написав боту, снова ставит заявку (владелец увидит «ранее отключён»)',
    supplyAccessRequestCore_(msgFrom('555', 'привет'), ioD) === 'requested' &&
    ioD.ownerMsgs[ioD.ownerMsgs.length - 1].text.indexOf('ранее отключён') !== -1);

  // --- 6. Ручное изменение листа: подхватывается через минуту ---
  var ioM = mkIo([{ chatId: '700', name: 'Анна', username: '', status: 'активен', added: 'x' }], []);
  ioM.be.clock = BASE + 0;
  expect('до ручной правки допущен', allowed(ioM, '700') === true);
  ioM.be.db[0].status = 'отключён'; // владелец поправил статус в таблице руками
  ioM.be.clock = BASE + 30000;
  expect('через 30 секунд кэш ещё действует', allowed(ioM, '700') === true);
  ioM.be.clock = BASE + 61000;
  expect('через минуту ручное изменение учтено', allowed(ioM, '700') === false);
  ioM.be.db.push({ chatId: '701', name: 'Ольга', username: '', status: 'активен', added: 'x' }); // добавлена вручную
  ioM.be.clock = BASE + 125000;
  expect('сотрудник, добавленный в лист вручную, допущен через минуту', allowed(ioM, '701') === true);

  // --- 7. Владелец, ALLOWED_CHAT_IDS и приоритет «отключён» ---
  var ioF = mkIo([{ chatId: '800', name: 'Старый', username: '', status: 'отключён', added: 'x' }], ['800', '801']);
  expect('владелец допущен всегда', allowed(ioF, OWNER) === true);
  expect('ALLOWED_CHAT_IDS — запасной вариант', allowed(ioF, '801') === true);
  expect('явное «отключён» в листе важнее ALLOWED_CHAT_IDS', allowed(ioF, '800') === false);
  expect('владельца в листе отключить нельзя',
    (function () { var o = mkIo(); return supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:off:' + OWNER), o) === 'ignored' && o.be.db.length === 0; })());

  // --- 8. /staff ---
  var ioS = mkIo([{ chatId: '555', name: 'Иван Петров', username: 'ivan', status: 'активен', added: '10.10.2026' },
                  { chatId: '556', name: 'Анна', username: '', status: 'отключён', added: 'x' }], ['801']);
  expect('/staff от не-владельца: бот молчит', supplyStaffCommandCore_(msgFrom('555', '/staff'), ioS) === 'silent' && ioS.ownerMsgs.length === 0);
  expect('/staff от неизвестного: бот молчит', supplyStaffCommandCore_(msgFrom('888', '/staff'), ioS) === 'silent' && ioS.ownerMsgs.length === 0);
  expect('/staff от владельца: список', supplyStaffCommandCore_(msgFrom(OWNER, '/staff'), ioS) === 'listed' && ioS.ownerMsgs.length === 1);
  var list = ioS.ownerMsgs[0];
  expect('список: активные (лист и ALLOWED_CHAT_IDS), без отключённых; у каждого кнопка «Отключить»',
    list.text.indexOf('Иван Петров, @ivan, id 555') !== -1 && list.text.indexOf('Анна') === -1 && list.text.indexOf('id 801') !== -1 &&
    list.kb.length === 2 && list.kb[0][0].callback_data === 'stf:off:555' && list.kb[0][0].text.indexOf('Отключить') === 0 &&
    list.kb[1][0].callback_data === 'stf:off:801');
  supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:off:801'), ioS);
  expect('сотрудник из ALLOWED_CHAT_IDS отключается записью в лист', allowed(ioS, '801') === false && ioS.be.db.some(function (r) { return r.chatId === '801' && r.status === 'отключён'; }));
  expect('после отключения список обновлён без отключённого', ioS.edits[ioS.edits.length - 1].text.indexOf('id 801') === -1 &&
    ioS.edits[ioS.edits.length - 1].text.indexOf('id 555') !== -1);
  expect('пустой список', supplyStaffListView_(mkIo()).text === '👥 Активных сотрудников нет.');

  // --- 9. Прочее ---
  expect('заявки из групп игнорируются', supplyAccessRequestCore_({ chat: { id: -100, type: 'group' }, from: { id: 5 }, text: 'x' }, mkIo()) === 'ignored');
  var ioN = mkIo(); ioN.ownerId = '';
  expect('владелец не настроен: заявка не создаётся', supplyAccessRequestCore_(msgFrom('555', '/start'), ioN) === 'no-owner' && ioN.userMsgs.length === 0);
  var ioX = mkIo(); ioX.sendOwner = function () { throw new Error('network'); };
  expect('владельцу не доставлено: заявитель ничего не получает, заявка не фиксируется (можно повторить)',
    supplyAccessRequestCore_(msgFrom('555', '/start'), ioX) === 'owner-send-failed' && ioX.userMsgs.length === 0 && ioX.reqStore.get('555') === null);
  expect('«да»/«нет» заявок: решение по заявке без записи в хранилище не падает', supplyStaffDecisionCore_(cqFrom(OWNER, 'stf:no:123'), mkIo()) === 'rejected');
  expect('проверка нажавшего: id и чат', supplyIsOwnerCallback_(cqFrom(OWNER, 'x'), OWNER) === true &&
    supplyIsOwnerCallback_(cqFrom('1', 'x'), OWNER) === false && supplyIsOwnerCallback_(cqFrom(OWNER, 'x'), '') === false);

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
