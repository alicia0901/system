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
