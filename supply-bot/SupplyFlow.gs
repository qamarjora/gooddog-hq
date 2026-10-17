/**
 * Диалог бота (этап 3): файл -> чтение -> дубль -> сопоставление -> вопросы владельцу / штуки сотруднику ->
 * сводка -> ✅ -> «совпало ли фактически» -> журнал (dry-run). Запись в Poster — этап 4.
 *
 * Состояние документа (лист SUPPLY_STATE, ключ — chat_id сотрудника):
 *   {sid, chatId, step, doc, match, model, fallback, fallbackReason, file,
 *    msgId (сообщение сотрудника со сводкой), ownerMsgId, discMsgId,
 *    notified, reported, summaryNew, pendingN, pendingIng}
 * step: owner_supplier | owner_supplier_search | owner_item | owner_item_search | owner_item_mode |
 *       owner_item_coef | pieces | confirm | edit | disc | disc_comment
 * Вопросы владельцу (поставщик, новая позиция) — в SupplyOwner.gs.
 */

var SUPPLY_EMP_TEXT_STEPS = ['pieces', 'edit', 'disc_comment'];

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------

function supplyFlowOnMessage_(msg, command) {
  var chatId = msg.chat.id;

  if (command === '/start' || command === '/help') {
    supplyTgSend_(chatId,
      'Пришлите фото накладной, скриншот или PDF электронного чека.\n' +
      '/cancel — отменить текущий документ\n' +
      '/myid — показать chat id.');
    return;
  }

  if (command === '/cancel') {
    var cur = supplyStateGet_(chatId);
    if (cur) {
      supplyFlowDiscard_(cur);
      supplyTgSend_(chatId, 'Отменено.');
    } else {
      supplyTgSend_(chatId, 'Нет активного документа.');
    }
    return;
  }

  var file = supplyFileFromMessage_(msg);
  if (file && file.error) {
    supplyTgSend_(chatId, '⚠️ ' + supplyEsc_(file.error), { replyTo: msg.message_id });
    return;
  }
  if (file) {
    supplyFlowOnFile_(chatId, msg, file);
    return;
  }

  if (msg.text) {
    supplyFlowOnText_(chatId, msg);
    return;
  }
  supplyTgSend_(chatId, 'Пришлите фото накладной или PDF чека.');
}

/** Снять незавершённый документ: кнопки у сотрудника и владельца гасим, состояние удаляем. */
function supplyFlowDiscard_(st) {
  if (st.msgId) supplyTgDropKeyboard_(st.chatId, st.msgId);
  if (st.discMsgId) supplyTgDropKeyboard_(st.chatId, st.discMsgId);
  var owner = supplyOwnerChat_();
  if (st.ownerMsgId && owner) supplyTgDropKeyboard_(owner, st.ownerMsgId);
  supplyStateClear_(st.chatId);
}

function supplyFlowOnFile_(chatId, msg, file) {
  // Сразу даём знать, что файл принят.
  var status = supplyTgSend_(chatId, '⏳ Читаю…', { replyTo: msg.message_id });

  var old = supplyStateGet_(chatId);
  if (old) supplyFlowDiscard_(old);

  // Этот снимок уже отправлялся (запись «принято» или «dry-run»)? Проверка для всех поставщиков, до чтения.
  if (supplyJrnFindSnapshot_(file.uniqueId)) {
    return supplyFlowAskSnapshot_(chatId, status.message_id, file);
  }
  supplyFlowReadDoc_(chatId, status.message_id, file, false);
}

/** Вопрос про повторно присланный снимок: состояние с шагом dup и кнопками «Это новый документ» / «❌ Отмена». */
function supplyFlowAskSnapshot_(chatId, msgId, file) {
  var sid = Utilities.getUuid().substring(0, 8);
  var st = {
    sid: sid, chatId: String(chatId), step: 'dup', stepBeforeDup: 'snap', dupFrom: 'snap',
    doc: null, match: null, file: file, msgId: msgId, dupMsgId: msgId
  };
  supplyTgEdit_(chatId, msgId, '⚠️ Этот снимок уже отправлялся', [[
    { text: 'Это новый документ', callback_data: 'sup:dnew:' + sid },
    { text: '❌ Отмена', callback_data: 'sup:dcancel:' + sid }
  ]]);
  supplyStateSet_(chatId, st);
}

