// ── Pet Licence Factory — Creator Video Proxy ──────────────────────────────
// GET /api/affiliate-video?token=<dashboard_token>
//
// Streams the creator's submitted proof video from R2. The dashboard token is
// already the creator's private auth credential, and the command center can use
// the same URL from creator detail.
// ---------------------------------------------------------------------------

import { getDb } from '../_shared/db.js';
import { findCreatorByDashboardToken } from '../_shared/affiliate.js';
import { ensureAffiliateContentSchema } from '../_shared/affiliate-content-schema.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!env.CREATOR_UPLOADS) {
    return new Response('Video storage is not configured.', { status: 503 });
  }

  const url = new URL(request.url);
  const token = String(url.searchParams.get('token') || '').trim();
  if (!token) return new Response('Missing token', { status: 401 });

  const db = getDb(env);
  await ensureAffiliateContentSchema(db);
  const creator = await findCreatorByDashboardToken(db, token);
  if (!creator) return new Response('Invalid token', { status: 401 });
  if (!creator.review_video_r2_key) return new Response('No video submitted.', { status: 404 });

  const object = await env.CREATOR_UPLOADS.get(creator.review_video_r2_key);
  if (!object) return new Response('Video not found.', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', creator.review_video_content_type || object.httpMetadata?.contentType || 'video/mp4');
  headers.set('Content-Disposition', `inline; filename="${safeHeaderFileName(creator.review_video_filename || 'creator-video.mp4')}"`);
  headers.set('Cache-Control', 'private, max-age=300');
  if (object.size) headers.set('Content-Length', String(object.size));

  return new Response(object.body, { status: 200, headers });
}

function safeHeaderFileName(value) {
  return String(value || 'creator-video.mp4').replace(/["\r\n]/g, '-').slice(0, 120);
}
