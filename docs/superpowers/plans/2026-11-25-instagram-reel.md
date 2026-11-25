# インスタ用 予約システム紹介リール Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飲食店オーナー向けの約27秒・縦型の紹介リール MP4 を、リポジトリ内のスクリプトで再現可能に書き出す。

**Architecture:** 実物の `gas/index.html`・`gas/admin.html` を Node 側でテンプレート展開し、`google.script.run` をダミーデータのスタブに差し替えて Playwright で操作・スクショする(画面素材)。リール本体は1枚の `reel.html` で、全シーンの見た目を `window.seek(t)` で時刻 t の状態に決定的に描く。Playwright で 30fps 分 `seek`→スクショして連番 PNG にし、ffmpeg で MP4 にする。

**Tech Stack:** Node.js(組み込みの `node:test`)、Playwright(プリインストール済み Chromium、`require('playwright')`)、ffmpeg/ffprobe、HTML/SVG/CSS。npm 依存は追加しない。

**Spec:** `docs/superpowers/specs/2026-11-25-instagram-reel-design.md`

## Global Constraints

- 出力: 1080×1920、30fps、H.264 `yuv420p`、**音声トラックなし**、長さ 27.0 秒(810 フレーム)。
- **料金に触れない**: シーンの文言に「円」「料金」「月額」「無料」「費用」「価格」を含めない。
- **実写を使わない**: 画像は描き起こし(SVG/CSS/canvas)と、実物画面のスクショのみ。外部画像を読み込まない。
- 店名は「サンプル食堂」。お客様名は架空(例: 山田様・佐藤様・鈴木様・高橋様・田中様)。
- 見た目: 手描きイラスト風。線のゆらぎ(`feTurbulence` の seed)を **4フレームごと**に 1→2→3 で切り替える。紙のざらつきを全面に乗せる。
- 字幕: 白文字 + 黒フチ(`-webkit-text-stroke` + `paint-order: stroke fill`)、フォント Noto Sans JP 900。シーンごとに位置・傾き(-3°〜+3°)・大きさを少しずつ変える。
- 字幕の安全領域(インスタのUIに隠れない範囲): x 60〜920、y 220〜1500(1080×1920 座標)。
- `gas/` 配下は変更しない(CLAUDE.md の構造を崩さない)。
- すべての動きは `seek(t)` から計算する。CSS の `animation`/`transition` や `requestAnimationFrame`、`Math.random()` を `reel.html` 内で使わない(フレームが毎回同じになるように)。
- 生成物(`promo/reel/build/`)はコミットしない。

## Review Focus

1. **Webフォントが読み込めない**(ネットワーク不調)→ 黙って別フォントで書き出されると見た目が崩れる。読み込めなければ書き出しを失敗させる(Task 3 のテスト `fonts loaded or abort`)。
2. **実物画面の日付が実行日に依存**する(フォームは「今日」基準で日付・空席を出す)→ いつ実行しても同じ 2026-11-28(金)の画面になること。Playwright の `page.clock.setFixedTime` で固定(Task 2 のテスト)。
3. **字幕がインスタのUIに隠れる/はみ出す** → 表示中の全字幕が安全領域内に収まること(Task 6 のテスト `captions stay in safe zone`)。
4. **フレームが非決定的**(実時間アニメや乱数)→ 同じ t を2回描いたら同じ PNG になること(Task 3 のテスト)。
5. **長さ・フレーム数のずれ**(端数で 26.97 秒や 811 フレームになる)→ ffprobe で 810 フレーム・音声なしを確認(Task 6)。

---

## File Structure

```
promo/reel/
├── README.md                 … 書き出し手順(字幕を直して再書き出しする方法)
├── build.sh                  … 一括: 画面撮影 → フレーム書き出し → MP4
├── stub/
│   ├── render-template.js    … GAS テンプレート(<? ?>)を Node で展開
│   ├── gas-stub.js           … ブラウザ用 google.script.run スタブ(DEMO_DATA を返す)
│   └── demo-data.js          … ダミーデータ(サンプル食堂・2026-11-28 の予約など)
├── capture-screens.js        … 実物画面を操作して build/screens/*.png と screens.json を作る
├── reel.html                 … リール本体(1080×1920、window.seek / REEL_DURATION)
├── lib/
│   ├── reel-core.js          … 純粋関数: タイムライン、ゆらぎ seed、出現イージング、安全領域
│   └── draw.js               … 共通部品: 字幕要素、手描きスマホ枠、紙のざらつき、タップ表示
├── scenes/
│   ├── s1-phone.js … s7-dm.js … 各シーン(mount / seek)
├── render-frames.js          … reel.html を seek→スクショ(全フレーム or --at 指定)
├── test/                     … node:test のテスト
└── build/                    … 生成物(.gitignore)
```