/**
 * Чтение документа (Claude) и начало диалога. statusMsgId — сообщение «⏳ Читаю…», его заменит сводка.
 * confirmedNew — сотрудник уже ответил «Это новый документ» на вопрос про повторный снимок:
 * повторный вопрос по ключу документа не нужен.
 */
function supplyFlowReadDoc_(chatId, statusMsgId, file, confirmedNew) {
  var res;
  try {
    res = supplyClaudeRead_(supplyImagePrepare_(file));
  } catch (e) {
    console.error('supplyFlowOnFile_: ' + supplySanitizeSecrets_(e.message) + '\n' + supplyErrDetails_(e, 10));
    supplyTgEdit_(chatId, statusMsgId,
      '❌ Не удалось прочитать документ. Пришлите ещё раз: ровно, при хорошем свете, весь лист в кадре.');
    var where = supplyErrDetails_(e, 3);
    supplyOwnerNote_('❗ Не прочитан документ из чата ' + supplyEsc_(chatId) + ':\n<code>' +
      supplyEsc_(supplySanitizeSecrets_(String(e.message)).substring(0, 500)) + '</code>' +
      (where ? '\n<code>' + supplyEsc_(where) + '</code>' : ''));
    return;
  }

  var st = {
    sid: Utilities.getUuid().substring(0, 8),
    chatId: String(chatId),
    step: '',
    doc: res.doc,
    match: supplyMatchDoc_(res.doc, null),
    model: res.model,
    fallback: res.fallback,
    fallbackReason: res.fallbackReason,
    file: file, // kind, readFileId, archiveFileId, uniqueId, mime, size, name
    msgId: statusMsgId,
    ownerMsgId: null,
    discMsgId: null,
    notified: false,
    reported: false,
    summaryNew: false,
    pendingN: null,
    pendingIng: null,
    dupConfirmed: !!confirmedNew
  };
  supplyStateSet_(chatId, st);
  supplyFlowAdvance_(st);
}

/**
 * Следующий шаг по документу: вопрос владельцу, вопрос про штуки или сводка.
 * Вызывается после каждого ответа, пока supplyMatchNext_ не вернёт null.
 */
function supplyFlowAdvance_(st) {
  // Дубль проверяем, как только известен поставщик, — до вопросов по позициям и штукам.
  if (st.match.supplier && !st.dupChecked) {
    if (!supplyFlowDupGate_(st, 'advance')) return;
    st.dupChecked = true;
  }

  var next = supplyMatchNext_(st.match);
  if (!next) {
    supplyFlowShowSummary_(st);
    return;
  }

  if (next.type === 'pieces') {
    var l = st.match.lines[next.n - 1];
    st.step = 'pieces';
    st.pendingN = next.n;
    st.summaryNew = true; // сводка появится после вопроса — отдельным сообщением
    supplyStateSet_(st.chatId, st);
    supplyTgSend_(st.chatId, supplyAskText_(l));
    return;
  }

  // Вопросы владельцу (новый поставщик / новая позиция).
  if (!supplyOwnerChat_()) {
    console.error('supplyFlowAdvance_: нужен ответ владельца, но SUPPLY_OWNER_CHAT_ID не задан');
    supplyTgSend_(st.chatId, '❌ Документ не принят: требуется решение владельца, но он не настроен.');
    supplyFlowDiscard_(st);
    return;
  }
  if (!st.notified && !supplyIsOwnerChat_(st.chatId)) {
    supplyTgEdit_(st.chatId, st.msgId,
      '⏳ ' + (next.type === 'supplier' ? 'Новый поставщик' : 'Новая позиция') + ', передано владельцу');
  }
  st.notified = true;
  if (next.type === 'supplier') supplyOwnerAskSupplier_(st, 0);
  else supplyOwnerAskItem_(st, next.n, null);
}

