/**
 * Каталог Poster для заполнения владельцем: все ингредиенты и товары одним листом «Каталог Poster».
 * Владелец по каждой позиции выбирает из списка, как она считается на складе (колонка F), при необходимости пишет
 * коэффициент (G) и заметку своими словами (H). Повторный запуск supplyCatalogExport() ответы не стирает:
 * обновляет список из Poster, новые позиции дописываются, введённое сохраняется.
 *
 * Колонки: A вид | B id | C название в Poster | D категория | E единица в Poster |
 *          F как считаем на складе (список) | G коэффициент | H заметка | I что уже знаем из накладных.
 * Запуск: supplyCatalogExport() вручную (нужен POSTER_TOKEN). Прогресс: supplyCatalogProgress().
 */

var SUPPLY_CATALOG_SHEET = 'Каталог Poster';
var SUPPLY_CATALOG_WIDTH = 9;

/** Варианты колонки F (подпись для человека -> режим справочника накладных). */
var SUPPLY_CATALOG_OPTIONS = [
  { label: '1 к 1 (в накладной те же единицы, что на складе)', mode: 'прямо' },
  { label: 'пересчёт (в накладной упаковки, на складе штуки/литры/кг)', mode: 'коэффициент' },
  { label: 'в накладной вес, на складе штуки', mode: 'ввод штук' },
  { label: 'не оприходовать (не считаем на складе)', mode: 'пропускать' },
  { label: 'спросить количество при приёме (бот спросит, сколько кг/л)', mode: 'спросить количество' },
  { label: 'спросить размер упаковки при приёме (сколько шт/кг/л в упаковке)', mode: 'спросить упаковку' },
  { label: 'банки: бот спросит чистый вес одной банки', mode: 'банки' }
];

function supplyCatalogModeFromLabel_(label) {
  var l = String(label || '').trim();
  for (var i = 0; i < SUPPLY_CATALOG_OPTIONS.length; i++) {
    if (SUPPLY_CATALOG_OPTIONS[i].label === l) return SUPPLY_CATALOG_OPTIONS[i].mode;
  }
  return '';
}

function supplyCatalogLabelFromMode_(mode) {
  var m = String(mode || '').trim().toLowerCase();
  for (var i = 0; i < SUPPLY_CATALOG_OPTIONS.length; i++) {
    if (SUPPLY_CATALOG_OPTIONS[i].mode === m) return SUPPLY_CATALOG_OPTIONS[i].label;
  }
  return '';
}

/**
 * Ответы владельца из листа «Каталог Poster»: {'вид|id': {mode, coef}} — только строки с выбранным режимом.
 * Листа нет или он не читается — пустой объект (бот работает по справочнику накладных).
 */
function supplyCatalogLoad_() {
  var out = {};
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SUPPLY_CATALOG_SHEET);
    var last = sh ? sh.getLastRow() : 0;
    if (last < 2) return out;
    sh.getRange(2, 1, last - 1, SUPPLY_CATALOG_WIDTH).getValues().forEach(function (r) {
      var mode = supplyCatalogModeFromLabel_(r[5]);
      var id = Number(r[1]);
      if (!mode || !id) return;
      var coef = r[6] === '' ? null : supplyNum_(r[6]);
      out[(String(r[0]) === 'товар' ? 'товар' : 'ингредиент') + '|' + id] = { mode: mode, coef: coef !== null && coef > 0 ? coef : null };
    });
  } catch (e) {
    console.error('supplyCatalogLoad_: каталог недоступен: ' + e.message);
  }
  return out;
}

/** Запись справочника с режимом и коэффициентом из каталога Poster (если по позиции есть ответ владельца). */
function supplyCatalogApply_(entry, answers) {
  if (!entry || !entry.id || !answers) return entry;
  var a = answers[(entry.ptype === 'товар' ? 'товар' : 'ингредиент') + '|' + entry.id];
  if (!a) return entry;
  var coef = a.coef;
  if (coef === null && (a.mode === SUPPLY_CONST.MODE_COEF || a.mode === SUPPLY_CONST.MODE_DIRECT)) {
    coef = a.mode === SUPPLY_CONST.MODE_DIRECT ? 1 : (entry.mode === SUPPLY_CONST.MODE_COEF ? entry.coef : null);
  }
  return Object.assign({}, entry, { mode: a.mode, coef: coef });
}

