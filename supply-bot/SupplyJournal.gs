/**
 * Лист «Журнал поставок», ключ документа, поиск дублей.
 *
 * Колонки: A дата (с документа, как прочитана с фото — в логике дублей НЕ используется) | B источник |
 *          C № документа (в логике дублей не используется) | D сумма | E ссылка на файл (не используется, всегда пусто) |
 *          F статус (принято / dry-run) | G расхождение («нет» или «да: комментарий») |
 *          H ключ документа (служебная) | I записано (когда бот внёс строку) |
 *          J ID поставки в Poster (только при реальной записи) |
 *          K file_unique_id снимка/файла (поиск повторно присланного снимка)
 *
 * Статус «ошибка Poster» (Poster не принял поставку) в дубли не считается: документ можно отправить заново.
 *
 * Дату и номер с фото модель читает нестабильно, поэтому ключ документа строится без них:
 *  - поставщик с «несколько в день» = нет (или пусто): supplier_id + сегодняшняя дата по Астане (UTC+5);
 *  - поставщик с «несколько в день» = да:            supplier_id + сегодняшняя дата + итоговая сумма;
 *  - поставщика нет на листе «Поставщики»:           нормализованное название + сегодняшняя дата.
 * Поставщик определяется по листу «Поставщики» (с нечётким сопоставлением).
 * «Сегодня» для строки журнала — дата в колонке «записано» (по Астане): ключ каждой строки при поиске дублей
 * вычисляется заново из колонок B, D, I (старые строки не меняются, но тоже находятся).
 *
 * Вторая проверка (только «нет»): тот же supplier_id, та же сумма, строка записана за последние 7 дней.
 *
 * Если для документа в журнале уже есть подходящая строка (статус «принято» или «dry-run»), сотруднику
 * показывается предупреждение; записать документ можно только после кнопки «Это новый документ».
 */

var SUPPLY_JRN_COL = {
  DATE: 1, SOURCE: 2, NUMBER: 3, SUM: 4, LINK: 5, STATUS: 6, DISCREPANCY: 7, KEY: 8, AT: 9, POSTER_ID: 10, UID: 11
};
var SUPPLY_JRN_WIDTH = 11;
var SUPPLY_RECENT_DAYS = 7;

function supplyJrnSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SUPPLY_CONST.SHEET_JOURNAL);
  if (sh) {
    // Лист из прежней версии: дописываем заголовки колонок J и K.
    if (String(sh.getRange(1, SUPPLY_JRN_COL.POSTER_ID).getValue()) === '') {
      sh.getRange(1, SUPPLY_JRN_COL.POSTER_ID).setValue('ID поставки Poster').setFontWeight('bold');
    }
    if (String(sh.getRange(1, SUPPLY_JRN_COL.UID).getValue()) === '') {
      sh.getRange(1, SUPPLY_JRN_COL.UID).setValue('file_unique_id').setFontWeight('bold');
      sh.getRange('K:K').setNumberFormat('@');
    }
    return sh;
  }

  sh = ss.insertSheet(SUPPLY_CONST.SHEET_JOURNAL);
  sh.getRange(1, 1, 1, SUPPLY_JRN_WIDTH).setValues([[
    'дата', 'источник', '№ документа', 'сумма', 'ссылка на файл', 'статус',
    'расхождение', 'ключ документа', 'записано', 'ID поставки Poster', 'file_unique_id'
  ]]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // Текстом, чтобы Sheets не превращал номера и даты в числа/даты.
  sh.getRange('A:C').setNumberFormat('@');
  sh.getRange('H:H').setNumberFormat('@');
  sh.getRange('K:K').setNumberFormat('@');
  sh.getRange('I:I').setNumberFormat('dd.MM.yyyy HH:mm');
  sh.setColumnWidth(2, 180);
  sh.setColumnWidth(5, 220);
  sh.setColumnWidth(7, 220);
  sh.setColumnWidth(8, 220);
  return sh;
}

// ---------------------------------------------------------------------------
// Дата по Астане и ключ документа
// ---------------------------------------------------------------------------

