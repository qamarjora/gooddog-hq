/**
 * Лист «Справочник накладных». Ведёт бот; пользователь открывает только при ошибке.
 * Все функции вызываются под замком (из supplyPoll / webhook) либо вручную из редактора.
 *
 * Колонки:
 *  A источник | B название в документе | C ingredient_id | D название в Poster | E единица склада |
 *  F режим (прямо / коэффициент / ввод штук / пропускать) | G коэффициент | H вес на штуку |
 *  I последняя цена (за единицу склада) | J принято поставок | K среднее кол-во (в единицах склада) |
 *  L артикул | M синоним (непусто = эта строка только указывает на основную, см. ниже) |
 *  N тип в Poster (ингредиент / товар; пусто = ингредиент: в C стоит id ингредиента или id товара)
 *
 * Статистика (I, H, J, K) хранится один раз на ключ «источник + ingredient_id» в основной строке
 * (самая верхняя строка группы без пометки «синоним»). Источник — это поставщик с листа «Поставщики»
 * (Магнум и Magnum — один), а если его там нет, нормализованное название источника.
 * Строки-синонимы (другое написание названия того же товара) статистику не хранят: при чтении
 * они берут значения основной строки, при записи пишется в основную.
 *
 * Записи сопоставляются с документом по поставщику: источник документа и источник строки справочника приводятся
 * к supplier_id через лист «Поставщики» (с нечётким сопоставлением, поэтому опечатка в названии источника не мешает).
 * Если supplier_id не определён хотя бы у одной стороны, источники сравниваются по тексту.
 *
 * Порядок сопоставления позиции документа (supplyDirMatch_):
 *  1) артикул (нормализованный) в пределах поставщика; 2) точное название (без артикула в тексте);
 *  3) нечёткое название (схожесть ≥ FUZZY_MIN).
 *  Нечёткое совпадение считается уверенным только при единственном кандидате.
 *  Запись с другим артикулом по названию не сопоставляется (это другой товар).
 */

var SUPPLY_DIR_COL = {
  SOURCE: 1, NAME: 2, ID: 3, PNAME: 4, UNIT: 5, MODE: 6,
  COEF: 7, WEIGHT: 8, PRICE: 9, COUNT: 10, AVG: 11, SKU: 12, SYN: 13, PTYPE: 14
};
var SUPPLY_DIR_WIDTH = 14;

function supplyDirSeedRows_() {
  return [
    ['DidarPlast', 'РК-19 В (480шт) (Высокий)', '', 'бокс для хот-дога', 'шт', 'прямо', 1, '', '', 0, '', '', '', ''],
    ['ИП «Татым»', 'Хот-дог премиум 0,100', '', 'булочка для хот-дога', 'шт', 'прямо', 1, '', '', 0, '', '', '', ''],
    ['Qazmeatproduct Astana', 'Круг полукопчёный, вес', '', 'сосиски', 'шт', 'ввод штук', '', '', '', 0, '', 'ГП000000045', '', ''],
    ['Магнум', 'Молоко Зенченко пастеризованное 3,2% 0,9 л', '', 'молоко', 'л', 'коэффициент', 0.9, '', '', 0, '', '', '', ''],
    ['Магнум', 'Огурцы Миринда тепличные', '', 'огурцы', 'кг', 'прямо', 1, '', '', 0, '', '', '', ''],
    ['Магнум', 'Томаты розовые', '', 'томаты', 'кг', 'прямо', 1, '', '', 0, '', '', '', '']
  ];
}

