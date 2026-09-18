// ── Goofy Licenses — G.O.A.T. license card: geometry + renderer ─────────────
// The ONE place that knows where things go on the 1010×638 G.O.A.T. card
// (~300dpi at CR80 size). Everything that draws the card uses it:
//   - the builder (public/goofy/index.html): live-preview overlay positions
//     and the checkout snapshot shown on the success page,
//   - Command Station: the print re-render of an order,
// so the preview, the snapshot and the printed card can't drift apart.
//
//   GoofyCard.render({ variant, recipientName, giverName, photo, crop, orderId })
//     → Promise<HTMLCanvasElement>
//   GoofyCard.geometry                         boxes in card pixels (below)
//   GoofyCard.nameLayout(text, 'recipient'|'giver') → { text, size, x, base }
//   GoofyCard.qrCanvas(orderId, px)            just the QR, for previews
//
// - photo: data URL; crop: { cx, cy, zoom } the customer set in the builder
//   (a centered cover crop when missing, e.g. orders placed before it was
//   saved).
// - QR: GOOFY_QR.licenceUrl(orderId), drawn module by module so it prints
//   crisp. With an orderId it's that order's own short URL (every card gets
//   its own QR). Without one, custom cards show the generic licence URL (the
//   builder preview) and the standard card keeps its printed QR. Needs
//   /goofy/qr-config.js and qrcode-generator loaded before render() runs.
(function (root) {
  'use strict';
  var TW = 1010, TH = 638;

  // Measured on the templates (bg-custom-*.png, product-standard.png).
  // Photo: the frame's grey rule runs x31-352, y90-497 with ~10px corners;
  // the photo covers it with 1px to spare so no rule peeks out.
  var PHOTO_BOX = { x: 30, y: 89, w: 324, h: 410, r: 12 };
  // QR: the printed QR on product-standard.png spans x851-977, y33-160. The
  // box covers all of it, since the standard card's QR is redrawn per order.
  // No quiet zone inside the box: the white card around it is the quiet zone,
  // which keeps the modules as big as possible.
  var QR_BOX = { x: 851, y: 33, w: 128, h: 128 };
  // Names sit on the signature rules (y569; recipient x35-356, giver
  // x383-617): centered by ink on a fixed baseline, 52px, shrinking to fit
  // the rule. At 52px Pinyon Script's tallest glyph stays below FOREVER
  // (ends y511) and its deepest descender above the labels under the rules
  // (start y582).
  var FIELDS = {
    recipient: { x: 35,  w: 321, base: 557, max: 52 },
    giver:     { x: 383, w: 234, base: 557, max: 52 }
  };
  var TPL = {
    'standard':     '/goofy/images/product-standard.png',
    'custom-giver': '/goofy/images/bg-custom-giver.png',
    'custom-anon':  '/goofy/images/bg-custom-anon.png'
  };
  var SCRIPT = '"Pinyon Script",cursive';
  var INK = '#202030';

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
          document.fonts.load('52px "Pinyon Script"').then(resolve, resolve);
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

  // Size + position of a name, in card pixels. Fits the ink (swashes
  // included) inside the rule and centers the ink, not the advance box, so a
  // big leading capital doesn't push the name off-center. The builder uses
  // the same numbers to place its DOM preview, so both match.
  var mctx = null;
  function nameLayout(text, key) {
    var f = FIELDS[key] || FIELDS.recipient;
    var t = String(text == null ? '' : text).trim().slice(0, 30);
    if (!mctx) { mctx = document.createElement('canvas').getContext('2d'); mctx.textAlign = 'left'; }
    var s = f.max, m, L, R;
    for (;;) {
      mctx.font = s + 'px ' + SCRIPT;
      m = mctx.measureText(t);
      L = m.actualBoundingBoxLeft || 0;
      R = m.actualBoundingBoxRight || m.width;
      if (L + R <= f.w || s <= 14) break;
      s -= 1;
    }
    return { text: t, size: s, x: f.x + f.w / 2 - (R - L) / 2, base: f.base };
  }

  function drawName(x, text, key) {
    var lay = nameLayout(text, key);
    if (!lay.text) return;
    x.fillStyle = INK;
    x.textAlign = 'left';
    x.textBaseline = 'alphabetic';
    x.font = lay.size + 'px ' + SCRIPT;
    x.fillText(lay.text, lay.x, lay.base);
  }

  function parseCrop(crop) {
    var c = crop;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
    c = c || {};
    return {
      cx: isFinite(c.cx) ? +c.cx : 0.5,
      cy: isFinite(c.cy) ? +c.cy : 0.5,
      zoom: isFinite(c.zoom) && c.zoom > 0 ? Math.max(1, +c.zoom) : 1
    };
  }

  function roundRect(x, b) {
    var r = Math.min(b.r || 0, b.w / 2, b.h / 2);
    x.beginPath();
    x.moveTo(b.x + r, b.y);
    x.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r);
    x.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r);
    x.arcTo(b.x, b.y + b.h, b.x, b.y, r);
    x.arcTo(b.x, b.y, b.x + b.w, b.y, r);
    x.closePath();
  }

  // Cover-fit the photo in the rounded photo window at the customer's crop.
  // The centre is clamped the same way the builder clamps it, so no crop can
  // ever leave an empty edge.
  function drawPhoto(x, img, crop) {
    var B = PHOTO_BOX, cr = parseCrop(crop);
    var eff = Math.max(B.w / img.width, B.h / img.height) * cr.zoom;
    var dw = img.width * eff, dh = img.height * eff;
    var mx = B.w / (2 * dw), my = B.h / (2 * dh);
    var cx = mx > 1 - mx ? 0.5 : Math.min(1 - mx, Math.max(mx, cr.cx));
    var cy = my > 1 - my ? 0.5 : Math.min(1 - my, Math.max(my, cr.cy));
    x.save();
    roundRect(x, B);
    x.clip();
    x.drawImage(img, B.x + B.w / 2 - cx * dw, B.y + B.h / 2 - cy * dh, dw, dh);
    x.restore();
  }

  function qrFor(orderId) {
    var Q = root.GOOFY_QR;
    if (typeof root.qrcode !== 'function' || !Q || !Q.licenceUrl) return null;
    var url = Q.licenceUrl(orderId);
    var qr = root.qrcode(0, 'M');
    qr.addData(url, Q.qrMode ? Q.qrMode(url) : 'Byte');
    qr.make();
    return qr;
  }

  function drawQr(x, qr, bx, by, size) {
    var n = qr.getModuleCount(), cell = size / n;
    x.fillStyle = '#ffffff';
    x.fillRect(bx, by, size, size);
    x.fillStyle = '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        var x0 = Math.round(bx + c * cell), x1 = Math.round(bx + (c + 1) * cell);
        var y0 = Math.round(by + r * cell), y1 = Math.round(by + (r + 1) * cell);
        x.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }

  function qrCanvas(orderId, px) {
    var qr = qrFor(orderId);
    if (!qr) return null;
    var c = document.createElement('canvas');
    c.width = c.height = px || 256;
    drawQr(c.getContext('2d'), qr, 0, 0, c.width);
    return c;
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
    if (custom && o.photo) drawPhoto(x, await loadImg(o.photo), o.crop);
    if (custom) {
      drawName(x, o.recipientName || 'Their Name', 'recipient');
      if (variant === 'custom-giver' && o.giverName) drawName(x, o.giverName, 'giver');
    }
    if (custom || o.orderId) {
      var qr = qrFor(o.orderId);
      if (qr) drawQr(x, qr, QR_BOX.x, QR_BOX.y, QR_BOX.w);
    }
    return c;
  }

  root.GoofyCard = {
    render: render,
    nameLayout: nameLayout,
    qrCanvas: qrCanvas,
    ensureFont: ensureScriptFont,
    width: TW, height: TH,
    geometry: { TW: TW, TH: TH, PHOTO_BOX: PHOTO_BOX, QR_BOX: QR_BOX, FIELDS: FIELDS, TPL: TPL }
  };
})(typeof window !== 'undefined' ? window : this);
