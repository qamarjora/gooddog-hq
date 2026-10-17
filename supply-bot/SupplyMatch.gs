/**
 * Сопоставление документа со справочниками и пересчёт в единицы склада.
 * Чистая логика: Poster не вызывается, листы только читаются.
 *
 * match = {
 *   supplier: {id, name, row} | null,       // из листа «Поставщики»
 *   lines: [ line ... ]                      // по одной на позицию документа
 * }
 * line = {
 *   n, docName, name (для показа: название в Poster, если известно),
 *   item: {name, qty, unit, price, sum},     // как в документе
 *   entry: снимок записи справочника | null, // {row, id, posterName, unit, mode, coef, weight, price, count, avg}
 *   status: 'unknown' | 'skip' | 'need_pieces' | 'ready' | 'invalid',
 *   pieces: число штук (режим «ввод штук») | null,
 *   qtyWh: количество в единицах склада | null, unit: единица склада,
 *   weightPerPiece: вес на штуку | null,
 *   lineSum: сумма строки по документу | null,
 *   unitPriceWh: цена за единицу склада (lineSum ÷ qtyWh) | null
 * }
 */

function supplyEntrySnapshot_(e) {
  return {
    row: e.row, id: e.id, posterName: e.posterName, unit: e.unit, mode: e.mode,
    coef: e.coef, weight: e.weight, price: e.price, count: e.count, avg: e.avg, sku: e.sku || '', ptype: e.ptype || 'ингредиент'
  };
}

/** Кандидат из справочника для вопроса владельцу (минимум полей, чтобы состояние оставалось компактным). */
function supplyCandSnapshot_(e) {
  return { row: e.row, name: e.name, posterName: e.posterName, id: e.id, unit: e.unit, mode: e.mode, ptype: e.ptype || 'ингредиент' };
}

/** Сумма строки по документу: sum, иначе кол-во × цена. */
function supplyLineSum_(item) {
  if (item.sum !== null && item.sum !== undefined) return item.sum;
  if (item.qty !== null && item.price !== null && item.price !== undefined) return item.qty * item.price;
  return null;
}

function supplyRound3_(x) {
  return Math.round(x * 1000) / 1000;
}

/** Строка по записи справочника (entry может быть null) и числу штук (если уже известно). */
function supplyMatchBuildLine_(n, item, entry, pieces, cands, extra) {
  extra = extra || {};
  var line = {
    n: n,
    docName: item.name,
    sku: item.sku || null,
    cands: cands || [], // сомнительные кандидаты из справочника (нечёткое сопоставление), если записи нет
    rule: extra.rule || null,                 // позиция сопоставлена по правилу из листа «Правила сопоставления» (в справочник ещё не записана)
    onlyIngredients: !!extra.onlyIngredients, // слово-исключение (например, швепс): искать только среди ингредиентов Poster
    exceptionWord: extra.exceptionWord || '',
    forceAsk: !!extra.forceAsk,               // сотрудник отметил сопоставление по правилу неверным: спросить владельца
    name: entry && entry.posterName ? entry.posterName : item.name,
    item: item,
    entry: entry ? supplyEntrySnapshot_(entry) : null,
    status: 'unknown',
    pieces: pieces === undefined ? null : pieces,
    qtyWh: null,
    unit: entry ? entry.unit : '',
    weightPerPiece: null,
    lineSum: supplyLineSum_(item),
    unitPriceWh: null
  };
  if (!entry) return line;

  // Товары (Вода, Напитки, Детский сок…) всегда поштучно: режим «прямо», коэффициент 1, единица «шт» —
  // что бы ни было записано в справочнике (кроме «пропускать»).
  if (entry.ptype === 'товар' && entry.mode !== SUPPLY_CONST.MODE_SKIP) {
    entry = Object.assign({}, entry, { mode: SUPPLY_CONST.MODE_DIRECT, coef: 1, unit: 'шт' });
    line.unit = 'шт';
  }

  if (entry.mode === SUPPLY_CONST.MODE_SKIP) {
    line.status = 'skip';
    return line;
  }
  // Запись есть, но не доделана (нет ingredient_id или режима) — спрашиваем, как про незнакомую.
  if (!entry.id) return line;

  if (entry.mode === SUPPLY_CONST.MODE_DIRECT) {
    line.qtyWh = supplyRound3_(item.qty);
    line.status = 'ready';
  } else if (entry.mode === SUPPLY_CONST.MODE_COEF) {
    if (entry.coef === null || entry.coef <= 0) {
      line.status = 'invalid'; // коэффициент не задан
      return line;
    }
    line.qtyWh = supplyRound3_(item.qty * entry.coef);
    line.status = 'ready';
  } else if (entry.mode === SUPPLY_CONST.MODE_PIECES) {
    if (line.pieces === null || line.pieces <= 0) {
      line.pieces = null;
      line.status = 'need_pieces';
      return line;
    }
    line.qtyWh = line.pieces;
    line.weightPerPiece = item.qty / line.pieces; // item.qty — вес по документу
    line.status = 'ready';
  } else {
    return line; // неизвестный режим -> как незнакомая позиция
  }

  if (line.lineSum !== null && line.qtyWh > 0) line.unitPriceWh = line.lineSum / line.qtyWh;
  return line;
}

