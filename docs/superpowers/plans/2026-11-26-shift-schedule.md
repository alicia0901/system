# シフト表(自動作成つき) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存の飲食店予約システム(GAS)に、店長が条件を入れるとシフト案を自動で作り、手直し・保存・印刷できる「シフト表」ページ(`?page=shift`)を追加する。

**Architecture:** GAS API に依存しない純粋ロジック(枠の展開・条件評価・自動作成・入力検証)を `gas/ShiftCore.gs` の `shiftCoreFactory()` に閉じ込め、サーバ(`gas/Shift.gs`)では `shiftCoreFactory()` を呼び、画面(`gas/shift.html`)にはテンプレートで `shiftCoreFactory.toString()` を埋め込んで同じコードで警告を計算する。保存は設定を `PropertiesService`、スタッフ・希望・割り当てを同じスプレッドシートの専用シートに置く。

**Tech Stack:** Google Apps Script(V8)、HtmlService テンプレート、素の HTML/CSS/JS。テストは Node 22 の `node:test` + `vm`(GAS API は自作モック)、画面テストは事前インストール済みの Playwright。

**Spec:** `docs/superpowers/specs/2026-11-26-shift-schedule-design.md`

## Global Constraints

- 外部サーバ・ビルド不要。npm 依存を追加しない(テストも Node 標準 + 事前インストール済み Playwright のみ)
- `gas/Code.gs` の `const CONFIG = { ... };` ブロックは変更しない。`Code.gs` の変更は `doGet` の振り分けのみ
- 予約関連のシート・関数・プロパティには一切手を入れない
- 休業判定は `getBusinessHoursForDate(dateStr)` 経由のみ。新しいコードで `CONFIG.CLOSED_WEEKDAYS` / `BUSINESS_START_HOUR` / `BUSINESS_END_HOUR` を参照しない
- 設定は `PropertiesService` キー `SHIFT_SETTINGS`(JSON)。スタッフ・希望・定期条件・割り当て・日別枠はシート `シフト_スタッフ` / `シフト_希望` / `シフト_定期条件` / `シフト_割り当て` / `シフト_日別枠`
- 認証は既存の `isValidAdminToken(token)`。失敗時は `{ success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' }`
- 入力エラーは日本語メッセージで `{ success: false, message }`
- 対象期間は最大31日。週は月曜始まり
- 自動作成は既定 20秒(`timeLimitMs: 20000`)で打ち切り、30人・31日・1日3枠で 30秒以内に返る
- 優先順位: 絶対条件 > 必要人数 > 一緒にしない > できれば休み > ベテラン > 公平さ(目安日数) > 出たい
- 画面の見た目は `gas/admin.html` の CSS 変数(`--main: #b5502f` ほか)・ボタン・アイコンに合わせる
- `stores/` 配下は編集しない

## Review Focus

1. **日をまたぐ枠(例: `17:00`〜`01:00`)**: 居酒屋ではよくある。終了 ≤ 開始なら翌日終了とみなし、勤務時間は8時間、同日の `22:00`〜`24:00` 枠とは「同じ時間」と判定されるべき(Task 1 にテスト)
2. **シートの日付セルが Date 型で返る**: スプレッドシートは `2026-11-05` のような文字列を日付に自動変換することがある。読み出しで `Date` が来ても `'YYYY-MM-DD'` として扱えるべき(Task 4 にテスト)
3. **設定から消した枠・担当、在籍を外したスタッフ**: 保存済みの割り当てや「一緒にしない」条件が、存在しない枠IDや在籍外スタッフを指していても、画面が壊れず、その行は無視されるべき(Task 2・Task 4 にテスト)
4. **条件を満たす人が誰もいない枠**: 全員が出られない日でも、自動作成は例外を出さずに「不足」の警告を返すべき(Task 3 にテスト)
5. **同時保存**: 2つのタブから同時に保存しても行が二重にならない。保存処理は `LockService.getScriptLock()` の中でシートを読み直して書くべき(Task 4 にテスト:モックのロックが呼ばれ、2回連続保存で行数が増えない)

---

## File Structure

| ファイル | 役割 |
|---|---|
| Create `gas/ShiftCore.gs` | `function shiftCoreFactory()` 1つだけを定義。中身は GAS API を使わない純粋関数群(日付・時間ユーティリティ、枠の展開、希望の解決、評価、自動作成、入力検証)を返す |
| Create `gas/Shift.gs` | シフト機能のサーバ API と、シート/プロパティの読み書き |
| Create `gas/shift.html` | シフト画面(ログイン、4タブ) |
| Modify `gas/Code.gs` (`doGet`) | `page === 'shift'` の振り分け、管理画面テンプレートへ `shiftUrl` を渡す |
| Modify `gas/admin.html` | 設定ボタン列に「シフト表」リンク |
| Modify `gas/.claspignore`, `setup/create-store.js` | `Shift.gs` / `ShiftCore.gs` / `shift.html` を許可・コピー |
| Create `tests/helpers/load-gas.js` | `vm` で `gas/*.gs` を1つのコンテキストに読み込む |
| Create `tests/helpers/gas-mock.js` | SpreadsheetApp / PropertiesService / CacheService / LockService / Utilities / ScriptApp / Logger のインメモリモック |
| Create `tests/helpers/shift-page.js` | Playwright で `shift.html` を描画し、`google.script.run` を Node 上の `Shift.gs` につなぐ |
| Create `tests/shift-core.test.js`, `tests/shift-solver.test.js`, `tests/shift-server.test.js`, `tests/shift-ui.test.js` | テスト |
| Modify `README.md`, `CLAUDE.md` | 説明追記 |

テスト実行コマンド(全タスク共通): `node --test tests/`

## 共通データ形(全タスクで使う)

