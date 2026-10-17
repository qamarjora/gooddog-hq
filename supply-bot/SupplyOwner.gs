/**
 * Вопросы владельцу (SUPPLY_OWNER_CHAT_ID): новый поставщик и новая позиция.
 * Документ ждёт ответа; пока владелец не ответил, ничего не оприходуется.
 * Состояние и шаги — см. SupplyFlow.gs. Кнопки: sup:<действие>:<sid>[:<аргумент>].
 *   поставщик: sp (выбор), spp (страница), sps (поиск), spn (не из списка)
 *   позиция:   dc (★ позиция справочника), ic (ингредиент), ics (другое/поиск), isk (не оприходовать), md (режим: d/c/p)
 *   ocancel — отменить документ; sumok — «записать как есть» при расхождении суммы позиций и итога
 */

var SUPPLY_OWNER_TEXT_STEPS = ['owner_supplier_search', 'owner_item_search', 'owner_item_coef'];
var SUPPLY_SUPPLIERS_PER_PAGE = 8;

function supplyBtn_(s) {
  s = String(s);
  return s.length > 48 ? s.substring(0, 47) + '…' : s;
}

/** Отправка владельцу; предыдущий вопрос (его кнопки) гасится. */
function supplyOwnerSend_(st, text, keyboard) {
  var owner = supplyOwnerChat_();
  if (st.ownerMsgId) supplyTgDropKeyboard_(owner, st.ownerMsgId);
  var sent = supplyTgSend_(owner, text, keyboard ? { keyboard: keyboard } : {});
  st.ownerMsgId = sent.message_id;
  supplyStateSet_(st.chatId, st);
  return sent;
}

// ---------------------------------------------------------------------------
// Новый поставщик
// ---------------------------------------------------------------------------

/** Текст и кнопки выбора поставщика. list — готовый список (результат поиска) или null (все из Poster). */
function supplyOwnerSupplierView_(st, page, list, isSearch) {
  list = list || supplyPosterSuppliers_(false);
  var per = SUPPLY_SUPPLIERS_PER_PAGE;
  var paged = !isSearch && list.length > per;
  var pages = paged ? Math.ceil(list.length / per) : 1;
  page = Math.max(0, Math.min(page || 0, pages - 1));
  var slice = paged ? list.slice(page * per, (page + 1) * per) : list.slice(0, per);

  var kb = slice.map(function (s) {
    return [{ text: supplyBtn_(s.name), callback_data: 'sup:sp:' + st.sid + ':' + s.id }];
  });
  if (paged) {
    var nav = [];
    if (page > 0) nav.push({ text: '◀', callback_data: 'sup:spp:' + st.sid + ':' + (page - 1) });
    nav.push({ text: (page + 1) + '/' + pages, callback_data: 'sup:spp:' + st.sid + ':' + page });
    if (page < pages - 1) nav.push({ text: '▶', callback_data: 'sup:spp:' + st.sid + ':' + (page + 1) });
    kb.push(nav);
  }
  if (paged || isSearch) kb.push([{ text: '🔍 Поиск', callback_data: 'sup:sps:' + st.sid }]);
  kb.push([{ text: 'Не из списка', callback_data: 'sup:spn:' + st.sid }]);
  kb.push([{ text: '❌ Отменить документ', callback_data: 'sup:ocancel:' + st.sid }]);

  var text = supplyDocHeader_(st.doc) + '\nНовый поставщик: «' + supplyEsc_(st.doc.source) + '». ' +
    (slice.length ? 'Выберите поставщика в Poster' + (paged ? ' (стр. ' + (page + 1) + '/' + pages + ')' : '') + ':'
                  : 'Список пуст.');
  return { text: text, keyboard: kb };
}

function supplyOwnerAskSupplier_(st, page) {
  st.step = 'owner_supplier';
  var v = supplyOwnerSupplierView_(st, page, null, false);
  supplyOwnerSend_(st, v.text, v.keyboard);
}

// ---------------------------------------------------------------------------
// Новая позиция
// ---------------------------------------------------------------------------

/** Диагностика сопоставления для вопроса о новой позиции (поставщик, артикул, кандидат). Сбой диагностики вопрос не ломает. */
function supplyOwnerDiagText_(st, line) {
  try {
    return supplyDirDiagnoseText_(supplyDirDiagnose_(st.doc.source, line.docName, line.sku), st.doc.source, line.sku);
  } catch (e) {
    console.error('supplyOwnerDiagText_: ' + supplySanitizeSecrets_(e.message));
    return '';
  }
}

