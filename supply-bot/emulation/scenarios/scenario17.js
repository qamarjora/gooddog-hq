const h = require('../harness.js');
const { ctx, sent, setDoc, run, sheets, props, faults } = h;
let uid = 0;
function upd(u) { u.update_id = ++uid; try { return ctx.supplyProcessUpdate_(u); } catch (e) { console.log('THROWN', e.stack); } }
function texts(label) { console.log('--- ' + label); sent.splice(0).forEach(s => { if (s.p && s.p.text && s.method !== 'answerCallbackQuery') console.log('[' + s.method + ' → ' + s.p.chat_id + '] ' + s.p.text.replace(/\n/g, ' | ').substring(0, 330) + (s.p.reply_markup ? '  {' + s.p.reply_markup.inline_keyboard.flat().map(b => b.text).join(' / ') + '}' : '')); }); }
const cur = () => ctx.supplyStateGet_('111');
const press = (a, st, mid, chat) => upd({ callback_query: { id: 'c' + (++uid), data: 'sup:' + a + ':' + st.sid, from: { id: chat || 111 }, message: { message_id: mid, chat: { id: chat || 111 } } } });
const photo = (u) => upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, photo: [{ file_id: 'f' + u, file_unique_id: u, width: 900, height: 700 }] } });
run('supplyDirSheet_(); supplyPosterResolveIds(); supplySupSheet_(); supplyJrnSheet_();'); sent.length = 0;

console.log('=== 1. Скриншот заказа: поставщика нет, позиции и итог есть; строки «Закупки» на листе нет → спрашиваем владельца ===');
setDoc({ doc_type: 'receipt', source: null, doc_number: null, datetime: '2026-10-15', total: 7488, uncertain_fields: [], notes: null,
  items: [{ name: 'Coca-Cola 0.5 л', qty: 1, unit: 'шт', price: 289, sum: 289 }, { name: 'Coca-Cola 0.5 л', qty: 23, unit: 'шт', price: 313, sum: 7199 }] });
photo('S1'); let st = cur(); console.log('шаг:', st.step, '| источник:', st.doc.source, '| по умолчанию:', st.doc.sourceDefault, '| позиций:', st.doc.items.length, 'qty', st.doc.items[0].qty, 'sum', st.doc.items[0].sum);
texts('вопрос по поставщику');
upd({ callback_query: { id: 'c' + (++uid), data: 'sup:sp:' + st.sid + ':12', from: { id: 999 }, message: { message_id: st.ownerMsgId, chat: { id: 999 } } } });
console.log('лист «Поставщики»:', JSON.stringify(sheets['Поставщики'].getRange(1, 1, sheets['Поставщики'].getLastRow(), 4).getValues().slice(-1)));
st = cur(); console.log('шаг:', st.step); texts('вопрос по позиции');
upd({ callback_query: { id: 'c' + (++uid), data: 'sup:ic:' + st.sid + ':7', from: { id: 999 }, message: { message_id: st.ownerMsgId, chat: { id: 999 } } } });
st = cur(); console.log('шаг:', st.step); texts('сводка');

console.log('\n=== 2. Тот же поставщик по умолчанию в следующий раз: строка «Закупка» уже есть, вопросов по поставщику нет; сумма другая — не дубль («да») ===');
ctx.supplyStateClear_('111');
setDoc({ doc_type: 'receipt', source: '', doc_number: null, datetime: '2026-10-15', total: 1000, uncertain_fields: [], notes: null,
  items: [{ name: 'Coca-Cola 0.5 л', qty: 4, unit: 'шт', price: 250, sum: 1000 }] });
photo('S2'); st = cur(); console.log('шаг:', st.step, '| supplier:', st.match.supplier && st.match.supplier.id); texts('сводка');

console.log('\n=== 3. Чужое фото: ни поставщика, ни позиций ===');
ctx.supplyStateClear_('111');
setDoc({ doc_type: 'receipt', source: null, doc_number: null, datetime: '', total: null, uncertain_fields: [], notes: 'кошка', items: [] });
photo('S3'); texts('ответ'); console.log('состояние:', cur() ? 'есть' : 'нет');

console.log('\n=== 4. Тот же скриншот (file_unique_id) ===');
ctx.supplyStateClear_('111');
setDoc({ doc_type: 'receipt', source: null, items: [{ name: 'Coca-Cola 0.5 л', qty: 4, unit: 'шт', price: 250, sum: 1000 }], total: 1000 });
// сначала запишем документ из пункта 2 в журнал
photo('S2'); st = cur(); console.log('шаг:', st.step);
