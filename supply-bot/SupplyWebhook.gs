/**
 * Приём апдейтов от ретранслятора (Cloudflare Worker -> веб-приложение Apps Script).
 * Здесь НЕТ функции doPost: она в SupplyDoPost.gs (если в проекте doPost ещё нет)
 * либо вызывает supplyDoPostRoute_ из существующего doPost.
 */

/**
 * Роутер для doPost. Возвращает ответ, только если запрос наш (key == SUPPLY_RELAY_SECRET),
 * иначе null — чтобы старый doPost мог продолжить как обычно.
 */
function supplyDoPostRoute_(e) {
  var secret = supplyProp_('SUPPLY_RELAY_SECRET');
  if (!secret || !e || !e.parameter || e.parameter.key !== secret) return null;
  supplyWebhookRun_(e);
  return ContentService.createTextOutput('ok'); // ответ всегда короткий, без деталей
}

/** Разбор тела и обработка под тем же замком, что и supplyPoll. Ошибки только в лог. */
function supplyWebhookRun_(e) {
  var update;
  try {
    update = JSON.parse(e.postData.contents);
  } catch (err) {
    console.error('supplyWebhookRun_: тело не JSON');
    return;
  }

  var lock = supplyLockAcquire_(SUPPLY_CONST.LOCK_WAIT_WEBHOOK_MS);
  if (!lock) {
    console.error('supplyWebhookRun_: замок занят, update_id=' + (update && update.update_id) + ' не обработан');
    supplyOwnerNote_('❗ Апдейт ' + supplyEsc_(update && update.update_id) +
      ' не обработан: система была занята. Попросите сотрудника отправить документ ещё раз.');
    return;
  }
  try {
    supplyProcessUpdate_(update);
  } catch (err2) {
    console.error('supplyWebhookRun_: ' + err2.message);
  } finally {
    lock.releaseLock();
  }
}
