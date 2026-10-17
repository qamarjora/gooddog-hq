// Мини-эмуляция Apps Script: листы в памяти, свойства, кэш, Telegram/Claude/Poster заглушки.
// Все значения (токены, ключи, chat id, id поставщиков и ингредиентов) — вымышленные тестовые.
const fs = require('fs'), vm = require('vm'), path = require('path');
// Исходники бота лежат в родительской папке (supply-bot/).
const dir = path.resolve(__dirname, '..');

function makeSheet(name) {
  const grid = [];
  const sh = {
    name, hidden: false,
    getLastRow() { for (let r = grid.length; r >= 1; r--) if ((grid[r-1]||[]).some(v => v !== '' && v !== undefined && v !== null)) return r; return 0; },
    getRange(a, b, c, d) {
      let r, col, nr, nc;
      if (typeof a === 'string') { r = 1; col = 1; nr = Math.max(this.getLastRow(), 1); nc = 1; }
      else { r = a; col = b; nr = c || 1; nc = d || 1; }
      const rng = {
        getValue() { const v = (grid[r-1] || [])[col-1]; return v === undefined ? '' : v; },
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (grid[r-1+i]||[])[col-1+j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
        setValue(v) { grid[r-1] = grid[r-1] || []; grid[r-1][col-1] = v; return rng; },
        setValues(vals) { vals.forEach((row, i) => { grid[r-1+i] = grid[r-1+i] || []; row.forEach((v, j) => { grid[r-1+i][col-1+j] = v; }); }); return rng; },
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (grid[r-1+i]) grid[r-1+i][col-1+j] = ''; return rng; },
        setNumberFormat() { return rng; }, setFontWeight() { return rng; }, setDataValidation() { return rng; }
      };
      return rng;
    },
    setFrozenRows() {}, setColumnWidth() {}, hideSheet() { this.hidden = true; }, deleteRow(r) { grid.splice(r-1, 1); }
  };
  return sh;
}
const sheets = {};
const props = { TELEGRAM_TOKEN_INVOICES: 'TEST_TELEGRAM_TOKEN', CLAUDE_API_KEY: 'TEST_CLAUDE_KEY', POSTER_TOKEN: 'TEST_POSTER_TOKEN', ALLOWED_CHAT_IDS: '111', SUPPLY_OWNER_CHAT_ID: '999', DRY_RUN: 'true' };
const sent = [];
let msgId = 100, uuidN = 0;
let claudeDoc = null;
const cacheStore = {};
const clock = { offset: 0, now() { return Date.now() + this.offset; } };
const faults = { telegramNetworkFailures: 0, telegramMatch: null, poster: 'ok', posterCalls: [] };

const ingredients = [[1,'бокс для хот-дога','p'],[2,'булочка для хот-дога','p'],[3,'сосиски','p'],[4,'молоко','l'],[5,'огурцы','kg'],[6,'томаты','kg'],[7,'пакет','p'],[8,'кетчуп','kg'],[9,'чай зеленый пак','p'],[10,'халапеньо','kg']]
  .map(([id,n,u]) => ({ ingredient_id: String(id), ingredient_name: n, ingredient_unit: u, ingredients_type: '1', delete: '0' }));
const suppliers = [[11,'DidarPlast'],[13,'Магнум'],[6,'Qazmeat'],[7,'Татым'],[12,'Арбуз']].map(([id,n]) => ({ supplier_id: String(id), supplier_name: n, delete: '0' }));

