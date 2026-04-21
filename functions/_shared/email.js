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

  const subject = `🐾 Order confirmed — ${petFull}'s Pet Licence is being processed!`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">

        <!-- Header -->
        <tr><td style="padding:32px 32px 16px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://pet-licence-factory.pages.dev/images/wordmark-email.png" alt="Pet Licence Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <img src="https://pet-licence-factory.pages.dev/images/rabbit-email.gif" width="80" height="80" alt="🐰" style="display:block;margin:0 auto 12px;image-rendering:pixelated;">
          <h1 style="margin:0;font-family:'Press Start 2P','Courier New',monospace;font-size:16px;color:#0077ff;letter-spacing:2px;text-transform:uppercase;">Order Confirmed!</h1>
          <p style="margin:12px 0 0;font-size:14px;color:#334477;line-height:1.5;">
            ${esc(petFull)} is now the most official animal in the neighbourhood.
          </p>
        </td></tr>

        <!-- Order ID -->
        <tr><td style="padding:24px 32px 8px;">
          <div style="background:#f0f5ff;border:1px solid #0088cc;border-radius:4px;padding:14px 18px;">
            <div style="font-size:11px;color:#5577aa;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Your Order ID</div>
            <div style="font-family:'Courier New',monospace;font-size:14px;color:#0055cc;word-break:break-all;">${esc(orderId || '—')}</div>
          </div>
        </td></tr>

        <!-- Order details -->
        <tr><td style="padding:16px 32px;">
          <h2 style="margin:0 0 12px;font-size:13px;color:#0088cc;letter-spacing:1px;text-transform:uppercase;font-weight:600;">🧾 Order Summary</h2>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;color:#223355;border-collapse:collapse;">
            <tr><td style="padding:6px 0;border-bottom:1px dashed rgba(0,102,255,.15);">Item</td><td style="padding:6px 0;text-align:right;border-bottom:1px dashed rgba(0,102,255,.15);color:#0099cc;">${esc(packLabel)}</td></tr>
            <tr><td style="padding:6px 0;border-bottom:1px dashed rgba(0,102,255,.15);">Chip Size</td><td style="padding:6px 0;text-align:right;border-bottom:1px dashed rgba(0,102,255,.15);color:#0099cc;">${esc((chipSize || 'mini').charAt(0).toUpperCase() + (chipSize || 'mini').slice(1))}</td></tr>
            <tr><td style="padding:6px 0;border-bottom:1px dashed rgba(0,102,255,.15);">Shipping</td><td style="padding:6px 0;text-align:right;border-bottom:1px dashed rgba(0,102,255,.15);color:#0099cc;">${esc(shipLabel)}</td></tr>
            <tr><td style="padding:12px 0 0;font-weight:700;color:#0077ff;">Total</td><td style="padding:12px 0 0;text-align:right;font-weight:700;color:#0077ff;font-size:16px;">${esc(total || '—')}</td></tr>
          </table>
        </td></tr>

        <!-- Shipping -->
        ${addrParts ? `<tr><td style="padding:16px 32px;">
          <h2 style="margin:0 0 12px;font-size:13px;color:#0088cc;letter-spacing:1px;text-transform:uppercase;font-weight:600;">📦 Shipping To</h2>
          <div style="background:#f0f5ff;border-left:3px solid #0077ff;padding:12px 16px;font-size:14px;color:#223355;line-height:1.6;">
            ${customerName ? `<strong style="color:#0099cc;">${esc(customerName)}</strong><br>` : ''}
            ${addrParts}
          </div>
        </td></tr>` : ''}

        <!-- Stamp mail notice -->
        ${shippingOption === 'stamp' ? `<tr><td style="padding:0 32px 8px;">
          <div style="background:#f0f8ff;border:1px dashed #0099cc;border-radius:4px;padding:14px 18px;">
            <div style="font-size:12px;color:#0099cc;font-weight:700;margin-bottom:6px;">📮 Stamp Mail — No Tracking Number</div>
            <div style="font-size:13px;color:#223355;line-height:1.6;">Your order ships via USPS stamp mail. There's no tracking number with this option. If your licence hasn't arrived after <strong style="color:#0099cc;">21 days</strong> (most orders arrive in 3–5 days), email us at <a href="mailto:contact@creditcardart.com" style="color:#0055cc;">contact@creditcardart.com</a> and we'll make it right — free replacement included.</div>
          </div>
        </td></tr>` : ''}

        <!-- What's next -->
        <tr><td style="padding:16px 32px 24px;">
          <h2 style="margin:0 0 12px;font-size:13px;color:#0088cc;letter-spacing:1px;text-transform:uppercase;font-weight:600;">⚡ What Happens Next</h2>
          ${shippingOption === 'stamp' ? `<ol style="margin:0;padding-left:20px;font-size:14px;color:#223355;line-height:1.8;">
            <li>🖨️ We print your custom licence sticker (2–3 business days).</li>
            <li>📮 We seal and stamp your envelope and drop it in the mail.</li>
            <li>📬 Keep an eye on your mailbox — stamp mail typically arrives in 3–5 business days.</li>
            <li>❓ Not arrived after 21 days? Email <a href="mailto:contact@creditcardart.com" style="color:#0055cc;">contact@creditcardart.com</a> and we'll sort it out.</li>
            <li>🏆 ${esc(petFull)} is the fastest animal in the neighborhood.</li>
          </ol>` : `<ol style="margin:0;padding-left:20px;font-size:14px;color:#223355;line-height:1.8;">
            <li>🖨️ We print your custom licence sticker (2–3 business days).</li>
            <li>📫 We carefully package it and ship it via your chosen method.</li>
            <li>📧 You get a follow-up email with tracking once it's in the mail.</li>
            <li>🏆 ${esc(petFull)} is the fastest animal in the neighborhood.</li>
          </ol>`}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
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

