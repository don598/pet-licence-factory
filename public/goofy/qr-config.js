// ── Goofy Licenses — QR Destination Config (CLIENT) ─────────────────────────
// SINGLE SOURCE OF TRUTH for where printed QR codes point. Change the domain,
// line path, or tracking params HERE — the builder modal, the QR generator
// page, and any future line pages all read from window.GOOFY_QR.
//
// URL structure: <canonical-origin>/<line>?src=<tracker>  (e.g.
// https://goofylicenses.com/goat?src=frat-batch-1)
//
// Placements (both open the SAME nomination landing page):
//   - Nomination card in the shipped kit → per-batch src (?src=frat-batch-1,
//     batch name changes per drop)
//   - Licence card itself → its own src (?src=license-qr), attributed
//     separately from nomination-card scans
//
// Loaded as a classic <script src="/goofy/qr-config.js"> BEFORE pricing.js /
// the builder script. Plain script (no modules) so it works from file:// too.
(function (root) {
  var QR = {
    CANONICAL_ORIGIN: 'https://goofylicenses.com',
    LINE_PATH: '/goat',          // long-term structure is /<line> (/goat, /clown…)
    LICENCE_SRC: 'license-qr',   // ?src= printed on the licence card itself

    // ── Scan modal copy (shown when a visitor lands with ?src= in the URL) ──
    MODAL_TITLE: '🐐 Right of Nomination Granted',
    MODAL_BODY: 'Congratulations, Fellow GOAT. The Council has granted you the Right of Nomination. Choose the honor below and we will deliver the certification upon submission. The processing fee is the only thing charged.',
    MODAL_CTA: 'Choose the honor →'
  };

  // Nomination-card URL for a given batch/drop name.
  QR.nominationUrl = function (batch) {
    var b = String(batch == null ? '' : batch).trim() || 'frat-batch-1';
    return QR.CANONICAL_ORIGIN + QR.LINE_PATH + '?src=' + encodeURIComponent(b);
  };

  // Licence-card URL (its own tracker, separate from nomination-card scans).
  // With an order id (every printed card) it's the short per-card link
  //   HTTPS://GOOFYLICENSES.COM/L/GOOFY-1726694400000-AB12
  // which functions/_middleware.js redirects to
  //   /goat?src=license-qr&o=GOOFY-... (the landing greets that recipient).
  // It's all caps on purpose: that fits QR "alphanumeric" mode, so the code
  // needs a smaller grid and each printed module is ~35% bigger than the long
  // lowercase URL would give on the same 128px corner (easier to scan).
  // Without an id (the builder preview) it's the plain landing URL.
  QR.LICENCE_PATH = '/L/';
  QR.licenceUrl = function (orderId) {
    var id = String(orderId == null ? '' : orderId).trim().toUpperCase();
    if (/^[A-Z0-9-]{1,40}$/.test(id)) return QR.CANONICAL_ORIGIN.toUpperCase() + QR.LICENCE_PATH + id;
    return QR.CANONICAL_ORIGIN + QR.LINE_PATH + '?src=' + encodeURIComponent(QR.LICENCE_SRC);
  };

  // QR encoding mode for a URL: 'Alphanumeric' when every character fits
  // that set (0-9 A-Z space $%*+-./:), else 'Byte'.
  QR.qrMode = function (text) {
    return /^[0-9A-Z $%*+\-.\/:]*$/.test(String(text)) ? 'Alphanumeric' : 'Byte';
  };

  // "frat-batch-1" → "Frat Batch 1" for the scan-modal callout.
  QR.prettySrc = function (src) {
    return String(src || '').replace(/[-_]+/g, ' ').trim()
      .replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
      .slice(0, 60);
  };

  root.GOOFY_QR = QR;
})(typeof window !== 'undefined' ? window : this);
