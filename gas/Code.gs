/**
 * 飲食店 予約システム (Google Apps Script)
 * ------------------------------------------------
 * - index.html を予約フォームとして配信 (Web App / お客様向け)
 * - admin.html を管理画面として配信 (Web App / 店舗スタッフ向け, ?page=admin)
 * - 送信内容をスプレッドシートに記録
 * - 同じ内容で Google カレンダーに予定を自動登録
 * - 総座席数(SEATS_TOTAL)を基準に、時間帯ごとの空席を自動計算して満席の時間を拒否
 * - 営業時間外・定休日の予約は自動的に拒否
 * - 予約確定時にお客様(+店舗)へ確認メールを自動送信
 *
 * セットアップ手順は README.md を参照。
 */

// ==================== 設定 ====================
// この CONFIG ブロックだけが店舗ごとに異なる設定です。
// 他店舗用に複製する場合は setup/create-store.js が自動でこのブロックを
// 差し替えます(手動で編集してもOK)。CONFIG より下のコードは共通エンジンです。
const CONFIG = {
  // 予約フォーム・管理画面のタイトルに表示する店名(空文字なら「ご予約フォーム」のまま)
  STORE_NAME: '飲食店',

  // 予定を登録する Googleカレンダー。
  // 自分のメインカレンダーでよければ 'primary' のまま。
  // 店舗専用カレンダーを使う場合はそのカレンダーIDに変更する。
  CALENDAR_ID: 'primary',

  // 予約を記録するシート名(なければ自動作成)
  SHEET_NAME: '予約一覧',

  TIMEZONE: 'Asia/Tokyo',

  // 営業時間 (24時間表記)
  BUSINESS_START_HOUR: 11,
  BUSINESS_END_HOUR: 22,

  // 定休日 (0=日, 1=月, 2=火, 3=水, 4=木, 5=金, 6=土)
  CLOSED_WEEKDAYS: [1],

  // 予約受付の時間刻み(分)
  SLOT_MINUTES: 30,

  // 何日先まで予約可能にするか
  MAX_DAYS_AHEAD: 60,

  // 総座席数。時間帯ごとの空席はこの数字を基準に自動計算されます。
  SEATS_TOTAL: 20,

  // 1回のご予約で受け付ける最大人数
  PARTY_SIZE_MAX: 8,

  // コース/プラン: name と滞在時間(分)。滞在時間の分だけ座席を占有するとみなして空席計算する。
  COURSES: [
    { name: 'ディナーコース', duration: 120 },
    { name: 'ランチ', duration: 60 },
    { name: 'お食事のみ(コース注文なし)', duration: 90 },
  ],

  // 予約が入るたびに店舗側にも通知メールを送る宛先(空文字にすると送らない)
  NOTIFY_EMAIL: '',

  // 管理画面(?page=admin)のログインパスワード。必ずデフォルトから変更してください。
  ADMIN_PASSWORD: 'changeme',

  // 満席の時間帯でも「キャンセル待ち」としての登録を受け付けるか
  WAITLIST_ENABLED: true,

  // LINEアプリ内で予約フォームを開けるようにする場合、LINE Developersで発行した
  // LIFFアプリのID('1234567890-AbCdEfGh' のような形式)を設定する。
  // 空文字のままなら通常のブラウザ予約フォームとしてのみ動作する(LIFF関連の読み込みは一切行われない)。
  LIFF_ID: '',

  // 簡易的な連投・スパム対策(いたずら・二重送信・ボットによる大量送信の防止)
  RATE_LIMIT: {
    MIN_INTERVAL_SEC_PER_PHONE: 30, // 同じ電話番号からの連続送信を制限する間隔(秒)
    MAX_SUBMISSIONS_PER_WINDOW: 20, // 下記ウィンドウ(秒)内で許可する送信数の上限
    WINDOW_SEC: 60,
  },
};

const SHEET_HEADERS = [
  '受付日時', '氏名', 'フリガナ', '電話番号', 'メールアドレス',
  '予約日', '予約時間', '人数', 'コース', 'ご要望', 'ステータス', 'カレンダーイベントID',
  '申込経路', 'LINE表示名',
];

// 列インデックス(0始まり)
const COL = {
  RECEIVED_AT: 0, NAME: 1, KANA: 2, PHONE: 3, EMAIL: 4,
  DATE: 5, TIME: 6, PARTY_SIZE: 7, COURSE: 8, NOTES: 9, STATUS: 10, EVENT_ID: 11,
  ROUTE: 12, LINE_NAME: 13,
};

// 申込経路の値
const ROUTE_WEB = 'Web';
const ROUTE_LINE = 'LINE';
const ROUTE_STAFF = '電話等(手動登録)';

const STATUS_CONFIRMED = '予約確定';
const STATUS_CANCELLED = 'キャンセル';
const STATUS_WAITLIST = 'キャンセル待ち';

