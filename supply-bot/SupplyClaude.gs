/**
 * Чтение документа через Claude API (vision / PDF напрямую).
 * Основная модель — MODEL (по умолчанию claude-haiku-5-5), откат — claude-sonnet-5-5.
 */

function supplyClaudePrompt_() {
  return [
    'Ты читаешь фото/скан/PDF товарной накладной или электронного кассового чека (Казахстан, тенге).',
    'Документ может быть повёрнут на 90°/180° — сначала мысленно поверни его правильно.',
    'Верни ТОЛЬКО один JSON-объект, без пояснений и без markdown, строго такой формы:',
    '{',
    '  "doc_type": "invoice" | "receipt",',
    '  "source": "поставщик (для накладной) или название магазина (для чека), как напечатано; null, если его нет",',
    '  "doc_number": "номер накладной; для чека — № чека; null если нет",',
    '  "fp": "фискальный признак (ФП) чека; null если нет",',
    '  "datetime": "YYYY-MM-DD или YYYY-MM-DD HH:MM (для чека со временем)",',
    '  "items": [ {"sku": "артикул или null", "name": "...", "qty": 0, "unit": "шт", "price": 0, "sum": 0} ],',
    '  "total": 0,',
    '  "uncertain_fields": [],',
    '  "notes": null',
    '}',
    'Правила:',
    '- Все числа — JSON-числа с точкой как десятичным разделителем, без пробелов и знаков валюты.',
    '- qty бери ТОЛЬКО из колонки «Количество». Число в скобках в названии, например «(480шт)», — размер упаковки, это НЕ количество.',
    '- name — название позиции полностью, как в документе, включая скобки и размеры.',
    '- sku — артикул / номенклатурный номер / код товара строки, если он напечатан в документе (например ГП000000045), символ в символ; если артикула нет — null. Не выдумывай и не путай с количеством или ценой.',
    '- unit — единица как в документе (шт, кг, л, упак и т.п.).',
    '- price — цена за единицу, sum — сумма по строке. Если в документе значения нет — null. Ничего не вычисляй и не выдумывай.',
    '- total — итоговая сумма документа «Итого/К оплате», как напечатано.',
    '- Позиции перечисляй в порядке документа, не пропускай строки.',
    '- uncertain_fields — массив из значений "doc_number", "qty", "total": перечисли только то, в чём ты действительно не уверен (плохо видно, неразборчиво). Если уверен — пустой массив. Поворот документа, рукописные пометки и т.п. сюда не относятся.',
    '- Скриншоты заказов из приложений доставки и такси (inDrive и т.п.): поставщика/магазина в них может не быть — верни source = null, не выдумывай его (название приложения поставщиком не является); doc_type = "receipt". Позиции бери из блока «Товары в заказе»; total — сумма «Товары в заказе на сумму …». Сервисный сбор, доставку, чаевые, промокод и скидку в позиции и в total НЕ включай.',
    '- Если одна и та же позиция идёт несколькими строками с разной ценой (например «1 × 289» и «23 × 313»), сложи в одну позицию: qty — сумма количеств, sum — сумма сумм (1 × 289 + 23 × 313 = 24 шт на 7488), price = sum / qty.',
    '- В notes кратко запиши прочие наблюдения (или null).'
  ].join('\n');
}

/**
 * Читает документ. Возвращает {doc, model, fallback}.
 * При ошибке API / невалидном JSON / отсутствии поставщика, номера или итога повторяет на модели отката.
 */
