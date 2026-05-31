// ── Pet Licence Factory — Admin API (Cloudflare Pages Function) ─────────────
// POST /api/admin-api
// Body: { action, ...params }
// Auth: Bearer JWT (except for "login" action)
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { sendShippingNotificationEmail, sendStampShippedEmail, sendOrderConfirmationEmail } from '../_shared/email.js';
import { createAndBuyLabel } from '../_shared/easypost.js';
import { attributeOrder, getPaymentIntentId } from '../_shared/affiliate.js';
import Stripe from 'stripe';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// ── Helpers ─────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function verifyToken(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return jwt.verify(token, env.ADMIN_JWT_SECRET);
  } catch {
    return null;
  }
}

// Whitelist of columns that admin can update on pet_orders
const ALLOWED_ORDER_UPDATES = ['status', 'tracking_number', 'notes', 'shipping_label_url', 'verification_error'];

// Strip control chars, cap length — used for admin-supplied override addresses.
function clean(v, max = 200) {
  return String(v ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const db = getDb(env);

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { action } = body;
  if (!action) return json(400, { error: 'Missing action' });

  // ── Login (no JWT required) ─────────────────────────────────────────────
  if (action === 'login') {
    const { password } = body;
    if (!password) return json(400, { error: 'Missing password' });

    const hash = env.ADMIN_PASSWORD_HASH;
    if (!hash) {
      console.error('ADMIN_PASSWORD_HASH not set in environment');
      return json(500, { error: 'Server configuration error' });
    }

    const match = await bcrypt.compare(password, hash);
    if (!match) return json(401, { error: 'Invalid password' });

    const token = jwt.sign(
      { role: 'admin' },
      env.ADMIN_JWT_SECRET,
      { expiresIn: '8h' }
    );

    return json(200, { token });
  }

  // ── All other actions require valid JWT ──────────────────────────────────
  const payload = verifyToken(request, env);
  if (!payload || payload.role !== 'admin') {
    return json(401, { error: 'Unauthorized' });
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  try {
    switch (action) {

      // ── Orders ──────────────────────────────────────────────────────────

      case 'list_orders': {
        const limit = Math.min(Math.max(parseInt(body.limit) || 500, 1), 1000);
        const result = await db.query(
          `SELECT p.id, p.order_id, p.status, p.created_at, p.updated_at, p.pet_first_name, p.pet_last_name,
                  p.customer_email, p.customer_name, p.shipping_option, p.total, p.pack_count, p.add_on,
                  p.chip_size, p.tracking_number, p.notes, p.stripe_payment_id,
                  p.ship_addr_line1, p.ship_addr_line2, p.ship_city, p.ship_state, p.ship_zip, p.ship_country,
                  p.verification_error, p.verification_attempts,
                  p.affiliate_creator_id, p.affiliate_coupon_code, p.affiliate_commission_rate,
                  p.affiliate_commission_cents, p.affiliate_is_freebie,
                  c.name AS affiliate_creator_name
           FROM pet_orders p
           LEFT JOIN affiliate_creators c ON c.id = p.affiliate_creator_id
           ORDER BY p.created_at DESC LIMIT $1`,
          [limit]
        );
        return json(200, { orders: result.rows });
      }

      case 'get_order': {
        const { id } = body;
        if (!id) return json(400, { error: 'Missing id' });
        const result = await db.query(
          `SELECT p.*, c.name AS affiliate_creator_name, c.email AS affiliate_creator_email
           FROM pet_orders p
           LEFT JOIN affiliate_creators c ON c.id = p.affiliate_creator_id
           WHERE p.id = $1`,
          [id]
        );
        if (result.rows.length === 0) return json(404, { error: 'Order not found' });
        return json(200, { order: result.rows[0] });
      }

      case 'update_order': {
        const { id, updates } = body;
        if (!id || !updates) return json(400, { error: 'Missing id or updates' });

        // Read the current row first so we can detect transitions and fire emails.
        const priorRes = await db.query(
          `SELECT tracking_number, customer_email, status, shipping_option FROM pet_orders WHERE id = $1`,
          [id]
        );
        const prior = priorRes.rows[0] || {};
        const priorTracking = (prior.tracking_number || '').trim();
        const priorStatus   = (prior.status || '').trim();

        const setClauses = [];
        const values = [];
        let paramIdx = 1;

        for (const key of ALLOWED_ORDER_UPDATES) {
          if (key in updates) {
            setClauses.push(`${key} = $${paramIdx}`);
            values.push(updates[key]);
            paramIdx++;
          }
        }

        if (setClauses.length === 0) return json(400, { error: 'No valid updates' });

        setClauses.push(`updated_at = NOW()`);
        values.push(id);

        const upd = await db.query(
          `UPDATE pet_orders SET ${setClauses.join(', ')} WHERE id = $${paramIdx}
           RETURNING order_id, pet_first_name, pet_last_name, customer_email, customer_name,
                     shipping_option, tracking_number, status, pack_count, add_on, chip_size, total,
                     ship_addr_line1, ship_addr_line2, ship_city, ship_state, ship_zip, ship_country`,
          values
        );

        const row = upd.rows[0];
        let emailSent = false;

        // Shipping notification trigger: tracking number just got set
        const newTracking = ((row?.tracking_number) || '').trim();
        const crossedThreshold = !priorTracking && newTracking;
        if (crossedThreshold && row?.customer_email) {
          try {
            await sendShippingNotificationEmail(env, {
              orderId:        row.order_id,
              customerEmail:  row.customer_email,
              petFirstName:   row.pet_first_name,
              petLastName:    row.pet_last_name,
              trackingNumber: row.tracking_number,
              shippingOption: row.shipping_option,
            });
            emailSent = true;
          } catch (e) {
            console.error('Shipping email failed (non-fatal):', e);
          }
        }

        // Stamp-mail shipped trigger: status just flipped to 'printed'.
        // (Confirmation already sent at payment time by the Stripe webhook.)
        const statusJustPrinted = priorStatus !== 'printed' && row?.status === 'printed';
        if (statusJustPrinted && row?.shipping_option === 'stamp' && row?.customer_email) {
          try {
            await sendStampShippedEmail(env, {
              orderId:       row.order_id,
              customerEmail: row.customer_email,
              petFirstName:  row.pet_first_name,
              petLastName:   row.pet_last_name,
            });
            emailSent = true;
          } catch (e) {
            console.error('Stamp shipped email failed (non-fatal):', e);
          }
        }

        return json(200, { success: true, emailSent });
      }

      // ── Override USPS + fulfil ─────────────────────────────────────────
      // Admin escape hatch for an address_invalid order: ship the address the
      // customer actually entered (USPS false-negatives on real addresses do
      // happen), optionally lightly corrected. Captures the held auth, marks
      // the order paid, credits any affiliate, and sends the confirmation email.
      case 'force_fulfill': {
        const { id, address } = body;
        if (!id) return json(400, { error: 'Missing id' });

        const res = await db.query('SELECT * FROM pet_orders WHERE id = $1', [id]);
        const order = res.rows[0];
        if (!order) return json(404, { error: 'Order not found' });

        // 1. Optionally overwrite the shipping address with admin-supplied values.
        if (address && typeof address === 'object') {
          const a = {
            line1:   clean(address.line1),
            line2:   clean(address.line2),
            city:    clean(address.city),
            state:   clean(address.state, 2).toUpperCase(),
            zip:     clean(address.zip, 12),
            country: clean(address.country, 2).toUpperCase() || 'US',
          };
          if (!a.line1 || !a.city || !a.state || !a.zip) {
            return json(400, { error: 'Address needs at least line1, city, state, and ZIP.' });
          }
          await db.query(
            `UPDATE pet_orders SET
               ship_addr_line1 = $1, ship_addr_line2 = $2, ship_city = $3,
               ship_state = $4, ship_zip = $5, ship_country = $6, updated_at = NOW()
             WHERE id = $7`,
            [a.line1, a.line2, a.city, a.state, a.zip, a.country, id]
          );
          Object.assign(order, {
            ship_addr_line1: a.line1, ship_addr_line2: a.line2, ship_city: a.city,
            ship_state: a.state, ship_zip: a.zip, ship_country: a.country,
          });
        }

        // 2. Capture the held auth. A $0 order (e.g. 100% freebie) has no PI —
        //    that's fine, there's simply nothing to charge.
        const stripe = new Stripe(env.STRIPE_SECRET_KEY);
        let captured = false;
        let captureNote = '';
        const piId = await getPaymentIntentId(stripe, order);
        if (piId) {
          try {
            await stripe.paymentIntents.capture(piId);
            captured = true;
          } catch (err) {
            const msg = String(err?.message || err);
            if (/already.*captured/i.test(msg)) {
              captured = true;
              captureNote = 'already captured';
            } else if (/canceled|cannot capture|expired|requires_payment_method/i.test(msg)) {
              return json(409, {
                error: `Could not capture payment: ${msg}. The card hold may have expired — ask the customer to check out again.`,
              });
            } else {
              throw err;
            }
          }
        } else {
          captureNote = 'no payment intent (free order — nothing to charge)';
        }

        // 3. Mark paid + clear the verification error.
        await db.query(
          `UPDATE pet_orders SET status = 'paid', verification_error = NULL, updated_at = NOW()
           WHERE id = $1`,
          [id]
        );

        // 4. Credit the affiliate creator if a coupon/ref was used (non-fatal).
        if (order.stripe_session_id) {
          try {
            await attributeOrder(env, db, stripe, { id: order.stripe_session_id }, order.order_id);
          } catch (err) {
            console.error('force_fulfill affiliate attribution failed (non-fatal):', err);
          }
        }

        // 5. Send the confirmation email (non-fatal).
        if (order.customer_email) {
          try {
            await sendOrderConfirmationEmail(env, {
              orderId:        order.order_id,
              customerEmail:  order.customer_email,
              customerName:   order.customer_name,
              petFirstName:   order.pet_first_name,
              petLastName:    order.pet_last_name,
              packCount:      order.pack_count,
              addOn:          order.add_on,
              chipSize:       order.chip_size,
              shippingOption: order.shipping_option,
              total:          order.total,
              shipAddrLine1:  order.ship_addr_line1,
              shipAddrLine2:  order.ship_addr_line2,
              shipCity:       order.ship_city,
              shipState:      order.ship_state,
              shipZip:        order.ship_zip,
              shipCountry:    order.ship_country,
            });
          } catch (err) {
            console.error('force_fulfill confirmation email failed (non-fatal):', err);
          }
        }

        // Return the refreshed row (joined with creator name) for the UI.
        const out = await db.query(
          `SELECT p.id, p.order_id, p.status, p.created_at, p.updated_at, p.pet_first_name, p.pet_last_name,
                  p.customer_email, p.customer_name, p.shipping_option, p.total, p.pack_count, p.add_on,
                  p.chip_size, p.tracking_number, p.notes, p.stripe_payment_id,
                  p.ship_addr_line1, p.ship_addr_line2, p.ship_city, p.ship_state, p.ship_zip, p.ship_country,
                  p.verification_error, p.verification_attempts,
                  p.affiliate_creator_id, p.affiliate_coupon_code, p.affiliate_commission_rate,
                  p.affiliate_commission_cents, p.affiliate_is_freebie,
                  c.name AS affiliate_creator_name
           FROM pet_orders p
           LEFT JOIN affiliate_creators c ON c.id = p.affiliate_creator_id
           WHERE p.id = $1`,
          [id]
        );
        return json(200, { success: true, captured, captureNote, order: out.rows[0] });
      }

      case 'delete_all_orders': {
        await db.query('DELETE FROM pet_orders');
        return json(200, { success: true });
      }

      // ── Shipping label (EasyPost) ──────────────────────────────────────
      case 'create_shipping_label': {
        const { id } = body;
        if (!id) return json(400, { error: 'Missing id' });

        // Load full order — need shipping address, shipping_option, pack_count, etc.
        const res = await db.query('SELECT * FROM pet_orders WHERE id = $1', [id]);
        if (res.rows.length === 0) return json(404, { error: 'Order not found' });
        const order = res.rows[0];

        if (order.status !== 'paid' && order.status !== 'shipped') {
          return json(400, { error: `Order status is "${order.status}" — must be paid first.` });
        }
        if ((order.shipping_option || 'stamp') === 'stamp') {
          return json(400, { error: 'Stamp-tier orders are hand-stamped. No label is generated.' });
        }
        if (order.tracking_number) {
          return json(400, { error: `Order already has tracking: ${order.tracking_number}` });
        }
        if (!order.ship_addr_line1 || !order.ship_city || !order.ship_state || !order.ship_zip) {
          return json(400, { error: 'Order is missing a complete shipping address.' });
        }

        // Call EasyPost
        let result;
        try {
          result = await createAndBuyLabel(env, order);
        } catch (err) {
          console.error('EasyPost error:', err);
          return json(502, { error: err.message || 'EasyPost request failed' });
        }

        // Persist tracking + label URL, flip status to 'shipped'
        await db.query(
          `UPDATE pet_orders SET
             tracking_number    = $1,
             shipping_label_url = $2,
             status             = 'shipped',
             updated_at         = NOW()
           WHERE id = $3`,
          [result.tracking_number, result.label_url, id]
        );

        // Fire shipping-notification email — tracking just transitioned empty → set
        if (order.customer_email) {
          try {
            await sendShippingNotificationEmail(env, {
              orderId:        order.order_id,
              customerEmail:  order.customer_email,
              petFirstName:   order.pet_first_name,
              petLastName:    order.pet_last_name,
              trackingNumber: result.tracking_number,
              shippingOption: order.shipping_option,
            });
          } catch (e) {
            console.error('Shipping email failed (non-fatal):', e);
          }
        }

        return json(200, {
          success:         true,
          tracking_number: result.tracking_number,
          label_url:       result.label_url,
          rate:            result.rate,
          currency:        result.currency,
          carrier:         result.carrier,
          service:         result.service,
        });
      }

      // ── Tasks ───────────────────────────────────────────────────────────

      case 'list_tasks': {
        const result = await db.query('SELECT * FROM admin_tasks ORDER BY created_at ASC');
        return json(200, { tasks: result.rows });
      }

      case 'add_task': {
        const { text } = body;
        if (!text || typeof text !== 'string') return json(400, { error: 'Missing text' });
        const result = await db.query(
          'INSERT INTO admin_tasks (text, done) VALUES ($1, false) RETURNING *',
          [text.slice(0, 500)]
        );
        return json(200, { task: result.rows[0] });
      }

      case 'toggle_task': {
        const { id, done } = body;
        if (!id) return json(400, { error: 'Missing id' });
        await db.query('UPDATE admin_tasks SET done = $1 WHERE id = $2', [!!done, id]);
        return json(200, { success: true });
      }

      case 'delete_task': {
        const { id } = body;
        if (!id) return json(400, { error: 'Missing id' });
        await db.query('DELETE FROM admin_tasks WHERE id = $1', [id]);
        return json(200, { success: true });
      }

      default:
        return json(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('Admin API error:', err);
    return json(500, { error: err.message });
  }
}