```js
// settings (SHIFT_SETTINGS)
{ positions: ['ホール','キッチン'],            // [] なら担当なし。担当なしの店では position は '' を使う
  slots: [{ id:'sl_x', name:'ランチ', start:'10:00', end:'15:00', weekdays:[0,2,3,4,5,6],
            required:{ 'ホール':1, 'キッチン':1 } }],   // 担当なしは { '':3 }
  pairRules: [{ a:'st_1', b:'st_2', type:'avoid' }],
  minVeteranPerSlot: 1 }
// staff
{ id:'st_1', name:'田中', positions:['ホール'], veteran:true,
  targetDays:3|null, maxDays:5|null, maxHours:28|null, active:true, note:'' }
// request(その日だけ)     slotId '' = 終日
{ date:'2026-12-05', staffId:'st_1', slotId:'', kind:'unavailable'|'prefer_off'|'want', note:'' }
// recurring(毎週)
{ staffId:'st_1', weekdays:[1,2,3,4,5], slotId:'sl_lunch', kind:'unavailable'|'prefer_off', note:'' }
// business(日付 → getBusinessHoursForDate の戻り値)
{ '2026-12-05': { closed:false, note:'', periods:[{startMin:660,endMin:1320}] } }
// dayOverride
{ date:'2026-12-05', slotId:'sl_x', state:'off'|'on' }
// assignment   kind 'exclude' = 「この人をこの枠から外した」(position は '' で枠全体)
{ date:'2026-12-05', slotId:'sl_x', position:'ホール', staffId:'st_1', kind:'assign'|'exclude', pinned:true|false }
// cell(buildCells の出力)
{ key:'2026-12-05|sl_x|ホール', date, slotId, slotName, position, required, startMin, endMin }
// warning
{ level:'error'|'warn', code, date|null, slotId|null, position|null, staffIds:[...], message:'...' }
```

---

### Task 1: テスト基盤と ShiftCore の基礎(日付・時間・枠の展開)

**Files:**
- Create: `gas/ShiftCore.gs`
- Create: `tests/helpers/load-gas.js`
- Test: `tests/shift-core.test.js`

**Interfaces:**
- Produces:
  - `loadGas(files: string[], globals?: object) -> vm.Context`。`gas/` からの相対名を順に `vm.runInContext` する。トップレベルの `const`/`function` は同じコンテキストで共有される。値の取り出しは `vm.runInContext('name', ctx)`
  - `shiftCoreFactory() -> Core`。`Core` が以下を持つ:
    - `hhmmToMin(s: string) -> number`
    - `slotRange(slot) -> {startMin, endMin}`(終了 ≤ 開始なら `endMin += 1440`)
    - `listDates(from: string, to: string) -> string[]`(両端含む、`'YYYY-MM-DD'`)
    - `weekdayOf(date) -> 0..6`、`mondayOf(date) -> 'YYYY-MM-DD'`
    - `formatMD(date) -> '12/5'`
    - `buildCells(settings, dates, business, dayOverrides) -> Cell[]`

- [ ] **Step 1: テスト基盤とテストを書く**

`tests/helpers/load-gas.js` は `vm.createContext({ ...globals, console })` に各ファイルを読み込む。`tests/shift-core.test.js`:

```js
const core = () => vm.runInContext('shiftCoreFactory()', loadGas(['ShiftCore.gs']));
const S = (o) => Object.assign({ positions: [], pairRules: [], minVeteranPerSlot: 0 }, o);
const open = { closed: false, note: '', periods: [{ startMin: 660, endMin: 1320 }] };

test('slotRange: 日をまたぐ枠', () => {
  assert.deepEqual(core().slotRange({ start: '17:00', end: '01:00' }), { startMin: 1020, endMin: 1500 });
});
test('listDates/mondayOf', () => {
  const c = core();
  assert.deepEqual(c.listDates('2026-11-29', '2026-12-01'), ['2026-11-29', '2026-11-30', '2026-12-01']);
  assert.equal(c.mondayOf('2026-11-29'), '2026-11-23'); // 日曜 → 前の月曜
  assert.equal(c.mondayOf('2026-11-30'), '2026-11-30');
});
test('buildCells: 曜日・休業・担当ごとに展開', () => {
  const settings = S({ positions: ['ホール', 'キッチン'], slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { 'ホール': 1, 'キッチン': 2 } }] });
  const cells = core().buildCells(settings, ['2026-11-30', '2026-12-01'],
    { '2026-11-30': open, '2026-12-01': open }, []);
  // 11/30(月)だけ。必要人数0の担当はセルにしない
  assert.deepEqual(cells.map(c => c.key), ['2026-11-30|L|ホール', '2026-11-30|L|キッチン']);
  assert.equal(cells[1].required, 2);
});
test('buildCells: 休業日は枠なし', () => {
  const settings = S({ slots: [{ id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { '': 2 } }] });
  assert.equal(core().buildCells(settings, ['2026-11-30'], { '2026-11-30': { closed: true, note: '', periods: [] } }, []).length, 0);
});
test('buildCells: どの枠の曜日にも入っていない営業日は営業時間と重なる枠を全部出す', () => {
  const settings = S({ slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [2], required: { '': 1 } },
    { id: 'N', name: '深夜', start: '23:00', end: '02:00', weekdays: [2], required: { '': 1 } }] });
  const cells = core().buildCells(settings, ['2026-11-30'], { '2026-11-30': open }, []); // 月曜、営業 11:00-22:00
  assert.deepEqual(cells.map(c => c.slotId), ['L']);
});
test('buildCells: 日別枠 off/on', () => {
  const settings = S({ slots: [
    { id: 'L', name: 'ランチ', start: '10:00', end: '15:00', weekdays: [1], required: { '': 1 } },
    { id: 'D', name: 'ディナー', start: '17:00', end: '22:00', weekdays: [2], required: { '': 1 } }] });
  const cells = core().buildCells(settings, ['2026-11-30'], { '2026-11-30': open },
    [{ date: '2026-11-30', slotId: 'L', state: 'off' }, { date: '2026-11-30', slotId: 'D', state: 'on' }]);
  assert.deepEqual(cells.map(c => c.slotId), ['D']);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test tests/`
Expected: FAIL(`shiftCoreFactory is not defined` / ファイルなし)

- [ ] **Step 3: `gas/ShiftCore.gs` に `function shiftCoreFactory()` を実装**

ファイルの先頭に「このファイルは `shiftCoreFactory` 1つだけを定義し、中で GAS API・外部の変数を一切使わないこと(`toString()` で画面にも埋め込むため)」とコメントを書く。日付計算は UTC の `Date.UTC` で行い、タイムゾーンに依存させない。
`buildCells` の規則: `business[date].closed` なら枠なし。そうでなければ、`weekdays` にその曜日を含む枠を使う。含む枠が1つもなければ、営業時間帯のどれかと時間が重なる枠を使う(臨時営業日の扱い)。最後に `dayOverrides` の `off` で除き、`on` で足す。セルは日付順 → `settings.slots` の順 → `settings.positions` の順(担当なしなら `''`)で、`required > 0` のものだけ。

