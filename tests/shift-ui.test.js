'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { openShiftPage, hasPlaywright } = require('./helpers/shift-page');
const { loadGas } = require('./helpers/load-gas');
const { createGasMock } = require('./helpers/gas-mock');

const ui = hasPlaywright ? test : test.skip;
const pad = (n) => (n < 10 ? '0' + n : '' + n);

// ==================== Task 5: 入口・ログイン・配布設定 ====================

ui('ログイン → 4タブが出る、期間の初期値は翌月', async () => {
  const s = await openShiftPage();
  try {
    await s.login();
    assert.equal(await s.page.locator('[data-tab]').count(), 4);
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    assert.equal(await s.page.inputValue('#periodFrom'), first.getFullYear() + '-' + pad(first.getMonth() + 1) + '-01');
    assert.equal(await s.page.inputValue('#periodTo'), last.getFullYear() + '-' + pad(last.getMonth() + 1) + '-' + pad(last.getDate()));
    assert.equal(await s.page.getAttribute('#backToAdmin', 'href'), 'https://script.example/exec?page=admin');
    await s.page.click('[data-tab="staff"]');
    const active = (id) => s.page.evaluate((x) => document.getElementById(x).classList.contains('active'), id);
    assert.equal(await active('tab-staff'), true);
    assert.equal(await active('tab-grid'), false);
    assert.deepEqual(s.errors(), []);
  } finally { await s.close(); }
});

ui('パスワード違いはエラー', async () => {
  const s = await openShiftPage();
  try {
    await s.page.fill('#password', 'wrong');
    await s.page.click('#loginBtn');
    await s.page.waitForFunction(() => document.getElementById('loginMsg').textContent !== '');
    assert.equal(await s.page.textContent('#loginMsg'), 'パスワードが違います。');
    assert.equal(await s.page.isVisible('#appView'), false);
  } finally { await s.close(); }
});

ui('保存済みのトークンがあればログインを飛ばす', async () => {
  const s = await openShiftPage();
  try {
    await s.page.evaluate(() => sessionStorage.setItem('adminToken', 'seed'));
    await s.page.reload();
    await s.page.waitForSelector('#appView', { state: 'visible' });
  } finally { await s.close(); }
});

