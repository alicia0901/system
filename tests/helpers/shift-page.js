'use strict';
// shift.html をブラウザ(Playwright)で開き、google.script.run を Node 上の Shift.gs(GAS モック込み)につなぐ。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGas, GAS_DIR } = require('./load-gas');
const { createGasMock } = require('./gas-mock');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { playwright = null; }

const PAGE_URL = 'https://shift.test/';
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// google.script.run のスタブ(ブラウザ側で実行される)
const RUN_STUB = `
  (function () {
    function runner(ok, ng) {
      return new Proxy({}, {
        get: function (_, name) {
          if (name === 'withSuccessHandler') return function (fn) { return runner(fn, ng); };
          if (name === 'withFailureHandler') return function (fn) { return runner(ok, fn); };
          return function () {
            var args = Array.prototype.slice.call(arguments);
            window.__callServer(String(name), JSON.stringify(args)).then(function (res) {
              if (ok) ok(JSON.parse(res));
            }, function (err) { if (ng) ng(err); });
          };
        },
      });
    }
    window.google = { script: { run: runner(null, null) } };
  })();
`;

function renderShiftHtml(ctx) {
  const html = fs.readFileSync(path.join(GAS_DIR, 'shift.html'), 'utf8');
  const storeName = vm.runInContext('CONFIG.STORE_NAME', ctx);
  return html
    .split('<?= storeName ?>').join(storeName)
    .split('<?= adminUrl ?>').join('https://script.example/exec?page=admin')
    .split('<?!= shiftCoreSource ?>').join(vm.runInContext('shiftCoreFactory.toString()', ctx));
}

/**
 * @param {{seed?: function(call, mock): void, viewport?: {width:number,height:number}}} [opts]
 */
async function openShiftPage(opts) {
  opts = opts || {};
  const mock = createGasMock();
  const ctx = loadGas(['Code.gs', 'ShiftCore.gs', 'Shift.gs'], mock.globals);
  const call = (name, ...args) => plain(vm.runInContext(name, ctx)(...args));
  mock.loginToken('seed');
  if (opts.seed) opts.seed(call, mock);

  const html = renderShiftHtml(ctx); // ブラウザ起動前に読む(失敗時にブラウザを残さない)
  const browser = await playwright.chromium.launch();

  /** ページに google.script.run のつなぎ込みをして shift.html を開く(同じサーバ状態を共有する) */
  async function attach(page) {
    page.setDefaultTimeout(5000);
    page.on('pageerror', (err) => { errors.push(String(err)); });
    page.on('dialog', (d) => d.accept());
    await page.exposeFunction('__callServer', (name, argsJson) => JSON.stringify(call(name, ...JSON.parse(argsJson))));
    await page.addInitScript(RUN_STUB);
    await page.route(PAGE_URL, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto(PAGE_URL);
    return page;
  }
  const errors = [];
  const page = await attach(await browser.newPage(Object.assign(
    { viewport: opts.viewport || { width: 1280, height: 800 } }, opts.pageOptions || {})));

  async function login() {
    await page.fill('#password', 'changeme');
    await page.click('#loginBtn');
    await page.waitForSelector('#appView', { state: 'visible' });
  }
  async function close() { await browser.close(); }
  return { browser, page, mock, call, login, close, attach, errors: () => errors };
}

module.exports = { openShiftPage, renderShiftHtml, hasPlaywright: !!playwright };
