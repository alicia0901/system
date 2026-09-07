# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Google Apps Script (GAS) だけで完結する飲食店向け予約システム。外部サーバ不要、ビルド不要。予約フォーム(HTML)・座席数ベースの空席管理・パスワード保護の管理画面・確認メール送信を1つの GAS プロジェクトで実現する。

## コマンド

ビルド/テストの仕組みはない(GAS はエディタに貼り付けて実行するか `clasp` で push するのみ)。

```bash
# 新店舗用のコード生成(Google側には何も作らない)
node setup/create-store.js setup/<store-config>.json

# 生成 + Googleスプレッドシート/Apps Scriptプロジェクト作成/push/デプロイまで自動実行
node setup/create-store.js setup/<store-config>.json --deploy

# 共通エンジン修正後、既存店舗へ反映(コード再生成→pushのみ。デプロイは別途「デプロイを管理」から)
node setup/create-store.js setup/<store-config>.json
cd stores/<storeSlug>/gas && clasp push -f
```

clasp 初回セットアップ(運用担当者アカウントで1回のみ): `npm install -g @google/clasp` → `https://script.google.com/home/usersettings` で Apps Script API を有効化 → `clasp login`。

## アーキテクチャ

### 「共通エンジン + CONFIG」構造

`gas/Code.gs` は先頭の `const CONFIG = {...}` ブロック(店名・営業時間・座席数・コース・管理画面パスワード等)と、それ以降の共通ロジック(予約処理・空席計算・管理画面API)に分かれている。**店舗ごとの差分は CONFIG ブロックだけ**であり、予約ロジック本体は1箇所(`gas/Code.gs`)にしか存在しない。

- `gas/` = 1店舗目 兼 テンプレート本体。バグ修正・機能追加は必ずここに対して行う。
- `stores/<storeSlug>/gas/` = `setup/create-store.js` の生成物。**直接編集しない**(再生成で上書きされる想定のファイル)。共通ロジックへの変更をここへ反映するには、店舗の設定ファイルで `create-store.js` を再実行してから `clasp push` する。
- `setup/create-store.js` は `gas/Code.gs` を正規表現 (`/const CONFIG = \{[\s\S]*?\n\};/`) で読み込み、CONFIG ブロックだけを店舗設定ファイル(`setup/*.json`)の内容で置換して `stores/<storeSlug>/gas/` に書き出す。CONFIG ブロックの構造(`const CONFIG = { ... };` という開始・終了の形)を崩す変更をすると、このジェネレーターが動かなくなる点に注意。

### 予約処理のフロー(`gas/Code.gs`)

