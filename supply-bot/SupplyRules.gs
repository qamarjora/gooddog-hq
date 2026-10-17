/**
 * Лист «Правила сопоставления»: слово | позиция Poster | тип | объём, л (необязательно).
 * Правила для товаров по ключевым словам: если позиции нет в «Справочнике накладных», а в названии есть слово
 * из правила, позиция сопоставляется с указанной позицией Poster без вопроса владельцу. Править можно без кода.
 *
 * Порядок: «Справочник накладных» → слово-исключение → правила по порядку строк → вопрос владельцу.
 *  - тип «товар» / «ингредиент»: позиция Poster ищется в общем справочнике Poster по точному названию и виду;
 *  - тип «исключение»: правила не применяются, позиция ищется только среди ингредиентов Poster; если в справочнике
 *    её нет, бот спрашивает владельца и предлагает ингредиенты (позиция Poster пустая);
 *  - объём, л: правило действует, только если в названии указан именно такой объём (0,5 л, 500 мл); пусто — любой
 *    (у воды объём не задан: любая бутылка — «Вода», 1 бутылка = 1 шт).
 * Все товары (Вода, Напитки, Детский сок) оприходуются поштучно: режим «прямо», коэффициент 1, единица «шт».
 * Слово ищется в начале слова названия («кола» найдёт «Кока-Кола», но не «школа»); регистр и «ё» не важны.
 * Совпавшая по правилу позиция показывается в сводке с пометкой «(по правилу)»; первое совпадение
 * сохраняется в «Справочник накладных» как обычная строка (после подтверждения документа).
 */

function supplyRulesSeedRows_() {
  var rows = [['пико', 'Детский сок', 'товар', '']];
  ['вода', 'water', 'аква', 'бонаква', 'aqua', 'bonaqua'].forEach(function (w) { rows.push([w, 'Вода', 'товар', '']); });
  ['кола', 'cola', 'спрайт', 'sprite', 'фанта', 'fanta', 'фьюсти', 'fuze', 'лимонад', 'газиров', 'энергетик']
    .forEach(function (w) { rows.push([w, 'Напитки', 'товар', '']); });
  rows.push(['швепс', '', 'исключение', '']);
  rows.push(['schweppes', '', 'исключение', '']);
  return rows;
}

function supplyRulesSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CONST.SHEET_RULES);
  if (sh) return sh;
  sh = ss.insertSheet(SUPPLY_CONST.SHEET_RULES);
  sh.getRange(1, 1, 1, 4).setValues([['слово', 'позиция Poster', 'тип (товар / ингредиент / исключение)', 'объём, л (необязательно)']]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('A:D').setNumberFormat('@');
  var seed = supplyRulesSeedRows_();
  sh.getRange(2, 1, seed.length, 4).setValues(seed);
  sh.setColumnWidth(1, 160);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(3, 220);
  sh.setColumnWidth(4, 180);
  return sh;
}

/** Правила листа: [{row, word (нормализованное), target, type: 'товар'|'ингредиент'|'исключение', volume: число|null}]. */
function supplyRulesLoad_() {
  var sh = supplyRulesSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  sh.getRange(2, 1, last - 1, 4).getValues().forEach(function (r, i) {
    var word = supplyNormName_(r[0]);
    if (!word) return;
    var t = String(r[2] || '').trim().toLowerCase();
    var type = t.indexOf('исключ') === 0 ? 'исключение' : (t === 'ингредиент' ? 'ингредиент' : (t === 'товар' ? 'товар' : ''));
    if (!type) return;
    out.push({ row: i + 2, word: word, target: String(r[1] || '').trim(), type: type, volume: supplyNum_(r[3]) });
  });
  return out;
}

/**
 * Разовый запуск для листа, созданного прежней версией: у правил с позицией «Вода» убирает условие «объём 0,5»
 * (вода любого объёма, 1 бутылка = 1 шт). Остальные строки не трогает.
 */
function supplyRulesFixWater() {
  var sh = supplyRulesSheet_();
  var last = sh.getLastRow();
  var fixed = 0;
  for (var r = 2; r <= last; r++) {
    var target = String(sh.getRange(r, 2).getValue()).trim().toLowerCase();
    var vol = String(sh.getRange(r, 4).getValue()).trim();
    if (target === 'вода' && vol !== '') {
      sh.getRange(r, 4).setValue('');
      fixed++;
    }
  }
  console.log('Правил для «Вода» очищено от условия по объёму: ' + fixed);
}

