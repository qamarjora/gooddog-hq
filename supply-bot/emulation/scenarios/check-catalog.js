// Сценарии по каталогу Poster: режимы «спросить количество / упаковку», «банки», упаковки товаров («1 X 24»), приоритет каталога.
// Запуск: node emulation/scenarios/check-catalog.js
const h = require('../harness.js');
const { ctx, sent, setDoc, run, sheets, props, faults } = h;
let uid = 0, fails = 0, total = 0;
function upd(u) { u.update_id = ++uid; try { return ctx.supplyProcessUpdate_(u); } catch (e) { console.log('THROWN', e.stack); fails++; } }
const cur = () => ctx.supplyStateGet_('111');
const tap = (data, from, mid) => upd({ callback_query: { id: 'c' + (++uid), data, from: { id: from }, message: { message_id: mid, chat: { id: from } } } });
const photo = (u) => upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, photo: [{ file_id: 'f' + u, file_unique_id: u, width: 900, height: 700 }] } });
const say = (t) => upd({ message: { message_id: ++uid, chat: { id: 111, type: 'private' }, from: { id: 111 }, text: t } });
function ok(name, cond) { total++; if (!cond) fails++; console.log((cond ? 'OK   ' : 'FAIL ') + name); }
function take() {
  const msgs = sent.filter(s => s.method === 'sendMessage').map(s => ({ to: String(s.p.chat_id), text: String(s.p.text) }));
  const edits = sent.filter(s => s.method === 'editMessageText').map(s => ({ to: String(s.p.chat_id), text: String(s.p.text) }));
  sent.length = 0;
  return { toOwner: msgs.filter(m => m.to === '999'), toEmp: msgs.filter(m => m.to === '111'), edits, all: msgs.concat(edits).map(x => x.text).join('\n') };
}
const log = console.log; console.log = () => {};
run('supplyDirSheet_(); supplyPosterResolveIds(); supplySupSheet_(); supplyJrnSheet_(); supplyRulesSheet_();');
console.log = log; sent.length = 0;

const sup = sheets['Поставщики'];
['Рэд Машин Астана', 'Магнум'].forEach((n, i) => sup.getRange(sup.getLastRow() + 1, 1, 1, 4).setValues([[n, 14 + i, '', 'да']]));
const dir = sheets['Справочник накладных'];
function dirRow(src, name, pname, ptype, unit) { dir.getRange(dir.getLastRow() + 1, 1, 1, 14).setValues([[src, name, '', pname, unit || 'шт', 'прямо', 1, '', '', 0, '', '', '', ptype || '']]); }
dirRow('Рэд Машин Астана', 'Бонаква негаз ПЭТ 500мл', 'Вода', 'товар');
dirRow('Рэд Машин Астана', 'Сок детский яблоко 0,2', 'Детский сок', 'товар');
dirRow('Магнум', 'Кетчуп Хайнц', 'кетчуп', '', 'кг');
dirRow('Магнум', 'Чай зелёный 100 пак', 'чай зеленый пак');
dirRow('Магнум', 'Огурцы маринованные банка', 'халапеньо', '', 'кг');
dirRow('Магнум', 'Молоко 0,9 л', 'молоко', '', 'л');
console.log = () => {}; run('supplyPosterResolveIds();'); console.log = log; sent.length = 0;
props.DRY_RUN = 'false';

// Каталог Poster: ответы владельца (ингредиенты 4 молоко, 8 кетчуп, 9 чай, 10 халапеньо).
const cat = ctx.SpreadsheetApp.getActive().insertSheet('Каталог Poster');
const L = { direct: '1 к 1 (в накладной те же единицы, что на складе)', coef: 'пересчёт (в накладной упаковки, на складе штуки/литры/кг)',
  qty: 'спросить количество при приёме (бот спросит, сколько кг/л)', pack: 'спросить размер упаковки при приёме (сколько шт/кг/л в упаковке)', jars: 'банки: бот спросит чистый вес одной банки' };
const catRows = [
  ['ингредиент', 4, 'Молоко', '', 'л', L.coef, '0,9', '', ''],
  ['ингредиент', 8, 'Кетчуп', '', 'кг', L.qty, '', 'соусы вручную', ''],
  ['ингредиент', 9, 'Чай зеленый пак', '', 'шт', L.pack, '', '', ''],
  ['ингредиент', 10, 'Халапеньо', '', 'кг', L.jars, '', '', ''],
  ['товар', 22, 'Вода', 'Напитки', 'шт', L.direct, '', '', ''],
  ['товар', 21, 'Детский сок', 'Напитки', 'шт', L.direct, '', '', '']
];
cat.getRange(1, 1, 1, 9).setValues([['вид', 'id', 'название', 'категория', 'ед.', 'как считаем', 'коэффициент', 'заметка', 'знаем']]);
cat.getRange(2, 1, catRows.length, 9).setValues(catRows);

