/**
 * Лист «Поставщики»: как источник из документа соответствует поставщику Poster.
 * Колонки: A название в документе | B supplier_id | C название в Poster | D несколько в день (да/нет)
 * Заменяет Script Property SUPPLY_SUPPLIER_MAP.
 *
 * Источник сопоставляется с листом: 1) равны после нормализации; 2) один содержит другой;
 * 3) нечёткое совпадение (схожесть ≥ SUPPLIER_FUZZY_MIN, только если все подходящие строки — один supplier_id).
 * Если совпадение не точное (2 или 3), новое написание автоматически добавляется на лист как вариант
 * (с тем же supplier_id и тем же значением «несколько в день»).
 *
 * «Несколько в день»: «да» — у поставщика бывает несколько поставок за день, ключ дубля включает сумму;
 * «нет» или пусто — одна поставка в день, ключ = поставщик + дата (см. SupplyJournal.gs).
 */

var SUPPLY_SUP_WIDTH = 4;

function supplySupSeedRows_() {
  return [
    ['Магнум', 13, '', 'да'],
    ['Magnum', 13, '', 'да'],
    ['Арбуз', 12, '', 'да'],
    ['Arbuz', 12, '', 'да'],
    ['Татым', 7, '', 'нет'],
    ['DidarPlast', 11, '', 'нет'],
    ['Qazmeatproduct', 6, '', 'нет']
  ];
}

/** «да» / yes / true / 1 (регистр не важен); пусто и всё остальное — нет. */
function supplyIsYes_(v) {
  return /^(да|yes|true|1)$/i.test(String(v === null || v === undefined ? '' : v).trim());
}

function supplySupSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CONST.SHEET_SUPPLIERS);
  if (sh) {
    supplySupMigrate_(sh);
    return sh;
  }

  sh = ss.insertSheet(SUPPLY_CONST.SHEET_SUPPLIERS);
  sh.getRange(1, 1, 1, SUPPLY_SUP_WIDTH)
    .setValues([['название в документе', 'supplier_id', 'название в Poster', 'несколько в день']])
    .setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('@');
  var seed = supplySupSeedRows_();
  sh.getRange(2, 1, seed.length, SUPPLY_SUP_WIDTH).setValues(seed);
  sh.setColumnWidth(1, 300);
  sh.setColumnWidth(3, 240);
  sh.setColumnWidth(4, 130);
  return sh;
}

/**
 * Лист прежней версии (3 колонки): добавляет колонку «несколько в день».
 * Магнум (13) и Арбуз (12) — «да», остальные — «нет».
 */
function supplySupMigrate_(sh) {
  if (String(sh.getRange(1, 4).getValue()) !== '') return;
  sh.getRange(1, 4).setValue('несколько в день').setFontWeight('bold');
  sh.setColumnWidth(4, 130);
  var last = sh.getLastRow();
  if (last < 2) return;
  var ids = sh.getRange(2, 2, last - 1, 1).getValues();
  var flags = ids.map(function (r) {
    var id = supplyNum_(r[0]);
    return [id === 13 || id === 12 ? 'да' : 'нет'];
  });
  sh.getRange(2, 4, last - 1, 1).setValues(flags);
}

function supplySupLoad_() {
  var sh = supplySupSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  sh.getRange(2, 1, last - 1, SUPPLY_SUP_WIDTH).getValues().forEach(function (r, i) {
    var id = supplyNum_(r[1]);
    if (!r[0] || !id) return;
    out.push({
      row: i + 2, source: String(r[0]), id: id, name: String(r[2] || ''),
      multi: supplyIsYes_(r[3]), key: supplyNormSource_(r[0])
    });
  });
  return out;
}

/** Схожесть строк 0..1 по символам. */
function supplyStrSim_(a, b) {
  if (!a || !b) return 0;
  return 1 - supplyLevenshtein_(a, b) / Math.max(a.length, b.length);
}

/**
 * Схожесть названий источников. Дополнительно сравнивается первое слово (бренд), если оно достаточно длинное
 * и остальная часть названия не противоречит: «gazmeatproduct astana» ≈ «qazmeatproduct».
 */
function supplySourceSim_(a, b) {
  var best = supplyStrSim_(a, b);
  var ta = a.split(' ');
  var tb = b.split(' ');
  if (ta[0].length >= 6 && tb[0].length >= 6) {
    var first = supplyStrSim_(ta[0], tb[0]);
    var ra = ta.slice(1).join(' ');
    var rb = tb.slice(1).join(' ');
    var min = SUPPLY_CONST.SUPPLIER_FUZZY_MIN;
    if (first >= min && (!ra || !rb || supplyStrSim_(ra, rb) >= min)) best = Math.max(best, first);
  }
  return best;
}

/**
 * Поставщик для источника документа: {id, name, row, how, multi} или null.
 * how: 'exact' (равны после нормализации), 'contains' (один содержит другой), 'fuzzy' (нечёткое).
 * multi — «несколько в день» у найденной строки.
 */
