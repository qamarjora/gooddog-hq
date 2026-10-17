/**
 * Запись принятого документа (этап 4): Poster (только в боевом режиме), журнал, статистика справочника —
 * и только после этого сообщения в Telegram. Drive не используется (колонка «ссылка на файл» в журнале пустая).
 *
 * Порядок и устойчивость:
 *  1. Сначала всё, что меняет данные: Poster (DRY_RUN=false) -> журнал -> статистика.
 *  2. Каждый этап отмечается в st.rec и сохраняется сразу; повторный вызов (повторное нажатие, сбой в середине)
 *     продолжает с недостающего этапа и не создаёт вторую запись. После записи st.recorded = true.
 *  3. Сбой отправки сообщения запись не откатывает и сотруднику «Что-то пошло не так» не показывает:
 *     «Принято…» отправляется с одной повторной попыткой, при неудаче уведомляется только владелец.
 *  4. Ошибка Poster в боевом режиме: в журнал — статус «ошибка Poster» (в дубли не считается), статистика
 *     не обновляется, владельцу текст ошибки, сотруднику «Передано владельцу».
 *
 * Одна позиция накладной = одна строка createSupply. Цена за единицу склада = сумма позиции ÷ количество,
 * округлена до 6 знаков (без округления до копеек), затем умножена на SUPPLY_POSTER_SUM_MULTIPLIER.
 * Итог «количество × цена» по строкам может отличаться от итога накладной на доли тиына — владельцу в dry-run
 * показывается, если отличается. Разбиение позиции на две строки с точным итогом (supplySplitLineT_)
 * сохранено и включается свойством SUPPLY_SPLIT_LINES=true.
 * Если сумма позиций не равна итогу накладной (за вычетом «пропускаемых» позиций), в боевом режиме запись
 * останавливается, в dry-run расхождение показывается владельцу.
 *
 * Все внешние действия — через deps (supplyRecordDeps_), поэтому логика проверяется в supplyStage4SelfTest().
 */

/** Текущее время по Астане (UTC+5) в формате Poster Y-m-d H:i:s. */
function supplyNowAstanaStamp_() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().substring(0, 19).replace('T', ' ');
}

/** Сумма в тенге -> целые тиыны (null/undefined — 0). */
function supplyLineTiyn_(tenge) {
  return tenge === null || tenge === undefined ? 0 : Math.round(tenge * 100);
}