function supplyFlowShowSummary_(st) {
  st.step = 'confirm';
  var text = supplySummaryText_(st);
  var kb = supplySummaryKeyboard_(st.sid);

  if (st.summaryNew) {
    var sent = supplyTgSend_(st.chatId, text, { keyboard: kb });
    st.msgId = sent.message_id;
  } else {
    supplyTgEdit_(st.chatId, st.msgId, text, kb);
  }

  var firstTime = !st.reported;
  st.reported = true;
  supplyStateSet_(st.chatId, st);

  if (firstTime) supplyFlowReportToOwner_(st, supplyMatchWarnings_(st.doc, st.match));
}

/**
 * Заметки модели всегда пишутся в лог. Владельцу уходят только если есть повод:
 * не прошла проверка (⚠️), модель не уверена в номере/количестве/итоге, понадобился откат на Sonnet.
 * (Ошибка чтения обрабатывается отдельно в supplyFlowOnFile_.)
 */
function supplyFlowReportToOwner_(st, warns) {
  var doc = st.doc;
  var label = doc.source + (doc.doc_number ? ' № ' + doc.doc_number : '');

  var reasons = [];
  if (warns.length) reasons.push('Проверка не прошла: ' + warns.join('; ') + '.');
  // Номер документа в ключе дубля и в Poster не используется, поэтому неуверенность в номере владельцу не интересна.
  var uncertain = (doc.uncertain_fields || []).filter(function (f) { return f !== 'doc_number'; });
  if (uncertain.length) {
    var names = { qty: 'количестве', total: 'итоге' };
    reasons.push('Модель не уверена в: ' + uncertain.map(function (f) { return names[f] || f; }).join(', ') + '.');
  }
  // Откат на Sonnet — только в лог (владельцу не шлём: на результат это не влияет).
  if (st.fallback) console.log('Основная модель не справилась (' + st.fallbackReason + '), прочитано ' + st.model + '. ' + label);

  if (doc.notes) console.log('Заметка модели по ' + label + ' (чат ' + st.chatId + '): ' + doc.notes);
  if (!reasons.length) return;
  console.log('Повод для сообщения владельцу по ' + label + ': ' + reasons.join(' | '));

  var lines = reasons.slice();
  if (doc.notes) lines.push('Заметка модели: ' + doc.notes);
  supplyOwnerNote_('ℹ️ <b>' + supplyEsc_(label) + '</b> (чат ' + supplyEsc_(st.chatId) + ')\n• ' +
    lines.map(supplyEsc_).join('\n• '));
}