/**
 * Сопоставляет документ. prevLines (необязательно) — прежние строки, из них берутся уже введённые штуки
 * (пересопоставление после ответа владельца или правки количества).
 */
function supplyMatchDoc_(doc, prevLines) {
  var sups = supplySupLoad_();
  var rows = supplyDirLoad_(sups);
  var prevByN = {};
  (prevLines || []).forEach(function (l) {
    prevByN[l.n] = { pieces: l.pieces, forceAsk: !!l.forceAsk };
  });

  // Правила по ключевым словам и справочник Poster загружаются лениво: только если позиции нет в справочнике накладных.
  var rules = null;
  var catalog = null;
  function getRules() {
    if (rules === null) {
      try { rules = supplyRulesLoad_(); } catch (e) { console.error('supplyMatchDoc_: правила недоступны: ' + supplySanitizeSecrets_(e.message)); rules = []; }
    }
    return rules;
  }
  function getCatalog() {
    if (catalog === null) {
      try { catalog = supplyPosterCatalog_(false); } catch (e) { console.error('supplyMatchDoc_: справочник Poster недоступен: ' + supplySanitizeSecrets_(e.message)); catalog = []; }
    }
    return catalog;
  }

  var lines = doc.items.map(function (item, i) {
    var n = i + 1;
    var m = supplyDirMatch_(rows, doc.source, item.name, item.sku, sups);
    var entry = m.entry;
    // Первое успешное сопоставление по названию: запоминаем артикул документа в справочнике.
    if (entry && m.how !== 'sku' && item.sku && !entry.sku) {
      supplyDirSetSku_(entry.row, item.sku);
      entry.sku = item.sku;
    }
    var prev = prevByN[n] || {};
    // Справочника накладных нет — слово-исключение → правила по ключевым словам → вопрос владельцу.
    var res = entry || m.candidates.length ? { entry: entry, rule: null, onlyIngredients: false, exceptionWord: '' }
      : supplyResolveItemEntry_(m, item, doc.source, prev.forceAsk, getRules(), getCatalog);
    return supplyMatchBuildLine_(n, item, res.entry, prev.pieces, m.candidates.map(supplyCandSnapshot_),
      { rule: res.rule, onlyIngredients: res.onlyIngredients, exceptionWord: res.exceptionWord, forceAsk: prev.forceAsk });
  });
  var supplier = supplySupplierFind_(doc.source);
  // Совпадение не точное (другое написание, ошибка распознавания): запоминаем это написание на листе «Поставщики».
  if (supplier && supplier.how !== 'exact') supplySupplierAddVariant_(doc.source, supplier);
  return { supplier: supplier, lines: lines };
}