function resp(obj, code) { const t = JSON.stringify(obj); return { getResponseCode: () => code || 200, getContentText: () => t, getHeaders: () => ({}), getBlob: () => ({ getBytes: () => [1,2,3], setContentType() { return this; }, setName(n) { this.name = n; return this; } }) }; }
const DriveApp = new Proxy({}, { get() { throw new Error('DriveApp НЕ должен вызываться'); } });
const ctx = {
  console, DriveApp,
  SpreadsheetApp: {
    getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet(n)), getSpreadsheetTimeZone: () => 'Asia/Almaty' }),
    newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } })
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({
    get: k => { const e = cacheStore[k]; if (!e) return null; if (e.exp && e.exp <= clock.now()) { delete cacheStore[k]; return null; } return e.v; },
    put: (k, v, sec) => { cacheStore[k] = { v, exp: sec ? clock.now() + sec * 1000 : 0 }; },
    putAll: (o, sec) => { Object.keys(o).forEach(k => { cacheStore[k] = { v: o[k], exp: sec ? clock.now() + sec * 1000 : 0 }; }); },
    remove: k => { delete cacheStore[k]; }
  }) },
  LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Utilities: { getUuid: () => ('u' + (++uuidN) + '0000000').substring(0, 8), sleep() {}, base64Encode: () => 'AAAA', formatDate: () => '09.10.2026 14:30' },
  ScriptApp: { getOAuthToken: () => { throw new Error('getOAuthToken НЕ должен вызываться'); }, getProjectTriggers: () => [] },
  UrlFetchApp: {
    fetch(url, opts) {
      if (url.includes('/file/bot')) return resp({});
      if (url.includes('api.telegram.org')) {
        const method = url.split('/').pop();
        const p = opts && opts.payload ? JSON.parse(opts.payload) : {};
        if (faults.telegramNetworkFailures > 0 && method === 'sendMessage' && (!faults.telegramMatch || (p.text || '').includes(faults.telegramMatch))) {
          faults.telegramNetworkFailures--; faults.failCount = (faults.failCount || 0) + 1;
          throw new Error('Exception: Address unavailable: https://api.telegram.org/botTEST_TELEGRAM_TOKEN/sendMessage');
        }
        sent.push({ method, p });
        if (method === 'sendMessage') return resp({ ok: true, result: { message_id: ++msgId } });
        if (method === 'getFile') return resp({ ok: true, result: { file_path: 'photos/a.jpg' } });
        return resp({ ok: true, result: true });
      }
      if (url.includes('api.anthropic.com')) return resp({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(claudeDoc) }] });
      if (url.includes('storage.createSupply')) {
        faults.posterCalls.push(JSON.parse(opts.payload));
        if (faults.poster === 'error') return resp({ error: { code: 16, message: 'Ingredient not found' } });
        return resp({ success: 1, response: 321 });
      }
      if (url.includes('menu.getProducts')) return resp({ response: [
        { product_id: '20', product_name: 'Напитки', type: '3', unit: '', weight_flag: '0' },
        { product_id: '21', product_name: 'Детский сок', type: '3', unit: '', weight_flag: '0' },
        { product_id: '22', product_name: 'Вода', type: '3', unit: '', weight_flag: '0' },
        { product_id: '30', product_name: 'Бургер', type: '2', unit: 'kg', weight_flag: '0' }] });
      if (url.includes('menu.getIngredients')) return resp({ response: ingredients });
      if (url.includes('storage.getSuppliers')) return resp({ response: suppliers });
      throw new Error('unmocked ' + url.split('?')[0]);
    }
  }
};
vm.createContext(ctx);
// «Сейчас» в эмуляции сдвигается переменной __offset (мс) и для Date.now(), и для new Date() без аргументов.
vm.runInContext('(function () { var RealDate = Date; var off = function () { return typeof __offset === "number" ? __offset : 0; };' +
  ' function FakeDate() { var a = arguments; if (!(this instanceof FakeDate)) return new FakeDate().toString();' +
  ' return a.length === 0 ? new RealDate(RealDate.now() + off()) : new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(a))))(); }' +
  ' FakeDate.prototype = RealDate.prototype; FakeDate.now = function () { return RealDate.now() + off(); };' +
  ' FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse; Date = FakeDate; })();', ctx);
const files = fs.readdirSync(dir).filter(f => /^Supply.*\.gs$/.test(f) && f !== 'SupplyDoPost.gs');
vm.runInContext(files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'), ctx);
module.exports = { ctx, sheets, props, sent, faults, clock, cacheStore, setDoc: d => { claudeDoc = d; }, run: code => vm.runInContext(code, ctx) };
