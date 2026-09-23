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
    pack1:     999,   // 1-Pack License Sticker
    pack2:    1599,   // 2-Pack License Stickers
    card1:     895,   // 1-Pack License Card (standalone PVC card)
    card2:    1395,   // 2-Pack License Cards
    bundle:   1599,   // Bundle: 1 License Sticker + 1 License Card
    decal:     449,   // 4×4" Vinyl Car Decal
    stamp:      95,   // Stamp Shipping
    standard:  699,   // Standard Shipping (USPS Ground Advantage)
    priority:  1099,  // Priority Shipping (USPS Priority Flat Rate Envelope)
  };
  var DISC_RATE = 0.15; // 15% mini-game reward discount

  // Dollar mirror for display code that works in dollars (plf-shared.js).
  var USD = {};
  for (var k in CENTS) USD[k] = CENTS[k] / 100;
  USD.disc = DISC_RATE;

  // What a pet order prints: 'skin' (card skin sticker), 'card' (standalone
  // license card) or 'bundle' (one of each; pack size doesn't apply).
  // Mirror of plcItem() in functions/_shared/pricing.js.
  function item(format, packQty) {
    var f = format === 'card' || format === 'bundle' ? format : 'skin';
    var two = parseInt(packQty, 10) === 2 && f !== 'bundle';
    var cents = f === 'bundle' ? CENTS.bundle
      : f === 'card' ? (two ? CENTS.card2 : CENTS.card1)
      : (two ? CENTS.pack2 : CENTS.pack1);
    var label = f === 'bundle' ? 'Bundle: License Sticker + License Card'
      : f === 'card' ? (two ? '2-Pack License Cards' : '1-Pack License Card')
      : (two ? '2-Pack License Stickers' : '1-Pack License Sticker');
    return { format: f, packQty: two ? 2 : 1, cents: cents, usd: cents / 100, label: label };
  }

  root.PLF_ITEM          = item;
  root.PLF_PRICES        = CENTS;       // cents (Command Station receipt)
  root.PLF_PRICES_USD    = USD;         // dollars (builder summary)
  root.PLF_DISCOUNT_RATE = DISC_RATE;
})(typeof window !== 'undefined' ? window : this);
