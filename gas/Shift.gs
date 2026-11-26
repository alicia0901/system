/**
 * シフト表(?page=shift)のサーバ側 API と保存処理
 * ------------------------------------------------
 * - 自動作成・評価・入力検証のロジックは ShiftCore.gs の shiftCoreFactory() にある(画面と共通)
 * - 枠・担当・組み合わせ条件の設定は PropertiesService(キー SHIFT_SETTINGS)に保存
 * - スタッフ・希望・定期条件・割り当て・日別枠は、予約と同じスプレッドシートの専用シートに保存
 * - GAS はファイルの読み込み順が保証されないため、トップレベルでは関数呼び出しをしない
 *   (shiftCoreFactory() は各関数の中で呼ぶ)
 */

const SHIFT_SETTINGS_KEY = 'SHIFT_SETTINGS';
const SHIFT_MAX_PERIOD_DAYS = 31;
const SHIFT_GENERATE_TIME_LIMIT_MS = 20000;

// シート定義。textCols は日付やIDなど、文字列のまま保存したい列(1始まり)
const SHIFT_SHEETS = {
  STAFF: {
    name: 'シフト_スタッフ',
    headers: ['スタッフID', '名前', 'できる担当', 'ベテラン', '週の目安日数', '週の上限日数', '週の上限時間', '在籍', 'メモ'],
    textCols: [1, 2, 3, 9],
  },
  REQUESTS: {
    name: 'シフト_希望',
    headers: ['日付', 'スタッフID', '枠ID', '種類', 'メモ'],
    textCols: [1, 2, 3, 4, 5],
  },
  RECURRING: {
    name: 'シフト_定期条件',
    headers: ['スタッフID', '曜日', '枠ID', '種類', 'メモ'],
    textCols: [1, 2, 3, 4, 5],
  },
  ASSIGNMENTS: {
    name: 'シフト_割り当て',
    headers: ['日付', '枠ID', '担当', 'スタッフID', '種類', '固定', '更新日時'],
    textCols: [1, 2, 3, 4, 5],
  },
  DAY_SLOTS: {
    name: 'シフト_日別枠',
    headers: ['日付', '枠ID', '状態'],
    textCols: [1, 2, 3],
  },
};

const SHIFT_KIND_LABELS = { unavailable: '出られない', prefer_off: 'できれば休み', want: '出たい' };
const SHIFT_ASSIGN_KIND_LABELS = { assign: '割り当て', exclude: '除外' };
const SHIFT_DAY_STATE_LABELS = { off: 'なし', on: 'あり' };

const SHIFT_AUTH_ERROR = { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };

// ==================== 画面から呼ばれる API ====================

/**
 * シフト画面の初期データ(期間ごと)。要ログイン。
 */
function getShiftBootstrap(token, from, to) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  const periodError = shiftValidatePeriod(from, to);
  if (periodError) return { success: false, message: periodError };
  const data = shiftLoadData(from, to);
  data.success = true;
  data.storeName = CONFIG.STORE_NAME;
  return data;
}

/**
 * 枠・担当・組み合わせ条件の設定を保存する。要ログイン。
 */
function saveShiftSettings(token, settings) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  const input = JSON.parse(JSON.stringify(settings || {}));
  (input.slots || []).forEach(function (sl) {
    if (sl && !sl.id) sl.id = 'sl_' + Utilities.getUuid().slice(0, 8);
  });
  const result = shiftCoreFactory().validateSettings(input);
  if (!result.ok) return { success: false, message: result.message };
  PropertiesService.getScriptProperties().setProperty(SHIFT_SETTINGS_KEY, JSON.stringify(result.value));
  return { success: true, settings: result.value };
}

/**
 * スタッフを追加・更新する(id が空なら追加)。要ログイン。
 */
function saveStaffMember(token, staff) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  const result = shiftCoreFactory().validateStaff(staff, shiftGetSettings());
  if (!result.ok) return { success: false, message: result.message };
  const value = result.value;
  if (!value.id) value.id = 'st_' + Utilities.getUuid().slice(0, 8);

  return shiftWithLock(function () {
    const list = shiftReadStaff();
    const idx = list.findIndex(function (s) { return s.id === value.id; });
    if (idx === -1) list.push(value); else list[idx] = value;
    shiftWriteAll(SHIFT_SHEETS.STAFF, list.map(shiftStaffToRow));
    return { success: true, staff: value };
  });
}

/**
 * スタッフの在籍を外す・戻す(削除はしない。過去のシフトに名前を残すため)。要ログイン。
 */