test('create-store.js がシフトのファイルもコピーする', () => {
  const repo = path.join(__dirname, '..');
  const slug = 'shift-test-' + process.pid;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-store-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'setup', 'store-config.example.json'), 'utf8'));
  cfg.storeSlug = slug;
  cfg.adminPassword = 'test-password';
  const cfgPath = path.join(tmp, 'store.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const outDir = path.join(repo, 'stores', slug);
  try {
    execFileSync('node', [path.join(repo, 'setup', 'create-store.js'), cfgPath], { stdio: 'pipe' });
    ['Code.gs', 'Shift.gs', 'ShiftCore.gs', 'shift.html', 'admin.html', '.claspignore'].forEach((f) => {
      assert.ok(fs.existsSync(path.join(outDir, 'gas', f)), f + ' がない');
    });
    const ignore = fs.readFileSync(path.join(outDir, 'gas', '.claspignore'), 'utf8');
    ['!Shift.gs', '!ShiftCore.gs', '!shift.html'].forEach((l) => assert.ok(ignore.includes(l), l));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('doGet(page=shift) はシフト画面を返し、管理画面には shiftUrl を渡す', () => {
  const mock = createGasMock();
  const ctx = loadGas(['Code.gs', 'ShiftCore.gs', 'Shift.gs'], mock.globals);
  const doGet = vm.runInContext('doGet', ctx);
  doGet({ parameter: { page: 'shift' } });
  doGet({ parameter: { page: 'admin' } });
  const [shift, admin] = mock.templates;
  assert.equal(shift.name, 'shift');
  assert.equal(shift.title, '飲食店 シフト表');
  assert.equal(shift.vars.adminUrl, 'https://script.example/exec?page=admin');
  assert.equal(shift.vars.storeName, '飲食店');
  assert.match(shift.vars.shiftCoreSource, /^function shiftCoreFactory\(\)/);
  assert.equal(admin.name, 'admin');
  assert.equal(admin.vars.shiftUrl, 'https://script.example/exec?page=shift');
});

test('Code.gs の CONFIG ブロックが create-store.js の正規表現で見つかる', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  assert.ok(/const CONFIG = \{[\s\S]*?\n\};/.test(code));
});

// ==================== Task 6: スタッフと枠・条件 ====================

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
const SIMPLE_SETTINGS = {
  positions: [], pairRules: [], minVeteranPerSlot: 0,
  slots: [{ id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: ALL_WEEK, required: { '': 1 } }],
};
const staffIn = (name, extra) => Object.assign(
  { id: '', name, positions: [], veteran: false, targetDays: null, maxDays: null, maxHours: null, active: true, note: '' }, extra || {});
const boot = (s) => s.call('getShiftBootstrap', 'seed', '2026-12-01', '2026-12-31');
const waitMsg = (s, id, text) => s.page.waitForFunction(
  ([i, t]) => document.getElementById(i) && document.getElementById(i).textContent.indexOf(t) !== -1, [id, text]);

ui('スタッフを追加して定期条件(平日ランチ不可)を登録', async () => {
  const s = await openShiftPage({ seed: (call) => call('saveShiftSettings', 'seed', SIMPLE_SETTINGS) });
  try {
    await s.login();
    await s.page.click('[data-tab="staff"]');
    await s.page.click('#staffAddBtn');
    await s.page.fill('#staffName', '田中');
    await s.page.fill('#staffTarget', '3');
    await s.page.click('#recurringAddBtn');
    const row = s.page.locator('#recurringRows .recurringRow').first();
    for (const wd of [1, 2, 3, 4, 5]) await row.locator('input.rwd[value="' + wd + '"]').check();
    await row.locator('select.rslot').selectOption('L');
    await row.locator('select.rkind').selectOption('unavailable');
    await s.page.click('#staffSaveBtn');
    await waitMsg(s, 'staffMsg', '保存しました');
    const b = boot(s);
    const tanaka = b.staff.find((x) => x.name === '田中');
    assert.equal(tanaka.targetDays, 3);
    assert.deepEqual(b.recurring.map((r) => ({ staffId: r.staffId, weekdays: r.weekdays, slotId: r.slotId, kind: r.kind })),
      [{ staffId: tanaka.id, weekdays: [1, 2, 3, 4, 5], slotId: 'L', kind: 'unavailable' }]);
    assert.ok((await s.page.textContent('#staffList')).includes('田中'));
    assert.deepEqual(s.errors(), []);
  } finally { await s.close(); }
});

ui('在籍を外すと一覧で在籍外になる', async () => {
  const s = await openShiftPage({ seed: (call) => { call('saveShiftSettings', 'seed', SIMPLE_SETTINGS); call('saveStaffMember', 'seed', staffIn('佐藤')); } });
  try {
    await s.login();
    await s.page.click('[data-tab="staff"]');
    await s.page.click('#staffList .staffItem');
    await s.page.click('#staffActiveBtn');
    await waitMsg(s, 'staffList', '在籍外');
    assert.equal(boot(s).staff[0].active, false);
  } finally { await s.close(); }
});

ui('担当なしの店では必要人数が1つだけ、担当ありなら担当ごと', async () => {
  const s = await openShiftPage({ seed: (call) => call('saveShiftSettings', 'seed', SIMPLE_SETTINGS) });
  try {
    await s.login();
    await s.page.click('[data-tab="settings"]');
    assert.equal(await s.page.locator('.slotRow').first().locator('input.sreq').count(), 1);
    await s.page.click('#posAddBtn');
    await s.page.locator('#posRows .posRow input.pname').last().fill('ホール');
    await s.page.click('#posAddBtn');
    await s.page.locator('#posRows .posRow input.pname').last().fill('キッチン');
    await s.page.locator('#posRows .posRow input.pname').last().dispatchEvent('change');
    assert.equal(await s.page.locator('.slotRow').first().locator('input.sreq').count(), 2);
  } finally { await s.close(); }
});

ui('枠と「一緒にしない」を保存', async () => {
  let a, b;
  const s = await openShiftPage({ seed: (call) => {
    call('saveShiftSettings', 'seed', SIMPLE_SETTINGS);
    a = call('saveStaffMember', 'seed', staffIn('A')).staff;
    b = call('saveStaffMember', 'seed', staffIn('B')).staff;
  } });
  try {
    await s.login();
    await s.page.click('[data-tab="settings"]');
    await s.page.click('#slotAddBtn');
    const row = s.page.locator('.slotRow').last();
    await row.locator('input.sname').fill('夜');
    await row.locator('input.sstart').fill('17:00');
    await row.locator('input.send').fill('01:00');
    await row.locator('input.send').dispatchEvent('change');
    assert.ok((await row.textContent()).includes('翌日まで'));
    await row.locator('input.swd[value="5"]').check();
    await row.locator('input.sreq').fill('2');
    await s.page.click('#pairAddBtn');
    const pr = s.page.locator('#pairRows .pairRow').first();
    await pr.locator('select.pa').selectOption(a.id);
    await pr.locator('select.pb').selectOption(b.id);
    await s.page.fill('#minVeteran', '1');
    await s.page.click('#settingsSaveBtn');
    await waitMsg(s, 'settingsMsg', '保存しました');
    const st = boot(s).settings;
    assert.deepEqual(st.pairRules, [{ a: a.id, b: b.id, type: 'avoid' }]);
    assert.equal(st.minVeteranPerSlot, 1);
    const night = st.slots.find((x) => x.name === '夜');
    assert.deepEqual([night.start, night.end, night.weekdays, night.required], ['17:00', '01:00', [5], { '': 2 }]);
    assert.equal(st.slots.find((x) => x.name === 'ランチ').id, 'L'); // 既存の枠IDは変わらない
  } finally { await s.close(); }
});

ui('検証エラーがそのまま表示される', async () => {
  const s = await openShiftPage();
  try {
    await s.login();
    await s.page.click('[data-tab="settings"]');
    await s.page.click('#settingsSaveBtn');
    await waitMsg(s, 'settingsMsg', '件目');
    assert.equal(await s.page.textContent('#settingsMsg'), '1件目の枠名を入力してください。');
  } finally { await s.close(); }
});

// ==================== Task 7: 希望・休み ====================

const NOV = ['2026-11-01', '2026-11-30'];
async function openPeriod(s, from, to) {
  await s.page.fill('#periodFrom', from);
  await s.page.fill('#periodTo', to);
  await s.page.click('#periodLoadBtn');
  await s.page.waitForFunction(([f]) => document.getElementById('periodMsg').textContent === '' &&
    window.STATE && STATE.from === f, [from]);
}
const seedTwo = (ids) => (call) => {
  call('saveShiftSettings', 'seed', SIMPLE_SETTINGS);
  ['A', 'B'].forEach((n) => { ids[n] = call('saveStaffMember', 'seed', staffIn(n)).staff.id; });
};

ui('11/5 ランチだけ出られないを入力して保存', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedTwo(ids) });
  try {
    await s.login();
    await s.page.click('[data-tab="requests"]');
    await openPeriod(s, NOV[0], NOV[1]);
    await s.page.selectOption('#reqStaff', ids.A);
    await s.page.click('.reqDay[data-date="2026-11-05"]');
    await s.page.selectOption('#reqPicker select.reqKind[data-slot="L"]', 'unavailable');
    assert.ok((await s.page.textContent('.reqDay[data-date="2026-11-05"]')).includes('ランチ×'));
    await s.page.click('#reqSaveBtn');
    await waitMsg(s, 'reqMsg', '保存しました');
    const reqs = s.call('getShiftBootstrap', 'seed', NOV[0], NOV[1]).requests;
    assert.deepEqual(reqs.map((r) => [r.date, r.staffId, r.slotId, r.kind]), [['2026-11-05', ids.A, 'L', 'unavailable']]);
    assert.deepEqual(s.errors(), []);
  } finally { await s.close(); }
});

