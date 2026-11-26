'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { loadGas } = require('./helpers/load-gas');

const c = vm.runInContext('shiftCoreFactory()', loadGas(['ShiftCore.gs']));
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
const open = { closed: false, note: '', periods: [{ startMin: 600, endMin: 1380 }] };

function problem(o) {
  const from = o.from || '2026-11-30';
  const to = o.to || '2026-12-06';
  const business = {};
  c.listDates(from, to).forEach((d) => { business[d] = open; });
  const staff = o.staff.map((s) => Object.assign(
    { name: s.id, positions: [], veteran: false, targetDays: null, maxDays: null, maxHours: null, active: true, note: '' }, s));
  return c.buildProblem({
    from, to, business, staff,
    settings: Object.assign({ positions: [], pairRules: [], minVeteranPerSlot: 0 }, o.settings),
    requests: o.requests || [], recurring: o.recurring || [], dayOverrides: [],
    outsideAssignments: o.outsideAssignments || [],
  });
}
const slot = (id, start, end, required, name) => ({ id, name: name || id, start, end, weekdays: ALL_WEEK, required });
const as = (date, slotId, staffId, position) =>
  ({ date, slotId, position: position || '', staffId, kind: 'assign', pinned: false });
const opts = { seed: 1, timeLimitMs: 300 };
const has = (out, date, slotId, staffId) =>
  out.some((x) => x.kind === 'assign' && x.date === date && x.slotId === slotId && x.staffId === staffId);

test('出られない人は入らない(終日・枠単位・定期)', () => {
  const p = problem({
    staff: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 1 }), slot('D', '17:00', '22:00', { '': 1 })] },
    requests: [
      { date: '2026-11-30', staffId: 'A', slotId: '', kind: 'unavailable' },
      { date: '2026-12-01', staffId: 'A', slotId: 'D', kind: 'unavailable' }],
    recurring: [{ staffId: 'A', weekdays: [3], slotId: 'L', kind: 'unavailable' }],
  });
  const out = c.solve(p, [], opts);
  assert.ok(!has(out, '2026-11-30', 'L', 'A'));
  assert.ok(!has(out, '2026-11-30', 'D', 'A'));
  assert.ok(!has(out, '2026-12-01', 'D', 'A'));
  assert.ok(!has(out, '2026-12-02', 'L', 'A'));
  assert.equal(c.evaluate(p, out).penalty[0], 0);
});

test('人数が足りれば avoid の2人は同じ時間にならない', () => {
  const p = problem({
    staff: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 1 }), slot('T', '10:00', '23:00', { '': 1 })],
      pairRules: [{ a: 'A', b: 'B', type: 'avoid' }] },
  });
  const r = c.evaluate(p, c.solve(p, [], opts));
  assert.equal(r.penalty[1], 0);
  assert.equal(r.penalty[2], 0);
});

test('人数が足りなければ枠を空けずに一緒に入れて警告', () => {
  const p = problem({
    from: '2026-11-30', to: '2026-11-30',
    staff: [{ id: 'A' }, { id: 'B' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 2 }, 'ランチ')], pairRules: [{ a: 'A', b: 'B', type: 'avoid' }] },
  });
  const out = c.solve(p, [], opts);
  assert.ok(has(out, '2026-11-30', 'L', 'A'));
  assert.ok(has(out, '2026-11-30', 'L', 'B'));
  const r = c.evaluate(p, out);
  assert.equal(r.penalty[1], 0);
  assert.equal(r.warnings.filter((w) => w.code === 'avoid').length, 1);
});

test('固定(割り当て・除外)は変わらない', () => {
  const p = problem({ staff: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 1 })] } });
  const pinnedC = Object.assign(as('2026-11-30', 'L', 'C'), { pinned: true });
  const exclB = { date: '2026-12-01', slotId: 'L', position: '', staffId: 'B', kind: 'exclude', pinned: true };
  const out = c.solve(p, [pinnedC, exclB, as('2026-12-02', 'L', 'A')], opts);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  assert.ok(out.some((x) => same(x, pinnedC)));
  assert.ok(out.some((x) => same(x, exclB)));
  assert.ok(!has(out, '2026-12-01', 'L', 'B'));
  assert.equal(out.filter((x) => x.date === '2026-11-30' && x.kind === 'assign').length, 1);
  // 自動で作った割り当ては固定なし
  assert.ok(out.filter((x) => !same(x, pinnedC) && !same(x, exclB)).every((x) => x.pinned === false && x.kind === 'assign'));
});