- [ ] **Step 4: 成功を確認**

Run: `node --test tests/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gas/ShiftCore.gs tests/
git commit -m "シフト: 共通ロジックの基礎(日付・枠の展開)とテスト基盤を追加"
```

---

### Task 2: 希望の解決と評価(警告・罰点・集計)

**Files:**
- Modify: `gas/ShiftCore.gs`
- Test: `tests/shift-core.test.js`

**Interfaces:**
- Consumes: Task 1 の `Core`
- Produces(`Core` に追加):
  - `buildProblem(input) -> Problem`。`input = { from, to, settings, staff, requests, recurring, business, dayOverrides, outsideAssignments }`。`Problem` = `input` + `cells: Cell[]`、`activeStaff: Staff[]`(在籍のみ)、`expectedDays: {[staffId]: number}`
  - `availability(problem, staffId, date, slotId) -> 'unavailable'|'prefer_off'|'want'|null`
  - `evaluate(problem, assignments) -> { warnings: Warning[], penalty: number[], summary: Summary[] }`
    - `penalty` は長さ7の配列 `[hard, shortage, avoid, preferOff, veteran, fairness, -want]`
    - `Summary = { staffId, name, days, hours, expectedDays, overMaxDays: boolean, overMaxHours: boolean }`
  - `comparePenalty(a, b) -> -1|0|1`(先頭から順に比べる)

**決めてあること:**
- `availability` の優先: その日の希望(枠指定 > 終日)が、毎週の定期条件(枠指定 > 終日)より強い。その日の希望が1つもなければ定期条件を見る
- 「同じ時間」= 同じ日で `slotRange` が1分でも重なる
- `hard` の数え方: 出られない枠への割り当て、担当外、週の上限日数・時間の超過(週ごと・人ごとに1件)。週の集計には `outsideAssignments` も含める
- `shortage`: 各セルの `required - 割り当て人数`(0未満は0)の合計
- `avoid`: 同じ時間に入っている `pairRules` の組の数(同じ日に複数枠で重なっても1日1組1件)
- `preferOff`: `prefer_off` の枠への割り当て件数
- `veteran`: 各「日・枠」でベテランの人数が `minVeteranPerSlot` に足りない分の合計(その日・枠に誰もいないときは数えない)
- `fairness`: `Σ (期間内の出勤日数 - expectedDays)^2`。`expectedDays = targetDays × 期間日数 / 7`。`targetDays` が空の人は、`(期間の必要延べ人日 − 目安ありの人の expectedDays の合計) / 目安なしの人数`(0未満は0)。必要延べ人日は「日ごとの `required` 合計」を全日分足した値
- `want`: `want` の枠に入った件数
- 在籍外・存在しないスタッフ、存在しないセルを指す割り当ては無視する(Review Focus 3)
- 警告文(`M/D` は `formatMD`、`○○` はスタッフ名):
  - shortage(`warn`): `12/5 ディナー: キッチンが1人不足`(担当なしは `スタッフが1人不足`)
  - avoid(`warn`): 同じ枠なら `12/5 ディナー: 高橋さんと伊藤さんが同じ時間(できれば避けたい組み合わせ)`、別の枠なら `12/5 ランチ/通し: …`
  - preferOff(`warn`): `12/5 ランチ: 田中さんは休み希望`
  - veteran(`warn`): `12/5 ランチ: ベテランが1人不足`
  - unavailable(`error`): `12/5 ランチ: 田中さんは出られない日`
  - position(`error`): `12/5 ランチ: 田中さんはキッチンの担当外`
  - maxDays(`error`): `田中さん: 12/1〜の週の出勤が6日(上限5日)`
  - maxHours(`error`): `田中さん: 12/1〜の週の勤務が30.5時間(上限28時間)`

- [ ] **Step 1: テストを書く**

共通の小さな問題 `fixture()` をテストファイル内に作る(担当なし、枠 `L` 10-15(ランチ)と `T` 10-23(通し)を月〜日、必要各1、スタッフ A/B/C、`pairRules: [{a:'A', b:'B', type:'avoid'}]`、期間 `2026-11-30`〜`2026-12-06`、全日営業)。

```js
test('availability: その日の希望が定期条件より強い', () => {
  const p = fixture({ recurring: [{ staffId: 'A', weekdays: [1], slotId: '', kind: 'unavailable' }],
                      requests: [{ date: '2026-11-30', staffId: 'A', slotId: 'L', kind: 'want' }] });
  assert.equal(c.availability(p, 'A', '2026-11-30', 'L'), 'want');
  assert.equal(c.availability(p, 'A', '2026-11-30', 'T'), 'unavailable');
  assert.equal(c.availability(p, 'A', '2026-12-01', 'L'), null);
});
test('evaluate: 重なる枠の2人は avoid 警告', () => {
  const p = fixture();
  const r = c.evaluate(p, [as('2026-11-30', 'L', 'A'), as('2026-11-30', 'T', 'B')]);
  assert.equal(r.penalty[2], 1);
  assert.ok(r.warnings.some(w => w.code === 'avoid' && w.message === '11/30 ランチ/通し: AさんとBさんが同じ時間(できれば避けたい組み合わせ)'));
});
test('evaluate: 日をまたぐ枠と同日の深夜枠は同じ時間', () => { /* 17:00-01:00 と 22:00-24:00 で avoid 1 */ });
test('evaluate: 不足', () => {
  const r = c.evaluate(fixture(), []);
  assert.equal(r.penalty[1], 14); // 7日 × 2枠
  assert.ok(r.warnings.some(w => w.message === '11/30 ランチ: スタッフが1人不足'));
});
test('evaluate: 週の上限は期間外の割り当ても数える', () => {
  const p = fixture({ from: '2026-12-05', to: '2026-12-06', staffOverrides: { A: { maxDays: 2 } },
    outsideAssignments: [as('2026-11-30', 'L', 'A'), as('2026-12-01', 'L', 'A')] });
  const r = c.evaluate(p, [as('2026-12-05', 'L', 'A')]);
  assert.equal(r.penalty[0], 1);
  assert.ok(r.warnings.some(w => w.message === 'Aさん: 11/30〜の週の出勤が3日(上限2日)'));
});
test('evaluate: 出られない・担当外は error', () => { /* level === 'error'、penalty[0] が件数 */ });
test('evaluate: 在籍外スタッフ・消えた枠への割り当ては無視', () => {
  const r = c.evaluate(fixture({ staffOverrides: { C: { active: false } } }),
    [as('2026-11-30', 'L', 'C'), as('2026-11-30', 'ZZ', 'A')]);
  assert.equal(r.penalty[1], 14);
  assert.equal(r.warnings.filter(w => w.level === 'error').length, 0);
});
test('evaluate: expectedDays と fairness', () => {
  const p = fixture({ staffOverrides: { A: { targetDays: 1 }, B: { targetDays: 4 } } });
  assert.equal(p.expectedDays.A, 1);
  assert.equal(p.expectedDays.B, 4);
  assert.equal(p.expectedDays.C, 9); // 必要延べ14 − 5
});
test('comparePenalty は先頭優先', () => {
  assert.equal(c.comparePenalty([0, 0, 1, 0, 0, 0, 0], [0, 0, 0, 99, 99, 99, 0]), 1);
});
```

