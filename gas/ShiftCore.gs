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

  // ==================== 問題の組み立て ====================

  /**
   * 自動作成・評価に使う「問題」を組み立てる。
   * input = { from, to, settings, staff, requests, recurring, business, dayOverrides, outsideAssignments }
   */
  function buildProblem(input) {
    const settings = input.settings;
    const dates = listDates(input.from, input.to);
    const cells = buildCells(settings, dates, input.business || {}, input.dayOverrides || []);
    const activeStaff = (input.staff || []).filter(function (st) { return st.active; });

    const staffById = {};
    activeStaff.forEach(function (st) { staffById[st.id] = st; });
    const slotById = {};
    (settings.slots || []).forEach(function (sl) { slotById[sl.id] = sl; });
    const cellByKey = {};
    cells.forEach(function (c) { cellByKey[c.key] = c; });

    const requestIndex = {};
    (input.requests || []).forEach(function (r) {
      requestIndex[r.staffId + '|' + r.date + '|' + (r.slotId || '')] = r.kind;
    });
    const recurringByStaff = {};
    (input.recurring || []).forEach(function (r) {
      (recurringByStaff[r.staffId] = recurringByStaff[r.staffId] || []).push(r);
    });

    // 週の目安日数 → 期間内の目安日数
    const totalDemand = cells.reduce(function (sum, c) { return sum + c.required; }, 0);
    const expectedDays = {};
    let targetedSum = 0;
    const untargeted = [];
    activeStaff.forEach(function (st) {
      if (st.targetDays === null || st.targetDays === undefined || st.targetDays === '') {
        untargeted.push(st.id);
      } else {
        expectedDays[st.id] = Number(st.targetDays) * dates.length / 7;
        targetedSum += expectedDays[st.id];
      }
    });
    const share = untargeted.length ? Math.max(0, totalDemand - targetedSum) / untargeted.length : 0;
    untargeted.forEach(function (id) { expectedDays[id] = share; });

    return {
      from: input.from, to: input.to, settings: settings, dates: dates,
      staff: input.staff || [], activeStaff: activeStaff, staffById: staffById, slotById: slotById,
      cells: cells, cellByKey: cellByKey,
      requests: input.requests || [], recurring: input.recurring || [],
      requestIndex: requestIndex, recurringByStaff: recurringByStaff,
      business: input.business || {}, dayOverrides: input.dayOverrides || [],
      outsideAssignments: input.outsideAssignments || [],
      expectedDays: expectedDays,
    };
  }

  /**
   * その人・その日・その枠の希望。優先順位:
   * その日の枠指定 > その日の終日 > 毎週の枠指定 > 毎週の終日
   * @return {'unavailable'|'prefer_off'|'want'|null}
   */
  function availability(problem, staffId, date, slotId) {
    const idx = problem.requestIndex;
    const bySlot = idx[staffId + '|' + date + '|' + slotId];
    if (bySlot) return bySlot;
    const byDay = idx[staffId + '|' + date + '|'];
    if (byDay) return byDay;
    const rules = problem.recurringByStaff[staffId] || [];
    const wd = weekdayOf(date);
    let dayKind = null;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if ((r.weekdays || []).indexOf(wd) === -1) continue;
      if (r.slotId === slotId) return r.kind;
      if (!r.slotId && !dayKind) dayKind = r.kind;
    }
    return dayKind;
  }

  // ==================== 評価 ====================

  function cellKeyOf(a) { return a.date + '|' + a.slotId + '|' + (a.position || ''); }

  function rangesOverlap(a, b) { return a.startMin < b.endMin && b.startMin < a.endMin; }

  function roundHours(h) { return Math.round(h * 10) / 10; }

  function staffName(problem, id) {
    const st = problem.staffById[id];
    return st ? st.name : id;
  }

  /** 期間内で有効な割り当て(在籍スタッフ・存在するセル)だけを返す */
  function validAssigns(problem, assignments) {
    return (assignments || []).filter(function (a) {
      return a.kind !== 'exclude' && problem.staffById[a.staffId] && problem.cellByKey[cellKeyOf(a)];
    });
  }

  /**
   * 割り当てを評価する。
   * @return {{warnings: Array, penalty: number[], summary: Array}}
   *   penalty = [hard, shortage, avoid, preferOff, veteran, fairness, -want]
   */
  function evaluate(problem, assignments) {
    const warnings = [];
    const penalty = [0, 0, 0, 0, 0, 0, 0];
    const valid = validAssigns(problem, assignments);
    const settings = problem.settings;

    function slotLabel(slotId) { return (problem.slotById[slotId] || {}).name || slotId; }
    function warn(level, code, a, staffIds, message) {
      warnings.push({ level: level, code: code, date: a ? a.date : null, slotId: a ? a.slotId : null,
        position: a ? (a.position || '') : null, staffIds: staffIds, message: message });
    }

    // --- 1件ごとの条件(出られない・担当外・休み希望・出たい)---
    const countByCell = {};
    const byDate = {}; // date -> [{staffId, slotId, startMin, endMin}]
    valid.forEach(function (a) {
      const key = cellKeyOf(a);
      countByCell[key] = (countByCell[key] || 0) + 1;
      const cell = problem.cellByKey[key];
      const st = problem.staffById[a.staffId];
      const prefix = formatMD(a.date) + ' ' + cell.slotName + ': ';
      const av = availability(problem, a.staffId, a.date, a.slotId);
      if (av === 'unavailable') {
        penalty[0]++;
        warn('error', 'unavailable', a, [a.staffId], prefix + st.name + 'さんは出られない日');
      } else if (av === 'prefer_off') {
        penalty[3]++;
        warn('warn', 'prefer_off', a, [a.staffId], prefix + st.name + 'さんは休み希望');
      } else if (av === 'want') {
        penalty[6]--;
      }
      if (a.position && (st.positions || []).indexOf(a.position) === -1) {
        penalty[0]++;
        warn('error', 'position', a, [a.staffId], prefix + st.name + 'さんは' + a.position + 'の担当外');
      }
      (byDate[a.date] = byDate[a.date] || []).push({ staffId: a.staffId, slotId: a.slotId, startMin: cell.startMin, endMin: cell.endMin, a: a });
    });

    // --- 同じ人の時間重複(手直しでも作れないが、念のため絶対条件として数える)---
    Object.keys(byDate).forEach(function (date) {
      const list = byDate[date];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].staffId === list[j].staffId && rangesOverlap(list[i], list[j])) {
            penalty[0]++;
            warn('error', 'overlap', list[j].a, [list[i].staffId],
              formatMD(date) + ' ' + slotLabel(list[i].slotId) + '/' + slotLabel(list[j].slotId) + ': ' +
              staffName(problem, list[i].staffId) + 'さんが同じ時間に2つの枠に入っています');
          }
        }
      }
    });

    // --- 不足 ---
    problem.cells.forEach(function (cell) {
      const short = cell.required - (countByCell[cell.key] || 0);
      if (short > 0) {
        penalty[1] += short;
        warnings.push({ level: 'warn', code: 'shortage', date: cell.date, slotId: cell.slotId, position: cell.position,
          staffIds: [], message: formatMD(cell.date) + ' ' + cell.slotName + ': ' + (cell.position || 'スタッフ') + 'が' + short + '人不足' });
      }
    });

    // --- 一緒にしない ---
    (settings.pairRules || []).forEach(function (rule) {
      if (rule.type !== 'avoid' || !problem.staffById[rule.a] || !problem.staffById[rule.b]) return;
      Object.keys(byDate).forEach(function (date) {
        const list = byDate[date];
        const as = list.filter(function (x) { return x.staffId === rule.a; });
        const bs = list.filter(function (x) { return x.staffId === rule.b; });
        for (let i = 0; i < as.length; i++) {
          for (let j = 0; j < bs.length; j++) {
            if (!rangesOverlap(as[i], bs[j])) continue;
            penalty[2]++;
            const label = as[i].slotId === bs[j].slotId
              ? slotLabel(as[i].slotId)
              : slotLabel(as[i].slotId) + '/' + slotLabel(bs[j].slotId);
            warnings.push({ level: 'warn', code: 'avoid', date: date, slotId: as[i].slotId, position: null,
              staffIds: [rule.a, rule.b],
              message: formatMD(date) + ' ' + label + ': ' + staffName(problem, rule.a) + 'さんと' +
                staffName(problem, rule.b) + 'さんが同じ時間(できれば避けたい組み合わせ)' });
            return; // 1日1組1件
          }
        }
      });
    });

    // --- ベテラン ---
    const minVet = parseInt(settings.minVeteranPerSlot, 10) || 0;
    if (minVet > 0) {
      const people = {};
      valid.forEach(function (a) {
        const k = a.date + '|' + a.slotId;
        (people[k] = people[k] || {})[a.staffId] = true;
      });
      Object.keys(people).forEach(function (k) {
        const ids = Object.keys(people[k]);
        const vets = ids.filter(function (id) { return problem.staffById[id].veteran; }).length;
        if (vets < minVet) {
          const parts = k.split('|');
          penalty[4] += minVet - vets;
          warnings.push({ level: 'warn', code: 'veteran', date: parts[0], slotId: parts[1], position: null, staffIds: [],
            message: formatMD(parts[0]) + ' ' + slotLabel(parts[1]) + ': ベテランが' + (minVet - vets) + '人不足' });
        }
      });
    }

    // --- 週の上限(期間外の割り当ても含めて数える)---
    const weekly = {}; // staffId|monday -> { dates: {}, hours }
    function addWeekly(a) {
      const slot = problem.slotById[a.slotId];
      const r = slotRange(slot);
      const k = a.staffId + '|' + mondayOf(a.date);
      const w = weekly[k] = weekly[k] || { dates: {}, hours: 0 };
      w.dates[a.date] = true;
      w.hours += (r.endMin - r.startMin) / 60;
    }
    valid.forEach(addWeekly);
    problem.outsideAssignments.forEach(function (a) {
      if (a.kind === 'exclude' || !problem.staffById[a.staffId] || !problem.slotById[a.slotId]) return;
      addWeekly(a);
    });
    const overDays = {}, overHours = {};
    Object.keys(weekly).sort().forEach(function (k) {
      const parts = k.split('|');
      const st = problem.staffById[parts[0]];
      const w = weekly[k];
      const days = Object.keys(w.dates).length;
      const head = st.name + 'さん: ' + formatMD(parts[1]) + '〜の週の';
      if (st.maxDays && days > Number(st.maxDays)) {
        penalty[0]++;
        overDays[st.id] = true;
        warnings.push({ level: 'error', code: 'max_days', date: null, slotId: null, position: null, staffIds: [st.id],
          message: head + '出勤が' + days + '日(上限' + st.maxDays + '日)' });
      }
      if (st.maxHours && w.hours > Number(st.maxHours)) {
        penalty[0]++;
        overHours[st.id] = true;
        warnings.push({ level: 'error', code: 'max_hours', date: null, slotId: null, position: null, staffIds: [st.id],
          message: head + '勤務が' + roundHours(w.hours) + '時間(上限' + st.maxHours + '時間)' });
      }
    });

    // --- 集計と公平さ ---
    const daysOf = {}, hoursOf = {};
    valid.forEach(function (a) {
      (daysOf[a.staffId] = daysOf[a.staffId] || {})[a.date] = true;
      const cell = problem.cellByKey[cellKeyOf(a)];
      hoursOf[a.staffId] = (hoursOf[a.staffId] || 0) + (cell.endMin - cell.startMin) / 60;
    });
    const summary = problem.activeStaff.map(function (st) {
      const days = Object.keys(daysOf[st.id] || {}).length;
      const expected = problem.expectedDays[st.id] || 0;
      penalty[5] += (days - expected) * (days - expected);
      return { staffId: st.id, name: st.name, days: days, hours: roundHours(hoursOf[st.id] || 0),
        expectedDays: Math.round(expected * 10) / 10, overMaxDays: !!overDays[st.id], overMaxHours: !!overHours[st.id] };
    });

    warnings.sort(function (x, y) { return (x.level === y.level) ? 0 : (x.level === 'error' ? -1 : 1); });
    return { warnings: warnings, penalty: penalty, summary: summary };
  }

  function comparePenalty(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i] - 1e-9) return -1;
      if (a[i] > b[i] + 1e-9) return 1;
    }
    return 0;
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
    buildProblem: buildProblem,
    availability: availability,
    cellKeyOf: cellKeyOf,
    rangesOverlap: rangesOverlap,
    evaluate: evaluate,
    comparePenalty: comparePenalty,
  };
}