ui('定期条件は薄く表示され、その日の希望で上書きできる', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: (call, mock) => {
    seedTwo(ids)(call, mock);
    call('saveRecurringRules', 'seed', ids.A, [{ weekdays: [4], slotId: '', kind: 'unavailable', note: '' }]);
  } });
  try {
    await s.login();
    await s.page.click('[data-tab="requests"]');
    await openPeriod(s, NOV[0], NOV[1]);
    await s.page.selectOption('#reqStaff', ids.A);
    const day = s.page.locator('.reqDay[data-date="2026-11-05"]');
    assert.ok((await day.textContent()).includes('×'));
    assert.equal(await day.locator('.fromRecurring').count(), 1);
    await day.click();
    await s.page.selectOption('#reqPicker select.reqKind[data-slot=""]', 'want');
    assert.ok((await day.textContent()).includes('◎'));
    assert.equal(await day.locator('.fromRecurring').count(), 0);
    // 休業日(月曜)は「休業」
    assert.ok((await s.page.textContent('.reqDay[data-date="2026-11-02"]')).includes('休業'));
  } finally { await s.close(); }
});

ui('他のスタッフの希望も消えずに保存される', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedTwo(ids) });
  try {
    await s.login();
    await s.page.click('[data-tab="requests"]');
    await openPeriod(s, NOV[0], NOV[1]);
    await s.page.selectOption('#reqStaff', ids.A);
    await s.page.click('.reqDay[data-date="2026-11-05"]');
    await s.page.selectOption('#reqPicker select.reqKind[data-slot=""]', 'prefer_off');
    await s.page.selectOption('#reqStaff', ids.B);
    await s.page.click('.reqDay[data-date="2026-11-06"]');
    await s.page.selectOption('#reqPicker select.reqKind[data-slot=""]', 'unavailable');
    await s.page.click('#reqSaveBtn');
    await waitMsg(s, 'reqMsg', '保存しました');
    const reqs = s.call('getShiftBootstrap', 'seed', NOV[0], NOV[1]).requests;
    assert.deepEqual(reqs.map((r) => [r.date, r.staffId, r.kind]).sort(),
      [['2026-11-05', ids.A, 'prefer_off'], ['2026-11-06', ids.B, 'unavailable']]);
  } finally { await s.close(); }
});