function supplyRound6_(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** Цена для сообщения (до 4 знаков без хвостовых нулей). Синоним supplyFmtPrice4_. */
function supplyFmtPrice_(n) {
  return supplyFmtPrice4_(n);
}

/**
 * Точное разбиение суммы позиции на строки с целой ценой в тиынах (чистая функция, целые числа).
 * S — сумма позиции в тиынах, Qm — количество в единицах склада в тысячных (132 шт = 132000, 8,69 кг = 8690).
 * p = floor(S / Q); остаток r (в тысячных долях тиына на единицу) раскладывается так:
 *   (Qm − r) по p и r по p + 1 тиын, при этом (Qm − r)·p + r·(p + 1) = S·1000 / 1000 = S точно.
 * Возвращает [{qtyM, priceT}] (одна строка при r = 0, иначе две; qtyM — тысячные) или null, если разбиение
 * невозможно (нецелые аргументы, Qm ≤ 0, S < 0).
 */
function supplySplitLineT_(S, Qm) {
  if (!(Qm > 0) || !(S >= 0) || S !== Math.floor(S) || Qm !== Math.floor(Qm)) return null;
  var total = S * 1000; // тиыны × тысячные, целое
  var p = Math.floor(total / Qm);
  while (p * Qm > total) p--;        // защита от погрешности деления
  while ((p + 1) * Qm <= total) p++;
  var r = total - p * Qm;            // 0 <= r < Qm
  if (r === 0) return [{ qtyM: Qm, priceT: p }];
  return [{ qtyM: Qm - r, priceT: p }, { qtyM: r, priceT: p + 1 }];
}

/**
 * Строки Poster для одной позиции (с множителем цены mult). split — разбивать на две строки (по умолчанию нет).
 * Возвращает {rows: [{num, sum, part, docSumT}], sT (сумма позиции в тиынах), postedT (количество × цена по строке,
 * округлено до 0,01 ₸, в тиынах), note, noPrice}.
 *  - без разбиения: одна строка, цена = S/Q на 6 знаков (умноженная на mult);
 *  - с разбиением: точное разбиение (supplySplitLineT_), если сумма кратна тиыну, а количество имеет не больше 3 знаков;
 *    иначе одна строка и пометка «итог может отличаться на X ₸».
 */
function supplyPlanLineSet_(l, mult, split) {
  mult = mult || 1;
  var Q = Number(l.qtyWh);
  if (l.lineSum === null || l.lineSum === undefined || !(Q > 0)) {
    return { rows: [{ num: Q, sum: 0, part: '', docSumT: 0 }], sT: 0, postedT: 0, note: '', noPrice: true };
  }
  var S = Math.round(l.lineSum * 100);

  if (split) {
    var Qm = Math.round(Q * 1000);
    var exact = Math.abs(l.lineSum * 100 - S) < 1e-6 && Math.abs(Q * 1000 - Qm) < 1e-6;
    var parts = exact ? supplySplitLineT_(S, Qm) : null;
    if (parts) {
      return {
        rows: parts.map(function (p, i) {
          return {
            num: Number((p.qtyM / 1000).toFixed(3)),
            sum: supplyRound6_(p.priceT / 100 * mult),
            part: parts.length > 1 ? (i + 1) + '/' + parts.length : '',
            docSumT: parts.length > 1 ? null : S
          };
        }),
        sT: S, postedT: S, note: '', noPrice: false
      };
    }
  }

  var price = supplyRound6_(l.lineSum / Q);
  var postedT = Math.round(Q * price * 100);
  return {
    rows: [{ num: Q, sum: supplyRound6_(price * mult), part: '', docSumT: S }],
    sT: S, postedT: postedT, noPrice: false,
    note: split
      ? l.name + ': точное разбиение невозможно, цена за единицу ' + supplyFmtPrice_(price) +
        '; итог может отличаться на ' + supplyFmtNum_(Math.abs(postedT - S) / 100) + ' ₸'
      : ''
  };
}

/** Комментарий к поставке: только «бот» и название поставщика (номер и дату с фото модель читает с ошибками). */
function supplySupplyComment_(supplierName) {
  return (String(supplierName || '').trim() + ' (бот)').trim().substring(0, 250);
}

/**
 * Тело storage.createSupply и данные для сообщения владельцу (одни и те же числа).
 * Позиции — только готовые к оприходованию строки: одна позиция = одна строка (при SUPPLY_SPLIT_LINES — две).
 * Возвращает:
 *  payload; lines [{name, unit, num, sum, part, docSumT}] — ровно то, что уйдёт в payload;
 *  itemsT — сумма позиций документа, уходящих в Poster (тиыны); postedT — количество × цена по строкам (тиыны,
 *  по строкам округлено до 0,01 ₸); skippedT — сумма «пропускаемых» позиций; docTotalT — итог документа;
 *  expectedT = docTotalT − skippedT; mismatchT = itemsT − expectedT (0 — позиции сходятся с итогом); notes; noPrice.
 */
function supplyBuildSupplyPlan_(st, stamp, multiplier, splitLines, productType) {
  var sup = st.match && st.match.supplier;
  if (!sup || !sup.id) throw new Error('Не определён поставщик (supplier_id) для записи в Poster');
  var mult = multiplier || 1;
  var prodType = productType || 1; // type товара в createSupply (SUPPLY_POSTER_PRODUCT_TYPE; по документации 1)

  var ingredient = [];
  var kinds = [];
  var lines = [];
  var notes = [];
  var noPrice = [];
  var itemsT = 0, postedT = 0, skippedT = 0;

  st.match.lines.forEach(function (l) {
    if (l.status === 'skip') {
      skippedT += supplyLineTiyn_(l.lineSum);
      return;
    }
    if (l.status !== 'ready') return;
    var set = supplyPlanLineSet_(l, mult, !!splitLines);
    itemsT += set.sT;
    postedT += set.postedT;
    if (set.noPrice) noPrice.push(l.name);
    if (set.note) notes.push(set.note);
    var isProduct = l.entry.ptype === 'товар';
    set.rows.forEach(function (r) {
      // id — id ингредиента или id товара (по виду в колонке «тип в Poster»); type: ингредиент 4, товар — по настройке (1).
      ingredient.push({ id: Number(l.entry.id), type: isProduct ? prodType : SUPPLY_CONST.TYPE_INGREDIENT, num: r.num, sum: r.sum });
      kinds.push(isProduct ? 'товар' : 'ингредиент');
      lines.push({ name: l.name, unit: l.unit, num: r.num, sum: r.sum, part: r.part, docSumT: r.docSumT,
                   kind: isProduct ? 'товар' : 'ингредиент', byRule: !!l.rule });
    });
  });

  var docTotalT = supplyLineTiyn_(st.doc.total);
  var expectedT = docTotalT - skippedT;
  return {
    payload: {
      supply: {
        date: stamp,
        supplier_id: Number(sup.id),
        storage_id: SUPPLY_CONST.POSTER_STORAGE_ID,
        supply_comment: supplySupplyComment_(sup.name || st.doc.source)
      },
      ingredient: ingredient
    },
    lines: lines,
    kinds: kinds,
    mixed: kinds.indexOf('товар') !== -1 && kinds.indexOf('ингредиент') !== -1, // в поставке и товары, и ингредиенты
    itemsT: itemsT, postedT: postedT, skippedT: skippedT,
    docTotalT: docTotalT, expectedT: expectedT, mismatchT: itemsT - expectedT,
    notes: notes, noPrice: noPrice
  };
}

/**
 * Тело createSupply для части поставки: key 'all' — целиком; 'товар' / 'ингредиент' — только строки этого вида
 * (та же дата, склад и поставщик).
 */
function supplyPlanPayloadFor_(plan, key) {
  if (key === 'all') return plan.payload;
  return {
    supply: plan.payload.supply,
    ingredient: plan.payload.ingredient.filter(function (x, i) { return plan.kinds[i] === key; })
  };
}

/** Текст о расхождении суммы позиций и итога накладной. */
function supplySumMismatchText_(st, plan) {
  var label = st.doc.source + (st.doc.doc_number ? ' № ' + st.doc.doc_number : '');
  var diff = ' (разница ' + supplyFmtNum_(plan.mismatchT / 100) + ' ₸)';
  var what = plan.skippedT
    ? 'не равна ожидаемой ' + supplyFmtNum_(plan.expectedT / 100) + ' ₸ (итог накладной ' + supplyFmtNum_(plan.docTotalT / 100) +
      ' ₸ минус пропускаемые позиции ' + supplyFmtNum_(plan.skippedT / 100) + ' ₸)'
    : 'не равна итогу накладной ' + supplyFmtNum_(plan.expectedT / 100) + ' ₸';
  return '⚠️ Сумма позиций ' + supplyFmtNum_(plan.itemsT / 100) + ' ₸ ' + what + diff + ': ' + label;
}

/**
 * Цена за единицу в сообщениях: максимум 4 знака после запятой, хвостовые нули и запятая убираются
 * («312», «55,5», «198,8167»), тысячи разделены пробелом. Только отображение: в payload и расчётах числа не округляются.
 */
function supplyFmtPrice4_(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  var s = (Math.round(n * 10000) / 10000).toFixed(4);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  var parts = s.split('.');
  var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return parts[1] ? intPart + ',' + parts[1] : intPart;
}

/**
 * Сообщение владельцу в режиме dry-run: что ушло бы в createSupply. Одна строка на позицию: количество, цена за единицу
 * (4 знака), сумма позиции из накладной. «Итого в Poster» (количество × цена по строкам, до 0,01 ₸) показывается,
 * только если отличается от итога накладной.
 */
function supplyDryRunOwnerText_(st, plan, multiplier, splitByType) {
  var sup = st.match.supplier;
  var out = ['🧪 <b>Оприходовал бы в Poster</b>'];
  out.push('Поставщик: ' + supplyEsc_(sup.name || st.doc.source) + ' (id ' + sup.id + ')');
  out.push('Дата: ' + supplyEsc_(plan.payload.supply.date));
  out.push('Комментарий: ' + supplyEsc_(plan.payload.supply.supply_comment));
  if (plan.mixed) {
    out.push(splitByType
      ? 'В документе товары и ингредиенты: будут созданы две поставки одного поставщика (SUPPLY_POSTER_SPLIT_BY_TYPE).'
      : 'В документе товары и ингредиенты: одной поставкой; если Poster её не примет, она автоматически разделится на две (товары и ингредиенты).');
  }
  out.push('');

  function lineText(l, i) {
    return (i + 1) + '. ' + supplyEsc_(l.name) + (l.kind === 'товар' ? ' (товар)' : '') + (l.part ? ' [' + l.part + ']' : '') +
      (l.byRule ? ' (по правилу)' : '') + ' — ' + supplyFmtNum_(l.num) +
      (l.unit ? ' ' + supplyEsc_(l.unit) : '') + ' × ' + supplyFmtPrice4_(l.sum) + ' ₸' +
      (l.docSumT !== null && l.docSumT !== undefined ? ' (по накладной ' + supplyFmtNum_(l.docSumT / 100) + ' ₸)' : '');
  }
  if (plan.mixed && splitByType) {
    ['товар', 'ингредиент'].forEach(function (kind, k) {
      out.push('Поставка ' + (k + 1) + ' — ' + (kind === 'товар' ? 'товары' : 'ингредиенты') + ':');
      plan.lines.forEach(function (l, i) { if (l.kind === kind) out.push(lineText(l, i)); });
    });
  } else {
    plan.lines.forEach(function (l, i) { out.push(lineText(l, i)); });
  }
  out.push('');
  out.push('Итого по накладной: ' + supplyFmtNum_(plan.docTotalT / 100) + ' ₸' +
    (plan.skippedT ? ' (из них пропускаемые позиции: ' + supplyFmtNum_(plan.skippedT / 100) + ' ₸)' : ''));
  if (plan.postedT !== plan.expectedT) {
    out.push('Итого в Poster (количество × цена по строкам): ' + supplyFmtNum_(plan.postedT / 100) + ' ₸ — отличается от накладной на ' +
      supplyFmtNum_((plan.postedT - plan.expectedT) / 100) + ' ₸');
  }
  if (plan.mismatchT !== 0) out.push(supplySumMismatchText_(st, plan));
  plan.notes.forEach(function (n) { out.push('⚠️ ' + supplyEsc_(n)); });
  if (plan.noPrice.length) out.push('⚠️ Нет цены у: ' + supplyEsc_(plan.noPrice.join(', ')) + ' (sum = 0)');
  if (multiplier && multiplier !== 1) out.push('Множитель цены: ×' + multiplier);
  return out.join('\n');
}

/** Статистика справочника по готовым строкам (цена за единицу склада, счётчик, среднее, вес на штуку). */
function supplyApplyStats_(st) {
  supplyMatchReadyLines_(st.match).forEach(function (l) {
    if (!l.entry.row) return; // позиция по правилу ещё не записана в справочник (supplySaveRuleLines_)
    try {
      supplyDirUpdatePrice_(l.entry.row, l.unitPriceWh); // в основную строку группы
      supplyDirRecordStats_(l.entry.row, l.qtyWh, l.weightPerPiece);
    } catch (e) {
      console.error('supplyApplyStats_ справочник, строка ' + l.n + ': ' + e.message);
    }
  });
}

/** Настоящие внешние действия. В тестах заменяются заглушками. */
function supplyRecordDeps_() {
  var dry = supplyIsDryRun_();
  return {
    dryRun: dry,
    multiplier: supplyPosterSumMultiplier_(),
    splitLines: supplySplitLinesEnabled_(),
    productType: supplyPosterProductType_(),
    splitByType: supplySplitByTypeEnabled_(),
    saveRules: supplySaveRuleLines_,
    nowAstana: supplyNowAstanaStamp_,
    saveState: function (st) { supplyStateSet_(st.chatId, st); },
    clearState: function (st) { supplyStateClear_(st.chatId); },
    posterCreate: function (payload) { return supplyPosterPost_('storage.createSupply', payload); },
    journalAppend: supplyJrnAppend_,
    applyStats: supplyApplyStats_,
    send: function (st, html) { return supplyTgSend_(st.chatId, html); },
    sendOwner: supplyOwnerNote_,
    editDisc: function (st, hasDisc) {
      if (st.discMsgId) {
        supplyTgEdit_(st.chatId, st.discMsgId, 'Фактически всё совпало с документом? ' + (hasDisc ? 'Есть расхождение' : 'Да'));
      }
    }
  };
}

/** Две попытки отправки (исходная + одна повторная). Возвращает {ok, error}. */
function supplySendRetry_(fn) {
  var last = null;
  for (var i = 0; i < 2; i++) {
    try {
      fn();
      return { ok: true, error: null };
    } catch (e) {
      last = e;
    }
  }
  return { ok: false, error: last };
}

/**
 * Запись документа и сообщения. Идемпотентна: повторный вызов не создаёт вторую запись.
 * Возвращает {status: 'accepted'|'dry-run'|'poster_error'|'blocked_sum', employeeDelivered, plan}.
 */
function supplyFinalizeCore_(st, hasDisc, comment, deps) {
  st.rec = st.rec || {};
  var rec = st.rec;
  var plan = null;
  var label = st.doc.source + (st.doc.doc_number ? ' № ' + st.doc.doc_number : '');

  if (!st.recorded) {
    if (!rec.started) {
      rec.stamp = deps.nowAstana();
      rec.disc = { hasDisc: !!hasDisc, comment: comment || '' };
      plan = supplyBuildSupplyPlan_(st, rec.stamp, deps.multiplier, deps.splitLines, deps.productType);

      // Боевой режим: сумма позиций не равна итогу накладной — молча не записываем.
      if (!deps.dryRun && plan.mismatchT !== 0 && !st.sumAccepted) {
        var blockedSent = supplySendRetry_(function () { deps.send(st, 'Передано владельцу'); });
        try { deps.sendOwner('❗ Запись в Poster остановлена.\n' + supplyEsc_(supplySumMismatchText_(st, plan))); } catch (e0) { /* не критично */ }
        return { status: 'blocked_sum', employeeDelivered: blockedSent.ok, plan: plan };
      }
      rec.started = true;
    }
    plan = plan || supplyBuildSupplyPlan_(st, rec.stamp, deps.multiplier, deps.splitLines, deps.productType);
    var discText = supplyJrnDiscrepancyText_(rec.disc.hasDisc, rec.disc.comment);
    deps.saveState(st);

    // 1. Poster — только в боевом режиме и только если есть что оприходовать.
    //    Товары и ингредиенты — одной поставкой; при SUPPLY_POSTER_SPLIT_BY_TYPE (или если Poster определённо отказал
    //    смешанной поставке) — двумя поставками одного поставщика. Каждая часть отмечается сразу после создания.
    if (!deps.dryRun && !rec.posterDone && !rec.posterError && plan.payload.ingredient.length) {
      if (!rec.parts) {
        rec.parts = plan.mixed && deps.splitByType
          ? [{ key: 'товар', done: false, id: null }, { key: 'ингредиент', done: false, id: null }]
          : [{ key: 'all', done: false, id: null }];
      }
      for (var pi = 0; pi < rec.parts.length; pi++) {
        var part = rec.parts[pi];
        if (part.done) continue;
        try {
          part.id = deps.posterCreate(supplyPlanPayloadFor_(plan, part.key));
          part.done = true;
          deps.saveState(st);
        } catch (e2) {
          if (part.key === 'all' && plan.mixed && e2 && e2.apiError) {
            // Poster определённо отказал смешанной поставке (ничего не создано): делим на две.
            rec.parts = [{ key: 'товар', done: false, id: null }, { key: 'ингредиент', done: false, id: null }];
            rec.splitFallback = true;
            deps.saveState(st);
            pi = -1;
            continue;
          }
          var created = rec.parts.filter(function (x) { return x.done; });
          rec.posterError = supplySanitizeSecrets_(String(e2 && e2.message ? e2.message : e2)).substring(0, 500) +
            (created.length ? ' ВНИМАНИЕ: часть поставки уже создана в Poster (' + created.map(function (x) {
              return (x.key === 'all' ? 'вся' : x.key) + ' №' + x.id; }).join(', ') + '), проверьте вручную.' : '');
          // Журнал: «ошибка Poster» (в дубли не считается), без статистики.
          var jrErr = deps.journalAppend({
            doc: st.doc, status: SUPPLY_CONST.STATUS_POSTER_ERROR, link: '',
            discrepancy: discText, fileUid: st.file && st.file.uniqueId, forceStats: false
          });
          rec.journalRow = jrErr.row;
          rec.journalDone = true;
          rec.statsDone = true;
          break;
        }
      }
      if (!rec.posterError) {
        rec.posterDone = true;
        rec.posterId = rec.parts.length === 1 ? rec.parts[0].id : rec.parts.map(function (x) { return x.id; }).join(', ');
      }
      deps.saveState(st);
    }

    if (!rec.posterError) {
      // 2. Журнал.
      if (!rec.journalDone) {
        var jr = deps.journalAppend({
          doc: st.doc,
          status: deps.dryRun ? SUPPLY_CONST.STATUS_DRYRUN : SUPPLY_CONST.STATUS_ACCEPTED,
          link: '',
          discrepancy: discText,
          posterId: rec.posterId || '',
          fileUid: st.file && st.file.uniqueId,
          // «Это новый документ» в боевом режиме — реальная дополнительная поставка; в dry-run дубль статистику не обновляет.
          forceStats: !!st.dupConfirmed && !deps.dryRun
        });
        rec.journalRow = jr.row;
        rec.duplicate = jr.duplicate;
        rec.journalDone = true;
        deps.saveState(st);
      }
      // 3. Позиции, сопоставленные по правилам, — в «Справочник накладных» как обычные строки (первое совпадение).
      if (!rec.rulesDone) {
        if (deps.saveRules) deps.saveRules(st);
        rec.rulesDone = true;
        deps.saveState(st);
      }
      // 4. Статистика справочника — не для дубля.
      if (!rec.statsDone) {
        if (!rec.duplicate) deps.applyStats(st);
        rec.statsDone = true;
        deps.saveState(st);
      }
    }

    st.recorded = true; // запись завершена: повторное нажатие вторую запись не создаст
    deps.saveState(st);
  } else {
    plan = supplyBuildSupplyPlan_(st, rec.stamp, deps.multiplier, deps.splitLines, deps.productType);
  }

  // ---- Сообщения (после записи). Сбой здесь запись не откатывает. ----
  var res = { status: rec.posterError ? 'poster_error' : (deps.dryRun ? 'dry-run' : 'accepted'), employeeDelivered: true, plan: plan };

  try { deps.editDisc(st, rec.disc ? rec.disc.hasDisc : !!hasDisc); } catch (e3) { /* не критично */ }

  var readyCount = supplyMatchReadyLines_(st.match).length;
  var empText = rec.posterError
    ? 'Передано владельцу'
    : 'Принято: ' + readyCount + ' ' + supplyPlural_(readyCount, 'позиция', 'позиции', 'позиций') +
      ', сумма ' + supplyFmtNum_(st.doc.total) + ' ₸';
  var sent = supplySendRetry_(function () { deps.send(st, empText); });
  res.employeeDelivered = sent.ok;

  var ownerMsgs = [];
  if (!rec.ownerSent) {
    if (rec.posterError) {
      ownerMsgs.push('❗ Poster не принял поставку: <b>' + supplyEsc_(label) + '</b> (чат ' + supplyEsc_(st.chatId) + ')\n<code>' +
        supplyEsc_(rec.posterError) + '</code>\nДокумент записан в журнал со статусом «' + SUPPLY_CONST.STATUS_POSTER_ERROR +
        '» (в дубли не считается), его можно отправить заново.');
    } else if (deps.dryRun) {
      ownerMsgs.push(supplyDryRunOwnerText_(st, plan, deps.multiplier, deps.splitByType));
    } else if (plan.notes.length) {
      ownerMsgs.push('ℹ️ <b>' + supplyEsc_(label) + '</b>: ' + supplyEsc_(plan.notes.join('; ')));
    }
    if (!rec.posterError && !deps.dryRun && rec.parts && rec.parts.length > 1) {
      ownerMsgs.push('ℹ️ <b>' + supplyEsc_(label) + '</b>: ' + (rec.splitFallback
        ? 'Poster не принял поставку с товарами и ингредиентами вместе — создано две поставки: '
        : 'Товары и ингредиенты разделены на две поставки (SUPPLY_POSTER_SPLIT_BY_TYPE): ') +
        rec.parts.map(function (x) { return x.key + ' №' + x.id; }).join(', ') + '.');
    }
  }
  if (!sent.ok) {
    ownerMsgs.push('⚠️ Не удалось отправить сотруднику (чат ' + supplyEsc_(st.chatId) + ') сообщение «' + supplyEsc_(empText) +
      '». Запись выполнена, повторно создавать её не нужно.\n<code>' +
      supplyEsc_(supplySanitizeSecrets_(String(sent.error && sent.error.message ? sent.error.message : sent.error)).substring(0, 300)) + '</code>');
  }
  ownerMsgs.forEach(function (m) {
    try { deps.sendOwner(m); } catch (e4) { console.error('supplyFinalizeCore_ владельцу: ' + e4.message); }
  });
  rec.ownerSent = true;

  deps.clearState(st);
  return res;
}

// ---------------------------------------------------------------------------
// Самотест этапа 4
// ---------------------------------------------------------------------------

/**
 * Самотест этапа 4 без Telegram, Poster и листов (внешние действия заменены заглушками).
 * Запуск вручную; результат в журнале выполнения.
 */
function supplyStage4SelfTest() {
  var fails = 0;
  function expect(name, cond) {
    console.log((cond ? 'OK   ' : 'FAIL ') + name);
    if (!cond) fails++;
  }
  // Точная сумма строк в тиынах × 1000: Σ (кол-во в тысячных × цена в тиынах). Для S тиынов должно быть S × 1000.
  function exactT1000(rows, mult) {
    return rows.reduce(function (a, r) {
      return a + Math.round(r.num * 1000) * Math.round(r.sum / (mult || 1) * 100);
    }, 0);
  }

  // --- Повторы Telegram ---
  function runRetry(script) {
    var calls = 0, sleeps = [];
    var r = null, err = null;
    try {
      r = supplyRetryCall_(function () {
        var step = script[Math.min(calls, script.length - 1)];
        calls++;
        if (step === 'throw') throw new Error('network');
        return step;
      }, function (ms) { sleeps.push(ms); });
    } catch (e) { err = e; }
    return { calls: calls, sleeps: sleeps, r: r, err: err };
  }
  var ok200 = { code: 200, text: '{"ok":true}' };
  var t1 = runRetry(['throw', 'throw', ok200]);
  expect('(а) два сетевых сбоя подряд, затем успех: 3 попытки, паузы 1 с и 2 с', t1.calls === 3 && t1.r === ok200 &&
    t1.sleeps.join() === '1000,2000');
  expect('три сбоя подряд: исключение после 3 попыток', runRetry(['throw', 'throw', 'throw']).err !== null);
  expect('5xx повторяются', runRetry([{ code: 500, text: '' }, { code: 502, text: '' }, ok200]).calls === 3);
  expect('429: пауза не меньше retry_after (4 с), не больше 15 с',
    runRetry([{ code: 429, text: '{"parameters":{"retry_after":4}}' }, ok200]).sleeps[0] === 4000 &&
    runRetry([{ code: 429, text: '{"parameters":{"retry_after":99}}' }, ok200]).sleeps[0] === 15000);
  expect('прочие 4xx не повторяются', runRetry([{ code: 400, text: '' }, ok200]).calls === 1);

  // Количество × цена по строкам в тиынах (по строкам округляется до 0,01 ₸).
  function lineT(rows, mult) {
    return rows.reduce(function (a, r) { return a + Math.round(r.num * (r.sum / (mult || 1)) * 100); }, 0);
  }

  // --- По умолчанию: одна позиция = одна строка, цена = S/Q на 6 знаков (без округления до копеек) ---
  var set132 = supplyPlanLineSet_({ name: 'Товар', qtyWh: 132, lineSum: 26243.8 }, 1);
  expect('26243,8 ₸ / 132 шт: ОДНА строка с ценой 198,816667',
    set132.rows.length === 1 && set132.rows[0].num === 132 && set132.rows[0].sum === 198.816667 && set132.note === '');
  expect('26243,8 ₸ / 132 шт: количество × цена = 26243,80 ₸ (до 0,01)', lineT(set132.rows) === 2624380 && set132.postedT === 2624380);
  var set9 = supplyPlanLineSet_({ name: 'Молоко', qtyWh: 9, lineSum: 500 }, 1);
  expect('500 ₸ / 9 л: одна строка с ценой 55,555556, итог 500,00',
    set9.rows.length === 1 && set9.rows[0].num === 9 && set9.rows[0].sum === 55.555556 && lineT(set9.rows) === 50000);
  var set40 = supplyPlanLineSet_({ name: 'Сосиски', qtyWh: 40, lineSum: 2520 }, 1);
  expect('2520 ₸ / 40 шт: одна строка по 63', set40.rows.length === 1 && set40.rows[0].num === 40 && set40.rows[0].sum === 63);
  var set869 = supplyPlanLineSet_({ name: 'Томаты', qtyWh: 8.69, lineSum: 100 }, 1);
  expect('8,69 кг на 100 ₸: одна строка с ценой 11,50748 (6 знаков), итог 100,00',
    set869.rows.length === 1 && set869.rows[0].num === 8.69 && set869.rows[0].sum === 11.50748 && lineT(set869.rows) === 10000);
  var set869b = supplyPlanLineSet_({ name: 'Огурцы', qtyWh: 8.69, lineSum: 1234.56 }, 1);
  expect('8,69 кг на 1234,56 ₸: одна строка, количество × цена = 1234,56 ₸',
    set869b.rows.length === 1 && lineT(set869b.rows) === 123456 && set869b.postedT === 123456);
  console.log('   8,69 кг / 1234,56 ₸ → цена ' + set869b.rows[0].sum);
  var setNo = supplyPlanLineSet_({ name: 'Без цены', qtyWh: 3, lineSum: null }, 1);
  expect('нет суммы позиции: sum = 0 и отметка «нет цены»', setNo.noPrice === true && setNo.rows[0].sum === 0);
  var setFb = supplyPlanLineSet_({ name: 'Корм', qtyWh: 0.3333, lineSum: 100 }, 1);
  expect('количество с >3 знаками: одна строка, цена 300,030003, без пометки (разбиение выключено)',
    setFb.rows.length === 1 && setFb.rows[0].sum === 300.030003 && setFb.note === '');

  // Множитель применяется к цене (6 знаков)
  var mult = supplyPlanLineSet_({ name: 'Товар', qtyWh: 132, lineSum: 26243.8 }, 100);
  expect('(г) множитель ×100 применяется к цене 198,816667: 19881,6667',
    mult.rows.length === 1 && mult.rows[0].sum === 19881.6667 && lineT(mult.rows, 100) === 2624380);
  expect('(г) множитель не задан = 1', supplyPlanLineSet_({ name: 'Т', qtyWh: 40, lineSum: 2520 }, undefined).rows[0].sum === 63);

  // --- Флаг SUPPLY_SPLIT_LINES ---
  expect('флаг SUPPLY_SPLIT_LINES: true / да / 1 — включён, пусто / false / не задан — выключен',
    supplyFlagTrue_('true') && supplyFlagTrue_('Да') && supplyFlagTrue_('1') &&
    !supplyFlagTrue_('') && !supplyFlagTrue_('false') && !supplyFlagTrue_(null) && !supplyFlagTrue_(undefined));

  // --- SUPPLY_SPLIT_LINES=true: прежнее разбиение на две строки с точным итогом ---
  var split = supplySplitLineT_(2624380, 132000); // 26243,8 ₸ / 132 шт
  expect('supplySplitLineT_: 26243,8 ₸ / 132 шт — 44 шт по 198,81 и 88 шт по 198,82',
    split.length === 2 && split[0].qtyM === 44000 && split[0].priceT === 19881 && split[1].qtyM === 88000 && split[1].priceT === 19882);
  var sp132 = supplyPlanLineSet_({ name: 'Товар', qtyWh: 132, lineSum: 26243.8 }, 1, true);
  expect('флаг включён: 26243,8 ₸ / 132 шт — две строки, сумма ровно 26243,8 ₸',
    sp132.rows.length === 2 && exactT1000(sp132.rows) === 2624380 * 1000 && sp132.rows[0].sum === 198.81 && sp132.rows[1].sum === 198.82 &&
    sp132.rows[0].num === 44 && sp132.rows[1].num === 88 && sp132.note === '');
  var sp9 = supplyPlanLineSet_({ name: 'Молоко', qtyWh: 9, lineSum: 500 }, 1, true);
  expect('флаг включён: 500 ₸ / 9 л — 4 л по 55,55 и 5 л по 55,56',
    sp9.rows.length === 2 && sp9.rows[0].num === 4 && sp9.rows[0].sum === 55.55 && sp9.rows[1].num === 5 && sp9.rows[1].sum === 55.56);
  expect('флаг включён: 2520 ₸ / 40 шт — одна строка по 63 (остатка нет)',
    supplyPlanLineSet_({ name: 'Сосиски', qtyWh: 40, lineSum: 2520 }, 1, true).rows.length === 1);
  var sp869 = supplyPlanLineSet_({ name: 'Томаты', qtyWh: 8.69, lineSum: 100 }, 1, true);
  expect('флаг включён: 8,69 кг на 100 ₸ — две строки, ровно 100 ₸',
    sp869.rows.length === 2 && exactT1000(sp869.rows) === 10000 * 1000 && sp869.rows[0].num + sp869.rows[1].num === 8.69);
  expect('флаг включён: ×100 — цены 19881 и 19882', (function () {
    var m = supplyPlanLineSet_({ name: 'Товар', qtyWh: 132, lineSum: 26243.8 }, 100, true);
    return m.rows[0].sum === 19881 && m.rows[1].sum === 19882;
  })());
  var spFb = supplyPlanLineSet_({ name: 'Корм', qtyWh: 0.3333, lineSum: 100 }, 1, true);
  expect('флаг включён, точное разбиение невозможно: одна строка и пометка «итог может отличаться на … ₸»',
    spFb.rows.length === 1 && spFb.note.indexOf('итог может отличаться на') !== -1);

  // Свойство разбиения: для любых S и Q (до 3 знаков) сумма строк точно равна S; цены p и p+1; количества положительны.
  var seed = 12345, bad = 0, checked = 0;
  function rnd(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; }
  for (var i = 0; i < 3000; i++) {
    var Sx = 1 + rnd(5000000);          // до 50 000,00 ₸
    var Qx = 1 + rnd(200000);           // до 200,000 ед.
    var sp = supplySplitLineT_(Sx, Qx);
    var tot = sp.reduce(function (a, r) { return a + r.qtyM * r.priceT; }, 0);
    var qsum = sp.reduce(function (a, r) { return a + r.qtyM; }, 0);
    var okRow = sp.every(function (r) { return r.qtyM > 0 && r.priceT >= 0 && r.qtyM === Math.floor(r.qtyM); }) &&
      (sp.length === 1 || sp[1].priceT === sp[0].priceT + 1);
    if (tot !== Sx * 1000 || qsum !== Qx || !okRow) bad++;
    checked++;
  }
  expect('свойство supplySplitLineT_ на ' + checked + ' случайных (S, Q): сумма строк ровно S, сумма количеств ровно Q', bad === 0);

  function mkState(uid, over) {
    var item = { name: 'Круг полукопчёный, вес', qty: 4.2, unit: 'кг', price: 600, sum: 2520, sku: null };
    var entry = { row: 4, id: 3, posterName: 'сосиски', unit: 'шт', mode: 'ввод штук', coef: null, weight: null, price: null, count: 0, avg: null, sku: '' };
    var item2 = { name: 'Молоко Зенченко 0,9 л', qty: 10, unit: 'шт', price: 50, sum: 500, sku: null };
    var entry2 = { row: 5, id: 4, posterName: 'молоко', unit: 'л', mode: 'коэффициент', coef: 0.9, weight: null, price: null, count: 0, avg: null, sku: '' };
    var item3 = { name: 'Пакет', qty: 5, unit: 'шт', price: 1, sum: 5, sku: null };
    var entry3 = { row: 6, id: null, posterName: '', unit: '', mode: 'пропускать', coef: null, weight: null, price: null, count: 0, avg: null, sku: '' };
    var st = {
      chatId: '111', sid: 'abc', step: 'disc', msgId: 1, discMsgId: 2, dupConfirmed: false,
      doc: { source: 'Qazmeatproduct', doc_type: 'invoice', doc_number: '4872', datetime: '09.10.2026', total: 3025, items: [item, item2, item3] },
      match: { supplier: { id: 6, name: 'Qazmeatproduct' }, lines: [
        supplyMatchBuildLine_(1, item, entry, 40), supplyMatchBuildLine_(2, item2, entry2), supplyMatchBuildLine_(3, item3, entry3)] },
      file: { uniqueId: uid || 'U1', archiveFileId: 'a', kind: 'photo' }
    };
    Object.keys(over || {}).forEach(function (k) { st[k] = over[k]; });
    return st;
  }
  function mkDeps(o) {
    o = o || {};
    var d = {
      dryRun: o.dryRun !== undefined ? o.dryRun : true, multiplier: o.multiplier || 1, splitLines: !!o.splitLines,
      nowAstana: function () { return '2026-10-10 11:30:00'; },
      posterCalls: [], journal: [], stats: 0, employee: [], owner: [], saves: 0, cleared: 0,
      saveState: function () { d.saves++; },
      clearState: function () { d.cleared++; },
      productType: o.productType || 1, splitByType: !!o.splitByType, rulesSaved: 0,
      saveRules: function () { d.rulesSaved++; },
      posterCreate: function (payload) {
        d.posterCalls.push(payload);
        if (o.posterScript) return o.posterScript(payload, d.posterCalls.length);
        if (o.posterFails) throw new Error('Poster storage.createSupply HTTP 200: {"error":{"code":16,"message":"bad"}}');
        return 777;
      },
      journalAppend: function (e) { d.journal.push(e); return { row: d.journal.length + 1, duplicate: !!o.duplicate }; },
      applyStats: function () { d.stats++; },
      send: function (st, text) {
        if (o.sendFailsTimes && d.sendTries === undefined) d.sendTries = 0;
        if (o.sendFailsTimes) { d.sendTries++; if (d.sendTries <= o.sendFailsTimes) throw new Error('network'); }
        d.employee.push(text);
      },
      sendOwner: function (text) { d.owner.push(text); },
      editDisc: function () {}
    };
    return d;
  }

  // --- Состав payload (разбиение выключено: одна позиция = одна строка) ---
  var stP = mkState();
  var plan = supplyBuildSupplyPlan_(stP, '2026-10-10 11:30:00', 1);
  var pl = plan.payload;
  expect('payload: storage_id 1, supplier_id 6, дата Y-m-d H:i:s',
    pl.supply.storage_id === 1 && pl.supply.supplier_id === 6 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(pl.supply.date));
  expect('payload: две строки (по позиции), все числа — number, type 4; пропускаемая позиция не попадает',
    pl.ingredient.length === 2 && pl.ingredient.every(function (x) {
      return x.type === 4 && typeof x.id === 'number' && typeof x.num === 'number' && typeof x.sum === 'number';
    }));
  expect('payload: сосиски 40 по 63; молоко 9 л по 55,555556',
    pl.ingredient[0].id === 3 && pl.ingredient[0].num === 40 && pl.ingredient[0].sum === 63 &&
    pl.ingredient[1].id === 4 && pl.ingredient[1].num === 9 && pl.ingredient[1].sum === 55.555556);
  expect('payload: количество × цена по строкам = 3020 ₸ = итог накладной 3025 ₸ за вычетом пропускаемых 5 ₸',
    plan.postedT === 302000 && plan.expectedT === 302000 && plan.mismatchT === 0 && lineT(plan.lines) === 302000);
  expect('комментарий: только название поставщика и «бот», без номера и даты с фото',
    pl.supply.supply_comment === 'Qazmeatproduct (бот)' && pl.supply.supply_comment.indexOf('4872') === -1 &&
    pl.supply.supply_comment.indexOf('2026') === -1 && supplySupplyComment_('') === '(бот)');
  var planS = supplyBuildSupplyPlan_(stP, '2026-10-10 11:30:00', 1, true);
  expect('SUPPLY_SPLIT_LINES=true: молоко в payload двумя строками (4 по 55,55 и 5 по 55,56)',
    planS.payload.ingredient.length === 3 && planS.payload.ingredient[1].num === 4 && planS.payload.ingredient[1].sum === 55.55 &&
    planS.payload.ingredient[2].num === 5 && planS.payload.ingredient[2].sum === 55.56 && planS.mismatchT === 0);
  expect('(г) множитель ×100 в payload', supplyBuildSupplyPlan_(stP, 'x', 100).payload.ingredient.map(function (x) { return x.sum; }).join() === '6300,5555.5556');

  // --- Проверка расхождения позиций и итога ---
  var stM = mkState(null, { doc: { source: 'Qazmeatproduct', doc_type: 'invoice', doc_number: '1', datetime: 'x', total: 3030,
    items: mkState().doc.items } });
  var planM = supplyBuildSupplyPlan_(stM, 'x', 1);
  expect('итог накладной 3030, позиции 3020 + пропускаемые 5: расхождение −5 ₸', planM.mismatchT === -500);
  console.log('   ' + supplySumMismatchText_(stM, planM));
  var stM2 = mkState(null, { doc: { source: 'Qazmeatproduct', doc_type: 'invoice', doc_number: '1', datetime: 'x', total: 3000,
    items: mkState().doc.items } });
  expect('итог накладной 3000: расхождение +25 ₸', supplyBuildSupplyPlan_(stM2, 'x', 1).mismatchT === 2500);
  expect('позиция без цены даёт расхождение (итог не сверить)',
    (function () {
      var s = mkState(); s.match.lines[0] = supplyMatchBuildLine_(1, { name: 'a', qty: 4.2, unit: 'кг', price: null, sum: null }, s.match.lines[0].entry, 40);
      return supplyBuildSupplyPlan_(s, 'x', 1).mismatchT !== 0;
    })());

  // --- (д) dry-run не вызывает Poster ---
  var dD = mkDeps({ dryRun: true }), sD = mkState();
  var rD = supplyFinalizeCore_(sD, false, '', dD);
  expect('(д) dry-run: Poster не вызывается', dD.posterCalls.length === 0);
  expect('dry-run: журнал 1 строка со статусом dry-run, ссылка на файл пустая, статистика 1',
    dD.journal.length === 1 && dD.journal[0].status === 'dry-run' && dD.journal[0].link === '' && dD.stats === 1);
  expect('dry-run: сотруднику «Принято: 2 позиции…», владельцу «Оприходовал бы»',
    rD.status === 'dry-run' && dD.employee.length === 1 && dD.employee[0].indexOf('Принято: 2 позиции') === 0 &&
    dD.owner.length === 1 && dD.owner[0].indexOf('Оприходовал бы в Poster') !== -1);
  var ownerTxt = dD.owner[0];
  console.log('   ' + ownerTxt.replace(/\n/g, ' | '));
  expect('dry-run: одна строка на позицию (без [1/2]): количество, цена (4 знака), сумма позиции из накладной',
    ownerTxt.indexOf('1. сосиски — 40 шт × 63 ₸ (по накладной ' + supplyFmtNum_(2520) + ' ₸)') !== -1 &&
    ownerTxt.indexOf('2. молоко — 9 л × 55,5556 ₸ (по накладной 500 ₸)') !== -1 && ownerTxt.indexOf('[1/2]') === -1 &&
    ownerTxt.indexOf('2026-10-10 11:30:00') !== -1);
  expect('dry-run: комментарий в сообщении — только поставщик и «бот»', ownerTxt.indexOf('Комментарий: Qazmeatproduct (бот)') !== -1);
  expect('dry-run: «Итого по накладной» показан, «Итого в Poster» не показан (итог совпал), предупреждений нет',
    ownerTxt.indexOf('Итого по накладной: ' + supplyFmtNum_(3025) + ' ₸') !== -1 && ownerTxt.indexOf('Итого в Poster') === -1 &&
    ownerTxt.indexOf('не равна') === -1);
  var planD = JSON.parse(JSON.stringify(plan));
  planD.postedT += 1; // количество × цена по строкам дало на 0,01 ₸ больше итога накладной
  var txtD = supplyDryRunOwnerText_(stP, planD, 1);
  expect('dry-run: если «количество × цена» отличается от накладной — «Итого в Poster» показывается с разницей',
    txtD.indexOf('Итого в Poster (количество × цена по строкам): ' + supplyFmtNum_(3020.01) + ' ₸') !== -1 && txtD.indexOf('отличается от накладной на 0,01 ₸') !== -1);
  expect('цена в сообщении: без хвостовых нулей, максимум 4 знака',
    supplyFmtPrice4_(312) === '312' && supplyFmtPrice4_(63) === '63' && supplyFmtPrice4_(55.5) === '55,5' &&
    supplyFmtPrice4_(55.50004) === '55,5' && supplyFmtPrice4_(198.816667) === '198,8167' && supplyFmtPrice4_(198.8167) === '198,8167' &&
    supplyFmtPrice4_(0.05) === '0,05' && supplyFmtPrice4_(1200) === '1' + '\u00a0' + '200' &&
    supplyFmtPrice4_(19881.6667) === '19' + '\u00a0' + '881,6667' && supplyFmtPrice4_(1000.00004) === '1' + '\u00a0' + '000');
  expect('отображение не меняет payload: цена 198,816667 уходит как есть, в сообщении «198,8167»',
    supplyPlanLineSet_({ name: 'Т', qtyWh: 132, lineSum: 26243.8 }, 1).rows[0].sum === 198.816667 &&
    supplyFmtPrice4_(supplyPlanLineSet_({ name: 'Т', qtyWh: 132, lineSum: 26243.8 }, 1).rows[0].sum) === '198,8167');
  var dDs = mkDeps({ dryRun: true, splitLines: true }), sDs = mkState();
  supplyFinalizeCore_(sDs, false, '', dDs);
  expect('SUPPLY_SPLIT_LINES=true в сообщении владельцу: обе строки с пометками [1/2] и [2/2]',
    dDs.owner[0].indexOf('молоко [1/2] — 4 л × 55,55 ₸') !== -1 && dDs.owner[0].indexOf('молоко [2/2] — 5 л × 55,56 ₸') !== -1);
  var dDm = mkDeps({ dryRun: true }), sDm = mkState(null, { doc: stM.doc });
  supplyFinalizeCore_(sDm, false, '', dDm);
  expect('dry-run: расхождение позиций и итога показывается владельцу, запись разрешена',
    dDm.owner[0].indexOf('Сумма позиций') !== -1 && dDm.owner[0].indexOf('не равна') !== -1 && dDm.journal.length === 1 && dDm.posterCalls.length === 0);
  expect('состояние помечено «записано», затем очищено', sD.recorded === true && dD.cleared === 1);

  // --- Боевой режим ---
  var dLm = mkDeps({ dryRun: false }), sLm = mkState(null, { doc: stM.doc });
  var rLm = supplyFinalizeCore_(sLm, false, '', dLm);
  expect('боевой режим: расхождение позиций и итога — запись остановлена (Poster, журнал, статистика не тронуты)',
    rLm.status === 'blocked_sum' && dLm.posterCalls.length === 0 && dLm.journal.length === 0 && dLm.stats === 0 &&
    dLm.employee[0] === 'Передано владельцу' && dLm.owner[0].indexOf('остановлена') !== -1);
  var dLo = mkDeps({ dryRun: false }), sLo = mkState(null, { doc: stM.doc, sumAccepted: true });
  supplyFinalizeCore_(sLo, false, '', dLo);
  expect('боевой режим: владелец подтвердил «записать как есть» — запись выполняется', dLo.posterCalls.length === 1 && dLo.journal.length === 1);

  // --- (б) повторные нажатия не создают вторую запись ---
  var dL = mkDeps({ dryRun: false }), sL = mkState();
  supplyFinalizeCore_(sL, false, '', dL);
  supplyFinalizeCore_(sL, false, '', dL);
  supplyFinalizeCore_(sL, true, 'другое', dL);
  expect('(б) боевой режим, три нажатия подряд: Poster вызван 1 раз, строк журнала 1, статистика 1',
    dL.posterCalls.length === 1 && dL.journal.length === 1 && dL.stats === 1);
  expect('боевой режим: статус «принято», ID поставки в журнале, ссылка на файл пустая',
    dL.journal[0].status === 'принято' && dL.journal[0].posterId === 777 && dL.journal[0].link === '');
  expect('боевой режим: в Poster ушёл тот же payload (2 строки), владельцу «Оприходовал бы» не шлётся',
    dL.posterCalls[0].ingredient.length === 2 && dL.owner.length === 0);
  expect('повторное нажатие только повторяет «Принято», вторая запись не создаётся', dL.employee.length === 3);

  // --- Продолжение после сбоя в середине записи ---
  var dR = mkDeps({ dryRun: false }), sR = mkState();
  sR.rec = { started: true, stamp: '2026-10-10 11:30:00', disc: { hasDisc: false, comment: '' }, posterDone: true, posterId: 555 };
  supplyFinalizeCore_(sR, false, '', dR);
  expect('Poster уже отвечал успешно до сбоя: повторно не вызывается, в журнал идёт его ID',
    dR.posterCalls.length === 0 && dR.journal.length === 1 && dR.journal[0].posterId === 555);

  // --- (а) сбои отправки сообщений не влияют на запись ---
  var dN = mkDeps({ dryRun: false, sendFailsTimes: 2 }), sN = mkState();
  var rN = supplyFinalizeCore_(sN, false, '', dN);
  expect('(а) два сбоя отправки подряд: запись ровно одна (Poster 1, журнал 1, статистика 1)',
    dN.posterCalls.length === 1 && dN.journal.length === 1 && dN.stats === 1);
  expect('(а) «Принято» не доставлено — уведомлён только владелец, статус записи сохранён',
    rN.employeeDelivered === false && dN.employee.length === 0 && dN.owner.length === 1 &&
    dN.owner[0].indexOf('Не удалось отправить сотруднику') !== -1 && rN.status === 'accepted');
  var dN1 = mkDeps({ dryRun: false, sendFailsTimes: 1 }), sN1 = mkState();
  var rN1 = supplyFinalizeCore_(sN1, false, '', dN1);
  expect('один сбой отправки: повторная попытка доставляет «Принято», владельцу ничего',
    rN1.employeeDelivered === true && dN1.employee.length === 1 && dN1.owner.length === 0);

  // --- Ошибка Poster ---
  var dE = mkDeps({ dryRun: false, posterFails: true }), sE = mkState();
  var rE = supplyFinalizeCore_(sE, false, '', dE);
  expect('ошибка Poster: журнал «ошибка Poster», не «принято»; статистика не обновляется',
    rE.status === 'poster_error' && dE.journal.length === 1 && dE.journal[0].status === 'ошибка Poster' && dE.stats === 0);
  expect('ошибка Poster: сотруднику «Передано владельцу», владельцу текст ошибки',
    dE.employee.length === 1 && dE.employee[0] === 'Передано владельцу' && dE.owner.length === 1 &&
    dE.owner[0].indexOf('bad') !== -1 && dE.owner[0].indexOf('Poster не принял поставку') !== -1);
  expect('ошибка Poster: повторное нажатие не вызывает Poster снова', (function () {
    supplyFinalizeCore_(sE, false, '', dE);
    return dE.posterCalls.length === 1 && dE.journal.length === 1;
  })());
  expect('«ошибка Poster» в дубли не считается (можно отправить заново)',
    supplyJrnCounts_({ status: 'ошибка Poster' }) === false &&
    supplyJrnClassify_([{ computedKey: 's6|2026-10-10', supplierKey: 's6', sum: 3025, status: 'ошибка Poster', atMs: Date.now() }],
      { total: 3025 }, 's6|2026-10-10', { recentCheck: true }) === null);

  // --- Дубль: статистика не обновляется ---
  var dU = mkDeps({ dryRun: true, duplicate: true }), sU = mkState();
  supplyFinalizeCore_(sU, false, '', dU);
  expect('дубль: запись в журнале есть, статистика справочника не обновляется', dU.journal.length === 1 && dU.stats === 0);
  var dU2 = mkDeps({ dryRun: false }), sU2 = mkState(null, { dupConfirmed: true });
  supplyFinalizeCore_(sU2, false, '', dU2);
  var dU3 = mkDeps({ dryRun: true }), sU3 = mkState(null, { dupConfirmed: true });
  supplyFinalizeCore_(sU3, false, '', dU3);
  expect('«Это новый документ»: в боевом режиме статистика разрешена (forceStats), в dry-run нет',
    dU2.journal[0].forceStats === true && dU3.journal[0].forceStats === false);
  expect('file_unique_id передаётся в журнал', dU.journal[0].fileUid === 'U1');

  // --- (в) один и тот же file_unique_id ---
  var rows = [
    { fileUid: 'U1', status: 'dry-run' }, { fileUid: 'U2', status: 'принято' },
    { fileUid: 'U3', status: 'ошибка Poster' }, { fileUid: '', status: 'принято' }];
  expect('(в) снимок со статусом dry-run найден', supplyJrnClassifySnapshot_(rows, 'U1') !== null);
  expect('(в) снимок со статусом «принято» найден', supplyJrnClassifySnapshot_(rows, 'U2') !== null);
  expect('(в) снимок с «ошибка Poster» не считается', supplyJrnClassifySnapshot_(rows, 'U3') === null);
  expect('(в) новый снимок и пустой id — без предупреждения',
    supplyJrnClassifySnapshot_(rows, 'U9') === null && supplyJrnClassifySnapshot_(rows, '') === null);
  expect('(в) uid берётся из сообщения: самый большой размер фото и документ',
    supplyFileFromMessage_({ photo: [{ file_id: 'a', file_unique_id: 'ua', width: 90, height: 90 },
      { file_id: 'b', file_unique_id: 'ub', width: 1280, height: 960 }] }).uniqueId === 'ub' &&
    supplyFileFromMessage_({ document: { file_id: 'd', file_unique_id: 'ud', mime_type: 'application/pdf', file_name: 'x.pdf' } }).uniqueId === 'ud');


  // --- Товары и ингредиенты в одной поставке ---
  function mixedState(over) {
    var im = { name: 'Молоко', qty: 9, unit: 'л', price: 500 / 9, sum: 500, sku: null };
    var ic = { name: 'Coca-Cola 0,5 л', qty: 24, unit: 'шт', price: 312, sum: 7488, sku: null };
    var em = { row: 5, id: 10, posterName: 'молоко', unit: 'л', mode: 'прямо', coef: 1, weight: null, price: null, count: 0, avg: null, sku: '', ptype: 'ингредиент' };
    var ec = { row: 6, id: 20, posterName: 'Напитки', unit: 'шт', mode: 'прямо', coef: 1, weight: null, price: null, count: 0, avg: null, sku: '', ptype: 'товар' };
    var st = {
      chatId: '111', sid: 'abc', step: 'disc', msgId: 1, discMsgId: 2, dupConfirmed: false,
      doc: { source: 'Магнум', doc_type: 'receipt', doc_number: '1', datetime: 'x', total: 7988, items: [im, ic] },
      match: { supplier: { id: 13, name: 'Магнум' }, lines: [supplyMatchBuildLine_(1, im, em), supplyMatchBuildLine_(2, ic, ec)] },
      file: { uniqueId: 'M1' }
    };
    Object.keys(over || {}).forEach(function (k) { st[k] = over[k]; });
    return st;
  }
  var dMix = mkDeps({ dryRun: false }), sMix = mixedState();
  supplyFinalizeCore_(sMix, false, '', dMix);
  expect('смешанная поставка по умолчанию: один createSupply с товаром (type 1) и ингредиентом (type 4)',
    dMix.posterCalls.length === 1 && dMix.posterCalls[0].ingredient.length === 2 &&
    dMix.posterCalls[0].ingredient[0].type === 4 && dMix.posterCalls[0].ingredient[1].type === 1 &&
    dMix.journal[0].status === 'принято' && dMix.journal[0].posterId === 777);

  var dFb = mkDeps({ dryRun: false, posterScript: function (payload, n) {
    if (n === 1) { var e = new Error('Poster storage.createSupply HTTP 200: {"error":"mixed types"}'); e.apiError = true; throw e; }
    return 100 + n; } }), sFb = mixedState();
  supplyFinalizeCore_(sFb, false, '', dFb);
  expect('Poster отказал смешанной поставке (ошибка в ответе): повтор двумя поставками — товары (type 1) и ингредиенты (type 4)',
    dFb.posterCalls.length === 3 && dFb.posterCalls[1].ingredient.length === 1 && dFb.posterCalls[1].ingredient[0].type === 1 &&
    dFb.posterCalls[2].ingredient.length === 1 && dFb.posterCalls[2].ingredient[0].type === 4 &&
    dFb.posterCalls[1].supply.supplier_id === 13 && dFb.posterCalls[2].supply.supplier_id === 13);
  expect('после разделения: журнал «принято», ID обеих поставок, владельцу сообщено о разделении',
    dFb.journal.length === 1 && dFb.journal[0].status === 'принято' && dFb.journal[0].posterId === '102, 103' &&
    dFb.owner.some(function (m) { return m.indexOf('Poster не принял поставку с товарами и ингредиентами вместе') !== -1; }));
  supplyFinalizeCore_(sFb, false, '', dFb);
  expect('повторное нажатие после разделения Poster не вызывает', dFb.posterCalls.length === 3 && dFb.journal.length === 1);

  var dNet = mkDeps({ dryRun: false, posterScript: function () { throw new Error('Exception: timeout'); } }), sNet = mixedState();
  var rNet = supplyFinalizeCore_(sNet, false, '', dNet);
  expect('сетевой сбой (не определённый отказ Poster): повторной поставки нет, «ошибка Poster»',
    dNet.posterCalls.length === 1 && rNet.status === 'poster_error' && dNet.journal[0].status === 'ошибка Poster');

  var dSp = mkDeps({ dryRun: false, splitByType: true }), sSp = mixedState();
  supplyFinalizeCore_(sSp, false, '', dSp);
  expect('SUPPLY_POSTER_SPLIT_BY_TYPE: сразу две поставки (товары, затем ингредиенты)',
    dSp.posterCalls.length === 2 && dSp.posterCalls[0].ingredient[0].type === 1 && dSp.posterCalls[1].ingredient[0].type === 4 &&
    dSp.owner.some(function (m) { return m.indexOf('SUPPLY_POSTER_SPLIT_BY_TYPE') !== -1; }));

  var dPart = mkDeps({ dryRun: false, splitByType: true, posterScript: function (payload, n) { if (n === 2) throw new Error('Poster HTTP 200: {"error":"x"}'); return 555; } }), sPart = mixedState();
  var rPart = supplyFinalizeCore_(sPart, false, '', dPart);
  expect('вторая из двух поставок не прошла: «ошибка Poster» с предупреждением, что первая уже создана',
    rPart.status === 'poster_error' && dPart.owner[0].indexOf('часть поставки уже создана') !== -1 && dPart.owner[0].indexOf('№555') !== -1);

  var dRs = mkDeps({ dryRun: false, splitByType: true }), sRs = mixedState();
  sRs.rec = { started: true, stamp: '2026-10-10 11:30:00', disc: { hasDisc: false, comment: '' },
              parts: [{ key: 'товар', done: true, id: 9 }, { key: 'ингредиент', done: false, id: null }] };
  supplyFinalizeCore_(sRs, false, '', dRs);
  expect('продолжение после сбоя: создана только недостающая часть (ингредиенты), без повтора товаров',
    dRs.posterCalls.length === 1 && dRs.posterCalls[0].ingredient[0].type === 4 && dRs.journal[0].posterId === '9, 777');

  var dDm = mkDeps({ dryRun: true, splitByType: true }), sDm2 = mixedState();
  supplyFinalizeCore_(sDm2, false, '', dDm);
  expect('dry-run со смешанной поставкой: Poster не вызывается, владельцу — «(товар)» и две поставки',
    dDm.posterCalls.length === 0 && dDm.owner[0].indexOf('Напитки (товар)') !== -1 && dDm.owner[0].indexOf('Поставка 1 — товары') !== -1);

  var dRule = mkDeps({ dryRun: true }), sRule = mixedState();
  sRule.match.lines[1].rule = { word: 'cola', targetName: 'Напитки', kind: 'товар' };
  supplyFinalizeCore_(sRule, false, '', dRule);
  supplyFinalizeCore_(sRule, false, '', dRule);
  expect('позиции по правилам сохраняются в справочник один раз (до статистики), в сообщении владельцу — «(по правилу)»',
    dRule.rulesSaved === 1 && dRule.owner[0].indexOf('(по правилу)') !== -1);

  console.log(fails ? 'ПРОВАЛЕНО тестов: ' + fails : 'Все проверки пройдены.');
}
