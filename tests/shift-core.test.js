'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { loadGas } = require('./helpers/load-gas');

// vm コンテキスト内のオブジェクトは別 realm なので、比較前に JSON で通常のオブジェクトにする
const plain = (v) => JSON.parse(JSON.stringify(v));
const core = () => vm.runInContext('shiftCoreFactory()', loadGas(['ShiftCore.gs']));
const S = (o) => Object.assign({ positions: [], pairRules: [], minVeteranPerSlot: 0 }, o);
const open = { closed: false, note: '', periods: [{ startMin: 660, endMin: 1320 }] };

test('slotRange: 日をまたぐ枠', () => {
  assert.deepEqual(plain(core().slotRange({ start: '17:00', end: '01:00' })), { startMin: 1020, endMin: 1500 });
});

test('listDates/mondayOf', () => {
  const c = core();
  assert.deepEqual(plain(c.listDates('2026-11-29', '2026-12-01')), ['2026-11-29', '2026-11-30', '2026-12-01']);
  assert.equal(c.mondayOf('2026-11-29'), '2026-11-23');
  assert.equal(c.mondayOf('2026-11-30'), '2026-11-30');
  assert.equal(c.weekdayOf('2026-11-30'), 1);
  assert.equal(c.formatMD('2026-12-05'), '12/5');
  assert.equal(c.hhmmToMin('10:30'), 630);
});

test('buildCells: 曜日・休業・担当ごとに展開', () => {
  const settings = S({ positions: ['ホール', 'キッチン'], slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { 'ホール': 1, 'キッチン': 2 } }] });
  const cells = core().buildCells(settings, ['2026-11-30', '2026-12-01'],
    { '2026-11-30': open, '2026-12-01': open }, []);
  assert.deepEqual(plain(cells.map((c) => c.key)), ['2026-11-30|L|ホール', '2026-11-30|L|キッチン']);
  assert.equal(cells[1].required, 2);
  assert.equal(cells[0].slotName, 'ランチ');
  assert.equal(cells[0].startMin, 600);
  assert.equal(cells[0].endMin, 900);
});

test('buildCells: 必要人数0の担当はセルにしない', () => {
  const settings = S({ positions: ['ホール', 'キッチン'], slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { 'ホール': 0, 'キッチン': 1 } }] });
  const cells = core().buildCells(settings, ['2026-11-30'], { '2026-11-30': open }, []);
  assert.deepEqual(plain(cells.map((c) => c.position)), ['キッチン']);
});

test('buildCells: 休業日は枠なし', () => {
  const settings = S({ slots: [{ id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { '': 2 } }] });
  assert.equal(core().buildCells(settings, ['2026-11-30'],
    { '2026-11-30': { closed: true, note: '', periods: [] } }, []).length, 0);
});

test('buildCells: どの枠の曜日にも入っていない臨時営業日は営業時間と重なる枠を全部出す', () => {
  const settings = S({ slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [2], required: { '': 1 } },
    { id: 'N', name: '深夜', start: '23:00', end: '02:00', weekdays: [2], required: { '': 1 } }] });
  const special = Object.assign({}, open, { special: true }); // 特別な日(臨時営業)
  const cells = core().buildCells(settings, ['2026-11-30'], { '2026-11-30': special }, []);
  assert.deepEqual(plain(cells.map((c) => c.slotId)), ['L']);
  // 特別な日でなければ(普段の営業日で、その曜日の枠を作っていないだけ)何も出さない
  assert.equal(core().buildCells(settings, ['2026-11-30'], { '2026-11-30': open }, []).length, 0);
});

test('buildCells: 日別枠 off/on', () => {
  const settings = S({ slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { '': 1 } },
    { id: 'D', name: 'ディナー', start: '17:00', end: '22:00', weekdays: [2], required: { '': 1 } }] });
  const cells = core().buildCells(settings, ['2026-11-30'], { '2026-11-30': open },
    [{ date: '2026-11-30', slotId: 'L', state: 'off' }, { date: '2026-11-30', slotId: 'D', state: 'on' }]);
  assert.deepEqual(plain(cells.map((c) => c.slotId)), ['D']);
});

// ==================== Task 2: 希望の解決と評価 ====================

const c2 = core();
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
function fixture(o) {
  o = o || {};
  const from = o.from || '2026-11-30';
  const to = o.to || '2026-12-06';
  const business = {};
  c2.listDates(from, to).forEach((d) => { business[d] = open; });
  const staff = ['A', 'B', 'C'].map((id) => Object.assign(
    { id: id, name: id, positions: [], veteran: false, targetDays: null, maxDays: null, maxHours: null, active: true, note: '' },
    (o.staffOverrides || {})[id] || {}));
  return c2.buildProblem({
    from: from, to: to,
    settings: Object.assign(S({
      slots: [
        { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: ALL_WEEK, required: { '': 1 } },
        { id: 'T', name: '通し', start: '10:00', end: '23:00', weekdays: ALL_WEEK, required: { '': 1 } }],
      pairRules: [{ a: 'A', b: 'B', type: 'avoid' }],
    }), o.settings || {}),
    staff: staff,
    requests: o.requests || [],
    recurring: o.recurring || [],
    business: business,
    dayOverrides: [],
    outsideAssignments: o.outsideAssignments || [],
  });
}
const as = (date, slotId, staffId, position) =>
  ({ date: date, slotId: slotId, position: position || '', staffId: staffId, kind: 'assign', pinned: false });

