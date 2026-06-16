// ── Pet License Factory — Canonical Pricing (CLIENT) ────────────────────────
// SINGLE SOURCE OF TRUTH for prices shown in the browser: the builder order
// summary (plf-shared.js) and the Command Station printed receipt.
//
// ⚠️ MUST stay in sync with the server-side source at
//    functions/_shared/pricing.js (that file is what actually charges the
//    card). There is no build step linking them — change one, change the other.
//
// Loaded as a classic <script src="/pricing.js"> BEFORE plf-shared.js so the
// globals exist when the builder initialises.
(function (root) {
  // Amounts in US cents.
  var CENTS = {
    pack1:    1395,   // 1-Pack License Sticker
    pack2:    1999,   // 2-Pack License Stickers
    decal:     449,   // 4.5×4.5" Vinyl Car Decal
    stamp:      95,   // Stamp Shipping
    standard:  699,   // Standard Shipping (USPS Ground Advantage)
    priority:  1099,  // Priority Shipping (USPS Priority Flat Rate Envelope)
  };
  var DISC_RATE = 0.15; // 15% mini-game reward discount

  // Dollar mirror for display code that works in dollars (plf-shared.js).
  var USD = {};
  for (var k in CENTS) USD[k] = CENTS[k] / 100;
  USD.disc = DISC_RATE;

  root.PLF_PRICES        = CENTS;       // cents (Command Station receipt)
  root.PLF_PRICES_USD    = USD;         // dollars (builder summary)
  root.PLF_DISCOUNT_RATE = DISC_RATE;
})(typeof window !== 'undefined' ? window : this);