// 管理画面ログインのセッション有効期間(秒)
const ADMIN_SESSION_TTL_SEC = 6 * 60 * 60; // 6時間

// 管理画面から変更したコース設定を保存するプロパティキー(PropertiesService)。
// CONFIG.COURSES は setup/create-store.js による再生成で上書きされる「初期値」の位置づけとし、
// 管理画面からの変更はここに保存することで、共通エンジンの更新や再生成に影響されないようにする。
const COURSES_PROPERTY_KEY = 'COURSES_OVERRIDE';

// ==================== Web App エントリポイント ====================

function doGet(e) {
  const page = e && e.parameter && e.parameter.page;

  if (page === 'admin') {
    const title = (CONFIG.STORE_NAME ? CONFIG.STORE_NAME + ' ' : '') + '予約管理';
    return HtmlService.createTemplateFromFile('admin')
      .evaluate()
      .setTitle(title)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const title = (CONFIG.STORE_NAME ? CONFIG.STORE_NAME + ' ' : '') + 'ご予約フォーム';
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 現在有効なコース一覧を返す。
 * 管理画面から変更されていれば PropertiesService に保存された内容を、
 * まだ変更されていなければ CONFIG.COURSES(店舗設定の初期値)を返す。
 */
function getEffectiveCourses() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(COURSES_PROPERTY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    Logger.log('コース設定の読み込みエラー: ' + e.message);
  }
  return CONFIG.COURSES;
}

// ==================== お客様側: クライアントから呼ばれる関数 ====================

/**
 * フォーム初期表示用の設定情報を返す
 */
function getConfig() {
  return {
    storeName: CONFIG.STORE_NAME,
    courses: getEffectiveCourses(),
    businessStartHour: CONFIG.BUSINESS_START_HOUR,
    businessEndHour: CONFIG.BUSINESS_END_HOUR,
    closedWeekdays: CONFIG.CLOSED_WEEKDAYS,
    slotMinutes: CONFIG.SLOT_MINUTES,
    maxDaysAhead: CONFIG.MAX_DAYS_AHEAD,
    seatsTotal: CONFIG.SEATS_TOTAL,
    partySizeMax: CONFIG.PARTY_SIZE_MAX,
    waitlistEnabled: !!CONFIG.WAITLIST_ENABLED,
    liffId: CONFIG.LIFF_ID || '',
  };
}

/**
 * 指定日の予約状況を返す (フロントで空席のある時間帯の表示に使う)
 * カレンダーではなくスプレッドシートの記録を基準に、時間帯ごとの予約人数を集計する。
 * @param {string} dateStr 'YYYY-MM-DD'
 */
function getDaySchedule(dateStr) {
  const date = parseDateStr(dateStr);
  const weekday = date.getDay();

  const result = {
    closed: CONFIG.CLOSED_WEEKDAYS.indexOf(weekday) !== -1,
    bookedRanges: [], // [{startMin, endMin, partySize}]
  };

  if (result.closed) return result;

  result.bookedRanges = getConfirmedRangesForDate(dateStr);
  return result;
}

/**
 * 予約を確定する
 * @param {Object} form { name, kana, phone, email, course, partySize, date, time, notes, acceptWaitlist }
 */
function submitBooking(form) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // 同時アクセスによる二重予約(オーバーブッキング)を防ぐ

  try {
    // ---- 簡易フラッド対策(短時間の大量送信をブロック) ----
    const floodMessage = checkGlobalFloodGuard();
    if (floodMessage) {
      return { success: false, message: floodMessage };
    }

    // ---- 入力チェック ----
    if (!form || !form.name || !form.kana || !form.phone || !form.email || !form.date || !form.time || !form.course || !form.partySize) {
      return { success: false, message: '必須項目が入力されていません。' };
    }

    // ---- 簡易連投対策(同じ電話番号からの短時間の連続送信をブロック) ----
    const rateLimitMessage = checkPhoneRateLimit(form.phone);
    if (rateLimitMessage) {
      return { success: false, message: rateLimitMessage };
    }

    const partySize = parseInt(form.partySize, 10);
    if (!partySize || partySize < 1 || partySize > CONFIG.PARTY_SIZE_MAX) {
      return { success: false, message: 'ご人数は1〜' + CONFIG.PARTY_SIZE_MAX + '名の範囲で指定してください。' };
    }

    const courseDef = getEffectiveCourses().filter(function (c) { return c.name === form.course; })[0];
    if (!courseDef) {
      return { success: false, message: '選択されたコースが不正です。' };
    }

    const start = parseDateTimeStr(form.date, form.time);
    if (!start || isNaN(start.getTime())) {
      return { success: false, message: '日付・時間が不正です。' };
    }
    const end = new Date(start.getTime() + courseDef.duration * 60000);

    // ---- 過去日チェック ----
    const now = new Date();
    if (start.getTime() < now.getTime()) {
      return { success: false, message: '過去の日時は予約できません。' };
    }

    // ---- 予約可能日数チェック ----
    const maxDate = new Date(now.getTime() + CONFIG.MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000);
    if (start.getTime() > maxDate.getTime()) {
      return { success: false, message: 'ご予約可能な期間を超えています。' };
    }

    // ---- 定休日チェック ----
    if (CONFIG.CLOSED_WEEKDAYS.indexOf(start.getDay()) !== -1) {
      return { success: false, message: '選択された日付は定休日です。' };
    }

    // ---- 営業時間チェック ----
    const startMin = minutesSinceMidnight(start);
    const endMin = minutesSinceMidnight(end);
    if (startMin < CONFIG.BUSINESS_START_HOUR * 60 || endMin > CONFIG.BUSINESS_END_HOUR * 60) {
      return { success: false, message: '営業時間外の時間帯です(お食事の時間を含め営業時間内でご予約ください)。' };
    }

    // ---- 空席(座席数)チェック ----
    const bookedRanges = getConfirmedRangesForDate(form.date);
    const reservedAtSlot = sumOverlappingPartySize(bookedRanges, startMin, endMin);
    const isFull = reservedAtSlot + partySize > CONFIG.SEATS_TOTAL;

    // LINEアプリ(LIFF)経由の予約かどうか。index.html が LIFF 経由で取得できた
    // LINEのプロフィール情報をこの2項目に載せて送ってくる(取得できなければ通常のWeb予約)。
    const route = form.lineUserId ? ROUTE_LINE : ROUTE_WEB;
    const lineDisplayName = form.lineDisplayName || '';

    if (isFull) {
      // 満席でも、キャンセル待ちの受付が有効かつお客様が希望していれば登録する
      if (CONFIG.WAITLIST_ENABLED && form.acceptWaitlist) {
        const waitlistSheet = getOrCreateSheet();
        waitlistSheet.appendRow([
          new Date(),
          form.name,
          form.kana || '',
          form.phone,
          form.email || '',
          form.date,
          form.time,
          partySize,
          form.course,
          form.notes || '',
          STATUS_WAITLIST,
          '', // カレンダー未登録(確定時に登録する)
          route,
          lineDisplayName,
        ]);

        markPhoneRateLimit(form.phone);
        sendWaitlistRegisteredEmail(form, partySize);

        return {
          success: true,
          waitlisted: true,
          message: form.date + ' ' + form.time + ' は満席のため、キャンセル待ちとして登録しました。空きが出た場合、折り返しご連絡いたします。',
        };
      }
      return { success: false, message: '大変申し訳ございません、その時間帯は満席です。別の時間をお選びください。' };
    }

    // ---- カレンダー登録 ----
    const title = '【予約】' + form.name + ' 様 ' + partySize + '名(' + form.course + ')';
    const description = [
      '人数: ' + partySize + '名',
      '電話番号: ' + form.phone,
      form.email ? 'メール: ' + form.email : '',
      form.kana ? 'フリガナ: ' + form.kana : '',
      form.notes ? 'ご要望: ' + form.notes : '',
    ].filter(String).join('\n');

    let eventId = '';
    try {
      const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
      const event = calendar.createEvent(title, start, end, { description: description });
      eventId = event.getId();
    } catch (calErr) {
      // カレンダー登録に失敗しても予約自体は成立させる(スプレッドシートが正)
      Logger.log('カレンダー登録エラー: ' + calErr.message);
    }

    // ---- スプレッドシート記録 ----
    const sheet = getOrCreateSheet();
    sheet.appendRow([
      new Date(),
      form.name,
      form.kana || '',
      form.phone,
      form.email || '',
      form.date,
      form.time,
      partySize,
      form.course,
      form.notes || '',
      STATUS_CONFIRMED,
      eventId,
      route,
      lineDisplayName,
    ]);

    // ---- 確認メール送信(失敗しても予約は成立させる) ----
    sendBookingEmails(form, partySize);
    markPhoneRateLimit(form.phone);

    return {
      success: true,
      message: form.date + ' ' + form.time + ' から ' + partySize + '名様「' + form.course + '」でのご予約が完了しました!当日を楽しみにお待ちしております♪',
    };
  } catch (err) {
    return { success: false, message: 'エラーが発生しました: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

// ==================== 管理画面側: クライアントから呼ばれる関数 ====================

/**
 * 管理画面ログイン。成功時はセッショントークンを返す。
 */
function adminLogin(password) {
  if (!CONFIG.ADMIN_PASSWORD || password !== CONFIG.ADMIN_PASSWORD) {
    return { success: false, message: 'パスワードが違います。' };
  }
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('admin_' + token, '1', ADMIN_SESSION_TTL_SEC);
  return { success: true, token: token, storeName: CONFIG.STORE_NAME };
}

/**
 * 指定日の予約一覧(管理画面用)。要ログイン。
 */
function getReservationsForAdmin(token, dateStr) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }

  const sheet = getOrCreateSheet();
  const values = sheet.getDataRange().getValues();
  const reservations = [];
  let reservedSeats = 0;
  let waitlistCount = 0;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (String(row[COL.DATE]) !== dateStr) continue;
    const status = row[COL.STATUS];
    if (status === STATUS_CONFIRMED) reservedSeats += Number(row[COL.PARTY_SIZE]) || 0;
    if (status === STATUS_WAITLIST) waitlistCount++;
    reservations.push({
      rowIndex: r + 1, // シート上の実際の行番号(1始まり、ヘッダーが1行目)
      time: row[COL.TIME],
      partySize: row[COL.PARTY_SIZE],
      course: row[COL.COURSE],
      name: row[COL.NAME],
      kana: row[COL.KANA],
      phone: row[COL.PHONE],
      email: row[COL.EMAIL],
      notes: row[COL.NOTES],
      status: status,
      route: row[COL.ROUTE] || ROUTE_WEB,
      lineDisplayName: row[COL.LINE_NAME] || '',
    });
  }

  reservations.sort(function (a, b) { return String(a.time).localeCompare(String(b.time)); });

  return {
    success: true,
    reservations: reservations,
    seatsTotal: CONFIG.SEATS_TOTAL,
    reservedSeats: reservedSeats,
    waitlistCount: waitlistCount,
  };
}

