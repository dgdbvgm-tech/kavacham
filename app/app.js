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

  // Да/нет: нативный tg.showConfirm, где он есть; вне Telegram — window.confirm.
  // Ответ приходит колбэком (showConfirm асинхронный) — синхронного пути нет.
  function askConfirm(msg, cb) {
    if (inTelegram && typeof tg.showConfirm === 'function') {
      try {
        tg.showConfirm(msg, function (ok) { cb(!!ok); });
        return;
      } catch (e) { /* старый клиент — падаем в window.confirm */ }
    }
    cb(window.confirm(msg));
  }

  // slug из хэша не доверяем: только безопасный набор, иначе не строим путь к JSON
  function safeSlug(s) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(s || '') ? s : null;
  }

  var MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

  function fmtDate(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
  }

  // Дата стадии в конвейере — без года: очередь живёт днями, а ширина 390 px конечна.
  // Нет метки времени (у заявки старого формата так бывает) — возвращаем пусто,
  // и в строке стадии просто не будет даты. Подставлять «сегодня» нельзя: это враньё.
  function fmtDay(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return '';
    return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1];
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
    about:    { el: 'screen-about',    tab: 'about',    back: false },
    hq:       { el: 'screen-hq',       tab: 'hq',       back: false },
    // Лог событий (v6.3): вкладки не имеет, вход с конверта в шапке
    log:      { el: 'screen-log',      tab: 'terminal', back: true  }
  };

  var SEGS = { razbory: 'pane-razbory', sri: 'pane-sri', corpus: 'pane-corpus' };

  var current = { name: 'terminal', slug: null, seg: 'razbory', rubric: null, tag: null };

  // Ссылка на срез Полигона — единственное место, где собирается маршрут ленты.
  // Тег-фильтр живёт в маршруте (#/polygon?tag=SRI): «назад» Telegram снимает его сам.
  function polygonHash(seg, rubric, tag) {
    var h = '#/polygon?seg=' + (seg || 'razbory');
    if (rubric) h += '&rubric=' + encodeURIComponent(rubric);
    if (tag) h += '&tag=' + encodeURIComponent(tag);
    return h;
  }

  // Тег из маршрута: произвольный текст из данных ленты (кириллица, пробелы),
  // но с потолком длины и без управляющих символов — в путь к данным он не идёт,
  // им только СРАВНИВАЮТ (нормализованно) со значениями tags[] из feed.json.
  function safeTag(s) {
    if (typeof s !== 'string') return null;
    s = s.trim();
    if (!s || s.length > 80 || /[\u0000-\u001f<>]/.test(s)) return null;
    return s;
  }

  // Нормализация тега для сравнения (аналог casefold): регистр и лишние пробелы
  // не считаются различием, а ПОКАЗЫВАЕМ теги всегда как в данных.
  function normTag(s) {
    return String(s || '').trim().toLowerCase();
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
    var tag = safeTag(p.tag);

    var parts = raw.split('/').filter(Boolean);
    var head = parts[0] || '';

    // — старые маршруты → новые экраны (редирект, а не 404) —
    if (head === 'reader') {
      return { redirect: polygonHash('razbory', rubric, tag) };
    }
    if (head === 'submit') {
      return { redirect: '#/terminal?form=1' };
    }
    if (head === 'profile') {
      return { redirect: '#/terminal?focus=mine' };
    }

    if (head === 'reading' && parts[1]) {
      return { name: 'reading', slug: parts[1], seg: 'razbory', rubric: null, tag: null };
    }
    if (SCREENS[head] && head !== 'reading') {
      return {
        name: head,
        slug: null,
        seg: seg,
        rubric: rubric,
        tag: tag,
        form: p.form === '1',
        focus: p.focus || null
      };
    }
    // пустой/неизвестный хэш — стартовый экран
    return { name: 'terminal', slug: null, seg: 'razbory', rubric: null, tag: null };
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
  // Владелец MainButton и его условие «можно жать». Кнопка у экрана ОДНА (два золотых
  // действия на 390×600 — шум, а не навигация), и владельцев уже двое: Терминал занимает
  // её «Отправить вызов», Обогащение — «Отправить вклад». Поэтому валидатор приходит
  // вместе с кнопкой: кто её занял, тот и решает, когда она активна. Без валидатора
  // (напр. «Поделиться») кнопка просто всегда активна.
  var mainValidator = null;

  function setMainButton(text, handler, validator) {
    if (!inTelegram || !tg.MainButton) return;
    try {
      if (mainHandler) tg.MainButton.offClick(mainHandler);
      mainHandler = null;
      mainValidator = null;
      if (!text) {
        tg.MainButton.hide();
        document.body.classList.remove('tma-has-mainbutton');
        return;
      }
      mainHandler = handler;
      mainValidator = validator || null;
      tg.MainButton.setText(text);
      tg.MainButton.onClick(mainHandler);
      tg.MainButton.enable();
      tg.MainButton.show();
      document.body.classList.add('tma-has-mainbutton');
    } catch (e) { /* старый клиент — экранных кнопок достаточно */ }
  }

  // Активность MainButton = условие её нынешнего владельца. Чужую кнопку не трогаем:
  // без валидатора выходим сразу.
  function syncMain() {
    if (!inTelegram || !tg.MainButton || !mainValidator) return;
    try {
      if (mainValidator()) tg.MainButton.enable();
      else tg.MainButton.disable();
    } catch (e) { /* старый клиент */ }
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

    // смена рубрики внутри одного среза — не «новый экран»: не дёргаем скролл и фокус.
    // Смена ТЕГА — наоборот, скроллим наверх: тег кликают с карточки в глубине ленты,
    // и без прокрутки человек не увидел бы ни чип фильтра, ни результат.
    var sameSlice = (prev.name === r.name && r.name === 'polygon' && prev.seg === r.seg &&
                     (prev.tag || null) === (r.tag || null));
    if (!sameSlice) {
      // МГНОВЕННО, не smooth: html { scroll-behavior: smooth } из общего styles.css
      // превращал этот сброс в анимацию, и scrollIntoView активной рубрики,
      // выстреливая посреди неё, перехватывал прокрутку — экран замирал на полпути.
      try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }
      catch (e) { window.scrollTo(0, 0); }
      $('main').focus({ preventScroll: true });
    }

    if (r.name === 'reading') loadReading(r.slug);
    else if (r.name === 'polygon') enterPolygon(r);
    else if (r.name === 'terminal') enterTerminal(r);
    else if (r.name === 'enrich') enterEnrich();
    else if (r.name === 'hq') enterHq();
    else if (r.name === 'log') enterLog();
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
    if (authed() && formOpen && !doneShown) {
      setMainButton('Отправить вызов', trySend, function () { return textValid() && !sending; });
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
     Раздел А — та же лента, что была в «Протоколах» (тот же код и те же id).
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
      lastFeedHash = polygonHash('razbory', r.rubric, r.tag);
      loadFeed(r.rubric, r.tag);
    } else if (r.seg === 'sri') {
      loadSri();
    } else if (r.seg === 'corpus') {
      loadCorpus();
    }
  }

  // ——— Лента ————————————————————————————————————————————————
  // Лента — единственный источник правды по адресам разбора: в feed.json есть
  // контрактные поля reading_url (JSON для протоколов) и pages_url (статическая
  // страница Pages). Склеивать пути из слага руками нельзя: сменит генератор
  // раскладку — протоколы начнёт молча 404-ить, хотя правильный адрес лежит в ленте.
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

  // Теги элемента ленты: только строки, как в данных.
  function itemTags(it) {
    return (it && Array.isArray(it.tags)) ? it.tags.filter(function (t) {
      return typeof t === 'string' && t.trim();
    }) : [];
  }

  // Есть ли у элемента тег (сравнение нормализованное: регистр не различаем).
  function itemHasTag(it, tag) {
    var n = normTag(tag);
    return itemTags(it).some(function (t) { return normTag(t) === n; });
  }

  // Тег для показа — КАК В ДАННЫХ: первое написание из ленты, а не то, что в маршруте.
  function displayTag(items, tag) {
    var n = normTag(tag);
    for (var i = 0; i < items.length; i++) {
      var ts = itemTags(items[i]);
      for (var j = 0; j < ts.length; j++) {
        if (normTag(ts[j]) === n) return ts[j].trim();
      }
    }
    return tag;
  }

  // Чип активного тег-фильтра: «тег: SRI ✕» + счётчик. Снять — один тап (✕ ведёт
  // на тот же срез без тега; рубрика при этом сохраняется).
  function renderTagFilter(tag, shownTag, count, rubric) {
    var el = $('tagFilter');
    el.textContent = '';
    if (!tag) { el.hidden = true; return; }

    var chip = document.createElement('a');
    chip.className = 'chip on tag-chip';
    chip.href = polygonHash('razbory', rubric, null);
    chip.setAttribute('aria-label', 'Снять фильтр по тегу «' + shownTag + '»');

    var t = document.createElement('span');
    t.textContent = 'тег: ' + shownTag;
    chip.appendChild(t);

    var c = document.createElement('span');
    c.className = 'chip-n';
    c.textContent = String(count);
    chip.appendChild(c);

    var x = document.createElement('span');
    x.className = 'tag-x';
    x.setAttribute('aria-hidden', 'true');
    x.textContent = '✕';
    chip.appendChild(x);

    chip.addEventListener('click', function () { haptic('select'); });
    el.appendChild(chip);
    el.hidden = false;
  }

  function loadFeed(rubric, tag) {
    var stateEl = $('feedState'), listEl = $('feedList'), navEl = $('rubrics');

    fetchFeed()
      .then(function (items) {
        if (!items.length) {
          showState(stateEl,
            '<span class="state-h">Лента пока пуста</span>' +
            'Первые разборы появятся здесь сразу после публикации. Пока их можно читать в канале Лаборатории.', false);
          listEl.hidden = true;
          navEl.hidden = true;
          $('tagFilter').hidden = true;
          return;
        }

        // рубрика из маршрута, которой в ленте нет — молча показываем всё
        var active = (rubric && rubricByKey[rubric]) ? rubric : null;
        renderRubrics(active, tag);

        var slice = active
          ? items.filter(function (it) { return itemRubric(it) === active; })
          : items;

        // тег-фильтр поверх рубрики: честное пересечение и счётчик по нему
        var shownTag = null;
        if (tag) {
          shownTag = displayTag(items, tag);
          slice = slice.filter(function (it) { return itemHasTag(it, tag); });
        }
        renderTagFilter(tag, shownTag, slice.length, active);

        if (!slice.length) {
          // пустой результат — честное состояние, а не пустой экран
          var what = 'По тегу «' + String(shownTag || tag) + '»' +
                     (active ? ' в рубрике «' + rubricTitle(active) + '»' : '') +
                     ' материалов нет.';
          showState(stateEl,
            '<span class="state-h">Ничего не нашлось</span>' + what +
            '<br><a class="btn btn-ghost" href="' + polygonHash('razbory', active, null) + '">Снять фильтр</a>', false);
          listEl.hidden = true;
          return;
        }

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
  // Активный тег-фильтр рубрики СОХРАНЯЮТ (пересечение — см. loadFeed).
  function renderRubrics(active, tag) {
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
      a.href = polygonHash('razbory', key, tag);
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

      var tagList = itemTags(it);
      if (tagList.length) {
        var tags = document.createElement('div');
        tags.className = 'feed-tags';
        tagList.slice(0, 3).forEach(function (t) {
          // Карточка сама — <a>, поэтому тег НЕ ссылка (вложенных <a> не бывает),
          // а кликабельный span: клик/Enter уводят в ленту с фильтром по тегу.
          tags.appendChild(makeTagEl(t, current.rubric));
        });
        a.appendChild(tags);
      }

      a.addEventListener('click', function () { haptic('light'); });
      li.appendChild(a);
      listEl.appendChild(li);
    });
  }

  // Кликабельный тег: ведёт в ленту с фильтром по тегу. keepRubric — сохранить
  // текущую рубрику (пересечение, см. loadFeed); null — все материалы с тегом.
  function makeTagEl(t, keepRubric) {
    var s = document.createElement('span');
    s.className = 'tag tag-go';
    s.setAttribute('role', 'link');
    s.setAttribute('tabindex', '0');
    s.setAttribute('aria-label', 'Материалы с тегом «' + t + '»');
    s.textContent = t;
    function go(e) {
      e.preventDefault();
      e.stopPropagation();
      haptic('select');
      location.hash = polygonHash('razbory', keepRubric || null, t.trim());
    }
    s.addEventListener('click', go);
    s.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') go(e);
    });
    return s;
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
            : 'Такого разбора в протоколах нет — возможно, ссылка устарела или в ней опечатка.' +
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

    // Теги разбора — из ленты (свой источник правды по тегам; в reading-JSON их нет).
    // Кликабельны: ведут в ленту с фильтром по тегу — все материалы с ним.
    var tagsEl = $('readingTags');
    tagsEl.textContent = '';
    var rtags = itemTags(feedIndex[slug] || (meta && meta.tags ? { tags: meta.tags } : null));
    if (rtags.length) {
      rtags.forEach(function (t) { tagsEl.appendChild(makeTagEl(t, null)); });
      tagsEl.hidden = false;
    } else {
      tagsEl.hidden = true;
    }

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

  var scopeSel = [];          // выбранные ключи ДОПОЛНИТЕЛЬНЫХ корпусов (без основы)
  // Основа (Шрила Прабхупада). Снята → исследовательский режим: сервер ставит
  // заявке флаг research_mode. Снятие — только через явное подтверждение.
  var baseOn = true;
  // Сентинел в черновике корпусов: «основа снята». Не ключ корпуса — флаг; старые
  // черновики без него честно читаются как «основа включена».
  var NO_BASE = '-base';
  var RESEARCH_CONFIRM = 'Поиск пойдёт без корпуса основы (Шрилы Прабхупады). ' +
    'Согласование выводов по призме ачарьи-основателя — на этапе сверки человеком. Продолжить?';
  var sending = false;

  function syncResearchNote() {
    var el = $('researchNote');
    if (el) el.hidden = baseOn;
  }

  function saveScopesDraft() {
    // Дерево есть → черновик v2 (JSON): группы целиком + точечные книги.
    // Формат обратно совместим: parseDraftScopes читает и v2, и легаси-CSV.
    if (TREE) {
      draftSave(DRAFT_SCOPES, JSON.stringify({ v: 2, all: fullGroupLabels(), books: collectBooks() }));
      return;
    }
    var keys = scopeSel.slice();
    if (!baseOn) keys.push(NO_BASE);
    draftSave(DRAFT_SCOPES, keys.join(','));
  }

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

    loadCorpusSelector();

    if (!draftRestored) {
      draftRestored = true;
      draftLoad(function (d) {
        var t = d[DRAFT_TEXT] || '';
        if (t && !$('reqText').value) {
          $('reqText').value = t.slice(0, 4000);
          // v6.2 §2.4: свайп закрыл TMA — текст выжил, честно говорим об этом
          $('draftRestored').hidden = false;
        }
        var s = d[DRAFT_SCOPES];
        var sel = parseDraftScopes(typeof s === 'string' ? s : '');
        if (sel) {
          // pendingSel дождётся отрисовки дерева; чипам хватает ключей и основы
          pendingSel = sel;
          baseOn = sel.all.indexOf('prabhupada') >= 0 ||
            sel.books.some(function (b) { return corpusToKey(b.corpus || '') === 'prabhupada'; });
          scopeSel = [];
          sel.all.concat(sel.books.map(function (b) { return corpusToKey(b.corpus || ''); }))
            .forEach(function (k) {
              if (k && k !== 'prabhupada' && scopeSel.indexOf(k) < 0) scopeSel.push(k);
            });
          if (TREE) applySelection(sel);
        }
        if (d[DRAFT_SHOW] === '1') $('showName').checked = true;
        syncCorpusUI();
        syncResearchNote();
        syncCount();
      });
    }

    syncCount();
  }

  /* ── Дерево корпусов: группа → книги, как в пульте песочницы ──
     Дерево отдаётся ТОЛЬКО авторизованным (GET /api/corpus-tree): в нём есть
     корпуса, скрытые из публичного каталога. Ошибка или 404 → честный откат к
     плоским чипам /api/scopes (loadScopes) — форма работает всегда, дерево —
     обогащение. Состояние: gSel[gi] = множество индексов выбранных листьев.
     Основа = группа со scope_key BASE_KEY: «выбран хотя бы один лист» ⇔ baseOn;
     переход в ноль — только через RESEARCH_CONFIRM (как у чипа основы). */
  var TREE = null;           // группы дерева либо null (работаем чипами)
  var TREE_HINTS = {};
  var BASE_KEY = 'prabhupada';
  var gSel = [];             // gi → объект-множество: {bi: 1}
  var treeReq = null;
  var pendingSel = null;     // выбор из черновика, ждущий отрисовки дерева
  // тир — языком продукта (тот же словарь, что в хинтах слоёв), не жаргоном движка
  var TIER_TMA = { trusted: 'проверен', grey: 'серый список', pending: 'на вычитке' };

  function fmtN(n) {
    try { return (n || 0).toLocaleString('ru-RU'); } catch (e) { return String(n || 0); }
  }
  function corpusToKey(c) {
    // мостик «корпус ядра → ключ слоя» — инвариант сервера v6.1: ключ слоя =
    // имя корпуса, а четыре свода основы (bg/sb/cc/prabhupada) сворачиваются в базу
    return (c === 'bg' || c === 'sb' || c === 'cc' || c === 'prabhupada') ? 'prabhupada' : c;
  }
  function elc(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function groupCount(gi) {
    var n = 0, k;
    for (k in gSel[gi]) { if (Object.prototype.hasOwnProperty.call(gSel[gi], k)) n++; }
    return n;
  }
  function baseGi() {
    for (var i = 0; i < TREE.length; i++) { if (TREE[i].scope_key === BASE_KEY) return i; }
    return -1;
  }

  function fetchTree() {
    if (!treeReq) treeReq = api('/api/corpus-tree').then(function (d) { return d || {}; });
    return treeReq;
  }

  // Точка входа селектора: дерево авторизованным, чипы — всем остальным сценариям.
  function loadCorpusSelector() {
    if (!authed()) { loadScopes(); return; }
    if (TREE) { syncCorpusUI(); return; }
    fetchTree().then(function (d) {
      if (!d || !Array.isArray(d.tree) || !d.tree.length) throw new Error('дерево пустое');
      TREE = d.tree;
      BASE_KEY = d.base_key || 'prabhupada';
      TREE_HINTS = d.hints || {};
      // черновик, если он был; иначе дефолт сервера (основа + канон парампары)
      applySelection(pendingSel || { all: d.default_keys || ['prabhupada'], books: [] });
      renderTree();
      $('scopeList').hidden = true;
      $('scopeState').hidden = true;
      $('corpusTree').hidden = false;
      syncResearchNote();
    }).catch(function () {
      treeReq = null;          // неудачу не кэшируем: следующий заход попробует снова
      loadScopes();
    });
  }

  // sel = {all: [ключи групп целиком], books: [{corpus, title|prefix} частичных]}
  function applySelection(sel) {
    gSel = TREE.map(function () { return {}; });
    var all = {};
    (sel.all || []).forEach(function (k) { all[k] = 1; });
    TREE.forEach(function (g, gi) {
      // совпадение по label (черновик v6.2) ИЛИ по scope_key (дефолты сервера
      // и черновики v6.1) — scope_key не уникален, label стабилен
      if (g.disabled || (all[g.label] !== 1 && all[g.scope_key] !== 1)) return;
      g.books.forEach(function (leaf, bi) { gSel[gi][bi] = 1; });
    });
    (sel.books || []).forEach(function (b) {
      if (!b || !b.corpus) return;
      var key = corpusToKey(b.corpus);
      TREE.forEach(function (g, gi) {
        if (g.scope_key !== key || g.disabled) return;
        g.books.forEach(function (leaf, bi) {
          if (leaf.corpus !== b.corpus) return;
          // лист совпал, если совпали оба селектора (у листа «корпус целиком» их нет)
          if ((b.title || null) === (leaf.title || null) &&
              (b.prefix || null) === (leaf.prefix || null)) gSel[gi][bi] = 1;
        });
      });
    });
    syncScopeKeysFromTree();
  }

  // Учёт по СКОУП-КЛЮЧАМ поверх групп (v6.2): куратор ядра может переместить
  // лист в чужую группу (Нароттама живёт у «Ачарьев», но corpus=goswamis) и
  // разложить один корпус на две группы («Апология» и «Жизнеописания» = books).
  // Сужение и ключи считаем честно ПО КОРПУСУ листа, а не по группе.
  function keyStats() {
    var per = {};
    TREE.forEach(function (g, gi) {
      g.books.forEach(function (leaf, bi) {
        var k = corpusToKey(leaf.corpus);
        per[k] = per[k] || { sel: [], total: 0 };
        per[k].total++;
        if (gSel[gi][bi]) per[k].sel.push(leaf);
      });
    });
    return per;
  }

  // scopeSel/baseOn — общий язык формы (валидация, черновик, payload):
  // дерево лишь наполняет их своим состоянием.
  function syncScopeKeysFromTree() {
    var per = keyStats();
    scopeSel = [];
    Object.keys(per).forEach(function (k) {
      if (k === BASE_KEY || !per[k].sel.length) return;
      if (scopeSel.indexOf(k) < 0) scopeSel.push(k);
    });
    baseOn = !!(per[BASE_KEY] && per[BASE_KEY].sel.length);
  }

  // Черновик: группы, выбранные ЦЕЛИКОМ, — по label (scope_key не уникален:
  // «Апология» и «Жизнеописания» делят корпус books).
  function fullGroupLabels() {
    var out = [];
    TREE.forEach(function (g, gi) {
      if (g.disabled) return;
      if (g.books.length && groupCount(gi) === g.books.length) out.push(g.label);
    });
    return out;
  }

  // Сужение для сервера: по СКОУП-КЛЮЧУ — только частично выбранные
  // (ключ целиком = corpora-ключ без books, как раньше).
  function collectBooks() {
    if (!TREE) return [];
    var per = keyStats(), out = [];
    Object.keys(per).forEach(function (k) {
      var st = per[k];
      if (!st.sel.length || st.sel.length === st.total) return;
      st.sel.forEach(function (leaf) {
        var s = { corpus: leaf.corpus };
        if (leaf.title) s.title = leaf.title;
        else if (leaf.prefix) s.prefix = leaf.prefix;
        out.push(s);     // без title/prefix — лист «корпус целиком» (bg/sb/cc)
      });
    });
    return out;
  }

  function renderTree() {
    var box = $('corpusTree');
    box.textContent = '';
    var lastParent = null;
    TREE.forEach(function (g, gi) {
      // супер-раздел («Гуру ИСККОН») — визуальная секция, не выбираемая единица
      var par = g.parent || null;
      if (par !== lastParent) {
        lastParent = par;
        if (par) {
          var ph = elc('div', 'cg-parent');
          ph.textContent = par;
          box.appendChild(ph);
        }
      }
      var node = elc('div', 'cg' + (g.disabled ? ' cg-off' : '') + (par ? ' cg-child' : ''));
      var head = elc('div', 'cg-head');
      var arrow = elc('button', 'cg-arrow');
      arrow.type = 'button';
      arrow.textContent = '▸';
      arrow.setAttribute('aria-expanded', 'false');
      arrow.setAttribute('aria-label', 'Раскрыть состав: ' + g.label);
      var lab = elc('label', 'cg-check');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = !!g.disabled;
      var nm = elc('span', 'cg-name');
      nm.textContent = g.label;
      lab.appendChild(cb);
      lab.appendChild(nm);
      var meta = elc('span', 'cg-meta');
      var tier = elc('span', 'ctier t-' + (g.tier || 'pending'));
      tier.textContent = TIER_TMA[g.tier] || g.tier_label || '';
      var cnt = elc('span', 'cg-cnt mono');
      meta.appendChild(tier);
      meta.appendChild(cnt);
      var hint = g.hint || TREE_HINTS[g.scope_key];
      if (hint) head.title = hint;
      head.appendChild(arrow);
      head.appendChild(lab);
      head.appendChild(meta);
      // Права на текст: группа честно объявляет режим «только указатель»
      // (издательские права) — человек видит ДО выбора, что дословной цитаты
      // в опубликованном разборе не будет, будет ссылка на издание.
      var kids = elc('div', 'cg-kids');
      kids.hidden = true;
      if (g.rights_notice) {
        var rn = elc('div', 'cg-rights');
        rn.textContent = g.rights_notice;
        kids.appendChild(rn);
      }
      g.books.forEach(function (leaf, bi) {
        var l = elc('label', 'cl' + (leaf.private ? ' cl-private' : ''));
        var lcb = document.createElement('input');
        lcb.type = 'checkbox';
        lcb.disabled = !!g.disabled;
        lcb.dataset.gi = String(gi);
        lcb.dataset.bi = String(bi);
        var n2 = elc('span', 'cl-nm');
        n2.textContent = (leaf.private ? '🔒 ' : '') + leaf.label;
        l.appendChild(lcb);
        l.appendChild(n2);
        // лист с СОБСТВЕННЫМ тиром (перемещён куратором из корпуса другого
        // рубежа — например, Нароттама у «Ачарьев» из серого goswamis)
        if (leaf.tier && leaf.tier !== g.tier) {
          var lt = elc('span', 'ctier cl-tier t-' + leaf.tier);
          lt.textContent = TIER_TMA[leaf.tier] || leaf.tier_label || '';
          l.appendChild(lt);
        }
        var c2 = elc('span', 'cl-cnt mono');
        c2.textContent = fmtN(leaf.count);
        l.appendChild(c2);
        kids.appendChild(l);
        lcb.addEventListener('change', function () { onLeafToggle(gi, bi, lcb); });
      });
      arrow.addEventListener('click', function () {
        var open = kids.hidden;
        kids.hidden = !open;
        arrow.textContent = open ? '▾' : '▸';
        arrow.setAttribute('aria-expanded', String(open));
        haptic('select');
      });
      cb.addEventListener('change', function () { onGroupToggle(gi, cb); });
      node.appendChild(head);
      node.appendChild(kids);
      box.appendChild(node);
      g._ui = { cb: cb, cnt: cnt, kids: kids, node: node };
    });
    syncCorpusUI();
  }

  function onGroupToggle(gi, cb) {
    var g = TREE[gi];
    if (cb.checked) {
      gSel[gi] = {};
      g.books.forEach(function (_, bi) { gSel[gi][bi] = 1; });
      afterTreeChange();
      haptic('select');
      return;
    }
    if (g.scope_key === BASE_KEY) {
      // снятие основы: сперва честный вопрос, потом состояние (как у чипа)
      cb.checked = true;
      askConfirm(RESEARCH_CONFIRM, function (ok) {
        if (!ok) { syncCorpusUI(); return; }
        gSel[gi] = {};
        afterTreeChange();
        haptic('warning');
      });
      return;
    }
    gSel[gi] = {};
    afterTreeChange();
    haptic('select');
  }

  function onLeafToggle(gi, bi, lcb) {
    var g = TREE[gi];
    if (lcb.checked) {
      gSel[gi][bi] = 1;
      afterTreeChange();
      haptic('select');
      return;
    }
    // снятие ПОСЛЕДНЕГО листа основы = снятие основы: тот же честный вопрос
    if (g.scope_key === BASE_KEY && groupCount(gi) === 1 && gSel[gi][bi]) {
      lcb.checked = true;
      askConfirm(RESEARCH_CONFIRM, function (ok) {
        if (!ok) { syncCorpusUI(); return; }
        delete gSel[gi][bi];
        afterTreeChange();
        haptic('warning');
      });
      return;
    }
    delete gSel[gi][bi];
    afterTreeChange();
    haptic('select');
  }

  function afterTreeChange() {
    syncScopeKeysFromTree();
    saveScopesDraft();
    syncCorpusUI();
    syncResearchNote();
  }

  function syncTreeUI() {
    TREE.forEach(function (g, gi) {
      var ui = g._ui;
      if (!ui) return;
      var total = g.books.length, n = groupCount(gi);
      ui.cb.checked = total > 0 && n === total;
      ui.cb.indeterminate = n > 0 && n < total;
      // счётчик честный: целиком — объём корпуса, частично — «выбрано из»
      ui.cnt.textContent = (n === 0 || n === total)
        ? fmtN(g.count) + ' док.'
        : n + ' из ' + total;
      ui.node.classList.toggle('on', n > 0);
      Array.prototype.forEach.call(ui.kids.querySelectorAll('input'), function (inp) {
        inp.checked = !!gSel[gi][inp.dataset.bi];
      });
    });
  }

  // Один синхронизатор на оба вида селектора: дерево или чипы.
  function syncCorpusUI() {
    if (TREE) { syncTreeUI(); return; }
    syncScopeChips();
  }

  // Черновик: v2 (JSON с книгами) для дерева, легаси-CSV — для чипов.
  function parseDraftScopes(s) {
    if (!s) return null;
    if (s.charAt(0) === '{') {
      try {
        var d = JSON.parse(s);
        if (d && d.v === 2) return { all: d.all || [], books: d.books || [] };
      } catch (e) {}
      return null;
    }
    var keys = s.split(',').filter(Boolean);
    var noBase = keys.indexOf(NO_BASE) >= 0;
    keys = keys.filter(function (k) { return k !== NO_BASE; });
    if (!noBase) keys.push('prabhupada');
    return { all: keys, books: [] };
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
        var lab = document.createElement('label');
        lab.className = 'chip chip-check';
        var inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.value = s.key;

        // Основа (s.base) — «Шрила Прабхупада»: с v6.0 чип СНИМАЕМЫЙ, но не молча.
        // Снятие — только через явное подтверждение (showConfirm/confirm), и пока
        // основа снята, на форме видна пометка «исследовательский режим».
        if (s.base) {
          lab.classList.add('chip-base');
          inp.checked = baseOn;
          inp.addEventListener('change', function () {
            if (!inp.checked) {
              // снятие основы: сперва честный вопрос, потом состояние
              inp.checked = true;                 // до ответа ничего не меняем
              askConfirm(RESEARCH_CONFIRM, function (ok) {
                if (!ok) { syncScopeChips(); return; }
                baseOn = false;
                inp.checked = false;
                lab.classList.remove('on');
                saveScopesDraft();
                syncResearchNote();
                haptic('warning');
              });
              return;
            }
            baseOn = true;
            lab.classList.add('on');
            saveScopesDraft();
            syncResearchNote();
            haptic('select');
          });
          lab.classList.toggle('on', baseOn);
          lab.appendChild(inp);
          var bt = document.createElement('span');
          bt.textContent = s.title || s.key;
          lab.appendChild(bt);
          if (s.hint) lab.title = s.hint;
          listEl.appendChild(lab);
          return;
        }

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
            saveScopesDraft();
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
      syncResearchNote();
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
      // чип основы синхронизируется с baseOn, остальные — с выбором слоёв
      inp.checked = (inp.value === 'prabhupada') ? baseOn : scopeSel.indexOf(inp.value) >= 0;
      if (inp.parentNode) inp.parentNode.classList.toggle('on', inp.checked);
    });
  }

  // v6.2 §2.3: пре-флайт ужесточён до 15 (сервер держит свой минимум — фронт строже).
  function textLen() { return $('reqText').value.trim().length; }
  function textValid() { var n = textLen(); return n >= 15 && n <= 4000; }

  function syncCount() {
    var n = $('reqText').value.length;
    $('reqCount').textContent = String(n);
    // warn — на строке .field-h, не на внутреннем span: счётчик теперь обёрнут
    // (строка counter-row), а красит только правило .field-h.warn
    var line = $('reqCount').parentNode;
    while (line && line.classList && !line.classList.contains('field-h')) line = line.parentNode;
    if (line && line.classList) line.classList.toggle('warn', n > 0 && textLen() < 15);
    // подсветка категории следует за текстом всюду, где он меняется программно
    // (восстановление черновика, правка заявки, очистка формы), — syncCount
    // зовут во всех этих местах
    var m = /^\s*\[(T-[A-Z-]+)\]/.exec($('reqText').value);
    syncQmChips(m ? m[1] : null);
    syncMain();
  }

  function formErr(msg) {
    var el = $('submitErr');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
    haptic('error');
  }

  // Генеративные стоп-слова (v6.2 §2.3). Текст с маркером [T-…] пропускаем:
  // внутри шаблона может лежать ЦИТАТА оппонента с любыми словами — шаблон и есть
  // то русло, куда Alert предлагает направить запрос.
  var STOP_GEN = /(напиши|состав(?:ь|ьте)|придумай|эссе|конспект)/i;

  function trySend() {
    if (sending) return;
    if (!authed()) { formErr('Отправка работает только внутри Telegram.'); return; }

    var n = textLen();
    if (n < 15) { formErr('Вызов слишком короткий: нужно не меньше 15 символов, сейчас ' + n + '. Опишите суть — так разбор будет точнее.'); return; }
    if (n > 4000) { formErr('Слишком длинно: до 4000 символов, сейчас ' + n + '. Пришлите главное, остальное дополните в боте.'); return; }
    var rawText = $('reqText').value;
    if (!/^\s*\[T-/.test(rawText) && STOP_GEN.test(rawText)) {
      formErr('⚠️ Нецелевой запрос: КАВАЧАМ — аналитик, а не писатель, эссе и конспекты он не пишет. ' +
              'Выберите шаблон над полем (софизм · цитата · учебный узел) и сформулируйте вопрос к первоисточникам.');
      return;
    }
    if (!baseOn && !scopeSel.length) {
      formErr('Основа снята, а слои не выбраны — разбору не по чему искать. Включите основу или отметьте хотя бы один слой.');
      return;
    }

    // v6.2 (v6.2 §2.2): режим правки queued-заявки — PATCH, место в очереди сохраняется.
    if (editing && editing.status === 'queued') {
      formErr(null);
      sending = true; syncMain(); $('btnSend').disabled = true;
      api('/api/requests/' + editing.id, { method: 'PATCH', body: { text: rawText.trim() } })
        .then(function () {
          haptic('success');
          var rid = editing.id;
          stopEditing();
          draftClear(); $('reqText').value = ''; syncCount();
          mineDirty = true; mountProfile();
          showState($('submitDone'), '<span class="state-h">Правка сохранена</span>Заявка №' + rid +
            ' обновлена, место в очереди прежнее.' +
            '<br><button class="btn btn-ghost" type="button" data-go-mine>Мои испытания</button>' +
            '<button class="btn btn-ghost" type="button" data-again>Прислать ещё вызов</button>', false);
          doneShown = true; $('submitForm').hidden = true; syncTerminalMain();
        })
        .catch(function (err) { formErr((err && err.message) || 'Не удалось сохранить правку.'); })
        .then(function () { sending = false; $('btnSend').disabled = false; syncMain(); });
      return;
    }

    formErr(null);
    sending = true;
    syncMain();
    $('btnSend').disabled = true;
    if (inTelegram && tg.MainButton && tg.MainButton.showProgress) {
      try { tg.MainButton.showProgress(true); } catch (e) {}
    }

    // v6.2: отправка доработанного черновика = обычная постановка в КОНЕЦ очереди
    // (новый номер — честный FIFO), а исходный черновик после успеха удаляется.
    var draftToConsume = (editing && editing.status === 'draft') ? editing.id : null;

    api('/api/requests', {
      method: 'POST',
      body: {
        text: $('reqText').value.trim(),
        // Контракт v6.0: основа передаётся ЯВНО. corpora без «prabhupada» —
        // исследовательский режим (сервер ставит заявке флаг research_mode).
        corpora: (baseOn ? ['prabhupada'] : []).concat(scopeSel),
        // v6.1: точечный выбор из дерева — только ЧАСТИЧНО выбранные группы;
        // пустой список = сужения нет (сервер трактует так же)
        books: collectBooks(),
        show_name: !!$('showName').checked
      }
    }).then(function (res) {
      haptic('success');
      if (draftToConsume != null) {
        stopEditing();
        api('/api/requests/' + draftToConsume + '/cancel', { method: 'POST', body: { action: 'delete' } })
          .catch(function () { /* черновик остался — человек удалит руками, заявка уже в очереди */ });
      }
      draftClear();
      $('reqText').value = '';
      // Исследовательский режим — решение на КОНКРЕТНУЮ заявку, не «раз и навсегда»:
      // после отправки основа возвращается (та же логика, что у согласия на имя).
      baseOn = true;
      if (TREE) {
        var b = baseGi();
        if (b >= 0) TREE[b].books.forEach(function (_, bi) { gSel[b][bi] = 1; });
        syncScopeKeysFromTree();
      }
      syncCorpusUI();
      syncResearchNote();
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
    $('draftRestored').hidden = true;   // человек начал печатать — плашка своё отработала
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
     v6.2 — v6.2 (правка/отмена/Архив черновиков) + v6.2 (чипы-шаблоны).
     Грейсфул-деградация: если сервер ещё не обновлён (эндпоинтов нет), любые
     действия отвечают честным сообщением, а данные пользователя не теряются.
     ══════════════════════════════════════════════════════════════════ */

  // ── Режим правки: заявка из очереди (PATCH) или черновик из Архива ──
  var editing = null;   // {id, status: 'queued'|'draft'} | null

  function startEditing(it) {
    editing = { id: it.id, status: it.status };
    doneShown = false;
    $('submitDone').hidden = true;
    $('submitForm').hidden = false;
    var ta = $('reqText');
    ta.value = String(it.text || '');
    syncCount();
    var warn = (it.status === 'queued' && /…\s*$/.test(ta.value))
      ? ' ⚠️ Показана сокращённая версия (превью): сохранив её, вы замените полный текст заявки этим.'
      : '';
    $('editBanner').textContent = (it.status === 'draft'
      ? '✏️ Дорабатываете черновик №' + it.id + ': «Отправить» поставит его в конец очереди, «Отложить» — сохранит обратно в Архив.'
      : '✏️ Правите заявку №' + it.id + ' — место в очереди сохранится.') + warn;
    $('editBanner').hidden = false;
    $('btnEditCancel').hidden = false;
    $('btnSend').textContent = it.status === 'queued' ? 'Сохранить правку' : 'Отправить в очередь';
    $('btnDraft').hidden = it.status === 'queued';   // у queued свой путь в Архив — кнопка «Отменить» в карточке
    scrollToEl($('submitForm'));
    ta.focus();
  }

  function stopEditing() {
    editing = null;
    $('editBanner').hidden = true;
    $('btnEditCancel').hidden = true;
    $('btnSend').textContent = 'Отправить вызов';
    $('btnDraft').hidden = false;
  }

  $('btnEditCancel').addEventListener('click', function () {
    haptic('light');
    stopEditing();
    $('reqText').value = '';
    syncCount();
    formErr(null);
  });

  // ── v6.2 §2.3: «Отложить в Архив» ──
  $('btnDraft').addEventListener('click', function () {
    if (sending) return;
    if (!authed()) { formErr('Архив черновиков работает только внутри Telegram.'); return; }
    var text = $('reqText').value.trim();
    if (!text) { formErr('Нечего откладывать: поле пустое.'); return; }
    formErr(null);
    sending = true;
    $('btnDraft').disabled = true;
    var req = (editing && editing.status === 'draft')
      ? api('/api/requests/' + editing.id, { method: 'PATCH', body: { text: text } })
      : api('/api/requests', {
          method: 'POST',
          body: {
            text: text,
            corpora: (baseOn ? ['prabhupada'] : []).concat(scopeSel),
            books: collectBooks(),
            show_name: !!$('showName').checked,
            status: 'draft'
          }
        });
    req.then(function () {
      haptic('success');
      stopEditing();
      draftClear();
      $('reqText').value = '';
      syncCount();
      mineDirty = true;
      mountProfile();
      var el = $('submitErr');
      el.textContent = '💾 Отложено в Архив черновиков (см. «Мои испытания»). Форма свободна для нового вызова.';
      el.classList.add('is-ok');
      el.hidden = false;
      setTimeout(function () { el.hidden = true; el.classList.remove('is-ok'); }, 6000);
    }).catch(function (err) {
      formErr((err && err.message) || 'Архив пока недоступен — сервер обновляется. Текст остался в поле, ничего не потеряно.');
    }).then(function () {
      sending = false;
      $('btnDraft').disabled = false;
      syncMain();
    });
  });

  // ── v6.2 §2.2: чипы-шаблоны — маркер режима в начало текста ──
  var QM_TPL = {
    'T-SOPHISM': '[T-SOPHISM] Аргумент оппонента: {вставьте текст}',
    'T-QUOTE': '[T-QUOTE] Правда ли, что Шрила Прабхупада говорил: "{вставьте цитату}"',
    'T-EDU-SHASTRI': '[T-EDU-SHASTRI] Учебный запрос (Бхакти-шастри): {сформулируйте вопрос}',
    'T-EDU-VAIBHAVA': '[T-EDU-VAIBHAVA] Учебный запрос (Бхакти-вайбхава): {сформулируйте вопрос}',
    'T-EDU-VEDANTA': '[T-EDU-VEDANTA] Учебный запрос (Бхакти-веданта): {сформулируйте вопрос}',
    'T-EDU-SARVABHAUMA': '[T-EDU-SARVABHAUMA] Учебный запрос (Бхакти-сарвабхаума): {сформулируйте вопрос}'
  };
  // Прежний шаблон-префикс заменяется целиком (маркер + вводная фраза шаблона),
  // авторский текст после него бережём.
  var QM_PREFIX_RE = /^\s*\[T-[A-Z-]+\]\s*(?:Аргумент оппонента:|Правда ли, что Шрила Прабхупада говорил:|Учебный запрос \([^)]*\):)?\s*/;
  // НЕТРОНУТЫЙ плейсхолдер шаблона (в т.ч. в кавычках у T-QUOTE) — не авторский
  // текст, при переключении категории срезается вместе с префиксом. Иначе
  // «{сформулируйте вопрос}» наслаивался при каждом тапе по другой ступени.
  var QM_PLACEHOLDER_RE = /^"?\{(?:вставьте текст|вставьте цитату|сформулируйте вопрос)\}"?\s*/;

  function syncQmChips(code) {
    // Подсветка выбранной категории: одна активная на оба ряда; выбор ступени
    // подсвечивает и родительский чип «Учебный узел».
    Array.prototype.forEach.call(document.querySelectorAll('#qmChips [data-qm], #qmEduRow [data-qm]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-qm') === code);
    });
    $('qmEdu').classList.toggle('on', /^T-EDU-/.test(code || ''));
  }

  function insertTemplate(code) {
    var ta = $('reqText');
    var rest = ta.value.replace(QM_PREFIX_RE, '').replace(QM_PLACEHOLDER_RE, '');
    ta.value = QM_TPL[code] + (rest ? ' ' + rest : '');
    syncCount();               // счётчик + подсветка выбранной категории
    formErr(null);
    draftSave(DRAFT_TEXT, ta.value.slice(0, 4000));
    ta.focus();
    var i = ta.value.indexOf('{');
    var j = ta.value.indexOf('}');
    if (i >= 0 && j > i) { try { ta.setSelectionRange(i, j + 1); } catch (e) {} }
    haptic('select');
  }

  Array.prototype.forEach.call(document.querySelectorAll('#qmChips [data-qm], #qmEduRow [data-qm]'), function (b) {
    b.addEventListener('click', function () { insertTemplate(b.getAttribute('data-qm')); });
  });
  var eduHideTimer = null;
  $('qmEdu').addEventListener('click', function () {
    var row = $('qmEduRow');
    // Источник правды — класс .open, НЕ hidden: hidden в момент анимации
    // сворачивания ещё false, и быстрый повторный тап читал бы его как «открыто».
    var open = !row.classList.contains('open');
    // таймер прошлого сворачивания ОБЯЗАН быть снят: иначе он прячет ряд
    // через мгновение после нового открытия (гонка rAF против setTimeout)
    clearTimeout(eduHideTimer);
    if (open) {
      row.hidden = false;                  // сперва вернуть в раскладку…
      requestAnimationFrame(function () { row.classList.add('open'); });  // …потом кадр на transition
    } else {
      row.classList.remove('open');        // закрытие — синхронно, rAF не нужен
      eduHideTimer = setTimeout(function () {
        if (!row.classList.contains('open')) row.hidden = true;
      }, 220);
    }
    $('qmEdu').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('qmEdu').classList.toggle('expanded', open);
    haptic('light');
  });

  // ℹ️ детали формы: тот же паттерн раскрытия, что у ступеней (не hover-тултип —
  // на тач-экране ховера нет)
  $('reqInfo').addEventListener('click', function () {
    var body = $('reqInfoBody');
    body.hidden = !body.hidden;
    $('reqInfo').setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    haptic('light');
  });

  // ── v6.2 §2.1: отмена заявки — нативный трёхкнопочный попап Telegram ──
  function askThree(message, onDelete, onDraft) {
    if (inTelegram && typeof tg.showPopup === 'function') {
      try {
        tg.showPopup({
          title: 'Снять заявку с очереди?',
          message: message,
          buttons: [
            { id: 'draft', type: 'default', text: '💾 В черновики' },
            { id: 'delete', type: 'destructive', text: '🗑 Удалить' },
            { id: 'back', type: 'cancel' }
          ]
        }, function (id) {
          if (id === 'delete') onDelete();
          else if (id === 'draft') onDraft();
        });
        return;
      } catch (e) { /* упадём в фолбэк */ }
    }
    // Вне Telegram: два шага из «да/нет» (порядок сохраняет UX-защиту ТЗ)
    askConfirm(message + '\n\nСохранить текст в Архив черновиков? («Отмена» = следующий вопрос — удалить навсегда)', function (toDraft) {
      if (toDraft) { onDraft(); return; }
      askConfirm('Удалить текст заявки навсегда?', function (kill) { if (kill) onDelete(); });
    });
  }

  function doCancel(rid, action) {
    api('/api/requests/' + rid + '/cancel', { method: 'POST', body: { action: action } })
      .then(function () {
        haptic('success');
        if (editing && editing.id === rid) { stopEditing(); $('reqText').value = ''; syncCount(); }
        mineDirty = true;
        loadMine();
      })
      .catch(function (err) {
        haptic('error');
        showState($('profileState'), (err && err.message) || 'Не получилось — сервер обновляется, попробуйте позже.', true);
      });
  }

  function askCancel(it) {
    if (it.status === 'draft') {
      askConfirm('Удалить черновик №' + it.id + ' навсегда?', function (ok) {
        if (ok) doCancel(it.id, 'delete');
      });
      return;
    }
    askThree(
      'Заявка №' + it.id + ': это освободит место для других участников. Можно удалить текст навсегда или отложить его в Архив черновиков, чтобы доработать позже.',
      function () { doCancel(it.id, 'delete'); },
      function () { doCancel(it.id, 'move_to_draft'); }
    );
  }

  /* ══════════════════════════════════════════════════════════════════
     ГОЛОСОВОЙ ВВОД — Deepgram через сервис kavacham-stt (Cloud Run).

     Ключ Deepgram живёт ТОЛЬКО на сервере: приложение шлёт сырое аудио
     на POST /api/stt и получает { transcript }. Тот же сервис и тот же
     батч-эндпоинт, что у виджета «О проекте» на лендинге, — origin
     https://dgdbvgm-tech.github.io у них общий, CORS уже разрешён.

     Честность интерфейса:
       • кнопка появляется ТОЛЬКО там, где запись реально возможна
         (getUserMedia + MediaRecorder) — в WebView без них блока нет;
       • отказ в доступе к микрофону / сбой сети — внятное сообщение,
         обычный ввод текстом продолжает работать (деградация, не тупик);
       • распознанный текст ДОПИСЫВАЕТСЯ к уже введённому, не затирая его.
     Предел записи — 60 секунд: таймер виден, за 10 секунд до предела
     предупреждаем, по истечении останавливаем сами.
     ══════════════════════════════════════════════════════════════════ */
  (function () {
    var STT_URL = 'https://kavacham-stt-928986955802.us-central1.run.app/api/stt';
    var MAX_SEC = 60;

    var row = $('voiceRow'), mic = $('voiceMic'), status = $('voiceStatus'),
        vText = $('voiceText'), vTimer = $('voiceTimer'), vStop = $('voiceStop'),
        vNote = $('voiceNote');
    if (!row) return;

    // Признак «записать можно» — как в виджете лендинга. Без него блок скрыт:
    // рисовать микрофон, который не запишет, — обман интерфейсом.
    var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    if (!canRecord) return;
    row.hidden = false;

    var stream = null, mr = null, chunks = [], tick = null, t0 = 0, busy = false;

    function note(msg) {
      if (msg) { vNote.textContent = msg; vNote.hidden = false; }
      else { vNote.hidden = true; vNote.textContent = ''; }
    }
    function fmtSec(s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    // idle — только кнопка; rec — статус с волной, таймером и «Стоп»; busy — «распознаю…»
    function show(state) {
      mic.hidden = state !== 'idle';
      status.hidden = state === 'idle';
      status.classList.toggle('rec', state === 'rec');
      vStop.hidden = state !== 'rec';
      vTimer.hidden = state !== 'rec';
    }
    function stopTracks() {
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    }

    function startRec() {
      if (busy || (mr && mr.state === 'recording')) return;
      note(null);
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        stream = s;
        chunks = [];
        // opus/webm — родной формат Chromium-WebView; где его нет (iOS даёт
        // audio/mp4) — берём формат по умолчанию, Deepgram понимает оба.
        try { mr = new MediaRecorder(s, { mimeType: 'audio/webm;codecs=opus' }); }
        catch (e) {
          try { mr = new MediaRecorder(s); }
          catch (e2) {
            stopTracks();
            note('Запись в этом окружении недоступна — введите текст с клавиатуры.');
            return;
          }
        }
        mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
        mr.onstop = onRecorded;
        mr.start(250);
        haptic('light');
        t0 = Date.now();
        vText.textContent = 'слушаю… говорите';
        vTimer.textContent = '0:00';
        show('rec');
        tick = setInterval(function () {
          var sec = Math.floor((Date.now() - t0) / 1000);
          vTimer.textContent = fmtSec(Math.min(sec, MAX_SEC));
          if (sec >= MAX_SEC) {
            note('Предел записи — 60 секунд: остановил сам и распознаю сказанное. Продолжить можно новой записью.');
            stopRec();
          } else if (sec >= MAX_SEC - 10) {
            vText.textContent = 'ещё ' + (MAX_SEC - sec) + ' сек — и запись остановится';
          }
        }, 250);
      }).catch(function () {
        show('idle');
        note('Нет доступа к микрофону. Разрешите доступ в настройках — или просто введите текст с клавиатуры.');
      });
    }

    function stopRec() {
      if (tick) { clearInterval(tick); tick = null; }
      haptic('medium');
      try {
        if (mr && mr.state !== 'inactive') mr.stop();  // onstop доделает остальное
        else { stopTracks(); show('idle'); }
      } catch (e) { stopTracks(); show('idle'); }
    }

    function onRecorded() {
      stopTracks();
      if (!chunks.length) {
        show('idle');
        note('Звук не записался — попробуйте ещё раз или введите текстом.');
        return;
      }
      var blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
      chunks = [];
      busy = true;
      vText.textContent = 'распознаю…';
      show('busy');
      fetch(STT_URL, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(function (d) {
          busy = false;
          show('idle');
          var tr = ((d && d.transcript) || '').trim();
          if (!tr) { note('Не расслышал — скажите ещё раз ближе к микрофону или введите текстом.'); return; }
          insertTranscript(tr);
        })
        .catch(function () {
          busy = false;
          show('idle');
          note('Распознавание не ответило (сеть или сервис). Текст можно ввести с клавиатуры.');
        });
    }

    // Расшифровка ДОПИСЫВАЕТСЯ: уже введённое не затираем, курсор — в конец,
    // счётчик и черновик обновляем тем же путём, что и ручной ввод.
    function insertTranscript(tr) {
      var ta = $('reqText');
      var joined = ta.value ? (ta.value.replace(/\s+$/, '') + ' ' + tr) : tr;
      if (joined.length > 4000) {
        joined = joined.slice(0, 4000);
        note('Часть расшифровки не поместилась: поле вмещает 4000 символов.');
      }
      ta.value = joined;
      syncCount();
      formErr(null);
      draftSave(DRAFT_TEXT, ta.value.slice(0, 4000));
      try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
      haptic('success');
    }

    mic.addEventListener('click', startRec);
    vStop.addEventListener('click', stopRec);
    // Ушли с экрана во время записи — не держим микрофон открытым:
    // останавливаем запись, расшифровка доедет в черновик.
    window.addEventListener('hashchange', function () {
      if (mr && mr.state === 'recording') stopRec();
    });
  })();

  /* ══════════════════════════════════════════════════════════════════
     МОИ ИСПЫТАНИЯ (бывший «Кабинет») — конвейер стадий, честный.

     Сервер отдаёт три вещи:
       pipeline — общий маршрут: В очереди → Разведка ядром → Сверка праман (HITL)
                  → Опубликовано (плюс «Отклонена» — выход в сторону);
       stage    — где заявка СЕЙЧАС (ключ, метка, подсказка, дата входа);
       timeline — какие стадии уже БЫЛИ, с датами.
     Рисуем ровно это и ничего сверх:
       • пройденное берём ТОЛЬКО из timeline — это факты;
       • предстоящее — из pipeline и БЕЗ дат: маршрут не обещает дату;
       • стадию, которой у заявки не было, «пройденной» не рисуем НИКОГДА.
         У заявки, заведённой до появления конвейера, timeline честно короткий
         («В очереди 12 июля» → «Опубликовано 13 июля») — так и покажем.
     Если бэкенд ещё не обновлён (страницы и API выкатываются раздельно), stage и
     timeline не придут — тогда работает прежний вид: один бейдж статуса.
     ══════════════════════════════════════════════════════════════════ */

  // Фолбэк на случай ответа без stage (старый бэкенд): метка и цвет бейджа.
  var STATUS = {
    queued:    { label: 'В очереди',     cls: 'st-queued' },
    scouting:  { label: 'Разведка',      cls: 'st-scouting' },
    verifying: { label: 'Сверка праман', cls: 'st-verifying' },
    done:      { label: 'Опубликовано',  cls: 'st-done' },
    rejected:  { label: 'Отклонена',     cls: 'st-rejected' },
    draft:     { label: 'Черновик',      cls: 'st-draft' },      // v6.2
    cancelled: { label: 'Отменена',      cls: 'st-cancelled' }   // v6.2
  };
  var IN_WORK = { scouting: 1, verifying: 1 };   // заявка в руках движка/человека
  var PIPE_MARK = { past: '✓', now: '◉', next: '○' };
  var PIPE_SR = { past: ' — пройдено', now: ' — сейчас', next: ' — предстоит' };

  var mineDirty = true;    // список заявок устарел (первый вход / после отправки)
  var mineAt = 0;          // когда загружали в последний раз
  var minePipe = null;     // маршрут стадий с последнего ответа сервера
  var MINE_TTL = 30000;
  var mineItems = [];      // v6.2: последний список целиком (для табов Заявки/Черновики)
  var mineView = 'req';    // 'req' | 'drafts'

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
      minePipe = (d && Array.isArray(d.pipeline)) ? d.pipeline : null;
      mineDirty = false;
      mineAt = Date.now();

      mineItems = items;
      if (!items.length) {
        $('mineTabs').hidden = true;
        showState(stateEl,
          '<span class="state-h">Испытаний пока нет</span>' +
          'Пришлите вызов — софизм, мем, искажение или сложный вопрос. Разбор придёт сюда и в бота.' +
          '<br><button class="btn btn-ghost" type="button" data-go-form>Инициировать разбор</button>', false);
        return;
      }
      renderMineView();
      stateEl.hidden = true;
      listEl.hidden = false;
    }).catch(function (err) {
      showState(stateEl,
        '<span class="state-h">Не удалось загрузить заявки</span>' +
        (err && err.message ? err.message : '') +
        '<br><button class="btn btn-ghost" type="button" data-retry-mine>Повторить</button>', true);
    });
  }

  // Строки конвейера одной заявки. null → рисовать нечестно нечего (нет данных):
  // тогда карточка остаётся с одним бейджем, как до Этапа 2.
  function stageRows(it, pipeline) {
    var tl = (it && Array.isArray(it.timeline))
      ? it.timeline.filter(function (e) { return e && e.key; }) : [];
    var pipe = Array.isArray(pipeline) ? pipeline : [];
    if (!tl.length || !pipe.length) return null;

    var stage = it.stage || null;
    var curKey = (stage && stage.key) || it.status;
    var final = stage ? !!stage.final : (curKey === 'done' || curKey === 'rejected');

    var curIdx = (stage && typeof stage.index === 'number') ? stage.index : -1;
    if (curIdx < 0 && !final) {
      pipe.forEach(function (s, i) { if (s.key === curKey) curIdx = i; });
    }
    // финал закрывает маршрут: всё, что было ДО него, — позади. «Отклонена» вне
    // линейного маршрута (index -1), поэтому граница считается отдельно.
    var edge = final ? pipe.length + 1 : curIdx;

    // стадия могла повториться (человек вернул черновик из сверки в разведку) —
    // в строке маршрута показываем последнюю дату, полная история есть в боте (/status)
    var last = {};
    tl.forEach(function (e) { last[e.key] = e; });

    var rows = [];
    pipe.forEach(function (s, i) {
      var idx = (typeof s.index === 'number') ? s.index : i;
      var e = last[s.key];
      if (e && idx <= edge) {
        rows.push({ label: s.label, at: e.at, state: (s.key === curKey ? 'now' : 'past') });
      } else if (!final && idx > edge) {
        // предстоит; если стадия уже была — это возврат на доработку, не прячем
        rows.push({ label: s.label, at: null, state: 'next', again: !!e });
      }
      // иначе стадию ПРОПУСТИЛИ (записи нет, а заявка уже дальше) — не рисуем её
      // вовсе: «пройденной» она не была, врать о ней нельзя
    });

    if (final && curIdx < 0 && last[curKey]) {      // «Отклонена» — только фактом
      rows.push({ label: (stage && stage.label) || String(curKey), at: last[curKey].at, state: 'now' });
    }
    return rows.length ? rows : null;
  }

  function renderPipe(rows) {
    var ol = document.createElement('ol');
    ol.className = 'pipe';
    ol.setAttribute('aria-label', 'Стадии разбора');
    rows.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'pipe-s is-' + r.state;

      var mark = document.createElement('span');
      mark.className = 'pipe-m';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = PIPE_MARK[r.state] || '·';
      li.appendChild(mark);

      var label = document.createElement('span');
      label.className = 'pipe-l';
      label.textContent = r.label;
      var sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = PIPE_SR[r.state] || '';
      label.appendChild(sr);
      li.appendChild(label);

      var when = document.createElement('span');
      when.className = 'pipe-d mono';
      when.textContent = r.at ? fmtDay(r.at) : (r.again ? 'повторно' : '');
      li.appendChild(when);

      ol.appendChild(li);
    });
    return ol;
  }

  // Подпись под конвейером, когда сервер стадий не прислал (старый бэкенд).
  function legacyFoot(it) {
    if (it.status === 'queued') return 'В очереди. Порядок — по времени поступления.';
    if (it.status === 'rejected') return 'Заявка не пошла в разбор. Причину можно спросить в боте.';
    if (it.status === 'done') return it.post_url ? 'Разбор опубликован.' : 'Разбор готов. Ссылку пришлёт бот.';
    return 'Состояние заявки — как его вернул сервер.';
  }

  function addFoot(li, text) {
    if (!text) return;
    var p = document.createElement('p');
    p.className = 'req-f';
    p.textContent = text;
    li.appendChild(p);
  }

  // v6.2 (v6.2 §2.3): табы «Заявки | Черновики». Черновики — отдельная полка:
  // они не в очереди, и мешать их с живыми заявками значит врать про очередь.
  function renderMineView() {
    var drafts = mineItems.filter(function (it) { return it.status === 'draft'; });
    var reqs = mineItems.filter(function (it) { return it.status !== 'draft'; });
    $('draftCount').textContent = String(drafts.length);
    $('mineTabs').hidden = !drafts.length && mineView === 'req' ? true : false;
    if (!drafts.length && mineView === 'drafts') mineView = 'req';
    $('mineTabReq').classList.toggle('on', mineView === 'req');
    $('mineTabReq').setAttribute('aria-selected', mineView === 'req' ? 'true' : 'false');
    $('mineTabDrafts').classList.toggle('on', mineView === 'drafts');
    $('mineTabDrafts').setAttribute('aria-selected', mineView === 'drafts' ? 'true' : 'false');
    renderMine(mineView === 'drafts' ? drafts : reqs, minePipe);
  }
  $('mineTabReq').addEventListener('click', function () { mineView = 'req'; haptic('select'); renderMineView(); });
  $('mineTabDrafts').addEventListener('click', function () { mineView = 'drafts'; haptic('select'); renderMineView(); });

  function renderMine(items, pipeline) {
    var listEl = $('profileList');
    listEl.textContent = '';

    items.forEach(function (it) {
      var stage = it.stage || null;
      var key = (stage && stage.key) || it.status;
      var fb = STATUS[key];
      // метку берём у сервера; неизвестный ключ не переводим и не выдумываем
      var label = (stage && (stage.short || stage.label)) || (fb ? fb.label : String(key || '—'));
      var cls = fb ? fb.cls : 'st-unknown';

      var li = document.createElement('li');
      li.className = 'req' + (IN_WORK[key] ? ' is-work' : '');

      var head = document.createElement('div');
      head.className = 'req-head';

      var num = document.createElement('span');
      num.className = 'req-n mono';
      num.textContent = '№' + (it.id != null ? it.id : '—');
      head.appendChild(num);

      var badge = document.createElement('span');
      badge.className = 'req-st ' + cls;
      badge.textContent = label;
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

      // флаг исследовательского режима — показываем только фактом от сервера
      if (it.research_mode === true) {
        var rm = document.createElement('p');
        rm.className = 'req-f research-flag';
        rm.textContent = '🔬 исследовательский режим: без корпуса основы';
        li.appendChild(rm);
      }

      var rows = stageRows(it, pipeline);
      if (rows) li.appendChild(renderPipe(rows));

      // Что происходит сейчас — фразой сервера (на «Сверке праман» это и есть
      // главное: цитаты проверяет человек, а не движок сам себя).
      addFoot(li, (stage && stage.hint) ? stage.hint : legacyFoot(it));
      if (key === 'done' && !it.post_url) addFoot(li, 'Ссылку на публикацию пришлёт бот.');

      if (key === 'queued' && typeof it.position === 'number' && it.position > 0) {
        var q = document.createElement('p');
        q.className = 'req-f';
        q.appendChild(document.createTextNode('Место в очереди: '));
        var b = document.createElement('b');
        b.className = 'mono';
        b.textContent = String(it.position);
        q.appendChild(b);
        li.appendChild(q);
      }

      if (it.post_url && /^https?:\/\//i.test(it.post_url)) {
        var a = document.createElement('a');
        a.className = 'btn btn-ghost';
        a.href = it.post_url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Открыть разбор';
        li.appendChild(a);
      }

      // v6.2 (v6.2 §2.1–2.2): управление — СТРОГО пока заявка «В очереди»
      // (ушла в разведку — кнопки пропадают, ресурс уже тратится) или это черновик.
      if (key === 'queued' || key === 'draft') {
        var act = document.createElement('div');
        act.className = 'req-actions';
        var bEdit = document.createElement('button');
        bEdit.type = 'button';
        bEdit.className = 'mini';
        bEdit.textContent = key === 'draft' ? '✏ Доработать' : '✎ Изменить';
        bEdit.addEventListener('click', function () { haptic('light'); startEditing(it); });
        act.appendChild(bEdit);
        var bCancel = document.createElement('button');
        bCancel.type = 'button';
        bCancel.className = 'mini mini-danger';
        bCancel.textContent = key === 'draft' ? '🗑 Удалить' : '✖ Отменить';
        bCancel.addEventListener('click', function () { haptic('light'); askCancel(it); });
        act.appendChild(bCancel);
        li.appendChild(act);
      }

      listEl.appendChild(li);
    });
  }

  $('mineRefresh').addEventListener('click', function () {
    haptic('light');
    mineDirty = true;
    loadMine();
  });

  /* ══════════════════════════════════════════════════════════════════
     ОБОГАЩЕНИЕ (вкладка 3) — воронка со-создателей.

     Форма на экране ОДНА и переезжает в раскрытую карточку (см. openContrib).
     Шесть отдельных форм на 390×600 — это простыня, в которой не найти ни одной;
     а ещё это шесть реализаций галочки «указать имя» — то есть шесть шансов
     ошибиться в красной линии проекта. Одна форма — одна галочка — один код.

     Красная линия (анонимность): #contribShowName сбрасывается в false при КАЖДОМ
     открытии и закрытии формы, и НИГДЕ не сохраняется — ни в localStorage, ни в
     CloudStorage. Черновик заявки мы бережём (там человек пишет долго), а согласие
     на имя переживать сессию НЕ должно: согласие даётся на конкретный вклад, а не
     «однажды и навсегда».
     ══════════════════════════════════════════════════════════════════ */

  // Презентация вектора: какие поля показать и как подписать. Это ВЁРСТКА, а не
  // контракт: белый список типов держит сервер, и последнее слово за ним (разъедемся —
  // он ответит внятной ошибкой, а не молча примет мусор). Ключи направлений
  // компетенции здесь НЕ дублируются — они приходят с сервера (см. loadRoles).
  // Вектора B тут нет намеренно: «бросить вызов» — обычная заявка, она на Терминале.
  var CONTRIB_UI = {
    book: {
      vector: 'A · Книги и форумы',
      label: 'Что за издание',
      ph: 'Автор, название, издание. Чем оно ценно и почему считается выверенным.',
      hint: 'Файл в это поле не вложить — приложение загрузку файлов не умеет. PDF или EPUB примет бот: команда /book, затем пришлите документ.',
      url: 'optional',
      urlLabel: 'Ссылка на источник',
      urlHint: 'Необязательно — но со ссылкой издание проверят быстрее.',
      cmd: '/book',
      done: 'Издание уйдёт на сверку легитимности и качества перевода: в корпус попадает только то, что проверку прошло.'
    },
    discussion: {
      vector: 'A · Книги и форумы',
      label: 'Что там за спор',
      ph: 'Пара слов: о чём спорят, кто с кем и почему это стоит мониторинга.',
      url: 'required',
      urlLabel: 'Ссылка на дискуссию',
      urlHint: 'Обязательно: без ссылки наводку не проверить, а непроверяемое мы в работу не берём.',
      cmd: '/discussion',
      done: 'Наводку посмотрит человек: что там за спор и ставить ли его на мониторинг трендов.'
    },
    skill: {
      vector: 'C · Соратники',
      label: 'Что вы умеете',
      ph: 'Опыт, чем именно готовы помочь, сколько у вас на это времени.',
      hint: 'Ссылку на профиль или работы можно вставить прямо в текст.',
      url: 'none',
      role: true,
      cmd: '/skill',
      done: 'Автор проекта свяжется с вами лично. Служение — не вакансия: сначала разговор.'
    },
    patron: {
      vector: 'D · Поддержка',
      label: 'Чем можете помочь',
      ph: 'Например: могу закрывать счёт за API; помогу с доменом; сведу с жертвователем.',
      hint: 'Напишите, как с вами связаться. Платёжной кнопки здесь нет: договорённость идёт через живого человека.',
      url: 'none',
      cmd: '/patron',
      done: 'Автор проекта свяжется с вами и покажет, куда именно уходят средства. Отчёт по расходам — по запросу, конкретными цифрами.'
    },
    bug: {
      vector: 'E · Воронка фидбека',
      label: 'Что сломалось',
      ph: 'Что вы делали → что ожидали увидеть → что увидели на самом деле.',
      hint: 'Скриншот сюда не вложить: пришлите его в бота командой /bug.',
      url: 'none',
      cmd: '/bug',
      done: 'Баг уйдёт в бэклог проекта. Если для починки понадобятся детали, автор проекта напишет вам в бот.'
    },
    idea: {
      vector: 'E · Воронка фидбека',
      label: 'Что предлагаете',
      ph: 'Чего не хватает и какую задачу это решит.',
      hint: '',
      url: 'none',
      cmd: '/idea',
      done: 'Идея уйдёт в бэклог проекта. Возьмут её в работу или нет — решает автор проекта; публичной доски задач у нас пока нет, поэтому обещать «следите за карточкой» не будем.'
    }
  };

  var CONTRIB_MIN = 5;
  var CONTRIB_MAX = 4000;
  var contribKind = null;      // какой вектор раскрыт сейчас (null — все свёрнуты)
  var contribSending = false;
  var kindsReq = null;         // GET /api/contributions/kinds — один запрос на всё приложение

  function fetchKinds() {
    if (!kindsReq) {
      kindsReq = api('/api/contributions/kinds').then(function (d) { return d || {}; });
    }
    return kindsReq;
  }

  function enterEnrich() {
    // Вне Telegram честно говорим, что форм здесь нет, и называем команды бота.
    $('enrichGate').hidden = authed();
    closeContrib();            // возвращаясь на вкладку, не оставляем раскрытую форму
    loadBoards();              // v6.3: доски Лаборатории (свой TTL внутри)
  }

  function contribErr(msg) {
    var el = $('contribErr');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
    haptic('error');
  }

  function contribLen() { return $('contribText').value.trim().length; }

  function contribValid() {
    if (contribSending || !contribKind) return false;
    var n = contribLen();
    if (n < CONTRIB_MIN || n > CONTRIB_MAX) return false;
    var ui = CONTRIB_UI[contribKind];
    if (ui.url === 'required' && !$('contribUrl').value.trim()) return false;
    return true;
  }

  function syncContribCount() {
    var n = $('contribText').value.length;
    $('contribCount').textContent = String(n);
    $('contribCount').parentNode.classList.toggle('warn', n > 0 && contribLen() < CONTRIB_MIN);
    syncMain();
  }

  function syncEnrichMain() {
    if (authed() && contribKind && !$('contribForm').hidden) {
      setMainButton('Отправить вклад', trySendContrib, contribValid);
      syncMain();
      return;
    }
    setMainButton(null);
  }

  // Направления компетенции — ТОЛЬКО с сервера. Свой список ключей в приложении был бы
  // вторым источником правды: разъедется с сервером — человек заполнит форму и получит
  // 400 на ровном месте. Не пришли — поле прячем и шлём вклад без направления (сервер
  // это допускает); выдумывать ключи не станем.
  function loadRoles() {
    var sel = $('contribRole'), hint = $('contribRoleHint'), field = $('contribRoleField');
    sel.textContent = '';
    hint.textContent = 'Загружаю направления…';
    field.hidden = false;

    fetchKinds().then(function (d) {
      var roles = (d && Array.isArray(d.roles)) ? d.roles : [];
      if (!roles.length) { field.hidden = true; return; }
      sel.appendChild(new Option('— не выбрано —', ''));
      roles.forEach(function (r) {
        if (r && r.key) sel.appendChild(new Option(r.label || r.key, r.key));
      });
      hint.textContent = 'Необязательно — но так автор проекта поймёт, с чего начать разговор.';
    }).catch(function () {
      kindsReq = null;
      field.hidden = true;
    });
  }

  function openContrib(kind, card) {
    var ui = CONTRIB_UI[kind];
    if (!ui || !card) return;

    // Вне Telegram подписать вклад нечем. Не показываем форму, которая ничего не
    // отправит: уводим в бота и называем ТУ САМУЮ команду — там вклад принимается целиком.
    if (!authed()) {
      haptic('warning');
      showToast('Форма работает в Telegram. В боте: ' + ui.cmd);
      openTelegram(BOT_URL);
      return;
    }

    contribKind = kind;

    var panel = $('contribPanel');
    card.appendChild(panel);          // одна форма на все векторы — она переезжает в карточку
    panel.hidden = false;

    $('contribVector').textContent = ui.vector;
    $('contribLabel').textContent = ui.label;

    var ta = $('contribText');
    ta.value = '';
    ta.placeholder = ui.ph || '';

    var h = $('contribHint');
    h.textContent = ui.hint || '';
    h.hidden = !ui.hint;

    var uf = $('contribUrlField');
    uf.hidden = (ui.url === 'none');
    $('contribUrl').value = '';
    $('contribUrlLabel').textContent = ui.urlLabel || 'Ссылка';
    $('contribUrlHint').textContent = ui.urlHint || '';

    if (ui.role) loadRoles();
    else $('contribRoleField').hidden = true;

    // КРАСНАЯ ЛИНИЯ: согласие на имя — заново на каждый вклад. Ни переноса между
    // векторами, ни памяти между сессиями.
    $('contribShowName').checked = false;

    contribErr(null);
    $('contribForm').hidden = false;
    $('contribDone').hidden = true;

    Array.prototype.forEach.call(document.querySelectorAll('[data-contrib]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-contrib') === kind);
    });

    syncContribCount();
    syncEnrichMain();
    scrollToEl(panel);
  }

  function closeContrib() {
    var panel = $('contribPanel');
    panel.hidden = true;
    $('contribForm').hidden = false;
    $('contribDone').hidden = true;
    $('contribText').value = '';
    $('contribUrl').value = '';
    $('contribShowName').checked = false;      // согласие не переживает закрытие формы
    contribErr(null);
    contribKind = null;

    // Панель возвращается на своё место в экране: остаться внутри чужой карточки она
    // не должна — иначе следующее открытие таскало бы её по DOM непредсказуемо.
    var host = $('screen-enrich');
    if (panel.parentNode !== host) host.appendChild(panel);

    Array.prototype.forEach.call(document.querySelectorAll('[data-contrib]'), function (b) {
      b.classList.remove('on');
    });
    setMainButton(null);
  }

  function trySendContrib() {
    if (contribSending || !contribKind) return;
    if (!authed()) { contribErr('Отправка работает только внутри Telegram.'); return; }

    var ui = CONTRIB_UI[contribKind];
    var n = contribLen();
    if (n < CONTRIB_MIN) {
      contribErr('Слишком коротко: нужно не меньше ' + CONTRIB_MIN + ' символов, сейчас ' + n + '.');
      return;
    }
    if (n > CONTRIB_MAX) {
      contribErr('Слишком длинно: до ' + CONTRIB_MAX + ' символов, сейчас ' + n + '.');
      return;
    }

    var url = $('contribUrl').value.trim();
    if (ui.url === 'required' && !url) {
      contribErr('Нужна ссылка на дискуссию: без неё наводку не проверить.');
      return;
    }
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
      contribErr('Ссылка должна начинаться с http:// или https:// и быть без пробелов.');
      return;
    }

    var role = (ui.role && !$('contribRoleField').hidden) ? $('contribRole').value : '';

    contribErr(null);
    contribSending = true;
    syncMain();
    $('contribSend').disabled = true;
    if (inTelegram && tg.MainButton && tg.MainButton.showProgress) {
      try { tg.MainButton.showProgress(true); } catch (e) {}
    }

    var body = {
      kind: contribKind,
      text: $('contribText').value.trim(),
      // Строго булев: сервер согласием считает только настоящий true (fail-safe),
      // и клиент обязан слать именно его — не "1", не "on".
      show_name: !!$('contribShowName').checked
    };
    if (url) body.url = url;
    if (role) body.meta = { role: role };

    api('/api/contributions', { method: 'POST', body: body }).then(function (res) {
      haptic('success');
      showContribDone(res);
    }).catch(function (err) {
      contribErr(err && err.message ? err.message : 'Не удалось отправить вклад.');
    }).then(function () {
      contribSending = false;
      $('contribSend').disabled = false;
      if (inTelegram && tg.MainButton && tg.MainButton.hideProgress) {
        try { tg.MainButton.hideProgress(); } catch (e) {}
      }
      syncMain();
    });
  }

  function showContribDone(res) {
    var id = (res && typeof res.id === 'number') ? res.id : null;
    var ui = CONTRIB_UI[contribKind] || {};
    var named = !!$('contribShowName').checked;

    // Номер показываем только если сервер его вернул: «принято, номер …» без номера —
    // это обещание, которого мы не держим.
    var html = '<span class="state-h">Вклад' + (id ? ' <b class="mono">№' + id + '</b>' : '') + ' принят</span>';
    html += ui.done || 'Его посмотрит человек.';
    html += '<br><br>Имя: ' + (named
      ? 'вы разрешили указать себя как автора.'
      : '<b>анонимно</b> — вклад числится за «участником Лаборатории».');
    html += '<br><button class="btn btn-ghost" type="button" data-contrib-close>Готово</button>';

    $('contribForm').hidden = true;
    showState($('contribDone'), html, false);
    setMainButton(null);      // отправлять больше нечего
  }

  $('contribText').addEventListener('input', function () {
    syncContribCount();
    contribErr(null);
  });
  $('contribUrl').addEventListener('input', function () {
    syncMain();
    contribErr(null);
  });
  $('contribShowName').addEventListener('change', function () { haptic('select'); });
  $('contribCancel').addEventListener('click', function () { haptic('light'); closeContrib(); });
  $('contribForm').addEventListener('submit', function (e) {
    e.preventDefault();
    trySendContrib();
  });

  /* ══════════════════════════════════════════════════════════════════
     ШТАБ (вкладка 5) — админ-пульт конвейера. БЕЗ пароля и без чужих секретов
     в клиенте: единственный источник права — сервер (/api/me по подписанному
     initData; все /api/admin/* дополнительно проверяют user.id в списке админов
     НА СЕРВЕРЕ). Здесь нет ни одного id админа — только булев ответ «я админ?».
     Вкладка скрыта, пока сервер не сказал is_admin=true; прямой заход на #/hq
     не-админом упирается в честный гейт (а API — в 403).
     ══════════════════════════════════════════════════════════════════ */

  var isAdmin = null;        // null — сервер ещё не отвечал; true/false — его слово
  var hqFilterKey = '';      // фильтр по стадии ('' — все)
  var hqItems = [];          // заявки с последнего ответа /api/admin/requests

  // Метки стадий и допустимые переходы — те же, что на сервере (ALLOWED_MOVES):
  // Штаб не рисует кнопку перехода, который сервер всё равно отвергнет.
  var HQ_MOVES = {
    queued:    ['scouting', 'verifying'],
    scouting:  ['verifying'],
    verifying: ['scouting'],
    done:      [],
    rejected:  []
  };
  var HQ_STAGE_BTN = { scouting: 'В разведку', verifying: 'На сверку' };

  function checkAdmin() {
    if (!authed()) { isAdmin = false; return; }
    api('/api/me').then(function (d) {
      isAdmin = !!(d && d.is_admin === true);
      if (isAdmin) $('tabHq').hidden = false;
      if (current.name === 'hq') enterHq();   // человек уже стоит на #/hq — обновим экран
    }).catch(function () {
      isAdmin = false;
      if (current.name === 'hq') enterHq();
    });
  }

  function enterHq() {
    var gate = $('hqGate'), body = $('hqBody');
    if (isAdmin === true) {
      gate.hidden = true;
      body.hidden = false;
      loadHq();
      return;
    }
    // не-админ, гость или сервер ещё не ответил — честный гейт (сервер всё равно 403)
    gate.hidden = false;
    body.hidden = true;
  }

  function loadHq() {
    loadHqStats();
    loadHqRequests();
    loadHqContribs();
    loadHqMessages();          // v6.3: сигналы связи (консоль Оператора)
  }

  function loadHqStats() {
    var el = $('hqStats');
    el.textContent = 'Загружаю сводку…';
    api('/api/admin/stats').then(function (d) {
      el.textContent = '';
      var r = (d && d.requests) || {};
      var c = (d && d.contributions) || {};
      function cell(k, v) {
        var w = document.createElement('span');
        w.className = 'hq-c';
        var kk = document.createElement('span');
        kk.className = 'hq-k';
        kk.textContent = k;
        var vv = document.createElement('b');
        vv.className = 'hq-v mono';
        vv.textContent = String(v == null ? '—' : v);
        w.appendChild(kk);
        w.appendChild(vv);
        return w;
      }
      el.appendChild(cell('Очередь', r.queued));
      el.appendChild(cell('В работе', r.in_work));
      el.appendChild(cell('Опубликовано', r.done));
      el.appendChild(cell('Отклонено', r.rejected));
      el.appendChild(cell('Вкладов', c.total));
      var kinds = c.by_kind || {};
      Object.keys(kinds).forEach(function (k) {
        el.appendChild(cell(k, kinds[k]));
      });
    }).catch(function (err) {
      el.textContent = 'Сводка недоступна: ' + (err && err.message ? err.message : '');
    });
  }

  function loadHqRequests() {
    var stateEl = $('hqReqState'), listEl = $('hqReqList');
    listEl.hidden = true;
    showState(stateEl, 'Загружаю заявки…', false);
    api('/api/admin/requests').then(function (d) {
      hqItems = (d && Array.isArray(d.items)) ? d.items : [];
      renderHqFilter();
      renderHqList();
      if (hqItems.length) stateEl.hidden = true;
      else showState(stateEl, '<span class="state-h">Заявок пока нет</span>Очередь пуста.', false);
    }).catch(function (err) {
      showState(stateEl,
        '<span class="state-h">Не удалось загрузить заявки</span>' +
        (err && err.message ? err.message : '') +
        '<br><button class="btn btn-ghost" type="button" data-retry-hq>Повторить</button>', true);
    });
  }

  function renderHqFilter() {
    var navEl = $('hqFilter');
    navEl.textContent = '';
    if (!hqItems.length) { navEl.hidden = true; return; }

    var counts = Object.create(null);
    hqItems.forEach(function (it) {
      var k = it.status || 'queued';
      counts[k] = (counts[k] || 0) + 1;
    });

    function chip(key, title, count) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (key === hqFilterKey ? ' on' : '');
      var t = document.createElement('span');
      t.textContent = title;
      b.appendChild(t);
      var c = document.createElement('span');
      c.className = 'chip-n';
      c.textContent = String(count);
      b.appendChild(c);
      b.addEventListener('click', function () {
        haptic('select');
        hqFilterKey = key;
        renderHqFilter();
        renderHqList();
      });
      return b;
    }

    navEl.appendChild(chip('', 'Все', hqItems.length));
    Object.keys(STATUS).forEach(function (k) {
      if (counts[k]) navEl.appendChild(chip(k, STATUS[k].label, counts[k]));
    });
    navEl.hidden = false;
  }

  function renderHqList() {
    var listEl = $('hqReqList');
    listEl.textContent = '';
    var slice = hqFilterKey
      ? hqItems.filter(function (it) { return (it.status || 'queued') === hqFilterKey; })
      : hqItems;
    if (!slice.length) {
      var li = document.createElement('li');
      li.className = 'req';
      li.textContent = 'В этой стадии заявок нет.';
      listEl.appendChild(li);
      listEl.hidden = false;
      return;
    }
    slice.forEach(function (it) { listEl.appendChild(renderHqCard(it)); });
    listEl.hidden = false;
  }

  function hqCardErr(li, msg) {
    var el = li.querySelector('.hq-err');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
    haptic('error');
  }

  // Действие Штаба: POST → сервер вернул обновлённую карточку → перерисовываем
  // ТОЛЬКО её (без перезагрузки списка). Сводка обновляется отдельно — она дешёвая.
  function hqAction(li, it, path, body) {
    Array.prototype.forEach.call(li.querySelectorAll('button'), function (b) { b.disabled = true; });
    hqCardErr(li, null);
    api('/api/admin/requests/' + encodeURIComponent(it.id) + path, { method: 'POST', body: body || {} })
      .then(function (res) {
        var updated = (res && res.item) ? res.item : null;
        if (updated) {
          for (var i = 0; i < hqItems.length; i++) {
            if (hqItems[i].id === updated.id) { hqItems[i] = updated; break; }
          }
          var fresh = renderHqCard(updated);
          li.parentNode.replaceChild(fresh, li);
        }
        haptic('success');
        var note = '№' + it.id + ': готово';
        if (res && res.notified === false) {
          note += '; уведомить заявителя не вышло' + (res.notify_error ? ' (' + res.notify_error + ')' : '');
        } else {
          note += '; заявитель уведомлён';
        }
        showToast(note);
        renderHqFilter();
        loadHqStats();
      })
      .catch(function (err) {
        Array.prototype.forEach.call(li.querySelectorAll('button'), function (b) { b.disabled = false; });
        hqCardErr(li, err && err.message ? err.message : 'Не удалось выполнить действие.');
      });
  }

  function renderHqCard(it) {
    var key = it.status || 'queued';
    var fb = STATUS[key];
    var stage = it.stage || null;
    var label = (stage && (stage.short || stage.label)) || (fb ? fb.label : String(key));

    var li = document.createElement('li');
    li.className = 'req hq-card' + (IN_WORK[key] ? ' is-work' : '');

    var head = document.createElement('div');
    head.className = 'req-head';

    var num = document.createElement('span');
    num.className = 'req-n mono';
    num.textContent = '№' + (it.id != null ? it.id : '—');
    head.appendChild(num);

    var badge = document.createElement('span');
    badge.className = 'req-st ' + (fb ? fb.cls : 'st-unknown');
    badge.textContent = label;
    head.appendChild(badge);

    if (it.created_at) {
      var d = document.createElement('span');
      d.className = 'req-d';
      d.textContent = fmtDate(it.created_at);
      head.appendChild(d);
    }
    li.appendChild(head);

    // автор с его аккаунтом — норма админского контура (эти данные не выходят из Штаба)
    var meta = document.createElement('p');
    meta.className = 'req-f hq-meta';
    var author = it.author || ('id ' + (it.user_id != null ? it.user_id : '—'));
    meta.textContent = author + ' · ' + (it.show_name ? '🙋 имя можно' : '🕊 аноним') +
      (it.scope ? ' · ' + it.scope : '');
    li.appendChild(meta);

    if (it.research_mode === true) {
      var rm = document.createElement('p');
      rm.className = 'req-f research-flag';
      rm.textContent = '🔬 исследовательский режим: без корпуса основы';
      li.appendChild(rm);
    }

    // текст: свёрнут в 2 строки, тап разворачивает (и сворачивает обратно)
    var p = document.createElement('p');
    p.className = 'req-t hq-clip';
    p.textContent = String(it.text || '');
    p.title = 'Показать целиком / свернуть';
    p.addEventListener('click', function () {
      p.classList.toggle('open');
      haptic('select');
    });
    li.appendChild(p);

    // путь по стадиям одной строкой — только факты из timeline
    if (Array.isArray(it.timeline) && it.timeline.length) {
      var tl = document.createElement('p');
      tl.className = 'req-f';
      tl.textContent = 'Путь: ' + it.timeline.map(function (e) {
        return (e.label || e.key) + (e.at ? ' ' + fmtDay(e.at) : '');
      }).join(' → ');
      li.appendChild(tl);
    }

    if (it.post_url && /^https?:\/\//i.test(it.post_url)) {
      var a = document.createElement('a');
      a.className = 'cite hq-url';
      a.href = it.post_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = it.post_url;
      li.appendChild(a);
    }

    var err = document.createElement('p');
    err.className = 'form-err hq-err';
    err.hidden = true;
    li.appendChild(err);

    // ——— кнопки конвейера: только легальные переходы (зеркало ALLOWED_MOVES) ———
    var actions = document.createElement('div');
    actions.className = 'hq-actions';

    (HQ_MOVES[key] || []).forEach(function (next) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost';
      b.textContent = HQ_STAGE_BTN[next];
      b.addEventListener('click', function () {
        haptic('medium');
        hqAction(li, it, '/stage', { stage: next });
      });
      actions.appendChild(b);
    });

    var terminal = (key === 'done' || key === 'rejected');
    if (!terminal || key === 'done') {
      // «Опубликовано» с полем URL; для уже опубликованной — поправить ссылку
      var urlRow = document.createElement('div');
      urlRow.className = 'hq-url-row';
      var urlInp = document.createElement('input');
      urlInp.type = 'url';
      urlInp.className = 'field-i hq-url-inp';
      urlInp.placeholder = 'https://… (ссылка на публикацию)';
      urlInp.value = it.post_url || '';
      var doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.className = 'btn btn-primary';
      doneBtn.textContent = key === 'done' ? 'Обновить ссылку' : 'Опубликовано';
      doneBtn.addEventListener('click', function () {
        var u = urlInp.value.trim();
        if (u && !/^https?:\/\/[^\s]+$/i.test(u)) {
          hqCardErr(li, 'Ссылка должна начинаться с http(s):// и быть без пробелов.');
          return;
        }
        haptic('medium');
        hqAction(li, it, '/done', { url: u });
      });
      urlRow.appendChild(urlInp);
      urlRow.appendChild(doneBtn);
      actions.appendChild(urlRow);
    }

    if (!terminal) {
      var rej = document.createElement('button');
      rej.type = 'button';
      rej.className = 'btn btn-ghost hq-reject';
      rej.textContent = 'Отклонить';
      rej.addEventListener('click', function () {
        askConfirm('Отклонить заявку №' + it.id + '? Заявитель получит вежливое уведомление; вернуть закрытую заявку в работу нельзя.', function (ok) {
          if (!ok) return;
          haptic('medium');
          hqAction(li, it, '/reject', {});
        });
      });
      actions.appendChild(rej);
    }

    if (actions.childNodes.length) li.appendChild(actions);
    return li;
  }

  function loadHqContribs() {
    var stateEl = $('hqContribState'), listEl = $('hqContribList');
    listEl.hidden = true;
    showState(stateEl, 'Загружаю вклады…', false);
    api('/api/admin/contributions').then(function (d) {
      var items = (d && Array.isArray(d.items)) ? d.items : [];
      if (!items.length) {
        showState(stateEl, '<span class="state-h">Вкладов пока нет</span>Воронка «Обогащение» пуста.', false);
        return;
      }
      listEl.textContent = '';
      items.forEach(function (c) {
        var li = document.createElement('li');
        li.className = 'req hq-card';

        var head = document.createElement('div');
        head.className = 'req-head';
        var num = document.createElement('span');
        num.className = 'req-n mono';
        num.textContent = '№' + (c.id != null ? c.id : '—');
        head.appendChild(num);
        var kind = document.createElement('span');
        kind.className = 'req-st st-queued';
        kind.textContent = ((c.mark || '') + ' ' + (c.label || c.kind || '')).trim();
        head.appendChild(kind);
        if (c.created_at) {
          var d2 = document.createElement('span');
          d2.className = 'req-d';
          d2.textContent = fmtDate(c.created_at);
          head.appendChild(d2);
        }
        li.appendChild(head);

        var meta = document.createElement('p');
        meta.className = 'req-f hq-meta';
        meta.textContent = (c.author || ('id ' + (c.user_id != null ? c.user_id : '—'))) +
          ' · ' + (c.show_name ? '🙋 имя можно' : '🕊 аноним') +
          (c.source ? ' · ' + c.source : '') +
          (c.backlog ? ' · бэклог: ' + c.backlog : '');
        li.appendChild(meta);

        var p = document.createElement('p');
        p.className = 'req-t hq-clip';
        p.textContent = String(c.text || '');
        p.addEventListener('click', function () { p.classList.toggle('open'); });
        li.appendChild(p);

        if (c.url && /^https?:\/\//i.test(c.url)) {
          var a = document.createElement('a');
          a.className = 'cite hq-url';
          a.href = c.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = c.url;
          li.appendChild(a);
        }
        listEl.appendChild(li);
      });
      stateEl.hidden = true;
      listEl.hidden = false;
    }).catch(function (err) {
      showState(stateEl,
        '<span class="state-h">Не удалось загрузить вклады</span>' +
        (err && err.message ? err.message : ''), true);
    });
  }

  $('hqRefresh').addEventListener('click', function () {
    haptic('light');
    loadHq();
  });

  /* ══════════════════════════════════════════════════════════════════
     ЛОГ СОБЫТИЙ (v6.3) — лента: 📡 рассылки Штаба, 👨‍💻 ответы Оператора,
     ⚙️ движение заявок по конвейеру, плюс мои сообщения Оператору.
     Счётчик непрочитанного живёт на конверте в шапке; открытие ленты
     отмечает всё прочитанным на сервере (отметка «до id включительно»).
     ══════════════════════════════════════════════════════════════════ */

  var logReplyTo = null;     // id сообщения, на которое отвечаем (null — простое письмо)
  var logSending = false;
  var logLastRead = 0;

  function fmtDT(iso) {
    var d = fmtDay(iso);
    var m = /T(\d{2}):(\d{2})/.exec(iso || '');
    return d + (m ? ' · ' + m[1] + ':' + m[2] : '');
  }

  function bellSet(n) {
    var b = $('bellN');
    if (n > 0) { b.textContent = n > 9 ? '9+' : String(n); b.hidden = false; }
    else b.hidden = true;
  }

  // Тихая проверка почты на старте: один GET, без повторов по таймеру —
  // лента обновляется при каждом заходе на экран, этого достаточно.
  function bellSync() {
    if (!authed()) return;
    api('/api/messages').then(function (d) {
      bellSet((d && d.unread) || 0);
    }).catch(function () { /* молча: конверт без цифры, не ошибка экрана */ });
  }

  $('btnBell').addEventListener('click', function () {
    haptic('light');
    location.hash = '#/log';
  });

  function enterLog() {
    var gate = $('logGate'), body = $('logBody');
    if (!authed()) { gate.hidden = false; body.hidden = true; return; }
    gate.hidden = true;
    body.hidden = false;
    loadLog();
  }

  function logSetReply(id) {
    logReplyTo = id;
    var note = $('logReplyNote');
    if (!id) { note.hidden = true; note.textContent = ''; return; }
    note.textContent = '';
    note.appendChild(document.createTextNode('↩ Ответ на сообщение Лаборатории. '));
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'mini';
    x.textContent = 'Отменить';
    x.addEventListener('click', function () { logSetReply(null); });
    note.appendChild(x);
    note.hidden = false;
  }

  function loadLog() {
    var stateEl = $('logState'), listEl = $('logList');
    listEl.hidden = true;
    showState(stateEl, 'Загружаю ленту…', false);
    api('/api/messages').then(function (d) {
      var items = (d && Array.isArray(d.items)) ? d.items : [];
      logLastRead = (d && d.last_read) || 0;
      listEl.textContent = '';
      if (!items.length) {
        showState(stateEl, '<span class="state-h">Пока тихо</span>' +
          'Здесь появятся новости Штаба и движение ваших заявок.', false);
      } else {
        items.forEach(function (m) {
          var li = document.createElement('li');
          li.className = 'msg' + (m.mine ? ' msg-mine' : '') +
            (!m.mine && m.id > logLastRead ? ' msg-new' : '');
          var meta = document.createElement('p');
          meta.className = 'msg-meta mono';
          meta.textContent = (m.mine ? '✉️ Вы — Оператору' : m.mark + ' [' + m.label + ']') +
            ' · ' + fmtDT(m.created_at);
          li.appendChild(meta);
          var p = document.createElement('p');
          p.className = 'msg-t';
          p.textContent = m.text || '';
          li.appendChild(p);
          if (!m.mine) {
            var rb = document.createElement('button');
            rb.type = 'button';
            rb.className = 'mini';
            rb.textContent = '↩ Ответить';
            rb.addEventListener('click', function () {
              haptic('light');
              logSetReply(m.id);
              $('logText').focus();
            });
            li.appendChild(rb);
          }
          listEl.appendChild(li);
        });
        stateEl.hidden = true;
        listEl.hidden = false;
        // прочитано «до последнего» — сервер не даст откатить отметку назад
        var maxId = items.reduce(function (a, m) { return Math.max(a, m.id || 0); }, 0);
        if (maxId > logLastRead) {
          api('/api/messages/read', { method: 'POST', body: { last_id: maxId } })
            .catch(function () { /* не критично: отметится при следующем открытии */ });
        }
        bellSet(0);
      }
    }).catch(function (err) {
      showState(stateEl, '<span class="state-h">Лента недоступна</span>' +
        (err && err.message ? err.message : ''), true);
    });
  }

  $('logForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (logSending) return;
    var text = $('logText').value.trim();
    var errEl = $('logErr');
    errEl.hidden = true;
    if (!text) { errEl.textContent = 'Пустое сообщение не отправить.'; errEl.hidden = false; return; }
    logSending = true;
    $('logSend').disabled = true;
    api('/api/messages', { method: 'POST', body: { text: text, reply_to: logReplyTo } })
      .then(function () {
        $('logText').value = '';
        logSetReply(null);
        haptic('success');
        showToast('Передано Оператору');
        loadLog();
      })
      .catch(function (err) {
        errEl.textContent = (err && err.message) || 'Не отправилось — попробуйте ещё раз.';
        errEl.hidden = false;
        haptic('error');
      })
      .then(function () { logSending = false; $('logSend').disabled = false; });
  });

  /* ══════════════════════════════════════════════════════════════════
     ДОСКИ ЛАБОРАТОРИИ (v6.3, вкладка «Обогащение»).
     «Разработка» — статический снапшот kanban.json рядом с приложением:
     он пересобирается при каждой публикации кода, токенов в проде нет.
     «Очередь Узлов» — живая, с сервера; чужие карточки анонимны by design.
     ══════════════════════════════════════════════════════════════════ */

  var boardsAt = 0;
  var BOARDS_TTL = 60 * 1000;
  var kbAdmin = false;       // сервер сказал is_admin в ответе /api/kanban
  var kbDevHidden = [];      // заголовки, скрытые оператором с доски разработки
  var kbNodesHidden = [];    // id заявок, скрытые с доски узлов

  function kbColumn(title, count) {
    var col = document.createElement('div');
    col.className = 'kb-col';
    var h = document.createElement('p');
    h.className = 'kb-col-h mono';
    h.textContent = title + ' · ' + count;
    col.appendChild(h);
    return col;
  }

  // ✖ на карточке (только оператор): скрыть с витрины через пульт сервера
  function kbHideBtn(board, key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini mini-danger kb-hide';
    b.textContent = '✖';
    b.title = 'Скрыть с витрины';
    b.addEventListener('click', function () {
      haptic('light');
      askConfirm('Скрыть карточку с витрины для всех?', function (ok) {
        if (!ok) return;
        api('/api/admin/kanban/hide', { method: 'POST', body: { board: board, key: key } })
          .then(function () { showToast('Скрыто'); boardsAt = 0; loadBoards(); })
          .catch(function (err) { showToast((err && err.message) || 'Не сохранилось'); });
      });
    });
    return b;
  }

  // блок ПОД доской (подпись снапшота, список скрытых): внутрь .kb нельзя —
  // это горизонтальный flex, любой ребёнок встаёт «колонкой»
  function kbBelow(boardEl, id) {
    var el = document.getElementById(id);
    if (el) { el.textContent = ''; return el; }
    el = document.createElement('div');
    el.id = id;
    boardEl.parentNode.insertBefore(el, boardEl.nextSibling);
    return el;
  }

  // список скрытых с кнопками «↩ вернуть» (только оператор)
  function kbHiddenList(board, keys, labelFn) {
    var wrap = document.createElement('div');
    wrap.className = 'kb-hidden';
    if (!keys.length) return wrap;
    var head = document.createElement('p');
    head.className = 'field-h';
    head.textContent = 'Скрыто оператором: ' + keys.length;
    wrap.appendChild(head);
    keys.forEach(function (k) {
      var row = document.createElement('p');
      row.className = 'kb-hidden-row';
      var t = document.createElement('span');
      t.textContent = labelFn(k);
      row.appendChild(t);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini';
      b.textContent = '↩ вернуть';
      b.addEventListener('click', function () {
        haptic('light');
        api('/api/admin/kanban/hide', { method: 'POST', body: { board: board, key: k, restore: true } })
          .then(function () { showToast('Возвращено'); boardsAt = 0; loadBoards(); })
          .catch(function (err) { showToast((err && err.message) || 'Не сохранилось'); });
      });
      row.appendChild(b);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderDevBoard(d) {
    var devState = $('kbDevState'), devEl = $('kbDev');
    var cols = (d && Array.isArray(d.columns)) ? d.columns : [];
    devEl.textContent = '';
    cols.forEach(function (c) {
      var cards = (Array.isArray(c.cards) ? c.cards : []).filter(function (card) {
        return kbDevHidden.indexOf(String(card.title || '')) < 0;
      });
      var col = kbColumn(c.title || '', cards.length);
      cards.forEach(function (card) {
        var el = document.createElement('div');
        el.className = 'kb-card';
        var t = document.createElement('span');
        t.textContent = String(card.title || '');
        el.appendChild(t);
        if (kbAdmin) el.appendChild(kbHideBtn('dev', String(card.title || '')));
        col.appendChild(el);
      });
      devEl.appendChild(col);
    });
    var below = kbBelow(devEl, 'kbDevBelow');
    if (d && d.updated) {
      var u = document.createElement('p');
      u.className = 'field-h';
      u.textContent = 'Снапшот от ' + fmtDate(d.updated) + ' — обновляется с каждой публикацией кода.';
      below.appendChild(u);
    }
    if (kbAdmin) {
      below.appendChild(kbHiddenList('dev', kbDevHidden, function (k) { return k; }));
    }
    devState.hidden = true;
    devEl.hidden = false;
  }

  function loadBoards() {
    var now = Date.now();
    if (now - boardsAt < BOARDS_TTL) return;
    boardsAt = now;

    var devState = $('kbDevState');
    var fetchDev = fetch('kanban.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('нет снапшота');
      return r.json();
    });

    // — Доска 2: Очередь Узлов (живая, персональная) —
    var labState = $('kbLabState'), labEl = $('kbLab');
    if (!authed()) {
      // вне Telegram живой доски нет; статика разработки — без операторского
      // фильтра (он доедет со следующей пересборкой снапшота)
      fetchDev.then(renderDevBoard).catch(function () {
        showState(devState, 'Снапшот доски ещё не выгружен — появится со следующей публикацией кода.', false);
      });
      showState(labState, 'Живой конвейер виден внутри Telegram: чтобы показать ВАШИ карточки с текстом, нужна подпись аккаунта.', false);
      labEl.hidden = true;
      return;
    }
    labState.hidden = true;
    api('/api/kanban').then(function (d) {
      kbAdmin = !!(d && d.is_admin);
      kbDevHidden = (d && d.dev_hidden) || [];
      kbNodesHidden = (d && d.nodes_hidden) || [];
      var cols = (d && Array.isArray(d.columns)) ? d.columns : [];
      labEl.textContent = '';
      cols.forEach(function (c) {
        var cards = Array.isArray(c.cards) ? c.cards : [];
        var col = kbColumn(c.title || '', cards.length);
        cards.forEach(function (card) {
          var el = document.createElement('div');
          el.className = 'kb-card' + (card.mine ? ' kb-mine' : '');
          var k = document.createElement('p');
          k.className = 'kb-kind mono';
          k.textContent = (card.id ? '№' + card.id + ' · ' : '') + String(card.kind || '');
          el.appendChild(k);
          if (card.mine && card.text) {
            var t = document.createElement('p');
            t.className = 'kb-text';
            t.textContent = card.text;
            el.appendChild(t);
          }
          var dt = document.createElement('p');
          dt.className = 'kb-date';
          dt.textContent = fmtDay(card.closed_at || card.created_at);
          el.appendChild(dt);
          if (card.post_url && /^https?:\/\//i.test(card.post_url)) {
            var a = document.createElement('a');
            a.className = 'cite';
            a.href = card.post_url;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'Открыть разбор';
            el.appendChild(a);
          }
          if (kbAdmin && card.id) el.appendChild(kbHideBtn('nodes', card.id));
          col.appendChild(el);
        });
        labEl.appendChild(col);
      });
      var labBelow = kbBelow(labEl, 'kbLabBelow');
      if (kbAdmin) {
        labBelow.appendChild(kbHiddenList('nodes', kbNodesHidden, function (k) { return 'Заявка №' + k; }));
      }
      labEl.hidden = false;
      $('kbRefresh').hidden = !kbAdmin;      // ⟳ — пульт оператора
      // статика рендерится ПОСЛЕ живой доски: фильтр dev_hidden уже известен
      fetchDev.then(renderDevBoard).catch(function () {
        showState(devState, 'Снапшот доски ещё не выгружен — появится со следующей публикацией кода.', false);
      });
    }).catch(function (err) {
      showState(labState, 'Конвейер сейчас недоступен: ' +
        (err && err.message ? err.message : ''), true);
      labEl.hidden = true;
      fetchDev.then(renderDevBoard).catch(function () {
        showState(devState, 'Снапшот доски ещё не выгружен — появится со следующей публикацией кода.', false);
      });
    });
  }

  $('kbRefresh').addEventListener('click', function () {
    haptic('light');
    boardsAt = 0;
    loadBoards();
  });

  /* ══════════════════════════════════════════════════════════════════
     КОНСОЛЬ ОПЕРАТОРА (v6.3, Штаб): сигналы связи + личный ответ + рассылка.
     ══════════════════════════════════════════════════════════════════ */

  var hqReplyBox = null;     // одна перемещаемая форма ответа (как contribPanel)

  function hqCloseReply() {
    if (hqReplyBox && hqReplyBox.parentNode) hqReplyBox.parentNode.removeChild(hqReplyBox);
  }

  function hqOpenReply(li, uid, author) {
    hqCloseReply();
    if (!hqReplyBox) {
      hqReplyBox = document.createElement('div');
      hqReplyBox.className = 'hq-reply';
      var ta = document.createElement('textarea');
      ta.className = 'field-t';
      ta.rows = 3;
      ta.maxLength = 3500;
      hqReplyBox.appendChild(ta);
      var send = document.createElement('button');
      send.type = 'button';
      send.className = 'btn btn-primary';
      send.textContent = 'Ответить лично';
      hqReplyBox.appendChild(send);
      hqReplyBox._ta = ta;
      hqReplyBox._send = send;
    }
    var box = hqReplyBox;
    box._ta.value = '';
    box._send.onclick = function () {
      var text = box._ta.value.trim();
      if (!text) return;
      box._send.disabled = true;
      api('/api/admin/messages/send', { method: 'POST', body: { uid: box._uid, text: text } })
        .then(function (d) {
          haptic('success');
          showToast(d && d.notified ? 'Доставлено в личку' : 'В Лог событий (личка закрыта)');
          hqCloseReply();
          loadHqMessages();
        })
        .catch(function (err) {
          haptic('error');
          showToast((err && err.message) || 'Не отправилось');
          box._send.disabled = false;
        });
    };
    box._uid = uid;
    box._ta.placeholder = 'Ответ для ' + (author || ('ID ' + uid)) + '…';
    box._send.disabled = false;
    li.appendChild(box);
    box._ta.focus();
  }

  function loadHqMessages() {
    var stateEl = $('hqMsgState'), listEl = $('hqMsgList');
    listEl.hidden = true;
    showState(stateEl, 'Загружаю переписку…', false);
    api('/api/admin/messages').then(function (d) {
      var items = (d && Array.isArray(d.items)) ? d.items : [];
      listEl.textContent = '';
      if (!items.length) {
        showState(stateEl, '<span class="state-h">Сигналов пока нет</span>' +
          'Входящие от участников появятся здесь.', false);
        return;
      }
      items.forEach(function (m) {
        var li = document.createElement('li');
        li.className = 'req';
        var meta = document.createElement('p');
        meta.className = 'req-m mono';
        var who = m.sender === 'user'
          ? ('✉️ ' + (m.author || ('ID ' + m.from_uid)))
          : (m.mark + ' → ID ' + m.to_uid);
        meta.textContent = '№' + m.id + ' · ' + who + ' · ' + fmtDT(m.created_at);
        li.appendChild(meta);
        var p = document.createElement('p');
        p.className = 'req-t hq-clip';
        p.textContent = m.text || '';
        p.addEventListener('click', function () { p.classList.toggle('open'); });
        li.appendChild(p);
        if (m.sender === 'user' && m.from_uid) {
          var rb = document.createElement('button');
          rb.type = 'button';
          rb.className = 'mini';
          rb.textContent = '↩ Ответить лично';
          rb.addEventListener('click', function () {
            haptic('light');
            hqOpenReply(li, m.from_uid, m.author);
          });
          li.appendChild(rb);
        }
        listEl.appendChild(li);
      });
      stateEl.hidden = true;
      listEl.hidden = false;
    }).catch(function (err) {
      showState(stateEl, '<span class="state-h">Переписка недоступна</span>' +
        (err && err.message ? err.message : ''), true);
    });
  }

  $('hqMsgRefresh').addEventListener('click', function () { haptic('light'); loadHqMessages(); });

  var hqCasting = false;
  $('hqCastForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (hqCasting) return;
    var text = $('hqCastText').value.trim();
    var errEl = $('hqCastErr');
    errEl.hidden = true;
    if (!text) { errEl.textContent = 'Пустую директиву не отправить.'; errEl.hidden = false; return; }
    var push = !!$('hqCastPush').checked;
    askConfirm('Отправить ВСЕМ участникам' + (push ? ' с пушем в лички' : ' (только Лог событий)') + '?',
      function (ok) {
        if (!ok) return;
        hqCasting = true;
        $('hqCastSend').disabled = true;
        api('/api/admin/broadcast', { method: 'POST', body: { text: text, sender: 'staff', push: push } })
          .then(function (d) {
            haptic('success');
            $('hqCastText').value = '';
            showToast('Рассылка ушла' + (push ? ': ' + (d.pushed_ok || 0) + ' в лички' : ''));
          })
          .catch(function (err) {
            errEl.textContent = (err && err.message) || 'Рассылка не отправилась.';
            errEl.hidden = false;
            haptic('error');
          })
          .then(function () { hqCasting = false; $('hqCastSend').disabled = false; });
      });
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

    if (t.closest('[data-open-bot]')) { haptic('medium'); openTelegram(BOT_URL); return; }

    // Обогащение: кнопка вектора раскрывает форму ПОД своей карточкой (повторное
    // нажатие — сворачивает). Открыт может быть только один вектор: сперва закрываем
    // прежний, иначе форма-одиночка осталась бы висеть в чужой карточке.
    var cbtn = t.closest('[data-contrib]');
    if (cbtn) {
      haptic('medium');
      var k = cbtn.getAttribute('data-contrib');
      var wasOpen = (contribKind === k);
      closeContrib();
      if (!wasOpen) openContrib(k, cbtn.closest('.enr-c'));
      return;
    }
    if (t.closest('[data-contrib-close]')) { haptic('light'); closeContrib(); return; }

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

    if (t.closest('[data-retry-feed]')) { loadFeed(current.rubric, current.tag); return; }
    if (t.closest('[data-retry-sri]')) { loadSri(); return; }
    if (t.closest('[data-retry-hq]')) { loadHqRequests(); return; }
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

  // «Штаб»: спрашиваем сервер, админ ли текущий пользователь (/api/me по подписи).
  // До ответа вкладка скрыта; не-админу она не появится вовсе.
  checkAdmin();

  // Почта (v6.3): один тихий запрос на старте — цифра на конверте в шапке.
  bellSync();
})();
