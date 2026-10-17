// Регрессионные сценарии с проверками (завершается с кодом 1, если что-то не так).
// Запуск: node emulation/scenarios/check-regression.js
const h = require('../harness.js');
const { ctx, sent, setDoc, run, sheets, props, faults, clock } = h;
let uid = 0, fails = 0, total = 0;
function upd(u) { u.update_id = ++uid; try { return ctx.supplyProcessUpdate_(u); } catch (e) { console.log('THROWN', e.stack); fails++; } }
const cur = () => ctx.supplyStateGet_('111');
const tap = (data, from, mid) => upd({ callback_query: { id: 'c' + (++uid), data, from: { id: from }, message: { message_id: mid, chat: { id: from } } } });
const photo = (u) => upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, photo: [{ file_id: 'f' + u, file_unique_id: u, width: 900, height: 700 }] } });
function ok(name, cond) { total++; if (!cond) fails++; console.log((cond ? 'OK   ' : 'FAIL ') + name); }
// Сообщения за шаг: новые (sendMessage) по адресатам и правки.
function take() {
  const msgs = sent.filter(s => s.method === 'sendMessage').map(s => ({ to: String(s.p.chat_id), text: String(s.p.text) }));
  const edits = sent.filter(s => s.method === 'editMessageText').map(s => ({ to: String(s.p.chat_id), text: String(s.p.text) }));
  sent.length = 0;
  return { toOwner: msgs.filter(m => m.to === '999'), toEmp: msgs.filter(m => m.to === '111'), edits };
}
const log = console.log; console.log = () => {}; // глушим диагностику самого бота
run('supplyDirSheet_(); supplyPosterResolveIds(); supplySupSheet_(); supplyJrnSheet_(); supplyRulesSheet_();');
console.log = log; sent.length = 0;

const sup = sheets['Поставщики'];
const addSup = (n, id, multi) => sup.getRange(sup.getLastRow() + 1, 1, 1, 4).setValues([[n, id, '', multi || 'нет']]);
addSup('Рэд Машин Астана', 14); addSup('Хлебозавод', 15); addSup('Овощи Базар', 16, 'да');
const dir = sheets['Справочник накладных'];
function dirRow(src, name, pname, ptype) { dir.getRange(dir.getLastRow() + 1, 1, 1, 14).setValues([[src, name, '', pname, 'шт', 'прямо', 1, '', '', 0, '', '', '', ptype || '']]); }
['Кола стекло 250мл', 'Кола ПЭТ 500мл', 'Кола Зеро ПЭТ 500', 'Фьюс Манго ПЭТ 500мл', 'Фьюс Манго-Ананас ПЭТ 500мл', 'Фьюс Ягоды ПЭТ 500мл']
  .forEach(n => dirRow('Рэд Машин Астана', n, 'Напитки', 'товар'));
dirRow('Рэд Машин Астана', 'Бонаква негаз ПЭТ 500мл', 'Вода', 'товар');
dirRow('Хлебозавод', 'Булочка для хот-дога', 'булочка для хот-дога');
dirRow('Овощи Базар', 'Огурцы', 'огурцы');
console.log = () => {}; run('supplyPosterResolveIds();'); console.log = log; sent.length = 0;
props.DRY_RUN = 'false';

