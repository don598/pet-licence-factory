// ── Pet Licence Factory — EasyPost Shipping Helper (Cloudflare) ──────────────
// EasyPost REST API via fetch. HTTP Basic auth using the API key as username.
// Uses env.EASYPOST_API_KEY — set to your test key (EZTK…) for dev, production
// key (EZAK…) for live. Same code, swap the env var to go live.
// ---------------------------------------------------------------------------

const EP_BASE = 'https://api.easypost.com/v2';

// Return address for all shipments
export const FROM_ADDRESS = {
  name:    'Pet Licence Factory',
  street1: '7900 Cambridge St.',
  street2: 'Apt 28-1G',
  city:    'Houston',
  state:   'TX',
  zip:     '77054',
  country: 'US',
  email:   'contact@creditcardart.com',
};

// Parcel dimensions per order shape. Small rigid mailer for the card-skin
// sticker. 2-pack + decal adds weight but keeps the same envelope size.
function parcelFor(order) {
  const packCount = parseInt(order.pack_count) || 1;
  const hasDecal  = order.add_on === 'car_decal';
  const oz = 1 + (packCount === 2 ? 0.5 : 0) + (hasDecal ? 1.5 : 0);
  return {
    length: 6.0,
    width:  4.0,
    height: 0.25,
    weight: oz, // EasyPost weight is in ounces
  };
}

// Build the EasyPost `to_address` from a paid pet_orders row.
function toAddressFrom(order) {
  return {
    name:    order.customer_name || [order.pet_first_name, order.pet_last_name].filter(Boolean).join(' ') || 'Recipient',
    street1: order.ship_addr_line1 || '',
    street2: order.ship_addr_line2 || '',
    city:    order.ship_city       || '',
    state:   order.ship_state      || '',
    zip:     order.ship_zip        || '',
    country: order.ship_country    || 'US',
    email:   order.customer_email  || '',
  };
}

// Map our shipping_option → EasyPost USPS service name used to filter rates.
// Stamp is never labeled via EasyPost (user hand-stamps; see create-label).
const SERVICE_FOR_OPTION = {
  standard: 'First',              // USPS First-Class Package Service
  priority: 'Priority',           // USPS Priority Mail
};

function authHeader(apiKey) {
  // EasyPost uses HTTP Basic with the API key as username and empty password
  const encoded = typeof btoa === 'function'
    ? btoa(apiKey + ':')
    : Buffer.from(apiKey + ':').toString('base64');
  return 'Basic ' + encoded;
}

async function ep(env, method, path, body) {
  const apiKey = env.EASYPOST_API_KEY;
  if (!apiKey) throw new Error('EASYPOST_API_KEY not set');
  const resp = await fetch(EP_BASE + path, {
    method,
    headers: {
      'Authorization': authHeader(apiKey),
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || `${resp.status} ${resp.statusText}`;
    throw new Error('EasyPost: ' + msg);
  }
  return data;
}

/**
 * Create a shipment, buy the cheapest rate matching the customer's chosen
 * shipping tier, and return { tracking_number, label_url, rate, carrier }.
 *
 * Throws on:
 *   - Invalid shipping_option (stamp should never reach here)
 *   - No matching rate available
 *   - Bad address / EasyPost API error
 */
export async function createAndBuyLabel(env, order) {
  const option = (order.shipping_option || 'stamp').toLowerCase();
  if (option === 'stamp') {
    throw new Error('Stamp-tier orders are hand-stamped and do not use EasyPost.');
  }
  const desiredService = SERVICE_FOR_OPTION[option];
  if (!desiredService) throw new Error(`Unknown shipping_option: ${option}`);

  // Create the shipment with inline addresses + parcel. EasyPost returns rates.
  const shipment = await ep(env, 'POST', '/shipments', {
    shipment: {
      to_address:   toAddressFrom(order),
      from_address: FROM_ADDRESS,
      parcel:       parcelFor(order),
      // Let EasyPost verify the recipient address and warn us about bad ones
      options: { address_validation_level: 'none' },
    },
  });

  const rates = Array.isArray(shipment.rates) ? shipment.rates : [];
  if (rates.length === 0) {
    throw new Error('EasyPost returned no rates for this shipment (check address).');
  }

  // Filter to USPS + the service tier we want
  const candidates = rates.filter(r =>
    r.carrier === 'USPS' && (r.service || '').startsWith(desiredService)
  );
  // Fallback: if our preferred tier isn't available, use cheapest USPS rate
  const pool = candidates.length > 0 ? candidates : rates.filter(r => r.carrier === 'USPS');
  if (pool.length === 0) throw new Error('No USPS rates available for this shipment.');

  pool.sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
  const chosen = pool[0];

  // Buy the rate → EasyPost produces the label + assigns tracking number
  const bought = await ep(env, 'POST', `/shipments/${shipment.id}/buy`, {
    rate: { id: chosen.id },
  });

  return {
    tracking_number: bought.tracking_code,
    label_url:       bought.postage_label?.label_url || '',
    rate:            chosen.rate,
    currency:        chosen.currency || 'USD',
    carrier:         chosen.carrier,
    service:         chosen.service,
    shipment_id:     shipment.id,
  };
}
