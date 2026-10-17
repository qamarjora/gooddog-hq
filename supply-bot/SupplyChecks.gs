/**
 * Проверки документа. Результат — короткие тексты для строк «⚠️ …» в сводке;
 * подтверждение они не блокируют.
 *
 *  - supplyChecksDoc_(doc): арифметика документа (кол-во × цена = сумма строки; сумма строк = итог);
 *  - supplyChecksLines_(lines): цена ±10% от последней, диапазон количества (×3 / ÷3 с 3-й поставки),
 *    вес на штуку ±15% для режима «ввод штук»;
 *  - supplyChecksAll_(doc, lines): всё вместе.
 *
 * Строка для supplyChecksLines_ (собирается при сопоставлении со справочником):
 *   {n: номер позиции (1..), name: название, item: строка документа {qty, price, sum, ...},
 *    entry: запись справочника (price, count, avg, weight, mode) или null,
 *    qtyWh: количество в единицах склада, unit: единица склада,
 *    weightPerPiece: вес на штуку (для «ввод штук») или null}
 * Все проверки по строке пропускаются, если для них нет данных (первая поставка, пустые поля).
 */

/** Допуск на округление: 1 ₸ или 0,5% суммы, что больше. */
function supplyTol_(amount) {
  return Math.max(1, Math.abs(amount) * 0.005);
}

/** Арифметика документа. Пустой массив, если всё сошлось. */
function supplyChecksDoc_(doc) {
  var warns = [];
  var lineValues = [];
  var unverifiable = false;

  doc.items.forEach(function (it, i) {
    var n = i + 1;
    var calc = (it.qty !== null && it.price !== null) ? it.qty * it.price : null;

    if (calc !== null && it.sum !== null && Math.abs(calc - it.sum) > supplyTol_(it.sum)) {
      warns.push('строка ' + n + ': ' + supplyFmtNum_(it.qty) + ' × ' + supplyFmtNum_(it.price) +
        ' ≠ ' + supplyFmtNum_(it.sum));
    }

    var value = it.sum !== null ? it.sum : calc;
    if (value === null) unverifiable = true;
    else lineValues.push(value);
  });

  if (unverifiable) {
    warns.push('не у всех строк есть сумма, итог не сверен');
  } else {
    var sum = lineValues.reduce(function (a, b) { return a + b; }, 0);
    if (Math.abs(sum - doc.total) > supplyTol_(doc.total)) {
      warns.push('сумма строк ' + supplyFmtNum_(sum) + ' ≠ итог ' + supplyFmtNum_(doc.total));
    }
  }
  return warns;
}

/** «+15%» / «−8%» для отклонения dev (доля, со знаком). */
function supplyPct_(dev) {
  var p = Math.round(dev * 100);
  return (p > 0 ? '+' : (p < 0 ? '−' : '')) + Math.abs(p) + '%';
}

/** Короткое название для предупреждения. */
function supplyShortName_(s) {
  s = String(s || '');
  return s.length > 32 ? s.substring(0, 31) + '…' : s;
}

/** Цена единицы по строке документа: price, а если его нет — сумма ÷ количество. */
function supplyLineUnitPrice_(item) {
  if (item.price !== null && item.price !== undefined) return item.price;
  if (item.sum !== null && item.sum !== undefined && item.qty > 0) return item.sum / item.qty;
  return null;
}

/** Проверки по строкам со справочником. Пустой массив, если замечаний нет. */
function supplyChecksLines_(lines) {
  var warns = [];

  lines.forEach(function (ln) {
    var e = ln.entry;
    if (!e) return;
    var label = ln.n + '. ' + supplyShortName_(ln.name);

    // 1) Цена за единицу склада против последней (±PRICE_TOL). Если пересчёта нет — цена по документу.
    var price = (ln.unitPriceWh !== null && ln.unitPriceWh !== undefined) ? ln.unitPriceWh : supplyLineUnitPrice_(ln.item);
    if (price !== null && e.price !== null && e.price > 0) {
      var dev = (price - e.price) / e.price;
      if (Math.abs(dev) > SUPPLY_CONST.PRICE_TOL + 1e-9) {
        warns.push(label + ': цена ' + supplyFmtPrice4_(price) + ' ₸ (была ' + supplyFmtPrice4_(e.price) +
          ', ' + supplyPct_(dev) + ')');
      }
    }

    // 2) Диапазон количества (в единицах склада), только с 3-й поставки.
    if (ln.qtyWh !== null && ln.qtyWh !== undefined && e.count >= SUPPLY_CONST.QTY_MIN_DELIVERIES &&
        e.avg !== null && e.avg > 0) {
      var f = SUPPLY_CONST.QTY_FACTOR;
      if (ln.qtyWh > e.avg * f + 1e-9 || ln.qtyWh < e.avg / f - 1e-9) {
        warns.push(label + ': количество ' + supplyFmtNum_(ln.qtyWh) + (ln.unit ? ' ' + ln.unit : '') +
          ' при обычном ~' + supplyFmtNum_(e.avg));
      }
    }

    // 3) Вес на штуку (режим «ввод штук»), ±PIECE_WEIGHT_TOL от сохранённого. Первая поставка — без сравнения.
    if (e.mode === SUPPLY_CONST.MODE_PIECES && ln.weightPerPiece !== null && ln.weightPerPiece !== undefined &&
        e.weight !== null && e.weight > 0) {
      var wd = (ln.weightPerPiece - e.weight) / e.weight;
      if (Math.abs(wd) > SUPPLY_CONST.PIECE_WEIGHT_TOL + 1e-9) {
        warns.push(label + ': вес на штуку ' + supplyFmtNum_(ln.weightPerPiece) + ' (обычно ' +
          supplyFmtNum_(e.weight) + ', ' + supplyPct_(wd) + ')');
      }
    }
  });
  return warns;
}