test('週の目安日数に近づく', () => {
  const p = problem({ staff: [{ id: 'A', targetDays: 1 }, { id: 'B', targetDays: 4 }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 1 })] } });
  const r = c.evaluate(p, c.solve(p, [], opts));
  const days = (id) => r.summary.find((s) => s.staffId === id).days;
  assert.ok(days('A') <= 2, 'A=' + days('A'));
  assert.ok(days('B') >= 3, 'B=' + days('B'));
});

test('週の上限日数を超えない(期間外の割り当て込み)', () => {
  const p = problem({
    from: '2026-12-05', to: '2026-12-06',
    staff: [{ id: 'A', maxDays: 2 }, { id: 'B' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 1 })] },
    outsideAssignments: [as('2026-11-30', 'L', 'A'), as('2026-12-01', 'L', 'A')],
  });
  const out = c.solve(p, [], opts);
  assert.ok(!out.some((x) => x.staffId === 'A'));
  assert.equal(c.evaluate(p, out).penalty[0], 0);
});

test('同じ人を時間が重なる2枠に入れない', () => {
  const p = problem({ from: '2026-11-30', to: '2026-11-30', staff: [{ id: 'A' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 1 }), slot('T', '10:00', '23:00', { '': 1 })] } });
  const out = c.solve(p, [], opts);
  assert.equal(out.length, 1);
});

test('候補ゼロの枠でも例外を出さず不足になる', () => {
  const p = problem({ staff: [{ id: 'A' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 1 })] },
    recurring: [{ staffId: 'A', weekdays: ALL_WEEK, slotId: '', kind: 'unavailable' }] });
  const out = c.solve(p, [], opts);
  assert.equal(out.length, 0);
  assert.equal(c.evaluate(p, out).penalty[1], 7);
});

test('同じ seed なら同じ結果', () => {
  const mk = () => problem({ staff: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    settings: { slots: [slot('L', '10:00', '15:00', { '': 2 }), slot('D', '17:00', '22:00', { '': 2 })],
      pairRules: [{ a: 'A', b: 'B', type: 'avoid' }] } });
  const fakeNow = () => { let t = 0; return () => (t += 1); };
  const r1 = c.solve(mk(), [], { seed: 7, timeLimitMs: 500, now: fakeNow() });
  const r2 = c.solve(mk(), [], { seed: 7, timeLimitMs: 500, now: fakeNow() });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('性能: 30人・31日・1日3枠が時間内に終わる', { timeout: 40000 }, () => {
  const staff = [];
  for (let i = 0; i < 30; i++) {
    staff.push({ id: 'S' + i, positions: i % 3 === 0 ? ['キッチン'] : ['ホール'], maxDays: 5, veteran: i % 5 === 0 });
  }
  const req = { 'ホール': 2, 'キッチン': 1 };
  const p = problem({
    from: '2026-12-01', to: '2026-12-31', staff,
    settings: { positions: ['ホール', 'キッチン'], minVeteranPerSlot: 1,
      slots: [slot('L', '10:00', '15:00', req), slot('D', '17:00', '22:00', req), slot('N', '22:00', '01:00', req)],
      pairRules: [{ a: 'S1', b: 'S2', type: 'avoid' }, { a: 'S0', b: 'S3', type: 'avoid' }] },
  });
  const t0 = Date.now();
  const out = c.solve(p, [], { seed: 3, timeLimitMs: 20000 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 30000, 'elapsed ' + elapsed);
  const r = c.evaluate(p, out);
  assert.equal(r.penalty[0], 0);
  assert.equal(r.penalty[1], 0);
  assert.equal(r.penalty[2], 0);
});