let n = 0;
function mk(source, items, total) { setDoc({ doc_type: 'invoice', source, doc_number: 'C-' + (++n), datetime: null, total, uncertain_fields: [], notes: null, items }); }
let st, m;

// 1. Упаковки товаров: «1 X 24» → 24 шт, «1 X 18» → 18 шт; цена за штуку = сумма ÷ штуки
mk('Рэд Машин Астана', [
  { name: 'Бонаква негаз ПЭТ 500мл', qty: 1, unit: 'шт', price: 4986.21, sum: 5784, pack: 24 },
  { name: 'Сок детский яблоко 0,2', qty: 2, unit: 'шт', price: 3000, sum: 6000, pack: 18 }], 11784);
photo('P1'); st = cur(); m = take();
ok('1. упаковки: сводка «Вода — 24 шт (1 × 24)» и «Детский сок — 36 шт (2 × 18)»',
  st.step === 'confirm' && m.all.indexOf('24 шт (1 × 24)') !== -1 && m.all.indexOf('36 шт (2 × 18)') !== -1);
ok('1. упаковки: в состоянии qtyWh 24 и 36, цена за штуку 241 и 166,67',
  st.match.lines[0].qtyWh === 24 && st.match.lines[1].qtyWh === 36 && Math.abs(st.match.lines[0].unitPriceWh - 241) < 0.01 && Math.abs(st.match.lines[1].unitPriceWh - 166.667) < 0.01);
tap('sup:ok:' + st.sid, 111, st.msgId); take();
const lastCall = JSON.stringify(faults.posterCalls[faults.posterCalls.length - 1]);
ok('1. упаковки: в Poster ушло 24 и 36 штук', /"num":24\b/.test(lastCall) && /"num":36\b/.test(lastCall));

// 2. Товар без размера упаковки в документе — считается как раньше (штуки из документа)
mk('Рэд Машин Астана', [{ name: 'Бонаква негаз ПЭТ 500мл', qty: 24, unit: 'шт', price: 241, sum: 5784 }], 5784);
photo('P2'); st = cur(); m = take();
ok('2. без pack в документе: 24 шт как в документе, без «×»', st.step === 'confirm' && st.match.lines[0].qtyWh === 24 && m.all.indexOf('×') === -1);
tap('sup:ok:' + st.sid, 111, st.msgId); take();

// 3. Кетчуп: справочник накладных говорит «прямо», каталог — «спросить количество» (каталог сильнее)
mk('Магнум', [{ name: 'Кетчуп Хайнц', qty: 6, unit: 'шт', price: 900, sum: 5400 }], 5400);
photo('K1'); st = cur(); m = take();
ok('3. кетчуп: бот спрашивает «Сколько кг получили всего?»', st.step === 'pieces' && m.all.indexOf('Сколько кг получили всего') !== -1);
say('abc'); m = take();
ok('3. кетчуп: нечисловой ответ — повторный вопрос, шаг не меняется', cur().step === 'pieces' && m.toEmp.length === 1);
say('5,4'); st = cur(); m = take();
ok('3. кетчуп: ответ 5,4 → «Кетчуп — 5,4 кг», цена за кг 1000', st.step === 'confirm' && m.all.indexOf('5,4 кг') !== -1 && Math.abs(st.match.lines[0].unitPriceWh - 1000) < 0.01);
tap('sup:ok:' + st.sid, 111, st.msgId); take();

// 4. Чай: «спросить упаковку» → 3 уп. × 100 = 300 шт
mk('Магнум', [{ name: 'Чай зелёный 100 пак', qty: 3, unit: 'шт', price: 1000, sum: 3000 }], 3000);
photo('T1'); st = cur(); m = take();
ok('4. чай: бот спрашивает «Сколько шт в одной упаковке?»', st.step === 'pieces' && m.all.indexOf('в одной упаковке') !== -1);
say('100'); st = cur(); m = take();
ok('4. чай: 3 × 100 → 300 шт', st.step === 'confirm' && st.match.lines[0].qtyWh === 300 && m.all.indexOf('300 шт') !== -1);
tap('sup:ok:' + st.sid, 111, st.msgId); take();

