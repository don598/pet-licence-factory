// ── Pet Licence Factory — SendGrid Email Helpers (Cloudflare) ────────────────
// Uses SendGrid v3 REST API via fetch. No Node SDK needed — works on the
// Workers runtime. Sender (`contact@creditcardart.com`) is a verified
// single-sender identity on the shared SendGrid account.
// ---------------------------------------------------------------------------

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

const DEFAULT_FROM_EMAIL = 'contact@creditcardart.com';
const DEFAULT_FROM_NAME  = 'Pet Licence Factory';

// ── HTML escape (XSS-safe interpolation into templates) ──────────────────────
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Low-level send ───────────────────────────────────────────────────────────
export async function sendEmail(env, { to, subject, html, text, replyTo }) {
  const apiKey = env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn('[SendGrid] No SENDGRID_API_KEY set — skipping email to', to);
    return { skipped: true };
  }
  if (!to) {
    console.warn('[SendGrid] No recipient — skipping send');
    return { skipped: true };
  }

  const fromEmail = env.SENDGRID_FROM_EMAIL || DEFAULT_FROM_EMAIL;
  const fromName  = env.SENDGRID_FROM_NAME  || DEFAULT_FROM_NAME;

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from:     { email: fromEmail, name: fromName },
    reply_to: { email: replyTo || fromEmail, name: fromName },
    subject,
    content: [
      ...(text ? [{ type: 'text/plain', value: text }] : []),
      { type: 'text/html', value: html },
    ],
  };

  const resp = await fetch(SENDGRID_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error(`[SendGrid] ${resp.status} ${resp.statusText} — ${errBody}`);
    return { success: false, status: resp.status, error: errBody };
  }
  return { success: true };
}

// ── Order confirmation email ────────────────────────────────────────────────
// Called from the Stripe webhook after checkout.session.completed.
// Keeps inline styles only (no external CSS) — email clients strip <style>.
export async function sendOrderConfirmationEmail(env, order) {
  const {
    orderId, customerEmail, customerName,
    petFirstName, petLastName,
    packCount, addOn, chipSize,
    shippingOption, total,
    shipAddrLine1, shipAddrLine2, shipCity, shipState, shipZip, shipCountry,
  } = order;

  if (!customerEmail) return { skipped: true, reason: 'no email' };

  const petFull = [petFirstName, petLastName].filter(Boolean).join(' ') || 'your pet';
  const shipLabel = ({
    stamp:    'Stamp Mail (USPS)',
    standard: 'Standard Shipping (7–14 business days)',
    priority: 'Priority Shipping (3–5 business days)',
  })[shippingOption] || 'Standard Shipping';
  const packLabel = (parseInt(packCount) === 2 ? '2-Pack' : '1-Pack')
    + ' Licence Sticker' + (addOn === 'car_decal' ? ' + Car Decal' : '');

  const addrParts = [shipAddrLine1, shipAddrLine2, [shipCity, shipState, shipZip].filter(Boolean).join(', '), shipCountry]
    .filter(Boolean).join('<br>');

  const subject = `🐾 Order confirmed — ${petFull}'s Pet Licence is on the way!`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#0d0800;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0d0800;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#1a0e04;border:2px solid #c8922a;border-radius:8px;overflow:hidden;">

        <!-- Header -->
        <tr><td style="padding:32px 32px 16px;text-align:center;background:linear-gradient(180deg,#2a1804 0%,#1a0e04 100%);">
          <div style="font-size:48px;line-height:1;margin-bottom:12px;">🐾</div>
          <h1 style="margin:0;font-family:'Courier New',monospace;font-size:22px;color:#4caf50;letter-spacing:2px;text-transform:uppercase;">Order Confirmed!</h1>
          <p style="margin:12px 0 0;font-size:14px;color:#d4a84a;line-height:1.5;">
            ${esc(petFull)} is now the most official animal in the neighbourhood.
          </p>
        </td></tr>

        <!-- Order ID -->
        <tr><td style="padding:24px 32px 8px;">
          <div style="background:#2a1804;border:1px solid #c8922a;border-radius:4px;padding:14px 18px;">
            <div style="font-size:11px;color:#d4a84a;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Your Order ID</div>
            <div style="font-family:'Courier New',monospace;font-size:14px;color:#f0c050;word-break:break-all;">${esc(orderId || '—')}</div>
          </div>
        </td></tr>

        <!-- Order details -->
        <tr><td style="padding:16px 32px;">
          <h2 style="margin:0 0 12px;font-size:13px;color:#c8922a;letter-spacing:1px;text-transform:uppercase;font-weight:600;">Order Summary</h2>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;color:#d4a84a;border-collapse:collapse;">
            <tr><td style="padding:6px 0;border-bottom:1px dashed rgba(200,146,42,.3);">Item</td><td style="padding:6px 0;text-align:right;border-bottom:1px dashed rgba(200,146,42,.3);color:#f0c050;">${esc(packLabel)}</td></tr>
            <tr><td style="padding:6px 0;border-bottom:1px dashed rgba(200,146,42,.3);">Chip Size</td><td style="padding:6px 0;text-align:right;border-bottom:1px dashed rgba(200,146,42,.3);color:#f0c050;">${esc((chipSize || 'mini').charAt(0).toUpperCase() + (chipSize || 'mini').slice(1))}</td></tr>
            <tr><td style="padding:6px 0;border-bottom:1px dashed rgba(200,146,42,.3);">Shipping</td><td style="padding:6px 0;text-align:right;border-bottom:1px dashed rgba(200,146,42,.3);color:#f0c050;">${esc(shipLabel)}</td></tr>
            <tr><td style="padding:12px 0 0;font-weight:700;color:#4caf50;">Total</td><td style="padding:12px 0 0;text-align:right;font-weight:700;color:#4caf50;font-size:16px;">${esc(total || '—')}</td></tr>
          </table>
        </td></tr>

        <!-- Shipping -->
        ${addrParts ? `<tr><td style="padding:16px 32px;">
          <h2 style="margin:0 0 12px;font-size:13px;color:#c8922a;letter-spacing:1px;text-transform:uppercase;font-weight:600;">Shipping To</h2>
          <div style="background:#2a1804;border-left:3px solid #c8922a;padding:12px 16px;font-size:14px;color:#d4a84a;line-height:1.6;">
            ${customerName ? `<strong style="color:#f0c050;">${esc(customerName)}</strong><br>` : ''}
            ${addrParts}
          </div>
        </td></tr>` : ''}

        <!-- What's next -->
        <tr><td style="padding:16px 32px 24px;">
          <h2 style="margin:0 0 12px;font-size:13px;color:#c8922a;letter-spacing:1px;text-transform:uppercase;font-weight:600;">What Happens Next</h2>
          <ol style="margin:0;padding-left:20px;font-size:14px;color:#d4a84a;line-height:1.8;">
            <li>We print your custom licence sticker (2–3 business days).</li>
            <li>We carefully package it and ship it via your chosen method.</li>
            <li>You get a follow-up email with tracking once it's in the mail.</li>
            <li>You frame it. Brag about it. You earned this.</li>
          </ol>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;background:#0d0800;border-top:1px solid rgba(200,146,42,.3);text-align:center;font-size:12px;color:#9e7a34;line-height:1.6;">
          Questions? Just reply to this email — we read every message.<br>
          <span style="opacity:.6;">Pet Licence Factory · 7900 Cambridge St, Apt 28-1G · Houston, TX 77054</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
`Order confirmed! 🐾

Order ID: ${orderId || '—'}
Pet: ${petFull}

Item:     ${packLabel}
Chip:     ${chipSize || 'mini'}
Shipping: ${shipLabel}
Total:    ${total || '—'}

${addrParts ? `Shipping to:\n${customerName ? customerName + '\n' : ''}${[shipAddrLine1, shipAddrLine2, [shipCity, shipState, shipZip].filter(Boolean).join(', '), shipCountry].filter(Boolean).join('\n')}\n\n` : ''}Next up: we'll print ${petFull}'s licence, package it with care, and ship it your way. You'll get a tracking email once it's out the door.

Questions? Just reply to this email.

— Pet Licence Factory`;

  return sendEmail(env, { to: customerEmail, subject, html, text });
}

