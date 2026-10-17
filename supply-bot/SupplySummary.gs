/**
 * Тексты и кнопки для сотрудника.
 *
 * Сводка:
 *   📄 {Источник} № {номер}
 *   {название} — {кол-во} {ед. склада}
 *   Итого {сумма} ₸
 *   ⚠️ … (только если проверка не прошла)
 * Заметки модели сотруднику не показываются (они уходят владельцу, см. SupplyFlow.gs).
 */

/** 12345.5 -> «12 345,5» (до 3 знаков, без хвостовых нулей). */
function supplyFmtNum_(n) {
  if (n === null || n === undefined) return '—';
  var s = String(Math.round(n * 1000) / 1000);
  var parts = s.split('.');
  var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return parts[1] ? intPart + ',' + parts[1] : intPart;
}

/** «1 позиция / 2 позиции / 5 позиций». */
function supplyPlural_(n, one, few, many) {
  var m10 = n % 10;
  var m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Шапка: «📄 Источник № номер» (для чека без номера — ФП); у запасного поставщика — «Поставщик: … (по умолчанию)». */
function supplyDocHeader_(doc) {
  var head = doc.sourceDefault
    ? '📄 Поставщик: ' + supplyEsc_(doc.source) + ' (по умолчанию)'
    : '📄 ' + supplyEsc_(doc.source);
  if (doc.doc_number) head += ' № ' + supplyEsc_(doc.doc_number);
  else if (doc.doc_type === 'receipt' && doc.fp) head += ' ФП ' + supplyEsc_(doc.fp);
  return head;
}

/** Сводка по состоянию документа (st.doc + st.match). */
function supplySummaryText_(st) {
  var doc = st.doc;
  var lines = [supplyDocHeader_(doc)];

  st.match.lines.forEach(function (l) {
    if (l.status !== 'ready') return; // «пропускать» и неготовые в сводку не попадают
    lines.push(supplyEsc_(l.name) + ' — ' + supplyFmtNum_(l.qtyWh) + (l.unit ? ' ' + supplyEsc_(l.unit) : '') +
      (l.rule ? ' (по правилу)' : ''));
  });

  lines.push('Итого ' + supplyFmtNum_(doc.total) + ' ₸');

  var warns = supplyMatchWarnings_(doc, st.match);
  if (warns.length) {
    lines.push('');
    warns.forEach(function (w) { lines.push('⚠️ ' + supplyEsc_(w)); });
  }

  var text = lines.join('\n');
  return text.length > 4000 ? text.substring(0, 3990) + '\n…' : text;
}

/** Нумерованный список позиций документа — подсказка для правки («2 15,5»). */
function supplyPositionsList_(st) {
  return st.match.lines.map(function (l) {
    var row = l.n + '. ' + supplyEsc_(l.docName) + ' — ' + supplyFmtNum_(l.item.qty) +
      (l.item.unit ? ' ' + supplyEsc_(l.item.unit) : '');
    if (l.entry && l.entry.mode === SUPPLY_CONST.MODE_PIECES && l.pieces) row += ' (' + l.pieces + ' шт)';
    return row;
  }).join('\n');
}

function supplySummaryKeyboard_(sid) {
  return [[
    { text: '✅ Верно', callback_data: 'sup:ok:' + sid },
    { text: '✏️ Исправить', callback_data: 'sup:edit:' + sid },
    { text: '❌ Отмена', callback_data: 'sup:cancel:' + sid }
  ]];
}

function supplyDiscrepancyKeyboard_(sid) {
  return [[
    { text: 'Да', callback_data: 'sup:dn:' + sid },
    { text: 'Есть расхождение', callback_data: 'sup:dy:' + sid }
  ]];
}
