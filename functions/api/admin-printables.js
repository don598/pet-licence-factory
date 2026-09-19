// ── Pet Licence Factory — Printables library (Cloudflare Pages Function) ────
// Command Station's "Printables" view: files Donny prints often (envelope
// inserts, return labels, flyers, packing slips…). Stored in the private
// CREATOR_UPLOADS R2 bucket under printables/, no database needed — the
// display name and upload time ride along as R2 customMetadata.
//
//   GET    /api/admin-printables            → { files: [{ key, name, size, type, uploadedAt }] }
//   GET    /api/admin-printables?key=…      → the file bytes (inline)
//   POST   /api/admin-printables            multipart: file (1+), optional name
//   DELETE /api/admin-printables?key=…      → { ok: true }
//
// Auth: same admin JWT as admin-api (Authorization: Bearer …) on every call.
// ---------------------------------------------------------------------------

import jwt from 'jsonwebtoken';

const PREFIX = 'printables/';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB per file
const ALLOWED_TYPES = /^(application\/pdf|image\/(png|jpe?g|webp|gif|svg\+xml))$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function authed(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  try { jwt.verify(token, env.ADMIN_JWT_SECRET); return true; } catch { return false; }
}

// Only keys we minted: printables/<uuid>-<safe name>. Blocks reaching other
// prefixes in the shared bucket (creator videos, lead licences).
function validKey(key) {
  return typeof key === 'string' && key.startsWith(PREFIX) && !key.includes('..')
    && /^printables\/[0-9a-f-]{36}-[A-Za-z0-9._-]{1,120}$/.test(key);
}

function safeName(name) {
  return String(name || 'file').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(-120) || 'file';
}

function cleanLabel(v) {
  return String(v ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 120);
}

export async function onRequest({ request, env }) {
  if (!authed(request, env)) return json(401, { error: 'Unauthorized' });
  const bucket = env.CREATOR_UPLOADS;
  if (!bucket) return json(503, { error: 'Storage is not configured (CREATOR_UPLOADS R2 binding missing).' });

  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (request.method === 'GET' && key) {
    if (!validKey(key)) return json(400, { error: 'Bad key' });
    const obj = await bucket.get(key);
    if (!obj) return json(404, { error: 'Not found' });
    const name = (obj.customMetadata && obj.customMetadata.name) || key.slice(PREFIX.length + 37);
    return new Response(obj.body, {
      headers: {
        'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${safeName(name)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (request.method === 'GET') {
    const files = [];
    let cursor;
    do {
      const page = await bucket.list({ prefix: PREFIX, cursor, include: ['customMetadata', 'httpMetadata'] });
      for (const o of page.objects) {
        files.push({
          key: o.key,
          name: (o.customMetadata && o.customMetadata.name) || o.key.slice(PREFIX.length + 37),
          size: o.size,
          type: (o.httpMetadata && o.httpMetadata.contentType) || '',
          uploadedAt: (o.customMetadata && o.customMetadata.uploadedAt) || (o.uploaded && o.uploaded.toISOString()),
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    files.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    return json(200, { files });
  }

  if (request.method === 'POST') {
    let form;
    try { form = await request.formData(); } catch { return json(400, { error: 'Expected multipart form data' }); }
    const uploads = form.getAll('file').filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f);
    if (!uploads.length) return json(400, { error: 'No file attached' });
    const label = cleanLabel(form.get('name'));
    const saved = [];
    for (const file of uploads) {
      const type = file.type || '';
      if (!ALLOWED_TYPES.test(type)) return json(415, { error: `${file.name}: only PDF and image files (PNG, JPG, WEBP, GIF, SVG)` });
      if (file.size > MAX_BYTES) return json(413, { error: `${file.name}: over the 50 MB limit` });
      const name = (uploads.length === 1 && label) || cleanLabel(file.name) || 'Untitled';
      const k = `${PREFIX}${crypto.randomUUID()}-${safeName(file.name)}`;
      const uploadedAt = new Date().toISOString();
      await bucket.put(k, file.stream(), {
        httpMetadata: { contentType: type },
        customMetadata: { name, uploadedAt },
      });
      saved.push({ key: k, name, size: file.size, type, uploadedAt });
    }
    return json(200, { files: saved });
  }

  if (request.method === 'DELETE') {
    if (!validKey(key)) return json(400, { error: 'Bad key' });
    await bucket.delete(key);
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method Not Allowed' });
}