/** Сообщение владельцу; ошибки отправки не должны ломать основной сценарий. */
function supplyOwnerNote_(html) {
  var owner = supplyOwnerChat_();
  if (!owner) return;
  try {
    supplyTgSend_(owner, html);
  } catch (e) {
    console.error('supplyOwnerNote_: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Кнопки
// ---------------------------------------------------------------------------

function supplyFlowOnCallback_(cq) {
  var chatId = cq.message.chat.id;
  var msgId = cq.message.message_id;
  var parts = String(cq.data || '').split(':');
  if (parts[0] !== 'sup') {
    supplyTgAnswerCb_(cq.id);
    return;
  }
  var action = parts[1];
  var sid = parts[2];
  var arg = parts[3];

  var found = supplyStateFindBySid_(sid);
  if (!found) {
    supplyTgAnswerCb_(cq.id, 'Это сообщение устарело');
    supplyTgDropKeyboard_(chatId, msgId);
    return;
  }
  // Ответ на нажатие не бросает исключений и не влияет на действие ниже.
  supplyTgAnswerCb_(cq.id);

  var st = found.state;
  var isEmployee = String(chatId) === String(st.chatId);

  var ownerActions = ['sp', 'spp', 'sps', 'spn', 'dc', 'ic', 'ics', 'isk', 'md', 'ocancel', 'sumok'];
  if (ownerActions.indexOf(action) !== -1) {
    if (supplyIsOwnerChat_(chatId)) supplyOwnerOnCallback_(cq, st, action, arg);
    return;
  }
  if (!isEmployee) return;

  if (action === 'ok') return supplyFlowOnConfirm_(st);

  if (action === 'cancel') {
    if (st.step !== 'confirm') return;
    supplyTgEdit_(st.chatId, msgId, supplySummaryText_(st) + '\n\n❌ Отменено');
    supplyStateClear_(st.chatId);
    return;
  }

  if (action === 'edit') {
    if (st.step !== 'confirm' && st.step !== 'sum') return;
    if (st.step === 'sum' && st.sumMsgId) supplyTgDropKeyboard_(st.chatId, st.sumMsgId);
    st.step = 'edit';
    supplyStateSet_(st.chatId, st);
    supplyTgSend_(st.chatId,
      '✏️ Напишите исправление. Позиции документа:\n' + supplyPositionsList_(st) + '\n\n' +
      '• «<code>2 15,5</code>» — у позиции 2 количество 15,5\n' +
      '• «<code>2 шт 40</code>» — у позиции 2 число штук (для позиций «ввод штук»)\n' +
      '• «<code>итог 12345</code>» — итоговая сумма\n' +
      (st.match.lines.some(function (l) { return l.rule; })
        ? '• «<code>2 другое</code>» — позиция 2 (по правилу) определена неверно, спросить владельца\n' : '') +
      'Или пришлите документ заново / /cancel.');
    return;
  }

  if (action === 'dnew') {
    // «Это новый документ»: дальше только после этой кнопки.
    if (st.step !== 'dup') return;
    if (st.dupFrom === 'snap') {
      // Повторный снимок подтверждён как новый документ: читаем его, повторный вопрос по ключу не задаётся.
      supplyTgEdit_(st.chatId, msgId, '⏳ Читаю…');
      var snapFile = st.file;
      supplyStateClear_(st.chatId);
      return supplyFlowReadDoc_(st.chatId, msgId, snapFile, true);
    }
    st.dupConfirmed = true;
    st.step = st.stepBeforeDup || 'confirm';
    supplyTgEdit_(st.chatId, msgId, '✅ Принят как новый документ');
    var from = st.dupFrom;
    supplyStateSet_(st.chatId, st);
    if (from === 'confirm') return supplyFlowOnConfirm_(st);
    if (from === 'finalize') {
      var pf = st.pendingFinal || { hasDisc: false, comment: '' };
      return supplyFlowFinalize_(st, pf.hasDisc, pf.comment);
    }
    return supplyFlowAdvance_(st);
  }

  if (action === 'dcancel') {
    if (st.step !== 'dup') return;
    supplyTgEdit_(st.chatId, msgId, '❌ Отменено');
    supplyFlowDiscard_(st);
    return;
  }

  if (action === 'sumown') {
    // Сумма позиций не сходится с итогом: сотрудник передаёт решение владельцу.
    if (st.step !== 'sum') return;
    var owner = supplyOwnerChat_();
    if (!owner) {
      supplyTgSend_(st.chatId, '⚠️ Владелец не настроен (SUPPLY_OWNER_CHAT_ID). Исправьте данные («Исправить») или отмените документ.');
      return;
    }
    var planO = supplyBuildSupplyPlan_(st, supplyNowAstanaStamp_(), supplyPosterSumMultiplier_());
    supplyTgEdit_(st.chatId, msgId, 'Передано владельцу');
    var sentO = supplyTgSend_(owner, supplyEsc_(supplySumMismatchText_(st, planO)) + '\nЗаписать в Poster как есть?',
      { keyboard: [[
        { text: '✅ Записать как есть', callback_data: 'sup:sumok:' + st.sid },
        { text: '❌ Отменить документ', callback_data: 'sup:ocancel:' + st.sid }
      ]] });
    st.ownerMsgId = sentO.message_id;
    st.step = 'sum_owner';
    supplyStateSet_(st.chatId, st);
    return;
  }

  if (action === 'dn') return supplyFlowFinalize_(st, false, '');

  if (action === 'dy') {
    if (st.step !== 'disc') return;
    st.step = 'disc_comment';
    supplyStateSet_(st.chatId, st);
    supplyTgEdit_(st.chatId, msgId, 'Фактически всё совпало с документом? Есть расхождение.\nНапишите, что именно не совпало:');
  }
}

/**
 * Проверка дубля по журналу. Ключ: поставщик + дата документа (у поставщиков с «несколько в день» = да — ещё и сумма);
 * номер в ключ не входит. Учитываются строки со статусом «принято» и «dry-run».
 * Возвращает true, если можно идти дальше. from: 'advance' (до вопросов по позициям), 'confirm' (по ✅),
 * 'finalize' (перед записью).
 * Если дубль найден и сотрудник ещё не нажал «Это новый документ», показывается предупреждение с кнопками
 * «Это новый документ» / «❌ Отмена», документ ждёт; ✅ до этого не действует.
 */
function supplyFlowDupGate_(st, from) {
  if (st.dupConfirmed) return true;
  var dup = supplyJrnDupCheck_(st.doc);
  if (!dup) return true;

  var kb = [[
    { text: 'Это новый документ', callback_data: 'sup:dnew:' + st.sid },
    { text: '❌ Отмена', callback_data: 'sup:dcancel:' + st.sid }
  ]];
  var ask = supplyEsc_(supplyJrnDupAskText_(dup));
  st.stepBeforeDup = st.step;
  st.step = 'dup';
  st.dupFrom = from;
  if (from === 'advance' && !st.reported && st.msgId) { // сообщение «Читаю…» ещё можно заменить
    supplyTgEdit_(st.chatId, st.msgId, ask, kb);
    st.dupMsgId = st.msgId;
  } else {
    st.dupMsgId = supplyTgSend_(st.chatId, ask, { keyboard: kb }).message_id;
  }
  supplyStateSet_(st.chatId, st);
  return false;
}

/** ✅ Верно: повторная проверка дубля, затем вопрос «Фактически всё совпало?». */
function supplyFlowOnConfirm_(st) {
  if (st.step !== 'confirm' || st.recorded || (st.rec && st.rec.started)) return;
  if (!supplyFlowDupGate_(st, 'confirm')) return;

  // Боевой режим: сумма позиций должна сходиться с итогом накладной до тиына, иначе запись останавливается.
  if (!supplyIsDryRun_() && !st.sumAccepted) {
    var plan = supplyBuildSupplyPlan_(st, supplyNowAstanaStamp_(), supplyPosterSumMultiplier_());
    if (plan.mismatchT !== 0) {
      supplyFlowSumStop_(st, plan);
      return;
    }
  }

  // По умолчанию вопроса «Фактически всё совпало?» нет: сразу запись (SUPPLY_ASK_ACTUAL=true возвращает вопрос).
  // Сводка остаётся без кнопок, следом приходит «✅ Принято · сумма».
  if (!supplyAskActualEnabled_()) {
    supplyTgEdit_(st.chatId, st.msgId, supplySummaryText_(st));
    st.step = 'disc';
    supplyStateSet_(st.chatId, st);
    return supplyFlowFinalize_(st, false, '');
  }
  supplyTgEdit_(st.chatId, st.msgId, supplySummaryText_(st) + '\n\n✅ Подтверждено');
  var sent = supplyTgSend_(st.chatId, 'Фактически всё совпало с документом?',
    { keyboard: supplyDiscrepancyKeyboard_(st.sid) });
  st.step = 'disc';
  st.discMsgId = sent.message_id;
  supplyStateSet_(st.chatId, st);
}

/** Остановка записи: сумма позиций не равна итогу накладной. Сотрудник исправляет данные или передаёт владельцу. */
function supplyFlowSumStop_(st, plan) {
  st.step = 'sum';
  var sent = supplyTgSend_(st.chatId, supplyEsc_(supplySumMismatchText_(st, plan)) +
    '\nЗапись в Poster остановлена. Исправьте количество или итог («Исправить») либо передайте владельцу.',
    { keyboard: [[
      { text: '✏️ Исправить', callback_data: 'sup:edit:' + st.sid },
      { text: 'Передать владельцу', callback_data: 'sup:sumown:' + st.sid }
    ]] });
  st.sumMsgId = sent.message_id;
  supplyStateSet_(st.chatId, st);
}

/**
 * Запись результата после ответа «Фактически всё совпало?». Сама запись (Poster в боевом режиме, журнал,
 * статистика) и сообщения — в supplyFinalizeCore_ (SupplyRecord.gs). Повторное нажатие запись не повторяет.
 */
function supplyFlowFinalize_(st, hasDisc, comment) {
  var resumed = st.recorded || (st.rec && st.rec.started);
  if (!resumed) {
    if (st.step !== 'disc' && st.step !== 'disc_comment') return;
    // Последняя проверка дубля прямо перед записью (документ мог появиться в журнале, пока шёл диалог).
    st.pendingFinal = { hasDisc: hasDisc, comment: comment };
    if (!supplyFlowDupGate_(st, 'finalize')) return;
  }
  supplyFinalizeCore_(st, hasDisc, comment, supplyRecordDeps_());
}

// ---------------------------------------------------------------------------
// Текст
// ---------------------------------------------------------------------------

function supplyFlowOnText_(chatId, msg) {
  var text = String(msg.text).trim();
  var st = supplyStateGet_(chatId);

  if (st) {
    if (st.step === 'pieces') return supplyFlowOnPiecesText_(st, text);
    if (st.step === 'edit') return supplyFlowOnEditText_(st, text);
    if (st.step === 'disc_comment') {
      if (!text) {
        supplyTgSend_(chatId, 'Напишите, что именно не совпало.');
        return;
      }
      return supplyFlowFinalize_(st, true, text);
    }
  }

  // Ответы владельца текстом (поиск, коэффициент) — документ может быть из другого чата.
  if (supplyIsOwnerChat_(chatId)) {
    var os = supplyOwnerTextState_(st);
    if (os) return supplyOwnerOnText_(os, text);
  }

  if (st && st.step.indexOf('owner_') === 0) {
    supplyTgSend_(chatId, 'Документ ждёт ответа владельца.');
    return;
  }
  supplyTgSend_(chatId, 'Пришлите фото накладной или PDF чека.');
}

/** Вопрос сотруднику по позиции с режимом «ввод штук» / «спросить …» / «банки». */
function supplyAskText_(l) {
  var mode = l.entry.mode;
  var head = '«' + supplyEsc_(l.name) + '»: ' + supplyFmtNum_(l.item.qty) + (l.item.unit ? ' ' + supplyEsc_(l.item.unit) : '') + '. ';
  var u = supplyEsc_(l.entry.unit || '');
  if (mode === SUPPLY_CONST.MODE_ASK_QTY) return head + 'Сколько ' + u + ' получили всего? Например: 5 или 2,5';
  if (mode === SUPPLY_CONST.MODE_ASK_PACK) return head + 'Сколько ' + u + ' в одной упаковке? Например: 100';
  if (mode === SUPPLY_CONST.MODE_JARS) return head + 'Чистый вес одной банки, ' + u + '? Например: 0,5\nЕсли банок не ' +
    supplyFmtNum_(l.item.qty) + ', напишите вес и число банок: 0,5 10';
  return head + 'Сколько штук в поставке?';
}

/** Разбор ответа сотрудника: {value, jars} или null. «Ввод штук» — целое число; «банки» — вес и, по желанию, число банок. */
function supplyParseAnswer_(mode, text) {
  var nums = String(text || '').match(/\d+(?:[.,]\d+)?/g);
  if (!nums) return null;
  var vals = nums.map(function (x) { return Number(x.replace(',', '.')); });
  if (mode === SUPPLY_CONST.MODE_JARS) {
    if (vals.length > 2 || !(vals[0] > 0) || (vals.length === 2 && !(vals[1] > 0))) return null;
    return { value: vals[0], jars: vals.length === 2 ? vals[1] : null };
  }
  if (vals.length !== 1 || !(vals[0] > 0)) return null;
  if (mode === SUPPLY_CONST.MODE_PIECES && !/^\d+$/.test(String(text).trim())) return null;
  return { value: vals[0], jars: null };
}

function supplyFlowOnPiecesText_(st, text) {
  var line = st.match.lines[st.pendingN - 1];
  var mode = line && line.entry ? line.entry.mode : SUPPLY_CONST.MODE_PIECES;
  var ans = supplyParseAnswer_(mode, text);
  if (!ans) {
    supplyTgSend_(st.chatId, mode === SUPPLY_CONST.MODE_PIECES ? 'Введите число штук целым числом, например 40.'
      : (mode === SUPPLY_CONST.MODE_JARS ? 'Введите вес банки числом, например 0,5 (можно и число банок: 0,5 10).' : 'Введите число, например 2,5.'));
    return;
  }
  if (!supplyMatchSetPieces_(st.match, st.pendingN, ans.value, ans.jars)) {
    supplyTgSend_(st.chatId, 'Не получилось принять ответ. Попробуйте ещё раз или /cancel.');
    return;
  }
  supplyFlowAdvance_(st);
}

function supplyFlowOnEditText_(st, text) {
  var doc = st.doc;
  var mQty = text.match(/^(\d+)\s+(-?[\d\s.,]+)$/);
  var mPcs = text.match(/^(\d+)\s+шт\s+([\d.,]+(?:\s+\d+)?)$/i);
  var mTot = text.match(/^итог\s+([\d\s.,]+)$/i);
  var mOther = text.match(/^(\d+)\s+другое$/i);

  if (mOther) {
    // Позиция сопоставлена по правилу неверно: убираем правило, вопрос получит владелец.
    var on = Number(mOther[1]);
    if (!st.match.lines[on - 1]) {
      supplyTgSend_(st.chatId, '⚠️ Нет позиции ' + on + '. Пример: «2 другое».');
      return;
    }
    st.match.lines[on - 1].forceAsk = true;
    st.match = supplyMatchDoc_(doc, st.match.lines);
  } else if (mPcs) {
    var n = Number(mPcs[1]);
    var pl = st.match.lines[n - 1];
    var pa = pl && pl.entry ? supplyParseAnswer_(pl.entry.mode, mPcs[2]) : null;
    if (!pl || !pa || !supplyMatchSetPieces_(st.match, n, pa.value, pa.jars)) {
      supplyTgSend_(st.chatId, '⚠️ Число можно задать только у позиций, где бот спрашивает штуки, упаковку, количество или вес банки. Пример: «2 шт 40».');
      return;
    }
  } else if (mQty) {
    var idx = Number(mQty[1]);
    var qty = supplyNum_(mQty[2]);
    if (idx < 1 || idx > doc.items.length || qty === null || qty <= 0) {
      supplyTgSend_(st.chatId, '⚠️ Не понял. Позиция от 1 до ' + doc.items.length + ', количество больше нуля. Пример: «2 15,5».');
      return;
    }
    doc.items[idx - 1].qty = qty;
    st.match = supplyMatchDoc_(doc, st.match.lines); // пересчёт; введённые штуки сохраняются
  } else if (mTot) {
    var total = supplyNum_(mTot[1]);
    if (total === null || total <= 0) {
      supplyTgSend_(st.chatId, '⚠️ Не понял сумму. Пример: «итог 12345».');
      return;
    }
    doc.total = total;
    st.dupConfirmed = false; // сумма входит в ключ у части поставщиков и во вторую проверку — дубль проверяется заново
    st.dupChecked = false;
  } else {
    supplyTgSend_(st.chatId, '⚠️ Не понял. Примеры: «2 15,5», «2 шт 40», «итог 12345» или «2 другое». Либо /cancel.');
    return;
  }

  // Старую сводку гасим, новая придёт отдельным сообщением с кнопками.
  if (st.msgId) supplyTgDropKeyboard_(st.chatId, st.msgId);
  st.doc = doc;
  st.summaryNew = true;
  supplyFlowAdvance_(st);
}