シーンの共通インターフェース(Task 3 で定義、Task 4〜6 で実装):

```js
// scenes/sN-*.js は window.REEL_SCENES.push({...}) で登録する(クラシックscript、bundlerなし)
{
  id: 's1',                 // 's1'..'s7'
  duration: 2.5,            // 秒
  mount(root, ctx),         // root: 1080×1920 の div。ctx: { screens } (screens.json の中身)
  seek(localT, ctx),        // 0 <= localT < duration の状態を描く
  captions: ['…'],          // このシーンで出る字幕の全文(禁止語テスト用)
}
```

---

### Task 1: GAS テンプレート展開とスタブ

**Files:**
- Create: `promo/reel/stub/render-template.js`, `promo/reel/stub/gas-stub.js`, `promo/reel/stub/demo-data.js`
- Test: `promo/reel/test/stub.test.js`

**Interfaces:**
- Produces:
  - `renderGasTemplate(html: string, scope: object) -> string`(Node、`module.exports`)。`<? code ?>` を JS 文、`<?= expr ?>` を HTML エスケープした出力、`<?!= expr ?>` をそのまま出力として評価する。`scope` のキーを変数として参照できる。
  - `demo-data.js`: ブラウザでは `window.DEMO_DATA`、Node では `module.exports` に同じオブジェクト。キー: `config`(`getConfig()` の戻り値と同じ形)、`daySchedule`(`{ [dateStr]: getDaySchedule の戻り値 }`)、`submitBooking`、`adminLogin`、`reservations`(`{ [dateStr]: getReservationsForAdmin の戻り値 }`)、`week`(`{ [fromDateStr]: getWeekForAdmin の戻り値 }`)、`stats`(`getStatsForAdmin` の戻り値)。形は `gas/Code.gs` の各関数の return と一致させる。
  - `gas-stub.js`: ブラウザで `window.google.script.run` を定義。`withSuccessHandler(fn)`/`withFailureHandler(fn)` はチェーン可能で、サーバ関数名の呼び出しで `DEMO_DATA` から引いた値を `setTimeout(…, 0)` で成功ハンドラに渡す。引数に日付があるものは日付キーで引き、無ければ空の成功レスポンスを返す。
- ダミーデータの値: `storeName: 'サンプル食堂'`、`seatsTotal: 20`、デモ日 `'2026-11-28'`。その日の予約: 18:00 山田様 4名 確定、18:30 佐藤様 2名 確定、19:00 鈴木様 6名 キャンセル待ち、19:30 高橋様 3名 確定(経路 LINE)、20:00 田中様 5名 確定。19:00〜20:00 は満席になる `bookedRanges` にする。

- [ ] **Step 1: Write the failing tests**

```js
// promo/reel/test/stub.test.js
const test = require('node:test'); const assert = require('node:assert');
const { renderGasTemplate } = require('../stub/render-template');
const DEMO = require('../stub/demo-data');

test('if-scriptlet omits block when falsy', () => {
  const out = renderGasTemplate('a<? if (CONFIG.LIFF_ID) { ?>X<? } ?>b', { CONFIG: { LIFF_ID: '' } });
  assert.strictEqual(out, 'ab');
});
test('raw print outputs JSON unescaped', () => {
  const out = renderGasTemplate('v=<?!= JSON.stringify(CONFIG.LIFF_ID || "") ?>;', { CONFIG: { LIFF_ID: '' } });
  assert.strictEqual(out, 'v="";');
});
test('escaped print escapes html', () => {
  assert.strictEqual(renderGasTemplate('<?= s ?>', { s: '<b>' }), '&lt;b&gt;');
});
test('real index.html renders with no scriptlets left', () => {
  const html = require('fs').readFileSync(__dirname + '/../../../gas/index.html', 'utf8');
  const out = renderGasTemplate(html, { CONFIG: { LIFF_ID: '' } });
  assert.ok(!out.includes('<?'));
});
test('demo data uses the demo store and date', () => {
  assert.strictEqual(DEMO.config.storeName, 'サンプル食堂');
  assert.strictEqual(DEMO.reservations['2026-11-28'].reservations.length, 5);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test promo/reel/test/`