test('availability: その日の希望が定期条件より強い', () => {
  const p = fixture({ recurring: [{ staffId: 'A', weekdays: [1], slotId: '', kind: 'unavailable' }],
    requests: [{ date: '2026-11-30', staffId: 'A', slotId: 'L', kind: 'want' }] });
  assert.equal(c2.availability(p, 'A', '2026-11-30', 'L'), 'want');
  assert.equal(c2.availability(p, 'A', '2026-11-30', 'T'), 'unavailable');
  assert.equal(c2.availability(p, 'A', '2026-12-01', 'L'), null);
});

test('availability: 枠指定は終日より強い', () => {
  const p = fixture({ requests: [
    { date: '2026-11-30', staffId: 'A', slotId: '', kind: 'unavailable' },
    { date: '2026-11-30', staffId: 'A', slotId: 'T', kind: 'want' }] });
  assert.equal(c2.availability(p, 'A', '2026-11-30', 'L'), 'unavailable');
  assert.equal(c2.availability(p, 'A', '2026-11-30', 'T'), 'want');
});

test('evaluate: 重なる枠の2人は avoid 警告', () => {
  const r = c2.evaluate(fixture(), [as('2026-11-30', 'L', 'A'), as('2026-11-30', 'T', 'B')]);
  assert.equal(r.penalty[2], 1);
  assert.ok(r.warnings.some((w) => w.code === 'avoid' && w.level === 'warn' &&
    w.message === '11/30 ランチ/通し: AさんとBさんが同じ時間(できれば避けたい組み合わせ)'));
});

test('evaluate: 同じ枠の avoid は枠名1つ', () => {
  const p = fixture({ settings: { slots: [
    { id: 'D', name: 'ディナー', start: '17:00', end: '22:00', weekdays: ALL_WEEK, required: { '': 2 } }] } });
  const r = c2.evaluate(p, [as('2026-11-30', 'D', 'A'), as('2026-11-30', 'D', 'B')]);
  assert.ok(r.warnings.some((w) => w.message === '11/30 ディナー: AさんとBさんが同じ時間(できれば避けたい組み合わせ)'));
});

test('evaluate: 重ならない枠の avoid は警告なし', () => {
  const p = fixture({ settings: { slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: ALL_WEEK, required: { '': 1 } },
    { id: 'D', name: 'ディナー', start: '17:00', end: '22:00', weekdays: ALL_WEEK, required: { '': 1 } }] } });
  const r = c2.evaluate(p, [as('2026-11-30', 'L', 'A'), as('2026-11-30', 'D', 'B')]);
  assert.equal(r.penalty[2], 0);
});

test('evaluate: 日をまたぐ枠と同日の深夜枠は同じ時間', () => {
  const p = fixture({ settings: { slots: [
    { id: 'N1', name: '夜', start: '17:00', end: '01:00', weekdays: ALL_WEEK, required: { '': 1 } },
    { id: 'N2', name: '深夜', start: '22:00', end: '24:00', weekdays: ALL_WEEK, required: { '': 1 } }] } });
  const r = c2.evaluate(p, [as('2026-11-30', 'N1', 'A'), as('2026-11-30', 'N2', 'B')]);
  assert.equal(r.penalty[2], 1);
  assert.equal(r.summary.find((s) => s.staffId === 'A').hours, 8);
});

test('evaluate: 不足', () => {
  const r = c2.evaluate(fixture(), []);
  assert.equal(r.penalty[1], 14);
  assert.ok(r.warnings.some((w) => w.code === 'shortage' && w.message === '11/30 ランチ: スタッフが1人不足'));
});

test('evaluate: 担当ありの不足は担当名', () => {
  const p = fixture({ settings: { positions: ['ホール', 'キッチン'], slots: [
    { id: 'D', name: 'ディナー', start: '17:00', end: '22:00', weekdays: [1], required: { 'ホール': 1, 'キッチン': 1 } }] } });
  const r = c2.evaluate(p, []);
  assert.ok(r.warnings.some((w) => w.message === '11/30 ディナー: キッチンが1人不足'));
});