/** Объём в литрах из названия («0,5 л», «500 мл», «1.5л») или null. */
function supplyVolumeLiters_(name) {
  var s = supplyNormName_(name);
  var m = s.match(/(\d+(?:\.\d+)?)\s*(?:мл|ml)(?![a-zа-я])/);
  if (m) return Number(m[1]) / 1000;
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:л|l|литр[а-я]*)(?![a-zа-я0-9])/);
  return m ? Number(m[1]) : null;
}

/**
 * Объём без единицы в названии («Аква Минерале 0,5»): последнее десятичное число не больше 10, не процент («3,2%»).
 * Используется только когда единицы нет и правило требует объём.
 */
function supplyBareVolumeLiters_(name) {
  var s = supplyNormName_(name);
  var re = /(\d+\.\d+)(?![0-9])(?!\s*%)/g;
  var m, last = null;
  while ((m = re.exec(s)) !== null) last = Number(m[1]);
  return last !== null && last <= 10 ? last : null;
}

function supplyRuleWordMatch_(nameKey, word) {
  var esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-zа-я0-9])' + esc).test(nameKey);
}

/**
 * Применение правил к названию позиции (чистая функция). getCatalog() вызывается только при совпадении слова.
 * Возвращает null (правил нет) или
 *  {kind: 'exception', word}                      — исключение: правила для товаров не применяются;
 *  {kind: 'rule', word, target (запись справочника Poster), rule} — позиция найдена;
 *  {kind: 'rule-missing', word, targetName, type} — слово совпало, но такой позиции в справочнике Poster нет.
 */
function supplyRulesMatch_(rules, name, getCatalog) {
  var nk = supplyNormName_(name);
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].type === 'исключение' && supplyRuleWordMatch_(nk, rules[i].word)) {
      return { kind: 'exception', word: rules[i].word };
    }
  }
  var vol = supplyVolumeLiters_(name);
  if (vol === null) vol = supplyBareVolumeLiters_(name);
  var missing = null;
  for (var j = 0; j < rules.length; j++) {
    var r = rules[j];
    if (r.type === 'исключение' || !supplyRuleWordMatch_(nk, r.word)) continue;
    if (r.volume !== null && (vol === null || Math.abs(vol - r.volume) > 0.0005)) continue;
    var tkey = supplyNormName_(r.target);
    var target = getCatalog().filter(function (x) { return x.kind === r.type && x.key === tkey; })[0];
    if (target) return { kind: 'rule', word: r.word, target: target, rule: r };
    if (!missing) missing = { kind: 'rule-missing', word: r.word, targetName: r.target, type: r.type };
  }
  return missing;
}

/** Запись справочника из позиции Poster, найденной по правилу (до сохранения строка справочника ещё не создана: row = null). */
function supplyRuleEntry_(target, item, source) {
  return {
    row: null, source: source, name: item.name, id: target.id, posterName: target.name, unit: target.unit,
    mode: SUPPLY_CONST.MODE_DIRECT, coef: 1, weight: null, price: null, count: 0, avg: null,
    sku: item.sku || '', ptype: target.kind, synonym: false, statsRow: null
  };
}

/**
 * Что делать с позицией, которой нет в справочнике (чистая функция):
 * {entry, rule, onlyIngredients, exceptionWord}. m — результат supplyDirMatch_; forceAsk — сотрудник отметил, что
 * сопоставление по правилу неверно. Если справочник нашёл позицию или предложил кандидатов — правила не применяются.
 */
function supplyResolveItemEntry_(m, item, source, forceAsk, rules, getCatalog) {
  var none = { entry: null, rule: null, onlyIngredients: false, exceptionWord: '' };
  if (m.entry) return { entry: m.entry, rule: null, onlyIngredients: false, exceptionWord: '' };
  if (m.candidates && m.candidates.length) return none;

  var res = supplyRulesMatch_(rules, item.name, getCatalog);
  if (!res) return none;
  if (res.kind === 'exception') return { entry: null, rule: null, onlyIngredients: true, exceptionWord: res.word };
  if (res.kind === 'rule' && !forceAsk) {
    return {
      entry: supplyRuleEntry_(res.target, item, source),
      rule: { word: res.word, targetName: res.target.name, kind: res.target.kind },
      onlyIngredients: false, exceptionWord: ''
    };
  }
  if (res.kind === 'rule-missing') {
    console.warn('Правило «' + res.word + '» → «' + res.targetName + '» (' + res.type + '): такой позиции нет в справочнике Poster');
  }
  return none;
}