(`as(date, slotId, staffId)` は `{date, slotId, position:'', staffId, kind:'assign', pinned:false}` を返すテスト内ヘルパー。中身を書き下していないテストは、コメントの条件で assert を書く。)

- [ ] **Step 2: 失敗を確認** — Run: `node --test tests/` / Expected: FAIL(`buildProblem is not a function`)
- [ ] **Step 3: `buildProblem` / `availability` / `evaluate` / `comparePenalty` を実装**
- [ ] **Step 4: 成功を確認** — Run: `node --test tests/` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -am "シフト: 希望の解決と条件評価(警告・罰点・集計)"`

---

### Task 3: 自動作成(solve)

**Files:**
- Modify: `gas/ShiftCore.gs`
- Test: `tests/shift-solver.test.js`

**Interfaces:**
- Consumes: Task 2 の `buildProblem` / `evaluate` / `availability` / `comparePenalty`
- Produces: `Core.solve(problem, current: Assignment[], options?: { timeLimitMs?: number, seed?: number, now?: () => number }) -> Assignment[]`
  - `current` のうち `pinned: true` のもの(`assign` / `exclude` 両方)をそのまま結果に含める。`pinned: false` は捨てる
  - 自分で作る割り当ては `pinned: false`、`kind: 'assign'`
  - 自分で作る割り当ては絶対条件を破らない: 出られない枠、担当外、同じ人の時間重複、週の上限日数・時間(`outsideAssignments` と固定分を含めて数える)、除外された「人 × 日 × 枠」
  - `seed` を渡したときは同じ結果になる(乱数は Core 内の小さな擬似乱数。`Math.random` を使わない)。既定 `timeLimitMs` は 20000、既定 `now` は `Date.now`

**アルゴリズム(仕様 6.5 の具体化):**
1. 固定分を置く
2. 貪欲法: 埋めるべき「席」(セル × 不足人数)を、候補者数の少ない順 → 不足の多いセル順に並べ、各席に「入れても絶対条件を破らない人」のうち、入れたあとの `penalty` が最も小さい人を入れる。候補がいなければ空けておく(Review Focus 4)
3. 局所探索: `now()` が期限に達するまで、ランダムに「固定でない割り当て1つを別の候補に替える」「固定でない割り当て2つの人を入れ替える」「空いている席に候補を入れる」を試し、`comparePenalty` で悪くならなければ採用する(同点も採用して停滞を避ける)。比較のたびに `evaluate` 全体を呼んでよいが、30人・31日・3枠で1回の `evaluate` が 5ms を超えるなら、日・週単位の差分計算に切り替える

- [ ] **Step 1: テストを書く**

`tests/shift-solver.test.js`。すべて `seed: 1`、時間制限は性能テスト以外 `timeLimitMs: 300`。

```js
test('出られない人は入らない(終日・枠単位・定期)', () => { /* 3種類それぞれで、該当の 日×枠 に A がいない */ });
test('人数が足りれば avoid の2人は同じ時間にならない', () => {
  // スタッフ4人、各枠1人、A-B avoid → evaluate(...).penalty[2] === 0 かつ penalty[1] === 0
});
test('人数が足りなければ枠を空けずに一緒に入れて警告', () => {
  // スタッフ A,B だけ、枠 L(必要2)1日 → 結果に A と B の両方、shortage 0、avoid 警告 1件
});
test('固定(割り当て・除外)は変わらない', () => {
  const pinnedA = { ...as('2026-11-30', 'L', 'C'), pinned: true };
  const exclB = { date: '2026-12-01', slotId: 'L', position: '', staffId: 'B', kind: 'exclude', pinned: true };
  const out = c.solve(p, [pinnedA, exclB, as('2026-12-02', 'L', 'A') /* 固定でない → 捨てる */], { seed: 1, timeLimitMs: 300 });
  assert.ok(out.some(x => sameAs(x, pinnedA)));
  assert.ok(out.some(x => sameAs(x, exclB)));
  assert.ok(!out.some(x => x.kind === 'assign' && x.date === '2026-12-01' && x.slotId === 'L' && x.staffId === 'B'));
});
test('週の目安日数に近づく', () => {
  // A targetDays 1、B targetDays 4、7日・1枠(必要1)・担当なし・上限なし → A の日数 ≤ 2、B の日数 ≥ 3
});
test('週の上限日数を超えない(期間外の割り当て込み)', () => { /* outsideAssignments で既に上限、期間内に入らない */ });
test('候補ゼロの枠でも例外を出さず不足になる', () => { /* 全員 unavailable → solve が返り、evaluate の shortage > 0 */ });
test('同じ seed なら同じ結果', () => { /* 2回の JSON.stringify が一致 */ });
test('性能: 30人・31日・1日3枠が時間内に終わる', { timeout: 40000 }, () => {
  // 担当2種、各枠 ホール2・キッチン1、全員 maxDays 5 → timeLimitMs 20000 で開始から 30000ms 未満、shortage 0
});
```

- [ ] **Step 2: 失敗を確認** — Run: `node --test tests/` / Expected: FAIL(`solve is not a function`)
- [ ] **Step 3: `solve` を実装**
- [ ] **Step 4: 成功を確認** — Run: `node --test tests/` / Expected: PASS(性能テストに約20秒かかる)
- [ ] **Step 5: Commit** — `git commit -am "シフト: 自動作成(貪欲法 + 局所探索)"`

---

### Task 4: サーバ API と保存(Shift.gs)

**Files:**
- Modify: `gas/ShiftCore.gs`(入力検証)
- Create: `gas/Shift.gs`
- Create: `tests/helpers/gas-mock.js`
- Test: `tests/shift-server.test.js`

**Interfaces:**
- Consumes: Task 1〜3 の `Core`。`Code.gs` の `isValidAdminToken`、`getBusinessHoursForDate`、`CONFIG.TIMEZONE`
- Produces:
  - `Core.validateSettings(raw) -> { ok: true, value } | { ok: false, message }`(`validateStaff`、`validateRequests(list, from, to, settings, staffIds)`、`validateRecurring(list, settings)` も同じ形)
  - `createGasMock(options?) -> { globals, sheets(name) -> any[][], props, lockCalls }`。`globals` を `loadGas` に渡す。`setValues` で書いた値は保持し、`options.dateCells: true` のとき `YYYY-MM-DD` 形式の文字列を `Date` に変えて保持する(Review Focus 2)
  - サーバ関数(すべて先頭で `isValidAdminToken`):
    - `getShiftBootstrap(token, from, to) -> { success, settings, staff, requests, recurring, business, dayOverrides, assignments, outsideAssignments, storeName }`。`staff` は在籍外も含む全員。`outsideAssignments` は `mondayOf(from)` 〜 `from` の前日、`to` の翌日 〜 その週の日曜の保存済み割り当て
    - `saveShiftSettings(token, settings) -> { success, settings }`(枠に `id` がなければ `'sl_' + Utilities.getUuid().slice(0, 8)` を振る)
    - `saveStaffMember(token, staff) -> { success, staff }`(`id` が空なら `'st_' + Utilities.getUuid().slice(0, 8)`)
    - `setStaffActive(token, staffId, active: boolean) -> { success }`
    - `saveRecurringRules(token, staffId, rules) -> { success, recurring }`(その人の定期条件を丸ごと置き換え)
    - `saveRequests(token, from, to, requests) -> { success }`(期間内を丸ごと置き換え)
    - `generateShift(token, from, to, currentAssignments) -> { success, assignments, warnings, summary, penalty }`(保存しない)
    - `saveShiftPeriod(token, from, to, assignments, dayOverrides) -> { success }`(期間内の割り当てと日別枠を丸ごと置き換え)

**決めてあること:**
- 期間チェック: `from`・`to` が `YYYY-MM-DD`、`from <= to`、31日以内。違反は `対象期間は31日以内で指定してください。` など
- 検証メッセージの例(既存の `updateCoursesAdmin` と同じ調子): `1件目の枠名を入力してください。`、`「ランチ」の時間は HH:MM の形式で入力してください。`、`「ランチ」の必要人数を1人以上にしてください。`、`同じスタッフ同士の組み合わせは設定できません。`、`スタッフの名前を入力してください。`
- シートの列(1行目はヘッダー。シートがなければ作成し、作成時に日付・ID列を書式 `@`(テキスト)にする):
  - `シフト_スタッフ`: `スタッフID, 名前, できる担当, ベテラン, 週の目安日数, 週の上限日数, 週の上限時間, 在籍, メモ`(担当はカンマ区切り、空の数値は空セル)
  - `シフト_希望`: `日付, スタッフID, 枠ID, 種類, メモ`(種類は `出られない` / `できれば休み` / `出たい` ⇔ `unavailable` / `prefer_off` / `want`)
  - `シフト_定期条件`: `スタッフID, 曜日, 枠ID, 種類, メモ`(曜日はカンマ区切りの数字)
  - `シフト_割り当て`: `日付, 枠ID, 担当, スタッフID, 種類, 固定, 更新日時`(種類は `割り当て` / `除外`)
  - `シフト_日別枠`: `日付, 枠ID, 状態`(`なし` / `あり` ⇔ `off` / `on`)
- 読み出しの日付セルは `Date` なら `Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd')`、文字列ならそのまま
- 置き換え保存は `LockService.getScriptLock().waitLock(10000)` の中で「全行読む → 対象外の行を残して新しい行を足す → `clearContents` → ヘッダーごと `setValues`」。使ってよいシート操作はモックが持つ `getDataRange().getValues()`、`getRange(r, c, nr, nc).setValues()/setNumberFormat()`、`clearContents()`、`setFrozenRows()`、`getLastRow()`、`getLastColumn()` のみ
- `business` は期間内の各日について `getBusinessHoursForDate(date)` を呼んで作る
- `generateShift` はサーバ側でもう一度 bootstrap 相当を読み直し、`Core.buildProblem` → `Core.solve(problem, currentAssignments, { timeLimitMs: 20000 })` → `Core.evaluate`

