/**
 * Вечерний отчёт владельцу: сколько накладных принято за день и на какую сумму.
 * Приходит один раз в день (по умолчанию около 21:30 по Астане). Если за день поставок не было, сообщения нет.
 * Установка триггера: supplyInstallDigest() (запустить вручную один раз).
 */

/**
 * Текст отчёта (чистая функция). rows — строки журнала (supplyJrnLoad_), day — YYYY-MM-DD по Астане.
 * Возвращает пустую строку, если за день нет ни принятых поставок, ни ошибок.
 */
function supplyDigestText_(rows, day) {
  var today = rows.filter(function (r) { return r.atDay === day; });
  var ok = today.filter(supplyJrnCounts_);
  var errors = today.filter(function (r) {
    return String(r.status || '').trim().toLowerCase() === SUPPLY_CONST.STATUS_POSTER_ERROR.toLowerCase();
  });
  if (!ok.length && !errors.length) return '';

  var total = ok.reduce(function (a, r) { return a + (r.sum || 0); }, 0);
  var out = ['📊 <b>Поставки за ' + supplyFmtDate_(day) + '</b>'];
  if (ok.length) {
    out.push(ok.length + ' ' + supplyPlural_(ok.length, 'накладная', 'накладные', 'накладных') + ' · ' + supplyFmtNum_(total) + ' ₸');
    ok.forEach(function (r) { out.push('• ' + supplyEsc_(r.source) + ' — ' + supplyFmtNum_(r.sum) + ' ₸'); });
  }
  var disc = ok.filter(function (r) { return /^да/i.test(r.discrepancy); });
  if (disc.length) {
    out.push('');
    disc.forEach(function (r) { out.push('⚠️ Расхождение: ' + supplyEsc_(r.source) + ' (' + supplyEsc_(r.discrepancy) + ')'); });
  }
  if (errors.length) {
    out.push('');
    errors.forEach(function (r) { out.push('❗ Не принято Poster: ' + supplyEsc_(r.source) + ' — ' + supplyFmtNum_(r.sum) + ' ₸'); });
  }
  if (ok.length && supplyIsDryRun_()) out.push('\n🧪 режим проверки: в Poster ничего не записано');
  return out.join('\n');
}

/** Отправка отчёта за сегодня (nowMs — «сейчас» для тестов; триггер передаёт объект события, он игнорируется). */
function supplyDigest(nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var text = supplyDigestText_(supplyJrnLoad_(), supplyAstanaDate_(now));
  if (!text) return '';
  supplyOwnerNote_(text);
  return text;
}

/** Один ежедневный триггер на supplyDigest около 21:30 по Астане. */
function supplyInstallDigest() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'supplyDigest'; });
  if (exists) {
    console.log('Триггер supplyDigest уже есть.');
    return;
  }
  ScriptApp.newTrigger('supplyDigest').timeBased().atHour(21).nearMinute(30).everyDays(1).inTimezone('Asia/Almaty').create();
  console.log('Триггер supplyDigest создан (ежедневно около 21:30 по Астане).');
}

/** Самопроверка отчёта: без листов и Telegram. Запуск вручную. */
function supplyDigestSelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  function row(source, sum, status, day, disc) {
    return { source: source, sum: sum, status: status, atDay: day, discrepancy: disc || 'нет' };
  }
  var D = '2026-10-17';
  expect('нет поставок за день — пустой текст', supplyDigestText_([row('Хлебозавод', 100, 'принято', '2026-10-16')], D) === '');
  var t = supplyDigestText_([
    row('Хлебозавод', 6000, 'принято', D), row('Рэд Машин Астана', 90312, 'принято', D), row('Магнум', 5000, 'принято', '2026-10-16')], D);
  expect('2 накладные, сумма 96 312', t.indexOf('2 накладные · ' + supplyFmtNum_(96312) + ' ₸') !== -1);
  expect('вчерашняя поставка не попала', t.indexOf('Магнум') === -1);
  expect('есть строки по поставщикам', t.indexOf('• Хлебозавод — ' + supplyFmtNum_(6000) + ' ₸') !== -1 &&
    t.indexOf('• Рэд Машин Астана — ' + supplyFmtNum_(90312) + ' ₸') !== -1);
  var te = supplyDigestText_([row('Татым', 1200, 'ошибка Poster', D)], D);
  expect('ошибка Poster показана', te.indexOf('❗ Не принято Poster: Татым') !== -1);
  var td = supplyDigestText_([row('Хлебозавод', 6000, 'принято', D, 'да: нет двух коробок')], D);
  expect('расхождение показано', td.indexOf('⚠️ Расхождение: Хлебозавод') !== -1);
  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