Expected: FAIL(`Cannot find module '../stub/render-template'`)

- [ ] **Step 3: Implement the three files** to the Interfaces above. `renderGasTemplate` は `<?`/`?>` で分割して関数本体の文字列を組み立て、`new Function(...Object.keys(scope), body)` で評価する。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test promo/reel/test/`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add promo/reel/stub promo/reel/test/stub.test.js
git commit -m "リール用: GASテンプレート展開とgoogle.script.runスタブを追加"
```

---

### Task 2: 実物画面の撮影

**Files:**
- Create: `promo/reel/capture-screens.js`, `promo/reel/.gitignore`(`build/`)
- Test: `promo/reel/test/capture.test.js`

**Interfaces:**
- Consumes: Task 1 の `renderGasTemplate`、`gas-stub.js`、`demo-data.js`。
- Produces: `node promo/reel/capture-screens.js` → `promo/reel/build/screens/*.png` と `promo/reel/build/screens/screens.json`:
  ```json
  { "viewport": { "width": 390, "height": 844, "deviceScaleFactor": 2 },
    "shots": [ { "id": "form-1", "file": "form-1.png", "tap": { "x": 195, "y": 600 } | null, "fullHeight": 844 } ] }
  ```
  `tap` は次のショットへ進むためにタップした位置(CSS px、ビューポート基準)。`fullHeight` はフルページ撮影時の高さ(管理画面のスクロール演出用)。
- 撮るショット(id は固定): `form-1`(コース・人数)、`form-2`(日付 11/28 選択後の時間帯一覧、19:00〜20:00 が満席表示)、`form-3`(18:00 選択後の入力欄、お名前「山田 太郎」入力済み)、`form-4`(予約確定画面)、`admin-list`(11/28 の一覧、フルページ)、`admin-week`(週間ビュー)、`admin-stats`(今月の集計)。
- 手順: 展開済み HTML の `<head>` 先頭に `demo-data.js` → `gas-stub.js` を `<script>` で差し込み、`build/screens/_index.html`・`_admin.html` として書き出して `file://` で開く。`page.clock.setFixedTime(new Date('2026-11-25T10:00:00+09:00'))` で日付を固定。管理画面はパスワード欄に任意の文字列を入れてログイン(スタブの `adminLogin` は常に `{ success: true, token: 'demo' }`)。

- [ ] **Step 1: Write the failing test**

```js
// promo/reel/test/capture.test.js
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, '../build/screens');

test('captures all shots deterministically for the demo date', { timeout: 120000 }, () => {
  execFileSync('node', [path.join(__dirname, '../capture-screens.js')], { stdio: 'inherit' });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'screens.json'), 'utf8'));
  assert.deepStrictEqual(meta.shots.map(s => s.id),
    ['form-1', 'form-2', 'form-3', 'form-4', 'admin-list', 'admin-week', 'admin-stats']);
  for (const s of meta.shots) assert.ok(fs.statSync(path.join(dir, s.file)).size > 10000, s.id);
  const html = fs.readFileSync(path.join(dir, 'form-2.txt'), 'utf8'); // capture が各ショットの innerText も保存する
  assert.match(html, /11\/28|11月28日/);
  assert.match(html, /満席/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test promo/reel/test/capture.test.js`
Expected: FAIL(`Cannot find module …capture-screens.js`)

- [ ] **Step 3: Implement `capture-screens.js`** to the Interfaces above, also writing `<id>.txt` (= `document.body.innerText`) beside each PNG. Use selectors from `gas/index.html`/`gas/admin.html` (e.g. `#weekBtn`, `#statsBtn`); wait for the stub's handler to render before each screenshot.

- [ ] **Step 4: Run to verify it passes, then look at `form-2.png` and `admin-list.png` once**

