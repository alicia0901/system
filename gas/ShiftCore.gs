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
    // 目安なしの人は残りを等分する。ただし期間の日数と週の上限日数を超えない
    const share = untargeted.length ? Math.max(0, totalDemand - targetedSum) / untargeted.length : 0;
    untargeted.forEach(function (id) {
      const st = staffById[id];
      let cap = dates.length;
      if (st.maxDays !== null && st.maxDays !== undefined && st.maxDays !== '') {
        cap = Math.min(cap, Number(st.maxDays) * dates.length / 7);
      }
      expectedDays[id] = Math.min(share, cap);
    });

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

  // ==================== 自動作成 ====================

  /** 再現できる小さな擬似乱数(mulberry32) */
  function makeRng(seed) {
    let t = (seed >>> 0) || 1;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * シフト案を自動で作る。
   * - current のうち pinned のもの(割り当て・除外)はそのまま残し、pinned でないものは捨てる
   * - 自分で作る割り当ては絶対条件(出られない・担当外・同じ人の時間重複・週の上限・除外)を破らない
   * @param {Object} problem buildProblem の結果
   * @param {Array} current 画面上の今の割り当て
   * @param {{timeLimitMs?: number, seed?: number, now?: function(): number}} [options]
   * @return {Array} 割り当て一覧
   */
  function solve(problem, current, options) {
    options = options || {};
    const now = options.now || Date.now;
    const startedAt = now();
    const timeLimitMs = options.timeLimitMs === undefined ? 20000 : options.timeLimitMs;
    const rng = makeRng(options.seed === undefined ? startedAt : options.seed);
    const STALL_LIMIT = 5000; // これだけ続けて改善しなければ打ち切る

    const pinned = (current || []).filter(function (a) { return a.pinned; });
    const excluded = {};
    pinned.forEach(function (a) { if (a.kind === 'exclude') excluded[a.date + '|' + a.slotId + '|' + a.staffId] = true; });
    const pinnedAssigns = validAssigns(problem, pinned);

    // --- 絶対条件の判定に使う索引 ---
    const busy = {};   // staffId|date -> [{startMin, endMin}]
    const weeks = {};  // staffId|monday -> { dates: {date: count}, hours }
    function rangeOfAssign(a) {
      const cell = problem.cellByKey[cellKeyOf(a)];
      return cell ? { startMin: cell.startMin, endMin: cell.endMin } : slotRange(problem.slotById[a.slotId]);
    }
    function track(staffId, date, range, sign) {
      const bk = staffId + '|' + date;
      if (sign > 0) {
        (busy[bk] = busy[bk] || []).push(range);
      } else {
        const list = busy[bk];
        for (let i = 0; i < list.length; i++) {
          if (list[i].startMin === range.startMin && list[i].endMin === range.endMin) { list.splice(i, 1); break; }
        }
      }
      const wk = staffId + '|' + mondayOf(date);
      const w = weeks[wk] = weeks[wk] || { dates: {}, hours: 0 };
      w.dates[date] = (w.dates[date] || 0) + sign;
      if (w.dates[date] <= 0) delete w.dates[date];
      w.hours += sign * (range.endMin - range.startMin) / 60;
    }
    pinnedAssigns.forEach(function (a) { track(a.staffId, a.date, rangeOfAssign(a), 1); });
    problem.outsideAssignments.forEach(function (a) {
      if (a.kind === 'exclude' || !problem.staffById[a.staffId] || !problem.slotById[a.slotId]) return;
      track(a.staffId, a.date, slotRange(problem.slotById[a.slotId]), 1);
    });

    function staticOk(st, cell) {
      if (cell.position && (st.positions || []).indexOf(cell.position) === -1) return false;
      if (excluded[cell.date + '|' + cell.slotId + '|' + st.id]) return false;
      return availability(problem, st.id, cell.date, cell.slotId) !== 'unavailable';
    }
    function feasible(st, cell) {
      const list = busy[st.id + '|' + cell.date] || [];
      for (let i = 0; i < list.length; i++) if (rangesOverlap(list[i], cell)) return false;
      const w = weeks[st.id + '|' + mondayOf(cell.date)];
      const days = w ? Object.keys(w.dates).length + (w.dates[cell.date] ? 0 : 1) : 1;
      if (st.maxDays && days > Number(st.maxDays)) return false;
      const hours = (w ? w.hours : 0) + (cell.endMin - cell.startMin) / 60;
      if (st.maxHours && hours > Number(st.maxHours) + 1e-9) return false;
      return true;
    }

    // --- 埋める席 ---
    const pinnedCount = {};
    pinnedAssigns.forEach(function (a) { const k = cellKeyOf(a); pinnedCount[k] = (pinnedCount[k] || 0) + 1; });
    const seats = [];
    problem.cells.forEach(function (cell, idx) {
      const cands = problem.activeStaff.filter(function (st) { return staticOk(st, cell); });
      for (let n = cell.required - (pinnedCount[cell.key] || 0); n > 0; n--) {
        seats.push({ cell: cell, cellIdx: idx, cands: cands, staff: null });
      }
    });

    // 貪欲法の簡易採点用: 期間内の出勤日・枠ごとのベテラン人数
    const daysIn = {};    // staffId -> {date: count}
    const vetCount = {};  // date|slotId -> count
    function tally(staffId, date, slotId, sign) {
      const d = daysIn[staffId] = daysIn[staffId] || {};
      d[date] = (d[date] || 0) + sign;
      if (d[date] <= 0) delete d[date];
      const st = problem.staffById[staffId];
      if (st && st.veteran) vetCount[date + '|' + slotId] = (vetCount[date + '|' + slotId] || 0) + sign;
    }
    pinnedAssigns.forEach(function (a) { tally(a.staffId, a.date, a.slotId, 1); });

    function place(seat, st) { seat.staff = st; track(st.id, seat.cell.date, seat.cell, 1); tally(st.id, seat.cell.date, seat.cell.slotId, 1); }
    function unplace(seat) {
      const st = seat.staff;
      track(st.id, seat.cell.date, seat.cell, -1);
      tally(st.id, seat.cell.date, seat.cell.slotId, -1);
      seat.staff = null;
      return st;
    }
    function inSameCell(seat, st) {
      for (let i = 0; i < seats.length; i++) {
        if (seats[i] !== seat && seats[i].cell === seat.cell && seats[i].staff === st) return true;
      }
      return false;
    }
    function feasibleCands(seat) {
      return seat.cands.filter(function (st) { return feasible(st, seat.cell) && !inSameCell(seat, st); });
    }
    function currentAssignments() {
      const out = pinned.slice();
      seats.forEach(function (seat) {
        if (!seat.staff) return;
        out.push({ date: seat.cell.date, slotId: seat.cell.slotId, position: seat.cell.position,
          staffId: seat.staff.id, kind: 'assign', pinned: false });
      });
      return out;
    }
    function score() { return evaluate(problem, currentAssignments()).penalty; }

    /**
     * 貪欲法で「この人をこの席に入れたら罰点がどれだけ増えるか」を、関係する項目だけで素早く見積もる
     * (全体の evaluate は重く、大きな店だと貪欲法だけで時間制限を超えるため)。
     * 順番は evaluate の罰点と同じ [hard, shortage, avoid, preferOff, veteran, fairness, -want]。
     */
    const minVet = parseInt(problem.settings.minVeteranPerSlot, 10) || 0;
    const partners = {};
    (problem.settings.pairRules || []).forEach(function (r) {
      if (r.type !== 'avoid') return;
      (partners[r.a] = partners[r.a] || []).push(r.b);
      (partners[r.b] = partners[r.b] || []).push(r.a);
    });
    function greedyCost(st, cell) {
      let avoid = 0;
      (partners[st.id] || []).forEach(function (pid) {
        (busy[pid + '|' + cell.date] || []).forEach(function (r) { if (rangesOverlap(r, cell)) avoid = 1; });
      });
      const av = availability(problem, st.id, cell.date, cell.slotId);
      const vet = (minVet > 0 && st.veteran && (vetCount[cell.date + '|' + cell.slotId] || 0) < minVet) ? -1 : 0;
      const days = Object.keys(daysIn[st.id] || {}).length;
      const expected = problem.expectedDays[st.id] || 0;
      const newDay = !(daysIn[st.id] && daysIn[st.id][cell.date]);
      const fair = newDay ? (days + 1 - expected) * (days + 1 - expected) - (days - expected) * (days - expected) : 0;
      // 週の上限日数がある人は、出勤日を散らすと週の後半に人が足りなくなりやすいので、
      // できれば同じ日の別の枠にまとめる(公平さより優先。罰点の配列に1項目足した貪欲法専用の採点)
      const scarce = (newDay && st.maxDays) ? 1 : 0;
      return [0, 0, avoid, av === 'prefer_off' ? 1 : 0, scarce, vet, fair, av === 'want' ? -1 : 0];
    }

    // --- 1. 貪欲法: 候補の少ない席から、罰点の増え方が一番小さい人を入れる ---
    const order = seats.slice().sort(function (x, y) {
      return (x.cands.length - y.cands.length) || (y.cell.required - x.cell.required) || (x.cellIdx - y.cellIdx);
    });
    order.forEach(function (seat) {
      let best = null, bestCost = null;
      feasibleCands(seat).forEach(function (st) {
        const cost = greedyCost(st, seat.cell);
        if (!best || comparePenalty(cost, bestCost) < 0) { best = st; bestCost = cost; }
      });
      if (best) place(seat, best);
    });

    // --- 2. 局所探索: 入れ替え・交換・空席埋めを試し、悪くならなければ採用 ---
    let cur = score();
    let stall = 0;
    function pick(list) { return list[Math.floor(rng() * list.length)]; }
    while (seats.length && now() - startedAt < timeLimitMs && stall < STALL_LIMIT) {
      const r = rng();
      const seatA = pick(seats);
      let undo = null;
      if (!seatA.staff) {
        const cands = feasibleCands(seatA);
        if (cands.length) {
          place(seatA, pick(cands));
          undo = function () { unplace(seatA); };
        } else {
          // 入れられる人がいない空席: 別の席の人をここへ移す(移した先の席はあとで別の人が埋められるかもしれない)
          const from = pick(seats);
          if (from !== seatA && from.staff && from.cell !== seatA.cell) {
            const mover = unplace(from);
            if (seatA.cands.indexOf(mover) !== -1 && feasible(mover, seatA.cell) && !inSameCell(seatA, mover)) {
              place(seatA, mover);
              undo = function () { unplace(seatA); place(from, mover); };
            } else {
              place(from, mover);
            }
          }
        }
      } else if (r < 0.5) {
        const old = unplace(seatA);
        const cands = feasibleCands(seatA).filter(function (st) { return st !== old; });
        if (cands.length) {
          place(seatA, pick(cands));
          undo = function () { unplace(seatA); place(seatA, old); };
        } else {
          place(seatA, old);
        }
      } else {
        const seatB = pick(seats);
        if (seatB !== seatA && seatB.staff && seatB.staff !== seatA.staff && seatB.cell !== seatA.cell) {
          const a = unplace(seatA), b = unplace(seatB);
          let ok = seatA.cands.indexOf(b) !== -1 && seatB.cands.indexOf(a) !== -1 &&
            feasible(b, seatA.cell) && !inSameCell(seatA, b);
          if (ok) { place(seatA, b); ok = feasible(a, seatB.cell) && !inSameCell(seatB, a); if (!ok) unplace(seatA); }
          if (ok) {
            place(seatB, a);
            undo = function () { unplace(seatA); unplace(seatB); place(seatA, a); place(seatB, b); };
          } else {
            place(seatA, a); place(seatB, b);
          }
        }
      }
      if (!undo) { stall++; continue; }
      const next = score();
      const cmp = comparePenalty(next, cur);
      if (cmp <= 0) {
        stall = cmp < 0 ? 0 : stall + 1;
        cur = next;
      } else {
        undo();
        stall++;
      }
    }

    return currentAssignments();
  }

  // ==================== 入力の検証 ====================
  // すべて { ok: true, value } か { ok: false, message } を返す。

  const TIME_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const REQUEST_KINDS = ['unavailable', 'prefer_off', 'want'];
  const RECURRING_KINDS = ['unavailable', 'prefer_off'];

  function fail(message) { return { ok: false, message: message }; }

  function cleanWeekdays(list) {
    const seen = {};
    return (Array.isArray(list) ? list : []).map(function (x) { return parseInt(x, 10); })
      .filter(function (x) { if (!(x >= 0 && x <= 6) || seen[x]) return false; seen[x] = true; return true; })
      .sort(function (a, b) { return a - b; });
  }

  function optionalNumber(v, max, message) {
    if (v === null || v === undefined || String(v).trim() === '') return { ok: true, value: null };
    const n = Number(v);
    if (!isFinite(n) || n < 0 || (max !== null && n > max)) return fail(message);
    return { ok: true, value: n };
  }

  function validateSettings(raw) {
    raw = raw || {};
    const positions = [];
    const posList = Array.isArray(raw.positions) ? raw.positions : [];
    for (let i = 0; i < posList.length; i++) {
      const name = String(posList[i] || '').trim();
      if (!name) return fail((i + 1) + '件目の担当名を入力してください。');
      if (positions.indexOf(name) !== -1) return fail('担当名「' + name + '」が重複しています。');
      positions.push(name);
    }
    const posKeys = positions.length ? positions : [''];

    const slotsIn = Array.isArray(raw.slots) ? raw.slots : [];
    if (!slotsIn.length) return fail('シフト枠を1つ以上設定してください。');
    const slots = [];
    const seenIds = {}, seenNames = {};
    for (let i = 0; i < slotsIn.length; i++) {
      const sl = slotsIn[i] || {};
      const name = String(sl.name || '').trim();
      if (!name) return fail((i + 1) + '件目の枠名を入力してください。');
      if (seenNames[name]) return fail('枠名「' + name + '」が重複しています。');
      seenNames[name] = true;
      const start = String(sl.start || '').trim(), end = String(sl.end || '').trim();
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) return fail('「' + name + '」の時間は HH:MM の形式で入力してください。');
      if (start === end) return fail('「' + name + '」の開始と終了が同じです。');
      const id = String(sl.id || '').trim();
      if (!id || seenIds[id]) return fail('「' + name + '」の内部IDが正しくありません。');
      seenIds[id] = true;
      const required = {};
      let total = 0;
      for (let j = 0; j < posKeys.length; j++) {
        const n = parseInt((sl.required || {})[posKeys[j]], 10) || 0;
        if (n < 0) return fail('「' + name + '」の必要人数は0人以上にしてください。');
        required[posKeys[j]] = n;
        total += n;
      }
      if (total < 1) return fail('「' + name + '」の必要人数を1人以上にしてください。');
      slots.push({ id: id, name: name, start: start, end: end, weekdays: cleanWeekdays(sl.weekdays), required: required });
    }

    const pairRules = [];
    const seenPairs = {};
    const pairsIn = Array.isArray(raw.pairRules) ? raw.pairRules : [];
    for (let i = 0; i < pairsIn.length; i++) {
      const pr = pairsIn[i] || {};
      const a = String(pr.a || ''), b = String(pr.b || '');
      if (!a || !b) return fail((i + 1) + '件目の組み合わせのスタッフを2人選んでください。');
      if (a === b) return fail('同じスタッフ同士の組み合わせは設定できません。');
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seenPairs[key]) continue;
      seenPairs[key] = true;
      pairRules.push({ a: a, b: b, type: 'avoid' });
    }

    const minVet = parseInt(raw.minVeteranPerSlot, 10) || 0;
    if (minVet < 0) return fail('ベテランの人数は0人以上にしてください。');
    return { ok: true, value: { positions: positions, slots: slots, pairRules: pairRules, minVeteranPerSlot: minVet } };
  }

  function validateStaff(raw, settings) {
    raw = raw || {};
    const name = String(raw.name || '').trim();
    if (!name) return fail('スタッフの名前を入力してください。');
    const allowed = (settings && settings.positions) || [];
    const positions = (Array.isArray(raw.positions) ? raw.positions : [])
      .map(function (x) { return String(x); })
      .filter(function (x, i, arr) { return allowed.indexOf(x) !== -1 && arr.indexOf(x) === i; });
    const target = optionalNumber(raw.targetDays, 7, '週の目安日数は0〜7の数字で入力してください。');
    if (!target.ok) return target;
    const maxDays = optionalNumber(raw.maxDays, 7, '週の上限日数は0〜7の数字で入力してください。');
    if (!maxDays.ok) return maxDays;
    const maxHours = optionalNumber(raw.maxHours, null, '週の上限時間は0以上の数字で入力してください。');
    if (!maxHours.ok) return maxHours;
    return { ok: true, value: {
      id: String(raw.id || ''), name: name, positions: positions, veteran: !!raw.veteran,
      targetDays: target.value, maxDays: maxDays.value, maxHours: maxHours.value,
      active: raw.active === undefined ? true : !!raw.active, note: String(raw.note || ''),
    } };
  }

  function validateRequests(list, from, to, settings, staffIds) {
    const slotIds = {};
    ((settings && settings.slots) || []).forEach(function (sl) { slotIds[sl.id] = true; });
    const byKey = {};
    const order = [];
    const items = Array.isArray(list) ? list : [];
    for (let i = 0; i < items.length; i++) {
      const r = items[i] || {};
      const date = String(r.date || '');
      if (!DATE_RE.test(date) || date < from || date > to) return fail('希望の日付が対象期間の外です。');
      if (staffIds.indexOf(r.staffId) === -1) return fail('希望のスタッフが見つかりません。');
      const slotId = String(r.slotId || '');
      if (slotId && !slotIds[slotId]) return fail('希望の枠が見つかりません。');
      if (REQUEST_KINDS.indexOf(r.kind) === -1) return fail('希望の種類が正しくありません。');
      const key = r.staffId + '|' + date + '|' + slotId;
      if (!byKey[key]) order.push(key);
      byKey[key] = { date: date, staffId: r.staffId, slotId: slotId, kind: r.kind, note: String(r.note || '') };
    }
    return { ok: true, value: order.map(function (k) { return byKey[k]; }) };
  }

  function validateRecurring(list, settings) {
    const slotIds = {};
    ((settings && settings.slots) || []).forEach(function (sl) { slotIds[sl.id] = true; });
    const out = [];
    const items = Array.isArray(list) ? list : [];
    for (let i = 0; i < items.length; i++) {
      const r = items[i] || {};
      const weekdays = cleanWeekdays(r.weekdays);
      if (!weekdays.length) return fail('いつもの条件の曜日を1つ以上選んでください。');
      const slotId = String(r.slotId || '');
      if (slotId && !slotIds[slotId]) return fail('いつもの条件の枠が見つかりません。');
      if (RECURRING_KINDS.indexOf(r.kind) === -1) return fail('いつもの条件の種類が正しくありません。');
      out.push({ staffId: String(r.staffId || ''), weekdays: weekdays, slotId: slotId, kind: r.kind, note: String(r.note || '') });
    }
    return { ok: true, value: out };
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
    solve: solve,
    validateSettings: validateSettings,
    validateStaff: validateStaff,
    validateRequests: validateRequests,
    validateRecurring: validateRecurring,
  };
}