function supplyClaudeRead_(prepared) {
  if (!supplyProp_('CLAUDE_API_KEY')) throw new Error('Не задано свойство CLAUDE_API_KEY');

  var primary = supplyModel_();
  var fallback = SUPPLY_CONST.FALLBACK_MODEL;
  var reasons = [];

  var a = supplyClaudeTry_(primary, prepared, true);
  if (a.ok) return { doc: a.doc, model: primary, fallback: false, fallbackReason: '' };
  reasons.push(primary + ': ' + a.reason);
  console.warn('supplyClaudeRead_ ' + primary + ' -> ' + a.reason);

  if (primary !== fallback) {
    var b = supplyClaudeTry_(fallback, prepared, false);
    if (b.ok) return { doc: b.doc, model: fallback, fallback: true, fallbackReason: a.reason };
    reasons.push(fallback + ': ' + b.reason);
  }
  throw new Error('Не удалось надёжно прочитать документ (' + reasons.join('; ') + ').');
}

/** Одна попытка. strict=true: нужен номер документа; strict=false: у чека допускается отсутствие номера при наличии даты. */
function supplyClaudeTry_(model, prepared, strict) {
  var text;
  try {
    text = supplyClaudeCall_(model, prepared);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  var raw = supplyClaudeExtractJson_(text);
  if (!raw) return { ok: false, reason: 'ответ не JSON' };
  var doc = supplyClaudeApplyDefaults_(supplyClaudeNormalize_(raw), supplyDefaultSupplierName_());
  var bad = supplyClaudeValid_(doc, strict);
  if (bad) return { ok: false, reason: bad };
  return { ok: true, doc: doc };
}

function supplyClaudeCall_(model, prepared) {
  var block = prepared.type === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: prepared.data } }
    : { type: 'image', source: { type: 'base64', media_type: prepared.mime, data: prepared.data } };

  var payload = {
    model: model,
    max_tokens: SUPPLY_CONST.CLAUDE_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: supplyClaudePrompt_() }]
    }]
  };

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': supplyProp_('CLAUDE_API_KEY'),
      'anthropic-version': SUPPLY_CONST.ANTHROPIC_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code !== 200) {
    var msg = body;
    try { msg = JSON.parse(body).error.message; } catch (e) { /* оставляем тело как есть */ }
    throw new Error('Claude API HTTP ' + code + ': ' + String(msg).substring(0, 200));
  }
  var data = JSON.parse(body);
  if (data.stop_reason === 'max_tokens') throw new Error('ответ обрезан по max_tokens');
  return (data.content || [])
    .filter(function (c) { return c.type === 'text'; })
    .map(function (c) { return c.text; })
    .join('');
}

/** Достаёт JSON-объект из ответа (на случай обёртки в ```json). */
function supplyClaudeExtractJson_(text) {
  if (!text) return null;
  var s = text.indexOf('{');
  var e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(text.substring(s, e + 1));
  } catch (err) {
    return null;
  }
}

/** Приводит ответ к единому виду, числа — к number или null. */
function supplyClaudeNormalize_(raw) {
  var type = String(raw.doc_type || '').toLowerCase();
  type = type.indexOf('rec') === 0 || type.indexOf('чек') !== -1 ? 'receipt' : (type === 'invoice' ? 'invoice' : type);

  var items = Array.isArray(raw.items) ? raw.items : [];
  return {
    doc_type: type,
    source: raw.source && !/^(null|none|n\/a|-|—)$/i.test(String(raw.source).trim()) ? String(raw.source).trim() : '',
    doc_number: raw.doc_number !== null && raw.doc_number !== undefined && String(raw.doc_number).trim() !== ''
      ? String(raw.doc_number).trim() : null,
    fp: raw.fp !== null && raw.fp !== undefined && String(raw.fp).trim() !== '' ? String(raw.fp).trim() : null,
    datetime: raw.datetime ? String(raw.datetime).trim() : '',
    items: supplyMergeItems_(items.map(function (it) {
      // Если модель положила артикул в название («… номенклатурный номер ГП…», «(ГП…)»), он выделяется
      // в отдельное поле и убирается из названия.
      var split = supplySplitSku_(it && it.name ? String(it.name).trim() : '');
      var name = split.name;
      var skuRaw = it && it.sku !== null && it.sku !== undefined ? String(it.sku).trim() : '';
      if (skuRaw.toLowerCase() === 'null') skuRaw = '';
      // В самом поле тоже мог оказаться текст вроде «артикул ГП…».
      var sku = skuRaw ? (supplySplitSku_(skuRaw).sku || skuRaw) : (split.sku || '');
      return {
        sku: sku || null,
        name: name,
        qty: supplyNum_(it && it.qty),
        unit: it && it.unit ? String(it.unit).trim() : '',
        price: supplyNum_(it && it.price),
        sum: supplyNum_(it && it.sum)
      };
    })),
    total: supplyNum_(raw.total),
    uncertain_fields: (Array.isArray(raw.uncertain_fields) ? raw.uncertain_fields : [])
      .map(function (f) { return String(f); })
      .filter(function (f) { return f === 'doc_number' || f === 'qty' || f === 'total'; }),
    notes: raw.notes ? String(raw.notes).trim() : ''
  };
}

