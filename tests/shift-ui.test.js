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
