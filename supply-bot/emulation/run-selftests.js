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
  'supplyWatchdogSelfTest'   // окно работы сторожа 08:00–21:30
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
process.exit(failed ? 1 : 0);
