/**
 * ВСТАВЛЯТЬ ТОЛЬКО ЕСЛИ В ПРОЕКТЕ НЕТ СВОЕГО doPost (проверка: supplyCheckEntryPoints()).
 * Если doPost уже есть — этот файл не нужен: добавьте в начало существующего doPost
 *   var supplyResp = supplyDoPostRoute_(e);
 *   if (supplyResp) return supplyResp;
 */
function doPost(e) {
  return supplyDoPostRoute_(e) || ContentService.createTextOutput('ok');
}