/** Лист справочника; при первом обращении создаётся с шапкой и стартовыми строками, старый лист донастраивается. */
function supplyDirSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CONST.SHEET_DIR);
  if (sh) {
    supplyDirMigrate_(sh);
    return sh;
  }

  sh = ss.insertSheet(SUPPLY_CONST.SHEET_DIR);
  var header = [[
    'источник (поставщик/магазин)', 'название в документе', 'ingredient_id', 'название в Poster',
    'единица склада', 'режим', 'коэффициент', 'вес на штуку', 'последняя цена (за ед. склада)',
    'принято поставок', 'среднее кол-во', 'артикул', 'синоним (указывает на основную строку)', 'тип в Poster'
  ]];
  sh.getRange(1, 1, 1, SUPPLY_DIR_WIDTH).setValues(header).setFontWeight('bold');
  sh.setFrozenRows(1);

  sh.getRange('A:B').setNumberFormat('@');
  sh.getRange('L:N').setNumberFormat('@');
  var seed = supplyDirSeedRows_();
  sh.getRange(2, 1, seed.length, SUPPLY_DIR_WIDTH).setValues(seed);

  var modes = [SUPPLY_CONST.MODE_DIRECT, SUPPLY_CONST.MODE_COEF, SUPPLY_CONST.MODE_PIECES, SUPPLY_CONST.MODE_SKIP,
    SUPPLY_CONST.MODE_ASK_PACK, SUPPLY_CONST.MODE_ASK_QTY, SUPPLY_CONST.MODE_JARS];
  sh.getRange(2, SUPPLY_DIR_COL.MODE, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(modes, true).setAllowInvalid(true).build());

  sh.setColumnWidth(1, 190);
  sh.setColumnWidth(2, 330);
  sh.setColumnWidth(4, 200);
  sh.setColumnWidth(12, 140);
  sh.setColumnWidth(13, 220);
  sh.setColumnWidth(14, 120);
  return sh;
}

/**
 * Старый лист -> добавляет недостающие колонки «артикул» (L) и «синоним» (M).
 * Артикул заполняется там, где он указан в названии («… (ГП000000045)»).
 */
function supplyDirMigrate_(sh) {
  if (String(sh.getRange(1, SUPPLY_DIR_COL.SKU).getValue()) === '') {
    sh.getRange(1, SUPPLY_DIR_COL.SKU).setValue('артикул').setFontWeight('bold');
    sh.getRange('L:L').setNumberFormat('@');
    sh.setColumnWidth(SUPPLY_DIR_COL.SKU, 140);

    var last = sh.getLastRow();
    if (last >= 2) {
      var names = sh.getRange(2, SUPPLY_DIR_COL.NAME, last - 1, 1).getValues();
      var skus = names.map(function (r) { return [supplyExtractSku_(r[0]) || '']; });
      sh.getRange(2, SUPPLY_DIR_COL.SKU, last - 1, 1).setValues(skus);
    }
  }
  if (String(sh.getRange(1, SUPPLY_DIR_COL.SYN).getValue()) === '') {
    sh.getRange(1, SUPPLY_DIR_COL.SYN).setValue('синоним (указывает на основную строку)').setFontWeight('bold');
    sh.getRange('M:M').setNumberFormat('@');
    sh.setColumnWidth(SUPPLY_DIR_COL.SYN, 220);
  }
  if (String(sh.getRange(1, SUPPLY_DIR_COL.PTYPE).getValue()) === '') {
    // Старые строки: пусто = ингредиент.
    sh.getRange(1, SUPPLY_DIR_COL.PTYPE).setValue('тип в Poster').setFontWeight('bold');
    sh.getRange('N:N').setNumberFormat('@');
    sh.setColumnWidth(SUPPLY_DIR_COL.PTYPE, 120);
  }
}

// ---------------------------------------------------------------------------
// Нормализация
// ---------------------------------------------------------------------------