function supplyOwnerAskItem_(st, n, searchText) {
  var line = st.match.lines[n - 1];
  var cands = supplyPosterSuggest_(searchText || line.docName, searchText ? 8 : 5,
    line.onlyIngredients ? { onlyKind: 'ингредиент' } : undefined); // слово-исключение (швепс…) — только ингредиенты

  st.step = 'owner_item';
  st.pendingN = n;
  st.pendingIng = null;

  // Сомнительные совпадения со справочником (нечёткое сопоставление) — первыми кнопками.
  var dirCands = searchText ? [] : (line.cands || []);
  var kb = [];
  var dirIds = {};
  dirCands.forEach(function (c, i) {
    dirIds[(c.ptype === 'товар' ? 'p' : 'i') + c.id] = true;
    kb.push([{ text: supplyBtn_('★ ' + (c.posterName || c.name) + ' ' + supplyKindMark_(c.ptype) + ' (' + c.name + ')'),
              callback_data: 'sup:dc:' + st.sid + ':' + i }]);
  });
  cands = cands.filter(function (c) { return !dirIds[c.uid]; });
  cands.forEach(function (c) {
    kb.push([{ text: supplyBtn_(c.name + ' (' + c.unit + ') ' + supplyKindMark_(c.kind)), callback_data: 'sup:ic:' + st.sid + ':' + c.uid }]);
  });
  kb.push([
    { text: '🔍 Другое', callback_data: 'sup:ics:' + st.sid },
    { text: '🚫 Не оприходовать', callback_data: 'sup:isk:' + st.sid }
  ]);
  kb.push([{ text: '❌ Отменить документ', callback_data: 'sup:ocancel:' + st.sid }]);

  var text = supplyDocHeader_(st.doc) + '\nНовая позиция: «' + supplyEsc_(line.docName) + '»\nВ документе: ' +
    supplyFmtNum_(line.item.qty) + (line.item.unit ? ' ' + supplyEsc_(line.item.unit) : '') +
    (searchText ? '\nПоиск: «' + supplyEsc_(searchText) + '»' : '') +
    (line.onlyIngredients ? '\nПравило-исключение «' + supplyEsc_(line.exceptionWord) + '»: правила для товаров не применялись, показаны только ингредиенты Poster.' : '') +
    (dirCands.length ? '\n★ — похоже на позиции справочника. Это одна из них?' : '') +
    (kb.length > 3 ? '\nВыберите позицию Poster:' : '\nПохожих не нашёл. Нажмите «Другое» и введите слово.');
  if (!searchText) text += '\n\n' + supplyOwnerDiagText_(st, line);
  supplyOwnerSend_(st, text, kb);
}

/**
 * Сохранить выбор по позиции в справочник и продолжить диалог.
 * mode: прямо / коэффициент / ввод штук / пропускать; ing — ингредиент Poster (для «пропускать» не нужен).
 * mid — id сообщения владельца с кнопками (если выбор сделан кнопкой), иначе подтверждение уйдёт новым сообщением.
 */
function supplyOwnerSaveItem_(st, n, ing, mode, coef, mid) {
  var line = st.match.lines[n - 1];
  var fields = { source: st.doc.source, name: line.docName, mode: mode };
  if (line.sku) fields.sku = line.sku; // артикул документа запоминается вместе с позицией
  if (mode !== SUPPLY_CONST.MODE_SKIP) {
    fields.id = ing.id;
    fields.posterName = ing.name;
    fields.unit = ing.kind === 'товар' ? 'шт' : ing.unit;
    fields.ptype = ing.kind || 'ингредиент'; // «товар» — id в колонке C это id товара (createSupply: type товара)
    fields.coef = mode === SUPPLY_CONST.MODE_PIECES ? null : coef;
  }
  supplyDirUpsert_(fields);

  var how = mode === SUPPLY_CONST.MODE_SKIP ? 'не оприходовать'
    : ing.name + ' ' + supplyKindMark_(ing.kind) + ' (' + ing.unit + '), ' + mode + (mode === SUPPLY_CONST.MODE_COEF ? ' ×' + supplyFmtNum_(coef) : '');
  var text = supplyDocHeader_(st.doc) + '\n✅ «' + supplyEsc_(line.docName) + '» → ' + supplyEsc_(how);
  var owner = supplyOwnerChat_();
  if (mid) supplyTgEdit_(owner, mid, text);
  else supplyTgSend_(owner, text);

  st.ownerMsgId = null;
  st.pendingN = null;
  st.pendingIng = null;
  st.match = supplyMatchDoc_(st.doc, st.match.lines);
  supplyFlowAdvance_(st);
}