/** Причина невалидности или '' если всё хорошо. */
function supplyClaudeValid_(doc, strict) {
  if (doc.doc_type !== 'invoice' && doc.doc_type !== 'receipt') return 'не определён тип документа';
  if (!doc.source) return 'не найден поставщик/магазин';
  var hasNumber = !!(doc.doc_number || (doc.doc_type === 'receipt' && doc.fp));
  if (!hasNumber && !doc.sourceDefault && (strict || doc.doc_type === 'invoice' || !doc.datetime)) return 'не найден номер документа';
  if (doc.total === null || doc.total <= 0) return 'не найден итог';
  if (!doc.items.length) return 'нет позиций';
  for (var i = 0; i < doc.items.length; i++) {
    var it = doc.items[i];
    if (!it.name) return 'позиция ' + (i + 1) + ' без названия';
    if (it.qty === null || it.qty <= 0) return 'позиция ' + (i + 1) + ' без количества';
  }
  return '';
}

/** Сумма позиции: sum, а если его нет — количество × цена; иначе null. */
function supplyItemValue_(it) {
  if (it.sum !== null && it.sum !== undefined) return it.sum;
  if (it.qty !== null && it.price !== null && it.price !== undefined) return it.qty * it.price;
  return null;
}

/**
 * Одна и та же позиция несколькими строками (с разной ценой) складывается в одну: количества и суммы суммируются,
 * цена = сумма / количество. Позиция «та же», если совпадают название (без артикула в тексте), единица и артикул.
 * Строки без количества или без суммы/цены не склеиваются.
 */
function supplyMergeItems_(items) {
  var out = [];
  var index = {};
  items.forEach(function (it) {
    var value = supplyItemValue_(it);
    var mergeable = it.name && it.qty !== null && it.qty > 0 && value !== null;
    if (!mergeable) {
      out.push(it);
      return;
    }
    var key = supplyNameKey_(it.name) + '|' + String(it.unit || '').toLowerCase() + '|' + supplySkuKey_(it.sku);
    if (index[key] === undefined) {
      index[key] = out.length;
      out.push({ sku: it.sku, name: it.name, qty: it.qty, unit: it.unit, price: it.price, sum: it.sum });
      return;
    }
    var m = out[index[key]];
    var total = supplyItemValue_(m) + value;
    m.qty = Math.round((m.qty + it.qty) * 1000) / 1000;
    m.sum = Math.round(total * 100) / 100;
    m.price = Math.round(m.sum / m.qty * 1e6) / 1e6;
  });
  return out;
}

/**
 * Документ без поставщика/магазина (скриншот заказа из приложения доставки): если есть позиции с количеством и ценой
 * и итог, поставщиком становится запасной (SUPPLY_DEFAULT_SUPPLIER, по умолчанию «Закупка»), номер документа не нужен.
 * Без позиций или без итога поставщик не подставляется — документ дальше отклоняется проверкой supplyClaudeValid_.
 */