/** Название позиции: регистр, ё, кавычки, пробелы, десятичная запятая («0,9» = «0.9»). */
function supplyNormName_(s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`“”„]/g, '')
    .replace(/[ \s]+/g, ' ')
    .replace(/(\d),(\d)/g, '$1.$2')
    .trim();
}

/**
 * Источник: без организационно-правовой формы (ИП/ТОО/ООО/«Товарищество с ограниченной ответственностью…»),
 * кавычек и знаков препинания. «ТОО "QAZMEATPRODUCT ASTANA"» и
 * «Товарищество с ограниченной ответственностью "QAZMEATPRODUCT ASTANA"» дают одно значение.
 */
function supplyNormSource_(s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(товарищество|общество)\s+с\s+ограниченной\s+ответственностью/g, ' ')
    .replace(/индивидуальный\s+предприниматель/g, ' ')
    .replace(/акционерное\s+общество/g, ' ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .split(' ')
    .filter(function (t) { return t && ['ип', 'тоо', 'ооо', 'ао', 'llp', 'ltd'].indexOf(t) === -1; })
    .join(' ');
}

/** Источники считаем одинаковыми при равенстве или когда один содержит другой («Qazmeatproduct» ⊂ «Qazmeatproduct Astana»). */
function supplySourceMatch_(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 4 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
}

// ---------------------------------------------------------------------------
// Артикул
// ---------------------------------------------------------------------------

// «номенклатурный номер ГП…», «артикул: ГП…», «арт. ГП…», «код товара ГП…» (метка + код из ≥4 цифр).
var SUPPLY_SKU_LABEL_RE =
  /(^|[\s,;(])(?:номенклатурн[а-яё]*(?:\s+номер)?|артикул[а-яё]*|арт\.?|код(?:\s+товара)?)\s*[:№#.\-]*\s*\(?\s*([A-Za-zА-Яа-яЁё]{0,4}\d{4,})\s*\)?/i;
// Артикул в скобках: «(ГП000000045)»; «(480шт)» — не артикул.
var SUPPLY_SKU_PAREN_RE = /\(\s*([A-Za-zА-Яа-яЁё]{0,4}\d{5,})\s*\)/;

/**
 * Отделяет артикул от названия, если модель положила его в название.
 * Возвращает {name: название без артикула, sku: артикул или null}.
 */
function supplySplitSku_(name) {
  var original = String(name === null || name === undefined ? '' : name);
  var s = original;
  var sku = null;

  var m = s.match(SUPPLY_SKU_LABEL_RE);
  if (m) {
    sku = m[2];
    s = s.replace(m[0], ' ');
  } else {
    m = s.match(SUPPLY_SKU_PAREN_RE);
    if (m) {
      sku = m[1];
      s = s.replace(m[0], ' ');
    }
  }
  s = s.replace(/\s+/g, ' ').replace(/\s+([,;.])/g, '$1').replace(/[\s,;:\-–—(]+$/, '').trim();
  return { name: s || original.trim(), sku: sku };
}

/** Артикул из названия (для миграции и подстраховки) или null. */
function supplyExtractSku_(name) {
  return supplySplitSku_(name).sku;
}

/** Ключ названия для сопоставления: без артикула в тексте, нормализованный. */
function supplyNameKey_(name) {
  return supplyNormName_(supplySplitSku_(name).name);
}

var SUPPLY_CYR_TO_LAT = {
  'А': 'A', 'Б': 'B', 'В': 'B', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ж': 'J', 'З': 'Z', 'И': 'I', 'Й': 'I',
  'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'H', 'О': 'O', 'П': 'P', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y',
  'Ф': 'F', 'Х': 'X', 'Ц': 'C', 'Ч': 'C', 'Ш': 'S', 'Щ': 'S', 'Ы': 'Y', 'Ь': '', 'Ъ': '', 'Э': 'E',
  'Ю': 'U', 'Я': 'A'
};

/**
 * Ключ артикула: верхний регистр, только буквы и цифры, кириллица приравнена к латинице
 * (ГП = GP), ведущие нули после букв и в начале убраны: ГП000000045 = ГП0000000045 = GP45.
 */
function supplySkuKey_(sku) {
  var s = String(sku === null || sku === undefined ? '' : sku).toUpperCase().replace(/Ё/g, 'Е')
    .replace(/[^A-ZА-Я0-9]/g, '');
  s = s.replace(/[А-Я]/g, function (c) { return SUPPLY_CYR_TO_LAT[c] !== undefined ? SUPPLY_CYR_TO_LAT[c] : c; });
  s = s.replace(/([A-Z])0+(?=\d)/g, '$1');
  return s.replace(/^0+(?=\d)/, '');
}

/** Артикулы совпадают, если равны их ключи (см. supplySkuKey_). */
function supplySkuEq_(a, b) {
  var ka = supplySkuKey_(a);
  var kb = supplySkuKey_(b);
  return ka !== '' && ka === kb;
}

// ---------------------------------------------------------------------------
// Нечёткое сравнение названий
// ---------------------------------------------------------------------------

/** Название для нечёткого сравнения: без артикула и знаков препинания. */
function supplyFuzzyKey_(name) {
  return supplyNormName_(supplySplitSku_(name).name)
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function supplyLevenshtein_(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var prev = [];
  var i, j;
  for (j = 0; j <= b.length; j++) prev.push(j);
  for (i = 1; i <= a.length; i++) {
    var cur = [i];
    for (j = 1; j <= b.length; j++) {
      var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Схожесть по символам 0..1 (1 — одинаковые) после supplyFuzzyKey_. */
function supplySimilarity_(a, b) {
  var ka = supplyFuzzyKey_(a);
  var kb = supplyFuzzyKey_(b);
  if (ka.length < 4 || kb.length < 4) return ka === kb && ka.length > 0 ? 1 : 0;
  return 1 - supplyLevenshtein_(ka, kb) / Math.max(ka.length, kb.length);
}

// ---------------------------------------------------------------------------
// Группы статистики («источник + ingredient_id») и синонимы
// ---------------------------------------------------------------------------

/**
 * Функция «источник -> идентификатор источника» для групп статистики.
 * sups — список листа «Поставщики» ([{key, id, ...}]): Магнум и Magnum с одним supplier_id дают один источник.
 */
function supplyDirSourceKeyFn_(sups) {
  return function (source) {
    var s = supplySupplierFindIn_(sups, source);
    return s ? 's' + s.id : 'n:' + supplyNormSource_(source);
  };
}

/**
 * Проставляет группам статистику основной строки.
 * Основная строка группы — самая верхняя без пометки «синоним» (если все помечены — самая верхняя).
 * Каждой записи добавляются groupKey и statsRow (строка, где хранится статистика); у синонимов
 * price, count, avg, weight заменяются значениями основной строки. entries — в порядке строк.
 */
function supplyDirApplyGroups_(entries, keyFn) {
  var groups = {};
  entries.forEach(function (e) {
    e.groupKey = e.id ? keyFn(e.source) + '|' + (e.ptype === 'товар' ? 'p' : 'i') + e.id : null; // id ингредиента и товара — разные пространства
    e.statsRow = e.row;
    if (e.groupKey) {
      if (!groups[e.groupKey]) groups[e.groupKey] = [];
      groups[e.groupKey].push(e);
    }
  });
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    var main = g.filter(function (e) { return !e.synonym; })[0] || g[0];
    g.forEach(function (e) {
      e.statsRow = main.row;
      if (e !== main) {
        e.price = main.price;
        e.count = main.count;
        e.avg = main.avg;
        e.weight = main.weight;
      }
    });
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

/** Тип в Poster: «товар» или «ингредиент» (пусто и всё остальное = ингредиент). */
function supplyNormPtype_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase() === 'товар' ? 'товар' : 'ингредиент';
}

function supplyDirNormMode_(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * Все строки справочника как объекты (у синонимов статистика взята у основной строки).
 * supId — supplier_id источника строки по листу «Поставщики» (или null). sups — список поставщиков (необязательно).
 */
function supplyDirLoad_(sups) {
  var sh = supplyDirSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  sups = sups || supplySupLoad_();
  var vals = sh.getRange(2, 1, last - 1, SUPPLY_DIR_WIDTH).getValues();
  var out = [];
  vals.forEach(function (r, i) {
    if (!r[0] && !r[1]) return; // пустая строка
    var id = supplyNum_(r[SUPPLY_DIR_COL.ID - 1]);
    var syn = String(r[SUPPLY_DIR_COL.SYN - 1] || '').trim();
    out.push({
      row: i + 2,
      source: String(r[0]),
      name: String(r[1]),
      id: id,
      posterName: String(r[3] || ''),
      unit: String(r[4] || ''),
      mode: supplyDirNormMode_(r[5]),
      coef: supplyNum_(r[6]),
      weight: supplyNum_(r[7]),
      price: supplyNum_(r[8]),
      count: supplyNum_(r[9]) || 0,
      avg: supplyNum_(r[10]),
      sku: String(r[SUPPLY_DIR_COL.SKU - 1] || '').trim(),
      synonym: syn !== '',
      synOf: syn,
      ptype: supplyNormPtype_(r[SUPPLY_DIR_COL.PTYPE - 1]),
      supId: (function () { var sp = supplySupplierFindIn_(sups, r[0]); return sp ? sp.id : null; })(),
      srcKey: supplyNormSource_(r[0]),
      nameKey: supplyNameKey_(r[1])
    });
  });
  return supplyDirApplyGroups_(out, supplyDirSourceKeyFn_(sups));
}

/**
 * Строка справочника относится к источнику документа: при известных supplier_id с обеих сторон — равны supplier_id
 * (опечатка в названии источника не мешает), иначе источники совпадают по тексту (равны или один содержит другой).
 */
function supplySameSource_(entry, source, docSupId) {
  if (docSupId && entry.supId) return entry.supId === docSupId;
  return supplySourceMatch_(entry.srcKey, supplyNormSource_(source));
}

/** Точное совпадение (поставщик + название). Нужно для записи (supplyDirUpsert_). */
function supplyDirFind_(source, docName, rows) {
  var sups = supplySupLoad_();
  var sup = supplySupplierFindIn_(sups, source);
  var docSupId = sup ? sup.id : null;
  var nameKey = supplyNameKey_(docName);
  var list = rows || supplyDirLoad_(sups);
  for (var i = 0; i < list.length; i++) {
    if (list[i].nameKey === nameKey && supplySameSource_(list[i], source, docSupId)) return list[i];
  }
  return null;
}

/**
 * Сопоставление позиции документа со справочником (чистая функция, листы не читаются).
 * Возвращает {entry, how, candidates}:
 *  - how 'sku'   — найдено по паре (источник, артикул);
 *  - how 'name'  — точное совпадение названия;
 *  - how 'fuzzy' — единственная запись со схожестью ≥ FUZZY_MIN;
 *  - entry null и candidates (≥2) — сомнение, нужен выбор владельца;
 *  - entry null и candidates [] — позиция незнакомая.
 * Запись с другим артикулом по названию не подходит; если артикула в документе нет, работаем по названию.
 * sups — список листа «Поставщики»: записи ищутся среди строк того же supplier_id; без sups (или если supplier_id
 * не определён) источники сравниваются по тексту.
 */
function supplyDirMatch_(rows, source, name, sku, sups) {
  var sup = sups ? supplySupplierFindIn_(sups, source) : null;
  var docSupId = sup ? sup.id : null;
  var nameKey = supplyNameKey_(name);
  var inSource = rows.filter(function (r) { return supplySameSource_(r, source, docSupId); });

  if (sku) {
    var bySku = inSource.filter(function (r) { return r.sku && supplySkuEq_(r.sku, sku); });
    if (bySku.length) return { entry: bySku[0], how: 'sku', candidates: [] };
  }

  // По названию — только записи, у которых нет другого артикула.
  var eligible = inSource.filter(function (r) { return !(sku && r.sku); });

  var exact = eligible.filter(function (r) { return r.nameKey === nameKey; });
  if (exact.length) return { entry: exact[0], how: 'name', candidates: [] };

  var scored = [];
  eligible.forEach(function (r) {
    var s = supplySimilarity_(name, r.name);
    if (s >= SUPPLY_CONST.FUZZY_MIN) scored.push({ entry: r, score: s });
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  if (scored.length === 1) return { entry: scored[0].entry, how: 'fuzzy', candidates: [] };
  if (scored.length > 1) {
    return { entry: null, how: null, candidates: scored.map(function (s) { return s.entry; }) };
  }
  return { entry: null, how: null, candidates: [] };
}

/**
 * Диагностика для вопроса владельцу о новой позиции (чистая функция): определённый supplier_id, артикул после
 * нормализации, найден ли он в справочнике, лучший кандидат и оценка схожести (среди строк того же поставщика).
 */
function supplyDirDiagnoseIn_(rows, sups, source, name, sku) {
  var sup = supplySupplierFindIn_(sups, source);
  var docSupId = sup ? sup.id : null;
  var inSource = rows.filter(function (r) { return supplySameSource_(r, source, docSupId); });
  var skuEntry = null;
  if (sku) {
    skuEntry = inSource.filter(function (r) { return r.sku && supplySkuEq_(r.sku, sku); })[0] || null;
  }
  var best = null;
  inSource.forEach(function (r) {
    var score = supplySimilarity_(name, r.name);
    if (!best || score > best.score) best = { entry: r, score: score };
  });
  return { supplier: sup, skuKey: sku ? supplySkuKey_(sku) : '', skuEntry: skuEntry, best: best, scope: inSource.length };
}

/** Диагностика по листам (см. supplyDirDiagnoseIn_). */
function supplyDirDiagnose_(source, name, sku) {
  var sups = supplySupLoad_();
  return supplyDirDiagnoseIn_(supplyDirLoad_(sups), sups, source, name, sku);
}

/** Текст диагностики (HTML) для сообщения владельцу. */
function supplyDirDiagnoseText_(d, source, sku) {
  var how = { exact: 'точное совпадение', contains: 'по вхождению', fuzzy: 'нечёткое совпадение' };
  var out = ['🔎 <b>Диагностика</b>'];
  out.push('• поставщик: ' + (d.supplier
    ? 'supplier_id ' + d.supplier.id + (d.supplier.name ? ' («' + supplyEsc_(d.supplier.name) + '»)' : '') + ', ' + (how[d.supplier.how] || d.supplier.how)
    : 'не определён, источник «' + supplyEsc_(source) + '» сравнивается по тексту'));
  out.push('• артикул: ' + (sku ? supplyEsc_(sku) + ' → ключ ' + supplyEsc_(d.skuKey) : 'в документе не найден'));
  if (sku) {
    out.push('• артикул в справочнике: ' + (d.skuEntry
      ? 'найден (строка ' + d.skuEntry.row + ', «' + supplyEsc_(d.skuEntry.name) + '»)'
      : 'не найден среди ' + d.scope + ' ' + supplyPlural_(d.scope, 'записи', 'записей', 'записей') + ' этого поставщика'));
  }
  out.push('• лучший кандидат: ' + (d.best
    ? '«' + supplyEsc_(d.best.entry.name) + '» (строка ' + d.best.entry.row + '), схожесть ' + d.best.score.toFixed(2).replace('.', ',') +
      ' (порог ' + String(SUPPLY_CONST.FUZZY_MIN).replace('.', ',') + ')' +
      (sku && d.best.entry.sku && !supplySkuEq_(d.best.entry.sku, sku)
        ? ' — у кандидата другой артикул (' + supplyEsc_(supplySkuKey_(d.best.entry.sku)) + '), по названию он не подходит' : '')
    : 'нет записей этого поставщика'));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

/**
 * Добавляет или обновляет запись. fields: {source, name, id, posterName, unit, mode, coef, weight, price, sku}.
 * На обновлении записываются только переданные (не undefined) поля; счётчик и среднее не трогаются.
 * Если для (источник, ingredient_id) уже есть основная строка, эта строка помечается синонимом.
 * Возвращает номер строки.
 */
function supplyDirUpsert_(fields) {
  var sh = supplyDirSheet_();
  var existing = supplyDirFind_(fields.source, fields.name);
  var map = {
    id: SUPPLY_DIR_COL.ID, posterName: SUPPLY_DIR_COL.PNAME, unit: SUPPLY_DIR_COL.UNIT,
    mode: SUPPLY_DIR_COL.MODE, coef: SUPPLY_DIR_COL.COEF, weight: SUPPLY_DIR_COL.WEIGHT,
    price: SUPPLY_DIR_COL.PRICE, sku: SUPPLY_DIR_COL.SKU, ptype: SUPPLY_DIR_COL.PTYPE
  };

  var row;
  if (existing) {
    row = existing.row;
    Object.keys(map).forEach(function (k) {
      if (fields[k] !== undefined) {
        sh.getRange(row, map[k]).setValue(fields[k] === null ? '' : fields[k]);
      }
    });
  } else {
    row = sh.getLastRow() + 1;
    var line = [];
    for (var c = 0; c < SUPPLY_DIR_WIDTH; c++) line.push('');
    line[0] = fields.source;
    line[1] = fields.name;
    Object.keys(map).forEach(function (k) {
      if (fields[k] !== undefined && fields[k] !== null) line[map[k] - 1] = fields[k];
    });
    line[SUPPLY_DIR_COL.COUNT - 1] = 0;
    sh.getRange(row, 1, 1, SUPPLY_DIR_WIDTH).setValues([line]);
  }

  if (fields.id !== undefined && fields.id !== null) supplyDirMarkIfSynonym_(row);
  return row;
}

/** Если в группе (источник + ingredient_id) уже есть другая основная строка, помечает эту строку синонимом. */
function supplyDirMarkIfSynonym_(row) {
  var all = supplyDirLoad_();
  var e = all.filter(function (r) { return r.row === row; })[0];
  if (!e || !e.groupKey || e.synonym || e.statsRow === e.row) return;
  var main = all.filter(function (r) { return r.row === e.statsRow; })[0];
  if (main) supplyDirSheet_().getRange(row, SUPPLY_DIR_COL.SYN).setValue(main.name);
}

/** Записать артикул в строку (автоматически при первом успешном сопоставлении по названию). */
function supplyDirSetSku_(row, sku) {
  if (!sku) return;
  supplyDirSheet_().getRange(row, SUPPLY_DIR_COL.SKU).setValue(sku);
}

/**
 * Владелец подтвердил, что позиция документа — это запись candRow справочника.
 * Если у записи нет артикула, а в документе он есть, достаточно записать его в запись (дальше сопоставится по нему).
 * Иначе добавляется строка-синоним с теми же настройками (режим, коэффициент, ингредиент) под названием из документа;
 * статистика у неё общая с основной строкой.
 */
function supplyDirAdopt_(candRow, source, docName, sku) {
  var cand = supplyDirLoad_().filter(function (r) { return r.row === candRow; })[0];
  if (!cand) throw new Error('Запись справочника не найдена (строка ' + candRow + ')');
  if (sku && !cand.sku) {
    supplyDirSetSku_(candRow, sku);
    return candRow;
  }
  var fields = {
    source: source, name: docName, id: cand.id, posterName: cand.posterName, unit: cand.unit,
    mode: cand.mode, coef: cand.coef, ptype: cand.ptype
  };
  if (sku) fields.sku = sku;
  return supplyDirUpsert_(fields);
}

/** Проставить ingredient_id (и название в Poster) в существующей строке — для supplyPosterResolveIds. */
function supplyDirSetIngredient_(row, id, posterName) {
  var sh = supplyDirSheet_();
  sh.getRange(row, SUPPLY_DIR_COL.ID).setValue(id);
  if (posterName) sh.getRange(row, SUPPLY_DIR_COL.PNAME).setValue(posterName);
}

/** Строка, где хранится статистика для строки row (основная строка группы; для обычной строки — она сама). */
function supplyDirStatsRow_(row) {
  var e = supplyDirLoad_().filter(function (r) { return r.row === row; })[0];
  return e ? e.statsRow : row;
}

/** Последняя цена (за единицу склада) — в основную строку группы. */
function supplyDirUpdatePrice_(row, price) {
  if (price === null || price === undefined) return;
  supplyDirSheet_().getRange(supplyDirStatsRow_(row), SUPPLY_DIR_COL.PRICE).setValue(Math.round(price * 10000) / 10000);
}

/**
 * Статистика после принятой поставки: счётчик, среднее количество (в единицах склада), вес на штуку —
 * в основную строку группы. ВЫЗЫВАТЬ ОДИН РАЗ НА УНИКАЛЬНЫЙ ДОКУМЕНТ (решает вызывающий по ключу дубля).
 * Вес на штуку: первая поставка сохраняет значение; далее перезаписывается, только если отклонение
 * от сохранённого не больше PIECE_WEIGHT_TOL (чтобы ошибочная поставка не портила эталон).
 */
function supplyDirRecordStats_(row, qtyWarehouse, weightPerPiece) {
  var sh = supplyDirSheet_();
  var target = supplyDirStatsRow_(row);
  var cur = sh.getRange(target, 1, 1, SUPPLY_DIR_WIDTH).getValues()[0];
  var count = supplyNum_(cur[SUPPLY_DIR_COL.COUNT - 1]) || 0;
  var avg = supplyNum_(cur[SUPPLY_DIR_COL.AVG - 1]);

  if (qtyWarehouse !== null && qtyWarehouse !== undefined) {
    var newAvg = (avg === null || count === 0) ? qtyWarehouse : (avg * count + qtyWarehouse) / (count + 1);
    sh.getRange(target, SUPPLY_DIR_COL.AVG).setValue(Math.round(newAvg * 1000) / 1000);
    sh.getRange(target, SUPPLY_DIR_COL.COUNT).setValue(count + 1);
  }

  if (weightPerPiece !== null && weightPerPiece !== undefined) {
    var saved = supplyNum_(cur[SUPPLY_DIR_COL.WEIGHT - 1]);
    var ok = saved === null || saved <= 0 ||
      Math.abs(weightPerPiece - saved) / saved <= SUPPLY_CONST.PIECE_WEIGHT_TOL;
    if (ok) sh.getRange(target, SUPPLY_DIR_COL.WEIGHT).setValue(Math.round(weightPerPiece * 10000) / 10000);
  }
}

/**
 * Ручной запуск перед переходом на DRY_RUN=false:
 * обнуляет счётчик поставок, среднее количество и вес на штуку по всему справочнику. Цены остаются.
 */
function supplyResetStats() {
  var sh = supplyDirSheet_();
  var last = sh.getLastRow();
  if (last < 2) {
    console.log('Справочник пуст, сбрасывать нечего.');
    return;
  }
  var n = last - 1;
  sh.getRange(2, SUPPLY_DIR_COL.WEIGHT, n, 1).clearContent();
  sh.getRange(2, SUPPLY_DIR_COL.AVG, n, 1).clearContent();
  var zeros = [];
  for (var i = 0; i < n; i++) zeros.push([0]);
  sh.getRange(2, SUPPLY_DIR_COL.COUNT, n, 1).setValues(zeros);
  console.log('Статистика сброшена в ' + n + ' строках (счётчик=0, среднее и вес на штуку очищены, цены сохранены).');
}
