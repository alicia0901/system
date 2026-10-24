/* ============================================================
   js/content.js の内容をページに流し込む処理。
   通常の更新ではこのファイルを編集する必要はありません。
   ============================================================ */
(function () {
  'use strict';

  var C = window.SITE_CONTENT;
  if (!C) return;

  var RANK_KEYS = ['rookie', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'predator'];

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 'coach.name' のようなパスで値を取り出す
  function lookup(path) {
    return path.split('.').reduce(function (obj, key) {
      return obj == null ? undefined : obj[key];
    }, C);
  }

  function rankClass(rank) {
    var key = String(rank || '').toLowerCase();
    return RANK_KEYS.indexOf(key) >= 0 ? 'rank-' + key : 'rank-other';
  }

  function sampleTag() {
    return C.sampleMode ? '<span class="sample-tag">SAMPLE</span>' : '';
  }

  var CHECK_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.6 13.6 4 10l-1.4 1.4 5 5 10-10L16.2 5z"/></svg>';

  var renderers = {
    stats: function (s) {
      return '<li class="stat"><p class="stat-value">' + esc(s.value) +
        '<span class="stat-unit">' + esc(s.unit) + '</span></p>' +
        '<p class="stat-label">' + esc(s.label) + '</p></li>';
    },
    features: function (f, i) {
      var num = ('0' + (i + 1)).slice(-2);
      return '<li class="feature"><span class="feature-num">' + num + '</span>' +
        '<h3 class="feature-title">' + esc(f.title) + '</h3>' +
        '<p class="feature-text">' + esc(f.text) + '</p></li>';
    },
    'coach.achievements': function (a) {
      return '<li>' + CHECK_ICON + '<span>' + esc(a) + '</span></li>';
    },
    results: function (r) {
      var img = r.image
        ? '<img class="result-img" src="' + esc(r.image) + '" alt="' + esc(r.name) + 'さんのランク実績" loading="lazy">'
        : '';
      return '<li class="result">' + sampleTag() + img +
        '<div class="result-ranks">' +
          '<span class="rank ' + rankClass(r.from) + '">' + esc(r.from) + '</span>' +
          '<span class="result-arrow" aria-label="から">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4z"/></svg>' +
          '</span>' +
          '<span class="rank rank-to ' + rankClass(r.to) + '">' + esc(r.to) + '</span>' +
        '</div>' +
        '<p class="result-meta"><span class="result-name">' + esc(r.name) + '</span>' +
        '<span>' + esc(r.device) + '</span><span>' + esc(r.period) + '</span></p></li>';
    },
    voices: function (v) {
      return '<li class="voice">' + sampleTag() +
        '<p class="voice-text">' + esc(v.text) + '</p>' +
        '<p class="voice-who"><span class="voice-name">' + esc(v.name) + '</span>' +
        '<span class="voice-meta">' + esc(v.meta) + '</span></p></li>';
    },
    plans: function (p) {
      var items = (p.features || []).map(function (f) {
        return '<li>' + CHECK_ICON + '<span>' + esc(f) + '</span></li>';
      }).join('');
      return '<li class="plan' + (p.recommended ? ' is-recommended' : '') + '">' +
        (p.recommended ? '<p class="plan-badge">おすすめ</p>' : '') +
        '<h3 class="plan-name">' + esc(p.name) + '</h3>' +
        '<p class="plan-price"><span class="plan-yen">¥</span>' + esc(p.price) +
        '<span class="plan-unit">' + esc(p.unit) + '</span></p>' +
        '<p class="plan-desc">' + esc(p.description) + '</p>' +
        '<ul class="plan-features">' + items + '</ul>' +
        '<a class="btn ' + (p.recommended ? 'btn-primary' : 'btn-outline') + ' js-dm" href="#" target="_blank" rel="noopener">' +
        'このプランで相談する</a></li>';
    },
    flow: function (f, i) {
      return '<li class="flow-step"><span class="flow-num">STEP ' + (i + 1) + '</span>' +
        '<h3 class="flow-title">' + esc(f.title) + '</h3>' +
        '<p class="flow-text">' + esc(f.text) + '</p></li>';
    },
    faq: function (f) {
      return '<details class="faq-item"><summary><span class="faq-q">Q</span><span class="faq-question">' +
        esc(f.q) + '</span><span class="faq-toggle" aria-hidden="true"></span></summary>' +
        '<div class="faq-answer"><span class="faq-a">A</span><p>' + esc(f.a) + '</p></div></details>';
    }
  };

  // --- テキスト・画像の差し込み ---
  document.querySelectorAll('[data-bind]').forEach(function (el) {
    el.textContent = lookup(el.getAttribute('data-bind')) || '';
  });
  // タイトル系のみ <br> と <em> を許可する
  document.querySelectorAll('[data-bind-html]').forEach(function (el) {
    var html = esc(lookup(el.getAttribute('data-bind-html')) || '')
      .replace(/&lt;br\s*\/?&gt;/g, '<br>')
      .replace(/&lt;em&gt;/g, '<em>')
      .replace(/&lt;\/em&gt;/g, '</em>');
    el.innerHTML = html;
  });
  document.querySelectorAll('[data-bind-src]').forEach(function (el) {
    var src = lookup(el.getAttribute('data-bind-src'));
    if (src) el.setAttribute('src', src);
  });

  // --- 一覧の描画 ---
  document.querySelectorAll('[data-list]').forEach(function (el) {
    var key = el.getAttribute('data-list');
    var items = lookup(key) || [];
    var render = renderers[key];
    if (!render) return;
    el.innerHTML = items.map(render).join('');
  });

  // --- XのDM / プロフィールへのリンク ---
  var x = C.x || {};
  var handle = String(x.handle || '').replace(/^@/, '');
  var profileUrl = 'https://x.com/' + encodeURIComponent(handle);
  var dmUrl = x.userId
    ? 'https://x.com/messages/compose?recipient_id=' + encodeURIComponent(x.userId) +
      (x.dmText ? '&text=' + encodeURIComponent(x.dmText) : '')
    : profileUrl;

  document.querySelectorAll('.js-dm').forEach(function (a) { a.href = dmUrl; });
  document.querySelectorAll('.js-profile').forEach(function (a) { a.href = profileUrl; });
  document.querySelectorAll('.js-year').forEach(function (el) { el.textContent = new Date().getFullYear(); });

  // --- サンプル表示の帯 ---
  if (C.sampleMode) {
    document.body.classList.add('is-sample');
    var bar = document.createElement('div');
    bar.className = 'sample-bar';
    bar.textContent = 'サンプル表示中:数字・実績・受講者の声・料金は仮の内容です';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // --- よくある質問を検索エンジン向けの構造化データとして出力 ---
  if (C.faq && C.faq.length) {
    var ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: C.faq.map(function (f) {
        return { '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } };
      })
    });
    document.head.appendChild(ld);
  }

  // --- スクロール時の演出・ヘッダー ---
  var header = document.querySelector('.site-header');
  var sticky = document.querySelector('.sticky-cta');
  var hero = document.querySelector('.hero');
  function onScroll() {
    var y = window.scrollY;
    header.classList.toggle('is-scrolled', y > 10);
    if (sticky && hero) sticky.classList.toggle('is-visible', y > hero.offsetHeight * 0.6);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if ('IntersectionObserver' in window) {
    var targets = document.querySelectorAll('.section-head, .feature, .coach, .result, .voice, .plan, .flow-step, .faq-item');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    document.documentElement.classList.add('has-reveal');
    targets.forEach(function (t) { io.observe(t); });
  }
})();