- [ ] **Step 1: モックとテストを書く**

`tests/shift-server.test.js` は `loadGas(['Code.gs', 'ShiftCore.gs', 'Shift.gs'], mock.globals)` を使う。トークンは `mock.globals.CacheService.getScriptCache().put('admin_t', '1')` で用意する。

```js
test('認証切れ', () => {
  assert.deepEqual(call('getShiftBootstrap', 'bad', '2026-12-01', '2026-12-07'),
    { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' });
});
test('期間が31日を超えるとエラー', () => {
  assert.equal(call('getShiftBootstrap', 't', '2026-12-01', '2027-01-02').success, false);
});
test('スタッフ追加 → bootstrap に出る(IDが振られる)', () => { /* id が /^st_/、在籍外も staff に含まれる */ });
test('設定の検証: 枠名が空ならエラー文', () => {
  const r = call('saveShiftSettings', 't', { positions: [], slots: [{ name: '', start: '10:00', end: '15:00', weekdays: [1], required: { '': 1 } }], pairRules: [], minVeteranPerSlot: 0 });
  assert.deepEqual(r, { success: false, message: '1件目の枠名を入力してください。' });
});
test('希望・定期条件・割り当て・日別枠の保存と読み戻し', () => { /* 保存した内容が bootstrap で同じ形で返る */ });
test('期間の置き換え保存は期間外の行を残す', () => { /* 11月分を保存 → 12月分を保存 → 11月分が残る */ });
test('2回続けて保存しても行が増えない & ロックを使う', () => {
  call('saveShiftPeriod', 't', from, to, list, []); call('saveShiftPeriod', 't', from, to, list, []);
  assert.equal(mock.sheets('シフト_割り当て').length, 1 + list.length);
  assert.ok(mock.lockCalls >= 2);
});
test('日付セルが Date で返っても読める', () => { /* createGasMock({ dateCells: true }) で保存 → bootstrap の date が 'YYYY-MM-DD' */ });
test('存在しない枠IDの割り当ては bootstrap で捨てる', () => { /* 枠を消した設定を保存後、旧枠の割り当てが assignments に出ない */ });
test('outsideAssignments は端の週の期間外だけ', () => { /* 11/30〜12/6 と 12/7〜 を保存、from=12/5 で 11/30〜12/4 だけ */ });
test('generateShift は保存しない', () => { /* 呼ぶ前後で シフト_割り当て の行数が同じ、assignments が返る */ });
```