ui('未保存のまま別タブへ移ると確認が出て、破棄される', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedTwo(ids) });
  try {
    await s.login();
    await s.page.click('[data-tab="requests"]');
    await openPeriod(s, NOV[0], NOV[1]);
    await s.page.selectOption('#reqStaff', ids.A);
    await s.page.click('.reqDay[data-date="2026-11-05"]');
    await s.page.selectOption('#reqPicker select.reqKind[data-slot=""]', 'prefer_off');
    let asked = '';
    s.page.removeAllListeners('dialog');
    s.page.on('dialog', (d) => { asked = d.message(); d.accept(); });
    await s.page.click('[data-tab="staff"]');
    assert.equal(asked, '保存していない変更があります。破棄しますか?');
    await s.page.click('[data-tab="requests"]');
    await s.page.selectOption('#reqStaff', ids.A);
    assert.ok(!(await s.page.textContent('.reqDay[data-date="2026-11-05"]')).includes('休'));
  } finally { await s.close(); }
});

// ==================== Task 8: シフト表 ====================

const DAY = '2026-12-01'; // 火曜(営業日)
function seedGrid(ids, o) {
  o = o || {};
  return (call) => {
    call('saveShiftSettings', 'seed', Object.assign({}, SIMPLE_SETTINGS, {
      slots: [{ id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: ALL_WEEK, required: { '': o.required || 1 } }],
    }));
    (o.names || ['A', 'B', 'C']).forEach((n) => { ids[n] = call('saveStaffMember', 'seed', staffIn(n)).staff.id; });
    if (o.pair) {
      const st = call('getShiftBootstrap', 'seed', DAY, DAY).settings;
      call('saveShiftSettings', 'seed', Object.assign(st, { pairRules: [{ a: ids.A, b: ids.B, type: 'avoid' }] }));
    }
    (o.requests || []).forEach((r) => {
      call('saveRequests', 'seed', DAY, DAY, [Object.assign({ date: DAY, slotId: '', note: '' }, r, { staffId: ids[r.staff] })]);
    });
  };
}
async function openGrid(s) {
  await s.login();
  await openPeriod(s, DAY, DAY);
}
async function generate(s) {
  await s.page.click('#genBtn');
  await waitMsg(s, 'gridMsg', '作成しました');
}
const cellSel = '.cellPos[data-date="' + DAY + '"][data-slot="L"]';
const whoIds = (s) => s.page.$$eval(cellSel + ' .who', (els) => els.map((e) => e.dataset.staff).sort());

ui('自動作成 → 表に名前が並び、不足がなければ警告なし', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids) });
  try {
    await openGrid(s);
    assert.ok((await s.page.textContent(cellSel)).includes('不足'));
    await generate(s);
    assert.equal((await whoIds(s)).length, 1);
    assert.equal(await s.page.locator('#warnList .warnItem').count(), 0);
    assert.equal(await s.page.locator('#summary tr.staffRow').count(), 3);
    assert.deepEqual(s.errors(), []);
  } finally { await s.close(); }
});