1. `doGet(e)` — `?page=admin` の有無で `index.html`(予約フォーム)か `admin.html`(管理画面)を出し分けるエントリポイント。
2. `getDaySchedule(dateStr)` — 指定日の確定予約(`getConfirmedRangesForDate`、`STATUS_CONFIRMED` のみ集計)と、`getBusinessHoursForDate(dateStr)` による営業時間帯を集計し、時間帯ごとの空席状況をフォームに返す。
3. `submitBooking(form)` — 予約確定処理。フラッド対策(`checkGlobalFloodGuard`)→ 必須項目・人数上限 → 同一電話番号の連投対策(`checkPhoneRateLimit`)→ 過去日時/予約可能期間 → 休業日・営業時間内(コース滞在時間込み、`getBusinessHoursForDate`+`isWithinBusinessPeriods`) → 座席数超過(`sumOverlappingPartySize` で時間帯の重複人数を合算し `SEATS_TOTAL` と比較)の順にチェックする。満席時は `CONFIG.WAITLIST_ENABLED` かつ `form.acceptWaitlist` なら `STATUS_WAITLIST` で登録(カレンダー登録なし)、それ以外は拒否。通過すればカレンダー登録・スプレッドシート追記・メール送信(`sendBookingEmails`)を行う。
4. 管理画面側は `adminLogin` → `isValidAdminToken` によるパスワード認証(単純な共有パスワード方式)の上で以下を呼ぶ:
   - `getReservationsForAdmin` / `cancelReservationAdmin` — 一覧取得・キャンセル(キャンセル待ちの取り消しにも使う)。`cancelReservationAdmin` は確定予約のキャンセル時に `notifyWaitlistOfOpening(dateStr)` を呼び、その日のキャンセル待ちへ空席通知を試みる。
   - `createReservationAdmin` — 電話予約などの手動登録。オンラインフォームと違いメール任意。`force: true` で休業日・営業時間外・満席チェックを無視できる(通知メールは店舗へは送らずお客様宛のみ)。
   - `updateReservationAdmin` — 既存予約(キャンセル済み以外)の内容変更。ステータスは変更しない。空席チェックは `getConfirmedRangesForDate(dateStr, excludeRowIndex)` で変更対象自身の現在の枠を除外した上で行う(自分自身との重複で誤って満席判定にならないようにするため)。`force: true` で休業日・営業時間外・満席チェックを無視できる(満席時間帯への変更用)。確定済み(`STATUS_CONFIRMED`)予約はカレンダーの予定も `setTime`/`setTitle`/`setDescription` で追随して更新する。変更前の日付・人数・コースと比べて座席に空きが出る可能性がある変更(日付変更・人数減・滞在時間短縮)なら、変更前の日付について `notifyWaitlistOfOpening` を呼ぶ。
   - `promoteWaitlistAdmin` — キャンセル待ち(`STATUS_WAITLIST`)をその時点の空席状況を再確認した上で確定(`STATUS_CONFIRMED`)へ繰り上げ、この時点で初めてカレンダー登録する。
   - `getCoursesForAdmin` / `updateCoursesAdmin` / `resetCoursesAdmin` — コース(名前・滞在時間)の一覧取得・変更・初期化。**コース設定は `CONFIG.COURSES` ではなく `PropertiesService.getScriptProperties()`(キー `COURSES_OVERRIDE`, JSON文字列)に保存される**。`getEffectiveCourses()` がこのプロパティがあればそれを、なければ `CONFIG.COURSES` を返す共通の読み出し口になっており、コース一覧を参照する箇所(`getConfig`・`submitBooking`・`createReservationAdmin`・`updateReservationAdmin`・`promoteWaitlistAdmin`・`getConfirmedRangesForDate`)はすべて `CONFIG.COURSES` ではなく `getEffectiveCourses()` を使う。これにより、管理画面からのコース変更は `setup/create-store.js` によるコード再生成(CONFIG ブロックの差し替え)や `gas/Code.gs` への機能追加の影響を受けない。新しくコース一覧を参照するコードを書く場合は `CONFIG.COURSES` を直接参照しないこと。
   - `getBusinessHoursForAdmin` / `updateBusinessHoursAdmin` / `resetBusinessHoursAdmin` — 営業時間帯(中抜け対応の複数帯)・特別な日(臨時休業/時間変更/臨時営業)の取得・変更・初期化。コース設定と同じパターンで、**実運用値は `CONFIG.CLOSED_WEEKDAYS`/`BUSINESS_START_HOUR`/`BUSINESS_END_HOUR`/`BUSINESS_PERIODS` ではなく `PropertiesService`(キー `BUSINESS_HOURS_OVERRIDE`, JSON文字列)に保存**され、`getBusinessSettings()` が読み出し口。指定日の営業状況(休業か・どの時間帯か)を判定する処理は必ず `getBusinessHoursForDate(dateStr)` を経由すること(`CLOSED_WEEKDAYS`/`BUSINESS_START_HOUR`/`BUSINESS_END_HOUR` を新しいコードで直接参照しない)。保存時、過去日の `specialDays` は自動的に取り除かれる。
   - `getStatsForAdmin(token, fromDate, toDate)` — 期間内の予約組数・総人数・キャンセル数/率・1組あたり平均人数・キャンセル待ち件数を返す(シートの全走査、最大1年)。

**座席管理はテーブル単位ではなく総座席数ベース**: 各予約はコースの `duration`(滞在時間)分だけ `SEATS_TOTAL` を占有するとみなし、重なる時間帯の人数合計で空席を判定する(テーブル数・席種を分けた最適化は行わない設計)。

### キャンセル待ちへの空席通知

`notifyWaitlistOfOpening(dateStr)` は座席に空きが出た可能性がある操作(確定予約のキャンセル、または人数減・日付変更・滞在時間短縮を伴う変更)の後に呼ばれ、その日の `STATUS_WAITLIST` のうち現在の空席状況なら収まるものへ「空きが出ました」メールを送る。**ステータスは変更しない**(確定は引き続き管理画面の `promoteWaitlistAdmin` で行う、客の意思確認なしに席を押さえないため)。二重送信防止は `SHEET_HEADERS`/`COL` 末尾の `WAITLIST_NOTIFIED` 列(通知日時)で行い、一度通知した予約には二度と送らない(再度満席になって再び空いても再送しない)。1回の呼び出しで通知する件数は `WAITLIST_NOTIFY_MAX_PER_RUN`(登録順の先着)に絞る。

### LINEアプリ内予約(LIFF)