// ---------------------------------------------------------------------------
// Кнопки владельца
// ---------------------------------------------------------------------------

function supplyOwnerOnCallback_(cq, st, action, arg) {
  var owner = supplyOwnerChat_();
  var mid = cq.message.message_id;

  if (action === 'ocancel') {
    supplyTgEdit_(owner, mid, supplyDocHeader_(st.doc) + '\n❌ Документ отменён');
    st.ownerMsgId = null;
    supplyTgSend_(st.chatId, '❌ Документ отменён владельцем.');
    supplyFlowDiscard_(st);
    return;
  }

  // --- сумма позиций не равна итогу накладной ---
  if (action === 'sumok') {
    if (st.step !== 'sum_owner') return;
    st.sumAccepted = true;
    st.step = 'confirm';
    st.ownerMsgId = null;
    supplyStateSet_(st.chatId, st);
    supplyTgEdit_(owner, mid, supplyDocHeader_(st.doc) + '\n✅ Записать как есть — подтверждено');
    supplyFlowOnConfirm_(st); // дальше как по ✅ сотрудника: вопрос «Фактически всё совпало?»
    return;
  }

  // --- поставщик ---
  if (action === 'spp') {
    if (st.step !== 'owner_supplier') return;
    var v = supplyOwnerSupplierView_(st, Number(arg), null, false);
    supplyTgEdit_(owner, mid, v.text, v.keyboard);
    return;
  }
  if (action === 'sps') {
    if (st.step !== 'owner_supplier') return;
    st.step = 'owner_supplier_search';
    supplyStateSet_(st.chatId, st);
    supplyTgSend_(owner, '🔍 Введите часть названия поставщика.');
    return;
  }
  if (action === 'sp') {
    if (st.step !== 'owner_supplier') return;
    var id = Number(arg);
    var sup = supplyPosterSuppliers_(false).filter(function (s) { return s.id === id; })[0];
    if (!sup) {
      supplyTgSend_(owner, 'Поставщик не найден в Poster. Выберите другого.');
      return;
    }
    supplySupplierSave_(st.doc.source, sup.id, sup.name);
    supplyTgEdit_(owner, mid, supplyDocHeader_(st.doc) + '\n✅ Поставщик: ' + supplyEsc_(sup.name));
    st.ownerMsgId = null;
    st.match = supplyMatchDoc_(st.doc, st.match.lines);
    supplyFlowAdvance_(st);
    return;
  }
  if (action === 'spn') {
    if (st.step !== 'owner_supplier') return;
    supplyTgEdit_(owner, mid, supplyDocHeader_(st.doc) + '\nСоздайте поставщика в Poster и повторите.');
    st.ownerMsgId = null;
    supplyTgSend_(st.chatId, '❌ Документ не принят: поставщика нет в Poster. Владелец уведомлён.');
    supplyFlowDiscard_(st);
    return;
  }

  // --- позиция ---
  if (action === 'dc') {
    // Владелец подтвердил: это позиция из справочника (★).
    if (st.step !== 'owner_item') return;
    var cl = st.match.lines[st.pendingN - 1];
    var cand = (cl.cands || [])[Number(arg)];
    if (!cand) return;
    supplyDirAdopt_(cand.row, st.doc.source, cl.docName, cl.sku);
    supplyTgEdit_(owner, mid, supplyDocHeader_(st.doc) + '\n✅ «' + supplyEsc_(cl.docName) + '» → ' +
      supplyEsc_(cand.posterName || cand.name) + ' (по справочнику)');
    st.ownerMsgId = null;
    st.pendingN = null;
    st.match = supplyMatchDoc_(st.doc, st.match.lines);
    supplyFlowAdvance_(st);
    return;
  }
  if (action === 'ics') {
    if (st.step !== 'owner_item') return;
    st.step = 'owner_item_search';
    supplyStateSet_(st.chatId, st);
    supplyTgSend_(owner, '🔍 Введите слово для поиска ингредиента в Poster.');
    return;
  }
  if (action === 'isk') {
    if (st.step !== 'owner_item') return;
    supplyOwnerSaveItem_(st, st.pendingN, null, SUPPLY_CONST.MODE_SKIP, null, mid);
    return;
  }
  if (action === 'ic') {
    if (st.step !== 'owner_item') return;
    var ing = supplyPosterCatalogFind_(String(arg)); // uid: «i12» — ингредиент, «p345» — товар
    if (!ing) {
      supplyTgSend_(owner, 'Позиция не найдена в справочнике Poster. Выберите другую.');
      return;
    }
    var line = st.match.lines[st.pendingN - 1];
    if (ing.kind === 'товар' || supplyUnitNorm_(line.item.unit) === supplyUnitNorm_(ing.unit)) {
      // Товар — всегда «прямо», коэффициент 1, шт; у ингредиента при совпадении единиц — тоже без лишних вопросов.
      // Единицы совпадают — режим «прямо» без лишних вопросов.
      supplyOwnerSaveItem_(st, st.pendingN, ing, SUPPLY_CONST.MODE_DIRECT, 1, mid);
      return;
    }
    st.pendingIng = ing;
    st.step = 'owner_item_mode';
    supplyStateSet_(st.chatId, st);
    var kb = [[{ text: 'Прямо (1:1)', callback_data: 'sup:md:' + st.sid + ':d' }],
              [{ text: 'Коэффициент', callback_data: 'sup:md:' + st.sid + ':c' }]];
    if (ing.unit === 'шт') kb.push([{ text: 'Ввод штук', callback_data: 'sup:md:' + st.sid + ':p' }]);
    kb.push([{ text: '❌ Отменить документ', callback_data: 'sup:ocancel:' + st.sid }]);
    supplyTgEdit_(owner, mid, supplyDocHeader_(st.doc) + '\n«' + supplyEsc_(line.docName) + '» → ' + supplyEsc_(ing.name) +
      ' ' + supplyKindMark_(ing.kind) + ' (' + supplyEsc_(ing.unit) + ').\nВ документе единица «' + supplyEsc_(line.item.unit || '—') +
      '». Как пересчитывать в единицы склада?', kb);
    return;
  }
  if (action === 'md') {
    if (st.step !== 'owner_item_mode' || !st.pendingIng) return;
    var pend = st.pendingIng;
    if (arg === 'd') {
      supplyOwnerSaveItem_(st, st.pendingN, pend, SUPPLY_CONST.MODE_DIRECT, 1, mid);
    } else if (arg === 'p' && pend.unit === 'шт') {
      supplyOwnerSaveItem_(st, st.pendingN, pend, SUPPLY_CONST.MODE_PIECES, null, mid);
    } else if (arg === 'c') {
      st.step = 'owner_item_coef';
      supplyStateSet_(st.chatId, st);
      var ln = st.match.lines[st.pendingN - 1];
      supplyTgEdit_(owner, mid, supplyDocHeader_(st.doc) + '\n«' + supplyEsc_(ln.docName) + '» → ' + supplyEsc_(pend.name));
      supplyTgSend_(owner, 'Введите коэффициент: сколько ' + supplyEsc_(pend.unit) + ' в 1 ' +
        supplyEsc_(ln.item.unit || 'единице документа') + ' (например, 0,9).');
    }
  }
}

