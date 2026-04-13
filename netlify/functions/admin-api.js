'use strict';
// ── Pet Licence Factory — Admin API ──────────────────────────────────────────
// POST /.netlify/functions/admin-api
// Body: { action, ...params }
// Auth: Bearer JWT (except for "login" action)
//
// All admin database operations are proxied through this function so that the
// Supabase service role key never appears in client-side code.
// ---------------------------------------------------------------------------

const { createClient }  = require('@supabase/supabase-js');
const bcrypt            = require('bcryptjs');
const jwt               = require('jsonwebtoken');

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    body: JSON.stringify(body),
  };
}

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function verifyToken(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.ADMIN_JWT_SECRET);
  } catch {
    return null;
  }
}

// Whitelist of columns that admin can update on pet_orders
const ALLOWED_ORDER_UPDATES = ['status', 'tracking_number', 'notes', 'shipping_label_url'];

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return json(204, '');
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { action } = body;
  if (!action) return json(400, { error: 'Missing action' });

  // ── Login (no JWT required) ─────────────────────────────────────────────
  if (action === 'login') {
    const { password } = body;
    if (!password) return json(400, { error: 'Missing password' });

    const hash = process.env.ADMIN_PASSWORD_HASH;
    if (!hash) {
      console.error('ADMIN_PASSWORD_HASH not set in environment');
      return json(500, { error: 'Server configuration error' });
    }

    const match = await bcrypt.compare(password, hash);
    if (!match) return json(401, { error: 'Invalid password' });

    const token = jwt.sign(
      { role: 'admin' },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '8h' }
    );

    return json(200, { token });
  }

  // ── All other actions require valid JWT ──────────────────────────────────
  const payload = verifyToken(event);
  if (!payload || payload.role !== 'admin') {
    return json(401, { error: 'Unauthorized' });
  }

  const db = getSupabase();

  // ── Actions ─────────────────────────────────────────────────────────────

  switch (action) {

    // ── Orders ──────────────────────────────────────────────────────────

    case 'list_orders': {
      const limit = Math.min(Math.max(parseInt(body.limit) || 500, 1), 1000);
      const { data, error } = await db
        .from('pet_orders')
        .select('id,order_id,status,created_at,updated_at,pet_first_name,pet_last_name,customer_email,customer_name,shipping_option,total,pack_count,add_on,chip_size,tracking_number,notes,stripe_payment_id,ship_addr_line1,ship_addr_line2,ship_city,ship_state,ship_zip,ship_country')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return json(500, { error: error.message });
      return json(200, { orders: data });
    }

    case 'get_order': {
      const { id } = body;
      if (!id) return json(400, { error: 'Missing id' });
      const { data, error } = await db
        .from('pet_orders')
        .select('*')
        .eq('id', id)
        .single();
      if (error) return json(500, { error: error.message });
      return json(200, { order: data });
    }

    case 'update_order': {
      const { id, updates } = body;
      if (!id || !updates) return json(400, { error: 'Missing id or updates' });

      // Only allow whitelisted columns
      const safe = {};
      for (const key of ALLOWED_ORDER_UPDATES) {
        if (key in updates) safe[key] = updates[key];
      }
      safe.updated_at = new Date().toISOString();

      const { error } = await db
        .from('pet_orders')
        .update(safe)
        .eq('id', id);
      if (error) return json(500, { error: error.message });
      return json(200, { success: true });
    }

    case 'delete_all_orders': {
      const { error } = await db
        .from('pet_orders')
        .delete()
        .neq('id', 0);
      if (error) return json(500, { error: error.message });
      return json(200, { success: true });
    }

    // ── Tasks ───────────────────────────────────────────────────────────

    case 'list_tasks': {
      const { data, error } = await db
        .from('admin_tasks')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) return json(200, { tasks: [], fallback: true });
      return json(200, { tasks: data || [] });
    }

    case 'add_task': {
      const { text } = body;
      if (!text || typeof text !== 'string') return json(400, { error: 'Missing text' });
      const { data, error } = await db
        .from('admin_tasks')
        .insert({ text: text.slice(0, 500), done: false })
        .select()
        .single();
      if (error) return json(500, { error: error.message });
      return json(200, { task: data });
    }

    case 'toggle_task': {
      const { id, done } = body;
      if (!id) return json(400, { error: 'Missing id' });
      const { error } = await db
        .from('admin_tasks')
        .update({ done: !!done })
        .eq('id', id);
      if (error) return json(500, { error: error.message });
      return json(200, { success: true });
    }

    case 'delete_task': {
      const { id } = body;
      if (!id) return json(400, { error: 'Missing id' });
      const { error } = await db
        .from('admin_tasks')
        .delete()
        .eq('id', id);
      if (error) return json(500, { error: error.message });
      return json(200, { success: true });
    }

    default:
      return json(400, { error: `Unknown action: ${action}` });
  }
};