ui('avoid の2人しかいない枠は一緒に入って警告が出る', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids, { names: ['A', 'B'], required: 2, pair: true }) });
  try {
    await openGrid(s);
    await generate(s);
    assert.deepEqual(await whoIds(s), [ids.A, ids.B].sort());
    assert.ok((await s.page.textContent('#warnList')).includes('12/1 ランチ: AさんとBさんが同じ時間(できれば避けたい組み合わせ)'));
  } finally { await s.close(); }
});

ui('手で入れた人は固定になり、再作成でも残る', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids) });
  try {
    await openGrid(s);
    await s.page.click(cellSel);
    await s.page.click('#picker .addCand[data-staff="' + ids.C + '"]');
    assert.equal(await s.page.locator(cellSel + ' .who.pinned[data-staff="' + ids.C + '"]').count(), 1);
    await generate(s);
    assert.deepEqual(await whoIds(s), [ids.C]);
  } finally { await s.close(); }
});

ui('外した人は再作成で戻らない', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids, { names: ['A', 'B'] }) });
  try {
    await openGrid(s);
    await generate(s);
    const [first] = await whoIds(s);
    await s.page.click(cellSel);
    await s.page.click('#picker .removeWho[data-staff="' + first + '"]');
    await generate(s);
    const now = await whoIds(s);
    assert.equal(now.length, 1);
    assert.notEqual(now[0], first);
  } finally { await s.close(); }
});

ui('出られない人も理由付きで選べ、選ぶと赤い警告', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids, { requests: [{ staff: 'A', kind: 'unavailable' }] }) });
  try {
    await openGrid(s);
    await s.page.click(cellSel);
    const cand = s.page.locator('#picker .addCand[data-staff="' + ids.A + '"]');
    assert.ok((await cand.getAttribute('class')).includes('blocked'));
    assert.ok((await cand.textContent()).includes('出られない日'));
    await cand.click();
    assert.ok((await s.page.textContent('#warnList .warnItem.error')).includes('Aさんは出られない日'));
    assert.equal(await s.page.locator(cellSel + '.err').count(), 1);
  } finally { await s.close(); }
});

ui('時間が重なる別の枠に入っている人は選べない', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: (call) => {
    call('saveShiftSettings', 'seed', Object.assign({}, SIMPLE_SETTINGS, { slots: [
      { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: ALL_WEEK, required: { '': 1 } },
      { id: 'T', name: '通し', start: '10:00', end: '22:00', weekdays: ALL_WEEK, required: { '': 1 } }] }));
    ids.A = call('saveStaffMember', 'seed', staffIn('A')).staff.id;
  } });
  try {
    await openGrid(s);
    await s.page.click(cellSel);
    await s.page.click('#picker .addCand[data-staff="' + ids.A + '"]');
    await s.page.click('.cellPos[data-date="' + DAY + '"][data-slot="T"]');
    assert.equal(await s.page.locator('#picker .addCand[data-staff="' + ids.A + '"]').isDisabled(), true);
  } finally { await s.close(); }
});

ui('日別枠を消すとその日の枠が表から消え、保存される', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids) });
  try {
    await openGrid(s);
    await s.page.click('th.dayHead[data-date="' + DAY + '"]');
    await s.page.uncheck('#dayPanel input.daySlot[value="L"]');
    assert.equal(await s.page.locator(cellSel).count(), 0);
    await s.page.click('#gridSaveBtn');
    await waitMsg(s, 'gridMsg', '保存しました');
    assert.deepEqual(s.call('getShiftBootstrap', 'seed', DAY, DAY).dayOverrides, [{ date: DAY, slotId: 'L', state: 'off' }]);
  } finally { await s.close(); }
});

ui('保存 → 再読み込みで同じ表', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids, { required: 2 }) });
  try {
    await openGrid(s);
    await generate(s);
    const before = await whoIds(s);
    await s.page.click('#gridSaveBtn');
    await waitMsg(s, 'gridMsg', '保存しました');
    await s.page.click('#periodLoadBtn');
    await s.page.waitForFunction(() => document.getElementById('periodMsg').textContent === '');
    assert.deepEqual(await whoIds(s), before);
  } finally { await s.close(); }
});

ui('印刷用CSSでボタンが隠れる', async () => {
  const ids = {};
  const s = await openShiftPage({ seed: seedGrid(ids) });
  try {
    await openGrid(s);
    await s.page.emulateMedia({ media: 'print' });
    assert.equal(await s.page.isVisible('#genBtn'), false);
    assert.equal(await s.page.isVisible('.tabs'), false);
    assert.equal(await s.page.isVisible('#grid'), true);
  } finally { await s.close(); }
});
