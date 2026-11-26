'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { loadGas } = require('./helpers/load-gas');
const { createGasMock } = require('./helpers/gas-mock');

const plain = (v) => JSON.parse(JSON.stringify(v));
function setup(mockOptions) {
  const mock = createGasMock(mockOptions);
  const ctx = loadGas(['Code.gs', 'ShiftCore.gs', 'Shift.gs'], mock.globals);
  mock.loginToken('t');
  const call = (name, ...args) => plain(vm.runInContext(name, ctx)(...args));
  return { mock, call };
}
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
const SETTINGS = {
  positions: [],
  slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: ALL_WEEK, required: { '': 1 } },
    { id: 'D', name: 'ディナー', start: '17:00', end: '22:00', weekdays: ALL_WEEK, required: { '': 1 } }],
  pairRules: [],
  minVeteranPerSlot: 0,
};
const staffInput = (name, extra) => Object.assign(
  { id: '', name, positions: [], veteran: false, targetDays: null, maxDays: null, maxHours: null, active: true, note: '' }, extra || {});
const as = (date, slotId, staffId, extra) =>
  Object.assign({ date, slotId, position: '', staffId, kind: 'assign', pinned: true }, extra || {});

test('認証切れ', () => {
  const { call } = setup();
  assert.deepEqual(call('getShiftBootstrap', 'bad', '2026-12-01', '2026-12-07'),
    { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' });
  assert.equal(call('saveShiftPeriod', 'bad', '2026-12-01', '2026-12-07', [], []).authError, true);
});

test('期間が31日を超えるとエラー', () => {
  const { call } = setup();
  assert.deepEqual(call('getShiftBootstrap', 't', '2026-12-01', '2027-01-02'),
    { success: false, message: '対象期間は31日以内で指定してください。' });
  assert.equal(call('getShiftBootstrap', 't', '2026-12-07', '2026-12-01').success, false);
  assert.equal(call('getShiftBootstrap', 't', '2026-12-01', '2026-12-31').success, true);
});

test('スタッフ追加 → bootstrap に出る(IDが振られる、在籍外も含む)', () => {
  const { call } = setup();
  const r = call('saveStaffMember', 't', staffInput('田中', { targetDays: 3 }));
  assert.equal(r.success, true);
  assert.match(r.staff.id, /^st_/);
  call('saveStaffMember', 't', staffInput('佐藤'));
  const sato = call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07').staff.find((s) => s.name === '佐藤');
  assert.equal(call('setStaffActive', 't', sato.id, false).success, true);
  const b = call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07');
  assert.equal(b.staff.length, 2);
  assert.equal(b.staff.find((s) => s.name === '田中').targetDays, 3);
  assert.equal(b.staff.find((s) => s.name === '佐藤').active, false);
  // 既存スタッフの更新は行が増えない
  call('saveStaffMember', 't', Object.assign({}, r.staff, { name: '田中太郎' }));
  assert.equal(call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07').staff.length, 2);
});

test('スタッフ名が空ならエラー', () => {
  const { call } = setup();
  assert.deepEqual(call('saveStaffMember', 't', staffInput('  ')), { success: false, message: 'スタッフの名前を入力してください。' });
});

test('設定の検証: 枠名が空ならエラー文', () => {
  const { call } = setup();
  const r = call('saveShiftSettings', 't', { positions: [], pairRules: [], minVeteranPerSlot: 0,
    slots: [{ name: '', start: '10:00', end: '15:00', weekdays: [1], required: { '': 1 } }] });
  assert.deepEqual(r, { success: false, message: '1件目の枠名を入力してください。' });
});

test('設定の検証: 時間・必要人数・組み合わせ', () => {
  const { call } = setup();
  const base = { positions: [], pairRules: [], minVeteranPerSlot: 0 };
  assert.equal(call('saveShiftSettings', 't', Object.assign({}, base, { slots: [
    { name: 'ランチ', start: '1000', end: '15:00', weekdays: [1], required: { '': 1 } }] })).message,
  '「ランチ」の時間は HH:MM の形式で入力してください。');
  assert.equal(call('saveShiftSettings', 't', Object.assign({}, base, { slots: [
    { name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { '': 0 } }] })).message,
  '「ランチ」の必要人数を1人以上にしてください。');
  assert.equal(call('saveShiftSettings', 't', Object.assign({}, SETTINGS, { pairRules: [{ a: 'x', b: 'x', type: 'avoid' }] })).message,
    '同じスタッフ同士の組み合わせは設定できません。');
});

test('設定の保存: 枠IDが振られ、日をまたぐ枠も保存できる', () => {
  const { call } = setup();
  const r = call('saveShiftSettings', 't', { positions: ['ホール', 'キッチン'], pairRules: [], minVeteranPerSlot: 1,
    slots: [{ name: '夜', start: '17:00', end: '01:00', weekdays: [5, 6], required: { 'ホール': 2, 'キッチン': 1 } }] });
  assert.equal(r.success, true);
  assert.match(r.settings.slots[0].id, /^sl_/);
  assert.deepEqual(call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07').settings, r.settings);
});

test('希望・定期条件・割り当て・日別枠の保存と読み戻し', () => {
  const { call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  const a = call('saveStaffMember', 't', staffInput('A')).staff;
  const reqs = [{ date: '2026-12-05', staffId: a.id, slotId: 'L', kind: 'unavailable', note: '通院' },
    { date: '2026-12-06', staffId: a.id, slotId: '', kind: 'want', note: '' }];
  assert.equal(call('saveRequests', 't', '2026-12-01', '2026-12-07', reqs).success, true);
  const rules = [{ staffId: a.id, weekdays: [1, 2, 3, 4, 5], slotId: 'L', kind: 'unavailable', note: '学校' }];
  assert.equal(call('saveRecurringRules', 't', a.id, rules).success, true);
  const assigns = [as('2026-12-02', 'D', a.id), as('2026-12-03', 'D', a.id, { kind: 'exclude' })];
  const overrides = [{ date: '2026-12-04', slotId: 'L', state: 'off' }];
  assert.equal(call('saveShiftPeriod', 't', '2026-12-01', '2026-12-07', assigns, overrides).success, true);

  const b = call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07');
  assert.deepEqual(b.requests, reqs);
  assert.deepEqual(b.recurring, rules);
  assert.deepEqual(b.assignments, assigns);
  assert.deepEqual(b.dayOverrides, overrides);
  assert.equal(b.business['2026-12-01'].closed, false);
  assert.equal(b.business['2026-12-07'].closed, true); // CONFIG の既定は月曜定休
});

test('希望の検証: 期間外の日付はエラー', () => {
  const { call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  const a = call('saveStaffMember', 't', staffInput('A')).staff;
  assert.deepEqual(call('saveRequests', 't', '2026-12-01', '2026-12-07',
    [{ date: '2026-12-20', staffId: a.id, slotId: '', kind: 'unavailable', note: '' }]),
  { success: false, message: '希望の日付が対象期間の外です。' });
});

test('臨時営業日は business.special が立つ', () => {
  const { mock, call } = setup();
  mock.props.BUSINESS_HOURS_OVERRIDE = JSON.stringify({
    periods: [{ start: '11:00', end: '22:00' }],
    specialDays: [{ date: '2026-12-07', closed: false, note: '臨時営業' }] });
  const b = call('getShiftBootstrap', 't', '2026-12-06', '2026-12-07');
  assert.equal(b.business['2026-12-07'].closed, false);
  assert.equal(b.business['2026-12-07'].special, true);
  assert.equal(b.business['2026-12-06'].special, false);
});

test('期間の置き換え保存は期間外の行を残す', () => {
  const { call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  call('saveShiftPeriod', 't', '2026-11-01', '2026-11-30', [as('2026-11-10', 'L', 'x')], []);
  call('saveShiftPeriod', 't', '2026-12-01', '2026-12-31', [as('2026-12-10', 'L', 'x')], []);
  call('saveShiftPeriod', 't', '2026-12-01', '2026-12-31', [], []);
  assert.equal(call('getShiftBootstrap', 't', '2026-11-01', '2026-11-30').assignments.length, 1);
  assert.equal(call('getShiftBootstrap', 't', '2026-12-01', '2026-12-31').assignments.length, 0);
});

test('2回続けて保存しても行が増えない & ロックを使う', () => {
  const { mock, call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  const list = [as('2026-12-02', 'L', 'x'), as('2026-12-03', 'L', 'y')];
  const before = mock.lockCalls;
  call('saveShiftPeriod', 't', '2026-12-01', '2026-12-07', list, []);
  call('saveShiftPeriod', 't', '2026-12-01', '2026-12-07', list, []);
  assert.equal(mock.sheets('シフト_割り当て').length, 1 + list.length);
  assert.ok(mock.lockCalls >= before + 2);
});

test('日付セルが Date で返っても読める', () => {
  const { call } = setup({ dateCells: true });
  call('saveShiftSettings', 't', SETTINGS);
  const a = call('saveStaffMember', 't', staffInput('A')).staff;
  call('saveRequests', 't', '2026-12-01', '2026-12-07', [{ date: '2026-12-05', staffId: a.id, slotId: '', kind: 'unavailable', note: '' }]);
  call('saveShiftPeriod', 't', '2026-12-01', '2026-12-07', [as('2026-12-02', 'L', a.id)], [{ date: '2026-12-04', slotId: 'L', state: 'off' }]);
  const b = call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07');
  assert.equal(b.requests[0].date, '2026-12-05');
  assert.equal(b.assignments[0].date, '2026-12-02');
  assert.equal(b.dayOverrides[0].date, '2026-12-04');
});

test('存在しない枠IDの割り当て・日別枠は bootstrap で捨てる', () => {
  const { call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  call('saveShiftPeriod', 't', '2026-12-01', '2026-12-07', [as('2026-12-02', 'L', 'x'), as('2026-12-02', 'D', 'x')],
    [{ date: '2026-12-03', slotId: 'D', state: 'off' }]);
  call('saveShiftSettings', 't', Object.assign({}, SETTINGS, { slots: [SETTINGS.slots[0]] }));
  const b = call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07');
  assert.deepEqual(b.assignments.map((x) => x.slotId), ['L']);
  assert.equal(b.dayOverrides.length, 0);
});

test('outsideAssignments は端の週の期間外だけ', () => {
  const { call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  call('saveShiftPeriod', 't', '2026-11-23', '2026-12-13', [
    as('2026-11-29', 'L', 'x'), as('2026-11-30', 'L', 'x'), as('2026-12-04', 'L', 'x'),
    as('2026-12-05', 'L', 'x'), as('2026-12-06', 'L', 'x'), as('2026-12-07', 'L', 'x')], []);
  const b = call('getShiftBootstrap', 't', '2026-12-05', '2026-12-05'); // 土曜1日だけ → 週は 11/30〜12/6
  assert.deepEqual(b.outsideAssignments.map((x) => x.date).sort(), ['2026-11-30', '2026-12-04', '2026-12-06']);
});

test('generateShift は保存せずに案を返す', () => {
  const { mock, call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  const a = call('saveStaffMember', 't', staffInput('A')).staff;
  call('saveStaffMember', 't', staffInput('B'));
  call('saveShiftPeriod', 't', '2026-12-01', '2026-12-07', [], []);
  const before = mock.sheets('シフト_割り当て').length;
  const pinnedA = as('2026-12-02', 'L', a.id);
  const r = call('generateShift', 't', '2026-12-01', '2026-12-07', [pinnedA]);
  assert.equal(r.success, true);
  assert.ok(r.assignments.length > 1);
  assert.ok(r.assignments.some((x) => JSON.stringify(x) === JSON.stringify(pinnedA)));
  assert.ok(Array.isArray(r.warnings));
  assert.equal(r.summary.length, 2);
  assert.equal(r.penalty.length, 7);
  assert.equal(mock.sheets('シフト_割り当て').length, before);
});

// ==================== 最終レビューでの修正 ====================

test('削除した枠への希望・定期条件は bootstrap で捨て、希望の保存が続けられる', () => {
  const { call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  const a = call('saveStaffMember', 't', staffInput('A')).staff;
  call('saveRequests', 't', '2026-12-01', '2026-12-07', [{ date: '2026-12-05', staffId: a.id, slotId: 'D', kind: 'unavailable', note: '' }]);
  call('saveRecurringRules', 't', a.id, [{ weekdays: [1], slotId: 'D', kind: 'unavailable', note: '' }]);
  call('saveShiftSettings', 't', Object.assign({}, SETTINGS, { slots: [SETTINGS.slots[0]] })); // D を削除
  const b = call('getShiftBootstrap', 't', '2026-12-01', '2026-12-07');
  assert.equal(b.requests.length, 0);
  assert.equal(b.recurring.length, 0);
  const more = b.requests.concat([{ date: '2026-12-06', staffId: a.id, slotId: '', kind: 'want', note: '' }]);
  assert.equal(call('saveRequests', 't', '2026-12-01', '2026-12-07', more).success, true);
});

test('generateShift は渡された日別枠で作り、保存しない', () => {
  const { mock, call } = setup();
  call('saveShiftSettings', 't', SETTINGS);
  call('saveStaffMember', 't', staffInput('A'));
  call('saveStaffMember', 't', staffInput('B'));
  const r = call('generateShift', 't', '2026-12-01', '2026-12-01', [], [{ date: '2026-12-01', slotId: 'D', state: 'off' }]);
  assert.equal(r.success, true);
  assert.deepEqual(r.assignments.map((x) => x.slotId), ['L']);
  // 読み込み時に見出し行だけのシートは作られるが、データ行は書かれない
  assert.equal(mock.sheets('シフト_割り当て').length, 1);
  assert.equal(mock.sheets('シフト_日別枠').length, 1);
});