/**
 * 管理画面からの手動予約登録(電話予約など、システム外で受けた予約を反映する用)。要ログイン。
 * オンライン予約フォームと違い、メールアドレスは任意。force=true で定休日・営業時間外・
 * 満席チェックを無視して強制的に登録できる(例外対応用)。
 * @param {string} token
 * @param {Object} form { name, kana, phone, email, course, partySize, date, time, notes, force }
 */
function createReservationAdmin(token, form) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (!form || !form.name || !form.phone || !form.date || !form.time || !form.course || !form.partySize) {
      return { success: false, message: '必須項目(お名前・電話番号・日付・時間・コース・人数)が入力されていません。' };
    }

    const partySize = parseInt(form.partySize, 10);
    if (!partySize || partySize < 1) {
      return { success: false, message: 'ご人数を正しく指定してください。' };
    }

    const courseDef = getEffectiveCourses().filter(function (c) { return c.name === form.course; })[0];
    if (!courseDef) {
      return { success: false, message: '選択されたコースが不正です。' };
    }

    const start = parseDateTimeStr(form.date, form.time);
    if (!start || isNaN(start.getTime())) {
      return { success: false, message: '日付・時間が不正です。' };
    }
    const end = new Date(start.getTime() + courseDef.duration * 60000);
    const force = !!form.force;

    if (!force) {
      if (CONFIG.CLOSED_WEEKDAYS.indexOf(start.getDay()) !== -1) {
        return { success: false, message: '選択された日付は定休日です(強制登録を使えば無視できます)。' };
      }

      const startMin = minutesSinceMidnight(start);
      const endMin = minutesSinceMidnight(end);
      if (startMin < CONFIG.BUSINESS_START_HOUR * 60 || endMin > CONFIG.BUSINESS_END_HOUR * 60) {
        return { success: false, message: '営業時間外の時間帯です(強制登録を使えば無視できます)。' };
      }

      const bookedRanges = getConfirmedRangesForDate(form.date);
      const reservedAtSlot = sumOverlappingPartySize(bookedRanges, startMin, endMin);
      if (reservedAtSlot + partySize > CONFIG.SEATS_TOTAL) {
        return { success: false, message: 'その時間帯は満席です(現在 ' + reservedAtSlot + '/' + CONFIG.SEATS_TOTAL + ' 席。強制登録を使えば無視できます)。' };
      }
    }

    const title = '【予約(電話等)】' + form.name + ' 様 ' + partySize + '名(' + form.course + ')';
    const description = [
      '人数: ' + partySize + '名',
      '電話番号: ' + form.phone,
      form.email ? 'メール: ' + form.email : '',
      form.kana ? 'フリガナ: ' + form.kana : '',
      form.notes ? 'ご要望: ' + form.notes : '',
      '(スタッフによる手動登録)',
    ].filter(String).join('\n');

    let eventId = '';
    try {
      const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
      const event = calendar.createEvent(title, start, end, { description: description });
      eventId = event.getId();
    } catch (calErr) {
      Logger.log('カレンダー登録エラー: ' + calErr.message);
    }

    const sheet = getOrCreateSheet();
    sheet.appendRow([
      new Date(),
      form.name,
      form.kana || '',
      form.phone,
      form.email || '',
      form.date,
      form.time,
      partySize,
      form.course,
      form.notes || '',
      STATUS_CONFIRMED,
      eventId,
      ROUTE_STAFF,
      '',
    ]);

    // 店舗スタッフ自身の登録のため、通知メールは送らずお客様への確認メールのみ送る
    sendCustomerConfirmationEmail(form, partySize);

    return { success: true, message: form.date + ' ' + form.time + ' で予約を登録しました。' };
  } catch (err) {
    return { success: false, message: 'エラーが発生しました: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 既存の予約内容を変更する(管理画面用)。要ログイン。
 * 日付・時間・人数・コースなどを変更でき、キャンセル待ちを含む未キャンセルの予約が対象。
 * force=true の場合、定休日・営業時間外・満席チェックを無視して変更できる
 * (満席の時間帯へ変更したい場合はこれを使う)。
 * @param {string} token
 * @param {number} rowIndex シート上の行番号(getReservationsForAdmin が返す rowIndex)
 * @param {Object} form { name, kana, phone, email, course, partySize, date, time, notes, force }
 */
function updateReservationAdmin(token, rowIndex, form) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getOrCreateSheet();
    const row = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).getValues()[0];
    if (!row || !row[COL.NAME]) {
      return { success: false, message: '対象の予約が見つかりません。' };
    }
    const status = row[COL.STATUS]; // ステータス自体は変更しない
    if (status === STATUS_CANCELLED) {
      return { success: false, message: 'キャンセル済みの予約は変更できません。' };
    }

    if (!form || !form.name || !form.phone || !form.date || !form.time || !form.course || !form.partySize) {
      return { success: false, message: '必須項目(お名前・電話番号・日付・時間・コース・人数)が入力されていません。' };
    }

    const partySize = parseInt(form.partySize, 10);
    if (!partySize || partySize < 1) {
      return { success: false, message: 'ご人数を正しく指定してください。' };
    }

    const courseDef = getEffectiveCourses().filter(function (c) { return c.name === form.course; })[0];
    if (!courseDef) {
      return { success: false, message: '選択されたコースが不正です。' };
    }

    const start = parseDateTimeStr(form.date, form.time);
    if (!start || isNaN(start.getTime())) {
      return { success: false, message: '日付・時間が不正です。' };
    }
    const end = new Date(start.getTime() + courseDef.duration * 60000);
    const force = !!form.force;

    if (!force) {
      if (CONFIG.CLOSED_WEEKDAYS.indexOf(start.getDay()) !== -1) {
        return { success: false, message: '選択された日付は定休日です(強制変更を使えば無視できます)。' };
      }

      const startMin = minutesSinceMidnight(start);
      const endMin = minutesSinceMidnight(end);
      if (startMin < CONFIG.BUSINESS_START_HOUR * 60 || endMin > CONFIG.BUSINESS_END_HOUR * 60) {
        return { success: false, message: '営業時間外の時間帯です(強制変更を使えば無視できます)。' };
      }

      if (status === STATUS_CONFIRMED) {
        // 自分自身が今占めている枠は除外して空席を判定する
        // (同じ時間帯のまま人数だけ変える等の編集で誤って満席判定されないように)
        const bookedRanges = getConfirmedRangesForDate(form.date, rowIndex);
        const reservedAtSlot = sumOverlappingPartySize(bookedRanges, startMin, endMin);
        if (reservedAtSlot + partySize > CONFIG.SEATS_TOTAL) {
          return { success: false, message: 'その時間帯は満席です(現在 ' + reservedAtSlot + '/' + CONFIG.SEATS_TOTAL + ' 席。強制変更を使えば無視できます)。' };
        }
      }
    }

    const title = '【予約】' + form.name + ' 様 ' + partySize + '名(' + form.course + ')';
    const description = [
      '人数: ' + partySize + '名',
      '電話番号: ' + form.phone,
      form.email ? 'メール: ' + form.email : '',
      form.kana ? 'フリガナ: ' + form.kana : '',
      form.notes ? 'ご要望: ' + form.notes : '',
      '(スタッフによる変更)',
    ].filter(String).join('\n');

    // 確定済み予約のみカレンダーと連動させる(キャンセル待ちはまだカレンダー未登録のため対象外)
    let eventId = row[COL.EVENT_ID];
    if (status === STATUS_CONFIRMED) {
      try {
        const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
        const existingEvent = eventId ? calendar.getEventById(eventId) : null;
        if (existingEvent) {
          existingEvent.setTime(start, end);
          existingEvent.setTitle(title);
          existingEvent.setDescription(description);
        } else {
          const newEvent = calendar.createEvent(title, start, end, { description: description });
          eventId = newEvent.getId();
        }
      } catch (calErr) {
        Logger.log('カレンダー更新エラー: ' + calErr.message);
      }
    }

    sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).setValues([[
      row[COL.RECEIVED_AT],
      form.name,
      form.kana || '',
      form.phone,
      form.email || '',
      form.date,
      form.time,
      partySize,
      form.course,
      form.notes || '',
      status,
      eventId,
      row[COL.ROUTE] || ROUTE_WEB, // 申込経路・LINE表示名は変更内容に含まれないので元の値を維持する
      row[COL.LINE_NAME] || '',
    ]]);

    return { success: true };
  } catch (err) {
    return { success: false, message: 'エラーが発生しました: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * キャンセル待ちの予約を確定に繰り上げる(管理画面用)。要ログイン。
 * force=true の場合、座席数チェックを無視して強制的に確定させる。
 */
function promoteWaitlistAdmin(token, rowIndex, force) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getOrCreateSheet();
    const row = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).getValues()[0];
    if (!row || !row[COL.NAME]) {
      return { success: false, message: '対象の予約が見つかりません。' };
    }
    if (row[COL.STATUS] !== STATUS_WAITLIST) {
      return { success: false, message: 'この予約はキャンセル待ちではありません。' };
    }

    const dateStr = String(row[COL.DATE]);
    const timeStr = row[COL.TIME];
    const partySize = Number(row[COL.PARTY_SIZE]) || 0;
    const courseName = row[COL.COURSE];
    const courseDef = getEffectiveCourses().filter(function (c) { return c.name === courseName; })[0];
    const duration = courseDef ? courseDef.duration : CONFIG.SLOT_MINUTES;

    const start = parseDateTimeStr(dateStr, timeStr);
    const end = new Date(start.getTime() + duration * 60000);

    if (!force) {
      const startMin = minutesSinceMidnight(start);
      const endMin = minutesSinceMidnight(end);
      const bookedRanges = getConfirmedRangesForDate(dateStr);
      const reservedAtSlot = sumOverlappingPartySize(bookedRanges, startMin, endMin);
      if (reservedAtSlot + partySize > CONFIG.SEATS_TOTAL) {
        return { success: false, message: 'まだ座席に空きがありません(現在 ' + reservedAtSlot + '/' + CONFIG.SEATS_TOTAL + ' 席)。' };
      }
    }

    const form = {
      name: row[COL.NAME], kana: row[COL.KANA], phone: row[COL.PHONE], email: row[COL.EMAIL],
      date: dateStr, time: timeStr, course: courseName, notes: row[COL.NOTES],
    };

    let eventId = '';
    try {
      const title = '【予約】' + form.name + ' 様 ' + partySize + '名(' + form.course + ')';
      const description = [
        '人数: ' + partySize + '名',
        '電話番号: ' + form.phone,
        form.email ? 'メール: ' + form.email : '',
        form.kana ? 'フリガナ: ' + form.kana : '',
        form.notes ? 'ご要望: ' + form.notes : '',
        '(キャンセル待ちからの繰り上げ)',
      ].filter(String).join('\n');
      const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
      const event = calendar.createEvent(title, start, end, { description: description });
      eventId = event.getId();
    } catch (calErr) {
      Logger.log('カレンダー登録エラー: ' + calErr.message);
    }

    sheet.getRange(rowIndex, COL.STATUS + 1).setValue(STATUS_CONFIRMED);
    sheet.getRange(rowIndex, COL.EVENT_ID + 1).setValue(eventId);

    sendWaitlistPromotedEmail(form, partySize);

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 予約をキャンセルする(管理画面用)。要ログイン。
 */
function cancelReservationAdmin(token, rowIndex) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getOrCreateSheet();
    const row = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).getValues()[0];
    if (!row || !row[COL.NAME]) {
      return { success: false, message: '対象の予約が見つかりません。' };
    }
    if (row[COL.STATUS] === STATUS_CANCELLED) {
      return { success: false, message: 'この予約は既にキャンセル済みです。' };
    }

    sheet.getRange(rowIndex, COL.STATUS + 1).setValue(STATUS_CANCELLED);

    const eventId = row[COL.EVENT_ID];
    if (eventId) {
      try {
        const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
        const event = calendar.getEventById(eventId);
        if (event) event.deleteEvent();
      } catch (calErr) {
        Logger.log('カレンダー削除エラー: ' + calErr.message);
      }
    }

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 現在のコース設定を返す(管理画面用)。要ログイン。
 */