// ── Stamp-mail shipped (called when admin flips a stamp order to 'printed') ──
// Stamp orders have no tracking number, so this is a simpler "it's in the
// mailbox" note vs. the full tracking email used for Standard/Priority.
export async function sendStampShippedEmail(env, order) {
  const { orderId, customerEmail, petFirstName, petLastName } = order;
  if (!customerEmail) return { skipped: true, reason: 'no email' };

  const petFull = [petFirstName, petLastName].filter(Boolean).join(' ') || 'your pet';
  const subject = `📬 ${petFull}'s Pet Licence is in the mail!`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:32px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://pet-licence-factory.pages.dev/images/wordmark-email.png" alt="Pet Licence Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <img src="https://pet-licence-factory.pages.dev/images/rabbit-email.gif" width="80" height="80" alt="🐰" style="display:block;margin:0 auto 12px;image-rendering:pixelated;">
          <div style="font-size:32px;margin-bottom:8px;">📮</div>
          <h1 style="margin:0 0 8px;font-family:'Press Start 2P','Courier New',monospace;font-size:16px;color:#0077ff;letter-spacing:2px;text-transform:uppercase;">It's In The Mail!</h1>
          <p style="margin:8px 0 20px;font-size:15px;color:#334477;line-height:1.5;">
            ${esc(petFull)}'s licence is sealed, stamped, and on its way via USPS.
          </p>
          <div style="background:#f0f5ff;border:1px solid #0088cc;border-radius:4px;padding:16px;margin:16px 0;text-align:left;">
            <div style="font-size:11px;color:#5577aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Order</div>
            <div style="font-family:'Courier New',monospace;font-size:14px;color:#0055cc;word-break:break-all;">${esc(orderId || '—')}</div>
          </div>
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <div style="background:#f0f8ff;border:1px dashed #0099cc;border-radius:4px;padding:14px 18px;font-size:13px;color:#223355;line-height:1.6;">
            <strong style="color:#0099cc;">📬 No tracking number</strong> — stamp mail doesn't come with tracking. Most orders arrive in <strong>3–5 business days</strong>. If yours hasn't shown up after <strong>21 days</strong>, just reply to this email and we'll send a free replacement.
          </div>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
          Questions? Reply to this email any time.<br>
          <span style="opacity:.6;">Pet Licence Factory · Houston, TX</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`📮 ${petFull}'s Pet Licence is in the mail!

Order: ${orderId || '—'}

Stamp mail doesn't include a tracking number. Most orders arrive in 3–5 business days.
If yours hasn't shown up after 21 days, just reply to this email and we'll send a free replacement.

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
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:32px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://pet-licence-factory.pages.dev/images/wordmark-email.png" alt="Pet Licence Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <img src="https://pet-licence-factory.pages.dev/images/rabbit-email.gif" width="80" height="80" alt="🐰" style="display:block;margin:0 auto 12px;image-rendering:pixelated;">
          <div style="font-size:32px;margin-bottom:8px;">📬</div>
          <h1 style="margin:0 0 8px;font-family:'Press Start 2P','Courier New',monospace;font-size:16px;color:#0077ff;letter-spacing:2px;text-transform:uppercase;">Shipped!</h1>
          <p style="margin:8px 0 24px;font-size:15px;color:#334477;line-height:1.5;">
            ${esc(petFull)}'s licence just hit the mail stream.
          </p>
          <div style="background:#f0f5ff;border:1px solid #0088cc;border-radius:4px;padding:16px;margin:16px 0;text-align:left;">
            <div style="font-size:11px;color:#5577aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Tracking Number</div>
            <div style="font-family:'Courier New',monospace;font-size:15px;color:#0055cc;word-break:break-all;">${esc(trackingNumber)}</div>
            <div style="font-size:11px;color:#5577aa;text-transform:uppercase;letter-spacing:1px;margin:12px 0 4px;">Order</div>
            <div style="font-family:'Courier New',monospace;font-size:13px;color:#0055cc;">${esc(orderId || '—')}</div>
          </div>
          <a href="${esc(trackUrl)}" style="display:inline-block;margin-top:12px;padding:14px 28px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:14px;letter-spacing:1px;">Track Package →</a>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
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
