/**
 * Poster API (good-dog2.joinposter.com). Токен: свойство POSTER_TOKEN (только чтение).
 * Список ингредиентов отдаёт menu.getIngredients (по документации Poster API v3).
 * Запись поставки — storage.createSupply (POST, см. supplyPosterPost_ и SupplyRecord.gs).
 */

/** Убирает токен из любого текста (значение токена и параметры token=...). */
function supplyPosterSanitize_(text) {
  var s = String(text === null || text === undefined ? '' : text);
  var token = supplyProp_('POSTER_TOKEN');
  if (token) s = s.split(token).join('***');
  return s.replace(/(token["']?\s*[=:]\s*["']?)[^&"'\s,}]+/gi, '$1***');
}

/** Низкоуровневый GET: {code, text}. Токен добавляется в URL, наружу не отдаётся. */
function supplyPosterFetch_(method, params) {
  var token = supplyProp_('POSTER_TOKEN');
  if (!token) throw new Error('Не задано свойство POSTER_TOKEN');

  var q = ['token=' + encodeURIComponent(token)];
  Object.keys(params || {}).forEach(function (k) {
    q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  });
  var resp = UrlFetchApp.fetch('https://' + SUPPLY_CONST.POSTER_HOST + '/api/' + method + '?' + q.join('&'), {
    muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), text: resp.getContentText() };
}

/**
 * GET-запрос к Poster. Возвращает data.response.
 * При ошибке бросает исключение с HTTP-кодом и телом ответа (до 500 символов, без токена).
 */
function supplyPosterCall_(method, params) {
  var r = supplyPosterFetch_(method, params);
  var data = null;
  try {
    data = JSON.parse(r.text);
  } catch (e) {
    data = null;
  }

  if (r.code !== 200 || data === null || data.error || data.response === undefined) {
    var body = data !== null ? JSON.stringify(data) : r.text;
    throw new Error('Poster ' + method + ' HTTP ' + r.code + ': ' +
      supplyPosterSanitize_(body).substring(0, 500));
  }
  return data.response;
}

/**
 * POST-запрос к Poster (тело — JSON, числа остаются числами). Токен в URL, наружу не отдаётся.
 * Повторов НЕТ: после сетевого сбоя неизвестно, создана ли запись, а повтор мог бы создать вторую поставку.
 * Возвращает data.response; при ошибке бросает исключение с кодом и телом ответа (до 500 символов, без токена).
 */
function supplyPosterPost_(method, body) {
  var token = supplyProp_('POSTER_TOKEN');
  if (!token) throw new Error('Не задано свойство POSTER_TOKEN');
  var resp = UrlFetchApp.fetch('https://' + SUPPLY_CONST.POSTER_HOST + '/api/' + method + '?token=' + encodeURIComponent(token), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  var data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }

  if (code !== 200 || data === null || data.error || data.success === 0 || data.success === false || data.response === undefined) {
    var err = new Error('Poster ' + method + ' HTTP ' + code + ': ' +
      supplyPosterSanitize_(data !== null ? JSON.stringify(data) : text).substring(0, 500));
    // Определённый отказ Poster (ответ 200 с описанием ошибки): запись точно не создана, повтор другим составом безопасен.
    err.apiError = code === 200 && data !== null && (!!data.error || data.success === 0 || data.success === false);
    throw err;
  }
  return data.response;
}

/** Единица Poster (kg / l / p) -> подпись единицы склада в справочнике. */
function supplyPosterUnitLabel_(u) {
  var map = { kg: 'кг', l: 'л', p: 'шт', g: 'г', ml: 'мл' };
  var k = String(u || '').toLowerCase();
  return map[k] || String(u || '');
}

// ---------------------------------------------------------------------------
// Справочник Poster: ингредиенты + товары (кеш в CacheService, порциями: лимит значения 100 КБ)
// ---------------------------------------------------------------------------

var SUPPLY_ING_CACHE_KEY = 'SUPPLY_CAT';
var SUPPLY_ING_CHUNK = 90000;
var SUPPLY_ING_METHOD = 'menu.getIngredients';
var SUPPLY_PRODUCTS_METHOD = 'menu.getProducts';
var SUPPLY_KIND_ING = 'ингредиент';
var SUPPLY_KIND_PRODUCT = 'товар';

function supplyIngCacheGet_() {
  var cache = CacheService.getScriptCache();
  var meta = cache.get(SUPPLY_ING_CACHE_KEY + '_n');
  if (!meta) return null;
  var parts = [];
  for (var i = 0; i < Number(meta); i++) {
    var p = cache.get(SUPPLY_ING_CACHE_KEY + '_' + i);
    if (p === null) return null;
    parts.push(p);
  }
  try {
    return JSON.parse(parts.join(''));
  } catch (e) {
    return null;
  }
}