function setStaffActive(token, staffId, active) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  return shiftWithLock(function () {
    const list = shiftReadStaff();
    const st = list.filter(function (s) { return s.id === staffId; })[0];
    if (!st) return { success: false, message: 'スタッフが見つかりません。' };
    st.active = !!active;
    shiftWriteAll(SHIFT_SHEETS.STAFF, list.map(shiftStaffToRow));
    return { success: true };
  });
}

/**
 * そのスタッフの毎週の条件(定期条件)を丸ごと置き換える。要ログイン。
 */
function saveRecurringRules(token, staffId, rules) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  const withStaff = (rules || []).map(function (r) { return Object.assign({}, r, { staffId: staffId }); });
  const result = shiftCoreFactory().validateRecurring(withStaff, shiftGetSettings());
  if (!result.ok) return { success: false, message: result.message };

  return shiftWithLock(function () {
    if (!shiftReadStaff().some(function (s) { return s.id === staffId; })) {
      return { success: false, message: 'スタッフが見つかりません。' };
    }
    const kept = shiftReadRecurring().filter(function (r) { return r.staffId !== staffId; });
    shiftWriteAll(SHIFT_SHEETS.RECURRING, kept.concat(result.value).map(shiftRecurringToRow));
    return { success: true, recurring: result.value };
  });
}

/**
 * 期間内の希望(全スタッフ分)を丸ごと置き換える。要ログイン。
 */
function saveRequests(token, from, to, requests) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  const periodError = shiftValidatePeriod(from, to);
  if (periodError) return { success: false, message: periodError };
  const staffIds = shiftReadStaff().map(function (s) { return s.id; });
  const result = shiftCoreFactory().validateRequests(requests, from, to, shiftGetSettings(), staffIds);
  if (!result.ok) return { success: false, message: result.message };

  return shiftWithLock(function () {
    const kept = shiftReadRequests().filter(function (r) { return r.date < from || r.date > to; });
    shiftWriteAll(SHIFT_SHEETS.REQUESTS, kept.concat(result.value).map(shiftRequestToRow));
    return { success: true };
  });
}

/**
 * シフト案を自動で作る(保存はしない)。要ログイン。
 * currentAssignments のうち固定(pinned)のものはそのまま残す。
 * dayOverrides を渡すと、保存済みの日別枠の代わりにそれを使う(画面で変えたまま未保存の日別枠)。
 */
function generateShift(token, from, to, currentAssignments, dayOverrides) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  const periodError = shiftValidatePeriod(from, to);
  if (periodError) return { success: false, message: periodError };
  const core = shiftCoreFactory();
  const data = shiftLoadData(from, to);
  if (Array.isArray(dayOverrides)) {
    const cleaned = shiftCleanDayOverrides(dayOverrides, from, to);
    if (!cleaned) return { success: false, message: '日別の枠の内容が正しくありません。' };
    data.dayOverrides = cleaned;
  }
  const problem = core.buildProblem({
    from: from, to: to, settings: data.settings, staff: data.staff, requests: data.requests,
    recurring: data.recurring, business: data.business, dayOverrides: data.dayOverrides,
    outsideAssignments: data.outsideAssignments,
  });
  const assignments = core.solve(problem, currentAssignments || [], { timeLimitMs: SHIFT_GENERATE_TIME_LIMIT_MS });
  const result = core.evaluate(problem, assignments);
  return { success: true, assignments: assignments, warnings: result.warnings, summary: result.summary, penalty: result.penalty };
}

/**
 * 期間内の割り当てと日別枠を丸ごと置き換えて保存する。要ログイン。
 */
function saveShiftPeriod(token, from, to, assignments, dayOverrides) {
  if (!isValidAdminToken(token)) return SHIFT_AUTH_ERROR;
  const periodError = shiftValidatePeriod(from, to);
  if (periodError) return { success: false, message: periodError };

  const cleanAssigns = [];
  const assignsIn = assignments || [];
  for (let i = 0; i < assignsIn.length; i++) {
    const a = assignsIn[i] || {};
    if (!shiftInPeriod(a.date, from, to) || !a.slotId || !a.staffId || !SHIFT_ASSIGN_KIND_LABELS[a.kind]) {
      return { success: false, message: '割り当ての内容が正しくありません。' };
    }
    cleanAssigns.push({ date: a.date, slotId: String(a.slotId), position: String(a.position || ''),
      staffId: String(a.staffId), kind: a.kind, pinned: !!a.pinned });
  }
  const cleanOverrides = shiftCleanDayOverrides(dayOverrides || [], from, to);
  if (!cleanOverrides) return { success: false, message: '日別の枠の内容が正しくありません。' };

  return shiftWithLock(function () {
    const now = new Date();
    const keptAssigns = shiftReadAssignments().filter(function (a) { return !shiftInPeriod(a.date, from, to); });
    shiftWriteAll(SHIFT_SHEETS.ASSIGNMENTS, keptAssigns.concat(cleanAssigns).map(function (a) {
      return shiftAssignmentToRow(a, a.updatedAt || now);
    }));
    const keptOverrides = shiftReadDayOverrides().filter(function (o) { return !shiftInPeriod(o.date, from, to); });
    shiftWriteAll(SHIFT_SHEETS.DAY_SLOTS, keptOverrides.concat(cleanOverrides).map(shiftDayOverrideToRow));
    return { success: true };
  });
}

