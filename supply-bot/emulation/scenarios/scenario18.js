const h = require('../harness.js');
const { ctx, sent, setDoc, run, sheets, props, faults } = h;
let uid = 0;
function upd(u) { u.update_id = ++uid; try { return ctx.supplyProcessUpdate_(u); } catch (e) { console.log('THROWN', e.stack); } }
function texts(label) { console.log('--- ' + label); sent.splice(0).forEach(s => { if (s.p && s.p.text && s.method !== 'answerCallbackQuery') console.log('[' + s.method + ' → ' + s.p.chat_id + '] ' + s.p.text.replace(/\n/g, ' | ').substring(0, 420) + (s.p.reply_markup ? '  {' + s.p.reply_markup.inline_keyboard.flat().map(b => b.text).join(' / ') + '}' : '')); }); }
const cur = () => ctx.supplyStateGet_('111');
const tap = (data, from, mid) => upd({ callback_query: { id: 'c' + (++uid), data, from: { id: from }, message: { message_id: mid, chat: { id: from } } } });
const photo = (u) => upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, photo: [{ file_id: 'f' + u, file_unique_id: u, width: 900, height: 700 }] } });
run('supplyDirSheet_(); supplyPosterResolveIds(); supplySupSheet_(); supplyJrnSheet_(); supplyRulesSheet_();'); sent.length = 0;
sheets['Поставщики'].getRange(sheets['Поставщики'].getLastRow() + 1, 1, 1, 4).setValues([['Закупка', 12, 'Арбуз', 'да']]);
props.DRY_RUN = 'false';
const D = (items, total, source) => setDoc({ doc_type: 'receipt', source: source || null, doc_number: source ? '1' : null, datetime: '2026-10-15', total, uncertain_fields: [], notes: null, items });

console.log('=== 1. Кола по правилу, молоко из справочника: в одной поставке товар и ингредиент ===');
D([{ name: 'Coca-Cola 0,5 л', qty: 24, unit: 'шт', price: 312, sum: 7488 }, { name: 'Молоко Зенченко пастеризованное 3,2% 0,9 л', qty: 10, unit: 'шт', price: 50, sum: 500 }], 7988, 'Магнум');
photo('R1'); let st = cur(); console.log('шаг:', st.step); texts('сводка (по правилу)');
st = cur(); tap('sup:ok:' + st.sid, 111, st.msgId); st = cur(); tap('sup:dn:' + st.sid, 111, st.discMsgId); texts('запись');
console.log('payload:', JSON.stringify(faults.posterCalls[0].ingredient));
const d = sheets['Справочник накладных']; console.log('справочник, последняя строка (источник, название, id, Poster, ед., режим, ..., тип):', JSON.stringify(d.getRange(d.getLastRow(), 1, 1, 14).getValues()[0].filter((v, i) => [0,1,2,3,4,5,13].includes(i))));

console.log('\n=== 2. Следующий раз та же кола — уже из справочника, без пометки ===');
faults.posterCalls.length = 0; ctx.supplyStateClear_('111');
D([{ name: 'Coca-Cola 0,5 л', qty: 6, unit: 'шт', price: 320, sum: 1920 }], 1920);
photo('R2'); st = cur(); console.log('шаг:', st.step); texts('сводка');

console.log('\n=== 3. «2 другое»: сотрудник отвергает правило → вопрос владельцу ===');
ctx.supplyStateClear_('111');
D([{ name: 'Fanta 0,5 л', qty: 12, unit: 'шт', price: 300, sum: 3600 }], 3600);
photo('R3'); st = cur(); console.log('шаг:', st.step); sent.length = 0;
tap('sup:edit:' + st.sid, 111, st.msgId); upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, text: '1 другое' } });
st = cur(); console.log('шаг:', st.step, '| вопрос владельцу?', !!st.ownerMsgId); texts('после «1 другое»');

console.log('\n=== 4. Швепс: исключение — спросить владельца, список только ингредиентов ===');
ctx.supplyStateClear_('111');
D([{ name: 'Schweppes Cola 0,33 л', qty: 12, unit: 'шт', price: 400, sum: 4800 }], 4800);
photo('R4'); st = cur(); console.log('шаг:', st.step); texts('вопрос по швепс');

console.log('\n=== 5. Сок 1 л и вода 1,5 л — правила не применяются ===');
ctx.supplyStateClear_('111');
D([{ name: 'Сок апельсиновый 1 л', qty: 6, unit: 'шт', price: 500, sum: 3000 }], 3000);
photo('R5'); st = cur(); console.log('шаг:', st.step); sent.length = 0;
ctx.supplyStateClear_('111');
D([{ name: 'Пико яблоко 0,2 л', qty: 30, unit: 'шт', price: 100, sum: 3000 }, { name: 'BonAqua 0,5 л', qty: 24, unit: 'шт', price: 120, sum: 2880 }], 5880);
photo('R6'); st = cur(); console.log('шаг:', st.step); texts('пико и вода по правилам');
