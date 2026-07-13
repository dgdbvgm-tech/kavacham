/* ============================================================
   KAVACHAM Lab — TMA (Этап 1: 4 вкладки).
   Ваниль, без сборки, без внешних зависимостей.

   Инварианты:
   - Работает БЕЗ Telegram: в обычном браузере это обычная веб-страница
     (Полигон читается; формы НЕ изображают отправку, а уводят в бота).
   - Подпись заявки — только непустая initData (HMAC проверяет сервер).
     user.id из initDataUnsafe для авторизации не используется НИКОГДА;
     имя оттуда — только чтобы показать человеку его же имя в строке статуса.
   - Читает data/feed.json и data/reading/<slug>.json (зона генератора)
     и REST API бота (заявки, корпуса).
   - Ничего не выдумывает: статусы, корпуса и материалы — только то, что
     реально приходит с сервера или из ленты.
   ============================================================ */
(function () {
  'use strict';

  // ——— Telegram SDK: есть объект, но «мы правда внутри Telegram?» — отдельный вопрос.
  // telegram-web-app.js создаёт window.Telegram.WebApp и в обычном браузере,
  // но platform там === 'unknown'. Это и есть честный признак.
  var tg = (window.Telegram && window.Telegram.WebApp) || null;
  var inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');

  var BOT_URL = 'https://t.me/kavacham_lab_bot';
  var LANDING = 'https://dgdbvgm-tech.github.io/kavacham/';
  var CATALOG = LANDING + 'corpus.html';
  // REST API («Терминал»/«Мои испытания»/корпуса) — та же очередь, что у бота.
  var API_BASE = 'https://kavacham-bot-928986955802.us-central1.run.app';
  // База, относительно которой раскрываются относительные пути ленты (pages_url)
  // в АБСОЛЮТНЫЕ — для шаринга. location.href тут не годится: с localhost
  // поделиться нечем.
  var APP_BASE = LANDING + 'app/';

  // Прямая ссылка-приложение t.me/kavacham_lab_bot/reader ЕЩЁ НЕ ЖИВАЯ:
  // short_name «reader» регистрируется в BotFather (/newapp) — это шаг человека
  // после деплоя. Пока её нет — делимся тем, что ТОЧНО откроется у получателя:
  // статической страницей разбора на Pages (она же — путь при блокировке TMA).
  // ПОСЛЕ регистрации short_name достаточно вписать сюда строку — шаринг
  // и deep-link переключатся сами:
  //   var APP_DIRECT_LINK = 'https://t.me/kavacham_lab_bot/reader';
  var APP_DIRECT_LINK = null;

  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;

  // ——— Мелкие утилиты ——————————————————————————————————————
  function haptic(kind) {
    if (!inTelegram || !tg.HapticFeedback) return;
    try {
      if (kind === 'select') tg.HapticFeedback.selectionChanged();
      else if (kind === 'success' || kind === 'error' || kind === 'warning') {
        tg.HapticFeedback.notificationOccurred(kind);
      } else tg.HapticFeedback.impactOccurred(kind || 'light');
    } catch (e) { /* тактильная отдача — украшение, не функция */ }
  }

  // ——— Аутентификация ——————————————————————————————————————
  // Единственный признак «я правда в Telegram и меня можно подписать» — непустая
  // initData. user.id из initDataUnsafe НЕ используется: подписи в нём нет,
  // доверять ему нельзя (и бэкенд его не принимает — он проверяет HMAC).
  function initData() {
    return (inTelegram && typeof tg.initData === 'string') ? tg.initData : '';
  }
  function authed() { return initData().length > 0; }

  // Один сетевой шов на все вызовы API: подпись в заголовке, ошибка — по-русски.
  function api(path, opts) {
    var o = opts || {};
    var headers = { 'X-Telegram-InitData': initData() };
    var init = { method: o.method || 'GET', headers: headers };
    if (o.body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.body);
    }
    return fetch(API_BASE + path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!r.ok) {
          var msg = (data && data.error) ? data.error
            : (r.status === 401 ? 'Подпись Telegram не принята. Откройте приложение заново из бота.'
                                : 'Сервер ответил ошибкой (' + r.status + ').');
          var err = new Error(msg);
          err.status = r.status;
          throw err;
        }
        if (!data) throw new Error('Сервер вернул пустой ответ.');
        return data;
      });
    }, function () {
      throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    });
  }

  function openExternal(url) {
    if (inTelegram && typeof tg.openLink === 'function') tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  function openTelegram(url) {
    if (inTelegram && typeof tg.openTelegramLink === 'function') tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  // slug из хэша не доверяем: только безопасный набор, иначе не строим путь к JSON
  function safeSlug(s) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(s || '') ? s : null;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    var months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + m[1];
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  var KIND_LABEL = { mega: 'Мега-разбор', razbor: 'Разбор', map: 'Карта' };

  function showState(el, html, isErr) {
    el.innerHTML = html;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
  }

  function prefersReduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Прокрутка к блоку экрана. Идёт ПОСЛЕ route()-ного scrollTo(0,0), поэтому
  // откладываем на следующий кадр — иначе роутер сбросит нашу прокрутку.
  function scrollToEl(el) {
    if (!el) return;
    setTimeout(function () {
      try {
        el.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'start' });
      } catch (e) { el.scrollIntoView(); }
    }, 0);
  }

  // ——— Тема ————————————————————————————————————————————————
  // Ведущая — наша палитра. Telegram задаёт лишь ВЫБОР темы (dark/light).
  // Ручной переключатель важнее автоматики и переживает перезапуск.
  var THEME_KEY = 'kavacham.theme';

  function systemTheme() {
    if (inTelegram && tg.colorScheme) return tg.colorScheme === 'light' ? 'light' : 'dark';
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    var glyph = $('themeGlyph');
    if (glyph) glyph.textContent = theme === 'dark' ? '◐' : '◑';
    // мягкая синхронизация «хрома» Telegram с нашим navy — приложение не выглядит чужой вкладкой
    if (inTelegram) {
      try {
        var deep = getComputedStyle(root).getPropertyValue('--deep').trim() || '#0C1030';
        if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor(deep);
        if (typeof tg.setBackgroundColor === 'function') {
          tg.setBackgroundColor(getComputedStyle(root).getPropertyValue('--ground').trim() || deep);
        }
      } catch (e) { /* старый клиент — переживём без окраски хрома */ }
    }
  }

  var stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* приватный режим */ }
  applyTheme(stored === 'light' || stored === 'dark' ? stored : systemTheme());

  $('btnTheme').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
    haptic('select');
  });

  // тема системы/Telegram сменилась, а пользователь не выбирал вручную — следуем за ней
  function followSystem() {
    var manual = null;
    try { manual = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (!manual) applyTheme(systemTheme());
  }
  if (inTelegram && typeof tg.onEvent === 'function') tg.onEvent('themeChanged', followSystem);
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', followSystem);
  }

  // ——— Вьюпорт и безопасные зоны ————————————————————————————
  function syncViewport() {
    if (!inTelegram) return;
    if (tg.viewportStableHeight) {
      root.style.setProperty('--tma-vh', tg.viewportStableHeight + 'px');
    }
    // инсеты Telegram (Bot API 8.0+); в старых клиентах их нет — остаётся env()
    var sa = tg.safeAreaInset, csa = tg.contentSafeAreaInset;
    function px(v) { return (typeof v === 'number' ? v : 0) + 'px'; }
    if (sa) {
      root.style.setProperty('--sa-bottom', px(sa.bottom));
      root.style.setProperty('--sa-left', px(sa.left));
      root.style.setProperty('--sa-right', px(sa.right));
      root.style.setProperty('--sa-top', px((sa.top || 0) + ((csa && csa.top) || 0)));
    }
  }

  // ——— Роутер ——————————————————————————————————————————————
  // 4 вкладки + экран разбора (вкладки не имеет, подсвечивает «Полигон»).
  var SCREENS = {
    terminal: { el: 'screen-terminal', tab: 'terminal', back: false },
    polygon:  { el: 'screen-polygon',  tab: 'polygon',  back: false },
    reading:  { el: 'screen-reading',  tab: 'polygon',  back: true  },
    enrich:   { el: 'screen-enrich',   tab: 'enrich',   back: false },
    about:    { el: 'screen-about',    tab: 'about',    back: false }
  };

  var SEGS = { razbory: 'pane-razbory', sri: 'pane-sri', corpus: 'pane-corpus' };

  var current = { name: 'terminal', slug: null, seg: 'razbory', rubric: null };

  // Ссылка на срез Полигона — единственное место, где собирается маршрут ленты.
  function polygonHash(seg, rubric) {
    var h = '#/polygon?seg=' + (seg || 'razbory');
    if (rubric) h += '&rubric=' + encodeURIComponent(rubric);
    return h;
  }

  // Разбор хэша + СОВМЕСТИМОСТЬ со старыми маршрутами.
  // На #/reading/<slug> ведут ссылки из бота и со статических страниц, а #/reader,
  // #/submit, #/profile могли остаться у людей в истории и закладках. Они обязаны
  // приводить туда же, куда раньше, — иначе ссылка «протухла» молча.
  function parseHash() {
    var raw = (location.hash || '').replace(/^#\/?/, '');

    var q = '';
    var qi = raw.indexOf('?');
    if (qi >= 0) { q = raw.slice(qi + 1); raw = raw.slice(0, qi); }

    var p = Object.create(null);
    q.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      var k = kv.slice(0, i);
      var v = decodeURIComponent(kv.slice(i + 1) || '');
      if (k) p[k] = v;
    });

    var rubric = (/^[a-z0-9_-]{1,40}$/i.test(p.rubric || '')) ? p.rubric : null;
    var seg = SEGS[p.seg] ? p.seg : 'razbory';

    var parts = raw.split('/').filter(Boolean);
    var head = parts[0] || '';

    // — старые маршруты → новые экраны (редирект, а не 404) —
    if (head === 'reader') {
      return { redirect: polygonHash('razbory', rubric) };
    }
    if (head === 'submit') {
      return { redirect: '#/terminal?form=1' };
    }
    if (head === 'profile') {
      return { redirect: '#/terminal?focus=mine' };
    }

    if (head === 'reading' && parts[1]) {
      return { name: 'reading', slug: parts[1], seg: 'razbory', rubric: null };
    }
    if (SCREENS[head] && head !== 'reading') {
      return {
        name: head,
        slug: null,
        seg: seg,
        rubric: rubric,
        form: p.form === '1',
        focus: p.focus || null
      };
    }
    // пустой/неизвестный хэш — стартовый экран
    return { name: 'terminal', slug: null, seg: 'razbory', rubric: null };
  }

  function setBackButton(show) {
    var btn = $('btnBack');
    // в Telegram back рисует сам клиент — свою кнопку не дублируем
    if (inTelegram && tg.BackButton) {
      btn.hidden = true;
      try { show ? tg.BackButton.show() : tg.BackButton.hide(); } catch (e) {}
    } else {
      btn.hidden = !show;
    }
  }

  var mainHandler = null;
  var mainIsSend = false;   // MainButton сейчас = «Отправить вызов» (только тогда его валидируем)

  function setMainButton(text, handler) {
    if (!inTelegram || !tg.MainButton) return;
    try {
      if (mainHandler) tg.MainButton.offClick(mainHandler);
      mainHandler = null;
      if (!text) {
        tg.MainButton.hide();
        document.body.classList.remove('tma-has-mainbutton');
        return;
      }
      mainHandler = handler;
      tg.MainButton.setText(text);
      tg.MainButton.onClick(mainHandler);
      tg.MainButton.enable();
      tg.MainButton.show();
      document.body.classList.add('tma-has-mainbutton');
    } catch (e) { /* старый клиент — экранных кнопок достаточно */ }
  }

  // куда возвращает «назад» из разбора: в тот же срез ленты, из которого ушли
  var lastFeedHash = polygonHash('razbory', null);

  function route() {
    var r = parseHash();

    if (r.redirect) { location.replace(r.redirect); return; }

    var prev = current;
    current = r;

    Object.keys(SCREENS).forEach(function (name) {
      $(SCREENS[name].el).hidden = (name !== r.name);
    });

    var tab = SCREENS[r.name].tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (a) {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    setBackButton(SCREENS[r.name].back);
    setMainButton(null);
    mainIsSend = false;

    // смена рубрики внутри одного среза — не «новый экран»: не дёргаем скролл и фокус
    var sameSlice = (prev.name === r.name && r.name === 'polygon' && prev.seg === r.seg);
    if (!sameSlice) {
      window.scrollTo(0, 0);
      $('main').focus({ preventScroll: true });
    }

    if (r.name === 'reading') loadReading(r.slug);
    else if (r.name === 'polygon') enterPolygon(r);
    else if (r.name === 'terminal') enterTerminal(r);
  }

  function goBack() {
    if (current.name === 'reading') location.hash = lastFeedHash;
    else if (history.length > 1) history.back();
    else location.hash = '#/terminal';
  }

  $('btnBack').addEventListener('click', function () { haptic('light'); goBack(); });

  /* ══════════════════════════════════════════════════════════════════
     ТЕРМИНАЛ (вкладка 1) — строка статуса, заявка, «Мои испытания».
     Форма и список заявок — ТОТ ЖЕ код, что был в «Приёмной»/«Кабинете»:
     те же id, те же функции, тот же API. Изменилась только оболочка
     (раскрывающаяся панель) и владелец MainButton — теперь он один
     на экран, а не по одному на каждый бывший экран.
     ══════════════════════════════════════════════════════════════════ */

  var formOpen = false;   // панель заявки раскрыта
  var doneShown = false;  // заявка отправлена, показан итог

  // Строка статуса. Имя берём из initDataUnsafe — это НЕподписанные данные,
  // и годятся они ровно на одно: показать человеку его же имя в его же клиенте.
  // Ни в один запрос к серверу оно не уходит (там подпись initData).
  function renderOps() {
    var el = $('opsLine');
    el.textContent = '';

    var u = (inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    var name = u ? String(u.first_name || u.username || '').trim() : '';
    var known = authed() && !!name;

    function cell(k, v, cls) {
      var w = document.createElement('span');
      w.className = 'ops-c' + (cls ? ' ' + cls : '');
      var kk = document.createElement('span');
      kk.className = 'ops-k';
      kk.textContent = k;
      var vv = document.createElement('span');
      vv.className = 'ops-v';
      vv.textContent = v;
      w.appendChild(kk);
      w.appendChild(vv);
      return w;
    }

    el.appendChild(cell('Оператор', known ? name : 'гость'));
    el.appendChild(cell('Статус', 'тестировщик'));
    // вне Telegram подписи нет — говорим об этом прямо, а не делаем вид, что всё как обычно
    if (!authed()) el.appendChild(cell('Режим', 'чтение', 'ops-warn'));
  }

  function openForm() {
    formOpen = true;
    doneShown = false;
    syncInit();
    syncTerminalMain();
    scrollToEl($('initPanel'));
  }

  // Раскрытие/сворачивание панели заявки. Хэш при этом НЕ трогаем: иначе
  // route() перезапустится и «Мои испытания» полезут в сеть на каждый клик.
  function syncInit() {
    var btn = $('btnInit'), panel = $('initPanel');
    btn.setAttribute('aria-expanded', formOpen ? 'true' : 'false');
    btn.classList.toggle('on', formOpen);
    panel.hidden = !formOpen;
    if (formOpen) mountSubmit();
  }

  $('btnInit').addEventListener('click', function () {
    haptic('medium');
    formOpen = !formOpen;
    if (formOpen) doneShown = false;
    syncInit();
    syncTerminalMain();
    if (formOpen) scrollToEl($('initPanel'));
  });

  // MainButton у экрана один — и на Терминале он занят ровно одним делом:
  // «Отправить вызов». Дублировать им экранные кнопки («Инициировать разбор»,
  // «Мои испытания») нельзя: на 390×600 два одинаковых золотых действия —
  // это шум, а не навигация. Все прочие действия живут на экране.
  function syncTerminalMain() {
    mainIsSend = false;

    if (authed() && formOpen && !doneShown) {
      mainIsSend = true;
      setMainButton('Отправить вызов', trySend);
      syncMain();          // пустой/короткий текст — кнопка выключена
      return;
    }
    setMainButton(null);
  }

  function enterTerminal(r) {
    renderOps();

    if (r.form) { formOpen = true; doneShown = false; }
    syncInit();
    mountProfile();
    syncTerminalMain();

    if (r.focus === 'mine') scrollToEl($('mineBlock'));
    else if (r.form) scrollToEl($('initPanel'));
  }

  /* ══════════════════════════════════════════════════════════════════
     ПОЛИГОН (вкладка 2) — Разборы / Индекс SRI / Доверенный контур.
     Раздел А — та же лента, что была в «Читальне» (тот же код и те же id).
     ══════════════════════════════════════════════════════════════════ */

  function enterPolygon(r) {
    Object.keys(SEGS).forEach(function (k) {
      $(SEGS[k]).hidden = (k !== r.seg);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.seg-b'), function (a) {
      if (a.dataset.seg === r.seg) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });

    if (r.seg === 'razbory') {
      lastFeedHash = polygonHash('razbory', r.rubric);
      loadFeed(r.rubric);
    } else if (r.seg === 'sri') {
      loadSri();
    } else if (r.seg === 'corpus') {
      loadCorpus();
    }
  }

  // ——— Лента ————————————————————————————————————————————————
  // Лента — единственный источник правды по адресам разбора: в feed.json есть
  // контрактные поля reading_url (JSON для читальни) и pages_url (статическая
  // страница Pages). Склеивать пути из слага руками нельзя: сменит генератор
  // раскладку — читальня начнёт молча 404-ить, хотя правильный адрес лежит в ленте.
  var feedPromise = null;                 // fetch ленты — один на всё приложение
  var feedIndex = Object.create(null);    // slug → элемент ленты (без прототипа!)
  var feedOk = false;                     // лента прочитана (значит, её индексу можно верить)
  var feedItems = [];                     // items как есть (уже отсортированы генератором)
  var rubrics = [];                       // [{key,title,order}] — ИЗ ленты, не из кода
  var rubricByKey = Object.create(null);

  // рубрика элемента: контрактное поле rubric; kind — совместимость со старой лентой
  function itemRubric(it) {
    return (it && (it.rubric || it.kind)) || 'razbor';
  }
  function rubricTitle(key) {
    return (rubricByKey[key] && rubricByKey[key].title) || KIND_LABEL[key] || 'Материал';
  }

  function fetchFeed() {
    if (!feedPromise) {
      feedPromise = fetch('data/feed.json', { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          feedItems = (data && Array.isArray(data.items)) ? data.items : [];
          feedItems.forEach(function (it) {
            if (it && typeof it.slug === 'string' && it.slug) feedIndex[it.slug] = it;
          });

          // порядок и названия рубрик — из ленты; в коде их нет ни строчкой
          var declared = (data && Array.isArray(data.rubrics)) ? data.rubrics.slice() : [];
          declared = declared.filter(function (r) { return r && r.key && r.title; });
          declared.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
          rubricByKey = Object.create(null);
          declared.forEach(function (r) { rubricByKey[r.key] = r; });
          // рубрика, объявленная в items, но не в rubrics — не теряем материал
          feedItems.forEach(function (it) {
            var k = itemRubric(it);
            if (!rubricByKey[k]) {
              var r = { key: k, title: KIND_LABEL[k] || k, order: 900 };
              rubricByKey[k] = r;
              declared.push(r);
            }
          });
          rubrics = declared;

          feedOk = true;
          return feedItems;
        });
    }
    return feedPromise;
  }

  // Адреса разбора: сперва контракт ленты, и только если элемента нет
  // (прямой deep-link на разбор, которого нет в ленте) — договорная раскладка.
  function readingUrlFor(slug) {
    var it = feedIndex[slug];
    return (it && typeof it.reading_url === 'string' && it.reading_url)
      ? it.reading_url
      : 'data/reading/' + encodeURIComponent(slug) + '.json';
  }

  function pagesUrlFor(slug) {
    var it = feedIndex[slug];
    return (it && typeof it.pages_url === 'string' && it.pages_url)
      ? it.pages_url
      : '../reading/' + encodeURIComponent(slug) + '.html';
  }

  // Ссылка, которой можно поделиться: пока short_name не зарегистрирован —
  // абсолютный адрес страницы на Pages (открывается у всех, в том числе там,
  // где TMA заблокирована).
  function shareUrlFor(slug) {
    if (APP_DIRECT_LINK) return APP_DIRECT_LINK + '?startapp=' + encodeURIComponent(slug);
    try { return new URL(pagesUrlFor(slug), APP_BASE).href; } catch (e) { return LANDING; }
  }

  function loadFeed(rubric) {
    var stateEl = $('feedState'), listEl = $('feedList'), navEl = $('rubrics');

    fetchFeed()
      .then(function (items) {
        if (!items.length) {
          showState(stateEl,
            '<span class="state-h">Лента пока пуста</span>' +
            'Первые разборы появятся здесь сразу после публикации. Пока их можно читать в канале Лаборатории.', false);
          listEl.hidden = true;
          navEl.hidden = true;
          return;
        }

        // рубрика из маршрута, которой в ленте нет — молча показываем всё
        var active = (rubric && rubricByKey[rubric]) ? rubric : null;
        renderRubrics(active);

        var slice = active
          ? items.filter(function (it) { return itemRubric(it) === active; })
          : items;

        renderFeed(slice, listEl);
        stateEl.hidden = true;
        listEl.hidden = false;
      })
      .catch(function (err) {
        // упавший промис нельзя кэшировать: иначе «Повторить» переиспользует ту же
        // ошибку и повтора не произойдёт вовсе
        feedPromise = null;
        showState(stateEl,
          '<span class="state-h">Не удалось загрузить ленту</span>' +
          'Похоже, нет связи. Разборы всегда доступны в боте и на сайте — это и есть запасной путь.' +
          '<br><button class="btn btn-ghost" type="button" data-retry-feed>Повторить</button>', true);
        listEl.hidden = true;
        navEl.hidden = true;
        if (window.console) console.warn('[kavacham] feed:', err && err.message);
      });
  }

  // Чипы рубрик: «Все» + непустые рубрики со счётчиком. Выбор — ссылка на маршрут,
  // а не внутреннее состояние: тогда «назад» Telegram возвращает в тот же срез.
  function renderRubrics(active) {
    var navEl = $('rubrics');
    navEl.textContent = '';

    var counts = Object.create(null);
    feedItems.forEach(function (it) {
      var k = itemRubric(it);
      counts[k] = (counts[k] || 0) + 1;
    });

    var shown = rubrics.filter(function (r) { return counts[r.key]; });
    if (shown.length < 2) { navEl.hidden = true; return; }

    function chip(key, title, count) {
      var a = document.createElement('a');
      a.className = 'chip' + (key === active ? ' on' : '');
      a.href = polygonHash('razbory', key);
      if (key === active) a.setAttribute('aria-current', 'true');
      var t = document.createElement('span');
      t.textContent = title;
      a.appendChild(t);
      var c = document.createElement('span');
      c.className = 'chip-n';
      c.textContent = String(count);
      a.appendChild(c);
      a.addEventListener('click', function () { haptic('select'); });
      return a;
    }

    navEl.appendChild(chip(null, 'Все', feedItems.length));
    shown.forEach(function (r) { navEl.appendChild(chip(r.key, r.title, counts[r.key])); });
    navEl.hidden = false;

    // Растушёвка правого края держится, пока строка рубрик не докручена до конца.
    var syncFade = function () {
      var atEnd = navEl.scrollLeft + navEl.clientWidth >= navEl.scrollWidth - 2;
      navEl.classList.toggle('at-end', atEnd);
    };
    navEl.addEventListener('scroll', syncFade, { passive: true });
    syncFade();

    // Активная рубрика — в поле зрения, даже если уехала за правый край.
    var on = navEl.querySelector('.chip.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Карточка ленты. listEl — параметр: тем же кодом рисуем и ленту разборов,
  // и подборку SRI (одна карточка на две поверхности, а не две реализации).
  function renderFeed(items, listEl) {
    listEl.textContent = '';

    items.forEach(function (it) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'feed-card';
      a.href = '#/reading/' + encodeURIComponent(it.slug || '');

      var rk = itemRubric(it);
      var top = document.createElement('div');
      top.className = 'feed-top';
      var kind = document.createElement('span');
      kind.className = 'kind k-' + rk;
      kind.textContent = rubricTitle(rk);
      top.appendChild(kind);
      // номер по оси рубрики — только если он есть; выдумывать нумерацию нельзя
      if (typeof it.number === 'number' && it.number > 0) {
        var num = document.createElement('span');
        num.className = 'num';
        num.textContent = '№' + it.number;
        top.appendChild(num);
      }
      a.appendChild(top);

      var h = document.createElement('h2');
      h.textContent = it.title || 'Без заголовка';
      a.appendChild(h);

      // Карточка — витрина: один тизер, а не два. Подзаголовок и выжимка почти
      // всегда пересказывают одно и то же, вдвоём они раздували карточку так,
      // что на экран помещался один материал. Подзаголовок точнее — он авторский.
      var teaser = it.subtitle || it.excerpt;
      if (teaser) {
        var sub = document.createElement('p');
        sub.className = it.subtitle ? 'feed-sub' : 'feed-ex';
        sub.textContent = teaser;
        a.appendChild(sub);
      }

      var meta = document.createElement('div');
      meta.className = 'feed-meta';
      if (it.date) {
        var d = document.createElement('span');
        d.textContent = fmtDate(it.date);
        meta.appendChild(d);
      }
      if (typeof it.pramanas === 'number' && it.pramanas > 0) {
        var p = document.createElement('span');
        p.textContent = it.pramanas + ' ' + plural(it.pramanas, 'прамана', 'праманы', 'праман');
        meta.appendChild(p);
      }
      if (meta.childNodes.length) a.appendChild(meta);

      if (Array.isArray(it.tags) && it.tags.length) {
        var tags = document.createElement('div');
        tags.className = 'feed-tags';
        it.tags.slice(0, 3).forEach(function (t) {
          var s = document.createElement('span');
          s.className = 'tag';
          s.textContent = t;
          tags.appendChild(s);
        });
        a.appendChild(tags);
      }

      a.addEventListener('click', function () { haptic('light'); });
      li.appendChild(a);
      listEl.appendChild(li);
    });
  }

  // ——— Раздел Б: Индекс SRI ————————————————————————————————
  // Узлов SRI в данных НЕТ: ни в ленте, ни в API нет коллекции «узел SRI-NNN».
  // Есть материалы про SRI (карта парадоксов). Их и показываем — как вход в тему.
  // Признак материала SRI берём из данных (слаг/заголовок), а не из списка в коде:
  // появится в ленте новый материал SRI — он подтянется сам, без правки кода.
  function isSriItem(it) {
    var s = String((it && it.slug) || '');
    var t = String((it && it.title) || '');
    return /(^|[-_])sri([-_]|$)/i.test(s) || /\bSRI\b/.test(t);
  }

  function loadSri() {
    var stateEl = $('sriState'), listEl = $('sriList');

    fetchFeed()
      .then(function (items) {
        var list = items.filter(isSriItem);
        if (!list.length) {
          showState(stateEl,
            '<span class="state-h">Материалов SRI пока нет</span>' +
            'Первые узлы появятся здесь после ратификации автором проекта.', false);
          listEl.hidden = true;
          return;
        }
        renderFeed(list, listEl);
        stateEl.hidden = true;
        listEl.hidden = false;
      })
      .catch(function (err) {
        feedPromise = null;
        showState(stateEl,
          '<span class="state-h">Не удалось загрузить материалы</span>' +
          'Похоже, нет связи.' +
          '<br><button class="btn btn-ghost" type="button" data-retry-sri>Повторить</button>', true);
        listEl.hidden = true;
        if (window.console) console.warn('[kavacham] sri:', err && err.message);
      });
  }

  // ——— Раздел В: Доверенный контур ————————————————————————
  // Состав корпусов — РЕАЛЬНЫЙ ответ сервера (GET /api/scopes; эндпоинт публичный,
  // подписи не требует, поэтому каталог виден и вне Telegram). Тот же список
  // питает чипы в форме заявки: один запрос, две поверхности.
  var scopesReq = null;

  function fetchScopes() {
    if (!scopesReq) {
      scopesReq = api('/api/scopes').then(function (d) { return d || {}; });
    }
    return scopesReq;
  }

  function loadCorpus() {
    var stateEl = $('corpState'), listEl = $('corpList');
    listEl.hidden = true;
    showState(stateEl, 'Загружаю корпуса…', false);

    fetchScopes().then(function (d) {
      var scopes = (d && Array.isArray(d.scopes)) ? d.scopes : [];

      // адрес каталога тоже приходит с сервера — в коде он лишь запасной
      var cat = (d && typeof d.catalog_url === 'string' && /^https?:\/\//i.test(d.catalog_url))
        ? d.catalog_url : CATALOG;
      $('corpCatalog').href = cat;

      if (!scopes.length) {
        showState(stateEl, 'Сервер вернул пустой список корпусов. Разбор идёт по основе — Шрила Прабхупада.', false);
        return;
      }

      listEl.textContent = '';
      scopes.forEach(function (s) {
        if (!s || !s.key) return;
        var li = document.createElement('li');
        li.className = 'corp-i';

        var top = document.createElement('div');
        top.className = 'corp-top';

        var t = document.createElement('span');
        t.className = 'corp-t';
        t.textContent = s.title || s.key;
        top.appendChild(t);

        var b = document.createElement('span');
        b.className = 'corp-b';
        if (s.base) {
          b.textContent = 'основа';
          b.classList.add('b-base');
        } else if (s.disabled) {
          b.textContent = 'пока не подключён';
          b.classList.add('b-off');
        } else {
          b.textContent = 'по выбору';
        }
        top.appendChild(b);
        li.appendChild(top);

        if (s.hint) {
          var h = document.createElement('p');
          h.className = 'corp-h';
          h.textContent = s.hint;
          li.appendChild(h);
        }
        listEl.appendChild(li);
      });

      stateEl.hidden = true;
      listEl.hidden = false;
    }).catch(function (err) {
      scopesReq = null;
      showState(stateEl,
        '<span class="state-h">Не удалось загрузить корпуса</span>' +
        (err && err.message ? err.message : '') +
        '<br><button class="btn btn-ghost" type="button" data-retry-corp>Повторить</button>', true);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     РАЗБОР (экран чтения) — без изменений: те же адреса, тот же контракт.
     ══════════════════════════════════════════════════════════════════ */

  // Кэш БЕЗ прототипа. С обычным {} слаг «constructor»/«toString» проходил бы
  // проверку `if (readingCache[slug])` как «уже загружено» (это свойство
  // Object.prototype) — и вместо честной ошибки рисовался бы пустой разбор.
  var readingCache = Object.create(null);

  function loadReading(rawSlug) {
    var stateEl = $('readingState'), rootEl = $('readingRoot');
    var slug = safeSlug(rawSlug);

    rootEl.hidden = true;
    stateEl.hidden = false;
    stateEl.classList.remove('err');
    stateEl.textContent = 'Загружаю разбор…';

    if (!slug) {
      showState(stateEl,
        '<span class="state-h">Разбор не найден</span>Ссылка выглядит повреждённой. Вернитесь в ленту и откройте разбор оттуда.' +
        '<br><a class="btn btn-ghost" href="' + polygonHash('razbory', null) + '">В Полигон</a>', true);
      return;
    }

    if (readingCache[slug]) { renderReading(readingCache[slug]); return; }

    // сперва лента (в ней контрактные адреса), но её недоступность не должна
    // ронять чтение: не получилось — идём по договорной раскладке
    fetchFeed()
      .catch(function () { return null; })
      .then(function () {
        return fetch(readingUrlFor(slug), { cache: 'no-cache' });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        readingCache[slug] = data;
        if (current.name === 'reading' && current.slug === rawSlug) renderReading(data);
      })
      .catch(function (err) {
        // Разные причины — разный честный ответ. Если лента прочитана и такого слага
        // в ней НЕТ, то и статической страницы нет: звать «открыть как страницу»
        // (там будет тот же 404) — значит врать второй раз.
        var known = !feedOk || !!feedIndex[slug];
        showState(stateEl,
          '<span class="state-h">Не удалось открыть разбор</span>' +
          (known
            ? 'Тот же текст открывается как обычная страница — она работает, даже когда приложение недоступно.' +
              '<br><a class="btn btn-ghost" href="' + pagesUrlFor(slug).replace(/"/g, '%22') +
              '" target="_blank" rel="noopener">Открыть как страницу</a>'
            : 'Такого разбора в читальне нет — возможно, ссылка устарела или в ней опечатка.' +
              '<br><a class="btn btn-ghost" href="' + polygonHash('razbory', null) + '">В Полигон</a>'), true);
        if (window.console) console.warn('[kavacham] reading:', err && err.message);
      });
  }

  function renderReading(data) {
    var stateEl = $('readingState'), rootEl = $('readingRoot');
    var slug = data.slug || current.slug;
    var meta = data.meta || {};

    var rk = meta.rubric || meta.kind || 'razbor';
    $('readingKind').textContent = rubricTitle(rk) +
      (typeof meta.number === 'number' && meta.number > 0 ? ' · №' + meta.number : '');
    $('readingTitle').textContent = data.title || 'Разбор';
    var subEl = $('readingSub');
    subEl.textContent = data.subtitle || '';
    subEl.hidden = !data.subtitle;

    var bits = [];
    if (meta.date) bits.push(fmtDate(meta.date));
    if (typeof meta.pramanas === 'number' && meta.pramanas > 0) {
      bits.push(meta.pramanas + ' ' + plural(meta.pramanas, 'прамана', 'праманы', 'праман'));
    }
    $('readingMeta').textContent = bits.join(' · ');

    // тело: HTML нашего же генератора, из нашего же origin
    var body = $('readingBody');
    body.innerHTML = data.html || '';
    hydrateBody(body);

    renderToc(Array.isArray(data.toc) ? data.toc : []);

    // «Открыть как страницу» — анти-блокировочный путь (работает и без TMA).
    // Адрес берём из ленты (контракт pages_url), а не склеиваем из слага.
    var pageUrl = pagesUrlFor(slug);
    var pageBtn = $('btnPage');
    pageBtn.href = pageUrl;
    pageBtn.onclick = function (e) {
      if (inTelegram) {
        e.preventDefault();
        haptic('light');
        openExternal(new URL(pageUrl, location.href).href);
      }
    };

    // Делимся только тем, что у получателя ТОЧНО откроется (см. APP_DIRECT_LINK):
    // пока short_name в BotFather не зарегистрирован — это страница на Pages.
    var shareUrl = shareUrlFor(slug);
    var shareText = (data.title || 'Разбор КАВАЧАМ') + ' — Лаборатория КАВАЧАМ';

    function share() {
      haptic('medium');
      if (inTelegram && typeof tg.openTelegramLink === 'function') {
        tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(shareUrl) +
                            '&text=' + encodeURIComponent(shareText));
      } else if (navigator.share) {
        navigator.share({ title: shareText, url: shareUrl }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(shareUrl).then(function () {
          showToast('Ссылка скопирована');
        }).catch(function () {});
      } else {
        window.open('https://t.me/share/url?url=' + encodeURIComponent(shareUrl), '_blank', 'noopener');
      }
    }
    $('btnShare').onclick = share;

    // «Нашёл неточность» → в бота.
    // Полезной нагрузки (?start=fix_<slug>) здесь НЕТ намеренно: бот её сейчас не
    // разбирает (/start отвечает общим приветствием), и передавать контекст, который
    // на том конце молча теряется, — это обещание, которого интерфейс не держит.
    // Появится разбор payload в боте — вернуть сюда '?start=fix_' + slug.
    $('btnFix').onclick = function () {
      haptic('medium');
      openTelegram(BOT_URL);
    };

    setMainButton('Поделиться', share);

    stateEl.hidden = true;
    rootEl.hidden = false;

    // якорь из хэша обрабатывать нечем (у нас хэш занят роутером) — просто наверх
    window.scrollTo(0, 0);
  }

  // Пост-обработка тела: таблицы — в свой скроллер (страница не должна ездить вбок);
  // внешние ссылки — открывать по-телеграмному.
  function hydrateBody(body) {
    Array.prototype.forEach.call(body.querySelectorAll('table'), function (t) {
      if (t.parentNode && t.parentNode.classList.contains('table-scroll')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });

    Array.prototype.forEach.call(body.querySelectorAll('a[href]'), function (a) {
      var href = a.getAttribute('href') || '';
      if (/^#/.test(href)) return; // якорь оглавления — не трогаем
      if (!/^https?:/i.test(href)) return;
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      a.addEventListener('click', function (e) {
        if (!inTelegram) return;
        e.preventDefault();
        haptic('light');
        if (/^https?:\/\/(t\.me|telegram\.me)\//i.test(href)) openTelegram(href);
        else openExternal(href);
      });
    });
  }

  function renderToc(toc) {
    var nav = $('toc'), list = $('tocList'), toggle = $('tocToggle');
    list.textContent = '';

    if (!toc.length) { nav.hidden = true; return; }
    nav.hidden = false;

    toc.forEach(function (n) {
      if (!n || !n.id) return;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + n.id;
      a.className = 'lv-' + (n.level || 2);
      a.textContent = n.text || n.id;
      a.addEventListener('click', function (e) {
        e.preventDefault(); // иначе хэш перебьёт роутер
        var target = document.getElementById(n.id);
        if (target) {
          haptic('select');
          target.scrollIntoView({
            behavior: prefersReduced() ? 'auto' : 'smooth',
            block: 'start'
          });
          collapseToc();
        }
      });
      li.appendChild(a);
      list.appendChild(li);
    });

    collapseToc();
    toggle.onclick = function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      haptic('select');
      open ? collapseToc() : expandToc();
    };
  }

  function expandToc() {
    $('tocToggle').setAttribute('aria-expanded', 'true');
    $('tocList').hidden = false;
  }
  function collapseToc() {
    $('tocToggle').setAttribute('aria-expanded', 'false');
    $('tocList').hidden = true;
  }

  /* ══════════════════════════════════════════════════════════════════
     ЗАЯВКА (бывшая «Приёмная») — код без изменений, кроме владельца MainButton.
     Зеркало черновика бота: тот же текст, те же корпуса, та же анонимность,
     та же очередь. Вне Telegram форма НЕ показывается: подписать заявку нечем,
     а рисовать кнопку, которая ничего не отправит, — обман.
     ══════════════════════════════════════════════════════════════════ */

  var DRAFT_TEXT = 'tma.draft.text';
  var DRAFT_SCOPES = 'tma.draft.scopes';
  var DRAFT_SHOW = 'tma.draft.show';

  var scopeSel = [];          // выбранные ключи корпусов
  var sending = false;

  function cloud() {
    return (inTelegram && tg.CloudStorage && typeof tg.CloudStorage.setItem === 'function')
      ? tg.CloudStorage : null;
  }
  function draftSave(key, val) {
    var c = cloud();
    if (c) { try { c.setItem(key, String(val), function () {}); } catch (e) {} }
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }
  function draftClear() {
    [DRAFT_TEXT, DRAFT_SCOPES, DRAFT_SHOW].forEach(function (k) {
      var c = cloud();
      if (c && typeof c.removeItem === 'function') { try { c.removeItem(k, function () {}); } catch (e) {} }
      try { localStorage.removeItem(k); } catch (e) {}
    });
  }
  // сперва облако Telegram (черновик переживает смену устройства), затем локальный
  function draftLoad(cb) {
    var local = {};
    try {
      local[DRAFT_TEXT] = localStorage.getItem(DRAFT_TEXT) || '';
      local[DRAFT_SCOPES] = localStorage.getItem(DRAFT_SCOPES) || '';
      local[DRAFT_SHOW] = localStorage.getItem(DRAFT_SHOW) || '';
    } catch (e) {}
    var c = cloud();
    if (!c || typeof c.getItems !== 'function') { cb(local); return; }
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; cb(local); } }, 1200);
    try {
      c.getItems([DRAFT_TEXT, DRAFT_SCOPES, DRAFT_SHOW], function (err, res) {
        if (done) return;
        done = true; clearTimeout(t);
        if (err || !res) { cb(local); return; }
        cb({
          'tma.draft.text': res[DRAFT_TEXT] || local[DRAFT_TEXT] || '',
          'tma.draft.scopes': res[DRAFT_SCOPES] || local[DRAFT_SCOPES] || '',
          'tma.draft.show': res[DRAFT_SHOW] || local[DRAFT_SHOW] || ''
        });
      });
    } catch (e) { if (!done) { done = true; clearTimeout(t); cb(local); } }
  }

  var draftRestored = false;

  // Раньше это была enterSubmit() экрана «Приёмная». Тело то же; MainButton
  // отсюда убран — им владеет syncTerminalMain() (один экран — одна кнопка).
  function mountSubmit() {
    var gate = $('submitGate'), form = $('submitForm'), done = $('submitDone');

    if (!authed()) {
      gate.hidden = false;
      form.hidden = true;
      done.hidden = true;
      return;
    }

    gate.hidden = true;

    if (doneShown) {          // заявка уже отправлена — держим итог, а не пустую форму
      form.hidden = true;
      done.hidden = false;
      return;
    }

    done.hidden = true;
    form.hidden = false;

    loadScopes();

    if (!draftRestored) {
      draftRestored = true;
      draftLoad(function (d) {
        var t = d[DRAFT_TEXT] || '';
        if (t && !$('reqText').value) $('reqText').value = t.slice(0, 4000);
        var s = d[DRAFT_SCOPES];
        if (typeof s === 'string' && s) scopeSel = s.split(',').filter(Boolean);
        if (d[DRAFT_SHOW] === '1') $('showName').checked = true;
        syncScopeChips();
        syncCount();
      });
    }

    syncCount();
  }

  function loadScopes() {
    var listEl = $('scopeList'), stateEl = $('scopeState');

    fetchScopes().then(function (d) {
      var scopes = (d && Array.isArray(d.scopes)) ? d.scopes : [];
      listEl.textContent = '';
      if (!scopes.length) {
        showState(stateEl, 'Список корпусов пуст — разбор пойдёт по основе (Шрила Прабхупада).', false);
        return;
      }
      scopes.forEach(function (s) {
        if (!s || !s.key) return;
        // Основа (s.base) — «Шрила Прабхупада», всегда включена, тумблером не является:
        // о ней уже сказано статичной строкой #scopeBase. Дубль-чекбоксом её не рисуем,
        // иначе он выглядит отключаемым (а сервер основу всё равно навяжет).
        if (s.base) return;
        var lab = document.createElement('label');
        lab.className = 'chip chip-check';
        var inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.value = s.key;
        // s.disabled — контрактный флаг «пока недоступно»: показываем, но не переключаем.
        if (s.disabled) {
          inp.disabled = true;
          lab.classList.add('chip-disabled');
        }
        inp.checked = !s.disabled && scopeSel.indexOf(s.key) >= 0;
        if (!s.disabled) {
          inp.addEventListener('change', function () {
            var i = scopeSel.indexOf(s.key);
            if (inp.checked && i < 0) scopeSel.push(s.key);
            if (!inp.checked && i >= 0) scopeSel.splice(i, 1);
            draftSave(DRAFT_SCOPES, scopeSel.join(','));
            lab.classList.toggle('on', inp.checked);
            haptic('select');
          });
        }
        lab.classList.toggle('on', inp.checked);
        lab.appendChild(inp);
        var t = document.createElement('span');
        t.textContent = s.title || s.key;
        lab.appendChild(t);
        if (s.hint) lab.title = s.hint;
        listEl.appendChild(lab);
      });
      stateEl.hidden = true;
    }).catch(function (err) {
      scopesReq = null;
      showState(stateEl,
        'Не удалось загрузить список корпусов. Разбор всё равно пойдёт по основе — Шрила Прабхупада. ' +
        (err && err.message ? err.message : ''), true);
    });
  }

  function syncScopeChips() {
    Array.prototype.forEach.call($('scopeList').querySelectorAll('input[type=checkbox]'), function (inp) {
      inp.checked = scopeSel.indexOf(inp.value) >= 0;
      if (inp.parentNode) inp.parentNode.classList.toggle('on', inp.checked);
    });
  }

  function textLen() { return $('reqText').value.trim().length; }
  function textValid() { var n = textLen(); return n >= 10 && n <= 4000; }

  function syncCount() {
    var n = $('reqText').value.length;
    $('reqCount').textContent = String(n);
    $('reqCount').parentNode.classList.toggle('warn', n > 0 && textLen() < 10);
    syncMain();
  }

  // Валидируем MainButton ТОЛЬКО когда он и есть «Отправить вызов».
  // Иначе бы гасили чужую кнопку («Инициировать разбор», «Мои испытания»).
  function syncMain() {
    if (!mainIsSend || !inTelegram || !tg.MainButton) return;
    try {
      if (textValid() && !sending) tg.MainButton.enable();
      else tg.MainButton.disable();
    } catch (e) {}
  }

  function formErr(msg) {
    var el = $('submitErr');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
    haptic('error');
  }

  function trySend() {
    if (sending) return;
    if (!authed()) { formErr('Отправка работает только внутри Telegram.'); return; }

    var n = textLen();
    if (n < 10) { formErr('Вызов слишком короткий: нужно не меньше 10 символов, сейчас ' + n + '. Опишите суть — так разбор будет точнее.'); return; }
    if (n > 4000) { formErr('Слишком длинно: до 4000 символов, сейчас ' + n + '. Пришлите главное, остальное дополните в боте.'); return; }

    formErr(null);
    sending = true;
    syncMain();
    $('btnSend').disabled = true;
    if (inTelegram && tg.MainButton && tg.MainButton.showProgress) {
      try { tg.MainButton.showProgress(true); } catch (e) {}
    }

    api('/api/requests', {
      method: 'POST',
      body: {
        text: $('reqText').value.trim(),
        corpora: scopeSel.slice(),
        show_name: !!$('showName').checked
      }
    }).then(function (res) {
      haptic('success');
      draftClear();
      $('reqText').value = '';
      syncCount();
      showDone(res);
    }).catch(function (err) {
      formErr(err && err.message ? err.message : 'Не удалось отправить заявку.');
    }).then(function () {
      sending = false;
      $('btnSend').disabled = false;
      if (inTelegram && tg.MainButton && tg.MainButton.hideProgress) {
        try { tg.MainButton.hideProgress(); } catch (e) {}
      }
      syncMain();
    });
  }

  function showDone(res) {
    var id = (res && typeof res.id === 'number') ? res.id : null;
    var pos = (res && typeof res.position === 'number') ? res.position : null;

    var html = '<span class="state-h">Заявка' + (id ? ' <b class="mono">№' + id + '</b>' : '') + ' принята</span>';
    html += pos
      ? 'Перед вами в очереди ' + (pos - 1) + ' ' + plural(pos - 1, 'заявка', 'заявки', 'заявок') +
        ' — вы ' + pos + '-й по счёту. Очередь идёт по порядку поступления, без «пропустить вперёд».'
      : 'Заявка встала в общую очередь. Она идёт по порядку поступления.';
    html += ' Когда разбор выйдет, бот пришлёт вам ссылку.';
    html += '<br><button class="btn btn-ghost" type="button" data-go-mine>Мои испытания</button>' +
            '<button class="btn btn-ghost" type="button" data-again>Прислать ещё вызов</button>';

    doneShown = true;
    showState($('submitDone'), html, false);
    $('submitForm').hidden = true;

    mineDirty = true;
    mountProfile();          // новая заявка должна появиться в списке сразу
    syncTerminalMain();
  }

  $('reqText').addEventListener('input', function () {
    syncCount();
    formErr(null);
    draftSave(DRAFT_TEXT, $('reqText').value.slice(0, 4000));
  });
  $('showName').addEventListener('change', function () {
    draftSave(DRAFT_SHOW, $('showName').checked ? '1' : '0');
    haptic('select');
  });
  $('submitForm').addEventListener('submit', function (e) {
    e.preventDefault();
    trySend();
  });

  /* ══════════════════════════════════════════════════════════════════
     МОИ ИСПЫТАНИЯ (бывший «Кабинет») — тот же запрос, тот же рендер.
     Статусы: показываем РОВНО то, что отдаёт сервер. Промежуточных стадий
     («разведка ядром», «сверка праман») в данных НЕТ — и в интерфейсе их нет.
     ══════════════════════════════════════════════════════════════════ */
  var STATUS = {
    queued:   { label: 'В очереди',    cls: 'st-queued' },
    done:     { label: 'Опубликовано', cls: 'st-done' },
    rejected: { label: 'Отклонена',    cls: 'st-rejected' }
  };

  var mineDirty = true;    // список заявок устарел (первый вход / после отправки)
  var mineAt = 0;          // когда загружали в последний раз
  var MINE_TTL = 30000;

  function mountProfile() {
    var gate = $('profileGate');

    if (!authed()) {
      gate.hidden = false;
      $('profileState').hidden = true;
      $('profileList').hidden = true;
      $('mineRefresh').hidden = true;
      return;
    }
    gate.hidden = true;
    $('mineRefresh').hidden = false;

    // не долбим сервер на каждый вход во вкладку, но и не показываем вчерашний список
    if (mineDirty || (Date.now() - mineAt) > MINE_TTL) loadMine();
  }

  function loadMine() {
    var stateEl = $('profileState'), listEl = $('profileList');
    listEl.hidden = true;
    showState(stateEl, 'Загружаю ваши заявки…', false);

    api('/api/requests/mine').then(function (d) {
      var items = (d && Array.isArray(d.items)) ? d.items : [];
      mineDirty = false;
      mineAt = Date.now();

      if (!items.length) {
        showState(stateEl,
          '<span class="state-h">Испытаний пока нет</span>' +
          'Пришлите вызов — софизм, мем, искажение или сложный вопрос. Разбор придёт сюда и в бота.' +
          '<br><button class="btn btn-ghost" type="button" data-go-form>Инициировать разбор</button>', false);
        return;
      }
      renderMine(items);
      stateEl.hidden = true;
      listEl.hidden = false;
    }).catch(function (err) {
      showState(stateEl,
        '<span class="state-h">Не удалось загрузить заявки</span>' +
        (err && err.message ? err.message : '') +
        '<br><button class="btn btn-ghost" type="button" data-retry-mine>Повторить</button>', true);
    });
  }

  function renderMine(items) {
    var listEl = $('profileList');
    listEl.textContent = '';

    items.forEach(function (it) {
      // неизвестный статус не переводим и не выдумываем — показываем как есть
      var st = STATUS[it.status] || { label: String(it.status || '—'), cls: 'st-unknown' };

      var li = document.createElement('li');
      li.className = 'req';

      var head = document.createElement('div');
      head.className = 'req-head';

      var num = document.createElement('span');
      num.className = 'req-n mono';
      num.textContent = '№' + (it.id != null ? it.id : '—');
      head.appendChild(num);

      var badge = document.createElement('span');
      badge.className = 'req-st ' + st.cls;
      badge.textContent = st.label;
      head.appendChild(badge);

      if (it.created_at) {
        var d = document.createElement('span');
        d.className = 'req-d';
        d.textContent = fmtDate(it.created_at);
        head.appendChild(d);
      }
      li.appendChild(head);

      var p = document.createElement('p');
      p.className = 'req-t';
      var txt = String(it.text || '');
      p.textContent = txt.length > 180 ? txt.slice(0, 180).trim() + '…' : txt;
      li.appendChild(p);

      var foot = document.createElement('p');
      foot.className = 'req-f';
      if (it.status === 'queued') {
        foot.textContent = (typeof it.position === 'number' && it.position > 0)
          ? 'Место в очереди: ' + it.position + '. Очередь идёт по порядку поступления.'
          : 'В очереди. Порядок — по времени поступления.';
      } else if (it.status === 'rejected') {
        foot.textContent = 'Заявка не пошла в разбор. Причину можно спросить в боте.';
      } else if (it.status === 'done' && !it.post_url) {
        foot.textContent = 'Разбор готов. Ссылку пришлёт бот.';
      } else if (it.status === 'done') {
        foot.textContent = 'Разбор опубликован.';
      } else {
        foot.textContent = 'Состояние заявки — как его вернул сервер.';
      }
      li.appendChild(foot);

      if (it.post_url && /^https?:\/\//i.test(it.post_url)) {
        var a = document.createElement('a');
        a.className = 'btn btn-ghost';
        a.href = it.post_url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Открыть разбор';
        li.appendChild(a);
      }

      listEl.appendChild(li);
    });
  }

  $('mineRefresh').addEventListener('click', function () {
    haptic('light');
    mineDirty = true;
    loadMine();
  });

  // ——— Тост (без самописных модалок: для да/нет есть tg.showConfirm) ————
  var toastTimer = null;
  function showToast(msg) {
    var el = document.querySelector('.tma-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tma-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2200);
  }

  // ——— Общие обработчики ————————————————————————————————————
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    // Все кнопки «Обогащения» ведут в бота — эндпоинтов для этих форм ещё НЕТ,
    // и рисовать отправку в никуда мы не будем.
    if (t.closest('[data-open-bot]')) { haptic('medium'); openTelegram(BOT_URL); return; }

    // «Инициировать разбор» из другого экрана: если мы уже на терминале —
    // просто раскрываем панель (хэш тот же, hashchange бы не выстрелил).
    if (t.closest('[data-go-form]')) {
      haptic('light');
      if (current.name === 'terminal') openForm();
      else location.hash = '#/terminal?form=1';
      return;
    }
    if (t.closest('[data-go-mine]')) { haptic('light'); scrollToEl($('mineBlock')); return; }
    if (t.closest('[data-again]')) { haptic('light'); openForm(); return; }

    if (t.closest('[data-retry-feed]')) { loadFeed(current.rubric); return; }
    if (t.closest('[data-retry-sri]')) { loadSri(); return; }
    if (t.closest('[data-retry-corp]')) { loadCorpus(); return; }
    if (t.closest('[data-retry-mine]')) { mineDirty = true; loadMine(); return; }

    // ссылки на Telegram и лендинг — через нативные открывалки клиента
    var link = t.closest('a[href^="http"]');
    if (link && inTelegram && !link.closest('.reading-body')) {
      e.preventDefault();
      var href = link.href;
      haptic('light');
      if (/^https?:\/\/(t\.me|telegram\.me)\//i.test(href)) openTelegram(href);
      else openExternal(href);
    }
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab, .seg-b'), function (a) {
    a.addEventListener('click', function () { haptic('select'); });
  });

  window.addEventListener('hashchange', route);

  // ——— Старт ————————————————————————————————————————————————
  if (inTelegram) {
    document.body.classList.add('tma-in-telegram');
    try {
      tg.ready();
      tg.expand();
      if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
      if (tg.BackButton && typeof tg.BackButton.onClick === 'function') {
        tg.BackButton.onClick(goBack);
      }
      if (typeof tg.onEvent === 'function') {
        tg.onEvent('viewportChanged', syncViewport);
        tg.onEvent('safeAreaChanged', syncViewport);
        tg.onEvent('contentSafeAreaChanged', syncViewport);
      }
    } catch (e) {
      if (window.console) console.warn('[kavacham] telegram init:', e && e.message);
    }
    syncViewport();

    // deep-link: t.me/kavacham_lab_bot/reader?startapp=<slug> → сразу нужный разбор
    var startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
    if (!location.hash && safeSlug(startParam)) {
      location.replace('#/reading/' + encodeURIComponent(startParam));
    }
  } else {
    document.body.classList.add('tma-standalone');
  }

  route();
})();
