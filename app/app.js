/* ============================================================
   Читальня КАВАЧАМ — TMA-каркас (Фаза 0).
   Ваниль, без сборки, без внешних зависимостей.

   Инварианты:
   - Работает БЕЗ Telegram: в обычном браузере это обычная веб-страница
     (лента и чтение работают; MainButton/BackButton/Haptic просто отсутствуют).
   - Никакого auth: user.id с клиента не используется вообще (Ф0).
   - Читает только data/feed.json и data/reading/<slug>.json (зона генератора).
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
  // База, относительно которой раскрываются относительные пути ленты (pages_url)
  // в АБСОЛЮТНЫЕ — для шаринга. location.href тут не годится: с localhost
  // поделиться нечем.
  var APP_BASE = LANDING + 'app/';

  // Прямая ссылка-приложение t.me/kavacham_lab_bot/reader ЕЩЁ НЕ ЖИВАЯ:
  // short_name «reader» регистрируется в BotFather (/newapp) — это шаг человека
  // после деплоя (§8, §12/Р6 ТЗ: «фабриковать „живую“ ссылку до деплоя не будем»).
  // Пока её нет — делимся тем, что ТОЧНО открывается у получателя: статической
  // страницей разбора на Pages (она же — путь при блокировке TMA, §3).
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
      else tg.HapticFeedback.impactOccurred(kind || 'light');
    } catch (e) { /* тактильная отдача — украшение, не функция */ }
  }

  function openExternal(url) {
    if (inTelegram && typeof tg.openLink === 'function') tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  function openTelegram(url) {
    if (inTelegram && typeof tg.openTelegramLink === 'function') tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  // slug из хэша не доверяем: только [a-z0-9-], иначе не строим путь к JSON
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
  var SCREENS = {
    reader:  { el: 'screen-reader',  tab: 'reader',  back: false },
    reading: { el: 'screen-reading', tab: 'reader',  back: true  },
    submit:  { el: 'screen-submit',  tab: 'submit',  back: false },
    profile: { el: 'screen-profile', tab: 'profile', back: false },
    about:   { el: 'screen-about',   tab: 'about',   back: false }
  };

  var current = { name: 'reader', slug: null };

  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('/').filter(Boolean);
    if (!parts.length) return { name: 'reader', slug: null };
    if (parts[0] === 'reading' && parts[1]) return { name: 'reading', slug: parts[1] };
    if (SCREENS[parts[0]] && parts[0] !== 'reading') return { name: parts[0], slug: null };
    return { name: 'reader', slug: null };
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
      tg.MainButton.show();
      document.body.classList.add('tma-has-mainbutton');
    } catch (e) { /* старый клиент — экранных кнопок достаточно */ }
  }
  var mainHandler = null;

  function route() {
    var r = parseHash();
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

    if (r.name === 'reading') loadReading(r.slug);
    if (r.name === 'submit' || r.name === 'profile') {
      setMainButton('Открыть бота', function () { haptic('medium'); openTelegram(BOT_URL); });
    }
    if (r.name === 'reader') loadFeed();

    window.scrollTo(0, 0);
    $('main').focus({ preventScroll: true });
  }

  function goBack() {
    if (current.name === 'reading') location.hash = '#/reader';
    else if (history.length > 1) history.back();
    else location.hash = '#/reader';
  }

  $('btnBack').addEventListener('click', function () { haptic('light'); goBack(); });

  // ——— Лента ————————————————————————————————————————————————
  // Лента — единственный источник правды по адресам разбора: в feed.json есть
  // контрактные поля reading_url (JSON для читальни) и pages_url (статическая
  // страница Pages). Склеивать пути из слага руками нельзя: сменит генератор
  // раскладку — читальня начнёт молча 404-ить, хотя правильный адрес лежит в ленте.
  var feedPromise = null;                 // fetch ленты — один на всё приложение
  var feedIndex = Object.create(null);    // slug → элемент ленты (без прототипа!)
  var feedLoaded = false;                 // лента УЖЕ отрисована на экране
  var feedOk = false;                     // лента прочитана (значит, её индексу можно верить)

  function fetchFeed() {
    if (!feedPromise) {
      feedPromise = fetch('data/feed.json', { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          var items = (data && Array.isArray(data.items)) ? data.items : [];
          items.forEach(function (it) {
            if (it && typeof it.slug === 'string' && it.slug) feedIndex[it.slug] = it;
          });
          feedOk = true;
          return items;
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

  function loadFeed() {
    if (feedLoaded) return;
    var stateEl = $('feedState'), listEl = $('feedList');

    fetchFeed()
      .then(function (items) {
        if (!items.length) {
          showState(stateEl,
            '<span class="state-h">Лента пока пуста</span>' +
            'Первые разборы появятся здесь сразу после публикации. Пока их можно читать в канале Лаборатории.', false);
          listEl.hidden = true;
          return;
        }
        renderFeed(items);
        stateEl.hidden = true;
        listEl.hidden = false;
        feedLoaded = true;
      })
      .catch(function (err) {
        // упавший промис нельзя кэшировать: иначе «Повторить» переиспользует ту же
        // ошибку и повтора не произойдёт вовсе
        feedPromise = null;
        // честное сообщение, а не тишина
        showState(stateEl,
          '<span class="state-h">Не удалось загрузить ленту</span>' +
          'Похоже, нет связи. Разборы всегда доступны в боте и на сайте — это и есть запасной путь.' +
          '<br><button class="btn btn-ghost" type="button" data-retry-feed>Повторить</button>', true);
        listEl.hidden = true;
        if (window.console) console.warn('[kavacham] feed:', err && err.message);
      });
  }

  function renderFeed(items) {
    var listEl = $('feedList');
    listEl.textContent = '';

    items.forEach(function (it) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'feed-card';
      a.href = '#/reading/' + encodeURIComponent(it.slug || '');

      var top = document.createElement('div');
      top.className = 'feed-top';
      var kind = document.createElement('span');
      kind.className = 'kind k-' + (it.kind || 'razbor');
      kind.textContent = KIND_LABEL[it.kind] || 'Разбор';
      top.appendChild(kind);
      a.appendChild(top);

      var h = document.createElement('h2');
      h.textContent = it.title || 'Без заголовка';
      a.appendChild(h);

      if (it.subtitle) {
        var sub = document.createElement('p');
        sub.className = 'feed-sub';
        sub.textContent = it.subtitle;
        a.appendChild(sub);
      }
      if (it.excerpt) {
        var ex = document.createElement('p');
        ex.className = 'feed-ex';
        ex.textContent = it.excerpt;
        a.appendChild(ex);
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
        it.tags.slice(0, 4).forEach(function (t) {
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

  // ——— Разбор ——————————————————————————————————————————————
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
        '<br><a class="btn btn-ghost" href="#/reader">В читальню</a>', true);
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
              '<br><a class="btn btn-ghost" href="#/reader">В читальню</a>'), true);
        if (window.console) console.warn('[kavacham] reading:', err && err.message);
      });
  }

  function renderReading(data) {
    var stateEl = $('readingState'), rootEl = $('readingRoot');
    var slug = data.slug || current.slug;
    var meta = data.meta || {};

    $('readingKind').textContent = KIND_LABEL[meta.kind] || 'Разбор';
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
    var shareText = (data.title || 'Разбор КАВАЧАМ') + ' — читальня КАВАЧАМ';

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
    // Правило зеркала (§3): фича выпускается на обоих фронтах или не выпускается.
    // Появится разбор payload в боте — вернуть сюда '?start=fix_' + slug.
    // Контекст разбора человек называет сам — об этом прямо просит текст под кнопками.
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
            behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
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
    var botBtn = e.target.closest && e.target.closest('[data-open-bot]');
    if (botBtn) { haptic('medium'); openTelegram(BOT_URL); return; }

    var retry = e.target.closest && e.target.closest('[data-retry-feed]');
    if (retry) { feedLoaded = false; loadFeed(); return; }

    // ссылки на Telegram и лендинг — через нативные открывалки клиента
    var link = e.target.closest && e.target.closest('a[href^="http"]');
    if (link && inTelegram && !link.closest('.reading-body')) {
      e.preventDefault();
      var href = link.href;
      haptic('light');
      if (/^https?:\/\/(t\.me|telegram\.me)\//i.test(href)) openTelegram(href);
      else openExternal(href);
    }
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (a) {
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