/** 日別枠の入力を整える。不正な行があれば null */
function shiftCleanDayOverrides(list, from, to) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i] || {};
    if (!shiftInPeriod(o.date, from, to) || !o.slotId || !SHIFT_DAY_STATE_LABELS[o.state]) return null;
    out.push({ date: o.date, slotId: String(o.slotId), state: o.state });
  }
  return out;
}

// ==================== 読み込み ====================

function shiftGetSettings() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(SHIFT_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    Logger.log('シフト設定の読み込みエラー: ' + e.message);
  }
  return { positions: [], slots: [], pairRules: [], minVeteranPerSlot: 0 };
}

/**
 * 期間のデータをまとめて読む(bootstrap と generateShift で共通)。
 * outsideAssignments は、期間の端の週(月曜始まり)のうち期間外の日の保存済み割り当て(週の上限の計算用)。
 */
function shiftLoadData(from, to) {
  const core = shiftCoreFactory();
  const settings = shiftGetSettings();
  const slotIds = {};
  (settings.slots || []).forEach(function (sl) { slotIds[sl.id] = true; });

  const dates = core.listDates(from, to);
  const specialDates = {};
  getBusinessSettings().specialDays.forEach(function (d) { specialDates[d.date] = true; });
  const business = {};
  dates.forEach(function (date) {
    const b = getBusinessHoursForDate(date);
    business[date] = { closed: b.closed, note: b.note, periods: b.periods, special: !!specialDates[date] };
  });

  const weekStart = core.mondayOf(from);
  const weekEnd = core.addDays(core.mondayOf(to), 6);
  const allAssigns = shiftReadAssignments().filter(function (a) { return slotIds[a.slotId]; });
  const strip = function (a) {
    return { date: a.date, slotId: a.slotId, position: a.position, staffId: a.staffId, kind: a.kind, pinned: a.pinned };
  };

  return {
    settings: settings,
    staff: shiftReadStaff(),
    // 設定から消した枠を指す希望・定期条件は捨てる(画面で消せず、保存の検証で止まってしまうため)
    requests: shiftReadRequests().filter(function (r) {
      return shiftInPeriod(r.date, from, to) && (!r.slotId || slotIds[r.slotId]);
    }),
    recurring: shiftReadRecurring().filter(function (r) { return !r.slotId || slotIds[r.slotId]; }),
    business: business,
    dayOverrides: shiftReadDayOverrides().filter(function (o) { return shiftInPeriod(o.date, from, to) && slotIds[o.slotId]; }),
    assignments: allAssigns.filter(function (a) { return shiftInPeriod(a.date, from, to); }).map(strip),
    outsideAssignments: allAssigns.filter(function (a) {
      return !shiftInPeriod(a.date, from, to) && a.date >= weekStart && a.date <= weekEnd;
    }).map(strip),
  };
}

function shiftReadStaff() {
  return shiftReadRows(SHIFT_SHEETS.STAFF).map(function (r) {
    return {
      id: shiftCellText(r[0]), name: shiftCellText(r[1]),
      positions: shiftCellText(r[2]) ? shiftCellText(r[2]).split(',') : [],
      veteran: shiftCellBool(r[3]),
      targetDays: shiftCellNumber(r[4]), maxDays: shiftCellNumber(r[5]), maxHours: shiftCellNumber(r[6]),
      active: shiftCellBool(r[7]), note: shiftCellText(r[8]),
    };
  }).filter(function (s) { return s.id; });
}

function shiftReadRequests() {
  return shiftReadRows(SHIFT_SHEETS.REQUESTS).map(function (r) {
    return { date: shiftCellDate(r[0]), staffId: shiftCellText(r[1]), slotId: shiftCellText(r[2]),
      kind: shiftLabelToKey(SHIFT_KIND_LABELS, r[3]), note: shiftCellText(r[4]) };
  }).filter(function (r) { return r.date && r.staffId && r.kind; });
}