- [ ] **Step 2: 失敗を確認** — Run: `node --test tests/` / Expected: FAIL(`getShiftBootstrap is not defined`)
- [ ] **Step 3: 検証関数を `ShiftCore.gs` に、API・シート入出力を `Shift.gs` に実装**。`Shift.gs` の先頭で `const ShiftCore = …` のようなトップレベル実行はせず、各関数の中で `shiftCoreFactory()` を呼ぶ(GAS はファイルの読み込み順が保証されないため)
- [ ] **Step 4: 成功を確認** — Run: `node --test tests/` / Expected: PASS
- [ ] **Step 5: Commit** — `git add gas/ tests/ && git commit -m "シフト: サーバAPIとシートへの保存"`

---

### Task 5: ページの入口・ログイン・配布設定

**Files:**
- Modify: `gas/Code.gs`(`doGet`)
- Modify: `gas/admin.html`(設定ボタン列)
- Create: `gas/shift.html`(枠組みのみ: ログイン、ヘッダー、4タブ、期間選択、共通の呼び出し関数)
- Modify: `gas/.claspignore`、`setup/create-store.js`(コピー対象)
- Create: `tests/helpers/shift-page.js`
- Test: `tests/shift-ui.test.js`

**Interfaces:**
- Consumes: Task 4 のサーバ関数、既存の `adminLogin(password) -> { success, token, storeName }`
- Produces:
  - `doGet` で `page === 'shift'` のとき `createTemplateFromFile('shift')` に `storeName = CONFIG.STORE_NAME`、`adminUrl = ScriptApp.getService().getUrl() + '?page=admin'`、`shiftCoreSource = shiftCoreFactory.toString()` を渡し、タイトル `(店名 )シフト表`。admin のテンプレートには `shiftUrl = ScriptApp.getService().getUrl() + '?page=shift'` を渡す
  - `shift.html` のスクリプトレットはこの3つだけ: `<?= storeName ?>`、`<?= adminUrl ?>`、`<?!= shiftCoreSource ?>`(`<script>var Core = (<?!= shiftCoreSource ?>)();</script>`)
  - 画面側の共通部品(後のタスクで使う): `callServer(name, ...args) -> Promise<result>`(`authError` ならログイン画面に戻す。`success: false` は呼び出し元へ返す)、`STATE = { from, to, data /* bootstrap の結果 */, assignments, dayOverrides, dirty }`、`reload() -> Promise`(bootstrap を呼び直して `STATE` を更新し、今のタブを描き直す)、`showTab(name)`(`'grid' | 'staff' | 'requests' | 'settings'`)、`showMsg(elId, text, isError)`
  - DOM id: `#loginView`、`#password`、`#loginBtn`、`#loginMsg`、`#appView`、タブボタン `[data-tab="grid|staff|requests|settings"]`、パネル `#tab-grid` / `#tab-staff` / `#tab-requests` / `#tab-settings`、期間 `#periodFrom` / `#periodTo` / `#periodLoadBtn`、`#backToAdmin`(`href` は `adminUrl`、`target="_top"`)
  - `tests/helpers/shift-page.js`: `openShiftPage({ seed?: (call) => void }) -> { page, browser, mock, call }`。`shift.html` を読み、3つのスクリプトレットを置き換えて `page.setContent` する。`google.script.run` は `withSuccessHandler` / `withFailureHandler` を持つ小さなスタブで、`page.exposeFunction('__callServer', …)` 経由で Node 側の `Shift.gs`(Task 4 のモック込み)を呼ぶ。`ADMIN_PASSWORD` は `'changeme'`(`CONFIG` の既定値)

**決めてあること:**
- 期間の初期値: 今日を含む月の翌月の1日〜末日(シフトは来月分を作ることが多いため)
- トークンは `sessionStorage` の `adminToken`(管理画面と同じキー)。あればログインを飛ばし、`authError` ならログイン画面
- 管理画面のボタン: 既存の `.settingsRow` 内、`weekBtn` の前に `<a id="shiftLink" class="..." target="_top" href="<?= shiftUrl ?>">` で「シフト表」(既存ボタンと同じ見た目)
- `.claspignore` に `!Shift.gs`、`!ShiftCore.gs`、`!shift.html` を追加。`create-store.js` のコピー対象に `Shift.gs`、`ShiftCore.gs`、`shift.html` を追加
- Playwright が `require` できない環境では、UI テストは `test.skip` にする

- [ ] **Step 1: UI テストを書く**

```js
test('ログイン → 4タブが出る、期間の初期値は翌月', async () => {
  // パスワード changeme → #appView が見える、[data-tab] が4つ、#periodFrom が翌月1日
});
test('パスワード違いはエラー', async () => { /* #loginMsg に 'パスワードが違います。' */ });
test('create-store.js がシフトのファイルもコピーする', () => {
  // 一時ディレクトリに store-config.example.json 相当を書き、node setup/create-store.js を実行
  // → stores/<slug>/gas/ に Shift.gs, ShiftCore.gs, shift.html がある(テスト後に stores/<slug> を消す)
});
test('doGet(page=shift) はシフト画面を返す', () => { /* モックの HtmlService で createTemplateFromFile が 'shift' で呼ばれる */ });
```

