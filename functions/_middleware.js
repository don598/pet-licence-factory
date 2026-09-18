// ── Goofy Licenses — Host Routing (Cloudflare Pages middleware) ─────────────
// One Pages project serves two front doors:
//
//   petlicensefactory.com   Pet License Factory, exactly as before (the
//                           default for ads, TikTok Shop, creator + gift
//                           links and emails)
//   goofylicenses.com       Goofy Licenses, the house brand:
//     /                     house homepage (public/goofy-home/)
//     /pet                  the Pet License Factory homepage, URL kept;
//                           canonical points at petlicensefactory.com
//     /goat                 G.O.A.T. builder (rewritten in public/_redirects)
//     /forklift, /clown     coming-soon pages (public/goofy-home/soon.html)
//
// Plus the domain hygiene _redirects can't do (Pages ignores host-based
// rules there): www + the singular goofylicense.com 301 to the canonical
// goofylicenses.com, and G.O.A.T. pages opened on the pet domain 301 to the
// Goofy domain. The product lines themselves are listed in public/lines.js.
//
// Runs in front of every request, so anything it doesn't handle goes
// straight to next() untouched. /api/* is never redirected (webhooks and
// POSTs must not bounce).
// ---------------------------------------------------------------------------

const GOOFY_HOST = 'goofylicenses.com';
const GOOFY_ORIGIN = 'https://' + GOOFY_HOST;
const PLC_ORIGIN = 'https://petlicensefactory.com';
const GOOFY_ALIASES = new Set(['www.goofylicenses.com', 'goofylicense.com', 'www.goofylicense.com']);
const PLC_HOSTS = new Set(['petlicensefactory.com', 'www.petlicensefactory.com']);
const SOON_PATHS = new Set(['/forklift', '/clown']);

// Pages that belong to the G.O.A.T. line. Assets under /goofy/ (images, js)
// are left alone so anything already embedding them keeps working.
function isGoatPage(path) {
  if (path === '/goat' || path.startsWith('/goat/')) return true;
  if (path === '/goofy' || path === '/goofy/') return true;
  return path.startsWith('/goofy/') && !/\.(?!html$)[a-z0-9]+$/i.test(path);
}

// Serve a static file under the visitor's URL. Pages normalises asset URLs
// (drops .html, adds trailing slashes) with a redirect; follow one of those
// internally so the address bar never changes.
async function serveAsset(env, request, url, assetPath) {
  let res = await env.ASSETS.fetch(new Request(new URL(assetPath, url), request));
  const loc = res.status >= 300 && res.status < 400 && res.headers.get('Location');
  if (loc) res = await env.ASSETS.fetch(new Request(new URL(loc, url), request));
  return res;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (path.startsWith('/api/')) return next();

  // Alias domains → the canonical Goofy domain, path and query kept.
  if (GOOFY_ALIASES.has(host)) {
    return Response.redirect(GOOFY_ORIGIN + path + url.search, 301);
  }

  // G.O.A.T. pages always live on the Goofy domain.
  if (PLC_HOSTS.has(host) && isGoatPage(path)) {
    return Response.redirect(GOOFY_ORIGIN + path + url.search, 301);
  }

  if (host !== GOOFY_HOST) return next();

  if (path === '/') {
    // A pet gift/affiliate link that landed on the Goofy root keeps working.
    if (url.searchParams.has('promo') || url.searchParams.has('ref')) {
      return Response.redirect(GOOFY_ORIGIN + '/pet' + url.search, 302);
    }
    return serveAsset(env, request, url, '/goofy-home/');
  }

  if (path === '/pet/') return Response.redirect(GOOFY_ORIGIN + '/pet' + url.search, 301);
  if (path === '/pet') {
    const res = await serveAsset(env, request, url, '/');
    const out = new Response(res.body, res);
    out.headers.set('Link', `<${PLC_ORIGIN}/>; rel="canonical"`);
    return out;
  }

  const bare = path.replace(/\/+$/, '');
  if (SOON_PATHS.has(bare)) {
    if (bare !== path) return Response.redirect(GOOFY_ORIGIN + bare + url.search, 301);
    return serveAsset(env, request, url, '/goofy-home/soon');
  }

  // Every other page here is a Pet License Factory page reached through the
  // Goofy domain: tell search engines the original lives on the pet domain.
  const res = await next();
  const type = res.headers.get('Content-Type') || '';
  if (request.method === 'GET' && type.includes('text/html')
      && !isGoatPage(path) && !path.startsWith('/goofy-home')) {
    const out = new Response(res.body, res);
    out.headers.set('Link', `<${PLC_ORIGIN}${path}>; rel="canonical"`);
    return out;
  }
  return res;
}