function getCoursesForAdmin(token) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }
  return { success: true, courses: getEffectiveCourses() };
}

/**
 * コース設定を変更する(管理画面用)。要ログイン。
 * 変更内容は PropertiesService に保存され、CONFIG.COURSES(店舗設定の初期値)には影響しない。
 * @param {string} token
 * @param {Array<{name: string, duration: number}>} courses
 */
function updateCoursesAdmin(token, courses) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }

  if (!Array.isArray(courses) || courses.length === 0) {
    return { success: false, message: 'コースを1つ以上設定してください。' };
  }

  const cleaned = [];
  const seenNames = {};
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i] || {};
    const name = String(c.name || '').trim();
    const duration = parseInt(c.duration, 10);

    if (!name) {
      return { success: false, message: (i + 1) + '件目のコース名を入力してください。' };
    }
    if (!duration || duration < 1) {
      return { success: false, message: '「' + name + '」の滞在時間を1分以上で正しく入力してください。' };
    }
    if (seenNames[name]) {
      return { success: false, message: 'コース名「' + name + '」が重複しています。コース名は重複しないようにしてください。' };
    }
    seenNames[name] = true;
    cleaned.push({ name: name, duration: duration });
  }

  PropertiesService.getScriptProperties().setProperty(COURSES_PROPERTY_KEY, JSON.stringify(cleaned));
  return { success: true, courses: cleaned };
}