Run: `node --test promo/reel/test/capture.test.js`
Expected: PASS。PNG に実物のフォーム/管理画面がダミーデータ入りで写っている。

- [ ] **Step 5: Commit**

```bash
git add promo/reel/capture-screens.js promo/reel/.gitignore promo/reel/test/capture.test.js
git commit -m "リール用: 実物の予約フォーム・管理画面をダミーデータで撮影するスクリプトを追加"
```

---

### Task 3: リールの土台(タイムライン・共通部品・1コマ書き出し)

**Files:**
- Create: `promo/reel/lib/reel-core.js`, `promo/reel/lib/draw.js`, `promo/reel/reel.html`, `promo/reel/render-frames.js`
- Test: `promo/reel/test/core.test.js`, `promo/reel/test/render.test.js`

**Interfaces:**
- Produces(`reel-core.js`、ブラウザでは `window.ReelCore`、Node では `module.exports`):
  - `FPS = 30`、`WIDTH = 1080`、`HEIGHT = 1920`、`SAFE = { left: 60, right: 920, top: 220, bottom: 1500 }`
  - `sceneAt(scenes: {id,duration}[], t: number) -> { index: number, localT: number }`(t がちょうど境界なら次のシーン。t >= 合計なら最後のシーンの終端直前)
  - `totalDuration(scenes) -> number`
  - `wobbleSeed(t: number) -> 1|2|3` = `Math.floor(Math.round(t * FPS) / 4) % 3 + 1`
  - `popIn(localT: number, start: number, dur = 0.18) -> number`(0→1、少しオーバーシュートする「ポン出し」。start 前は 0、start+dur 以降は 1)
- Produces(`draw.js`、`window.ReelDraw`):
  - `caption(root, { text, x, y, size, rotate }) -> HTMLElement`(白文字黒フチ、`\n` で改行、`data-caption` 属性付き。中心座標 x,y)
  - `handPhone(root, { x, y, scale }) -> { el, screen: HTMLElement }`(手が持つ手描きスマホ枠。`screen` にスクショ画像を入れる。390×844 比)
  - `paperGrain(root)`(全面の紙ざらつき、最前面、`pointer-events:none`)
  - `tapMark(parent, { x, y, progress })`(タップの波紋。progress 0→1)
  - `wobbleFilter(svg)`:`<filter id="wob">` を追加し、`setWobble(seed)` でその seed に切り替える関数を返す
- Produces(`reel.html`): 1080×1920 固定の `#stage`。読み込み順: Google Fonts(Noto Sans JP 900/700、Dela Gothic One)→ `lib/*.js` → `scenes/*.js`。`window.REEL_SCENES`(配列)、`window.REEL_DURATION`、`window.reelReady: Promise`(フォント読み込みと全シーンの `mount` 完了)、`window.seek(t)`(該当シーンだけ表示し `seek(localT)` を呼ぶ。全シーン共通で `setWobble(wobbleSeed(t))`)。`?screens=` クエリで `screens.json` のパスを受け取り、`fetch` できない `file://` 対策として `render-frames.js` が `window.REEL_SCREENS` を `addInitScript` で先に注入する。
- Produces(`render-frames.js`): `node render-frames.js --at 7.0 --out x.png`(1コマ)/ `node render-frames.js --all`(`build/frames/00000.png`〜`00809.png`)。`page.evaluate(() => window.reelReady)` の後、`document.fonts.check('900 40px "Noto Sans JP"')` が false なら **エラー終了**。テスト用に環境変数 `REEL_BLOCK_FONTS=1` のときは `page.route('**/fonts.{googleapis,gstatic}.com/**', r => r.abort())` でフォントを遮断する。`build/screens/screens.json` が無ければ `window.REEL_SCREENS = null` を注入する(Task 2 前でも Task 3 のシーンは描ける)。
- この Task では仮シーンとして `scenes/s0-placeholder.js`(duration 27、字幕1つ)を置き、Task 4 で削除する。

- [ ] **Step 1: Write the failing tests**