// ---------------------------------------------------------------------------
// Текст владельца
// ---------------------------------------------------------------------------

/** Документ, который ждёт текстового ответа владельца (поиск, коэффициент); own — состояние в чате владельца. */
function supplyOwnerTextState_(own) {
  if (own && SUPPLY_OWNER_TEXT_STEPS.indexOf(own.step) !== -1) return own;
  var best = null;
  supplyStateAll_().forEach(function (x) {
    if (SUPPLY_OWNER_TEXT_STEPS.indexOf(x.state.step) === -1) return;
    if (!best || x.updated > best.updated) best = x;
  });
  return best ? best.state : null;
}

function supplyOwnerOnText_(st, text) {
  var owner = supplyOwnerChat_();

  if (st.step === 'owner_supplier_search') {
    var list = supplySupplierSearch_(text, SUPPLY_SUPPLIERS_PER_PAGE);
    if (!list.length) {
      supplyTgSend_(owner, 'По «' + supplyEsc_(text) + '» ничего не найдено. Введите другое слово.');
      return;
    }
    st.step = 'owner_supplier';
    var v = supplyOwnerSupplierView_(st, 0, list, true);
    supplyOwnerSend_(st, v.text, v.keyboard);
    return;
  }

  if (st.step === 'owner_item_search') {
    supplyOwnerAskItem_(st, st.pendingN, text);
    return;
  }

  if (st.step === 'owner_item_coef') {
    var k = supplyNum_(text);
    if (k === null || !(k > 0)) {
      supplyTgSend_(owner, 'Введите число больше нуля, например 0,9.');
      return;
    }
    supplyOwnerSaveItem_(st, st.pendingN, st.pendingIng, SUPPLY_CONST.MODE_COEF, k, null);
  }
}