`CONFIG.LIFF_ID` に LINE Developers で発行した LIFF アプリの ID を設定すると、`index.html` が LINE の LIFF SDK(`https://static.line-scdn.net/liff/edge/2/sdk.js`)を読み込み、LINEアプリ内で開かれた場合に `liff.init()` → `liff.getProfile()` でLINEの表示名を取得してお名前欄を自動入力し、`submitBooking` にも `lineUserId` / `lineDisplayName` として送る。`LIFF_ID` が空文字の店舗(既定値)ではこのスクリプトタグ自体が出力されず(`index.html` 冒頭の `<? if (CONFIG.LIFF_ID) { ?>` スクリプトレット)、通常のブラウザ予約フォームの挙動に一切影響しない。

- サーバ側(`submitBooking`)は `form.lineUserId` の有無だけで `route`(`'LINE'` / `'Web'`)を判定し、`createReservationAdmin` は常に `'電話等(手動登録)'` を記録する。`updateReservationAdmin` は既存行の `route`・`lineDisplayName` をそのまま引き継ぐ(変更フォームにこの2項目は含まれないため)。これらは `SHEET_HEADERS`/`COL` の末尾(`ROUTE`, `LINE_NAME`)に追加した列で、既存シートには `getOrCreateSheet()` がヘッダー行だけ自動補完する。
- 予約確定後、LINEアプリ内(`liff.isInClient()`)であれば `liff.sendMessages()` でトーク画面に確定メッセージを送り(失敗しても予約自体は成立させる)、「LINEのトーク画面に戻る」ボタン(`liff.closeWindow()`)を表示する。`sendMessages` を使うには LIFF アプリ追加時に `chat_message.write` スコープを有効にしておく必要がある(未設定でも予約自体・トーク画面に戻るボタンは動作する)。
- LINE公式アカウント側のチャネル作成・LIFFアプリ登録(エンドポイントURLをこのWebアプリの `.../exec` URLにする)はLINE Developersコンソールでの作業が必要で、コード側からは行えない。手順は README.md を参照。

**簡易レート制限は `LockService` の排他区間に相乗り**: `checkGlobalFloodGuard` / `checkPhoneRateLimit` / `markPhoneRateLimit` は `CacheService` の get→put で実装しているが、呼び出し元(`submitBooking`)がすでに `LockService.getScriptLock()` を保持した中で実行されるため、素朴な read-then-write でも競合しない。この関数群を他の場所(ロック外)から呼ぶ場合は別途排他を検討すること。

### 前日・当日リマインダーメール

`sendDayBeforeReminders()` / `sendSameDayReminders()` は時間主導トリガー(`setupReminderTrigger()` を Apps Script エディタで1回手動実行して作成する。コードのpushだけではトリガーは作られない)から呼ばれ、内部で共通の `sendRemindersOfKind(kind)` を呼ぶ。当日分は毎日9時ごろ、前日分は毎日18時ごろに実行される想定(`atHour` はトリガー作成時に固定される)。

- 二重送信防止のため、`SHEET_HEADERS`/`COL` 末尾の `REMINDER_SENT`(リマインダー送信済み)列にカンマ区切りで `'day_before'` / `'same_day'` を記録する。送信対象の判定はこの文字列に対象の kind が含まれているかどうかで行う。
- `updateReservationAdmin` で予約の日付・時間が変更された場合、この列は空文字にリセットされる(古い日時に対する送信済みフラグを新しい日時にそのまま引き継ぐと、新しい日時への本来必要なリマインダーが誤って送られなくなるため)。日付・時間が変わっていなければ既存値をそのまま維持する。
- `CONFIG.REMINDER_DAY_BEFORE_ENABLED` / `REMINDER_SAME_DAY_ENABLED` は個別のON/OFFのみを制御し、トリガー自体の有無とは独立している(`false` でもトリガーは残るが、`sendRemindersOfKind` の先頭で何もせず終了する)。
- 日付の比較には `formatDateStr(date)`(`Utilities.formatDate` を `CONFIG.TIMEZONE` で使うラッパー)を使うこと。既存の `getConfirmedRangesForDate` 等と同様、シートの日付セルは `String(row[COL.DATE])` で文字列として扱う前提になっている。
- 他店舗展開時は、`create-store.js` の再実行や `clasp push` だけではトリガーは複製されない。新規店舗ごとに、その店舗の Apps Script エディタで `setupReminderTrigger` を1回実行する必要がある(README.md 参照)。

### Windows での clasp 呼び出しの注意

`create-store.js --deploy` は Windows 上で `clasp` を `shell: true` 経由の `.cmd` シムとして呼ぶと日本語・空白入り引数が壊れるため、`.cmd` の中身を解析して実体の `node <entry.js>` を直接 `execFileSync` で叩く(`resolveClaspInvocation()`)。clasp 呼び出し部分を変更する際はこの回避策を維持すること。