function supplyIngCachePut_(list) {
  var cache = CacheService.getScriptCache();
  var json = JSON.stringify(list);
  var n = Math.ceil(json.length / SUPPLY_ING_CHUNK);
  var obj = {};
  for (var i = 0; i < n; i++) {
    obj[SUPPLY_ING_CACHE_KEY + '_' + i] = json.substring(i * SUPPLY_ING_CHUNK, (i + 1) * SUPPLY_ING_CHUNK);
  }
  obj[SUPPLY_ING_CACHE_KEY + '_n'] = String(n);
  cache.putAll(obj, SUPPLY_CONST.ING_CACHE_TTL_SEC);
}

/**
 * Общий справочник Poster из ответов menu.getIngredients и menu.getProducts (чистая функция).
 * Запись: {id (number), name, unit (кг/л/шт), key (нормализованное название), kind: «ингредиент» | «товар»,
 * uid: «i<id>» | «p<id>»} — id ингредиента и id товара из разных пространств, поэтому различаются по uid.
 * Ингредиенты: без удалённых (delete=1) и системных (ingredients_type=2).
 * Товары: только type=3 («товар» с учётом на складе); тех.карты (type=2, блюда) и полуфабрикаты (type=1) не оприходуются.
 * Единица товара всегда «шт».
 */
function supplyPosterBuildCatalog_(rawIngredients, rawProducts) {
  var list = [];
  (Array.isArray(rawIngredients) ? rawIngredients : []).forEach(function (it) {
    if (String(it.delete) === '1') return;
    if (String(it.ingredients_type) === '2') return;
    var id = Number(it.ingredient_id);
    if (!id || !it.ingredient_name) return;
    list.push({
      id: id, name: String(it.ingredient_name), unit: supplyPosterUnitLabel_(it.ingredient_unit),
      key: supplyNormName_(it.ingredient_name), kind: SUPPLY_KIND_ING, uid: 'i' + id
    });
  });
  (Array.isArray(rawProducts) ? rawProducts : []).forEach(function (p) {
    if (String(p.type) !== '3') return;
    var id = Number(p.product_id);
    if (!id || !p.product_name) return;
    var unit = 'шт'; // товары оприходуются поштучно (1 бутылка = 1 шт), без пересчёта в литры/кг
    list.push({
      id: id, name: String(p.product_name), unit: unit,
      key: supplyNormName_(p.product_name), kind: SUPPLY_KIND_PRODUCT, uid: 'p' + id
    });
  });
  return list;
}

/** Метка вида для кнопок и сообщений: «(товар)» / «(ингредиент)». */
function supplyKindMark_(kind) {
  return '(' + (kind === SUPPLY_KIND_PRODUCT ? SUPPLY_KIND_PRODUCT : SUPPLY_KIND_ING) + ')';
}

/**
 * Общий справочник Poster (ингредиенты + товары) из кеша или API. force=true — обновить кеш.
 * Если товары получить не удалось, возвращаются только ингредиенты и такой список не кешируется (следующий вызов повторит запрос).
 */
function supplyPosterCatalog_(force) {
  if (!force) {
    var cached = supplyIngCacheGet_();
    if (cached) return cached;
  }
  var rawIng = supplyPosterCall_(SUPPLY_ING_METHOD, {});
  var rawProducts = null;
  try {
    rawProducts = supplyPosterCall_(SUPPLY_PRODUCTS_METHOD, { type: 'products' });
  } catch (e) {
    console.error('supplyPosterCatalog_: товары не получены: ' + supplySanitizeSecrets_(e.message));
  }
  var list = supplyPosterBuildCatalog_(rawIng, rawProducts);
  if (rawProducts !== null) supplyIngCachePut_(list);
  return list;
}

/** Совместимость: прежнее имя; теперь возвращает общий справочник (ингредиенты и товары). */
function supplyPosterIngredients_(force) {
  return supplyPosterCatalog_(force);
}

/** Запись справочника по uid («i12» / «p345») или null. */
function supplyPosterCatalogFind_(uid, catalog) {
  return (catalog || supplyPosterCatalog_(false)).filter(function (x) { return x.uid === uid; })[0] || null;
}

/** Запись справочника по виду и id (вид пустой = ингредиент). */
function supplyPosterCatalogById_(kind, id, catalog) {
  var k = kind === SUPPLY_KIND_PRODUCT ? SUPPLY_KIND_PRODUCT : SUPPLY_KIND_ING;
  return (catalog || supplyPosterCatalog_(false)).filter(function (x) { return x.kind === k && x.id === Number(id); })[0] || null;
}