/** Сохраняет в «Справочник накладных» позиции, сопоставленные по правилам (первое совпадение). Обновляет l.entry.row. */
function supplySaveRuleLines_(st) {
  st.match.lines.forEach(function (l) {
    if (!l.rule || !l.entry || l.entry.row) return;
    var row = supplyDirUpsert_({
      source: st.doc.source, name: l.docName, id: l.entry.id, posterName: l.entry.posterName, unit: l.entry.unit,
      mode: SUPPLY_CONST.MODE_DIRECT, coef: 1, ptype: l.entry.ptype, sku: l.sku || undefined
    });
    l.entry.row = row;
  });
}

// ---------------------------------------------------------------------------
// Самотест: товары Poster и правила
// ---------------------------------------------------------------------------

/** Справочник Poster (ингредиенты + товары), тип в createSupply, правила по ключевым словам. Запуск вручную. */
function supplyProductsSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }

  // --- Справочник Poster: ингредиенты + товары ---
  var rawIng = [
    { ingredient_id: '10', ingredient_name: 'молоко', ingredient_unit: 'l', ingredients_type: '1', delete: '0' },
    { ingredient_id: '11', ingredient_name: 'старое', ingredient_unit: 'kg', ingredients_type: '1', delete: '1' },
    { ingredient_id: '12', ingredient_name: 'системный', ingredient_unit: 'kg', ingredients_type: '2', delete: '0' }];
  var rawProd = [
    { product_id: '10', product_name: 'Coca-Cola 0,5', type: '3', unit: '', weight_flag: '0' },
    { product_id: '20', product_name: 'Напитки', type: '3', unit: '', weight_flag: '0' },
    { product_id: '21', product_name: 'Детский сок', type: '3', unit: 'p', weight_flag: '0' },
    { product_id: '22', product_name: 'Вода', type: '3', unit: '', weight_flag: '0' },
    { product_id: '30', product_name: 'Бургер', type: '2', unit: 'kg', weight_flag: '0' },
    { product_id: '31', product_name: 'Заготовка', type: '1', unit: '', weight_flag: '0' },
    { product_id: '40', product_name: 'Конфеты на развес', type: '3', unit: '', weight_flag: '1' }];
  var cat = supplyPosterBuildCatalog_(rawIng, rawProd);
  expect('справочник: ингредиенты без удалённых и системных + только товары (type=3)',
    cat.length === 1 + 5 && cat.filter(function (x) { return x.kind === 'ингредиент'; }).length === 1 &&
    cat.filter(function (x) { return x.kind === 'товар'; }).length === 5);
  expect('справочник: блюдо с техкартой (type=2) и полуфабрикат (type=1) не попадают',
    !cat.some(function (x) { return x.name === 'Бургер' || x.name === 'Заготовка'; }));
  expect('id ингредиента и товара могут совпадать — различаются по uid (i10 / p10)',
    cat.filter(function (x) { return x.id === 10; }).map(function (x) { return x.uid; }).sort().join() === 'i10,p10');
  expect('единица товара всегда «шт» (в том числе весовой и с единицей в Poster): товары оприходуются поштучно',
    supplyPosterCatalogById_('товар', 10, cat).unit === 'шт' && supplyPosterCatalogById_('товар', 40, cat).unit === 'шт' &&
    supplyPosterCatalogById_('товар', 21, cat).unit === 'шт' && supplyPosterCatalogById_('ингредиент', 10, cat).unit === 'л');
  expect('поиск по виду и id', supplyPosterCatalogById_('товар', 10, cat).name === 'Coca-Cola 0,5' &&
    supplyPosterCatalogById_('', 10, cat).name === 'молоко' && supplyPosterCatalogFind_('p20', cat).name === 'Напитки');

  // --- Поиск находит Coca-Cola среди товаров, с пометкой вида ---
  var found = supplySuggestIn_(cat, 'Coca-Cola 0,5 л', 5);
  expect('поиск «Coca-Cola 0,5 л» находит товар «Coca-Cola 0,5» первым', found.length > 0 && found[0].name === 'Coca-Cola 0,5' && found[0].kind === 'товар' && found[0].uid === 'p10');
  expect('поиск только среди ингредиентов не находит товар',
    supplySuggestIn_(cat, 'Coca-Cola 0,5 л', 5, { onlyKind: 'ингредиент' }).length === 0);
  expect('пометки вида: «(товар)» и «(ингредиент)»', supplyKindMark_('товар') === '(товар)' && supplyKindMark_('ингредиент') === '(ингредиент)' && supplyKindMark_(undefined) === '(ингредиент)');

  // --- Колонка «тип в Poster»: пусто = ингредиент ---
  expect('тип в справочнике: пусто и неизвестное = ингредиент, «Товар» = товар',
    supplyNormPtype_('') === 'ингредиент' && supplyNormPtype_(undefined) === 'ингредиент' && supplyNormPtype_('Товар ') === 'товар' && supplyNormPtype_('x') === 'ингредиент');

  // --- Тип в payload ---
  function line(n, name, id, ptype, qty, sum, unit) {
    var item = { name: name, qty: qty, unit: unit || 'шт', price: sum / qty, sum: sum, sku: null };
    var entry = { row: n + 3, id: id, posterName: name, unit: unit || 'шт', mode: 'прямо', coef: 1, weight: null, price: null, count: 0, avg: null, sku: '' };
    if (ptype !== undefined) entry.ptype = ptype;
    return supplyMatchBuildLine_(n, item, entry);
  }
  function stateOf(lines, total) {
    return { chatId: '1', doc: { source: 'Магнум', doc_type: 'receipt', doc_number: '1', datetime: 'x', total: total, items: lines.map(function (l) { return l.item; }) },
             match: { supplier: { id: 13, name: 'Магнум' }, lines: lines }, file: { uniqueId: 'U' } };
  }
  var stMix = stateOf([line(1, 'Молоко', 10, 'ингредиент', 9, 500, 'л'), line(2, 'Напитки', 20, 'товар', 24, 7488)], 7988);
  var planMix = supplyBuildSupplyPlan_(stMix, '2026-10-10 12:00:00', 1);
  expect('поставка с ингредиентом и товаром: type ингредиента 4, type товара 1 (по документации Poster)',
    planMix.payload.ingredient[0].type === 4 && planMix.payload.ingredient[1].type === 1 &&
    planMix.payload.ingredient[0].id === 10 && planMix.payload.ingredient[1].id === 20);
  expect('настройка SUPPLY_POSTER_PRODUCT_TYPE подставляется для товаров, ингредиент остаётся 4',
    supplyBuildSupplyPlan_(stMix, 'x', 1, false, 7).payload.ingredient.map(function (x) { return x.type; }).join() === '4,7');
  var stOld = stateOf([line(1, 'Молоко', 10, undefined, 9, 500, 'л')], 500);
  expect('старая строка без типа остаётся ингредиентом (type 4)', supplyBuildSupplyPlan_(stOld, 'x', 1).payload.ingredient[0].type === 4);
  expect('единицы и цена как раньше: товар 24 шт на 7488 ₸ → цена 312',
    planMix.payload.ingredient[1].num === 24 && planMix.payload.ingredient[1].sum === 312);
  expect('plan.mixed и разбиение по типам: товары и ингредиенты в разных поставках одного поставщика',
    planMix.mixed === true && supplyPlanPayloadFor_(planMix, 'товар').ingredient.length === 1 &&
    supplyPlanPayloadFor_(planMix, 'ингредиент').ingredient[0].id === 10 &&
    supplyPlanPayloadFor_(planMix, 'товар').supply.supplier_id === 13 && supplyPlanPayloadFor_(planMix, 'all') === planMix.payload &&
    stOld && supplyBuildSupplyPlan_(stOld, 'x', 1).mixed === false);
  var txtMix = supplyDryRunOwnerText_(stMix, planMix, 1, false);
  expect('«Оприходовал бы»: у товара пометка «(товар)», у ингредиента нет',
    txtMix.indexOf('2. Напитки (товар) — 24 шт') !== -1 && txtMix.indexOf('1. Молоко —') !== -1 && txtMix.indexOf('Молоко (товар)') === -1);
  expect('«Оприходовал бы»: про смешанную поставку и автоматическое разделение при отказе Poster',
    txtMix.indexOf('одной поставкой') !== -1 && txtMix.indexOf('автоматически') !== -1);
  var txtSplit = supplyDryRunOwnerText_(stMix, planMix, 1, true);
  expect('«Оприходовал бы» при SUPPLY_POSTER_SPLIT_BY_TYPE: две поставки, товары и ингредиенты отдельно',
    txtSplit.indexOf('две поставки') !== -1 && txtSplit.indexOf('Поставка 1 — товары') !== -1 && txtSplit.indexOf('Поставка 2 — ингредиенты') !== -1);

  // --- Правила по ключевым словам ---
  var rules = supplyRulesSeedRows_().map(function (r, i) {
    var t = r[2];
    return { row: i + 2, word: supplyNormName_(r[0]), target: r[1], type: t, volume: supplyNum_(r[3]) };
  });
  var catalog = cat;
  function rule(name) { return supplyRulesMatch_(rules, name, function () { return catalog; }); }
  expect('объём из названия: 0,5 л, 500 мл, 1.5л, 0,2 литра; без объёма — null',
    supplyVolumeLiters_('Вода 0,5 л') === 0.5 && supplyVolumeLiters_('Вода 500 мл') === 0.5 && supplyVolumeLiters_('Cola 1.5л') === 1.5 &&
    supplyVolumeLiters_('Сок 0,2 литра') === 0.2 && supplyVolumeLiters_('Лимоны 5 лимонов') === null);
  expect('«кола» → товар «Напитки» (Coca-Cola, Кока-Кола, Pepsi Cola, любой объём)',
    rule('Coca-Cola 0,5 л').target.name === 'Напитки' && rule('Кока-Кола 1 л').target.kind === 'товар' && rule('Pepsi Cola 2 л').target.name === 'Напитки');
  expect('«спрайт/sprite/фанта/fanta/фьюсти/fuze/лимонад/газиров/энергетик» → «Напитки»',
    ['Sprite 0,5', 'Спрайт 1 л', 'Fanta апельсин', 'Фанта', 'Фьюсти чай', 'Fuze Tea', 'Лимонад Дюшес', 'Напиток газированный', 'Энергетик Flash'].every(function (n) {
      var r = rule(n); return r && r.kind === 'rule' && r.target.name === 'Напитки'; }));
  expect('«пико» → товар «Детский сок»', rule('Сок Пико яблоко 0,2 л').target.name === 'Детский сок');
  expect('вода любого объёма → товар «Вода» (water, аква, бонаква)',
    ['Вода питьевая 0,5 л', 'Water 500 мл', 'Аква Минерале 0,5', 'BonAqua 0,5 л', 'БонАква 0,5л', 'Вода 1,5 л', 'Вода питьевая', 'Aqua 5 л'].every(function (n) {
      var r = rule(n); return r && r.kind === 'rule' && r.target.name === 'Вода'; }));
  expect('условие по объёму остаётся рабочим для любых правил с заполненной колонкой «объём, л»', (function () {
    var vr = [{ row: 2, word: 'тест', target: 'Вода', type: 'товар', volume: 0.5 }];
    function t(n) { return supplyRulesMatch_(vr, n, function () { return catalog; }); }
    return t('Тест 0,5 л').kind === 'rule' && t('Тест 1,5 л') === null && t('Тест') === null;
  })());
  expect('в стартовых правилах у воды объём не задан (любой), у остальных тоже',
    supplyRulesSeedRows_().every(function (r) { return r[3] === ''; }));
  expect('сок 1 л (апельсин, вишня) — правило не применяется, спрашиваем владельца',
    rule('Сок апельсиновый 1 л') === null && rule('Сок вишнёвый 1 л') === null);
  expect('объём без единицы: «0,5» — литры; процент жирности («3,2%») и целые числа не считаются',
    supplyBareVolumeLiters_('Аква Минерале 0,5') === 0.5 && supplyBareVolumeLiters_('Молоко 3,2%') === null && supplyBareVolumeLiters_('Вода 5 шт') === null);
  expect('слово ищется с начала слова («школа» не «кола»)', rule('Школа 5 шт') === null);

  // Исключения: швепс / schweppes
  var ex1 = rule('Швепс тоник 0,33 л'), ex2 = rule('Schweppes Mojito 0,5'), ex3 = rule('Schweppes Cola 0,5 л');
  expect('«швепс» и «schweppes» — исключения (правила для товаров не применяются)',
    ex1.kind === 'exception' && ex2.kind === 'exception');
  expect('исключение проверяется раньше правил: «Schweppes Cola» тоже исключение, не «Напитки»', ex3.kind === 'exception');

  // Порядок: справочник → исключение → правила → владелец
  var itemCola = { name: 'Coca-Cola 0,5 л', sku: null, qty: 1 };
  var dirHit = { entry: { row: 9, id: 1, posterName: 'другое', ptype: 'ингредиент' }, candidates: [] };
  var none = { entry: null, candidates: [] };
  function resolve(m, item, forceAsk) { return supplyResolveItemEntry_(m, item, 'Магнум', forceAsk, rules, function () { return catalog; }); }
  expect('справочник важнее правил: позиция из справочника не заменяется', resolve(dirHit, itemCola).entry.row === 9 && resolve(dirHit, itemCola).rule === null);
  var rv = resolve(none, itemCola);
  expect('позиции нет в справочнике — правило подставляет товар «Напитки» (по правилу, без вопроса владельцу)',
    rv.entry && rv.entry.posterName === 'Напитки' && rv.entry.ptype === 'товар' && rv.entry.id === 20 && rv.entry.mode === 'прямо' &&
    rv.entry.row === null && rv.rule.word === 'cola');
  var rvEx = resolve(none, { name: 'Швепс тоник 0,5 л' });
  expect('«швепс» не в справочнике: entry нет, только ингредиенты, владельцу предложат список ингредиентов',
    rvEx.entry === null && rvEx.onlyIngredients === true && rvEx.exceptionWord === 'швепс');
  expect('кандидаты справочника (сомнение) — правила не применяются', resolve({ entry: null, candidates: [{ row: 5 }] }, itemCola).entry === null);
  expect('сотрудник отметил «другое» — правило не применяется', resolve(none, itemCola, true).entry === null);
  expect('нет правила — как раньше (вопрос владельцу)', resolve(none, { name: 'Хлеб белый' }).entry === null && resolve(none, { name: 'Хлеб белый' }).onlyIngredients === false);
  var rvMiss = supplyResolveItemEntry_(none, itemCola, 'Магнум', false, rules, function () { return []; });
  expect('позиции из правила нет в Poster — вопрос владельцу, без падения', rvMiss.entry === null);

  // Товары всегда «прямо», коэффициент 1, шт — даже если в справочнике записано иначе
  var oddProd = { row: 3, id: 22, posterName: 'Вода', unit: 'л', mode: 'коэффициент', coef: 0.5, ptype: 'товар', weight: null, price: null, count: 0, avg: null, sku: '' };
  var oddLine = supplyMatchBuildLine_(1, { name: 'BonAqua 0,5 л', qty: 24, unit: 'шт', price: 120, sum: 2880 }, oddProd);
  expect('товар в режиме «коэффициент» в справочнике всё равно считается «прямо»: 24 бутылки = 24 шт (без пересчёта в литры)',
    oddLine.status === 'ready' && oddLine.qtyWh === 24 && oddLine.unit === 'шт' && oddLine.unitPriceWh === 120);
  var pcsProd = supplyMatchBuildLine_(1, { name: 'Вода', qty: 5, unit: 'шт', price: 1, sum: 5 }, Object.assign({}, oddProd, { mode: 'ввод штук' }));
  expect('товар в режиме «ввод штук» тоже «прямо» (вопроса про штуки нет)', pcsProd.status === 'ready' && pcsProd.qtyWh === 5);
  expect('режим «пропускать» у товара сохраняется',
    supplyMatchBuildLine_(1, { name: 'Вода', qty: 1, unit: 'шт', price: 1, sum: 1 }, Object.assign({}, oddProd, { mode: 'пропускать' })).status === 'skip');

  // Строка сопоставления и сводка
  var ruleLine = supplyMatchBuildLine_(1, { name: 'Coca-Cola 0,5 л', qty: 24, unit: 'шт', price: 312, sum: 7488 }, rv.entry, undefined, [],
    { rule: rv.rule });
  expect('строка по правилу готова (режим «прямо», 24 шт), в сводке «(по правилу)»',
    ruleLine.status === 'ready' && ruleLine.qtyWh === 24 && ruleLine.rule.word === 'cola' &&
    supplySummaryText_({ doc: { source: 'Магнум', doc_type: 'receipt', total: 7488, items: [] }, match: { lines: [ruleLine] }, dupWarn: '' }).indexOf('Напитки — 24 шт (по правилу)') !== -1);
  expect('строка исключения несёт признак «только ингредиенты»',
    supplyMatchBuildLine_(1, { name: 'Швепс', qty: 1, unit: 'шт', price: 1, sum: 1 }, null, undefined, [], { onlyIngredients: true, exceptionWord: 'швепс' }).onlyIngredients === true);
  expect('сохранение правила в справочник один раз: row проставляется, повторно не создаётся', (function () {
    return ruleLine.entry.row === null && typeof supplySaveRuleLines_ === 'function';
  })());

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