/**
 * Строки листа (чистая функция).
 * rawIng / rawProducts — ответы menu.getIngredients / menu.getProducts; dirEntries — supplyDirLoad_();
 * prev — уже введённое: {'вид|id': {mode, coef, note}}.
 * Ингредиенты: без удалённых и системных (ingredients_type=2). Товары: только type=3 (как в боте).
 * Порядок: ингредиенты, затем товары; внутри — по категории и названию.
 */
function supplyCatalogRows_(rawIng, rawProducts, dirEntries, prev) {
  prev = prev || {};
  var items = [];
  (Array.isArray(rawIng) ? rawIng : []).forEach(function (it) {
    if (String(it.delete) === '1' || String(it.ingredients_type) === '2') return;
    var id = Number(it.ingredient_id);
    if (!id || !it.ingredient_name) return;
    items.push({ kind: 'ингредиент', id: id, name: String(it.ingredient_name),
      cat: String(it.category_name || it.ingredients_category_name || ''), unit: supplyPosterUnitLabel_(it.ingredient_unit) });
  });
  (Array.isArray(rawProducts) ? rawProducts : []).forEach(function (p) {
    if (String(p.type) !== '3') return;
    var id = Number(p.product_id);
    if (!id || !p.product_name) return;
    items.push({ kind: 'товар', id: id, name: String(p.product_name), cat: String(p.category_name || ''), unit: 'шт' });
  });
  items.sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === 'ингредиент' ? -1 : 1;
    return (a.cat + '\u0000' + a.name).localeCompare(b.cat + '\u0000' + b.name, 'ru');
  });

  return items.map(function (x) {
    // Что бот уже знает об этой позиции из накладных (строки справочника, не синонимы).
    var known = (dirEntries || []).filter(function (e) {
      if (e.synonym) return false;
      var kind = e.ptype === 'товар' ? 'товар' : 'ингредиент';
      return kind === x.kind && ((e.id !== null && e.id === x.id) || (e.id === null && supplyNormName_(e.posterName) === supplyNormName_(x.name)));
    });
    var modes = [], coefs = [];
    known.forEach(function (e) {
      if (e.mode && modes.indexOf(e.mode) === -1) modes.push(e.mode);
      if (e.mode === 'коэффициент' && e.coef !== null && coefs.indexOf(e.coef) === -1) coefs.push(e.coef);
    });
    var knownText = known.slice(0, 4).map(function (e) {
      return e.source + ': «' + e.name + '» (' + (e.mode || '?') + (e.mode === 'коэффициент' && e.coef !== null ? ' ×' + e.coef : '') + ')';
    }).join('; ') + (known.length > 4 ? '; … ещё ' + (known.length - 4) : '');

    var saved = prev[x.kind + '|' + x.id] || {};
    var label = saved.mode ? supplyCatalogLabelFromMode_(saved.mode) : (modes.length === 1 ? supplyCatalogLabelFromMode_(modes[0]) : '');
    var coef = saved.coef !== undefined && saved.coef !== '' ? saved.coef : (coefs.length === 1 ? coefs[0] : '');
    return [x.kind, x.id, x.name, x.cat, x.unit, label, coef, saved.note || '', knownText];
  });
}

/** Уже введённое на листе: {'вид|id': {mode, coef, note}} (режим — по подписи из списка). */
function supplyCatalogReadPrev_(sh) {
  var out = {};
  var last = sh ? sh.getLastRow() : 0;
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, SUPPLY_CATALOG_WIDTH).getValues().forEach(function (r) {
    var mode = supplyCatalogModeFromLabel_(r[5]);
    var coef = r[6] === '' ? '' : supplyNum_(r[6]);
    var note = String(r[7] || '').trim();
    if (!mode && (coef === '' || coef === null) && !note) return;
    out[String(r[0]) + '|' + Number(r[1])] = { mode: mode, coef: coef === null ? '' : coef, note: note };
  });
  return out;
}