/**
 * Ручная проверка доступа к Poster: HTTP-код, начало ответа (без токена), число элементов.
 */
function supplyPosterDebug() {
  var r = supplyPosterFetch_(SUPPLY_ING_METHOD, {});
  console.log('Метод: ' + SUPPLY_ING_METHOD + ', хост: ' + SUPPLY_CONST.POSTER_HOST);
  console.log('HTTP: ' + r.code);
  console.log('Ответ (первые 300 символов): ' + supplyPosterSanitize_(r.text).substring(0, 300));

  var data = null;
  try { data = JSON.parse(r.text); } catch (e) { /* не JSON */ }
  if (data === null) {
    console.log('Ответ не JSON.');
    return;
  }
  if (data.error) {
    console.log('Poster вернул ошибку: ' + supplyPosterSanitize_(JSON.stringify(data.error)).substring(0, 300));
    return;
  }
  if (Array.isArray(data.response)) {
    console.log('Элементов в response: ' + data.response.length);
    if (data.response.length) {
      console.log('Поля первого элемента: ' + Object.keys(data.response[0]).join(', '));
    }
  } else {
    console.log('response не массив, тип: ' + typeof data.response);
  }
}

/** Поставщики Poster без удалённых: [{id (number), name}], по алфавиту. Кеш на час. */
function supplyPosterSuppliers_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var c = cache.get('SUPPLY_SUPPLIERS');
    if (c) {
      try { return JSON.parse(c); } catch (e) { /* перечитаем */ }
    }
  }
  var raw = supplyPosterCall_('storage.getSuppliers', {});
  var list = [];
  (Array.isArray(raw) ? raw : []).forEach(function (s) {
    if (String(s.delete) === '1') return;
    var id = Number(s.supplier_id);
    if (!id || !s.supplier_name) return;
    list.push({ id: id, name: String(s.supplier_name) });
  });
  list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  cache.put('SUPPLY_SUPPLIERS', JSON.stringify(list), 3600);
  return list;
}

/** Выводит в лог supplier_id и название всех поставщиков Poster (включая удалённые, с пометкой). */
function supplyPosterListSuppliers() {
  var list = supplyPosterCall_('storage.getSuppliers', {});
  var count = 0;
  (Array.isArray(list) ? list : []).forEach(function (s) {
    var deleted = String(s.delete) === '1' ? ' (удалён)' : '';
    console.log('supplier_id ' + Number(s.supplier_id) + ' — ' + s.supplier_name + deleted);
    count++;
  });
  console.log('Поставщиков: ' + count + '. Соответствие источников задаётся на листе «' +
    SUPPLY_CONST.SHEET_SUPPLIERS + '».');
}

// ---------------------------------------------------------------------------
// Похожие ингредиенты
// ---------------------------------------------------------------------------

var SUPPLY_STOP_TOKENS = ['для', 'шт', 'кг', 'вес', 'упак', 'пак', 'г', 'мл', 'литр', 'штука'];

/** Значимые слова строки (без чисел, единиц и служебных слов). */
function supplyTokens_(s) {
  return supplyNormName_(s)
    .split(/[^a-zа-я0-9]+/)
    .filter(function (t) {
      return t.length >= 3 && !/^\d/.test(t) && SUPPLY_STOP_TOKENS.indexOf(t) === -1;
    });
}

function supplyStem_(t) {
  return t.substring(0, 5);
}

/**
 * Лучшие совпадения по словам среди записей catalog (чистая функция; окончания не мешают: сравниваются первые 5 букв).
 * opts.onlyKind — искать только среди «ингредиент» или «товар». Возвращает до limit элементов
 * {id, name, unit, kind, uid}, лучшие первыми. Пустой массив, если совпадений нет.
 */
