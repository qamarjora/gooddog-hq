/**
 * Telegram Bot API (polling и webhook). Токен: TELEGRAM_TOKEN_INVOICES.
 * Сетевые сбои, 5xx и 429 повторяются (supplyRetryCall_).
 */

function supplySleep_(ms) {
  Utilities.sleep(ms);
}

/** retry_after (секунды) из ответа Telegram на 429 или 0. */
function supplyRetryAfter_(text) {
  try {
    var d = JSON.parse(text);
    return Number(d && d.parameters && d.parameters.retry_after) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Запрос с повторами при сетевом сбое (исключение UrlFetchApp), кодах 5xx и 429:
 * до 3 попыток, паузы 1 с и 2 с; на 429 пауза не меньше retry_after (но не дольше 15 с).
 * Прочие 4xx не повторяются. attemptFn() возвращает {code, text} или бросает исключение;
 * sleepFn(ms) — пауза (в тестах подменяется). После последней попытки возвращается последний ответ
 * (его разбирает вызывающий) либо пробрасывается последнее исключение.
 */
function supplyRetryCall_(attemptFn, sleepFn) {
  var pauses = [1000, 2000];
  var max = 3;
  for (var i = 1; i <= max; i++) {
    var r;
    try {
      r = attemptFn();
    } catch (e) {
      if (i === max) throw e;
      sleepFn(pauses[i - 1]);
      continue;
    }
    var retryable = r.code === 429 || (r.code >= 500 && r.code < 600);
    if (!retryable || i === max) return r;
    var wait = pauses[i - 1];
    if (r.code === 429) {
      var ra = supplyRetryAfter_(r.text);
      if (ra) wait = Math.max(wait, Math.min(ra * 1000, 15000));
    }
    sleepFn(wait);
  }
}

function supplyTgCall_(method, payload) {
  var token = supplyProp_('TELEGRAM_TOKEN_INVOICES');
  if (!token) throw new Error('Не задано свойство TELEGRAM_TOKEN_INVOICES');
  var url = 'https://api.telegram.org/bot' + token + '/' + method;
  var body = JSON.stringify(payload || {});

  var r;
  try {
    r = supplyRetryCall_(function () {
      var resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: body,
        muteHttpExceptions: true
      });
      return { code: resp.getResponseCode(), text: resp.getContentText() };
    }, supplySleep_);
  } catch (e) {
    // Текст исключения UrlFetchApp может содержать адрес с токеном.
    throw new Error('Telegram ' + method + ': сетевой сбой (' + supplySanitizeSecrets_(e.message) + ')');
  }

  var data;
  try {
    data = JSON.parse(r.text);
  } catch (e2) {
    throw new Error('Telegram ' + method + ': HTTP ' + r.code + ', ответ не JSON');
  }
  if (!data.ok) {
    throw new Error('Telegram ' + method + ': ' + data.error_code + ' ' + data.description);
  }
  return data.result;
}

function supplyTgGetOffset_() {
  return Number(supplyProp_(SUPPLY_CONST.PROP_OFFSET)) || 0;
}

function supplyTgSetOffset_(offset) {
  PropertiesService.getScriptProperties().setProperty(SUPPLY_CONST.PROP_OFFSET, String(offset));
}

/** Один запрос getUpdates без ожидания (timeout 0). */
function supplyTgGetUpdates_() {
  var payload = {
    limit: SUPPLY_CONST.TG_BATCH,
    timeout: 0,
    allowed_updates: ['message', 'callback_query']
  };
  var offset = supplyTgGetOffset_();
  if (offset > 0) payload.offset = offset;
  return supplyTgCall_('getUpdates', payload);
}

/**
 * Отправка сообщения (HTML). opts: {keyboard: [[{text, callback_data}]], replyTo: messageId}
 */
function supplyTgSend_(chatId, text, opts) {
  opts = opts || {};
  var payload = {
    chat_id: Number(chatId),
    text: String(text).substring(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (opts.keyboard) payload.reply_markup = { inline_keyboard: opts.keyboard };
  if (opts.replyTo) payload.reply_to_message_id = Number(opts.replyTo);
  return supplyTgCall_('sendMessage', payload);
}

function supplyTgEdit_(chatId, messageId, text, keyboard) {
  var payload = {
    chat_id: Number(chatId),
    message_id: Number(messageId),
    text: String(text).substring(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  try {
    return supplyTgCall_('editMessageText', payload);
  } catch (e) {
    if (/message is not modified/i.test(e.message)) return null;
    throw e;
  }
}

/**
 * Ответ на нажатие кнопки. Никогда не бросает исключений: «query is too old» /
 * «query ID is invalid» — обычное дело при запоздалом ответе, действие по кнопке от этого не зависит.
 */
function supplyTgAnswerCb_(callbackId, text) {
  try {
    var payload = { callback_query_id: callbackId };
    if (text) payload.text = String(text).substring(0, 200);
    return supplyTgCall_('answerCallbackQuery', payload);
  } catch (e) {
    if (!/query is too old|query ID is invalid/i.test(e.message)) {
      console.warn('supplyTgAnswerCb_: ' + e.message);
    }
    return null;
  }
}

/** Убрать кнопки у сообщения (ошибки игнорируем: сообщение могло быть удалено/уже без кнопок). */
function supplyTgDropKeyboard_(chatId, messageId) {
  try {
    supplyTgCall_('editMessageReplyMarkup', {
      chat_id: Number(chatId),
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] }
    });
  } catch (e) {
    console.log('supplyTgDropKeyboard_: ' + e.message);
  }
}

/** Скачать файл по file_id. Возвращает {blob, path, size}. */
function supplyTgDownload_(fileId) {
  var info = supplyTgCall_('getFile', { file_id: fileId });
  if (!info.file_path) throw new Error('Telegram не вернул путь к файлу');
  var token = supplyProp_('TELEGRAM_TOKEN_INVOICES');
  var resp = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + token + '/' + info.file_path, {
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Не удалось скачать файл из Telegram: HTTP ' + resp.getResponseCode());
  }
  var blob = resp.getBlob();
  return { blob: blob, path: info.file_path, size: blob.getBytes().length };
}

/** getUpdates не работает при установленном webhook: снимаем его. */
function supplyTgDeleteWebhook_() {
  return supplyTgCall_('deleteWebhook', { drop_pending_updates: false });
}