function supplySupplierFind_(source) {
  return supplySupplierFindIn_(supplySupLoad_(), source);
}

/** То же по готовому списку (supplySupLoad_) — без чтения листа, для ключей документов, групп статистики и тестов. */
function supplySupplierFindIn_(list, source) {
  var key = supplyNormSource_(source);
  if (!key) return null;

  var best = null;
  list.forEach(function (s) {
    if (!supplySourceMatch_(s.key, key)) return;
    var exact = s.key === key;
    if (!best || (exact && !best.exact) || (exact === best.exact && s.key.length > best.len)) {
      best = { s: s, exact: exact, len: s.key.length };
    }
  });
  if (best) return supplySupplierResult_(best.s, best.exact ? 'exact' : 'contains');

  // Нечёткое совпадение (ошибки распознавания: QAZ -> GAZ). Неоднозначное (разные supplier_id) не принимаем.
  if (key.length < 6) return null;
  var fuzzy = [];
  list.forEach(function (s) {
    if (s.key.length < 6) return;
    var sim = supplySourceSim_(key, s.key);
    if (sim >= SUPPLY_CONST.SUPPLIER_FUZZY_MIN) fuzzy.push({ s: s, sim: sim });
  });
  if (!fuzzy.length) return null;
  var ids = {};
  fuzzy.forEach(function (f) { ids[f.s.id] = true; });
  if (Object.keys(ids).length > 1) return null;
  fuzzy.sort(function (a, b) { return b.sim - a.sim; });
  return supplySupplierResult_(fuzzy[0].s, 'fuzzy');
}

function supplySupplierResult_(s, how) {
  return { id: s.id, name: s.name, row: s.row, multi: !!s.multi, how: how };
}

/**
 * Запоминает новое написание источника на листе (тот же supplier_id и «несколько в день»), если такого ещё нет.
 * Возвращает true, если строка добавлена.
 */
function supplySupplierAddVariant_(source, sup) {
  var key = supplyNormSource_(source);
  if (!key) return false;
  if (supplySupLoad_().some(function (s) { return s.key === key; })) return false;
  var sh = supplySupSheet_();
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, SUPPLY_SUP_WIDTH).setValues([[String(source).trim(), sup.id, sup.name || '', sup.multi ? 'да' : 'нет']]);
  console.log('Лист «Поставщики»: добавлен вариант написания «' + source + '» → supplier_id ' + sup.id);
  return true;
}

/** «несколько в день» для новой строки листа: у запасного поставщика (SUPPLY_DEFAULT_SUPPLIER) — «да», у остальных — «нет». */
function supplyDefaultFlagFor_(source) {
  return supplyNormSource_(source) === supplyNormSource_(supplyDefaultSupplierName_()) ? 'да' : 'нет';
}

/** Записывает выбор владельца: обновляет строку с тем же названием или добавляет новую («несколько в день»: «да» для «Закупки», иначе «нет»). */
function supplySupplierSave_(source, id, posterName) {
  var sh = supplySupSheet_();
  var key = supplyNormSource_(source);
  var found = supplySupLoad_().filter(function (s) { return s.key === key; })[0];
  if (found) {
    sh.getRange(found.row, 2, 1, 2).setValues([[id, posterName || '']]);
    return found.row;
  }
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, SUPPLY_SUP_WIDTH).setValues([[source, id, posterName || '', supplyDefaultFlagFor_(source)]]);
  return row;
}

/** Поиск поставщика Poster по тексту (для кнопки «Поиск» у владельца). */
function supplySupplierSearch_(text, limit) {
  var tokens = supplyNormName_(text).split(/[^a-zа-я0-9]+/).filter(function (t) { return t.length >= 2; });
  if (!tokens.length) return [];
  return supplyPosterSuppliers_(false).filter(function (s) {
    var n = supplyNormName_(s.name);
    return tokens.some(function (t) { return n.indexOf(t) !== -1; });
  }).slice(0, limit || 8);
}

/**
 * Ручной запуск: проставляет «название в Poster» на листе «Поставщики» по supplier_id
 * (storage.getSuppliers). Строки с неизвестным или удалённым id выводятся в лог.
 */
function supplyPosterFillSupplierNames() {
  var sh = supplySupSheet_();
  var byId = {};
  supplyPosterSuppliers_(true).forEach(function (s) { byId[s.id] = s.name; });

  var filled = 0;
  supplySupLoad_().forEach(function (s) {
    if (byId[s.id]) {
      sh.getRange(s.row, 3).setValue(byId[s.id]);
      filled++;
      console.log('Строка ' + s.row + ' «' + s.source + '» → ' + s.id + ' «' + byId[s.id] + '»');
    } else {
      console.log('⚠️ Строка ' + s.row + ' «' + s.source + '»: supplier_id ' + s.id + ' не найден среди действующих поставщиков Poster');
    }
  });
  console.log('Названий проставлено: ' + filled);
}