```js
// promo/reel/test/core.test.js
const test = require('node:test'); const assert = require('node:assert');
const C = require('../lib/reel-core');
const S = [{ id: 'a', duration: 2.5 }, { id: 'b', duration: 3.5 }];
test('sceneAt maps global time', () => {
  assert.deepStrictEqual(C.sceneAt(S, 0), { index: 0, localT: 0 });
  assert.deepStrictEqual(C.sceneAt(S, 2.5), { index: 1, localT: 0 });
  assert.strictEqual(C.sceneAt(S, 99).index, 1);
});
test('wobble seed changes every 4 frames', () => {
  assert.deepStrictEqual([0, 3, 4, 8, 12].map(f => C.wobbleSeed(f / 30)), [1, 1, 2, 3, 1]);
});
test('popIn bounds', () => {
  assert.strictEqual(C.popIn(0.9, 1), 0);
  assert.strictEqual(C.popIn(1.5, 1), 1);
});
test('no price words in any scene copy', () => {
  const fs = require('fs'), path = require('path'), dir = path.join(__dirname, '../scenes');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /円|料金|月額|無料|費用|価格/, f);
  }
});
```

```js
// promo/reel/test/render.test.js
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path');
const R = path.join(__dirname, '../render-frames.js'), out = path.join(__dirname, '../build/test');
test('same t renders identical png (deterministic)', { timeout: 120000 }, () => {
  fs.mkdirSync(out, { recursive: true });
  execFileSync('node', [R, '--at', '1.3', '--out', path.join(out, 'a.png')]);
  execFileSync('node', [R, '--at', '1.3', '--out', path.join(out, 'b.png')]);
  assert.ok(fs.readFileSync(path.join(out, 'a.png')).equals(fs.readFileSync(path.join(out, 'b.png'))));
});
test('fonts loaded or abort', { timeout: 60000 }, () => {
  assert.throws(() => execFileSync('node', [R, '--at', '0', '--out', path.join(out, 'c.png')],
    { env: { ...process.env, REEL_BLOCK_FONTS: '1' }, stdio: 'pipe' }));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test promo/reel/test/core.test.js promo/reel/test/render.test.js`
Expected: FAIL(モジュールが無い)

- [ ] **Step 3: Implement `reel-core.js`, `draw.js`, `reel.html`, `render-frames.js`, `scenes/s0-placeholder.js`** to the Interfaces above. 手描きの質感は storyboard の案A(`/tmp/claude-0/-home-user-system/a896eae6-d8d6-554b-a443-b6134ecfab20/scratchpad/reel-storyboard.html` の `#sampleA`)を 1080×1920 に拡大した見た目を基準にする。紙のざらつきは SVG `feTurbulence` の data URI(固定 seed)で作る。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test promo/reel/test/core.test.js promo/reel/test/render.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add promo/reel/lib promo/reel/reel.html promo/reel/render-frames.js promo/reel/scenes promo/reel/test/core.test.js promo/reel/test/render.test.js
git commit -m "リール用: タイムライン・手描き共通部品・フレーム書き出しの土台を追加"
```

---

### Task 4: シーン1〜3(イラストのシーン)

**Files:**
- Create: `promo/reel/scenes/s1-phone.js`, `s2-pains.js`, `s3-turn.js`
- Delete: `promo/reel/scenes/s0-placeholder.js`

**Interfaces:**
- Consumes: Task 3 のシーンインターフェース、`ReelDraw.caption`/`wobbleFilter`/`paperGrain`、`ReelCore.popIn`。
- 中身(秒はシーン内の localT):
  - **s1-phone**(2.5秒): 居酒屋カウンター(品書きの短冊「生ビール」「焼き鳥」「唐揚げ」「枝豆」、赤ちょうちん「酒」、湯気の立つ器)、店の電話が鳴って揺れる(揺れは `seek` から計算、4フレームごとに左右反転)、手描き文字「プルルル」。字幕 0.2秒から「営業中に\n電話が鳴りやまない…」。
  - **s2-pains**(3.5秒): 厨房(鍋・湯気・注文伝票が何枚も貼られた壁)。字幕を 0.3/1.3/2.3 秒に1行ずつポン出しで追加し、前の行は残す: 「ドタキャン・無断キャンセル」「満席なのに電話で断るのがつらい」「予約ノートの書き間違い」。各行の傾き・横位置は少しずつ変える。
  - **s3-turn**(2.0秒): 背景が紙っぽいレンガ色(`#b5502f` 系)にパッと変わる。手描きの電話に大きな×、または電話が静かになる絵。字幕「ぜんぶ自動に\nしませんか?」(大)、0.6秒から「Googleだけで動く予約システム」(小)。