(`doGet` のテストのため、`gas-mock.js` に `HtmlService.createTemplateFromFile(name)` を足す。テンプレートに設定されたプロパティと `name` を記録し、`evaluate().setTitle().addMetaTag().setXFrameOptionsMode()` を連鎖できるようにする。)

- [ ] **Step 2: 失敗を確認** — Run: `node --test tests/` / Expected: FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 成功を確認** — Run: `node --test tests/` / Expected: PASS。あわせて `node -e "require('fs').readFileSync('gas/Code.gs','utf8').match(/const CONFIG = \{[\s\S]*?\n\};/) || process.exit(1)"` が終了コード0(CONFIG ブロックが崩れていない)
- [ ] **Step 5: Commit** — `git commit -am "シフト: ページの入口・ログイン・配布設定"`(新規ファイルは `git add` してから)

---

### Task 6: 「スタッフ」タブと「枠と条件」タブ

**Files:**
- Modify: `gas/shift.html`
- Test: `tests/shift-ui.test.js`

**Interfaces:**
- Consumes: Task 5 の `callServer` / `STATE` / `reload` / `showMsg`、Task 4 の `saveStaffMember` / `setStaffActive` / `saveRecurringRules` / `saveShiftSettings`
- Produces: DOM id
  - スタッフ: `#staffList`(1人1行、在籍外は「在籍外」表示で下にまとめる)、`#staffAddBtn`、編集フォーム `#staffForm` 内に `#staffName`、担当チェックボックス `.staffPos[value=担当名]`、`#staffVeteran`、`#staffTarget`、`#staffMaxDays`、`#staffMaxHours`、`#staffNote`、`#staffSaveBtn`、`#staffActiveBtn`(在籍を外す/戻す)、定期条件の行 `#recurringRows .recurringRow`(曜日チェック7つ・枠セレクト(先頭は「終日」)・種類セレクト「出られない」「できれば休み」・削除ボタン)、`#recurringAddBtn`、`#staffMsg`
  - 枠と条件: `#posRows`(担当名の行と追加・削除。空なら「担当なし」と表示)、`#slotRows .slotRow`(名前・開始・終了・曜日チェック7つ・担当ごとの必要人数)、`#slotAddBtn`、`#pairRows .pairRow`(スタッフセレクト2つ、「できれば同じ時間にしない」)、`#pairAddBtn`、`#minVeteran`、`#settingsSaveBtn`、`#settingsMsg`

**決めてあること:**
- スタッフの定期条件は、スタッフの保存ボタンで `saveStaffMember` → `saveRecurringRules` の順に呼ぶ(新規スタッフは戻ってきた `id` を使う)
- 担当なしの店(`positions` が空)では、スタッフの担当チェックと枠の担当別人数を出さず、枠ごとに「必要人数」1つだけ(`required: { '': n }`)
- 枠の終了が開始以前なら、行の横に「翌日まで」と小さく出す
- 保存成功で `reload()`、失敗はサーバのメッセージを `showMsg(…, true)`

- [ ] **Step 1: UI テストを書く**

```js
test('スタッフを追加して定期条件(平日ランチ不可)を登録', async () => {
  // 枠 ランチ を seed → 追加 → 名前「田中」、曜日 月〜金・枠 ランチ・出られない → 保存
  // → call('getShiftBootstrap', ...) の recurring に { weekdays:[1,2,3,4,5], slotId: ランチのid, kind:'unavailable' }
});
test('在籍を外すと一覧で在籍外になる', async () => { /* #staffList に「在籍外」 */ });
test('担当なしの店では必要人数が1つだけ', async () => { /* positions [] → .slotRow 内の人数入力が1つ */ });
test('枠と「一緒にしない」を保存', async () => { /* 保存後 bootstrap の settings.pairRules に {a,b,type:'avoid'} */ });
test('検証エラーがそのまま表示される', async () => { /* 枠名空で保存 → #settingsMsg が '1件目の枠名を入力してください。' */ });
```

- [ ] **Step 2: 失敗を確認** — Run: `node --test tests/` / Expected: FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 成功を確認** — Run: `node --test tests/` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -am "シフト: スタッフと枠・条件の設定画面"`

---

### Task 7: 「希望・休み」タブ

**Files:**
- Modify: `gas/shift.html`
- Test: `tests/shift-ui.test.js`

**Interfaces:**
- Consumes: Task 5 の共通部品、Task 4 の `saveRequests`、`Core.listDates` / `Core.availability` / `Core.buildProblem`
- Produces: DOM id `#reqStaff`(スタッフ選択)、`#reqCalendar`(期間の日付を週ごとの行に並べ、各日 `.reqDay[data-date]`)、日付をタップしたときの小さな選択パネル `#reqPicker`(「終日」または枠ごとに「指定なし / 出られない / できれば休み / 出たい」)、`#reqSaveBtn`、`#reqMsg`

**決めてあること:**
- 1人ずつ入力する(スタッフを選ぶ → カレンダーをタップ)。選ばれていないスタッフの希望も `STATE` に保持し、保存は期間内の全員分をまとめて `saveRequests`
- 各日の表示: その日だけの希望はラベル(「休」「×」「◎」、枠指定なら「ランチ×」など)、定期条件だけによるものは薄い色で同じラベル(`Core.availability` の結果で判定)。休業日はグレーで「休業」
- 期間を変えるか別タブへ移るとき、未保存の変更があれば `confirm('保存していない変更があります。破棄しますか?')`

- [ ] **Step 1: UI テストを書く**

```js
test('11/5 ランチだけ出られないを入力して保存', async () => {
  // 期間を 2026-11-01〜2026-11-30 に → スタッフ選択 → .reqDay[data-date="2026-11-05"] → ランチ=出られない → 保存
  // → bootstrap.requests に { date:'2026-11-05', slotId: ランチ, kind:'unavailable' }
});
test('定期条件は薄く表示され、その日の希望で上書きできる', async () => { /* 薄い表示のクラス、上書き後は通常表示 */ });
test('他のスタッフの希望も消えずに保存される', async () => { /* 2人分入力 → 両方残る */ });
```