/** Дата по Астане (UTC+5) для момента ms (мс от эпохи) в виде YYYY-MM-DD. */
function supplyAstanaDate_(ms) {
  return new Date(ms + 5 * 3600 * 1000).toISOString().substring(0, 10);
}

/** Сегодняшняя дата по Астане (UTC+5). */
function supplyTodayAstana_() {
  return supplyAstanaDate_(Date.now());
}

/** «2026-10-10» -> «10.10.2026»; пустое — «—». */
function supplyFmtDate_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '.' + m[2] + '.' + m[1] : (String(iso || '') || '—');
}

/**
 * Ключ по источнику, дню и сумме (см. описание файла). day — YYYY-MM-DD («сегодня» нового документа или
 * день записи строки журнала). sups — список листа «Поставщики» (supplySupLoad_).
 * Сумма входит в ключ только у поставщиков с «несколько в день» = да.
 */
function supplyDocKeyFor_(source, day, total, sups) {
  var sup = supplySupplierFindIn_(sups || supplySupLoad_(), source);
  var key = (sup ? 's' + sup.id : 'n:' + supplyNormSource_(source)) + '|' + (day || '');
  if (sup && sup.multi) {
    var sum = supplyNum_(total);
    key += '|' + (sum === null ? '' : Math.round(sum * 100) / 100);
  }
  return key;
}

/** Ключ нового документа: дата документа с фото не используется, берётся сегодняшняя (today — для тестов). */
function supplyDocKey_(doc, sups, today) {
  return supplyDocKeyFor_(doc.source, today || supplyTodayAstana_(), doc.total, sups);
}

// ---------------------------------------------------------------------------
// Чтение и поиск дублей
// ---------------------------------------------------------------------------

function supplyJrnStatusIs_(entry, status) {
  return String(entry.status || '').trim().toLowerCase() === status;
}

/** Строка журнала учитывается при поиске дублей: статус «принято» или «dry-run». */
function supplyJrnCounts_(entry) {
  return supplyJrnStatusIs_(entry, SUPPLY_CONST.STATUS_ACCEPTED) || supplyJrnStatusIs_(entry, SUPPLY_CONST.STATUS_DRYRUN);
}

/**
 * Строки журнала. atMs/atDay — когда строка записана (колонка «записано», день по Астане);
 * computedKey — ключ, вычисленный по текущему листу «Поставщики» и дню записи.
 */
function supplyJrnLoad_(sups) {
  var sh = supplyJrnSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  sups = sups || supplySupLoad_();
  var vals = sh.getRange(2, 1, last - 1, SUPPLY_JRN_WIDTH).getValues();
  return vals.map(function (r, i) {
    var atMs = (r[8] && typeof r[8].getTime === 'function') ? r[8].getTime() : null;
    var atDay = atMs === null ? '' : supplyAstanaDate_(atMs);
    var computed = supplyDocKeyFor_(String(r[1]), atDay, r[3], sups);
    return {
      row: i + 2,
      date: r[0] instanceof Date ? supplyAstanaDate_(r[0].getTime()) : String(r[0]), // как записано (дата с документа)
      source: String(r[1]),
      number: String(r[2]),
      sum: supplyNum_(r[3]),
      link: String(r[4]),
      status: String(r[5]),
      discrepancy: String(r[6]),
      storedKey: String(r[7]),
      computedKey: computed,
      supplierKey: computed.split('|')[0],
      at: r[8],
      atMs: atMs,
      atDay: atDay,
      posterId: r[9],
      fileUid: String(r[10] || '')
    };
  });
}

/**
 * Классификация дубля (чистая функция). rows — supplyJrnLoad_; key — ключ нового документа.
 * opts.recentCheck — вторая проверка для поставщиков с «несколько в день» = нет: тот же supplier_id, та же сумма,
 *   строка записана за последние 7 дней (колонка «записано»). opts.nowMs — «сейчас» для тестов.
 * Возвращает null (дубля нет) или {kind: 'same'|'other', entry, entries, viaRecent}:
 *  - same:  в журнале есть документ с той же суммой (по ключу или по второй проверке);
 *  - other: тот же ключ, но другая сумма (бывает только у поставщиков с «несколько в день» = нет).
 * Учитываются строки со статусом «принято» и «dry-run».
 */