// 5. Банки: вес банки 0,5, банок как в документе (12) → 6 кг; с числом банок «0,5 10» → 5 кг
mk('Магнум', [{ name: 'Огурцы маринованные банка', qty: 12, unit: 'шт', price: 500, sum: 6000 }], 6000);
photo('J1'); st = cur(); m = take();
ok('5. банки: вопрос про чистый вес одной банки', st.step === 'pieces' && m.all.indexOf('Чистый вес одной банки') !== -1);
say('0,5'); st = cur(); take();
ok('5. банки: 0,5 × 12 банок = 6 кг', st.step === 'confirm' && st.match.lines[0].qtyWh === 6);
tap('sup:cancel:' + st.sid, 111, st.msgId); take(); ctx.supplyStateClear_('111');
mk('Магнум', [{ name: 'Огурцы маринованные банка', qty: 12, unit: 'шт', price: 500, sum: 6000 }], 6000);
photo('J2'); take(); say('0,5 10'); st = cur(); take();
ok('5. банки: «0,5 10» → 5 кг', st.step === 'confirm' && st.match.lines[0].qtyWh === 5);
tap('sup:edit:' + st.sid, 111, st.msgId); take(); say('1 шт 0,4 10'); st = cur(); take();
ok('5. банки: правка «1 шт 0,4 10» → 4 кг', st.step === 'confirm' && st.match.lines[0].qtyWh === 4);
tap('sup:ok:' + st.sid, 111, st.msgId); take();

// 6. Молоко: справочник «прямо ×1», каталог «пересчёт 0,9» → 10 шт = 9 л
mk('Магнум', [{ name: 'Молоко 0,9 л', qty: 10, unit: 'шт', price: 450, sum: 4500 }], 4500);
photo('M1'); st = cur(); take();
ok('6. молоко: каталог сильнее справочника, 10 × 0,9 = 9 л', st.step === 'confirm' && st.match.lines[0].qtyWh === 9);
tap('sup:ok:' + st.sid, 111, st.msgId); take();

// 7. Новая позиция: владелец выбирает ингредиент, у которого в каталоге уже есть режим — вопрос «как пересчитывать» не задаётся
mk('Магнум', [{ name: 'Кетчуп томатный острый', qty: 4, unit: 'шт', price: 800, sum: 3200 }], 3200);
photo('N1'); st = cur(); take();
ok('7. новая позиция: ждёт владельца', st.step === 'owner_item');
tap('sup:ic:' + st.sid + ':i8', 999, 5); m = take();
ok('7. выбран «Кетчуп»: режим из каталога, вопрос «Как пересчитывать» не задаётся',
  m.all.indexOf('Как пересчитывать') === -1 && cur().step === 'pieces');
ok('7. в справочник записан режим «спросить количество»',
  ctx.supplyDirLoad_().some(e => e.name === 'Кетчуп томатный острый' && e.mode === 'спросить количество'));

// 8. Бариста ошибся в ответе (54 вместо 5,4 кг): в сводке ⚠️ про цену, а владельцу сообщение — только после подтверждения
mk('Магнум', [{ name: 'Кетчуп Хайнц', qty: 6, unit: 'шт', price: 950, sum: 5700 }], 5700);
photo('K2'); take(); say('54'); st = cur(); m = take();
ok('8. ошибка бариста: в сводке ⚠️ про цену за кг и просьба проверить', st.step === 'confirm' && m.all.indexOf('⚠️') !== -1 && m.all.indexOf('Проверьте строки') !== -1);
ok('8. ошибка бариста: до подтверждения владельцу ничего', m.toOwner.length === 0);
tap('sup:ok:' + st.sid, 111, st.msgId); m = take();
ok('8. ошибка бариста: после подтверждения владельцу сообщение с цифрами', m.toOwner.length === 1 && m.toOwner[0].text.indexOf('цена') !== -1);
// 9. Бариста сам заметил и исправил (5,4) до подтверждения — владельцу тишина
mk('Магнум', [{ name: 'Кетчуп Хайнц', qty: 6, unit: 'шт', price: 933, sum: 5600 }], 5600);
photo('K3'); take(); say('54'); st = cur(); take();
tap('sup:edit:' + st.sid, 111, st.msgId); take(); say('1 шт 5,4'); st = cur(); take();
tap('sup:ok:' + st.sid, 111, st.msgId); m = take();
ok('9. бариста исправил ответ до подтверждения: владельцу сообщения нет', st.step === 'confirm' && m.toOwner.length === 0);

console.log('\nСценариев по каталогу: ' + total + ', провалено: ' + fails);
process.exit(fails ? 1 : 0);
