// Сценарий 20: накладная «Рэд Машин» (цена без НДС, сумма с НДС 16%) и хлеб в разные дни.
const h = require('../harness.js');
const { ctx, sent, setDoc, run, sheets, props, faults, clock } = h;
let uid = 0;
function upd(u) { u.update_id = ++uid; try { return ctx.supplyProcessUpdate_(u); } catch (e) { console.log('THROWN', e.stack); } }
const cur = () => ctx.supplyStateGet_('111');
const tap = (data, from, mid) => upd({ callback_query: { id: 'c' + (++uid), data, from: { id: from }, message: { message_id: mid, chat: { id: from } } } });
const photo = (u) => upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, photo: [{ file_id: 'f' + u, file_unique_id: u, width: 900, height: 700 }] } });
run('supplyDirSheet_(); supplyPosterResolveIds(); supplySupSheet_(); supplyJrnSheet_(); supplyRulesSheet_();'); sent.length = 0;
const sup = sheets['Поставщики'];
sup.getRange(sup.getLastRow() + 1, 1, 1, 4).setValues([['Рэд Машин Астана', 14, '', 'нет']]);
sup.getRange(sup.getLastRow() + 1, 1, 1, 4).setValues([['Хлебозавод', 15, '', 'нет']]);
const dir = sheets['Справочник накладных'];
function dirRow(src, name, pname, ptype) { dir.getRange(dir.getLastRow() + 1, 1, 1, 14).setValues([[src, name, '', pname, 'шт', 'прямо', 1, '', '', 0, '', '', '', ptype || '']]); }
['Кола стекло 250мл', 'Кола ПЭТ 500мл', 'Кола Зеро ПЭТ 500', 'Фьюс Манго ПЭТ 500мл', 'Фьюс Манго-Ананас ПЭТ 500мл', 'Фьюс Ягоды ПЭТ 500мл'].forEach(n => dirRow('Рэд Машин Астана', n, 'Напитки', 'товар'));
dirRow('Рэд Машин Астана', 'Бонаква негаз ПЭТ 500мл', 'Вода', 'товар');
dirRow('Хлебозавод', 'Булочка для хот-дога', 'булочка для хот-дога');
run('supplyPosterResolveIds();'); sent.length = 0;
props.DRY_RUN = 'false';
function texts() { const t = sent.filter(s => s.method === 'sendMessage' || s.method === 'editMessageText').map(s => (s.p.chat_id || '') + ' | ' + s.p.text.replace(/\n/g, ' / ')); sent.length = 0; return t; }

console.log('=== A. Рэд Машин, цены без НДС ===');
setDoc({ doc_type: 'invoice', source: 'Рэд Машин Астана', doc_number: '0011301272', datetime: '2026-10-15', total: 90312, uncertain_fields: [], notes: null, items: [
  { name: 'Кола стекло 250мл', qty: 1, unit: 'шт', price: 9227.59, sum: 10704 },
  { name: 'Кола ПЭТ 500мл', qty: 4, unit: 'шт', price: 8296.55, sum: 38496 },
  { name: 'Кола Зеро ПЭТ 500', qty: 2, unit: 'шт', price: 4148.28, sum: 9624 },
  { name: 'Бонаква негаз ПЭТ 500мл', qty: 1, unit: 'шт', price: 4986.21, sum: 5784 },
  { name: 'Фьюс Манго ПЭТ 500мл', qty: 2, unit: 'шт', price: 3693.1, sum: 8568 },
  { name: 'Фьюс Манго-Ананас ПЭТ 500мл', qty: 2, unit: 'шт', price: 3693.1, sum: 8568 },
  { name: 'Фьюс Ягоды ПЭТ 500мл', qty: 2, unit: 'шт', price: 3693.1, sum: 8568 }] });
photo('RM1'); let st = cur();
console.log('шаг:', st && st.step); console.log(texts().join('\n'));
if (st && st.step === 'confirm') { tap('sup:ok:' + st.sid, 111, st.msgId); st = cur(); console.log(texts().join('\n')); if (st) { tap('sup:dn:' + st.sid, 111, st.discMsgId); console.log(texts().join('\n')); } }
console.log('Poster вызовов:', faults.posterCalls.length);

console.log('\n=== B. Хлеб: день 1, потом день 2 (та же сумма) ===');
let breadN = 0;
function bread() { setDoc({ doc_type: 'invoice', source: 'Хлебозавод', doc_number: 'Н-' + (++breadN), datetime: null, total: 6000, uncertain_fields: [], notes: null, items: [{ name: 'Булочка для хот-дога', qty: 50, unit: 'шт', price: 120, sum: 6000 }] }); }
bread(); photo('B1'); st = cur(); console.log('день 1, шаг:', st && st.step); console.log(texts().join('\n'));
if (st && st.step === 'owner_item') { console.log('(владельца спросили про позицию — пропускаем)'); }
if (st && st.step === 'confirm') { tap('sup:ok:' + st.sid, 111, st.msgId); st = cur(); if (st) tap('sup:dn:' + st.sid, 111, st.discMsgId); console.log(texts().join('\n')); }
clock.offset = 24 * 3600 * 1000; ctx.__offset = clock.offset;
bread(); photo('B2'); st = cur(); console.log('день 2, шаг:', st && st.step); console.log(texts().join('\n'));
