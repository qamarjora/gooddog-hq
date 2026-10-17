/**
 * Подготовка файла для Claude: выбор размера фото из Telegram (не крупнее IMG_MAX_PX), PDF и картинки-файлы как есть.
 * Drive не используется: сжатия картинок-файлов нет, лишний размер Claude уменьшает сам; если файл слишком
 * большой или в неподдерживаемом формате (HEIC и т.п.), сотруднику предлагается прислать обычное фото —
 * Telegram сам сожмёт его до ~1280 px.
 */

/**
 * Разбор сообщения Telegram.
 * Возвращает null (в сообщении нет файла), {error} (неподдерживаемый файл)
 * или {kind: 'photo'|'image'|'pdf', readFileId, archiveFileId, uniqueId, mime, size, name}.
 */
function supplyFileFromMessage_(msg) {
  var max = SUPPLY_CONST.IMG_MAX_PX;

  if (msg.photo && msg.photo.length) {
    var sizes = msg.photo.slice().sort(function (a, b) {
      return (a.width * a.height) - (b.width * b.height);
    });
    var pick = null;
    sizes.forEach(function (p) {
      if (Math.max(p.width, p.height) <= max) pick = p; // самый большой, но не крупнее 1500
    });
    if (!pick) pick = sizes[0];
    return {
      kind: 'photo',
      readFileId: pick.file_id,
      archiveFileId: sizes[sizes.length - 1].file_id,
      uniqueId: sizes[sizes.length - 1].file_unique_id || '', // для поиска повторно присланного снимка
      mime: 'image/jpeg',
      size: pick.file_size || 0,
      name: 'photo.jpg'
    };
  }

  if (msg.document) {
    var d = msg.document;
    var mime = (d.mime_type || '').toLowerCase();
    var name = d.file_name || 'document';
    var isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
    var isImage = mime.indexOf('image/') === 0;
    if (!isPdf && !isImage) {
      return { error: 'Поддерживаются фото, изображения и PDF.' };
    }
    if (d.file_size && d.file_size > SUPPLY_CONST.TG_DOWNLOAD_MAX_BYTES) {
      return { error: 'Файл больше 20 МБ. Пришлите фото или файл поменьше.' };
    }
    return {
      kind: isPdf ? 'pdf' : 'image',
      readFileId: d.file_id,
      archiveFileId: d.file_id,
      uniqueId: d.file_unique_id || '',
      mime: isPdf ? 'application/pdf' : mime,
      size: d.file_size || 0,
      name: name
    };
  }

  return null;
}

/**
 * Скачивает файл и готовит его для Claude.
 * Возвращает {type: 'image'|'pdf', mime, data (base64), bytes}.
 */
function supplyImagePrepare_(file) {
  var dl = supplyTgDownload_(file.readFileId);
  var blob = dl.blob;

  if (file.kind === 'pdf') {
    if (dl.size > SUPPLY_CONST.PDF_MAX_BYTES) throw new Error('PDF слишком большой');
    return { type: 'pdf', mime: 'application/pdf', data: Utilities.base64Encode(blob.getBytes()), bytes: dl.size };
  }

  var mime = file.mime;
  if (!supplyImageMimeOk_(mime)) {
    throw new Error('Формат изображения не поддерживается (' + mime + '). Пришлите обычное фото (не файлом) или PDF.');
  }

  var bytes = blob.getBytes();
  if (bytes.length > SUPPLY_CONST.IMG_MAX_BYTES) {
    throw new Error('Изображение слишком большое. Пришлите его как обычное фото (не файлом).');
  }
  return { type: 'image', mime: mime, data: Utilities.base64Encode(bytes), bytes: bytes.length };
}

function supplyImageMimeOk_(mime) {
  return /^image\/(jpeg|png|webp|gif)$/.test(mime);
}