/**
 * Следующий шаг, который нужно сделать до сводки, или null, если всё готово.
 * Порядок: поставщик -> незнакомые позиции (по порядку) -> штуки.
 * Возвращает {type: 'supplier'} | {type: 'item', n} | {type: 'pieces', n}.
 */
function supplyMatchNext_(match) {
  if (!match.supplier) return { type: 'supplier' };
  for (var i = 0; i < match.lines.length; i++) {
    var st = match.lines[i].status;
    if (st === 'unknown' || st === 'invalid') return { type: 'item', n: match.lines[i].n };
  }
  for (var j = 0; j < match.lines.length; j++) {
    if (match.lines[j].status === 'need_pieces') return { type: 'pieces', n: match.lines[j].n };
  }
  return null;
}

/** Записать число штук для позиции n. Возвращает true, если принято. */
function supplyMatchSetPieces_(match, n, pieces) {
  var line = match.lines[n - 1];
  if (!line || !line.entry || line.entry.mode !== SUPPLY_CONST.MODE_PIECES) return false;
  if (pieces === null || !(pieces > 0)) return false;
  var rebuilt = supplyMatchBuildLine_(n, line.item, line.entry, pieces, line.cands,
    { rule: line.rule, onlyIngredients: line.onlyIngredients, exceptionWord: line.exceptionWord, forceAsk: line.forceAsk });
  match.lines[n - 1] = rebuilt;
  return true;
}

/** Строки, которые будут оприходованы (готовые, не «пропускать»). */
function supplyMatchReadyLines_(match) {
  return match.lines.filter(function (l) { return l.status === 'ready'; });
}

/** Строки в формате supplyChecksLines_ (для готовых позиций). */
function supplyMatchCheckLines_(match) {
  return supplyMatchReadyLines_(match).map(function (l) {
    return {
      n: l.n, name: l.name, item: l.item, entry: l.entry,
      qtyWh: l.qtyWh, unit: l.unit, weightPerPiece: l.weightPerPiece, unitPriceWh: l.unitPriceWh
    };
  });
}

/** Все предупреждения по документу: арифметика + цена / диапазон / вес на штуку. */
function supplyMatchWarnings_(doc, match) {
  return supplyChecksAll_(doc, supplyMatchCheckLines_(match));
}

/** Единица -> каноническая подпись (шт / кг / л / г / мл) для сравнения единицы документа и склада. */
function supplyUnitNorm_(u) {
  var s = String(u || '').toLowerCase().replace(/[.\s]/g, '');
  var map = {
    'шт': 'шт', 'штук': 'шт', 'штука': 'шт', 'pcs': 'шт', 'pc': 'шт',
    'кг': 'кг', 'kg': 'кг', 'килограмм': 'кг',
    'л': 'л', 'l': 'л', 'литр': 'л',
    'г': 'г', 'гр': 'г', 'грамм': 'г', 'мл': 'мл'
  };
  return map[s] || s;
}

