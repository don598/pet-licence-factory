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
  card1:     895,   // 1-Pack License Card (standalone PVC card, same as a Custom G.O.A.T.)
  card2:    1395,   // 2-Pack License Cards
  bundle:   1599,   // Bundle: 1 License Sticker + 1 License Card
  decal:     449,   // 4×4" Vinyl Car Decal
  discRate:  0.15,  // 15% discount (mini-game reward)
  stamp:      95,   // Stamp Shipping
  standard:  699,   // Standard Shipping (USPS Ground Advantage — covers worst-case AK/HI $6.36)
  priority:  1099,  // Priority Shipping (USPS Priority Flat Rate Envelope — covers continental $9.62; ~$0.13 AK/HI shortfall absorbed)
};

// ── Pet license formats ─────────────────────────────────────────────────────
// What a PLC order prints. Stored in pet_orders.variant (the same column the
// G.O.A.T. line uses for its variants; NULL/'' on older PLC rows = skin).
//   skin   → card skin sticker for a credit card (1 or 2 pack)
//   card   → standalone license card, printed & cut onto a PVC blank (1 or 2 pack)
//   bundle → one of each (pack size doesn't apply)
// Client mirror: PLF_ITEM in public/pricing.js.
export const PLC_FORMATS = ['skin', 'card', 'bundle'];
export function plcFormat(v) {
  return PLC_FORMATS.includes(v) ? v : 'skin';
}
export function plcItem(format, packQty) {
  const f = plcFormat(format);
  const two = parseInt(packQty) === 2 && f !== 'bundle';
  if (f === 'bundle') {
    return { format: f, packQty: 1, amount: PRICES.bundle,
      name: 'Pet License Bundle (Card Skin + License Card)',
      label: 'Bundle: License Sticker + License Card' };
  }
  if (f === 'card') {
    return { format: f, packQty: two ? 2 : 1, amount: two ? PRICES.card2 : PRICES.card1,
      name: two ? 'Pet License Card (2-Pack)' : 'Pet License Card (1-Pack)',
      label: two ? '2-Pack License Cards' : '1-Pack License Card' };
  }
  return { format: f, packQty: two ? 2 : 1, amount: two ? PRICES.pack2 : PRICES.pack1,
    name: two ? 'Pet License Sticker (2-Pack)' : 'Pet License Sticker (1-Pack)',
    label: two ? '2-Pack License Stickers' : '1-Pack License Sticker' };
}

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
