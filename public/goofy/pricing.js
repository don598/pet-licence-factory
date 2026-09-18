// ── Goofy Licenses — Canonical Pricing (CLIENT) ─────────────────────────────
// SINGLE SOURCE OF TRUTH for Goofy prices shown in the browser: the nominate
// page order summary.
//
// ⚠️ MUST stay in sync with the server-side source at
//    functions/_shared/pricing.js (GOOFY_PRICES — that file is what actually
//    charges the card). There is no build step linking them — change one,
//    change the other.
//
// Site-wide pricing frame: every price IS a "nomination processing fee".
// Never a fee added on top of a price (no drip pricing).
//
// Loaded as a classic <script src="/goofy/pricing.js"> BEFORE the nominate
// page script so the globals exist when it initialises. Separate globals
// from PLC (window.GOOFY_*) so the two brands can never collide.
(function (root) {
  // Amounts in US cents.
  var CENTS = {
    standard: 495,   // G.O.A.T. License Standard nomination processing fee
    custom:   895,   // G.O.A.T. License Custom nomination processing fee ($4.95 + $4.00)
    stamp:      0,   // Stamp Shipping: included in the processing fee (tracked tiers below are paid upgrades)
    standardShip: 699,  // Standard Shipping (USPS Ground Advantage)
    priority: 1099,  // Priority Shipping (USPS Priority Flat Rate Envelope)
  };

  // Dollar mirror for display code that works in dollars.
  var USD = {};
  for (var k in CENTS) USD[k] = CENTS[k] / 100;

  root.GOOFY_PRICES     = CENTS;   // cents (server-charge mirror)
  root.GOOFY_PRICES_USD = USD;     // dollars (nominate-page summary)
})(typeof window !== 'undefined' ? window : this);