/** Самопроверка сопоставления и ключей документов. Листы и Poster не нужны. Запуск вручную. */
function supplyMatchSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  function close(a, b) { return a !== null && Math.abs(a - b) < 1e-6; }
  function entry(over) {
    var e = { row: 2, id: 57, posterName: 'тест', unit: 'шт', mode: 'прямо', coef: 1,
              weight: null, price: null, count: 0, avg: null };
    Object.keys(over || {}).forEach(function (k) { e[k] = over[k]; });
    return e;
  }
  function item(q, p, s, u) { return { name: 'Тест', qty: q, unit: u || 'шт', price: p, sum: s }; }

  // Режим «прямо»
  var l = supplyMatchBuildLine_(1, item(5, 100, 500), entry());
  expect('прямо: ready, 5 шт', l.status === 'ready' && l.qtyWh === 5);
  expect('прямо: цена за ед. склада 100', close(l.unitPriceWh, 100));

  // Режим «коэффициент»: 10 шт × 0,9 = 9 л
  l = supplyMatchBuildLine_(1, item(10, 50, 500), entry({ mode: 'коэффициент', coef: 0.9, unit: 'л' }));
  expect('коэффициент: 10 × 0,9 = 9 л', l.status === 'ready' && close(l.qtyWh, 9) && l.unit === 'л');
  expect('коэффициент: цена за литр 500/9', close(l.unitPriceWh, 500 / 9));
  l = supplyMatchBuildLine_(1, item(10, 50, 500), entry({ mode: 'коэффициент', coef: null }));
  expect('коэффициент не задан -> invalid', l.status === 'invalid');

  // Режим «ввод штук»
  var piecesEntry = entry({ mode: 'ввод штук', unit: 'шт', coef: null });
  l = supplyMatchBuildLine_(1, item(4.2, null, 2520, 'кг'), piecesEntry);
  expect('штуки не введены -> need_pieces', l.status === 'need_pieces' && l.qtyWh === null);
  l = supplyMatchBuildLine_(1, item(4.2, null, 2520, 'кг'), piecesEntry, 40);
  expect('штуки 40: ready, оприходовать 40 шт', l.status === 'ready' && l.qtyWh === 40);
  expect('штуки 40: вес на штуку 0,105', close(l.weightPerPiece, 0.105));
  expect('штуки 40: цена за штуку 63', close(l.unitPriceWh, 63));

  // «Пропускать», незнакомые
  l = supplyMatchBuildLine_(1, item(1, 1, 1), entry({ mode: 'пропускать', id: null }));
  expect('пропускать -> skip', l.status === 'skip');
  expect('нет записи -> unknown', supplyMatchBuildLine_(1, item(1, 1, 1), null).status === 'unknown');
  expect('запись без ingredient_id -> unknown', supplyMatchBuildLine_(1, item(1, 1, 1), entry({ id: null })).status === 'unknown');

  // Очередь вопросов
  var ready = supplyMatchBuildLine_(1, item(1, 1, 1), entry());
  var unknown = supplyMatchBuildLine_(2, item(1, 1, 1), null);
  var needP = supplyMatchBuildLine_(3, item(4, null, 100, 'кг'), piecesEntry);
  var skip = supplyMatchBuildLine_(4, item(1, 1, 1), entry({ mode: 'пропускать' }));
  expect('нет поставщика -> сначала поставщик', supplyMatchNext_({ supplier: null, lines: [ready] }).type === 'supplier');
  var nx = supplyMatchNext_({ supplier: { id: 1 }, lines: [ready, needP, unknown] });
  expect('незнакомая позиция раньше штук', nx.type === 'item' && nx.n === 2);
  nx = supplyMatchNext_({ supplier: { id: 1 }, lines: [ready, needP] });
  expect('затем штуки', nx.type === 'pieces' && nx.n === 3);
  expect('всё готово -> null', supplyMatchNext_({ supplier: { id: 1 }, lines: [ready, skip] }) === null);

  // Ввод штук
  var m = { supplier: { id: 1 }, lines: [needP, ready] };
  expect('setPieces(40) принято', supplyMatchSetPieces_(m, 1, 40) === true && m.lines[0].status === 'ready');
  expect('setPieces(0) отклонено', supplyMatchSetPieces_(m, 1, 0) === false);
  expect('setPieces для режима «прямо» отклонено', supplyMatchSetPieces_(m, 2, 5) === false);
  expect('готовые строки без пропущенных', supplyMatchReadyLines_({ lines: [ready, skip, unknown] }).length === 1);


  // Артикул и нечёткое сопоставление (случай Qazmeatproduct: «Круг» прочитан как «Кунт»)
  function row(source, name, sku, over) {
    var r = { row: 2, source: source, name: name, id: 57, posterName: 'сосиски', unit: 'шт', mode: 'ввод штук',
              coef: null, weight: null, price: null, count: 0, avg: null, sku: sku || '',
              srcKey: supplyNormSource_(source), nameKey: supplyNameKey_(name) };
    Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
    return r;
  }
  var KRUG = 'Круг полукопчёный, вес (ГП000000045)';
  var rowsQ = [row('Qazmeatproduct Astana', KRUG, 'ГП000000045')];

  expect('артикул из названия в скобках', supplyExtractSku_(KRUG) === 'ГП000000045');
  expect('«(480шт)» — не артикул', supplyExtractSku_('РК-19 В (480шт) (Высокий)') === null);
  expect('артикул берётся из названия, если модель его не вернула',
    supplyClaudeNormalize_({ doc_type: 'invoice', items: [{ name: KRUG, qty: 1 }] }).items[0].sku === 'ГП000000045');

  var m1 = supplyDirMatch_(rowsQ, 'Qazmeatproduct', 'Кунт полукопченый вес', 'ГП000000045');
  expect('по артикулу при искажённом названии', m1.entry !== null && m1.how === 'sku');
  var m2 = supplyDirMatch_(rowsQ, 'Qazmeatproduct', 'Кунт полукопченый вес', 'GP000000045');
  expect('артикул латиницей = кириллице (по цифрам)', m2.entry !== null && m2.how === 'sku');

  expect('схожесть «Кунт…» и «Круг…» выше порога 0,8', supplySimilarity_('Кунт полукопченый вес', KRUG) >= 0.8);
  var m3 = supplyDirMatch_(rowsQ, 'Qazmeatproduct', 'Кунт полукопченый вес', null);
  expect('без артикула: единственный нечёткий кандидат — уверенно', m3.entry !== null && m3.how === 'fuzzy');
  var m4 = supplyDirMatch_(rowsQ, 'Qazmeatproduct', KRUG, null);
  expect('без артикула: точное название', m4.entry !== null && m4.how === 'name');
  var m5 = supplyDirMatch_(rowsQ, 'Qazmeatproduct', 'Молоко Зенченко 0,9 л', null);
  expect('непохожее название — незнакомая позиция', m5.entry === null && m5.candidates.length === 0);
  var m6 = supplyDirMatch_(rowsQ, 'Магнум', 'Кунт полукопченый вес', null);
  expect('чужой источник не сопоставляется', m6.entry === null && m6.candidates.length === 0);

  var rowsTwo = [row('Qazmeatproduct Astana', 'Круг полукопчёный вес малый'),
                 row('Qazmeatproduct Astana', 'Круг полукопчёный вес малый 2', '', { row: 3 })];
  var m7 = supplyDirMatch_(rowsTwo, 'Qazmeatproduct', 'Кунт полукопчёный вес малый', null);
  expect('два нечётких кандидата — сомнение, записи нет', m7.entry === null && m7.candidates.length === 2);

  var rowsOtherSku = [row('Qazmeatproduct Astana', KRUG, 'ГП000000099')];
  var m8 = supplyDirMatch_(rowsOtherSku, 'Qazmeatproduct', KRUG, 'ГП000000045');
  expect('другой артикул — другой товар, по названию не сопоставляется', m8.entry === null);

  var rowsNoSku = [row('Qazmeatproduct Astana', KRUG, '')];
  var m9 = supplyDirMatch_(rowsNoSku, 'Qazmeatproduct', KRUG, 'ГП000000045');
  expect('в справочнике артикула нет: сопоставление по названию (артикул запишется автоматически)',
    m9.entry !== null && m9.how === 'name');
  var m10 = supplyDirMatch_(rowsQ, 'Qazmeatproduct', KRUG, null);
  expect('в документе артикула нет — работаем по названию как раньше', m10.entry !== null && m10.how === 'name');

  var cl = supplyMatchBuildLine_(1, { name: 'Кунт', qty: 1, unit: 'кг', price: 1, sum: 1, sku: 'ГП000000045' }, null, undefined,
    m7.candidates.map(supplyCandSnapshot_));
  expect('строка хранит артикул и кандидатов для вопроса владельцу',
    cl.status === 'unknown' && cl.sku === 'ГП000000045' && cl.cands.length === 2);

  // --- Сопоставление по supplier_id: опечатка в названии источника не мешает ---
  function supRow(source, id) { return { source: source, id: id, name: '', key: supplyNormSource_(source), row: 2, multi: false }; }
  var sups6 = [supRow('Qazmeatproduct', 6), supRow('Магнум', 13)];
  var rowsS = [row('Qazmeatproduct Astana', 'Круг полукопчёный, вес', 'ГП000000045', { supId: 6, row: 4 }),
               row('Магнум', 'Томаты розовые', '', { supId: 13, row: 7, id: 6, posterName: 'томаты', mode: 'прямо' })];
  var TYPO = 'QAZMEATPROCUCT ASTANA';
  expect('опечатка в источнике определяется как supplier_id 6 (нечёткое совпадение)',
    supplySupplierFindIn_(sups6, TYPO).id === 6 && supplySupplierFindIn_(sups6, TYPO).how === 'fuzzy');
  expect('по тексту (без supplier_id) источник с опечаткой запись не находит — как раньше',
    supplyDirMatch_(rowsS, TYPO, 'Кнут полукопченый,вес', 'ГП000000045').entry === null);
  var ms = supplyDirMatch_(rowsS, TYPO, 'Кнут полукопченый,вес', 'ГП000000045', sups6);
  expect('источник «QAZMEATPROCUCT ASTANA» + артикул ГП000000045 находит «Круг полукопчёный, вес» без вопросов',
    ms.entry !== null && ms.entry.name === 'Круг полукопчёный, вес' && ms.how === 'sku' && ms.entry.row === 4);
  var ms2 = supplyDirMatch_(rowsS, TYPO, 'Круг полукопчёный, вес', null, sups6);
  expect('та же опечатка без артикула: находит по названию', ms2.entry !== null && ms2.how === 'name');
  var ms3 = supplyDirMatch_(rowsS, TYPO, 'Кнут полукопченый,вес', null, sups6);
  expect('та же опечатка, название искажено, артикула нет: нечёткое по названию в пределах поставщика',
    ms3.entry !== null && ms3.how === 'fuzzy');
  expect('другой поставщик (supplier_id 13) записи Qazmeatproduct не видит',
    supplyDirMatch_(rowsS, 'Магнум', 'Кнут полукопченый,вес', 'ГП000000045', sups6).entry === null);
  expect('артикул с лишним нулём и опечатка в источнике',
    supplyDirMatch_(rowsS, TYPO, 'x', 'ГП0000000045', sups6).how === 'sku');
  expect('supplier_id не определён у документа — сравнение по тексту, как раньше',
    supplyDirMatch_(rowsS, 'Qazmeatproduct Astana', 'Круг полукопчёный, вес', null, []).how === 'name');
  expect('supplier_id не определён у строки справочника — сравнение по тексту',
    supplyDirMatch_([row('Qazmeatproduct Astana', 'Круг полукопчёный, вес', 'ГП000000045', { supId: null })], TYPO, 'x', 'ГП000000045', sups6).entry === null &&
    supplyDirMatch_([row('Qazmeatproduct Astana', 'Круг полукопчёный, вес', 'ГП000000045', { supId: null })], 'Qazmeatproduct', 'x', 'ГП000000045', sups6).how === 'sku');

  // --- Диагностика для вопроса владельцу ---
  var dg = supplyDirDiagnoseIn_(rowsS, sups6, TYPO, 'Кнут полукопченый,вес', 'ГП000000045');
  expect('диагностика: supplier_id, ключ артикула, найден ли артикул, лучший кандидат и схожесть',
    dg.supplier.id === 6 && dg.skuKey === 'GP45' && dg.skuEntry !== null && dg.best.entry.row === 4 && dg.best.score > 0.8 && dg.scope === 1);
  var dgText = supplyDirDiagnoseText_(dg, TYPO, 'ГП000000045');
  console.log('   ' + dgText.replace(/\n/g, ' | '));
  expect('диагностика (текст): supplier_id 6, артикул → ключ GP45, найден, кандидат и схожесть',
    dgText.indexOf('supplier_id 6') !== -1 && dgText.indexOf('ГП000000045 → ключ GP45') !== -1 &&
    dgText.indexOf('артикул в справочнике: найден (строка 4') !== -1 && dgText.indexOf('лучший кандидат: «Круг полукопчёный, вес» (строка 4)') !== -1 &&
    dgText.indexOf('схожесть') !== -1);
  var dgNo = supplyDirDiagnoseIn_(rowsS, sups6, 'Qazmeatproduct', 'Совсем другое', 'ГП999999999');
  var dgNoText = supplyDirDiagnoseText_(dgNo, 'Qazmeatproduct', 'ГП999999999');
  expect('диагностика: артикул не найден в справочнике', dgNo.skuEntry === null && dgNoText.indexOf('не найден среди 1 записи этого поставщика') !== -1);
  var dgUnk = supplyDirDiagnoseText_(supplyDirDiagnoseIn_(rowsS, sups6, 'Новый Поставщик', 'Товар', null), 'Новый Поставщик', null);
  expect('диагностика: поставщик не определён, артикула нет',
    dgUnk.indexOf('не определён') !== -1 && dgUnk.indexOf('в документе не найден') !== -1 && dgUnk.indexOf('нет записей этого поставщика') !== -1);

  // --- Нормализация артикула ---
  expect('ключ артикула: нули и регистр букв не важны',
    supplySkuKey_('ГП000000045') === supplySkuKey_('ГП0000000045') && supplySkuKey_('ГП000000045') === supplySkuKey_('гп-000045'));
  expect('ключ артикула: кириллица = латиница (ГП = GP)', supplySkuKey_('ГП000000045') === supplySkuKey_('GP000000045'));
  expect('ключ артикула: «ГП45»', supplySkuKey_('ГП000000045') === 'GP45');
  expect('артикулы с разным числом не равны', !supplySkuEq_('ГП000000045', 'ГП000000450'));
  expect('артикулы с лишним нулём равны', supplySkuEq_('ГП000000045', 'ГП0000000045'));
  expect('пустой артикул ничему не равен', !supplySkuEq_('', ''));

  var sp = supplySplitSku_('Круг полукопчёный, вес (ГП000000045)');
  expect('артикул в скобках отделяется от названия', sp.sku === 'ГП000000045' && sp.name === 'Круг полукопчёный, вес');
  sp = supplySplitSku_('Круг полукопчёный, вес номенклатурный номер ГП000000045');
  expect('«номенклатурный номер ГП…» отделяется от названия', sp.sku === 'ГП000000045' && sp.name === 'Круг полукопчёный, вес');
  sp = supplySplitSku_('Артикул: ГП000000045 Круг полукопчёный, вес');
  expect('«Артикул: …» в начале названия', sp.sku === 'ГП000000045' && sp.name === 'Круг полукопчёный, вес');
  sp = supplySplitSku_('арт. 12345 Хлеб');
  expect('«арт. 12345»', sp.sku === '12345' && sp.name === 'Хлеб');
  expect('название без артикула не меняется',
    supplySplitSku_('РК-19 В (480шт) (Высокий)').sku === null &&
    supplySplitSku_('РК-19 В (480шт) (Высокий)').name === 'РК-19 В (480шт) (Высокий)' &&
    supplySplitSku_('Огурцы Миринда тепличные').name === 'Огурцы Миринда тепличные');
  expect('слово «артишок 12345» — не метка артикула', supplySplitSku_('артишок 12345').sku === null);
  var nrm = supplyClaudeNormalize_({ doc_type: 'invoice', items: [
    { name: 'Круг полукопчёный, вес номенклатурный номер ГП000000045', qty: 1 },
    { name: 'Хлеб', sku: 'артикул ГП0000000046', qty: 1 }] });
  expect('нормализация ответа: артикул из названия убран из названия',
    nrm.items[0].name === 'Круг полукопчёный, вес' && nrm.items[0].sku === 'ГП000000045');
  expect('нормализация ответа: «артикул …» в поле sku очищается', nrm.items[1].sku === 'ГП0000000046');

  var mm = supplyDirMatch_(rowsQ, 'Qazmeatproduct', 'Круг полукопчёный, вес', null);
  expect('название без артикула совпадает с записью, где артикул был в названии', mm.entry !== null && mm.how === 'name');
  mm = supplyDirMatch_(rowsQ, 'Qazmeatproduct', 'Кунт полукопченый вес', 'ГП0000000045');
  expect('артикул с лишним нулём находит запись по артикулу', mm.entry !== null && mm.how === 'sku');

  // --- Статистика по группе «источник + ingredient_id» ---
  function ent(rowNum, source, id, over) {
    var e = { row: rowNum, source: source, name: 'Позиция ' + rowNum, id: id, price: null, count: 0, avg: null, weight: null, synonym: false };
    Object.keys(over || {}).forEach(function (k) { e[k] = over[k]; });
    return e;
  }
  var sups = [{ key: 'магнум', id: 13 }, { key: 'magnum', id: 13 }, { key: 'татым', id: 7 }];
  var fn = supplyDirSourceKeyFn_(sups);
  var g = supplyDirApplyGroups_([
    ent(2, 'Магнум', 4, { price: 55, count: 5, avg: 9, weight: 0.1 }),
    ent(3, 'Магнум', 4, { synonym: true }),
    ent(4, 'Magnum', 4, { synonym: true }),
    ent(5, 'Татым', 4, { price: 70, count: 1, avg: 3 }),
    ent(6, 'Магнум', null),
    ent(7, 'Неизвестный', 4, { price: 9, count: 2 })
  ], fn);
  expect('синоним берёт статистику основной строки',
    g[1].statsRow === 2 && g[1].count === 5 && g[1].price === 55 && g[1].avg === 9 && g[1].weight === 0.1);
  expect('Magnum и Магнум (один supplier_id) — одна группа', g[2].statsRow === 2 && g[2].count === 5);
  expect('основная строка указывает сама на себя', g[0].statsRow === 2 && g[0].count === 5);
  expect('другой источник с тем же ингредиентом — своя статистика', g[3].statsRow === 5 && g[3].count === 1 && g[3].price === 70);
  expect('строка без ingredient_id — сама по себе', g[4].statsRow === 6 && g[4].groupKey === null);
  expect('источник вне списка поставщиков — своя группа', g[5].statsRow === 7 && g[5].count === 2);
  var g2 = supplyDirApplyGroups_([ent(2, 'Магнум', 4, { synonym: true, count: 1 }), ent(3, 'Магнум', 4, { synonym: true, count: 7 })], fn);
  expect('если все помечены синонимами, основной считается верхняя', g2[0].statsRow === 2 && g2[1].statsRow === 2 && g2[1].count === 1);

  // Единицы
  expect('единицы: «шт.» = «шт»', supplyUnitNorm_('шт.') === supplyUnitNorm_('Шт'));
  expect('единицы: «кг» ≠ «шт»', supplyUnitNorm_('кг') !== supplyUnitNorm_('шт'));

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