function supplyJrnClassify_(rows, doc, key, opts) {
  opts = opts || {};
  var total = supplyNum_(doc.total);
  function sameSum(r) { return r.sum !== null && total !== null && Math.abs(r.sum - total) < 0.01; }

  var cand = rows.filter(function (r) { return r.computedKey === key && supplyJrnCounts_(r); });
  var sameByKey = cand.filter(sameSum);

  var recent = [];
  if (opts.recentCheck) {
    var supplier = key.split('|')[0];
    var now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
    recent = rows.filter(function (r) {
      return supplyJrnCounts_(r) && r.supplierKey === supplier && sameSum(r) &&
        r.atMs !== null && r.atMs !== undefined && now - r.atMs <= SUPPLY_RECENT_DAYS * 86400000;
    });
  }

  if (sameByKey.length) return { kind: 'same', entry: sameByKey[sameByKey.length - 1], entries: cand, viaRecent: false };
  if (recent.length) return { kind: 'same', entry: recent[recent.length - 1], entries: cand, viaRecent: true };
  if (cand.length) return { kind: 'other', entry: cand[cand.length - 1], entries: cand, viaRecent: false };
  return null;
}

/** Проверка документа по журналу (читает листы). См. supplyJrnClassify_. */
function supplyJrnDupCheck_(doc) {
  var sups = supplySupLoad_();
  var sup = supplySupplierFindIn_(sups, doc.source);
  return supplyJrnClassify_(supplyJrnLoad_(sups), doc, supplyDocKey_(doc, sups), { recentCheck: !!(sup && !sup.multi) });
}

/**
 * Снимок (file_unique_id) уже есть в журнале со статусом «принято» или «dry-run» (чистая функция).
 * Пустой uid — null. Действует для всех поставщиков, включая «несколько в день» = да.
 */
function supplyJrnClassifySnapshot_(rows, uid) {
  if (!uid) return null;
  var found = rows.filter(function (r) { return r.fileUid === uid && supplyJrnCounts_(r); });
  return found.length ? found[found.length - 1] : null;
}

/** Строка журнала с таким же снимком или null (читает листы). */
function supplyJrnFindSnapshot_(uid) {
  return uid ? supplyJrnClassifySnapshot_(supplyJrnLoad_(), uid) : null;
}

/** Текст предупреждения о дубле (кнопки «Это новый документ» / «❌ Отмена» добавляет диалог). */
function supplyJrnDupAskText_(dup) {
  if (dup.kind === 'same') {
    var parts = ['сумма ' + supplyFmtNum_(dup.entry.sum) + ' ₸'];
    if (supplyJrnStatusIs_(dup.entry, SUPPLY_CONST.STATUS_DRYRUN)) parts.push('dry-run');
    if (dup.viaRecent && dup.entry.atDay) parts.push('в журнале от ' + supplyFmtDate_(dup.entry.atDay)); // вторая проверка: другой день
    return '⚠️ Точно такой же документ уже принят (' + parts.join(', ') + ')';
  }
  var sums = [];
  dup.entries.forEach(function (r) {
    var s = supplyFmtNum_(r.sum);
    if (sums.indexOf(s) === -1) sums.push(s);
  });
  return sums.length === 1
    ? '⚠️ В этот день от этого поставщика уже была поставка на ' + sums[0] + ' ₸. Это дополнительная поставка?'
    : '⚠️ В этот день от этого поставщика уже были поставки на ' + sums.join(' ₸, ') + ' ₸. Это дополнительная поставка?';
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

/** «нет» или «да: комментарий». */
function supplyJrnDiscrepancyText_(has, comment) {
  if (!has) return 'нет';
  return comment ? 'да: ' + comment : 'да';
}

/**
 * Добавляет строку в журнал: дата документа с фото пишется в колонку «дата» как есть,
 * в колонку «ключ документа» — новый ключ.
 * entry: {doc, status, link, discrepancy, posterId (необязательно), fileUid (необязательно), forceStats (необязательно)}.
 * Возвращает {row, duplicate, countStats}:
 *  - duplicate: для документа уже была подходящая строка журнала (то же, что показывает supplyJrnDupCheck_:
 *    ключ или вторая проверка; принято / dry-run) и forceStats не задан; по дублю статистика справочника
 *    не обновляется;
 *  - countStats = !duplicate.
 * forceStats передаёт диалог: сотрудник нажал «Это новый документ» в боевом режиме (реальная дополнительная
 * поставка). В dry-run дубль статистику не обновляет даже после этой кнопки.
 */
function supplyJrnAppend_(entry) {
  var sh = supplyJrnSheet_();
  var doc = entry.doc;
  var sups = supplySupLoad_();
  var sup = supplySupplierFindIn_(sups, doc.source);
  var key = supplyDocKey_(doc, sups);

  var rows = supplyJrnLoad_(sups);
  var prior = supplyJrnClassify_(rows, doc, key, { recentCheck: !!(sup && !sup.multi) }) !== null ||
    supplyJrnClassifySnapshot_(rows, entry.fileUid) !== null; // тот же ключ, вторая проверка или тот же снимок
  var duplicate = prior && !entry.forceStats;

  var number = doc.doc_number
    ? String(doc.doc_number)
    : (doc.doc_type === 'receipt' && doc.fp ? 'ФП:' + doc.fp : '');
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, SUPPLY_JRN_WIDTH).setValues([[
    doc.datetime || '',
    doc.source,
    number,
    doc.total,
    entry.link || '',
    entry.status,
    entry.discrepancy || '',
    key,
    new Date(),
    entry.posterId || '',
    entry.fileUid || ''
  ]]);
  return { row: row, duplicate: duplicate, countStats: !duplicate };
}