// ── Shipping notification (called when admin sets tracking number) ──────────
export async function sendShippingNotificationEmail(env, order) {
  const { orderId, customerEmail, customerName, petFirstName, petLastName, trackingNumber, shippingOption } = order;
  if (!customerEmail || !trackingNumber) return { skipped: true };

  const petFull = [petFirstName, petLastName].filter(Boolean).join(' ') || 'your pet';
  const subject = `📬 ${petFull}'s Pet Licence is on the way!`;

  // USPS tracking URL (works for stamp/standard/priority — all USPS)
  const trackUrl = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0800;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0d0800;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#1a0e04;border:2px solid #c8922a;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:32px;text-align:center;">
          <div style="font-size:48px;margin-bottom:12px;">📬</div>
          <h1 style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:20px;color:#4caf50;letter-spacing:2px;text-transform:uppercase;">Shipped!</h1>
          <p style="margin:8px 0 24px;font-size:15px;color:#d4a84a;line-height:1.5;">
            ${esc(petFull)}'s licence just hit the mail stream.
          </p>
          <div style="background:#2a1804;border:1px solid #c8922a;border-radius:4px;padding:16px;margin:16px 0;text-align:left;">
            <div style="font-size:11px;color:#d4a84a;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Tracking Number</div>
            <div style="font-family:'Courier New',monospace;font-size:15px;color:#f0c050;word-break:break-all;">${esc(trackingNumber)}</div>
            <div style="font-size:11px;color:#d4a84a;text-transform:uppercase;letter-spacing:1px;margin:12px 0 4px;">Order</div>
            <div style="font-family:'Courier New',monospace;font-size:13px;color:#f0c050;">${esc(orderId || '—')}</div>
          </div>
          <a href="${esc(trackUrl)}" style="display:inline-block;margin-top:12px;padding:14px 28px;background:#c8922a;color:#0d0800;text-decoration:none;border-radius:4px;font-weight:700;font-size:14px;letter-spacing:1px;">Track Package →</a>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#0d0800;border-top:1px solid rgba(200,146,42,.3);text-align:center;font-size:12px;color:#9e7a34;line-height:1.6;">
          Questions? Reply to this email any time.<br>
          <span style="opacity:.6;">Pet Licence Factory · Houston, TX</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`📬 ${petFull}'s Pet Licence is on the way!

Tracking: ${trackingNumber}
Order:    ${orderId || '—'}
Track it: ${trackUrl}

— Pet Licence Factory`;

  return sendEmail(env, { to: customerEmail, subject, html, text });
}