/** Все предупреждения для сводки. */
function supplyChecksAll_(doc, lines) {
  return supplyChecksDoc_(doc).concat(supplyChecksLines_(lines || []));
}

/** Самопроверка логики без Poster и без листов: запустить вручную, смотреть журнал. */
function supplyChecksSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  function line(over) {
    var base = {
      n: 1, name: 'Тест', item: { qty: 10, price: 100, sum: 1000 },
      entry: { price: 100, count: 5, avg: 10, weight: 0.1, mode: SUPPLY_CONST.MODE_DIRECT },
      qtyWh: 10, unit: 'шт', weightPerPiece: null
    };
    Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
    return base;
  }

  expect('цена +9% — без замечаний', supplyChecksLines_([line({ item: { qty: 10, price: 109, sum: 1090 } })]).length === 0);
  expect('цена +11% — ⚠️', supplyChecksLines_([line({ item: { qty: 10, price: 111, sum: 1110 } })]).length === 1);
  expect('цена −12% — ⚠️', supplyChecksLines_([line({ item: { qty: 10, price: 88, sum: 880 } })]).length === 1);
  expect('нет последней цены — без замечаний',
    supplyChecksLines_([line({ entry: { price: null, count: 5, avg: 10, weight: null, mode: 'прямо' } })]).length === 0);
  expect('цена из суммы, если price нет',
    supplyChecksLines_([line({ item: { qty: 10, price: null, sum: 1200 } })]).length === 1);

  // Цена сравнивается за единицу склада (литр), а не за штуку документа.
  expect('цена за единицу склада: 55,6 ₸/л против 61 — в допуске, хотя 50 ₸/шт против 61 не в допуске',
    supplyChecksLines_([line({ item: { qty: 10, price: 50, sum: 500 }, unitPriceWh: 500 / 9, qtyWh: 9,
      entry: { price: 61, count: 5, avg: 9, weight: null, mode: 'коэффициент' } })]).length === 0);
  expect('цена за единицу склада: 80 ₸/л против 61 — ⚠️',
    supplyChecksLines_([line({ item: { qty: 10, price: 72, sum: 720 }, unitPriceWh: 80, qtyWh: 9,
      entry: { price: 61, count: 5, avg: 9, weight: null, mode: 'коэффициент' } })]).length === 1);

  expect('количество в диапазоне ×3', supplyChecksLines_([line({ qtyWh: 30 })]).length === 0);
  expect('количество >×3 — ⚠️', supplyChecksLines_([line({ qtyWh: 31 })]).length === 1);
  expect('количество <÷3 — ⚠️', supplyChecksLines_([line({ qtyWh: 3 })]).length === 1);
  expect('до 3-й поставки диапазон не проверяется',
    supplyChecksLines_([line({ qtyWh: 100, entry: { price: 100, count: 2, avg: 10, weight: null, mode: 'прямо' } })]).length === 0);

  var pieces = { price: 100, count: 5, avg: 40, weight: 0.1, mode: SUPPLY_CONST.MODE_PIECES };
  expect('вес на штуку +15% — без замечаний',
    supplyChecksLines_([line({ entry: pieces, qtyWh: 40, weightPerPiece: 0.115 })]).length === 0);
  expect('вес на штуку +16% — ⚠️',
    supplyChecksLines_([line({ entry: pieces, qtyWh: 40, weightPerPiece: 0.116 })]).length === 1);
  expect('первая поставка (вес не сохранён) — без сравнения',
    supplyChecksLines_([line({ entry: { price: 100, count: 0, avg: null, weight: null, mode: SUPPLY_CONST.MODE_PIECES },
      qtyWh: 40, weightPerPiece: 0.5 })]).length === 0);
  expect('позиция без записи справочника пропускается', supplyChecksLines_([line({ entry: null })]).length === 0);

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
