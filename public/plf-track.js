// ── Pet Licence Factory — First-Party Click + Funnel Tracking ──────────────
// Self-contained IIFE. Loaded on every customer-facing page. Sends small,
// PII-free events to /api/track so we can answer "where do visitors drop off?"
// from our own data instead of TikTok's dashboard.
//
//   - visitor_id : persistent localStorage UUID
//   - session_id : localStorage UUID with a rolling inactivity window, so the
//                  identity survives the Stripe redirect round-trip and the
//                  purchase_success event on success.html carries the campaign
//   - page_view  : on load (with UTM / ttclid attribution captured from URL)
//   - click      : delegated capture-phase listener on every actionable element
//   - step       : explicit funnel instrumentation via PLFTrack.step()
//
// PII rule: labels come ONLY from data-track / id / trimmed innerText — never
// from input/textarea/select values, names, emails, addresses, or photos.
// Fire-and-forget: never blocks, never throws into the page.
// ---------------------------------------------------------------------------
(function () {
  if (window.PLFTrack) return;

  var ENDPOINT = '/api/track';
  var LABEL_MAX = 60;

  // ── IDs ──────────────────────────────────────────────────────────────
  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Persistent visitor id (localStorage). Survives across all visits.
  function persistentId(key) {
    try {
      var id = localStorage.getItem(key);
      if (!id) { id = uuid(); localStorage.setItem(key, id); }
      return id;
    } catch (e) { return uuid(); }   // private mode / disabled storage
  }

  // ── Session id with a rolling inactivity window ───────────────────────
  // Persisted in localStorage (NOT sessionStorage) so the session survives
  // the round-trip to checkout.stripe.com and back to success.html — that
  // navigation used to mint a fresh, untagged session, orphaning every
  // purchase_success event from its originating campaign. A gap of more than
  // SESSION_WINDOW_MS between events starts a genuinely-new session
  // (GA-style), so ordinary return visits still get fresh ids + attribution.
  var SESSION_WINDOW_MS = 30 * 60 * 1000;   // 30 min of inactivity
  var SID_KEY = 'plf_sid', SID_TS_KEY = 'plf_sid_ts';
  var isNewSession = false;

  function loadSession() {
    var now = Date.now(), sid, last;
    try {
      sid = localStorage.getItem(SID_KEY);
      last = parseInt(localStorage.getItem(SID_TS_KEY) || '0', 10);
    } catch (e) { sid = null; last = 0; }
    if (!sid || !last || (now - last) > SESSION_WINDOW_MS) {
      sid = uuid();
      isNewSession = true;
    }
    touchSession(sid, now);
    return sid;
  }

  // Refresh the session's last-activity stamp so an active session never
  // expires mid-flow (e.g. while the buyer sits on Stripe's hosted checkout).
  function touchSession(sid, now) {
    try {
      localStorage.setItem(SID_KEY, sid);
      localStorage.setItem(SID_TS_KEY, String(now || Date.now()));
    } catch (e) {}
  }

  var visitorId = persistentId('plf_vid');
  var sessionId = loadSession();

  // ── Attribution: capture UTM + ttclid once, persist for the session ──
  // Stored in localStorage (keyed to the session's lifetime) so it survives
  // the Stripe redirect and rides along on the purchase_success event fired
  // from success.html. Mirrored to sessionStorage because the free-digital
  // lead form on index.html reads plf_attr from there directly. A genuinely-
  // new session starts clean so stale campaigns don't leak into a later visit.
  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'ttclid'];
  var attribution = {};
  (function captureAttribution() {
    var stored = {};
    if (!isNewSession) {
      try { stored = JSON.parse(localStorage.getItem('plf_attr') || '{}') || {}; } catch (e) {}
    }
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
    ATTR_KEYS.forEach(function (k) {
      var fromUrl = params && params.get(k);
      if (fromUrl) stored[k] = ('' + fromUrl).slice(0, 120);
    });
    attribution = stored;
    var json = JSON.stringify(stored);
    try { localStorage.setItem('plf_attr', json); } catch (e) {}
    try { sessionStorage.setItem('plf_attr', json); } catch (e) {}
  })();

  // ── Transport: sendBeacon, fallback to fetch keepalive. Never throws. ──
  function send(evt) {
    try {
      touchSession(sessionId);   // keep the session alive on every event
      var payload = {
        v: visitorId,
        s: sessionId,
        page: (location.pathname || '/'),
        type: evt.type,
        label: evt.label || null,
        step: evt.step || null,
        meta: buildMeta(evt.meta)
      };
      var body = JSON.stringify(payload);
      // Body must stay small (server rejects >2KB).
      if (body.length > 1800) {
        payload.meta = attributionMeta();      // drop the extras, keep attribution
        body = JSON.stringify(payload);
      }
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'text/plain' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
      // Fallback
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: body,
        keepalive: true,
        credentials: 'omit'
      }).catch(function () {});
    } catch (e) { /* never let tracking break the page */ }
  }

  function attributionMeta() {
    var m = {};
    ATTR_KEYS.forEach(function (k) { if (attribution[k]) m[k] = attribution[k]; });
    return m;
  }

  // Merge caller meta with attribution (attribution always attached).
  function buildMeta(extra) {
    var m = attributionMeta();
    if (extra && typeof extra === 'object') {
      for (var k in extra) {
        if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
        var v = extra[k];
        var t = typeof v;
        if (t === 'string') m[k] = v.slice(0, 200);
        else if ((t === 'number' && isFinite(v)) || t === 'boolean') m[k] = v;
      }
    }
    return m;
  }

  // ── Label extraction (PII-free) ──────────────────────────────────────
  function cleanText(s) {
    if (!s) return '';
    return ('' + s).replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  }

  function labelFor(el) {
    // Priority: explicit data-track, then id, then trimmed visible text.
    // NEVER read form field values (input/textarea/select) — that's PII.
    var dt = el.getAttribute && el.getAttribute('data-track');
    if (dt) return cleanText(dt);
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return cleanText(aria);
    if (el.id) return cleanText('#' + el.id);
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      // Use type/name only — never the value.
      var typ = el.getAttribute('type') || tag;
      return cleanText(tag + '[' + typ + ']');
    }
    var txt = cleanText(el.textContent);
    if (txt) return txt;
    var title = el.getAttribute && el.getAttribute('title');
    if (title) return cleanText(title);
    return cleanText('<' + tag + '>');
  }

  // Is this element (or an ancestor) something we track clicks on?
  function trackableAncestor(node) {
    var el = node;
    var depth = 0;
    while (el && el.nodeType === 1 && depth < 6) {
      var tag = (el.tagName || '').toLowerCase();
      if (
        tag === 'a' || tag === 'button' ||
        (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'submit') ||
        (tag === 'label' && el.getAttribute('for')) ||
        el.getAttribute('role') === 'button' ||
        el.hasAttribute('data-track')
      ) return el;
      el = el.parentElement;
      depth++;
    }
    return null;
  }

  // ── Delegated click listener (capture phase, every actionable element) ──
  document.addEventListener('click', function (e) {
    try {
      var el = trackableAncestor(e.target);
      if (!el) return;
      var tag = (el.tagName || '').toLowerCase();
      var meta = { tag: tag };
      if (tag === 'a') {
        var href = el.getAttribute('href');
        if (href) meta.href = ('' + href).slice(0, 200);
      }
      send({ type: 'click', label: labelFor(el), meta: meta });
    } catch (err) { /* ignore */ }
  }, true);

  // ── Public API ───────────────────────────────────────────────────────
  window.PLFTrack = {
    visitorId: visitorId,
    sessionId: sessionId,
    // Explicit funnel step, e.g. PLFTrack.step('step_1_photo').
    step: function (stepName, meta) {
      send({ type: 'step', label: cleanText(stepName), step: cleanText(stepName), meta: meta });
    },
    // Arbitrary explicit event, e.g. PLFTrack.event('order_submitted', orderId).
    event: function (type, label, meta) {
      send({ type: (type || 'other'), label: cleanText(label), meta: meta });
    }
  };

  // ── page_view on load (with attribution) ──
  send({ type: 'page_view', label: cleanText(document.title || location.pathname) });
})();
