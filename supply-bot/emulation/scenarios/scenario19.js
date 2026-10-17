const h = require('../harness.js');
const { ctx, sent, setDoc, run, sheets, props, faults } = h;
let uid = 0;
function upd(u) { u.update_id = ++uid; try { return ctx.supplyProcessUpdate_(u); } catch (e) { console.log('THROWN', e.stack); } }
const cur = () => ctx.supplyStateGet_('111');
const tap = (data, from, mid) => upd({ callback_query: { id: 'c' + (++uid), data, from: { id: from }, message: { message_id: mid, chat: { id: from } } } });
const photo = (u) => upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, photo: [{ file_id: 'f' + u, file_unique_id: u, width: 900, height: 700 }] } });
run('supplyDirSheet_(); supplyPosterResolveIds(); supplySupSheet_(); supplyJrnSheet_(); supplyRulesSheet_();'); sent.length = 0;
sheets['Поставщики'].getRange(sheets['Поставщики'].getLastRow() + 1, 1, 1, 4).setValues([['Закупка', 12, 'Арбуз', 'да']]);
props.DRY_RUN = 'false';
function doc(items, total) { setDoc({ doc_type: 'receipt', source: null, doc_number: null, datetime: '2026-10-15', total, uncertain_fields: [], notes: null, items }); }
doc([{ name: 'Вода питьевая BonAqua 1,5 л', qty: 12, unit: 'шт', price: 200, sum: 2400 }, { name: 'Вода Aqua 0,5 л', qty: 24, unit: 'шт', price: 100, sum: 2400 }, { name: 'Sprite 1 л', qty: 6, unit: 'шт', price: 400, sum: 2400 }, { name: 'Пико вишня 0,2 л', qty: 30, unit: 'шт', price: 80, sum: 2400 }], 9600);
photo('W1'); let st = cur(); console.log('шаг:', st.step);
console.log(st.match.lines.map(l => l.name + ' ' + l.qtyWh + ' ' + l.unit + (l.rule ? ' (по правилу ' + l.rule.word + ')' : '')).join('\n'));
tap('sup:ok:' + st.sid, 111, st.msgId); st = cur(); tap('sup:dn:' + st.sid, 111, st.discMsgId);
console.log('payload:', JSON.stringify(faults.posterCalls[0].ingredient));
// Владелец выбирает товар из списка для нового незнакомого названия — без вопросов про режим
ctx.supplyStateClear_('111');
doc([{ name: 'Нектар Rich тетра', qty: 10, unit: 'л', price: 300, sum: 3000 }], 3000);
photo('W2'); st = cur(); console.log('шаг:', st.step);
tap('sup:ic:' + st.sid + ':p22', 999, st.ownerMsgId); st = cur();
console.log('после выбора товара «Вода» владельцем (единица документа «л», у товара «шт»): шаг', st.step, '|', st.match.lines[0].qtyWh, st.match.lines[0].unit);
const d = sheets['Справочник накладных']; console.log('справочник:', JSON.stringify(d.getRange(d.getLastRow(), 1, 1, 14).getValues()[0].filter((v, i) => [1,2,3,4,5,6,13].includes(i))));