test('evaluate: 週の上限は期間外の割り当ても数える', () => {
  const p = fixture({ from: '2026-12-05', to: '2026-12-06', staffOverrides: { A: { maxDays: 2 } },
    outsideAssignments: [as('2026-11-30', 'L', 'A'), as('2026-12-01', 'L', 'A')] });
  const r = c2.evaluate(p, [as('2026-12-05', 'L', 'A')]);
  assert.equal(r.penalty[0], 1);
  assert.ok(r.warnings.some((w) => w.level === 'error' && w.message === 'Aさん: 11/30〜の週の出勤が3日(上限2日)'));
});

test('evaluate: 週の上限時間', () => {
  const p = fixture({ staffOverrides: { A: { maxHours: 20 } } });
  const r = c2.evaluate(p, [as('2026-11-30', 'T', 'A'), as('2026-12-01', 'T', 'A')]);
  assert.ok(r.warnings.some((w) => w.message === 'Aさん: 11/30〜の週の勤務が26時間(上限20時間)'));
  assert.equal(r.summary.find((s) => s.staffId === 'A').overMaxHours, true);
});

test('evaluate: 出られない・担当外は error', () => {
  const p = fixture({
    settings: { positions: ['ホール', 'キッチン'], slots: [
      { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: ALL_WEEK, required: { 'ホール': 1, 'キッチン': 1 } }] },
    staffOverrides: { A: { positions: ['ホール'] }, B: { positions: ['ホール'] } },
    requests: [{ date: '2026-11-30', staffId: 'B', slotId: '', kind: 'unavailable' }],
  });
  const r = c2.evaluate(p, [as('2026-11-30', 'L', 'A', 'キッチン'), as('2026-11-30', 'L', 'B', 'ホール')]);
  assert.equal(r.penalty[0], 2);
  assert.ok(r.warnings.some((w) => w.level === 'error' && w.message === '11/30 ランチ: Aさんはキッチンの担当外'));
  assert.ok(r.warnings.some((w) => w.level === 'error' && w.message === '11/30 ランチ: Bさんは出られない日'));
});

test('evaluate: 休み希望・ベテラン不足・出たい', () => {
  const p = fixture({
    settings: { minVeteranPerSlot: 1 },
    staffOverrides: { C: { veteran: true } },
    requests: [
      { date: '2026-11-30', staffId: 'A', slotId: '', kind: 'prefer_off' },
      { date: '2026-11-30', staffId: 'C', slotId: 'T', kind: 'want' }],
  });
  const r = c2.evaluate(p, [as('2026-11-30', 'L', 'A'), as('2026-11-30', 'T', 'C')]);
  assert.equal(r.penalty[3], 1);
  assert.equal(r.penalty[4], 1); // ランチにベテランなし。通しは C がいる
  assert.equal(r.penalty[6], -1);
  assert.ok(r.warnings.some((w) => w.message === '11/30 ランチ: Aさんは休み希望'));
  assert.ok(r.warnings.some((w) => w.message === '11/30 ランチ: ベテランが1人不足'));
});

test('evaluate: 在籍外スタッフ・消えた枠への割り当ては無視', () => {
  const r = c2.evaluate(fixture({ staffOverrides: { C: { active: false } } }),
    [as('2026-11-30', 'L', 'C'), as('2026-11-30', 'ZZ', 'A'), as('2026-11-30', 'L', 'nobody')]);
  assert.equal(r.penalty[1], 14);
  assert.equal(r.warnings.filter((w) => w.level === 'error').length, 0);
  assert.equal(r.summary.length, 2);
});

test('evaluate: 在籍外スタッフを含む avoid 条件は無視', () => {
  const p = fixture({ staffOverrides: { B: { active: false } } });
  const r = c2.evaluate(p, [as('2026-11-30', 'L', 'A'), as('2026-11-30', 'T', 'B')]);
  assert.equal(r.penalty[2], 0);
});

test('evaluate: expectedDays と fairness', () => {
  const p = fixture({ staffOverrides: { A: { targetDays: 1 }, B: { targetDays: 4 } } });
  assert.equal(p.expectedDays.A, 1);
  assert.equal(p.expectedDays.B, 4);
  assert.equal(p.expectedDays.C, 9);
  const r = c2.evaluate(p, [as('2026-11-30', 'L', 'A'), as('2026-12-01', 'L', 'A')]);
  // A: (2-1)^2=1, B: (0-4)^2=16, C: (0-9)^2=81
  assert.equal(r.penalty[5], 98);
  assert.equal(r.summary.find((s) => s.staffId === 'A').days, 2);
  assert.equal(r.summary.find((s) => s.staffId === 'A').expectedDays, 1);
});

test('comparePenalty は先頭優先', () => {
  assert.equal(c2.comparePenalty([0, 0, 1, 0, 0, 0, 0], [0, 0, 0, 99, 99, 99, 0]), 1);
  assert.equal(c2.comparePenalty([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]), 0);
  assert.equal(c2.comparePenalty([0, 1, 0, 0, 0, 0, 0], [0, 2, 0, 0, 0, 0, 0]), -1);
});
