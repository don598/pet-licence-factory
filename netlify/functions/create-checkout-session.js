'use strict';
// ── Pet Licence Factory — Stripe Checkout Session Creator ──────────────────
// POST /.netlify/functions/create-checkout-session
// Body: { orderId, packQty, wantsDecal, discountEarned, petData, origin, cancelUrl }
// Returns: { url, sessionId }
// ---------------------------------------------------------------------------

const Stripe = require('stripe');

// Prices in US cents — must match PRICES in plf-shared.js
const PRICES = {
  pack1:    1395,   // 1-Pack Licence Sticker
  pack2:    1999,   // 2-Pack Licence Stickers
  decal:     499,   // 8×8" Vinyl Car Decal
  discRate:  0.15,  // 15% discount (mini-game reward)
  stamp:      95,   // Stamp Shipping
  standard:  399,   // Standard Shipping
  priority:  799,   // Priority Shipping
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const {
    orderId        = '',
    packQty        = 1,
    wantsDecal     = false,
    discountEarned = false,
    petData        = {},
    origin         = '',
    cancelUrl      = '',
  } = body;

  // ── Calculate line item amounts in cents ──────────────────────────────────
  let packAmount  = packQty === 2 ? PRICES.pack2 : PRICES.pack1;
  let decalAmount = wantsDecal ? PRICES.decal : 0;

  if (discountEarned) {
    packAmount  = Math.round(packAmount  * (1 - PRICES.discRate));
    decalAmount = decalAmount > 0 ? Math.round(decalAmount * (1 - PRICES.discRate)) : 0;
  }

  // ── Build Stripe line items ───────────────────────────────────────────────
  const lineItems = [
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: packQty === 2
            ? 'Pet Licence Sticker (2-Pack)'
            : 'Pet Licence Sticker (1-Pack)',
          description: discountEarned
            ? 'Custom pet licence sticker — 15% mini-game discount applied!'
            : 'Custom pet licence sticker with your pet\'s photo and info',
        },
        unit_amount: packAmount,
      },
      quantity: 1,
    },
  ];

  if (wantsDecal) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: '8×8" Vinyl Car Decal',
          description: discountEarned
            ? 'Weatherproof vinyl die-cut of your pet — 15% discount applied!'
            : 'Weatherproof vinyl die-cut sticker for your car',
        },
        unit_amount: decalAmount,
      },
      quantity: 1,
    });
  }

  // ── Build URLs ────────────────────────────────────────────────────────────
  const siteOrigin = origin || process.env.URL || 'http://localhost:8888';
  const successUrl = `${siteOrigin}/success.html?session_id={CHECKOUT_SESSION_ID}&order_id=${encodeURIComponent(orderId)}`;
  const cancel     = cancelUrl || `${siteOrigin}/game.html`;

  // ── Create Stripe Checkout Session ───────────────────────────────────────
  try {
    const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,

      // Collect shipping address inside Stripe Checkout
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ'],
      },

      // Three shipping options matching the game's shipping picker
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: PRICES.stamp, currency: 'usd' },
            display_name: 'Stamp Shipping',
            delivery_estimate: {
              minimum: { unit: 'week', value: 2 },
              maximum: { unit: 'week', value: 4 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: PRICES.standard, currency: 'usd' },
            display_name: 'Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 7 },
              maximum: { unit: 'business_day', value: 14 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: PRICES.priority, currency: 'usd' },
            display_name: 'Priority Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 3 },
              maximum: { unit: 'business_day', value: 5 },
            },
          },
        },
      ],

      // Always create a customer so we have their email
      customer_creation: 'always',

      // Store order data as metadata for the webhook to pick up
      metadata: {
        order_id:        orderId,
        pet_first_name:  (petData.petFirstName || '').slice(0, 100),
        pet_last_name:   (petData.petLastName  || '').slice(0, 100),
        pack_qty:        String(packQty),
        wants_decal:     String(wantsDecal),
        discount_earned: String(discountEarned),
      },

      success_url: successUrl,
      cancel_url:  cancel,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, sessionId: session.id }),
    };

  } catch (err) {
    console.error('Stripe create-checkout-session error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