function supplySuggestIn_(catalog, text, limit, opts) {
  var onlyKind = opts && opts.onlyKind;
  var qTokens = supplyTokens_(text);
  if (!qTokens.length) return [];
  var qStems = qTokens.map(supplyStem_);

  var scored = [];
  catalog.forEach(function (ing) {
    if (onlyKind && ing.kind !== onlyKind) return;
    var cTokens = supplyTokens_(ing.name);
    var cStems = cTokens.map(supplyStem_);
    var score = 0;
    qTokens.forEach(function (t, i) {
      if (cTokens.indexOf(t) !== -1) score += 1.5;
      else if (cStems.indexOf(qStems[i]) !== -1) score += 1;
    });
    if (score > 0) {
      score -= 0.01 * cTokens.length; // при равенстве выигрывают более короткие названия
      scored.push({ ing: ing, score: score });
    }
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, limit || 5).map(function (s) {
    return { id: s.ing.id, name: s.ing.name, unit: s.ing.unit, kind: s.ing.kind || SUPPLY_KIND_ING, uid: s.ing.uid || ('i' + s.ing.id) };
  });
}

/** То же по общему справочнику Poster (ингредиенты и товары). */
function supplyPosterSuggest_(text, limit, opts) {
  return supplySuggestIn_(supplyPosterCatalog_(false), text, limit, opts);
}

// ---------------------------------------------------------------------------
// Разовое заполнение ingredient_id (запускается вручную из редактора)
// ---------------------------------------------------------------------------

/**
 * Для строк справочника без ingredient_id ищет ингредиент в Poster по колонке «название в Poster».
 * Записывает id только при единственном точном совпадении. Иначе пишет в лог кандидатов
 * и ничего не меняет — такие случаи нужно решить вручную.
 */
function supplyPosterResolveIds() {
  var ingredients = supplyPosterCatalog_(true);
  console.log('В справочнике Poster: ' + ingredients.length + ' (ингредиентов ' +
    ingredients.filter(function (x) { return x.kind === SUPPLY_KIND_ING; }).length + ', товаров ' +
    ingredients.filter(function (x) { return x.kind === SUPPLY_KIND_PRODUCT; }).length + ')');

  var rows = supplyDirLoad_();
  var resolved = 0;
  var problems = [];

  rows.forEach(function (r) {
    if (r.id || r.mode === SUPPLY_CONST.MODE_SKIP || !r.posterName) return;
    var key = supplyNormName_(r.posterName);
    var exact = ingredients.filter(function (ing) { return ing.key === key && ing.kind === (r.ptype || SUPPLY_KIND_ING); });

    if (exact.length === 1) {
      supplyDirSetIngredient_(r.row, exact[0].id, exact[0].name);
      resolved++;
      var note = '';
      if (r.unit && exact[0].unit && r.unit !== exact[0].unit) {
        note = ' ⚠️ единица в справочнике «' + r.unit + '», в Poster «' + exact[0].unit + '»';
      }
      console.log('Строка ' + r.row + ' [' + r.source + ' | ' + r.name + '] → id ' + exact[0].id +
        ' «' + exact[0].name + '» (' + exact[0].unit + ') ' + supplyKindMark_(exact[0].kind) + note);
      return;
    }

    var candidates = exact.length > 1 ? exact : supplyPosterSuggest_(r.posterName, 6);
    problems.push('Строка ' + r.row + ' [' + r.source + ' | ' + r.name + '], искали «' + r.posterName + '»: ' +
      (exact.length > 1 ? 'НЕСКОЛЬКО ТОЧНЫХ СОВПАДЕНИЙ' : 'точного совпадения нет') + '. Варианты: ' +
      (candidates.length
        ? candidates.map(function (c) { return c.id + ' «' + c.name + '» (' + c.unit + ') ' + supplyKindMark_(c.kind); }).join('; ')
        : 'ничего похожего'));
  });

  console.log('Заполнено автоматически: ' + resolved + '. Требуют решения: ' + problems.length);
  problems.forEach(function (p) { console.log(p); });
}

/**
 * Проверка типа строки в Poster на ручной поставке (например, с колой): вводите ID поставки из Poster.
 * Выводит в лог строки поставки как их видит storage.getSupply: id ингредиента / товара, type, название, количество, сумму.
 * В getSupply: type 1 — товар, 10 — ингредиент. Для createSupply документация: товар — 1, ингредиент — 4
 * (настройка SUPPLY_POSTER_PRODUCT_TYPE, по умолчанию 1).
 */
function supplyPosterCheckSupply(supplyId) {
  var id = Number(supplyId);
  if (!id) throw new Error('Укажите ID поставки: supplyPosterCheckSupply(46)');
  var sup = supplyPosterCall_('storage.getSupply', { supply_id: id });
  console.log('Поставка ' + id + ': поставщик ' + sup.supplier_id + ' «' + sup.supplier_name + '», склад ' + sup.storage_id +
    ', дата ' + sup.date + ', сумма ' + sup.supply_sum);
  (sup.ingredients || []).forEach(function (l, i) {
    console.log((i + 1) + '. type=' + l.type + ' ingredient_id=' + l.ingredient_id + ' product_id=' + l.product_id +
      ' «' + l.ingredient_name + '» ' + l.supply_ingredient_num + ' ' + l.ingredient_unit + ' на ' + l.supply_ingredient_sum);
  });
}
