// ── Goofy Licenses — G.O.A.T. license card renderer ─────────────────────────
// Re-renders an order's printable G.O.A.T. license card (1010×638, ~300dpi at
// CR80 size) from the stored order: the same template art, photo box, script
// names and QR corner the builder (public/goofy/index.html) composes, so a
// re-print from Command Station matches what the customer saw.
//
//   GoofyCard.render({ variant, recipientName, giverName, photo, crop, orderId })
//     → Promise<HTMLCanvasElement>
//
// - Geometry is copied from the builder's measured constants (keep in sync).
// - photo: the stored data URL; crop: { cx, cy, zoom } the customer set in the
//   builder (defaults to a centered cover crop for orders placed before the
//   crop was saved).
// - The QR is always the per-order licence QR (GOOFY_QR.licenceUrl(orderId))
//   drawn module by module so it prints crisp; needs /goofy/qr-config.js and
//   qrcode-generator loaded first.
(function (root) {
  'use strict';
  var TW = 1010, TH = 638;
  var PHOTO_BOX = { x: 41, y: 90, w: 303, h: 407 };
  var QR_BOX = { x: 851, y: 33, w: 126, h: 127 };
  var FIELDS = {
    recipient: { x: 30,  y: 488, w: 336, h: 82 },
    giver:     { x: 372, y: 488, w: 260, h: 82 }
  };
  var TPL = {
    'standard':     '/goofy/images/product-standard.png',
    'custom-giver': '/goofy/images/bg-custom-giver.png',
    'custom-anon':  '/goofy/images/bg-custom-anon.png'
  };

  function loadImg(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('Could not load ' + String(src).slice(0, 60))); };
      im.src = src;
    });
  }

  // The names are Pinyon Script. document.fonts.load() resolves immediately
  // (with nothing) if the @font-face isn't known yet, so wait for the Google
  // Fonts stylesheet itself before asking for the face.
  var fontReady = null;
  function ensureScriptFont() {
    if (!fontReady) {
      fontReady = new Promise(function (resolve) {
        var link = Array.prototype.find.call(document.querySelectorAll('link[rel=stylesheet]'), function (l) {
          return /Pinyon\+Script/.test(l.href);
        });
        var loadFace = function () {
          if (!document.fonts || !document.fonts.load) return resolve();
          document.fonts.load('68px "Pinyon Script"').then(resolve, resolve);
        };
        if (link && link.sheet) return loadFace();
        if (!link) {
          link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = 'https://fonts.googleapis.com/css2?family=Pinyon+Script&display=block';
          document.head.appendChild(link);
        }
        link.addEventListener('load', loadFace);
        link.addEventListener('error', function () { resolve(); });
        setTimeout(loadFace, 4000);   // never hang a re-print on a slow font
      });
    }
    return fontReady;
  }

  function fitScript(x, txt, maxW, start) {
    var s = start;
    while (s > 10) {
      x.font = s + 'px "Pinyon Script",cursive';
      if (x.measureText(txt).width <= maxW) break;
      s -= 2;
    }
    return s;
  }

  function drawName(x, field, name) {
    var t = String(name || '').trim().slice(0, 30);
    if (!t) return;
    x.fillStyle = '#202030';
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    x.font = fitScript(x, t, field.w, 68) + 'px "Pinyon Script",cursive';
    x.fillText(t, field.x + field.w / 2, field.y + field.h - 6);
  }

  function drawQr(x, orderId) {
    var Q = root.GOOFY_QR || {};
    if (typeof root.qrcode !== 'function' || !Q.licenceUrl) return;
    var qr = root.qrcode(0, 'M');
    qr.addData(Q.licenceUrl(orderId));
    qr.make();
    var n = qr.getModuleCount(), m = 1, cell = QR_BOX.w / (n + 2 * m);
    x.fillStyle = '#ffffff';
    x.fillRect(QR_BOX.x, QR_BOX.y, QR_BOX.w, QR_BOX.h);
    x.fillStyle = '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        var x0 = Math.round(QR_BOX.x + (c + m) * cell), x1 = Math.round(QR_BOX.x + (c + m + 1) * cell);
        var y0 = Math.round(QR_BOX.y + (r + m) * cell), y1 = Math.round(QR_BOX.y + (r + m + 1) * cell);
        x.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }

  function parseCrop(crop) {
    var c = crop;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
    c = c || {};
    return {
      cx: isFinite(c.cx) ? +c.cx : 0.5,
      cy: isFinite(c.cy) ? +c.cy : 0.5,
      zoom: isFinite(c.zoom) && c.zoom > 0 ? +c.zoom : 1
    };
  }

  async function render(o) {
    o = o || {};
    var variant = TPL[o.variant] ? o.variant : 'standard';
    var custom = variant !== 'standard';
    await ensureScriptFont();
    var c = document.createElement('canvas');
    c.width = TW; c.height = TH;
    var x = c.getContext('2d');
    x.drawImage(await loadImg(TPL[variant]), 0, 0, TW, TH);
    if (custom && o.photo) {
      var p = await loadImg(o.photo);
      var cr = parseCrop(o.crop), B = PHOTO_BOX;
      var eff = Math.max(B.w / p.width, B.h / p.height) * cr.zoom;
      var dw = p.width * eff, dh = p.height * eff;
      x.save();
      x.beginPath(); x.rect(B.x, B.y, B.w, B.h); x.clip();
      x.drawImage(p, B.x + B.w / 2 - cr.cx * dw, B.y + B.h / 2 - cr.cy * dh, dw, dh);
      x.restore();
    }
    if (custom) {
      drawName(x, FIELDS.recipient, o.recipientName || 'Their Name');
      if (variant === 'custom-giver') drawName(x, FIELDS.giver, o.giverName);
    }
    drawQr(x, o.orderId);
    return c;
  }

  root.GoofyCard = { render: render, width: TW, height: TH };
})(typeof window !== 'undefined' ? window : this);