- [ ] **Step 2: 失敗を確認** — Run: `node --test tests/` / Expected: FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 成功を確認** — Run: `node --test tests/` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -am "シフト: 希望・休みの入力画面"`

---

### Task 8: 「シフト表」タブ(自動作成・手直し・警告・集計・保存・印刷)

**Files:**
- Modify: `gas/shift.html`
- Test: `tests/shift-ui.test.js`

**Interfaces:**
- Consumes: Task 5 の共通部品、Task 4 の `generateShift` / `saveShiftPeriod`、`Core.buildProblem` / `buildCells` / `evaluate` / `availability`
- Produces: DOM id
  - `#genBtn`(自動作成。固定は残す)、`#genResetBtn`(「固定も消して作り直す」。`confirm` 後、固定を全部外してから自動作成)、`#gridSaveBtn`、`#printBtn`、`#gridMsg`
  - `#grid`: 列 = 日付(見出し `12/5(土)`、休業日は「休業」)、行 = 枠。セル `td[data-date][data-slot]` の中に担当ごとの `.cellPos[data-pos]`、その中に人 `.who[data-staff]`(固定は `.pinned`)、不足は `.short`(「不足」)、警告のあるセル・人に `.warn` / `.err`
  - 日付見出しをタップすると `#dayPanel`(その日の全枠のチェックボックス。外すと `off`、普段ない枠を入れると `on`)
  - `.cellPos` をタップすると `#picker`: 入っている人(「外す」「固定を外す」ボタン)と、追加できる人の一覧。出られない・担当外・上限超えの人は灰色で理由付き(それでも選べる)。時間が重なる別の枠にすでに入っている人は選べない
  - `#warnList`(`level` ごとに error を先、各行は `warning.message`)、`#summary`(スタッフごとに 出勤日数 / 目安 / 時間 / 上限。目安から ±1日を超える人は色、上限超えは赤)

**決めてあること:**
- 手直しはすべて画面上の `STATE.assignments` を変え、その都度 `Core.evaluate` で `#warnList` / `#summary` / セルの印を描き直す(サーバを呼ばない)
- 人を追加した割り当ては `pinned: true`。「外す」は割り当てを消し、`{ kind:'exclude', position:'', pinned:true }` を足す。「固定を外す」は `pinned: false` にする(除外の場合は消す)
- `#genBtn` は `generateShift(token, from, to, STATE.assignments)` を呼び、戻りの `assignments` で置き換える。未保存の日別枠の変更があれば、先に `saveShiftPeriod` で日別枠と現在の割り当てを保存してから呼ぶ(サーバは保存済みの日別枠で枠を作るため)
- 自動作成中はボタンを無効にし「作成中…(最大30秒ほど)」と表示
- 保存は `saveShiftPeriod(token, from, to, STATE.assignments, STATE.dayOverrides)`。成功で `STATE.dirty = false`
- 印刷: `@media print` で、ヘッダー・タブ・ボタン・`#picker`・`#dayPanel` を隠し、表を白黒で読める罫線にする。`#warnList` は印刷しない。`#printBtn` は `window.print()`
- スマホ幅では `#grid` を横スクロール(枠名の列は `position: sticky; left: 0`)

- [ ] **Step 1: UI テストを書く**

```js
test('自動作成 → 表に名前が並び、不足がなければ警告なし', async () => { /* seed: 3人・1枠・1日 → .who が出る */ });
test('avoid の2人しかいない枠は一緒に入って警告が出る', async () => {
  // #warnList に '…さんと…さんが同じ時間(できれば避けたい組み合わせ)'
});
test('手で入れた人は固定になり、再作成でも残る', async () => {
  // picker で C を追加 → .who[data-staff="C"].pinned → #genBtn → まだ C がいる
});
test('外した人は再作成で戻らない', async () => { /* 外す → #genBtn → その枠に戻らない */ });
test('出られない人も理由付きで選べ、選ぶと赤い警告', async () => { /* picker で灰色・理由テキスト → 選ぶ → #warnList に error */ });
test('日別枠を消すとその日の枠が表から消える', async () => { /* #dayPanel でチェックを外す → td[data-date][data-slot] が消える */ });
test('保存 → 再読み込みで同じ表', async () => { /* #gridSaveBtn → reload → .who の並びが同じ */ });
test('印刷用CSSでボタンが隠れる', async () => {
  // page.emulateMedia({ media: 'print' }) → #genBtn が非表示、#grid は表示
});
```

- [ ] **Step 2: 失敗を確認** — Run: `node --test tests/` / Expected: FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 成功を確認** — Run: `node --test tests/` / Expected: PASS
- [ ] **Step 5: スマホ幅の見た目を確認** — `tests/helpers/shift-page.js` で 390×844 と 1280×800 のスクリーンショットを撮り(`deviceScaleFactor: 1`)、横スクロール以外にページ全体がはみ出していないこと、枠名の列が固定されていることを目で確認する
- [ ] **Step 6: Commit** — `git commit -am "シフト: シフト表(自動作成・手直し・警告・印刷)"`

---

### Task 9: ドキュメント

**Files:**
- Modify: `README.md`(機能一覧に1行、ファイル構成に3ファイルと `tests/`、「シフト表の使い方」節: 初回の設定順(枠と条件 → スタッフ → 希望 → 自動作成)、条件の強さと優先順位、テストの実行方法 `node --test tests/`)
- Modify: `CLAUDE.md`(「コマンド」にテスト実行、「アーキテクチャ」に「シフト表」節: `ShiftCore.gs` は `shiftCoreFactory` 1つで GAS API・外部変数を使わない(画面へ `toString()` で埋め込むため)、保存先(プロパティ `SHIFT_SETTINGS` と5シート)、固定・除外の意味、週の上限に期間外の割り当てを含めること、`create-store.js` と `.claspignore` に新ファイルを足す必要があること)

- [ ] **Step 1: 追記する**
- [ ] **Step 2: 確認** — Run: `node --test tests/` / Expected: PASS(ドキュメントの変更で何も壊れていない)。README のファイル構成と実際の `ls gas tests` が一致する
- [ ] **Step 3: Commit** — `git commit -am "シフト: README と CLAUDE.md に説明を追加"`