/**
 * コース設定を店舗設定の初期値(CONFIG.COURSES)に戻す(管理画面用)。要ログイン。
 */
function resetCoursesAdmin(token) {
  if (!isValidAdminToken(token)) {
    return { success: false, authError: true, message: 'ログインの有効期限が切れました。再度ログインしてください。' };
  }
  PropertiesService.getScriptProperties().deleteProperty(COURSES_PROPERTY_KEY);
  return { success: true, courses: CONFIG.COURSES };
}

function isValidAdminToken(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get('admin_' + token) === '1';
}

// ==================== ユーティリティ ====================

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow(SHEET_HEADERS);
    sheet.setFrozenRows(1);
  } else {
    // 既存シートに列(申込経路・LINE表示名など)が後から追加された場合、
    // ヘッダー行だけ自動で補完する(既存データの行はそのまま)。
    const lastCol = sheet.getLastColumn();
    if (lastCol < SHEET_HEADERS.length) {
      sheet.getRange(1, lastCol + 1, 1, SHEET_HEADERS.length - lastCol)
        .setValues([SHEET_HEADERS.slice(lastCol)]);
    }
  }
  return sheet;
}

/**
 * 指定日の「予約確定」中の予約を [{startMin, endMin, partySize}] の配列で返す。
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {number} [excludeRowIndex] 指定すると、その行(シート上の行番号)は集計から除外する
 *   (管理画面での予約変更時に、変更対象自身の現在の枠を空席計算に含めてしまわないため)
 */