let docN = 0;
function mk(source, items, total) { setDoc({ doc_type: 'invoice', source, doc_number: 'T-' + (++docN), datetime: null, total, uncertain_fields: [], notes: null, items }); }
function accept(st) { tap('sup:ok:' + st.sid, 111, st.msgId); }
function day(n) { clock.offset = n * 86400000; ctx.__offset = clock.offset; }
const rm = () => mk('Рэд Машин Астана', [
  { name: 'Кола стекло 250мл', qty: 1, unit: 'шт', price: 9227.59, sum: 10704 }, { name: 'Кола ПЭТ 500мл', qty: 4, unit: 'шт', price: 8296.55, sum: 38496 },
  { name: 'Кола Зеро ПЭТ 500', qty: 2, unit: 'шт', price: 4148.28, sum: 9624 }, { name: 'Бонаква негаз ПЭТ 500мл', qty: 1, unit: 'шт', price: 4986.21, sum: 5784 },
  { name: 'Фьюс Манго ПЭТ 500мл', qty: 2, unit: 'шт', price: 3693.1, sum: 8568 }, { name: 'Фьюс Манго-Ананас ПЭТ 500мл', qty: 2, unit: 'шт', price: 3693.1, sum: 8568 },
  { name: 'Фьюс Ягоды ПЭТ 500мл', qty: 2, unit: 'шт', price: 3693.1, sum: 8568 }], 90312);
const bread = (price) => mk('Хлебозавод', [{ name: 'Булочка для хот-дога', qty: 50, unit: 'шт', price, sum: 50 * price }], 50 * price);

// 1. Рэд Машин: цена без НДС, сумма с НДС
rm(); photo('RM1'); let st = cur(); let m = take();
ok('1. Рэд Машин: сводка без ⚠️', st.step === 'confirm' && !m.edits.concat(m.toEmp).some(x => x.text.indexOf('⚠️') !== -1));
ok('1. Рэд Машин: владельцу ничего до подтверждения', m.toOwner.length === 0);
accept(st); m = take();
ok('1. Рэд Машин: после ✅ сразу «✅ Принято · 90 312 ₸», без вопроса «Фактически всё совпало?»',
  m.toEmp.length === 1 && m.toEmp[0].text === '✅ Принято · ' + ctx.supplyFmtNum_(90312) + ' ₸');
ok('1. Рэд Машин: владельцу ничего (чистый документ)', m.toOwner.length === 0);
const posted = faults.posterCalls[faults.posterCalls.length - 1].ingredient;
const postedSum = posted.reduce((a, r) => a + r.num * r.sum, 0);
ok('1. Рэд Машин: итог в Poster = итогу накладной (' + postedSum.toFixed(2) + ')', Math.abs(postedSum - 90312) < 0.5 && posted.length === 7);
ok('1. Рэд Машин: состояние очищено', cur() === null || cur() === undefined);

// 2. Хлеб: каждый день, одна и та же сумма
day(0); bread(120); photo('B1'); st = cur(); take(); accept(st); take();
day(1); bread(120); photo('B2'); st = cur(); m = take();
ok('2. хлеб, день 2, та же сумма: без вопроса про дубль', st && st.step === 'confirm');
accept(st); m = take();
day(2); bread(120); photo('B3'); st = cur(); take();
ok('2. хлеб, день 3, та же сумма: без вопроса про дубль', st && st.step === 'confirm');
accept(st); take();

// 3. Тот же снимок отправлен повторно — вопрос остаётся
photo('B3'); st = cur(); m = take();
ok('3. тот же снимок второй раз: вопрос «Этот снимок уже отправлялся»', st && st.step === 'dup');
tap('sup:dcancel:' + st.sid, 111, st.msgId); take();

// 4. Тот же поставщик, второй документ в тот же день — спрашивает (дубль по ключу)
bread(120); photo('B4'); st = cur(); m = take();
ok('4. второй документ в тот же день с той же суммой: вопрос про дубль', st && st.step === 'dup');
tap('sup:dcancel:' + st.sid, 111, st.msgId); take();

// 5. Скачок цены (+33%) — ⚠️ и сообщение владельцу; +17% — тихо
day(3); bread(160); photo('B5'); st = cur(); m = take();
ok('5. цена +33%: ⚠️ в сводке', st && m.edits.concat(m.toEmp).some(x => x.text.indexOf('⚠️') !== -1));
ok('5. цена +33%: владельцу одно короткое сообщение', m.toOwner.length === 1);
accept(st); take();
day(4); bread(140); photo('B6'); st = cur(); m = take();
ok('5. цена ≈ +17% к последней (160 → 140 это −12%): без ⚠️ и без сообщения владельцу',
  st && !m.edits.concat(m.toEmp).some(x => x.text.indexOf('⚠️') !== -1) && m.toOwner.length === 0);
