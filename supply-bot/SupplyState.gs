/**
 * Состояние диалога на скрытом служебном листе SUPPLY_STATE.
 * Колонки: chat_id | state_json | updated
 * Одна строка на чат. Вызывается только из supplyPoll (под документной блокировкой).
 */

function supplyStateSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CONST.SHEET_STATE);
  if (!sh) {
    sh = ss.insertSheet(SUPPLY_CONST.SHEET_STATE);
    sh.getRange(1, 1, 1, 3).setValues([['chat_id', 'state_json', 'updated']]);
    sh.getRange('A:A').setNumberFormat('@');
    sh.hideSheet();
  }
  return sh;
}

/** Номер строки чата или 0. */
function supplyStateRow_(sh, chatId) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(chatId)) return i + 2;
  }
  return 0;
}

/**
 * Дополняет состояние, сохранённое прежней версией кода, недостающими полями,
 * чтобы незавершённый документ не падал на «reading 'length'» и подобном после обновления кода.
 */
function supplyStateNormalize_(st, chatId) {
  if (!st || typeof st !== 'object') return null;
  st.chatId = st.chatId ? String(st.chatId) : String(chatId);

  if (st.doc) {
    if (!Array.isArray(st.doc.items)) st.doc.items = [];
    if (!Array.isArray(st.doc.uncertain_fields)) st.doc.uncertain_fields = [];
    if (st.doc.notes === undefined || st.doc.notes === null) st.doc.notes = '';
    st.doc.items.forEach(function (it) { if (it.sku === undefined) it.sku = null; });
  }
  // Состояние этапа 2 (без сопоставления): собираем его заново.
  if (!st.match && st.doc) st.match = supplyMatchDoc_(st.doc, null);
  if (st.match) {
    if (!Array.isArray(st.match.lines)) st.match.lines = [];
    st.match.lines.forEach(function (l) {
      if (!Array.isArray(l.cands)) l.cands = [];
      if (l.sku === undefined) l.sku = (l.item && l.item.sku) || null;
    });
  }

  if (st.reported === undefined) st.reported = true; // сводка у старого документа уже показана
  ['notified', 'summaryNew', 'dupConfirmed', 'dupChecked', 'recorded', 'sumAccepted'].forEach(function (k) { if (st[k] === undefined) st[k] = false; });
  ['ownerMsgId', 'discMsgId', 'pendingN', 'pendingIng', 'dupMsgId', 'dupFrom', 'stepBeforeDup', 'pendingFinal', 'rec', 'sumMsgId']
    .forEach(function (k) { if (st[k] === undefined) st[k] = null; });
  if (st.fallbackReason === undefined) st.fallbackReason = '';
  return st;
}

/** Состояние чата (объект) или null. */
function supplyStateGet_(chatId) {
  var sh = supplyStateSheet_();
  var row = supplyStateRow_(sh, chatId);
  if (!row) return null;
  var raw = sh.getRange(row, 2).getValue();
  if (!raw) return null;
  try {
    return supplyStateNormalize_(JSON.parse(raw), chatId);
  } catch (e) {
    if (e instanceof SyntaxError) return null; // повреждённый JSON
    throw e;
  }
}

/** Все сохранённые состояния: [{row, chatId, state, updated}] (повреждённые пропускаются). */
function supplyStateAll_() {
  var sh = supplyStateSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r, i) {
    var st = null;
    try { st = JSON.parse(r[1]); } catch (e) { st = null; }
    st = supplyStateNormalize_(st, r[0]);
    if (st) out.push({ row: i + 2, chatId: String(r[0]), state: st, updated: r[2] });
  });
  return out;
}

/** Состояние документа по sid (кнопки владельца приходят из другого чата). Возвращает {chatId, state} или null. */
function supplyStateFindBySid_(sid) {
  var all = supplyStateAll_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].state.sid === sid) return all[i];
  }
  return null;
}

function supplyStateSet_(chatId, state) {
  var sh = supplyStateSheet_();
  var row = supplyStateRow_(sh, chatId);
  var json = JSON.stringify(state);
  if (json.length > 45000) throw new Error('Состояние диалога слишком большое');
  if (!row) row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, 3).setValues([[String(chatId), json, new Date()]]);
}

function supplyStateClear_(chatId) {
  var sh = supplyStateSheet_();
  var row = supplyStateRow_(sh, chatId);
  if (row) sh.deleteRow(row);
}