- [ ] **Step 1: Write the failing check** — 追記: `promo/reel/test/render.test.js` に

```js
test('scenes 1-3 are in order with spec durations', { timeout: 60000 }, () => {
  const { chromium } = require('playwright');
  return chromium.launch().then(async b => {
    const p = await b.newPage(); await p.goto('file://' + path.join(__dirname, '../reel.html'));
    await p.evaluate(() => window.reelReady);
    const ids = await p.evaluate(() => window.REEL_SCENES.map(s => [s.id, s.duration]));
    assert.deepStrictEqual(ids.slice(0, 3), [['s1', 2.5], ['s2', 3.5], ['s3', 2.0]]);
    await b.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test promo/reel/test/render.test.js`
Expected: FAIL(先頭が `s0`)

- [ ] **Step 3: Implement the three scenes and delete the placeholder.**

- [ ] **Step 4: Run tests, then render and look at t = 1.0, 4.5, 7.5 once**

Run: `node --test promo/reel/test/ && for t in 1.0 4.5 7.5; do node promo/reel/render-frames.js --at $t --out promo/reel/build/check-$t.png; done`
Expected: PASS。3枚とも手描きの店の絵 + 白黒フチ字幕が読める。

- [ ] **Step 5: Commit**

```bash
git add -A promo/reel/scenes promo/reel/test/render.test.js
git commit -m "リール用: シーン1〜3(電話・悩み・転換)を追加"
```

---

### Task 5: シーン4〜6(実物画面のシーン)

**Files:**
- Create: `promo/reel/scenes/s4-line.js`, `s5-auto.js`, `s6-admin.js`

**Interfaces:**
- Consumes: Task 2 の `screens.json`(`ctx.screens`)と PNG(`build/screens/<file>` を相対パスで `<img>`)、Task 3 の `handPhone`/`tapMark`/`caption`。
- 中身:
  - **s4-line**(6.0秒): 手描きの手が持つスマホ。上部に手描きの「LINE」風トーク画面ヘッダー(緑系、実在ロゴは描かない)。`form-1`→`form-2`→`form-3`→`form-4` を 0/1.4/2.8/4.2 秒で切り替え、各切り替えの 0.3 秒前に直前ショットの `tap` 位置へ `tapMark`。4.8 秒からスマホ横に手描きの吹き出し「ご予約が確定しました\n11/28(金) 18:00 4名」。字幕「LINEからそのまま予約」(上部)、2.0秒から「満席の時間は選べない」(`form-2` 表示中)。
  - **s5-auto**(4.0秒): 手描きのスマホにメール通知カード2枚。1枚目(0.2秒)件名「[サンプル食堂] 明日のご予約のご案内 (2026-11-28 18:00)」、2枚目(2.0秒)件名「[サンプル食堂] 空席のお知らせ (2026-11-28 19:00)」(件名の形は `gas/Code.gs` の subject と同じ)。字幕「前日にリマインド自動送信」→ 2.0秒から「キャンセルが出たら\nキャンセル待ちに自動でお知らせ」。
  - **s6-admin**(5.0秒): `admin-list` を 0〜2.0秒でゆっくり下にスクロール(`fullHeight` を使い translateY)、2.2秒 `admin-week`、3.6秒 `admin-stats`。字幕「今日の予約がスマホでひと目で」→ 2.2秒から「電話予約も手入力で一緒に管理」。

- [ ] **Step 1: Write the failing check** — `render.test.js` の順序テストの期待値を `[['s1',2.5],['s2',3.5],['s3',2.0],['s4',6.0],['s5',4.0],['s6',5.0]]` と `slice(0, 6)` に更新。

- [ ] **Step 2: Run to verify it fails**

Run: `node --test promo/reel/test/render.test.js`
Expected: FAIL

- [ ] **Step 3: Implement the three scenes.** スクショ画像はゆらぎフィルタの外に置く(実画面は揺らさない)。

- [ ] **Step 4: Run tests, then render and look at t = 10.0, 15.0, 20.0 once**