accept(st); take();

// 6. Незнакомая позиция — владельцу вопрос (исключение остаётся)
day(5); mk('Хлебозавод', [{ name: 'Батон нарезной', qty: 10, unit: 'шт', price: 200, sum: 2000 }], 2000); photo('N1'); st = cur(); m = take();
ok('6. новая позиция: вопрос владельцу, сотруднику «передано владельцу»', st && st.step === 'owner_item' && m.toOwner.length === 1);
ctx.supplyStateClear_('111'); take();

// 7. Настоящая ошибка в накладной: сумма строк не равна итогу — ⚠️ и остановка записи
day(6); mk('Хлебозавод', [{ name: 'Булочка для хот-дога', qty: 50, unit: 'шт', price: 120, sum: 6000 }], 9000); photo('S1'); st = cur(); m = take();
ok('7. сумма строк ≠ итог: ⚠️ в сводке', st && m.edits.concat(m.toEmp).some(x => x.text.indexOf('⚠️') !== -1));
const callsBefore = faults.posterCalls.length;
accept(st); take();
ok('7. сумма строк ≠ итог: в Poster ничего не ушло', faults.posterCalls.length === callsBefore);
ctx.supplyStateClear_('111'); take();

// 8. Ошибка Poster: владельцу сообщение, сотруднику «Передано владельцу»
day(7); faults.poster = 'error'; bread(120); photo('E1'); st = cur(); take(); accept(st); m = take();
ok('8. ошибка Poster: сотруднику «Передано владельцу», владельцу одно сообщение с ошибкой',
  m.toEmp.length === 1 && m.toEmp[0].text === 'Передано владельцу' && m.toOwner.length === 1 && m.toOwner[0].text.indexOf('Poster не принял') !== -1);
faults.poster = 'ok';
bread(120); photo('E2'); st = cur(); take();
ok('8. после ошибки Poster документ можно отправить заново без вопроса про дубль', st && st.step === 'confirm');
accept(st); take();

// 9. Настройки: вернуть вопрос «Фактически всё совпало?» и 7-дневную проверку
day(8); props.SUPPLY_ASK_ACTUAL = 'true'; bread(120); photo('A1'); st = cur(); take(); accept(st); m = take();
ok('9. SUPPLY_ASK_ACTUAL=true: вопрос «Фактически всё совпало?» возвращается', m.toEmp.some(x => x.text.indexOf('Фактически всё совпало') !== -1));
tap('sup:dn:' + cur().sid, 111, cur().discMsgId); take(); props.SUPPLY_ASK_ACTUAL = 'false';
day(9); props.SUPPLY_RECENT_CHECK = 'true'; bread(120); photo('A2'); st = cur(); take();
ok('9. SUPPLY_RECENT_CHECK=true: старая проверка «за 7 дней» работает', st && st.step === 'dup');
tap('sup:dcancel:' + st.sid, 111, st.msgId); take(); props.SUPPLY_RECENT_CHECK = 'false';

// 10. Вечерний отчёт
day(10); bread(120); photo('D1'); st = cur(); take(); accept(st); take();
const dText = ctx.supplyDigest(ctx.Date.now()); m = take();
ok('10. вечерний отчёт: одно сообщение владельцу, есть «Хлебозавод»', m.toOwner.length === 1 && dText.indexOf('Хлебозавод') !== -1);
day(30); ok('10. вечерний отчёт: в день без поставок сообщения нет', ctx.supplyDigest(ctx.Date.now()) === '' && take().toOwner.length === 0);

console.log('\nСценариев-проверок: ' + total + ', провалено: ' + fails);
process.exit(fails ? 1 : 0);