/** Выгрузка каталога Poster на лист «Каталог Poster». Ответы владельца сохраняются. */
function supplyCatalogExport() {
  var rawIng = supplyPosterCall_(SUPPLY_ING_METHOD, {});
  var rawProducts = supplyPosterCall_(SUPPLY_PRODUCTS_METHOD, { type: 'products' });
  var dirEntries = [];
  try { dirEntries = supplyDirLoad_(); } catch (e) { console.error('supplyCatalogExport: справочник накладных не прочитан: ' + e.message); }

  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CATALOG_SHEET);
  var prev = sh ? supplyCatalogReadPrev_(sh) : {};
  var rows = supplyCatalogRows_(rawIng, rawProducts, dirEntries, prev);
  if (!sh) sh = ss.insertSheet(SUPPLY_CATALOG_SHEET);

  // Список перезаписывается целиком (ответы уже учтены в rows), хвост старых строк очищается.
  var oldLast = sh.getLastRow();
  if (oldLast >= 1) sh.getRange(1, 1, oldLast, SUPPLY_CATALOG_WIDTH).clearContent();
  sh.getRange(1, 1, 1, SUPPLY_CATALOG_WIDTH).setValues([[
    'вид', 'id', 'название в Poster', 'категория', 'ед. в Poster',
    'КАК СЧИТАЕМ НА СКЛАДЕ (выберите)', 'коэффициент (если «пересчёт»)', 'заметка своими словами', 'что уже знаем из накладных'
  ]]);
  if (rows.length) sh.getRange(2, 1, rows.length, SUPPLY_CATALOG_WIDTH).setValues(rows);

  // Оформление — по возможности (на отсутствие отдельных методов не падаем).
  function safe(fn) { try { fn(); } catch (e) { /* не критично */ } }
  safe(function () { sh.setFrozenRows(1); });
  safe(function () { sh.getRange(1, 1, 1, SUPPLY_CATALOG_WIDTH).setFontWeight('bold'); });
  safe(function () { sh.getRange('A:B').setNumberFormat('@'); });
  safe(function () {
    var labels = SUPPLY_CATALOG_OPTIONS.map(function (o) { return o.label; });
    sh.getRange(2, 6, Math.max(rows.length, 1), 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(labels, true).setAllowInvalid(true).build());
  });
  safe(function () { sh.getRange(2, 6, Math.max(rows.length, 1), 3).setBackground('#FFF8DC'); });
  safe(function () { sh.getRange(2, 9, Math.max(rows.length, 1), 1).setFontColor('#777777'); });
  safe(function () { sh.setColumnWidth(3, 280); sh.setColumnWidth(6, 330); sh.setColumnWidth(8, 260); sh.setColumnWidth(9, 380); });
  safe(function () { sh.getRange(1, 1, rows.length + 1, SUPPLY_CATALOG_WIDTH).createFilter(); });

  var ing = rows.filter(function (r) { return r[0] === 'ингредиент'; }).length;
  console.log('Каталог Poster: ингредиентов ' + ing + ', товаров ' + (rows.length - ing) + '. Лист «' + SUPPLY_CATALOG_SHEET + '».');
  console.log('Заполнено: ' + rows.filter(function (r) { return r[5] !== ''; }).length + ' из ' + rows.length + '.');
  return rows.length;
}

/** Сколько позиций каталога уже заполнено и какие остались (первые 30). Запуск вручную. */
function supplyCatalogProgress() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SUPPLY_CATALOG_SHEET);
  if (!sh || sh.getLastRow() < 2) { console.log('Лист «' + SUPPLY_CATALOG_SHEET + '» пуст: запустите supplyCatalogExport().'); return; }
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, SUPPLY_CATALOG_WIDTH).getValues();
  var left = vals.filter(function (r) { return !supplyCatalogModeFromLabel_(r[5]); });
  console.log('Заполнено ' + (vals.length - left.length) + ' из ' + vals.length + '. Осталось: ' + left.length + '.');
  left.slice(0, 30).forEach(function (r) { console.log('  • ' + r[0] + ': ' + r[2]); });
}

