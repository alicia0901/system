/**
 * シフト表 共通ロジック
 * ------------------------------------------------
 * このファイルは shiftCoreFactory 1つだけを定義する。
 * 中では GAS の API(SpreadsheetApp など)も、このファイルの外の変数・関数(CONFIG など)も一切使わないこと。
 * サーバ側(Shift.gs)は shiftCoreFactory() を呼んで使い、画面側(shift.html)には
 * shiftCoreFactory.toString() をテンプレートで埋め込んで同じコードを動かすため。
 */
function shiftCoreFactory() {
  'use strict';

  // ==================== 日付・時間ユーティリティ ====================
  // 日付は 'YYYY-MM-DD' 文字列で扱い、計算は UTC で行う(タイムゾーンに依存させない)。

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function hhmmToMin(s) {
    const parts = String(s).split(':');
    return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
  }

  /** 枠の時間を分で返す。終了が開始以前なら翌日終了とみなす。 */
  function slotRange(slot) {
    const startMin = hhmmToMin(slot.start);
    let endMin = hhmmToMin(slot.end);
    if (endMin <= startMin) endMin += 1440;
    return { startMin: startMin, endMin: endMin };
  }

  function dateToUtc(date) {
    const p = String(date).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]);
  }

  function utcToDate(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function addDays(date, n) { return utcToDate(dateToUtc(date) + n * 86400000); }

  function listDates(from, to) {
    const out = [];
    for (let ms = dateToUtc(from), end = dateToUtc(to); ms <= end; ms += 86400000) out.push(utcToDate(ms));
    return out;
  }

  function weekdayOf(date) { return new Date(dateToUtc(date)).getUTCDay(); }

  /** その日を含む週(月曜始まり)の月曜日 */
  function mondayOf(date) { return addDays(date, -((weekdayOf(date) + 6) % 7)); }

  function formatMD(date) {
    const p = String(date).split('-').map(Number);
    return p[1] + '/' + p[2];
  }

  // ==================== 枠の展開 ====================

  function positionsOf(settings) {
    return (settings.positions && settings.positions.length) ? settings.positions : [''];
  }

  function slotOverlapsPeriods(slot, periods) {
    const r = slotRange(slot);
    return (periods || []).some(function (p) { return r.startMin < p.endMin && p.startMin < r.endMin; });
  }

  /**
   * 期間内の「日 × 枠 × 担当」のセル一覧を作る。
   * - 休業日は枠なし
   * - その曜日を weekdays に含む枠を使う。含む枠が1つもない「特別な日」(business[date].special。
   *   普段は定休の曜日の臨時営業日など)は、営業時間帯と時間が重なる枠をすべて使う
   * - dayOverrides の off で除き、on で足す
   */
  function buildCells(settings, dates, business, dayOverrides) {
    const slots = settings.slots || [];
    const positions = positionsOf(settings);
    const overrides = {};
    (dayOverrides || []).forEach(function (o) { overrides[o.date + '|' + o.slotId] = o.state; });

    const cells = [];
    dates.forEach(function (date) {
      const b = business[date];
      if (!b || b.closed) return;
      const wd = weekdayOf(date);
      const byWeekday = slots.filter(function (s) { return (s.weekdays || []).indexOf(wd) !== -1; });
      const base = (byWeekday.length || !b.special)
        ? byWeekday
        : slots.filter(function (s) { return slotOverlapsPeriods(s, b.periods); });
      const baseIds = {};
      base.forEach(function (s) { baseIds[s.id] = true; });

      slots.forEach(function (slot) {
        const state = overrides[date + '|' + slot.id];
        const used = state === 'off' ? false : (state === 'on' ? true : !!baseIds[slot.id]);
        if (!used) return;
        const r = slotRange(slot);
        positions.forEach(function (pos) {
          const required = parseInt((slot.required || {})[pos], 10) || 0;
          if (required <= 0) return;
          cells.push({
            key: date + '|' + slot.id + '|' + pos,
            date: date, slotId: slot.id, slotName: slot.name, position: pos,
            required: required, startMin: r.startMin, endMin: r.endMin,
          });
        });
      });
    });
    return cells;
  }

  return {
    pad2: pad2,
    hhmmToMin: hhmmToMin,
    slotRange: slotRange,
    addDays: addDays,
    listDates: listDates,
    weekdayOf: weekdayOf,
    mondayOf: mondayOf,
    formatMD: formatMD,
    positionsOf: positionsOf,
    buildCells: buildCells,
  };
}
