// ── Pet License Factory — SendGrid Email Helpers (Cloudflare) ────────────────
// Uses SendGrid v3 REST API via fetch. No Node SDK needed — works on the
// Workers runtime. Sends from `hello@petlicensefactory.com`, which is
// domain-authenticated (DKIM/SPF) in SendGrid for best inbox placement.
// Production overrides this via the SENDGRID_FROM_EMAIL env var.
// ---------------------------------------------------------------------------

import { LINE_SENDER } from './lines.js';
import { plcItem } from './pricing.js';

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

const DEFAULT_FROM_EMAIL = 'hello@petlicensefactory.com';
const DEFAULT_FROM_NAME  = 'Pet License Factory';
// Replies route here regardless of the from-address (so we can send from a
// branded @petlicensefactory.com address while replies still land in the
// monitored creditcardart inbox). Override per-send via the replyTo arg, or
// globally via the SENDGRID_REPLY_TO env var.
const DEFAULT_REPLY_TO   = 'contact@creditcardart.com';

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
// `attachments` (optional): array of SendGrid attachment objects, each
// { content (pure base64, no data: prefix), type, filename, disposition, content_id }.
// `sender` (optional, { name, email } from LINE_SENDER) overrides the from
// name + address for one send, so a product line mails from its own domain
// (the G.O.A.T. line sends as the Council from hello@goofylicenses.com).
export async function sendEmail(env, { to, subject, html, text, replyTo, sender, customArgs, attachments, asmGroupId, subscriptionTracking }) {
  const apiKey = env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn('[SendGrid] No SENDGRID_API_KEY set — skipping email to', to);
    return { skipped: true };
  }
  if (!to) {
    console.warn('[SendGrid] No recipient — skipping send');
    return { skipped: true };
  }

  const fromEmail = (sender && sender.email) || env.SENDGRID_FROM_EMAIL || DEFAULT_FROM_EMAIL;
  const fromName  = (sender && sender.name) || env.SENDGRID_FROM_NAME || DEFAULT_FROM_NAME;
  const replyEmail = replyTo || (sender && sender.email) || env.SENDGRID_REPLY_TO || DEFAULT_REPLY_TO;

  // custom_args are echoed back verbatim on every Event Webhook event, so we
  // tag each send with the order_id (+ email_type) to join events to orders.
  // SendGrid requires all custom_args values to be strings.
  const cleanArgs = {};
  for (const [k, v] of Object.entries(customArgs || {})) {
    if (v !== undefined && v !== null && v !== '') cleanArgs[k] = String(v);
  }
  const personalization = { to: [{ email: to }] };
  if (Object.keys(cleanArgs).length) personalization.custom_args = cleanArgs;

  const body = {
    personalizations: [personalization],
    from:     { email: fromEmail, name: fromName },
    reply_to: { email: replyEmail, name: fromName },
    subject,
    content: [
      ...(text ? [{ type: 'text/plain', value: text }] : []),
      { type: 'text/html', value: html },
    ],
  };

  if (Array.isArray(attachments) && attachments.length) {
    body.attachments = attachments;
  }

  // CAN-SPAM unsubscribe. Prefer a real ASM group (one-click, honored by
  // SendGrid); otherwise enable subscription tracking, which swaps the
  // "[unsubscribe]" token in the body for a working unsubscribe URL.
  if (asmGroupId) {
    body.asm = { group_id: asmGroupId };
  } else if (subscriptionTracking) {
    body.tracking_settings = {
      subscription_tracking: {
        enable: true,
        substitution_tag: '[unsubscribe]',
      },
    };
  }

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
  return { success: true, messageId: resp.headers.get('X-Message-Id') || null };
}

// ── Order confirmation email ────────────────────────────────────────────────
// Called from the Stripe webhook after checkout.session.completed.
// Keeps inline styles only (no external CSS) — email clients strip <style>.
export async function sendOrderConfirmationEmail(env, order) {
  const {
    orderId, customerEmail, customerName,
    petFirstName, petLastName,
    packCount, format, addOn, chipSize,
    shippingOption, total,
    shipAddrLine1, shipAddrLine2, shipCity, shipState, shipZip, shipCountry,
  } = order;

  if (!customerEmail) return { skipped: true, reason: 'no email' };
  const item = plcItem(format, packCount);   // skin | card | bundle

  const petFull = [petFirstName, petLastName].filter(Boolean).join(' ') || 'your pet';
  const shipLabel = ({
    stamp:    'Stamp Mail (USPS)',
    standard: 'Standard Shipping (7–14 business days)',
    priority: 'Priority Shipping (3–5 business days)',
  })[shippingOption] || 'Standard Shipping';
  const packLabel = item.label + (addOn === 'car_decal' ? ' + Car Decal' : '');
  const printWhat = ({ skin: 'sticker', card: 'card', bundle: 'sticker and card' })[item.format];

  const addrParts = [shipAddrLine1, shipAddrLine2, [shipCity, shipState, shipZip].filter(Boolean).join(', '), shipCountry]
    .filter(Boolean).join('<br>');

  const subject = `🐾 Order confirmed — ${petFull}'s Pet License is being processed!`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">

        <!-- Header -->
        <tr><td style="padding:32px 32px 16px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <img src="https://petlicensefactory.com/images/rabbit-email.gif" width="80" height="80" alt="🐰" style="display:block;margin:0 auto 12px;image-rendering:pixelated;">
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
            ${item.format === 'card' ? '' : `<tr><td style="padding:6px 0;border-bottom:1px dashed rgba(0,102,255,.15);">Chip Size</td><td style="padding:6px 0;text-align:right;border-bottom:1px dashed rgba(0,102,255,.15);color:#0099cc;">${esc((chipSize || 'mini').charAt(0).toUpperCase() + (chipSize || 'mini').slice(1))}</td></tr>`}
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
            <div style="font-size:13px;color:#223355;line-height:1.6;">Your order ships via USPS stamp mail. There's no tracking number with this option. If your license hasn't arrived after <strong style="color:#0099cc;">21 days</strong> (most orders arrive in 3–5 days), email us at <a href="mailto:contact@creditcardart.com" style="color:#0055cc;">contact@creditcardart.com</a> and we'll make it right — free replacement included.</div>
          </div>
        </td></tr>` : ''}

        <!-- What's next -->
        <tr><td style="padding:16px 32px 24px;">
          <h2 style="margin:0 0 12px;font-size:13px;color:#0088cc;letter-spacing:1px;text-transform:uppercase;font-weight:600;">⚡ What Happens Next</h2>
          ${shippingOption === 'stamp' ? `<ol style="margin:0;padding-left:20px;font-size:14px;color:#223355;line-height:1.8;">
            <li>🖨️ We print your custom license ${printWhat} (2–3 business days).</li>
            <li>📮 We seal and stamp your envelope and drop it in the mail.</li>
            <li>📬 Keep an eye on your mailbox — stamp mail typically arrives in 3–5 business days.</li>
            <li>❓ Not arrived after 21 days? Email <a href="mailto:contact@creditcardart.com" style="color:#0055cc;">contact@creditcardart.com</a> and we'll sort it out.</li>
            <li>🏆 ${esc(petFull)} is the fastest animal in the neighborhood.</li>
          </ol>` : `<ol style="margin:0;padding-left:20px;font-size:14px;color:#223355;line-height:1.8;">
            <li>🖨️ We print your custom license ${printWhat} (2–3 business days).</li>
            <li>📫 We carefully package it and ship it via your chosen method.</li>
            <li>📧 You get a follow-up email with tracking once it's in the mail.</li>
            <li>🏆 ${esc(petFull)} is the fastest animal in the neighborhood.</li>
          </ol>`}
        </td></tr>

        <!-- Show off your pet (UGC / Instagram feature) -->
        <tr><td style="padding:0 32px 24px;">
          <div style="background:#f0f5ff;border:1px dashed #0088cc;border-radius:6px;padding:18px 20px;text-align:center;">
            <div style="font-size:13px;color:#0077ff;font-weight:700;margin-bottom:8px;">📸 Show off ${esc(petFull)}!</div>
            <p style="margin:0 0 12px;font-size:13px;color:#334477;line-height:1.6;">
              When ${esc(petFull)}'s license arrives, snap a photo of your pet with it and send it to us in a DM on Instagram. We post our favourites on our page (with a shout-out to you), so don't be shy!
            </p>
            <a href="https://www.instagram.com/petlicensefactory/" style="display:inline-block;padding:12px 22px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:13px;letter-spacing:1px;">DM us @petlicensefactory →</a>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
          Questions? Just reply to this email — we read every message.<br>
          <span style="opacity:.6;">Pet License Factory · 7900 Cambridge St, Apt 28-1G · Houston, TX 77054</span>
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
${item.format === 'card' ? '' : `Chip:     ${chipSize || 'mini'}\n`}Shipping: ${shipLabel}
Total:    ${total || '—'}

${addrParts ? `Shipping to:\n${customerName ? customerName + '\n' : ''}${[shipAddrLine1, shipAddrLine2, [shipCity, shipState, shipZip].filter(Boolean).join(', '), shipCountry].filter(Boolean).join('\n')}\n\n` : ''}Next up: we'll print ${petFull}'s license, package it with care, and ship it your way. You'll get a tracking email once it's out the door.

📸 Show off ${petFull}! When the license arrives, snap a photo of your pet with it and DM it to us on Instagram @petlicensefactory. We post our favourites on our page (with a shout-out to you).

Questions? Just reply to this email.

— Pet License Factory`;

  return sendEmail(env, { to: customerEmail, subject, html, text, customArgs: { order_id: orderId, email_type: 'confirmation' } });
}