/** Самопроверка каталога: без Poster и листов. Запуск вручную. */
function supplyCatalogSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  var rawIng = [
    { ingredient_id: '5', ingredient_name: 'Огурцы', ingredient_unit: 'kg', ingredients_type: '1', delete: '0' },
    { ingredient_id: '3', ingredient_name: 'Сосиски', ingredient_unit: 'p', ingredients_type: '1', delete: '0' },
    { ingredient_id: '9', ingredient_name: 'Удалённое', ingredient_unit: 'p', ingredients_type: '1', delete: '1' },
    { ingredient_id: '8', ingredient_name: 'Системное', ingredient_unit: 'p', ingredients_type: '2', delete: '0' },
    { ingredient_id: '4', ingredient_name: 'Молоко', ingredient_unit: 'l', ingredients_type: '1', delete: '0' }
  ];
  var rawProd = [
    { product_id: '20', product_name: 'Напитки', type: '3' },
    { product_id: '30', product_name: 'Бургер', type: '2' }
  ];
  var dir = [
    { source: 'Магнум', name: 'Молоко 0,9 л', id: 4, posterName: 'молоко', mode: 'коэффициент', coef: 0.9, synonym: false, ptype: '' },
    { source: 'Qazmeat', name: 'Круг полукопчёный', id: 3, posterName: 'сосиски', mode: 'ввод штук', coef: null, synonym: false, ptype: '' },
    { source: 'Рэд Машин', name: 'Кола 0,5', id: 20, posterName: 'Напитки', mode: 'прямо', coef: 1, synonym: false, ptype: 'товар' }
  ];
  var rows = supplyCatalogRows_(rawIng, rawProd, dir, {});
  expect('удалённые, системные ингредиенты и тех.карты не попали', rows.length === 4);
  expect('сначала ингредиенты, потом товары', rows[0][0] === 'ингредиент' && rows[3][0] === 'товар' && rows[3][2] === 'Напитки');
  expect('внутри вида — по названию: Молоко, Огурцы, Сосиски', rows.slice(0, 3).map(function (r) { return r[2]; }).join() === 'Молоко,Огурцы,Сосиски');
  expect('единицы: молоко л, огурцы кг, сосиски шт, товар шт', rows[0][4] === 'л' && rows[1][4] === 'кг' && rows[2][4] === 'шт' && rows[3][4] === 'шт');
  expect('молоко: режим и коэффициент подставлены из справочника накладных',
    supplyCatalogModeFromLabel_(rows[0][5]) === 'коэффициент' && rows[0][6] === 0.9);
  expect('сосиски: «ввод штук» подставлен', supplyCatalogModeFromLabel_(rows[2][5]) === 'ввод штук');
  expect('товар «Напитки» сопоставлен по виду и id (не с ингредиентом id 20)', supplyCatalogModeFromLabel_(rows[3][5]) === 'прямо');
  expect('огурцы: из накладных ничего не известно — поле пустое', rows[1][5] === '' && rows[1][8] === '');
  expect('в колонке «что знаем» есть поставщик и название из накладной', rows[0][8].indexOf('Магнум') !== -1 && rows[0][8].indexOf('Молоко 0,9 л') !== -1);

  var prev = { 'ингредиент|5': { mode: 'пропускать', coef: '', note: 'считаем вручную' }, 'ингредиент|4': { mode: 'прямо', coef: 1, note: '' } };
  var rows2 = supplyCatalogRows_(rawIng, rawProd, dir, prev);
  expect('ответ владельца сохраняется при повторной выгрузке (огурцы)', supplyCatalogModeFromLabel_(rows2[1][5]) === 'пропускать' && rows2[1][7] === 'считаем вручную');
  expect('ответ владельца сильнее подсказки из справочника (молоко: «1 к 1», а не «пересчёт»)', supplyCatalogModeFromLabel_(rows2[0][5]) === 'прямо' && rows2[0][6] === 1);
  expect('все подписи списка однозначно переводятся в режимы',
    SUPPLY_CATALOG_OPTIONS.every(function (o) { return supplyCatalogModeFromLabel_(o.label) === o.mode && supplyCatalogLabelFromMode_(o.mode) === o.label; }));

  // Применение ответов каталога к записи справочника накладных.
  var ans = { 'ингредиент|4': { mode: 'коэффициент', coef: 0.9 }, 'ингредиент|8': { mode: 'спросить количество', coef: null },
    'ингредиент|5': { mode: 'прямо', coef: null }, 'ингредиент|6': { mode: 'коэффициент', coef: null } };
  var ap = supplyCatalogApply_({ id: 4, ptype: 'ингредиент', mode: 'прямо', coef: 1 }, ans);
  expect('каталог: молоко «пересчёт ×0,9» сильнее записи «прямо»', ap.mode === 'коэффициент' && ap.coef === 0.9);
  expect('каталог: соус → «спросить количество»', supplyCatalogApply_({ id: 8, ptype: 'ингредиент', mode: 'прямо', coef: 1 }, ans).mode === 'спросить количество');
  expect('каталог: «1 к 1» ставит коэффициент 1', supplyCatalogApply_({ id: 5, ptype: 'ингредиент', mode: 'коэффициент', coef: 3 }, ans).coef === 1);
  expect('каталог: «пересчёт» без числа берёт коэффициент записи', supplyCatalogApply_({ id: 6, ptype: 'ингредиент', mode: 'коэффициент', coef: 2.5 }, ans).coef === 2.5);
  expect('каталог: нет ответа по позиции — запись без изменений', supplyCatalogApply_({ id: 99, ptype: 'ингредиент', mode: 'прямо', coef: 1 }, ans).mode === 'прямо');
  expect('каталог: товар с тем же id не путается с ингредиентом', supplyCatalogApply_({ id: 4, ptype: 'товар', mode: 'прямо', coef: 1 }, ans).mode === 'прямо');
  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
