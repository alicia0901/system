#!/usr/bin/env node
/**
 * 他店舗用に予約システムを複製するジェネレーター。
 *
 * 使い方:
 *   node setup/create-store.js <store-config.json>            … コード生成のみ(手動でclasp操作)
 *   node setup/create-store.js <store-config.json> --deploy    … 生成 + Google側への作成/push/デプロイまで自動実行
 *
 * store-config.json の書式は setup/store-config.example.json を参照。
 *
 * このスクリプトは gas/Code.gs を「共通エンジン」とみなし、
 * ファイル内の `const CONFIG = { ... };` ブロックだけを
 * store-config.json の内容で置き換えた版を stores/<storeSlug>/gas/ に生成します。
 * エンジン本体(予約ロジック・空席計算・管理画面)は複製せず1箇所のまま保つので、
 * バグ修正や機能追加は gas/Code.gs 側にだけ行えば済みます。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function jsonStr(v) {
  return JSON.stringify(v);
}

// ---- 引数・設定読み込み ----
const configPath = process.argv[2];
if (!configPath) {
  fail('使い方: node setup/create-store.js <store-config.json> [--deploy]');
}
const doDeploy = process.argv.includes('--deploy');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  fail(`${configPath} の読み込みに失敗しました: ${e.message}`);
}

['storeSlug', 'storeName', 'courses', 'adminPassword'].forEach((key) => {
  if (!cfg[key]) fail(`${configPath} に "${key}" がありません`);
});
if (!/^[a-zA-Z0-9_-]+$/.test(cfg.storeSlug)) {
  fail('storeSlug は半角英数字・ハイフン・アンダースコアのみで指定してください');
}
if (!Array.isArray(cfg.courses) || cfg.courses.length === 0) {
  fail('courses は1件以上の配列で指定してください');
}
if (cfg.adminPassword === 'changeme') {
  console.warn('⚠ adminPassword が初期値の "changeme" のままです。必ず変更してください。');
}

// ---- パス ----
const repoRoot = path.resolve(__dirname, '..');
const engineDir = path.join(repoRoot, 'gas');
const outDir = path.join(repoRoot, 'stores', cfg.storeSlug, 'gas');

fs.mkdirSync(outDir, { recursive: true });

// ---- Code.gs: CONFIG ブロックを差し替え ----
const engineCode = fs.readFileSync(path.join(engineDir, 'Code.gs'), 'utf8');

const coursesLiteral = JSON.stringify(cfg.courses, null, 2).replace(/\n/g, '\n  ');

// RATE_LIMIT はネストしたオブジェクトなので、指定されたフィールドだけ既定値から上書きする
const rateLimitCfg = cfg.rateLimit || {};
const rateLimit = {
  MIN_INTERVAL_SEC_PER_PHONE: Number.isFinite(rateLimitCfg.minIntervalSecPerPhone) ? rateLimitCfg.minIntervalSecPerPhone : 30,
  MAX_SUBMISSIONS_PER_WINDOW: Number.isFinite(rateLimitCfg.maxSubmissionsPerWindow) ? rateLimitCfg.maxSubmissionsPerWindow : 20,
  WINDOW_SEC: Number.isFinite(rateLimitCfg.windowSec) ? rateLimitCfg.windowSec : 60,
};
const rateLimitLiteral = JSON.stringify(rateLimit, null, 2).replace(/\n/g, '\n  ');

const configBlock = `const CONFIG = {
  STORE_NAME: ${jsonStr(cfg.storeName)},
  CALENDAR_ID: ${jsonStr(cfg.calendarId || 'primary')},
  SHEET_NAME: ${jsonStr(cfg.sheetName || '予約一覧')},
  TIMEZONE: ${jsonStr(cfg.timezone || 'Asia/Tokyo')},
  BUSINESS_START_HOUR: ${Number.isFinite(cfg.businessStartHour) ? cfg.businessStartHour : 11},
  BUSINESS_END_HOUR: ${Number.isFinite(cfg.businessEndHour) ? cfg.businessEndHour : 22},
  CLOSED_WEEKDAYS: ${JSON.stringify(cfg.closedWeekdays || [1])},
  BUSINESS_PERIODS: ${JSON.stringify(cfg.businessPeriods || [])},
  SLOT_MINUTES: ${Number.isFinite(cfg.slotMinutes) ? cfg.slotMinutes : 30},
  MAX_DAYS_AHEAD: ${Number.isFinite(cfg.maxDaysAhead) ? cfg.maxDaysAhead : 60},
  SEATS_TOTAL: ${Number.isFinite(cfg.seatsTotal) ? cfg.seatsTotal : 20},
  PARTY_SIZE_MAX: ${Number.isFinite(cfg.partySizeMax) ? cfg.partySizeMax : 8},
  COURSES: ${coursesLiteral},
  NOTIFY_EMAIL: ${jsonStr(cfg.notifyEmail || '')},
  ADMIN_PASSWORD: ${jsonStr(cfg.adminPassword)},
  WAITLIST_ENABLED: ${cfg.waitlistEnabled === false ? 'false' : 'true'},
  LIFF_ID: ${jsonStr(cfg.liffId || '')},
  RATE_LIMIT: ${rateLimitLiteral},
};`;

const configBlockPattern = /const CONFIG = \{[\s\S]*?\n\};/;
if (!configBlockPattern.test(engineCode)) {
  fail('gas/Code.gs 内に CONFIG ブロックが見つかりませんでした(エンジンの構造が変わった可能性があります)');
}
const newCode = engineCode.replace(configBlockPattern, configBlock);

fs.writeFileSync(path.join(outDir, 'Code.gs'), newCode);
['index.html', 'admin.html', 'appsscript.json', '.claspignore'].forEach((f) => {
  fs.copyFileSync(path.join(engineDir, f), path.join(outDir, f));
});

console.log(`✓ ${path.relative(repoRoot, outDir)} に「${cfg.storeName}」用のコードを生成しました`);

if (!doDeploy) {
  console.log('\n次のいずれかで Google 側に反映してください:');
  console.log(`  1) 自動実行:  node setup/create-store.js ${configPath} --deploy`);
  console.log('  2) 手動実行:  README.md の「他店舗への展開」を参照');
  process.exit(0);
}

// ---- ここから Google 側の自動セットアップ ----
// Windows では clasp が .cmd シムで、shell:true 経由だと引数(日本語・空白入り)が
// エスケープされず壊れる(Node は shell:true 時に引数をエスケープしない)。
// .cmd の中身が実際に呼んでいる node の JS エントリポイントを直接 `node <entry> ...`
// で叩くことで、shell を介さずに引数をそのまま安全に渡す。
function resolveClaspInvocation() {
  if (process.platform !== 'win32') return { command: 'clasp', prefixArgs: [] };
  try {
    const whereOut = execFileSync('where', ['clasp'], { encoding: 'utf8' });
    const cmdPath = whereOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).find((p) => p.toLowerCase().endsWith('.cmd'));
    if (!cmdPath) return { command: 'clasp', prefixArgs: [] };
    const shim = fs.readFileSync(cmdPath, 'utf8');
    // shim 内の "%dp0%\node_modules\...\index.js" 相当を実パスに解決する
    const m = shim.match(/"%dp0%\\(node_modules\\.+?\.js)"/);
    if (!m) return { command: 'clasp', prefixArgs: [] };
    const entry = path.join(path.dirname(cmdPath), m[1]);
    if (!fs.existsSync(entry)) return { command: 'clasp', prefixArgs: [] };
    return { command: 'node', prefixArgs: [entry] };
  } catch (e) {
    return { command: 'clasp', prefixArgs: [] };
  }
}
const CLASP_INVOCATION = resolveClaspInvocation();

function run(args, opts) {
  return execFileSync(
    CLASP_INVOCATION.command,
    CLASP_INVOCATION.prefixArgs.concat(args),
    Object.assign({ cwd: outDir, encoding: 'utf8' }, opts || {})
  );
}

console.log('\nGoogle スプレッドシート・Apps Script プロジェクトを作成しています...');
let createOut;
try {
  createOut = run(['create-script', '--type', 'sheets', '--title', `${cfg.storeName} 予約システム`]);
} catch (e) {
  fail('clasp create-script に失敗しました。clasp login 済みか、Apps Script APIが有効か確認してください。\n' + (e.stdout || e.message));
}
console.log(createOut.trim());

// clasp create-script は rootDir: "" で書き出すので "." に直す
const claspJsonPath = path.join(outDir, '.clasp.json');
const claspJson = JSON.parse(fs.readFileSync(claspJsonPath, 'utf8'));
claspJson.rootDir = '.';
fs.writeFileSync(claspJsonPath, JSON.stringify(claspJson, null, 2) + '\n');

const sheetIdMatch = createOut.match(/id=([\w-]+)/);
const scriptIdMatch = createOut.match(/\/d\/([\w-]+)\/edit/);

console.log('コードを push しています...');
run(['push', '-f'], { stdio: 'inherit' });

console.log('Web アプリとしてデプロイしています...');
const deployOut = run(['deploy', '--description', '初回デプロイ']);
console.log(deployOut.trim());
const deployIdMatch = deployOut.match(/Deployed (\S+)/);

console.log('\n==== 完了 ====');
if (sheetIdMatch) console.log(`スプレッドシート     : https://drive.google.com/open?id=${sheetIdMatch[1]}`);
if (scriptIdMatch) console.log(`Apps Script エディタ : https://script.google.com/d/${scriptIdMatch[1]}/edit`);
if (deployIdMatch) {
  console.log(`予約フォームURL      : https://script.google.com/macros/s/${deployIdMatch[1]}/exec`);
  console.log(`管理画面URL          : https://script.google.com/macros/s/${deployIdMatch[1]}/exec?page=admin`);
}
console.log('\n※ 上記のURLを、このセットアップに使ったGoogleアカウントで一度開き、');
console.log('   「REVIEW PERMISSIONS」から権限の許可を行ってください(初回のみ必要な手順です)。');
console.log('※ store-config.json の adminPassword を初期値から変更していることを確認してください。');
