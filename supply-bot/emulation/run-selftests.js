// Запуск всех самотестов бота в эмуляции Apps Script: node emulation/run-selftests.js
// Код бота (../*.gs) загружается как в Apps Script (общее пространство имён), листы и сервисы — заглушки из harness.js.
const { ctx } = require('./harness.js');

const TESTS = [
  'supplyClaudeSelfTest',     // чтение документа: поставщик по умолчанию, слияние позиций, чужие фото
  'supplyChecksSelfTest',    // проверки: цена ±10%, диапазон количества, вес на штуку
  'supplyMatchSelfTest',     // сопоставление: артикул, нечёткое название, supplier_id, диагностика
  'supplyDupSelfTest',       // ключ документа и дубли
  'supplyStage4SelfTest',    // запись: повторы Telegram, payload Poster, идемпотентность, смешанные поставки
  'supplyAccessSelfTest',    // доступ сотрудников: заявки, кнопки владельца, кэш
  'supplyProductsSelfTest',  // товары Poster и правила по ключевым словам
  'supplyWatchdogSelfTest',  // окно работы сторожа 08:00–21:30
  'supplyDigestSelfTest',    // вечерний отчёт владельцу
  'supplyCatalogSelfTest'    // каталог Poster для заполнения владельцем
];

let ok = 0, failed = 0, suites = 0, suitesOk = 0;
const origLog = ctx.console.log;
ctx.console = Object.assign({}, ctx.console, {
  log: function () {
    const line = Array.prototype.join.call(arguments, ' ');
    if (/^OK\s/.test(line)) ok++;
    if (/^FAIL\s/.test(line)) failed++;
    if (process.env.VERBOSE || /^FAIL\s|ПРОВАЛЕНО/.test(line)) origLog.apply(console, arguments);
  },
  error: function () {}, warn: function () {}
});

TESTS.forEach(name => {
  suites++;
  const before = failed;
  try {
    ctx.__run = name;
    require('vm').runInContext(name + '()', ctx);
  } catch (e) {
    failed++;
    console.log('ОШИБКА в ' + name + ': ' + e.message);
  }
  const good = failed === before;
  if (good) suitesOk++;
  console.log((good ? 'OK   ' : 'FAIL ') + name);
});

console.log('\nПроверок пройдено: ' + ok + ', провалено: ' + failed + '. Наборов: ' + suitesOk + '/' + suites + '.');
// Сценарии-проверки (диалог целиком, накладные, дубли, отчёт): отдельным процессом, у них своё состояние.
let scenarioFailed = false;
if (!process.env.SKIP_SCENARIOS) {
  ['check-regression.js', 'check-catalog.js'].forEach(f => {
    const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'scenarios', f)], { encoding: 'utf8' });
    const tail = String(r.stdout || '').trim().split('\n').pop();
    console.log((r.status === 0 ? 'OK   ' : 'FAIL ') + 'сценарии (' + f + '): ' + tail);
    if (r.status !== 0) { scenarioFailed = true; console.log(r.stdout); }
  });
}
process.exit(failed || scenarioFailed ? 1 : 0);