function shiftReadRecurring() {
  return shiftReadRows(SHIFT_SHEETS.RECURRING).map(function (r) {
    return { staffId: shiftCellText(r[0]),
      weekdays: shiftCellText(r[1]).split(',').filter(function (x) { return x !== ''; }).map(Number),
      slotId: shiftCellText(r[2]), kind: shiftLabelToKey(SHIFT_KIND_LABELS, r[3]), note: shiftCellText(r[4]) };
  }).filter(function (r) { return r.staffId && r.kind && r.weekdays.length; });
}

function shiftReadAssignments() {
  return shiftReadRows(SHIFT_SHEETS.ASSIGNMENTS).map(function (r) {
    return { date: shiftCellDate(r[0]), slotId: shiftCellText(r[1]), position: shiftCellText(r[2]),
      staffId: shiftCellText(r[3]), kind: shiftLabelToKey(SHIFT_ASSIGN_KIND_LABELS, r[4]),
      pinned: shiftCellBool(r[5]), updatedAt: r[6] || '' };
  }).filter(function (a) { return a.date && a.slotId && a.staffId && a.kind; });
}

function shiftReadDayOverrides() {
  return shiftReadRows(SHIFT_SHEETS.DAY_SLOTS).map(function (r) {
    return { date: shiftCellDate(r[0]), slotId: shiftCellText(r[1]), state: shiftLabelToKey(SHIFT_DAY_STATE_LABELS, r[2]) };
  }).filter(function (o) { return o.date && o.slotId && o.state; });
}

// ==================== 行への変換 ====================

function shiftStaffToRow(s) {
  return [s.id, s.name, (s.positions || []).join(','), !!s.veteran,
    shiftNumberCell(s.targetDays), shiftNumberCell(s.maxDays), shiftNumberCell(s.maxHours), !!s.active, s.note || ''];
}
function shiftRequestToRow(r) { return [r.date, r.staffId, r.slotId || '', SHIFT_KIND_LABELS[r.kind], r.note || '']; }
function shiftRecurringToRow(r) { return [r.staffId, r.weekdays.join(','), r.slotId || '', SHIFT_KIND_LABELS[r.kind], r.note || '']; }
function shiftAssignmentToRow(a, updatedAt) {
  return [a.date, a.slotId, a.position || '', a.staffId, SHIFT_ASSIGN_KIND_LABELS[a.kind], !!a.pinned, updatedAt];
}
function shiftDayOverrideToRow(o) { return [o.date, o.slotId, SHIFT_DAY_STATE_LABELS[o.state]]; }

// ==================== シート・セルのユーティリティ ====================

function shiftGetSheet(def) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    // 日付やIDが自動で日付・数値に変換されないよう、文字列の列は書式を「書式なしテキスト」にする
    def.textCols.forEach(function (col) { sheet.getRange(1, col, 2000, 1).setNumberFormat('@'); });
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** ヘッダーを除いた行を返す(空行は除く) */
function shiftReadRows(def) {
  const values = shiftGetSheet(def).getDataRange().getValues();
  return values.slice(1).filter(function (r) {
    return r.some(function (v) { return v !== '' && v !== null && v !== undefined; });
  });
}

/** シートをヘッダー + rows で丸ごと書き直す(呼び出し元でロックを取ること) */
function shiftWriteAll(def, rows) {
  const sheet = shiftGetSheet(def);
  sheet.clearContents();
  const all = [def.headers].concat(rows);
  sheet.getRange(1, 1, all.length, def.headers.length).setValues(all);
}

function shiftWithLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** 日付セル: Date で返ってきても 'YYYY-MM-DD' にする */
function shiftCellDate(v) {
  if (v instanceof Date || (v && typeof v.getFullYear === 'function')) {
    return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return String(v === null || v === undefined ? '' : v).trim();
}
function shiftCellText(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function shiftCellBool(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function shiftCellNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function shiftNumberCell(n) { return n === null || n === undefined ? '' : n; }

function shiftLabelToKey(labels, v) {
  const text = shiftCellText(v);
  const keys = Object.keys(labels);
  for (let i = 0; i < keys.length; i++) if (labels[keys[i]] === text) return keys[i];
  return null;
}

function shiftInPeriod(date, from, to) { return typeof date === 'string' && date >= from && date <= to; }

/** 対象期間のチェック。問題があればエラーメッセージを返す */
function shiftValidatePeriod(from, to) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(from)) || !re.test(String(to))) return '対象期間の日付を正しく指定してください。';
  if (from > to) return '対象期間の終了日は開始日以降にしてください。';
  if (shiftCoreFactory().listDates(from, to).length > SHIFT_MAX_PERIOD_DAYS) {
    return '対象期間は' + SHIFT_MAX_PERIOD_DAYS + '日以内で指定してください。';
  }
  return null;
}
