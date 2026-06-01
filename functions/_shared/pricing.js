// ── Pet Licence Factory — Canonical Pricing (SERVER) ────────────────────────
// SINGLE SOURCE OF TRUTH for what the customer is actually charged at checkout.
// Amounts are in US cents.
//
// ⚠️ MUST stay in sync with the client-side mirror at public/pricing.js
//    (which is display-only: builder summary + Command Station receipt).
//    There is no build step wiring these together, so if you change a price
//    here, change it there too.
export const PRICES = {
  pack1:    1395,   // 1-Pack Licence Sticker
  pack2:    1999,   // 2-Pack Licence Stickers
  decal:     499,   // 8×8" Vinyl Car Decal
  discRate:  0.15,  // 15% discount (mini-game reward)
  stamp:      95,   // Stamp Shipping
  standard:  699,   // Standard Shipping (USPS Ground Advantage — covers worst-case AK/HI $6.36)
  priority:  1099,  // Priority Shipping (USPS Priority Flat Rate Envelope — covers continental $9.62; ~$0.13 AK/HI shortfall absorbed)
};