function getConfirmedRangesForDate(dateStr, excludeRowIndex) {
  const sheet = getOrCreateSheet();
  const values = sheet.getDataRange().getValues();
  const ranges = [];

  for (let r = 1; r < values.length; r++) {
    if (excludeRowIndex && r + 1 === excludeRowIndex) continue;
    const row = values[r];
    if (String(row[COL.DATE]) !== dateStr) continue;
    if (row[COL.STATUS] !== STATUS_CONFIRMED) continue;

    const timeStr = row[COL.TIME];
    const start = parseDateTimeStr(dateStr, timeStr);
    if (!start || isNaN(start.getTime())) continue;

    const courseDef = getEffectiveCourses().filter(function (c) { return c.name === row[COL.COURSE]; })[0];
    const duration = courseDef ? courseDef.duration : CONFIG.SLOT_MINUTES;
    const end = new Date(start.getTime() + duration * 60000);

    ranges.push({
      startMin: minutesSinceMidnight(start),
      endMin: minutesSinceMidnight(end),
      partySize: Number(row[COL.PARTY_SIZE]) || 0,
    });
  }

  return ranges;
}

function sumOverlappingPartySize(ranges, startMin, endMin) {
  return ranges.reduce(function (sum, r) {
    const overlaps = startMin < r.endMin && endMin > r.startMin;
    return overlaps ? sum + r.partySize : sum;
  }, 0);
}

