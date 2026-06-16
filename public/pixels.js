// ── Pet License Factory — Meta + TikTok Pixel Bootstrap ────────────────────
// Lazy-loads Meta Pixel and TikTok Pixel iff their IDs are configured via
// /api/pixels-config (driven by META_PIXEL_ID + TIKTOK_PIXEL_ID env vars).
//
// Tracks PageView automatically. Exposes `window.PLFPixels.purchase(value)`
// so success.html can fire a Purchase / CompletePayment event.
//
// Pixels and the affiliate system are independent: pixels measure ad
// performance, the affiliate layer credits creators. Both can run together.
// ---------------------------------------------------------------------------

(function () {
  if (window.PLFPixels) return;
  window.PLFPixels = { ready: false, queue: [] };

  // Public API: queues events until the pixels are loaded.
  window.PLFPixels.purchase = function (valueUsd, currency) {
    var v = Number(valueUsd) || 0;
    var c = currency || 'USD';
    enqueue(function () {
      if (window.fbq) window.fbq('track', 'Purchase', { value: v, currency: c });
      if (window.ttq) window.ttq.track('CompletePayment', { value: v, currency: c });
    });
  };

  function enqueue(fn) {
    if (window.PLFPixels.ready) fn();
    else window.PLFPixels.queue.push(fn);
  }

  // ── Fetch IDs and init ──
  fetch('/api/pixels-config').then(function (r) { return r.json(); }).then(function (cfg) {
    var anyLoaded = false;
    if (cfg && cfg.meta)   { initMeta(cfg.meta);   anyLoaded = true; }
    if (cfg && cfg.tiktok) { initTikTok(cfg.tiktok); anyLoaded = true; }
    window.PLFPixels.ready = true;
    while (window.PLFPixels.queue.length) (window.PLFPixels.queue.shift())();
    if (!anyLoaded) {
      // No IDs configured — silently no-op. Useful so we can ship the
      // include without the IDs and add them later via env vars.
    }
  }).catch(function () { /* network error — pixels just don't fire */ });

  // ── Meta Pixel ──
  function initMeta(id) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', id);
    window.fbq('track', 'PageView');
  }

  // ── TikTok Pixel ──
  function initTikTok(id) {
    !function (w, d, t) {
      w.TiktokAnalyticsObject = t;
      var ttq = w[t] = w[t] || [];
      ttq.methods = ['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie','holdConsent','revokeConsent','grantConsent'];
      ttq.setAndDefer = function (e, m) { e[m] = function () { e.push([m].concat(Array.prototype.slice.call(arguments,0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (e) { var n = ttq._i[e] || []; for (var r = 0; r < ttq.methods.length; r++) ttq.setAndDefer(n, ttq.methods[r]); return n; };
      ttq.load = function (e, n) {
        var r = 'https://analytics.tiktok.com/i18n/pixel/events.js';
        var o = n && n.partner;
        ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r;
        ttq._t = ttq._t || {}; ttq._t[e] = +new Date;
        ttq._o = ttq._o || {}; ttq._o[e] = n || {};
        n = document.createElement('script'); n.type = 'text/javascript'; n.async = !0;
        n.src = r + '?sdkid=' + e + '&lib=' + t;
        var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(n, s);
      };
      ttq.load(id);
      ttq.page();
    }(window, document, 'ttq');
  }
})();
