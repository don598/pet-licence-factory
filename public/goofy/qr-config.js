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
    MODAL_BODY: 'Congratulations, Fellow GOAT. The Council has granted you the Right of Nomination. Choose the honor below and we will deliver the certification upon submission. A small processing fee of $4.95 applies.',
    MODAL_CTA: 'Choose the honor →'
  };

  // Nomination-card URL for a given batch/drop name.
  QR.nominationUrl = function (batch) {
    var b = String(batch == null ? '' : batch).trim() || 'frat-batch-1';
    return QR.CANONICAL_ORIGIN + QR.LINE_PATH + '?src=' + encodeURIComponent(b);
  };

  // Licence-card URL (its own tracker, separate from nomination-card scans).
  QR.licenceUrl = function () {
    return QR.CANONICAL_ORIGIN + QR.LINE_PATH + '?src=' + encodeURIComponent(QR.LICENCE_SRC);
  };

  root.GOOFY_QR = QR;
})(typeof window !== 'undefined' ? window : this);