function buildBookingEmailBody(form, partySize) {
  const lines = [
    (form.name || '') + ' 様',
    '',
    'このたびはご予約いただき、誠にありがとうございます!',
    '当日をどうぞ楽しみにお待ちください♪',
    '',
    '━━━━━━━━━━━━━━━',
    'ご予約内容',
    '━━━━━━━━━━━━━━━',
    '日時: ' + form.date + ' ' + form.time,
    '人数: ' + partySize + '名',
    'コース: ' + form.course,
  ];
  if (form.notes) lines.push('ご要望: ' + form.notes);
  lines.push(
    '━━━━━━━━━━━━━━━',
    '',
    'スタッフ一同、心を込めてお迎えの準備をしてお待ちしております。',
    '当日お会いできる日を、私たちもとても楽しみにしています!',
    '',
    (CONFIG.STORE_NAME || '')
  );
  return lines.join('\n');
}

function sendCustomerConfirmationEmail(form, partySize) {
  if (!form.email) return;
  try {
    const subject = '[' + (CONFIG.STORE_NAME || 'ご予約') + '] ご予約確認 (' + form.date + ' ' + form.time + ')';
    MailApp.sendEmail(form.email, subject, buildBookingEmailBody(form, partySize));
  } catch (err) {
    Logger.log('お客様への確認メール送信エラー: ' + err.message);
  }
}