Run: `node promo/reel/capture-screens.js && node --test promo/reel/test/ && for t in 10.0 15.0 20.0; do node promo/reel/render-frames.js --at $t --out promo/reel/build/check-$t.png; done`
Expected: PASS。実物の画面が手描きのスマホの中にくっきり写り、字幕が画面と重ならない。

- [ ] **Step 5: Commit**

```bash
git add promo/reel/scenes promo/reel/test/render.test.js
git commit -m "リール用: シーン4〜6(LINE予約・自動通知・管理画面)を追加"
```

---

### Task 6: シーン7と MP4 書き出し

**Files:**
- Create: `promo/reel/scenes/s7-dm.js`, `promo/reel/build.sh`, `promo/reel/README.md`
- Test: `promo/reel/test/build.test.js`

**Interfaces:**
- Consumes: Task 2〜5 すべて。
- 中身:
  - **s7-dm**(4.0秒): 夜の店先(のれん「サンプル食堂」、ちょうちん)。字幕「導入のご相談は\nDMで」(大、0.2秒)、1.2秒から「「予約」とDMで\nデモ画面をお送りします」(黄色 `#ffe08a` の文字 + 黒フチ)。最後の 1.0 秒は動きを止めて読みやすく(ゆらぎのみ)。
  - `build.sh`: `capture-screens.js` → `render-frames.js --all` → `ffmpeg -y -framerate 30 -i build/frames/%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -an -movflags +faststart build/reel.mp4`。どこかで失敗したら止まる(`set -euo pipefail`)。
  - `render-frames.js --all` は各フレームで、表示中の `[data-caption]` の bounding rect が `SAFE` 内かを確認し、外れたら時刻と文言を出してエラー終了する。
  - README: 前提(Node・ffmpeg・Playwright)、`bash promo/reel/build.sh` で `promo/reel/build/reel.mp4` ができること、字幕を直すには `scenes/*.js` の文言を変えて再実行すること、料金・実写・実在名を入れない決まり。

- [ ] **Step 1: Write the failing test**

```js
// promo/reel/test/build.test.js
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const path = require('path');
const mp4 = path.join(__dirname, '../build/reel.mp4');
test('build produces 1080x1920 30fps 810 frames, no audio', { timeout: 900000 }, () => {
  execFileSync('bash', [path.join(__dirname, '../build.sh')], { stdio: 'inherit' });
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', mp4]));
  const v = info.streams.filter(s => s.codec_type === 'video'), a = info.streams.filter(s => s.codec_type === 'audio');
  assert.strictEqual(v.length, 1); assert.strictEqual(a.length, 0);
  assert.strictEqual(v[0].width, 1080); assert.strictEqual(v[0].height, 1920);
  assert.strictEqual(v[0].r_frame_rate, '30/1'); assert.strictEqual(Number(v[0].nb_read_frames), 810);
  assert.strictEqual(v[0].pix_fmt, 'yuv420p');
});
```

`render.test.js` の順序テストを全7シーン(`s7` 4.0)と合計 27.0 秒の確認に更新し、次も追加:

```js
test('captions stay in safe zone', { timeout: 120000 }, () => {
  // render-frames.js --check-safe は全フレームを seek して安全領域だけ確認し、PNG は書かない
  execFileSync('node', [R, '--check-safe']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test promo/reel/test/`
Expected: FAIL(`build.sh` が無い、`s7` が無い)

- [ ] **Step 3: Implement `s7-dm.js`, `--check-safe` / safe-zone check in `render-frames.js`, `build.sh`, `README.md`.**

- [ ] **Step 4: Run all tests, then watch the MP4 once** (先頭・各シーン境界・最後を `ffmpeg -ss <t> -frames:v 1` で抜き出して確認)

Run: `node --test promo/reel/test/`
Expected: PASS。`promo/reel/build/reel.mp4` が 27 秒、字幕がすべて読める。

- [ ] **Step 5: Commit and push, then send the MP4 to the user**

```bash
git add promo/reel
git commit -m "リール用: シーン7とMP4書き出しスクリプトを追加"
git push -u origin claude/lucid-einstein-3bprr2
```

完成した `promo/reel/build/reel.mp4` をユーザーへファイルで送る(コミットはしない)。