function supplyClaudeApplyDefaults_(doc, defaultName) {
  if (doc.source) return doc;
  var okItems = doc.items.length > 0 && doc.items.every(function (it) {
    return it.name && it.qty !== null && it.qty > 0 && (it.price !== null || it.sum !== null);
  });
  if (!okItems || doc.total === null || !(doc.total > 0)) return doc;
  doc.source = defaultName;
  doc.sourceDefault = true;
  if (doc.doc_type !== 'invoice' && doc.doc_type !== 'receipt') doc.doc_type = 'receipt';
  return doc;
}

/** Число из number или строки вида «1 234,5». Иначе null. */
function supplyNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  var s = String(v).replace(/[\s ]/g, '');
  if (s === '') return null;
  var lastComma = s.lastIndexOf(',');
  var lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // последний из разделителей — десятичный
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    s = s.replace(',', '.');
  }
  var n = Number(s);
  return isFinite(n) ? n : null;
}

/** Поставщик по умолчанию, слияние позиций и отклонение чужих фото. Листы и Claude не нужны. Запуск вручную. */
function supplyClaudeSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  var DEF = 'Закупка';
  function read(raw) { return supplyClaudeApplyDefaults_(supplyClaudeNormalize_(raw), DEF); }
  var coke = [
    { name: 'Coca-Cola 0.5 л', qty: 1, unit: 'шт', price: 289, sum: 289 },
    { name: 'Coca-Cola 0.5 л', qty: 23, unit: 'шт', price: 313, sum: 7199 }
  ];

  // Скриншот заказа: поставщика нет, позиции и итог есть
  var shot = read({ doc_type: 'receipt', source: null, doc_number: null, datetime: '', items: coke, total: 7488 });
  expect('документ без поставщика, но с позициями и итогом, получает «Закупка»',
    shot.source === 'Закупка' && shot.sourceDefault === true && shot.doc_type === 'receipt');
  expect('такой документ проходит проверку (номер не нужен)', supplyClaudeValid_(shot, true) === '' && supplyClaudeValid_(shot, false) === '');
  expect('две строки Coca-Cola (1×289 и 23×313) складываются в 24 шт на 7488 ₸',
    shot.items.length === 1 && shot.items[0].qty === 24 && shot.items[0].sum === 7488 && shot.items[0].price === 312);
  expect('сумма позиций сходится с итогом «Товары в заказе на сумму 7488» (⚠️ нет)', supplyChecksDoc_(shot).length === 0);
  expect('итог вместе с сервисным сбором (7788) даёт ⚠️ — в позиции и итог сбор не входит',
    supplyChecksDoc_(read({ doc_type: 'receipt', source: '', items: coke, total: 7788 })).length > 0);

  // Фото без поставщика, позиций или итога
  var noItems = read({ doc_type: 'receipt', source: null, items: [], total: 500 });
  expect('документ без позиций отклоняется', noItems.source === '' && supplyClaudeValid_(noItems, true) !== '');
  var noTotal = read({ doc_type: 'receipt', source: null, items: coke, total: null });
  expect('документ без итога отклоняется', noTotal.source === '' && supplyClaudeValid_(noTotal, true) !== '');
  var noPrice = read({ doc_type: 'receipt', source: null, items: [{ name: 'Что-то', qty: 2 }], total: 100 });
  expect('позиции без цены и суммы не дают поставщика по умолчанию (чужое фото)', noPrice.source === '' && supplyClaudeValid_(noPrice, true) !== '');
  var noQty = read({ doc_type: 'receipt', source: null, items: [{ name: 'Что-то', price: 5, sum: 5 }], total: 5 });
  expect('позиции без количества — отклоняется', noQty.source === '' && supplyClaudeValid_(noQty, true) !== '');
  expect('«null» / «—» как поставщик считаются пустыми', read({ source: 'null', items: coke, total: 7488 }).sourceDefault === true &&
    read({ source: '—', items: coke, total: 7488 }).sourceDefault === true);

  // Если поставщик найден, он не заменяется
  var shop = read({ doc_type: 'receipt', source: 'Магнум', doc_number: '1', items: coke, total: 7488 });
  expect('поставщик найден — «по умолчанию» не подставляется', shop.source === 'Магнум' && !shop.sourceDefault);
  expect('обычный документ без номера по-прежнему отклоняется',
    supplyClaudeValid_(read({ doc_type: 'invoice', source: 'ТОО Х', items: coke, total: 7488 }), true) === 'не найден номер документа');
  expect('свой поставщик по умолчанию', supplyClaudeApplyDefaults_(supplyClaudeNormalize_({ items: coke, total: 7488 }), 'Рынок').source === 'Рынок');

  // Слияние позиций
  var merged = supplyMergeItems_([
    { sku: null, name: 'Хлеб', qty: 2, unit: 'шт', price: 50, sum: 100 },
    { sku: null, name: 'Хлеб', qty: 3, unit: 'шт', price: 60, sum: 180 },
    { sku: null, name: 'Хлеб', qty: 1, unit: 'кг', price: 10, sum: 10 },
    { sku: null, name: 'Хлеб', qty: 1, unit: 'шт', price: null, sum: null },
    { sku: null, name: 'Молоко', qty: 1, unit: 'шт', price: 200, sum: 200 }]);
  expect('слияние: совпадают название и единица; другая единица, строка без цены и другой товар остаются отдельно',
    merged.length === 4 && merged[0].qty === 5 && merged[0].sum === 280 && merged[0].price === 56);
  expect('слияние: разные артикулы — разные позиции',
    supplyMergeItems_([{ sku: 'A1', name: 'X', qty: 1, unit: 'шт', price: 1, sum: 1 }, { sku: 'B2', name: 'X', qty: 1, unit: 'шт', price: 1, sum: 1 }]).length === 2);
  expect('слияние: цена без суммы (кол-во × цена)', (function () {
    var m = supplyMergeItems_([{ name: 'Чай', qty: 2, unit: 'шт', price: 10, sum: null }, { name: 'Чай', qty: 3, unit: 'шт', price: 20, sum: null }]);
    return m.length === 1 && m[0].qty === 5 && m[0].sum === 80 && m[0].price === 16;
  })());

  // Сводка и справочник
  expect('сводка: «Поставщик: Закупка (по умолчанию)»', supplyDocHeader_(shot) === '📄 Поставщик: Закупка (по умолчанию)');
  expect('сводка: с номером заказа', supplyDocHeader_({ source: 'Закупка', sourceDefault: true, doc_number: '123' }) === '📄 Поставщик: Закупка (по умолчанию) № 123');
  expect('обычная шапка не изменилась', supplyDocHeader_({ source: 'Магнум', doc_number: '5' }) === '📄 Магнум № 5');
  expect('строка «Закупка» на листе «Поставщики» создаётся с «несколько в день» = да, остальные — нет',
    supplyDefaultFlagFor_('Закупка') === 'да' && supplyDefaultFlagFor_(' закупка ') === 'да' && supplyDefaultFlagFor_('Магнум') === 'нет');
  var supsZ = [{ source: 'Закупка', id: 21, name: 'Закупка', key: supplyNormSource_('Закупка'), row: 2, multi: true }];
  expect('supplier_id берётся с листа «Поставщики» по названию', supplySupplierFindIn_(supsZ, shot.source).id === 21);
  expect('строки нет на листе — supplier_id не определён (бот спросит владельца)', supplySupplierFindIn_([], shot.source) === null &&
    supplyMatchNext_({ supplier: null, lines: [] }).type === 'supplier');
  expect('ключ дубля для «Закупки» («да»): supplier_id + день + сумма',
    supplyDocKey_(shot, supsZ, '2026-10-15') === 's21|2026-10-15|7488' &&
    supplyDocKey_({ source: 'Закупка', total: 100 }, supsZ, '2026-10-15') !== supplyDocKey_(shot, supsZ, '2026-10-15'));

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