// ---------------------------------------------------------------------------
// Самотест
// ---------------------------------------------------------------------------

/** Ключ документа и классификация дублей без листов и Poster. Запуск вручную. */
function supplyDupSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  function sup(source, id, multi) {
    return { source: source, id: id, name: '', key: supplyNormSource_(source), row: 2, multi: !!multi };
  }
  var sups = [sup('Магнум', 13, true), sup('Magnum', 13, true), sup('Арбуз', 12, true),
              sup('Qazmeatproduct', 6, false), sup('DidarPlast', 11, false), sup('Татым', 7, false)];
  var A = SUPPLY_CONST.STATUS_ACCEPTED, D = SUPPLY_CONST.STATUS_DRYRUN;
  var TODAY = '2026-10-10';
  var NOW = Date.UTC(2026, 9, 10, 6, 0), DAY = 86400000; // 10.10.2026 11:00 по Астане
  function jr(key, sum, status, atMs) {
    return { computedKey: key, supplierKey: key.split('|')[0], sum: sum, status: status, source: 'x',
             atMs: atMs === undefined ? null : atMs, atDay: atMs === undefined || atMs === null ? '' : supplyAstanaDate_(atMs) };
  }

  // --- «нет» (Qazmeatproduct): три чтения одного документа с разными датой, номером и суммой ---
  var q1 = { source: 'ТОО QAZMEATPRODUCT ASTANA', datetime: '09.10.2026', total: 26243.8, doc_number: '4872', doc_type: 'invoice' };
  var q2 = { source: 'Товарищество с ограниченной ответственностью "GAZMEATPRODUCT ASTANA"', datetime: '2025-10-09',
             total: 26248.3, doc_number: '4972', doc_type: 'invoice' };
  var q3 = { source: 'Qazmeatproduct', datetime: '', total: 262438, doc_number: '', doc_type: 'invoice' };
  var k1 = supplyDocKey_(q1, sups, TODAY), k2 = supplyDocKey_(q2, sups, TODAY), k3 = supplyDocKey_(q3, sups, TODAY);
  console.log('ключи «нет»: ' + k1 + ' | ' + k2 + ' | ' + k3);
  expect('«нет»: ключ = supplier_id + сегодняшняя дата, дата/номер/сумма документа не влияют',
    k1 === 's6|2026-10-10' && k2 === k1 && k3 === k1);
  expect('дата документа в ключ не входит (2025 и 2026 — один ключ)',
    supplyDocKey_({ source: 'Qazmeatproduct', datetime: '2025-10-09', total: 1 }, sups, TODAY) ===
    supplyDocKey_({ source: 'Qazmeatproduct', datetime: '2026-10-09', total: 1 }, sups, TODAY));
  expect('другой день записи — другой ключ', supplyDocKey_(q1, sups, '2026-10-11') !== k1);

  var rowQ = jr('s6|2026-10-10', 26243.8, D, NOW - 3600000);
  var c1 = supplyJrnClassify_([rowQ], q2, k2);
  var c0 = supplyJrnClassify_([rowQ], q1, k1);
  expect('«нет»: другая сумма за этот день — предупреждение «уже была поставка»', c1 && c1.kind === 'other');
  expect('«нет»: та же сумма — «точно такой же документ»', c0 && c0.kind === 'same' && c0.viaRecent === false);
  expect('«нет»: запись за другой день ключом не находится', supplyJrnClassify_([jr('s6|2026-10-09', 26243.8, D, NOW - DAY)], q2, k2) === null);

  // --- «да» (Магнум): в ключе сегодняшняя дата и сумма ---
  var m1 = { source: 'Магнум', datetime: '2025-01-05', total: 1500, doc_number: '111', doc_type: 'receipt' };
  var m2 = { source: 'ТОО Magnum', datetime: '', total: 1720.5, doc_number: '', doc_type: 'receipt' };
  var mk1 = supplyDocKey_(m1, sups, TODAY), mk2 = supplyDocKey_(m2, sups, TODAY);
  console.log('ключи «да»: ' + mk1 + ' | ' + mk2);
  expect('«да»: ключ = supplier_id + сегодняшняя дата + сумма', mk1 === 's13|2026-10-10|1500' && mk2 === 's13|2026-10-10|1720.5');
  var journalM = [jr(mk1, 1500, A, NOW - 3600000)];
  expect('«да»: другая сумма предупреждения не даёт', supplyJrnClassify_(journalM, m2, mk2) === null);
  expect('«да»: та же сумма — «точно такой же документ»', supplyJrnClassify_(journalM, m1, mk1).kind === 'same');
  expect('«да»: Магнум и Magnum — один поставщик',
    supplyDocKey_({ source: 'Magnum', datetime: 'x', total: 1500 }, sups, TODAY) === mk1);

  // --- Ключ строки журнала из колонки «записано» (по Астане, UTC+5) ---
  function rowKey(atMs, source, sum) { return supplyDocKeyFor_(source, supplyAstanaDate_(atMs), sum, sups); }
  expect('день записи по Астане: 18:30 UTC = 23:30 в тот же день', supplyAstanaDate_(Date.UTC(2026, 9, 9, 18, 30)) === '2026-10-09');
  expect('день записи по Астане: 19:30 UTC = 00:30 следующего дня', supplyAstanaDate_(Date.UTC(2026, 9, 9, 19, 30)) === '2026-10-10');
  expect('ключ строки журнала = ключ документа того же дня',
    rowKey(NOW - 3600000, 'GAZMEATPRODUCT ASTANA', 26243.8) === k1);

  // --- Вторая проверка («нет»): тот же supplier_id, та же сумма, записано за 7 дней ---
  var qDoc = { source: 'Qazmeatproduct', datetime: '2025-10-09', total: 26243.8, doc_number: '4872', doc_type: 'invoice' };
  var qKey = supplyDocKey_(qDoc, sups, TODAY);
  var rowOld = jr('s6|2026-10-09', 26243.8, D, NOW - DAY);
  var r7 = supplyJrnClassify_([rowOld], qDoc, qKey, { recentCheck: true, nowMs: NOW });
  expect('вчерашняя запись с той же суммой: предупреждение «Точно такой же документ…»',
    r7 && r7.kind === 'same' && r7.viaRecent === true);
  console.log('   ' + (r7 ? supplyJrnDupAskText_(r7) : ''));
  expect('без второй проверки (поставщик «да») вчерашняя запись не находится',
    supplyJrnClassify_([rowOld], qDoc, qKey, { recentCheck: false, nowMs: NOW }) === null);
  expect('запись старше 7 дней не считается',
    supplyJrnClassify_([jr('s6|2026-10-02', 26243.8, D, NOW - 8 * DAY)], qDoc, qKey, { recentCheck: true, nowMs: NOW }) === null);
  expect('запись ровно 7 дней назад считается',
    supplyJrnClassify_([jr('s6|2026-10-03', 26243.8, D, NOW - 7 * DAY)], qDoc, qKey, { recentCheck: true, nowMs: NOW }) !== null);
  expect('другая сумма — не дубль',
    supplyJrnClassify_([jr('s6|2026-10-09', 100, D, NOW - DAY)], qDoc, qKey, { recentCheck: true, nowMs: NOW }) === null);
  expect('другой поставщик — не дубль',
    supplyJrnClassify_([jr('s11|2026-10-09', 26243.8, D, NOW - DAY)], qDoc, qKey, { recentCheck: true, nowMs: NOW }) === null);
  expect('«принято» тоже учитывается',
    supplyJrnClassify_([jr('s6|2026-10-09', 26243.8, A, NOW - DAY)], qDoc, qKey, { recentCheck: true, nowMs: NOW }) !== null);
  expect('другой статус не учитывается',
    supplyJrnClassify_([jr('s6|2026-10-09', 26243.8, 'ошибка', NOW - DAY)], qDoc, qKey, { recentCheck: true, nowMs: NOW }) === null);
  expect('строка без даты «записано» второй проверкой не учитывается',
    supplyJrnClassify_([jr('s6|', 26243.8, D, null)], qDoc, qKey, { recentCheck: true, nowMs: NOW }) === null);

  // --- Прочее ---
  expect('«принято» и «dry-run» учитываются, прочие статусы нет',
    supplyJrnClassify_([jr(k1, 1, A, NOW)], q1, k1) !== null && supplyJrnClassify_([jr(k1, 1, D, NOW)], q1, k1) !== null &&
    supplyJrnClassify_([jr(k1, 1, 'ошибка', NOW)], q1, k1) === null);
  expect('пустое «несколько в день» = нет', supplyIsYes_('') === false && supplyIsYes_(undefined) === false &&
    supplyIsYes_('Да') === true && supplyIsYes_('нет') === false);
  expect('неизвестный поставщик: ключ по названию и сегодняшней дате, без суммы',
    supplyDocKey_({ source: 'Новый Поставщик', datetime: 'x', total: 5 }, sups, TODAY) === 'n:новый поставщик|2026-10-10');
  expect('нечёткий поставщик (QAZ/GAZ) и способ совпадения',
    supplySupplierFindIn_(sups, q2.source).id === 6 && supplySupplierFindIn_(sups, q2.source).how === 'fuzzy' &&
    supplySupplierFindIn_(sups, q1.source).how === 'contains' && supplySupplierFindIn_(sups, 'Qazmeatproduct').how === 'exact');
  expect('у найденного поставщика есть флаг «несколько в день»',
    supplySupplierFindIn_(sups, 'Магнум').multi === true && supplySupplierFindIn_(sups, 'Qazmeatproduct').multi === false);
  expect('двусмысленное название (два supplier_id) не принимается',
    supplySupplierFindIn_([sup('Kazfoods north', 1), sup('Kazfoods south', 2)], 'Kazfoods xorth') === null);

  // --- Тексты предупреждений ---
  var same = supplyJrnDupAskText_({ kind: 'same', entry: { sum: 26243.8, status: A }, entries: [] });
  expect('текст «точно такой же документ»', same === '⚠️ Точно такой же документ уже принят (сумма ' + supplyFmtNum_(26243.8) + ' ₸)');
  var other = supplyJrnDupAskText_({ kind: 'other', entry: { sum: 26243.8, status: A }, entries: [{ sum: 26243.8 }] });
  expect('текст «уже была поставка на … ₸»',
    other === '⚠️ В этот день от этого поставщика уже была поставка на ' + supplyFmtNum_(26243.8) + ' ₸. Это дополнительная поставка?');

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
