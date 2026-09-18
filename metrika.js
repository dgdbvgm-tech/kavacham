/* Яндекс Метрика и строка о cookie — один файл на весь сайт.
   Номер счетчика живет здесь и больше нигде: страницы подключают файл
   строкой <script src="/metrika.js" defer>. Политика данных — privacy.html.
   Считаем только боевой адрес: локальная сборка и старый адрес на Pages
   в статистику не попадают. */
(function () {
  var ID = 112797338; // номер счетчика «KAVACHAM — kavacham.bagnin.com»
  var HOST = 'kavacham.bagnin.com';
  if (!ID || location.hostname !== HOST) return;

  (function (m, e, t, r, i, k, a) {
    m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    for (var j = 0; j < document.scripts.length; j++) { if (document.scripts[j].src === r) { return; } }
    k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=' + ID, 'ym');
  ym(ID, 'init', { ssr: true, webvisor: true, clickmap: true, referrer: document.referrer, url: location.href, accurateTrackBounce: true, trackLinks: true });

  var KEY = 'kv.cookie.ok';
  try { if (localStorage.getItem(KEY)) return; } catch (e) { /* без хранилища полоса покажется снова — не беда */ }
  var bar = document.createElement('div');
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Про cookie');
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9999;'
    + 'max-width:560px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;'
    + 'background:#131A44;color:#ECE6D4;border:1px solid rgba(201,162,75,.35);border-radius:12px;'
    + 'box-shadow:0 6px 24px rgba(0,0,0,.35);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  bar.innerHTML = '<p style="margin:0;flex:1">Сайт считает посещения Яндекс Метрикой и сохраняет cookie. '
    + '<a href="/privacy.html" style="color:#E7CE8C">Подробнее</a></p>'
    + '<button type="button" style="flex:none;background:#0C1030;color:#ECE6D4;border:1px solid rgba(201,162,75,.45);'
    + 'border-radius:10px;padding:8px 12px;font:600 14px system-ui,sans-serif;cursor:pointer">Понятно</button>';
  bar.querySelector('button').addEventListener('click', function () {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* приватный режим — ок */ }
    bar.remove();
  });
  document.body.appendChild(bar);
})();
