// ── Pet License Factory — Canonical Pricing (SERVER) ────────────────────────
// SINGLE SOURCE OF TRUTH for what the customer is actually charged at checkout.
// Amounts are in US cents.
//
// ⚠️ MUST stay in sync with the client-side mirror at public/pricing.js
//    (which is display-only: builder summary + Command Station receipt).
//    There is no build step wiring these together, so if you change a price
//    here, change it there too.
export const PRICES = {
  pack1:     999,   // 1-Pack License Sticker
  pack2:    1599,   // 2-Pack License Stickers
  decal:     449,   // 4×4" Vinyl Car Decal
  discRate:  0.15,  // 15% discount (mini-game reward)
  stamp:      95,   // Stamp Shipping
  standard:  699,   // Standard Shipping (USPS Ground Advantage — covers worst-case AK/HI $6.36)
  priority:  1099,  // Priority Shipping (USPS Priority Flat Rate Envelope — covers continental $9.62; ~$0.13 AK/HI shortfall absorbed)
};

// ── Goofy Licenses — Canonical Pricing (SERVER) ─────────────────────────────
// Same contract as PRICES above: what the card is actually charged at
// checkout. Amounts in US cents. Client mirror: public/goofy/pricing.js.
//
// Site-wide pricing frame: every price IS a "nomination processing fee" —
// never a fee on top of a price.
export const GOOFY_PRICES = {
  standard: 495,   // G.O.A.T. License Standard nomination processing fee
  custom:   895,   // G.O.A.T. License Custom nomination processing fee ($4.95 + $4.00)
  stamp:       0,  // Stamp Shipping: included in the processing fee (tracked tiers below are paid upgrades)
  standardShip: 699,  // Standard Shipping (USPS Ground Advantage)
  priority: 1099,  // Priority Shipping (USPS Priority Flat Rate Envelope)
};