// ── G.O.A.T. email look (shared) ────────────────────────────────────────────
// Matches the goofylicenses.com/goat site and its success page: cream paper,
// a white rounded card, Cinzel headings in Council gold, Inter body, the cream
// filing-number box and the yellow button. Cinzel/Inter load where the mail
// client allows web fonts (Apple Mail, iOS); elsewhere Georgia / system sans.
const GOAT_EMAIL = {
  bg: '#f4efe3', card: '#ffffff', line: '#e4d9bf', ink: '#2b2118', muted: '#7c7264',
  gold: '#a86e0a', filing: '#faf5ea', btn: '#f5c542', btnInk: '#2a1a05', btnShadow: '#c8920f',
  serif: "'Cinzel',Georgia,'Times New Roman',serif",
  sans: "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif",
};
function goatOrigin(env) {
  return ((env && env.GOOFY_ORIGIN) || 'https://goofylicenses.com').replace(/\/+$/, '');
}
function goatH2(text) {
  const E = GOAT_EMAIL;
  return `<div style="margin:0 0 10px;font-family:${E.sans};font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${E.gold};">${text}</div>`;
}
function goatRow(label, value, opts = {}) {
  const E = GOAT_EMAIL;
  return `<tr>
          <td style="padding:9px 0;border-bottom:1px solid ${E.line};font-size:14px;color:${E.muted};">${label}</td>
          <td style="padding:9px 0;border-bottom:1px solid ${E.line};font-size:14px;color:${E.ink};text-align:right;${opts.mono ? "font-family:'Courier New',monospace;" : ''}${opts.bold ? 'font-weight:700;' : ''}">${opts.html ? value : esc(value)}</td>
        </tr>`;
}
function goatButton(href, label) {
  const E = GOAT_EMAIL;
  return `<a href="${esc(href)}" style="display:inline-block;background:${E.btn};color:${E.btnInk};text-decoration:none;font-family:${E.sans};font-weight:800;font-size:15px;padding:14px 28px;border-radius:12px;border-bottom:4px solid ${E.btnShadow};">${label}</a>`;
}
// title: the gold Cinzel headline. lead: one line under it (HTML-escaped by
// the caller). sections: HTML rows. footer: extra footer HTML.
function goatEmailShell(env, { subject, preheader, title, lead, sections, footer }) {
  const E = GOAT_EMAIL, origin = goatOrigin(env);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&family=Inter:wght@400;600;800&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${E.bg};font-family:${E.sans};color:${E.ink};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${E.bg};padding:26px 0;">
    <tr><td align="center" style="padding:0 12px;">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 6px 16px;text-align:left;">
          <div style="font-family:${E.serif};font-weight:700;font-size:14px;letter-spacing:2px;color:${E.gold};">🐐 GOOFY LICENSES</div>
          <div style="font-family:${E.sans};font-weight:700;font-size:10px;letter-spacing:3px;color:${E.muted};margin-top:2px;">THE COUNCIL OF G.O.A.T. AFFAIRS</div>
        </td></tr>
      </table>
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:${E.card};border:1px solid ${E.line};border-radius:18px;">
        <tr><td style="padding:34px 36px 6px;text-align:center;">
          <img src="${esc(origin)}/goofy/images/seal-email.png" width="88" height="88" alt="Certified G.O.A.T. seal" style="display:block;margin:0 auto 16px;border:0;">
          <h1 style="margin:0;font-family:${E.serif};font-weight:700;font-size:25px;line-height:1.35;letter-spacing:1.5px;color:${E.gold};">${title}</h1>
          ${lead ? `<p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:${E.muted};">${lead}</p>` : ''}
        </td></tr>
        ${sections}
        <tr><td style="padding:0 0 30px;"></td></tr>
      </table>
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:18px 20px;text-align:center;font-size:12px;line-height:1.7;color:${E.muted};">
          Questions? Reply to this email, a clerk reads every message.<br>
          Goofy Licenses makes novelty gag licenses for entertainment. Not a real government document.
          ${footer || ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
function goatFilingBox(orderId) {
  const E = GOAT_EMAIL;
  return `<tr><td style="padding:22px 36px 6px;">
          <div style="background:${E.filing};border:1px solid ${E.line};border-radius:10px;padding:13px 16px;text-align:center;">
            <div style="font-size:10px;font-weight:700;letter-spacing:2px;color:${E.muted};">COUNCIL FILING NUMBER</div>
            <div style="font-family:'Courier New',monospace;font-size:14px;color:${E.gold};margin-top:4px;word-break:break-all;">${esc(orderId || '—')}</div>
          </div>
        </td></tr>`;
}

// ── Goofy Licenses nomination confirmation email ────────────────────────────
// Called from the Stripe webhook (and update-address) when a GOOFY order is
// finalised. Council bureaucracy framing; every price is a processing fee.
// This is a separate template so a nominator NEVER receives pet-license copy.
// Goes to the NOMINATOR; the kit goes to the nominee.
export async function sendGoofyConfirmationEmail(env, order) {
  const {
    orderId, customerEmail,
    recipientName, giverName, variant, recipientCount,
    shippingOption, total,
    shipAddrLine1, shipAddrLine2, shipCity, shipState, shipZip, shipCountry,
  } = order;

  if (!customerEmail) return { skipped: true, reason: 'no email' };

  const nominee = recipientName || 'your nominee';
  const count = Math.max(1, parseInt(recipientCount) || 1);
  const party = count > 1 ? `${nominee} (+${count - 1} more)` : nominee;
  const honorLabel = ({
    'standard':     'G.O.A.T. License, Standard',
    'custom-giver': 'G.O.A.T. License, Custom (with giver credit)',
    'custom-anon':  'G.O.A.T. License, Custom (anonymous)',
  })[variant] || 'G.O.A.T. License';
  const shipLabel = ({
    stamp:    'Stamp mail (USPS)',
    standard: 'Standard, tracked',
    priority: 'Priority, tracked',
  })[shippingOption] || 'USPS mail';
  const presentedBy = variant === 'custom-giver' && giverName
    ? `Presented by ${giverName}`
    : variant === 'custom-anon' ? 'Anonymous (your name is not on it)' : 'Filed by the Council';

  // The kit goes to the nominee, so their name heads the address (not the
  // buyer's name from the card).
  const cityLine = [shipCity, [shipState, shipZip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const addrLines = [party, shipAddrLine1, shipAddrLine2, cityLine, shipCountry && shipCountry !== 'US' ? shipCountry : '']
    .filter(Boolean);
  const hasAddr = !!(shipAddrLine1 || cityLine);

  const subject = `🐐 Nomination filed: ${party}'s G.O.A.T. License`;
  const E = GOAT_EMAIL;

  const html = goatEmailShell(env, {
    subject,
    preheader: `The Council has accepted your nomination of ${party}.`,
    title: 'Nomination Filed! ★',
    lead: `The Council has accepted your nomination. The certified <b style="color:${E.ink};">G.O.A.T. license kit</b> will be printed, sealed, and mailed to ${esc(party)}.`,
    sections: `
        ${goatFilingBox(orderId)}
        <tr><td style="padding:22px 36px 4px;">
          ${goatH2('🧾 Nomination summary')}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
          ${goatRow('Honor', honorLabel)}
          ${goatRow('Nominee', party)}
          ${goatRow('Credit', presentedBy)}
          ${goatRow('Delivery', shipLabel)}
          <tr>
            <td style="padding:12px 0 0;font-size:15px;font-weight:800;color:${E.ink};">Processing fee</td>
            <td style="padding:12px 0 0;text-align:right;font-family:${E.serif};font-size:18px;font-weight:700;color:${E.gold};">${esc(total || '—')}</td>
          </tr>
          </table>
        </td></tr>
        ${hasAddr ? `<tr><td style="padding:22px 36px 4px;">
          ${goatH2('📮 Kit mails to')}
          <div style="background:${E.filing};border-left:3px solid ${E.gold};border-radius:6px;padding:12px 16px;font-size:14px;line-height:1.7;color:${E.ink};">
            <b>${esc(addrLines[0])}</b><br>${addrLines.slice(1).map(esc).join('<br>')}
          </div>
        </td></tr>` : ''}
        <tr><td style="padding:22px 36px 4px;">
          ${goatH2('⚡ What happens next')}
          <ol style="margin:0;padding-left:20px;font-size:14px;line-height:2;color:${E.muted};">
            <li>The Council prints the certified license <b style="color:${E.ink};">(2–3 business days)</b>.</li>
            <li>The kit is sealed, stamped, and mailed to <b style="color:${E.ink};">${esc(party)}</b>.</li>
          </ol>
        </td></tr>`,
  });

  const text =
`Nomination filed! 🐐

The Council has accepted your nomination. The certified G.O.A.T. license kit will be printed, sealed, and mailed to ${party}.

Council filing number: ${orderId || '—'}
Honor:    ${honorLabel}
Nominee:  ${party}
Credit:   ${presentedBy}
Delivery: ${shipLabel}
Processing fee: ${total || '—'}

${hasAddr ? `Kit mails to:\n${addrLines.join('\n')}\n\n` : ''}What happens next:
1. The Council prints the certified license (2–3 business days).
2. The kit is sealed, stamped, and mailed to ${party}.

Questions? Just reply to this email.

The Council of G.O.A.T. Affairs (Goofy Licenses)`;

  return sendEmail(env, { to: customerEmail, subject, html, text, sender: LINE_SENDER.goat, customArgs: { order_id: orderId, email_type: 'goofy_confirmation' } });
}

// ── Stamp-mail shipped (called when admin flips a stamp order to 'printed') ──
// Stamp orders have no tracking number, so this is a simpler "it's in the
// mailbox" note vs. the full tracking email used for Standard/Priority.
export async function sendStampShippedEmail(env, order) {
  const { orderId, customerEmail, petFirstName, petLastName } = order;
  if (!customerEmail) return { skipped: true, reason: 'no email' };

  const petFull = [petFirstName, petLastName].filter(Boolean).join(' ') || 'your pet';
  const subject = `📬 ${petFull}'s Pet License is in the mail!`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:32px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <img src="https://petlicensefactory.com/images/rabbit-email.gif" width="80" height="80" alt="🐰" style="display:block;margin:0 auto 12px;image-rendering:pixelated;">
          <div style="font-size:32px;margin-bottom:8px;">📮</div>
          <h1 style="margin:0 0 8px;font-family:'Press Start 2P','Courier New',monospace;font-size:16px;color:#0077ff;letter-spacing:2px;text-transform:uppercase;">It's In The Mail!</h1>
          <p style="margin:8px 0 20px;font-size:15px;color:#334477;line-height:1.5;">
            ${esc(petFull)}'s license is sealed, stamped, and on its way via USPS.
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

        <!-- Show off your pet (UGC / Instagram feature) -->
        <tr><td style="padding:0 32px 24px;">
          <div style="background:#f0f5ff;border:1px dashed #0088cc;border-radius:6px;padding:18px 20px;text-align:center;">
            <div style="font-size:13px;color:#0077ff;font-weight:700;margin-bottom:8px;">📸 Show off ${esc(petFull)}!</div>
            <p style="margin:0 0 12px;font-size:13px;color:#334477;line-height:1.6;">
              When ${esc(petFull)}'s license arrives, snap a photo of your pet with it and send it to us in a DM on Instagram. We post our favourites on our page (with a shout-out to you), so don't be shy!
            </p>
            <a href="https://www.instagram.com/petlicensefactory/" style="display:inline-block;padding:12px 22px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:13px;letter-spacing:1px;">DM us @petlicensefactory →</a>
          </div>
        </td></tr>

        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
          Questions? Reply to this email any time.<br>
          <span style="opacity:.6;">Pet License Factory · Houston, TX</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`📮 ${petFull}'s Pet License is in the mail!

Order: ${orderId || '—'}

Stamp mail doesn't include a tracking number. Most orders arrive in 3–5 business days.
If yours hasn't shown up after 21 days, just reply to this email and we'll send a free replacement.

📸 Show off ${petFull}! When the license arrives, snap a photo of your pet with it and DM it to us on Instagram @petlicensefactory. We post our favourites on our page (with a shout-out to you).

— Pet License Factory`;

  return sendEmail(env, { to: customerEmail, subject, html, text, customArgs: { order_id: orderId, email_type: 'stamp_shipped' } });
}

// ── Address-issue email (called from webhook when USPS verification fails) ──
// Sent when the customer's auth went through but the address couldn't be
// verified. The customer hasn't been charged — the auth is held for ~7 days.
// Email gives them a link back to the success page where they can fix it.
export async function sendAddressIssueEmail(env, order) {
  const { orderId, customerEmail, petFirstName, petLastName, sessionId, reason, siteOrigin } = order;
  if (!customerEmail) return { skipped: true, reason: 'no email' };

  const petFull = [petFirstName, petLastName].filter(Boolean).join(' ') || 'your pet';
  const fixUrl  = `${siteOrigin || 'https://petlicensefactory.com'}/success.html?session_id=${encodeURIComponent(sessionId || '')}&order_id=${encodeURIComponent(orderId || '')}`;
  const subject = `⚠️ We couldn't verify your shipping address for ${petFull}'s license`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #e0a800;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:32px;text-align:center;background:linear-gradient(180deg,#fff8e1 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
          <h1 style="margin:0 0 8px;font-family:'Press Start 2P','Courier New',monospace;font-size:14px;color:#a86c00;letter-spacing:2px;text-transform:uppercase;line-height:1.5;">Address Couldn't Be<br>Verified</h1>
          <p style="margin:14px 0 4px;font-size:15px;color:#334477;line-height:1.5;">
            Good news first: <strong>you have not been charged.</strong>
          </p>
          <p style="margin:8px 0 20px;font-size:14px;color:#334477;line-height:1.5;">
            We tried to verify your shipping address with USPS for ${esc(petFull)}'s license, but it didn't come back as deliverable. We've put the payment on hold so we don't ship to a bad address.
          </p>
        </td></tr>
        <tr><td style="padding:0 32px 8px;">
          <div style="background:#fff8e1;border:1px dashed #e0a800;border-radius:4px;padding:14px 18px;">
            <div style="font-size:11px;color:#a86c00;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">USPS said:</div>
            <div style="font-size:13px;color:#5a4a00;line-height:1.5;font-family:'Courier New',monospace;">${esc(reason || 'Address could not be verified.')}</div>
          </div>
        </td></tr>
        <tr><td style="padding:20px 32px 8px;text-align:center;">
          <a href="${esc(fixUrl)}" style="display:inline-block;padding:14px 28px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:14px;letter-spacing:1px;">Fix My Address →</a>
          <p style="margin:14px 0 0;font-size:12px;color:#6688aa;line-height:1.5;">
            The link above takes you back to your order. Update the address there and we'll re-verify it instantly. Once it passes, your card is charged and we get to printing.
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px;">
          <div style="background:#f0f5ff;border:1px solid #0088cc;border-radius:4px;padding:14px 18px;">
            <div style="font-size:11px;color:#5577aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Order</div>
            <div style="font-family:'Courier New',monospace;font-size:14px;color:#0055cc;word-break:break-all;">${esc(orderId || '—')}</div>
          </div>
        </td></tr>
        <tr><td style="padding:0 32px 24px;font-size:13px;color:#334477;line-height:1.6;">
          If you don't fix the address within 7 days, the card hold drops automatically and no charge is made. You can also just reply to this email and we'll sort it out manually.
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
          Need help? Reply to this email any time.<br>
          <span style="opacity:.6;">Pet License Factory · Houston, TX</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`⚠️ We couldn't verify your shipping address for ${petFull}'s license.

Good news first: you have NOT been charged.

USPS said: ${reason || 'Address could not be verified.'}

Fix it here: ${fixUrl}

Order: ${orderId || '—'}

If you don't fix the address within 7 days, the card hold drops automatically and no charge is made. You can also just reply to this email and we'll sort it out manually.

— Pet License Factory`;

  return sendEmail(env, { to: customerEmail, subject, html, text, customArgs: { order_id: orderId, email_type: 'address_issue' } });
}

// ── Shipping notification (called when admin sets tracking number) ──────────
export async function sendShippingNotificationEmail(env, order) {
  const { orderId, customerEmail, customerName, petFirstName, petLastName, trackingNumber, shippingOption } = order;
  if (!customerEmail || !trackingNumber) return { skipped: true };

  const petFull = [petFirstName, petLastName].filter(Boolean).join(' ') || 'your pet';
  const subject = `📬 ${petFull}'s Pet License is on the way!`;

  // USPS tracking URL (works for stamp/standard/priority — all USPS)
  const trackUrl = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:32px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <img src="https://petlicensefactory.com/images/rabbit-email.gif" width="80" height="80" alt="🐰" style="display:block;margin:0 auto 12px;image-rendering:pixelated;">
          <div style="font-size:32px;margin-bottom:8px;">📬</div>
          <h1 style="margin:0 0 8px;font-family:'Press Start 2P','Courier New',monospace;font-size:16px;color:#0077ff;letter-spacing:2px;text-transform:uppercase;">Shipped!</h1>
          <p style="margin:8px 0 24px;font-size:15px;color:#334477;line-height:1.5;">
            ${esc(petFull)}'s license just hit the mail stream.
          </p>
          <div style="background:#f0f5ff;border:1px solid #0088cc;border-radius:4px;padding:16px;margin:16px 0;text-align:left;">
            <div style="font-size:11px;color:#5577aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Tracking Number</div>
            <div style="font-family:'Courier New',monospace;font-size:15px;color:#0055cc;word-break:break-all;">${esc(trackingNumber)}</div>
            <div style="font-size:11px;color:#5577aa;text-transform:uppercase;letter-spacing:1px;margin:12px 0 4px;">Order</div>
            <div style="font-family:'Courier New',monospace;font-size:13px;color:#0055cc;">${esc(orderId || '—')}</div>
          </div>
          <a href="${esc(trackUrl)}" style="display:inline-block;margin-top:12px;padding:14px 28px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:14px;letter-spacing:1px;">Track Package →</a>
        </td></tr>

        <!-- Show off your pet (UGC / Instagram feature) -->
        <tr><td style="padding:0 32px 24px;">
          <div style="background:#f0f5ff;border:1px dashed #0088cc;border-radius:6px;padding:18px 20px;text-align:center;">
            <div style="font-size:13px;color:#0077ff;font-weight:700;margin-bottom:8px;">📸 Show off ${esc(petFull)}!</div>
            <p style="margin:0 0 12px;font-size:13px;color:#334477;line-height:1.6;">
              When ${esc(petFull)}'s license arrives, snap a photo of your pet with it and send it to us in a DM on Instagram. We post our favourites on our page (with a shout-out to you), so don't be shy!
            </p>
            <a href="https://www.instagram.com/petlicensefactory/" style="display:inline-block;padding:12px 22px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:13px;letter-spacing:1px;">DM us @petlicensefactory →</a>
          </div>
        </td></tr>

        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
          Questions? Reply to this email any time.<br>
          <span style="opacity:.6;">Pet License Factory · Houston, TX</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`📬 ${petFull}'s Pet License is on the way!

Tracking: ${trackingNumber}
Order:    ${orderId || '—'}
Track it: ${trackUrl}

📸 Show off ${petFull}! When the license arrives, snap a photo of your pet with it and DM it to us on Instagram @petlicensefactory. We post our favourites on our page (with a shout-out to you).

— Pet License Factory`;

  return sendEmail(env, { to: customerEmail, subject, html, text, customArgs: { order_id: orderId, email_type: 'shipping' } });
}

// ── Free digital licence (email-capture freebie) ────────────────────────────
// Sent from the homepage builder when a visitor asks for a free watermarked
// digital version of their pet's licence. The licence image rides along as an
// inline attachment (content_id "licence") so it renders in the body AND is
// downloadable. Copy is warm and free of em dashes (owner's style rule).
export async function sendFreeLicenceEmail(env, { to, petName, imageBase64, mimeType, filename }) {
  if (!to) return { skipped: true, reason: 'no email' };

  const pet = (petName || '').trim() || 'your pet';
  const orderUrl = 'https://petlicensefactory.com/?utm_source=email&utm_medium=freebie&utm_campaign=digital_licence';
  const subject = `🐾 ${pet}'s official licence is here`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fbf7f0;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #ff6f4d;border-radius:14px;overflow:hidden;">

        <tr><td style="padding:30px 32px 12px;text-align:center;background:linear-gradient(180deg,#fff1ec 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="380" style="display:block;margin:0 auto 16px;max-width:78%;height:auto;image-rendering:pixelated;">
          <h1 style="margin:0;font-family:'Press Start 2P','Courier New',monospace;font-size:15px;color:#ec5a38;letter-spacing:2px;text-transform:uppercase;line-height:1.6;">${esc(pet)}'s Licence</h1>
          <p style="margin:12px 0 0;font-size:15px;color:#5a5148;line-height:1.6;">
            Here it is, straight off the press. Your free digital copy is attached below. Show it off, share it, give ${esc(pet)} the recognition they deserve.
          </p>
        </td></tr>

        <!-- The licence itself (inline attachment via cid) -->
        <tr><td style="padding:20px 32px 8px;text-align:center;">
          <img src="cid:licence" alt="${esc(pet)}'s pet licence" width="480" style="display:block;margin:0 auto;max-width:100%;height:auto;border-radius:10px;border:1px solid #ece7dd;">
        </td></tr>

        <tr><td style="padding:8px 32px 4px;text-align:center;">
          <p style="margin:0;font-size:13px;color:#9aa0ab;line-height:1.5;">This one has a small "not a government document" line printed on it. Want the real thing?</p>
        </td></tr>

        <!-- Order the physical card -->
        <tr><td style="padding:16px 32px 8px;">
          <div style="background:#fff1ec;border:1px dashed #ff6f4d;border-radius:10px;padding:20px;text-align:center;">
            <div style="font-size:15px;color:#ec5a38;font-weight:800;margin-bottom:8px;">🎁 Get the real card skin</div>
            <p style="margin:0 0 14px;font-size:14px;color:#5a5148;line-height:1.6;">
              We print ${esc(pet)}'s licence as a premium sticker that fits right over a real credit or debit card, then ship it to your door. No watermark, just the good stuff.
            </p>
            <a href="${esc(orderUrl)}" style="display:inline-block;padding:13px 26px;background:#ff6f4d;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:14px;letter-spacing:.5px;">Order ${esc(pet)}'s card →</a>
          </div>
        </td></tr>

        <tr><td style="padding:20px 32px;text-align:center;font-size:12px;color:#9aa0ab;line-height:1.6;border-top:1px solid #ece7dd;">
          You asked us to email ${esc(pet)}'s licence, so here we are. Reply any time, a real human reads these.<br>
          <span style="opacity:.7;">Pet License Factory · Novelty pet ID art · Not a real government document.</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`${pet}'s licence is here! 🐾

Your free digital copy is attached to this email. Show it off, share it, and give ${pet} the recognition they deserve.

Want the real thing? We print ${pet}'s licence as a premium sticker that fits over a real credit or debit card and ship it to your door, no watermark:
${orderUrl}

You asked us to email ${pet}'s licence, so here we are. Reply any time, a real human reads these.

— Pet License Factory`;

  const type = mimeType || 'image/jpeg';
  const ext = type === 'image/webp' ? 'webp' : (type === 'image/png' ? 'png' : 'jpg');
  const attachments = imageBase64 ? [{
    content: imageBase64,
    type,
    filename: filename || `${pet.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'pet'}-licence.${ext}`,
    disposition: 'inline',
    content_id: 'licence',
  }] : undefined;

  return sendEmail(env, {
    to, subject, html, text, attachments,
    customArgs: { email_type: 'free_licence' },
  });
}

// ── Card-abandonment nudge (2–72h after a free-licence capture) ─────────────
// Sent by the /api/send-abandonment cron to leads who grabbed the free digital
// licence but never bought the physical card skin. Re-attaches their own
// rendered licence (inline via cid "licence") and offers 15% off. One send per
// lead, ever. Copy is warm, short, and free of em dashes (owner's style rule).
// CAN-SPAM: physical-address footer + a working unsubscribe link.
export async function sendAbandonmentEmail(env, { to, petName, imageBase64, mimeType, filename, leadId }) {
  if (!to) return { skipped: true, reason: 'no email' };

  const pet = (petName || '').trim();
  const petLabel = pet || 'your pet';
  const ctaUrl = 'https://petlicensefactory.com/?disc=1&utm_source=email&utm_medium=abandon&utm_campaign=card_abandon';
  const subject = pet
    ? `${pet}'s licence is one click from real`
    : `Your pet's licence is still waiting`;

  // Unsubscribe: prefer a real SendGrid ASM group (one-click, honored by
  // SendGrid) when one is configured; otherwise fall back to SendGrid's
  // subscription-tracking [unsubscribe] substitution injected below.
  const asmGroupId = env.SENDGRID_ASM_GROUP_ID ? parseInt(env.SENDGRID_ASM_GROUP_ID, 10) : null;
  // ASM groups expose a raw-URL substitution tag; the subscription-tracking
  // fallback replaces a plain "[unsubscribe]" token wherever it appears.
  const unsubHref = asmGroupId ? '<%asm_group_unsubscribe_raw_url%>' : '[unsubscribe]';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fbf7f0;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #ff6f4d;border-radius:14px;overflow:hidden;">

        <tr><td style="padding:30px 32px 12px;text-align:center;background:linear-gradient(180deg,#fff1ec 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="380" style="display:block;margin:0 auto 16px;max-width:78%;height:auto;image-rendering:pixelated;">
          <h1 style="margin:0;font-family:'Press Start 2P','Courier New',monospace;font-size:15px;color:#ec5a38;letter-spacing:2px;text-transform:uppercase;line-height:1.6;">${esc(petLabel)}'s Licence</h1>
          <p style="margin:12px 0 0;font-size:15px;color:#5a5148;line-height:1.6;">
            You built ${esc(petLabel)}'s licence the other day, here it is again. It came out great, so we saved you a spot.
          </p>
        </td></tr>

        <!-- Their own licence (inline attachment via cid) -->
        <tr><td style="padding:20px 32px 8px;text-align:center;">
          <img src="cid:licence" alt="${esc(petLabel)}'s pet licence" width="480" style="display:block;margin:0 auto;max-width:100%;height:auto;border-radius:10px;border:1px solid #ece7dd;">
        </td></tr>

        <!-- Offer + CTA -->
        <tr><td style="padding:16px 32px 8px;">
          <div style="background:#fff1ec;border:1px dashed #ff6f4d;border-radius:10px;padding:20px;text-align:center;">
            <div style="font-size:15px;color:#ec5a38;font-weight:800;margin-bottom:8px;">🎁 Here is 15% off your first order</div>
            <p style="margin:0 0 14px;font-size:14px;color:#5a5148;line-height:1.6;">
              We print ${esc(petLabel)}'s licence as a premium sticker that fits right over a real credit or debit card, then ship it to your door (no watermark, just the good stuff). Your 15% first-timer discount is ready to go.
            </p>
            <a href="${esc(ctaUrl)}" style="display:inline-block;padding:14px 28px;background:#ff6f4d;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:15px;letter-spacing:.5px;">Get ${esc(petLabel)}'s real card, 15% off →</a>
          </div>
        </td></tr>

        <tr><td style="padding:20px 32px;text-align:center;font-size:12px;color:#9aa0ab;line-height:1.6;border-top:1px solid #ece7dd;">
          You are getting this because you asked us to email ${esc(petLabel)}'s free licence. Reply any time, a real human reads these.<br>
          <span style="opacity:.7;">Pet License Factory · 7900 Cambridge St, Apt 28-1G · Houston, TX 77054</span><br>
          <a href="${unsubHref}" style="color:#9aa0ab;text-decoration:underline;">Unsubscribe</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`${petLabel}'s licence is one click from real.

You built ${petLabel}'s licence the other day, here it is again (attached). It came out great, so we saved you a spot.

Here is 15% off your first order: we print ${petLabel}'s licence as a premium sticker that fits over a real credit or debit card and ship it to your door, no watermark. Your 15% first-timer discount is ready:
${ctaUrl}

You are getting this because you asked us to email ${petLabel}'s free licence. Reply any time, a real human reads these.

Pet License Factory · 7900 Cambridge St, Apt 28-1G · Houston, TX 77054
Unsubscribe: ${unsubHref}

— Pet License Factory`;

  const type = mimeType || 'image/png';
  const ext = type === 'image/webp' ? 'webp' : (type === 'image/jpeg' ? 'jpg' : 'png');
  const attachments = imageBase64 ? [{
    content: imageBase64,
    type,
    filename: filename || `${petLabel.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'pet'}-licence.${ext}`,
    disposition: 'inline',
    content_id: 'licence',
  }] : undefined;

  return sendEmail(env, {
    to, subject, html, text, attachments,
    customArgs: { email_type: 'abandon', lead_id: leadId },
    asmGroupId,
    subscriptionTracking: !asmGroupId,
  });
}

// ── Abandoned Stripe-checkout recovery ──────────────────────────────────────
// Sent by stripe-webhook.js when a Checkout Session expires unpaid AND Stripe
// captured an email before the customer bailed. The recoveryUrl is Stripe's
// own 30-day cart-recovery link (restores the exact session, promo box and
// all). One send per order, enforced by pet_orders.recovery_email_sent_at.
export async function sendCheckoutRecoveryEmail(env, { to, petName, recoveryUrl, orderId }) {
  if (!to || !recoveryUrl) return { skipped: true, reason: 'missing email or url' };

  const pet = (petName || '').trim();
  const petLabel = pet || 'your pet';
  const subject = pet
    ? `${pet}'s licence is still in your cart`
    : `Your pet's licence is still in your cart`;

  const asmGroupId = env.SENDGRID_ASM_GROUP_ID ? parseInt(env.SENDGRID_ASM_GROUP_ID, 10) : null;
  const unsubHref = asmGroupId ? '<%asm_group_unsubscribe_raw_url%>' : '[unsubscribe]';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fbf7f0;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #ff6f4d;border-radius:14px;overflow:hidden;">

        <tr><td style="padding:30px 32px 12px;text-align:center;background:linear-gradient(180deg,#fff1ec 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="380" style="display:block;margin:0 auto 16px;max-width:78%;height:auto;image-rendering:pixelated;">
          <h1 style="margin:0;font-family:'Press Start 2P','Courier New',monospace;font-size:15px;color:#ec5a38;letter-spacing:2px;text-transform:uppercase;line-height:1.6;">Almost at the printer</h1>
          <p style="margin:12px 0 0;font-size:15px;color:#5a5148;line-height:1.6;">
            You built ${esc(petLabel)}'s licence and made it all the way to checkout, then life happened. No worries: we saved your cart exactly as you left it.
          </p>
        </td></tr>

        <tr><td style="padding:20px 32px 8px;">
          <div style="background:#fff1ec;border:1px dashed #ff6f4d;border-radius:10px;padding:20px;text-align:center;">
            <p style="margin:0 0 14px;font-size:14px;color:#5a5148;line-height:1.6;">
              One click below takes you straight back to the payment page with everything already filled in. The link works for 30 days, but ${esc(petLabel)} would prefer sooner.
            </p>
            <a href="${esc(recoveryUrl)}" style="display:inline-block;padding:14px 28px;background:#ff6f4d;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:15px;letter-spacing:.5px;">Finish ${esc(petLabel)}'s order →</a>
          </div>
        </td></tr>

        <tr><td style="padding:20px 32px;text-align:center;font-size:12px;color:#9aa0ab;line-height:1.6;border-top:1px solid #ece7dd;">
          You are getting this one-time reminder because you started an order at Pet License Factory. Reply any time, a real human reads these.<br>
          <span style="opacity:.7;">Pet License Factory · 7900 Cambridge St, Apt 28-1G · Houston, TX 77054</span><br>
          <a href="${unsubHref}" style="color:#9aa0ab;text-decoration:underline;">Unsubscribe</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`${petLabel}'s licence is still in your cart.

You built ${petLabel}'s licence and made it all the way to checkout, then life happened. We saved your cart exactly as you left it.

Pick up where you left off (the link works for 30 days):
${recoveryUrl}

You are getting this one-time reminder because you started an order at Pet License Factory. Reply any time, a real human reads these.

Pet License Factory · 7900 Cambridge St, Apt 28-1G · Houston, TX 77054
Unsubscribe: ${unsubHref}

— Pet License Factory`;

  return sendEmail(env, {
    to, subject, html, text,
    customArgs: { email_type: 'checkout_recovery', order_id: orderId },
    asmGroupId,
    subscriptionTracking: !asmGroupId,
  });
}

// ── Goofy Licenses nomination recovery email ────────────────────────────────
// Same trigger as sendCheckoutRecoveryEmail (expired unpaid Checkout Session
// with a captured email), Council copy for GOOFY orders so a nominator never
// receives pet-license copy. One send per order, enforced by
// pet_orders.recovery_email_sent_at in stripe-webhook.js.
export async function sendGoofyRecoveryEmail(env, { to, recipientName, recoveryUrl, orderId }) {
  if (!to || !recoveryUrl) return { skipped: true, reason: 'missing email or url' };

  const nominee = (recipientName || '').trim() || 'your nominee';
  const subject = `${nominee}'s G.O.A.T. nomination is still on the clerk's desk`;

  const asmGroupId = env.SENDGRID_ASM_GROUP_ID ? parseInt(env.SENDGRID_ASM_GROUP_ID, 10) : null;
  const unsubHref = asmGroupId ? '<%asm_group_unsubscribe_raw_url%>' : '[unsubscribe]';

  const E = GOAT_EMAIL;
  const html = goatEmailShell(env, {
    subject,
    preheader: `The Council kept ${nominee}'s file exactly as you left it.`,
    title: 'The file is still open',
    lead: `You started a G.O.A.T. nomination for ${esc(nominee)} and made it all the way to checkout, then life happened. The Council kept the file exactly as you left it.`,
    sections: `
        <tr><td style="padding:24px 36px 4px;text-align:center;">
          <div style="background:${E.filing};border:1px dashed ${E.gold};border-radius:12px;padding:22px 20px;">
            <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:${E.muted};">
              One click takes you straight back to the payment page with everything filled in. The link works for 30 days, but ${esc(nominee)} would prefer sooner.
            </p>
            ${goatButton(recoveryUrl, 'Finish the nomination →')}
          </div>
        </td></tr>`,
    footer: `<br>You're getting this one-time reminder because you started a nomination at Goofy Licenses.<br><a href="${unsubHref}" style="color:${E.muted};text-decoration:underline;">Unsubscribe</a>`,
  });

  const text =
`${nominee}'s G.O.A.T. nomination is still on the clerk's desk.

You started a G.O.A.T. nomination for ${nominee} and made it all the way to checkout, then life happened. The Council kept the file exactly as you left it.

Pick up where you left off (the link works for 30 days):
${recoveryUrl}

You are getting this one-time reminder because you started a nomination at Goofy Licenses. Reply any time, a clerk reads these.

Goofy Licenses · novelty gag licenses · not a government document
Unsubscribe: ${unsubHref}

— The Council of G.O.A.T. Affairs`;

  return sendEmail(env, {
    to, subject, html, text,
    sender: LINE_SENDER.goat,
    customArgs: { email_type: 'goofy_recovery', order_id: orderId },
    asmGroupId,
    subscriptionTracking: !asmGroupId,
  });
}

// ── G.O.A.T. line: kit shipped ───────────────────────────────────────────────
// The Council-branded counterpart of sendShippingNotificationEmail +
// sendStampShippedEmail, sent from the admin flows for goat-line orders so a
// Goofy customer never gets a Pet License Factory email. Goes to the
// NOMINATOR (the buyer), not the nominee, so the surprise survives. With a
// tracking number it shows the USPS tracking box; without one (stamp mail) it
// says so. Styled like the printed Council certificate: black on cream.
export async function sendGoofyShippedEmail(env, order) {
  const {
    orderId, customerEmail, recipientName, giverName, variant, selfNominate,
    trackingNumber,
    shipAddrLine1, shipAddrLine2, shipCity, shipState, shipZip,
  } = order;
  if (!customerEmail) return { skipped: true, reason: 'no email' };

  const nominee = (recipientName || '').trim() || 'your nominee';
  const tracking = (trackingNumber || '').trim();
  const trackUrl = tracking ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}` : '';
  const honorLabel = ({
    'standard':     'Standard',
    'custom-giver': 'Custom, with giver credit',
    'custom-anon':  'Custom, anonymous',
  })[variant] || 'G.O.A.T. License';
  const presentedBy = variant === 'custom-giver' && giverName ? giverName : '';
  const shipTo = [shipAddrLine1, shipAddrLine2, [shipCity, [shipState, shipZip].filter(Boolean).join(' ')].filter(Boolean).join(', ')]
    .filter(Boolean).join(', ');
  const origin = (env.GOOFY_ORIGIN || 'https://goofylicenses.com').replace(/\/+$/, '');

  const subject = `🐐 ${nominee}'s G.O.A.T. license is in the mail`;

  const E = GOAT_EMAIL;
  const trackingBlock = tracking
    ? `<div style="background:${E.filing};border:1px solid ${E.line};border-radius:12px;padding:20px;text-align:center;">
            <div style="font-size:10px;font-weight:700;letter-spacing:2px;color:${E.muted};">TRACKING NUMBER</div>
            <div style="margin:8px 0 16px;font-family:'Courier New',monospace;font-size:17px;font-weight:700;color:${E.gold};word-break:break-all;">${esc(tracking)}</div>
            ${goatButton(trackUrl, 'Track the package →')}
            ${selfNominate ? '' : `<div style="margin-top:12px;font-size:13px;color:${E.muted};">It's a surprise, so tracking goes to you, not to ${esc(nominee)}.</div>`}
          </div>`
    : `<div style="background:${E.filing};border:1px solid ${E.line};border-radius:12px;padding:16px 20px;text-align:center;font-size:14px;line-height:1.7;color:${E.muted};">
            Sealed, stamped and sent by USPS mail. Stamp mail doesn't come with tracking, so allow a few business days.
          </div>`;

  const html = goatEmailShell(env, {
    subject,
    preheader: `${nominee}'s G.O.A.T. license kit has left the chambers.`,
    title: 'The certification is in the mail',
    lead: `${esc(nominee)}'s G.O.A.T. license kit has left the chambers and is on its way.`,
    sections: `
        <tr><td style="padding:24px 36px 4px;">
          ${trackingBlock}
        </td></tr>
        <tr><td style="padding:22px 36px 4px;">
          ${goatH2('🧾 The filing')}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
          ${goatRow('Filing no.', orderId || '', { mono: true })}
          ${goatRow('Honor', honorLabel)}
          ${goatRow('Nominee', nominee)}
          ${presentedBy ? goatRow('Presented by', presentedBy) : ''}
          ${shipTo ? goatRow('Mails to', shipTo) : ''}
          </table>
        </td></tr>
        <tr><td style="padding:24px 36px 4px;text-align:center;">
          <div style="font-family:${E.serif};font-weight:700;font-size:17px;color:${E.gold};">Know another legend?</div>
          <p style="margin:6px 0 16px;font-size:14px;line-height:1.7;color:${E.muted};">Every kit carries a QR code for the next nomination. Or start one here.</p>
          ${goatButton(origin + '/goat', '🐐 Nominate another GOAT →')}
        </td></tr>`,
  });

  const text =
`The certification is in the mail.

${nominee}'s G.O.A.T. license kit has left the chambers and is on its way.

${tracking ? `Tracking number: ${tracking}\nTrack it: ${trackUrl}${selfNominate ? '' : `\nIt's a surprise, so tracking goes to you, not to ${nominee}.`}` : 'Sealed, stamped and sent by USPS mail. Stamp mail does not come with tracking.'}

Filing no.: ${orderId || ''}
Honor: ${honorLabel}
Nominee: ${nominee}${presentedBy ? `\nPresented by: ${presentedBy}` : ''}${shipTo ? `\nShips to: ${shipTo}` : ''}

Know another legend? The kit carries a QR code. Scan it to nominate the next one: ${origin}/goat

Questions? Reply to this email.

The Council of G.O.A.T. Affairs (Goofy Licenses)`;

  return sendEmail(env, {
    to: customerEmail, subject, html, text,
    sender: LINE_SENDER.goat,
    customArgs: { order_id: orderId, email_type: 'goofy_shipped' },
  });
}

// ── Creator onboarding (affiliate program) ──────────────────────────────────
// Sent at invite time. Carries everything the creator needs in one email:
// affiliate URL, customer-facing coupon code, magic-link to their dashboard,
// one-time freebie checkout URL with the welcome code pre-applied.

// Pure render: returns { subject, html, text, urls } without touching SendGrid.
// Used by the admin "Preview email" action and by the actual sender below.
export function renderCreatorOnboardingEmail(opts) {
  const {
    creatorName,
    affiliateCode, freebieCode, customerDiscountPct, commissionPct,
    siteOrigin = 'https://petlicensefactory.com',
    dashboardToken,
  } = opts;

  const refUrl       = `${siteOrigin}/?ref=${encodeURIComponent(affiliateCode)}`;
  const freebieUrl   = `${siteOrigin}/factory.html?promo=${encodeURIComponent(freebieCode)}`;
  const dashboardUrl = `${siteOrigin}/dashboard.html?token=${encodeURIComponent(dashboardToken)}`;

  const subject = `🎉 You're in — your Pet License Factory creator kit`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">

        <tr><td style="padding:32px 32px 16px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="420" style="display:block;margin:0 auto 20px;max-width:80%;height:auto;image-rendering:pixelated;">
          <h1 style="margin:0;font-family:'Press Start 2P','Courier New',monospace;font-size:14px;color:#0077ff;letter-spacing:2px;text-transform:uppercase;line-height:1.6;">Welcome To The<br>Creator Kit, ${esc(creatorName || 'Creator')}!</h1>
          <p style="margin:14px 0 0;font-size:14px;color:#334477;line-height:1.6;">
            Everything you need to start posting and earning is right here.
          </p>
        </td></tr>

        <!-- Coupon code -->
        <tr><td style="padding:24px 32px 8px;">
          <div style="background:#f0f5ff;border:1px solid #0088cc;border-radius:6px;padding:18px 20px;">
            <div style="font-size:11px;color:#5577aa;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Your Coupon Code (${esc(customerDiscountPct)}% off)</div>
            <div style="font-family:'Courier New',monospace;font-size:24px;color:#0055cc;font-weight:700;letter-spacing:2px;">${esc(affiliateCode)}</div>
            <div style="margin-top:8px;font-size:12px;color:#5577aa;line-height:1.5;">Share this code with your audience. Anyone who uses it gets ${esc(customerDiscountPct)}% off — and you earn ${esc(commissionPct)}% commission on the order.</div>
          </div>
        </td></tr>

        <!-- Affiliate URL -->
        <tr><td style="padding:0 32px 8px;">
          <div style="background:#f7faff;border:1px dashed #0088cc;border-radius:6px;padding:14px 18px;">
            <div style="font-size:11px;color:#5577aa;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Your Affiliate Link</div>
            <a href="${esc(refUrl)}" style="font-family:'Courier New',monospace;font-size:13px;color:#0055cc;word-break:break-all;text-decoration:none;">${esc(refUrl)}</a>
            <div style="margin-top:6px;font-size:12px;color:#5577aa;line-height:1.5;">Use this in bios, captions, link-in-bio. Works even if your followers don't enter a coupon code.</div>
          </div>
        </td></tr>

        <!-- Freebie -->
        <tr><td style="padding:16px 32px 8px;">
          <div style="background:#fff8e1;border:1px solid #e0a800;border-radius:6px;padding:18px 20px;">
            <div style="font-size:11px;color:#a86c00;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">🎁 Your free Pet License</div>
            <p style="margin:0 0 12px;font-size:14px;color:#5a4a00;line-height:1.6;">
              Click the button below to claim your complimentary Pet License sticker — free product, free stamp shipping, on us.
            </p>
            <a href="${esc(freebieUrl)}" style="display:inline-block;padding:12px 22px;background:#e0a800;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:13px;letter-spacing:1px;">Claim My Free License →</a>
            <div style="margin-top:8px;font-size:11px;color:#a86c00;font-family:'Courier New',monospace;">Code: ${esc(freebieCode)} · single-use · expires in 30 days</div>
          </div>
        </td></tr>

        <!-- Dashboard -->
        <tr><td style="padding:16px 32px 8px;">
          <div style="background:#f0f5ff;border:1px solid #0088cc;border-radius:6px;padding:18px 20px;text-align:center;">
            <div style="font-size:13px;color:#0077ff;font-weight:700;margin-bottom:8px;">📊 Your Creator Dashboard</div>
            <p style="margin:0 0 12px;font-size:13px;color:#334477;line-height:1.6;">
              See clicks, sales and commission in real time. Bookmark this — it's your personal page.
            </p>
            <a href="${esc(dashboardUrl)}" style="display:inline-block;padding:12px 22px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:13px;letter-spacing:1px;">Open Dashboard →</a>
          </div>
        </td></tr>

        <!-- Package -->
        <tr><td style="padding:16px 32px 8px;">
          <div style="background:#f7faff;border:1px solid rgba(0,102,255,.18);border-radius:6px;padding:18px 20px;">
            <div style="font-size:13px;color:#0077ff;font-weight:700;margin-bottom:10px;">What you get</div>
            <ol style="margin:0;padding-left:20px;font-size:13px;color:#223355;line-height:1.7;">
              <li><strong>Free product</strong> — claim your complimentary Pet License sample above.</li>
              <li><strong>Commission package</strong> — share your code/link and earn ${esc(commissionPct)}% on paid orders.</li>
              <li><strong>$10 video bonus</strong> — upload your TikTok review video in your dashboard after posting. Once reviewed, we’ll add the bonus.</li>
            </ol>
          </div>
        </td></tr>

        <!-- Brief -->
        <tr><td style="padding:20px 32px 8px;">
          <h2 style="margin:0 0 10px;font-size:13px;color:#0088cc;letter-spacing:1px;text-transform:uppercase;font-weight:600;">📋 The Brief</h2>
          <ul style="margin:0;padding-left:20px;font-size:13px;color:#223355;line-height:1.7;">
            <li>Post an authentic TikTok review video within 14 days of receiving your product.</li>
            <li>Upload that video in your dashboard as proof so we can review it for the $10 bonus.</li>
            <li>Add your TikTok Spark Ads authorization code in the dashboard if you want us to promote the video with ad spend.</li>
            <li>Tag <strong>@petlicensefactory</strong> so we can re-share.</li>
            <li>Be honest. Show the license; show your pet's reaction. Authenticity outperforms polish.</li>
          </ul>
        </td></tr>

        <!-- FAQ -->
        <tr><td style="padding:8px 32px 24px;">
          <h2 style="margin:0 0 10px;font-size:13px;color:#0088cc;letter-spacing:1px;text-transform:uppercase;font-weight:600;">❓ Quick FAQ</h2>
          <div style="font-size:13px;color:#223355;line-height:1.7;">
            <strong style="color:#0099cc;">When am I paid?</strong><br>
            Manually, monthly, via Venmo / PayPal / Zelle. We'll DM you the first time to confirm your handle.<br><br>
            <strong style="color:#0099cc;">What counts as a sale?</strong><br>
            Any paid order using your coupon code, OR any paid order from a visitor who clicked your affiliate link in the last 30 days. Refunds reverse the commission.<br><br>
            <strong style="color:#0099cc;">Can I share both the link and the code?</strong><br>
            Yes — share both. Whichever the customer uses, you get credit.
          </div>
        </td></tr>

        <tr><td style="padding:20px 32px;background:#f0f5ff;border-top:1px solid rgba(0,102,255,.15);text-align:center;font-size:12px;color:#6688aa;line-height:1.6;">
          Questions? Just reply to this email.<br>
          <span style="opacity:.6;">Pet License Factory · Houston, TX</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`Welcome to the Pet License Factory creator kit, ${creatorName || 'Creator'}!

Your coupon code:   ${affiliateCode}   (${customerDiscountPct}% off — you earn ${commissionPct}%)
Your affiliate URL: ${refUrl}

🎁 Claim your free Pet License:
${freebieUrl}
(Code: ${freebieCode} — single-use, 30-day expiry)

📊 Your dashboard:
${dashboardUrl}

What you get:
1. Free product — claim your complimentary sample above.
2. Commission package — share your code/link and earn ${commissionPct}% on paid orders.
3. $10 video bonus — upload your TikTok review video in your dashboard after posting. Once reviewed, we'll add the bonus.

The brief:
- Post an authentic TikTok review video within 14 days of receiving your product.
- Upload that video in your dashboard as proof so we can review it for the $10 bonus.
- Add your TikTok Spark Ads authorization code in the dashboard if you want us to promote the video with ad spend.
- Tag @petlicensefactory.
- Authenticity > polish.

When am I paid?  Monthly, via Venmo / PayPal / Zelle.
What counts?     Any paid order using your code, OR any paid order from a visitor who clicked your link in the last 30 days. Refunds reverse the commission.

Questions? Reply to this email.

— Pet License Factory`;

  return {
    subject,
    html,
    text,
    urls: { affiliate: refUrl, freebie: freebieUrl, dashboard: dashboardUrl },
  };
}

// Returns { success, status, error, messageId } so callers can log to
// affiliate_email_log with the SendGrid message id.
export async function sendCreatorOnboardingEmail(env, opts) {
  const { creatorEmail } = opts;
  if (!creatorEmail) return { skipped: true, reason: 'no email' };
  const { subject, html, text } = renderCreatorOnboardingEmail(opts);
  return sendEmail(env, { to: creatorEmail, subject, html, text });
}

// ── Creator magic-link (dashboard sign-in) ─────────────────────────────────
export async function sendCreatorMagicLinkEmail(env, opts) {
  const { creatorEmail, creatorName, magicUrl, expiresMinutes = 30 } = opts;
  if (!creatorEmail) return { skipped: true, reason: 'no email' };

  const subject = `🔑 Sign in to your Pet License Factory dashboard`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#f0f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f5ff;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:2px solid #0066ff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:32px;text-align:center;background:linear-gradient(180deg,#eef4ff 0%,#ffffff 100%);">
          <img src="https://petlicensefactory.com/images/wordmark-email.png" alt="Pet License Factory" width="380" style="display:block;margin:0 auto 16px;max-width:80%;height:auto;image-rendering:pixelated;">
          <h1 style="margin:0 0 8px;font-family:'Press Start 2P','Courier New',monospace;font-size:14px;color:#0077ff;letter-spacing:2px;text-transform:uppercase;">Sign In</h1>
          <p style="margin:8px 0 20px;font-size:14px;color:#334477;line-height:1.5;">
            ${creatorName ? `Hey ${esc(creatorName)} — c` : 'C'}lick the button to open your dashboard.
          </p>
          <a href="${esc(magicUrl)}" style="display:inline-block;padding:14px 28px;background:#0077ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700;font-size:14px;letter-spacing:1px;">Open Dashboard →</a>
          <p style="margin:18px 0 0;font-size:12px;color:#6688aa;">This link expires in ${esc(expiresMinutes)} minutes and can be used once.</p>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;font-size:12px;color:#6688aa;line-height:1.6;text-align:center;">
          Didn't request this? Ignore it. The link won't do anything if you don't click it.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`Sign in to your Pet License Factory dashboard:
${magicUrl}

This link expires in ${expiresMinutes} minutes and can be used once. Didn't request this? Ignore it.`;

  return sendEmail(env, { to: creatorEmail, subject, html, text });
}