function sendBookingEmails(form, partySize) {
  sendCustomerConfirmationEmail(form, partySize);

  if (CONFIG.NOTIFY_EMAIL) {
    try {
      const staffSubject = '[新規予約] ' + form.date + ' ' + form.time + ' ' + form.name + '様 ' + partySize + '名';
      MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, staffSubject, buildBookingEmailBody(form, partySize) + '\n\n電話番号: ' + form.phone);
    } catch (err) {
      Logger.log('店舗への通知メール送信エラー: ' + err.message);
    }
  }
}

function sendWaitlistRegisteredEmail(form, partySize) {
  if (form.email) {
    try {
      const subject = '[' + (CONFIG.STORE_NAME || 'ご予約') + '] キャンセル待ちのご登録 (' + form.date + ' ' + form.time + ')';
      const body = [
        (form.name || '') + ' 様',
        '',
        'ご希望の時間帯は満席のため、キャンセル待ちとして登録いたしました。',
        '',
        'ご希望日時: ' + form.date + ' ' + form.time,
        '人数: ' + partySize + '名',
        'コース: ' + form.course,
        '',
        '空きが出た場合、折り返しご連絡いたします。恐れ入りますが、そのままお待ちください。',
        (CONFIG.STORE_NAME || ''),
      ].filter(function (s) { return s !== ''; }).join('\n');
      MailApp.sendEmail(form.email, subject, body);
    } catch (err) {
      Logger.log('キャンセル待ち登録メール送信エラー: ' + err.message);
    }
  }

  if (CONFIG.NOTIFY_EMAIL) {
    try {
      const staffSubject = '[キャンセル待ち登録] ' + form.date + ' ' + form.time + ' ' + form.name + '様 ' + partySize + '名';
      MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, staffSubject, '電話番号: ' + form.phone);
    } catch (err) {
      Logger.log('店舗への通知メール送信エラー: ' + err.message);
    }
  }
}

function sendWaitlistPromotedEmail(form, partySize) {
  if (!form.email) return;
  try {
    const subject = '[' + (CONFIG.STORE_NAME || 'ご予約') + '] ご予約確定のご連絡 (' + form.date + ' ' + form.time + ')';
    const body = [
      (form.name || '') + ' 様',
      '',
      'お待たせいたしました!キャンセルが出ましたので、キャンセル待ちいただいていたご予約が確定いたしました。',
      '当日をどうぞ楽しみにお待ちください♪',
      '',
      '━━━━━━━━━━━━━━━',
      'ご予約内容',
      '━━━━━━━━━━━━━━━',
      '日時: ' + form.date + ' ' + form.time,
      '人数: ' + partySize + '名',
      'コース: ' + form.course,
      '━━━━━━━━━━━━━━━',
      '',
      'スタッフ一同、心を込めてお迎えの準備をしてお待ちしております。',
      '当日お会いできる日を、私たちもとても楽しみにしています!',
      '',
      (CONFIG.STORE_NAME || ''),
    ].join('\n');
    MailApp.sendEmail(form.email, subject, body);
  } catch (err) {
    Logger.log('繰り上げ確定メール送信エラー: ' + err.message);
  }
}

function parseDateStr(dateStr) {
  // 'YYYY-MM-DD' -> Date (0時0分, ローカルタイム扱い)
  const parts = dateStr.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function parseDateTimeStr(dateStr, timeStr) {
  const dateParts = dateStr.split('-').map(Number);
  const timeParts = String(timeStr).split(':').map(Number);
  return new Date(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1] || 0, 0);
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * 短時間の大量送信(ボット等)を防ぐ簡易ガード。
 * 直近 WINDOW_SEC 秒間の送信回数をスクリプトキャッシュで数え、上限を超えたら拒否する。
 * submitBooking は LockService で排他制御されているため、この get→put は競合しない。
 */
function checkGlobalFloodGuard() {
  const rl = CONFIG.RATE_LIMIT;
  if (!rl) return null;

  const cache = CacheService.getScriptCache();
  const key = 'rl_global_count';
  const count = Number(cache.get(key)) || 0;
  if (count >= rl.MAX_SUBMISSIONS_PER_WINDOW) {
    return 'ただいまアクセスが集中しています。しばらく経ってから再度お試しください。';
  }
  cache.put(key, String(count + 1), rl.WINDOW_SEC);
  return null;
}

/**
 * 同じ電話番号からの連続送信(二重送信・いたずら送信)を防ぐ簡易ガード。
 */
function checkPhoneRateLimit(phone) {
  const rl = CONFIG.RATE_LIMIT;
  if (!rl || !phone) return null;

  if (CacheService.getScriptCache().get('rl_phone_' + phone) === '1') {
    return 'ご送信を受け付けています。連続してのご送信はできません。少し時間をおいてから再度お試しください。';
  }
  return null;
}

function markPhoneRateLimit(phone) {
  const rl = CONFIG.RATE_LIMIT;
  if (!rl || !phone) return;
  CacheService.getScriptCache().put('rl_phone_' + phone, '1', rl.MIN_INTERVAL_SEC_PER_PHONE);
}
