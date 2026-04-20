// ── Pet Licence Factory — Admin API (Cloudflare Pages Function) ─────────────
// POST /api/admin-api
// Body: { action, ...params }
// Auth: Bearer JWT (except for "login" action)
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { sendShippingNotificationEmail, sendStampShippedEmail } from '../_shared/email.js';
import { createAndBuyLabel } from '../_shared/easypost.js';
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
const ALLOWED_ORDER_UPDATES = ['status', 'tracking_number', 'notes', 'shipping_label_url'];

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
          `SELECT id, order_id, status, created_at, updated_at, pet_first_name, pet_last_name,
                  customer_email, customer_name, shipping_option, total, pack_count, add_on,
                  chip_size, tracking_number, notes, stripe_payment_id,
                  ship_addr_line1, ship_addr_line2, ship_city, ship_state, ship_zip, ship_country
           FROM pet_orders ORDER BY created_at DESC LIMIT $1`,
          [limit]
        );
        return json(200, { orders: result.rows });
      }

      case 'get_order': {
        const { id } = body;
        if (!id) return json(400, { error: 'Missing id' });
        const result = await db.query('SELECT * FROM pet_orders WHERE id = $1', [id]);
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
