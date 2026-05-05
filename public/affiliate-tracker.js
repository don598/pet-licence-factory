// ── Pet Licence Factory — Affiliate URL Tracker ────────────────────────────
// Reads ?ref=<code> from the URL on page load, sends it to the
// /api/affiliate-track-click endpoint, and lets the server set the
// first-party attribution cookie. Idempotent — safe to include on every
// page; runs only when ?ref= is present.
//
// Also clones the ref into sessionStorage so the checkout-session creator
// can pick it up even if the cookie is blocked or stripped on a redirect.
// ---------------------------------------------------------------------------

(function () {
  try {
    var url    = new URL(window.location.href);
    var ref    = (url.searchParams.get('ref') || '').trim();
    if (!ref) return;

    // Stash for the checkout call — survives the off-site Stripe trip.
    try { sessionStorage.setItem('plfAffiliateRef', ref.toUpperCase()); } catch (e) {}

    fetch('/api/affiliate-track-click', {
      method:      'POST',
      credentials: 'same-origin',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({
        code:        ref,
        landingPath: url.pathname + url.search,
        referrer:    document.referrer || '',
      }),
    }).catch(function () { /* network errors are non-fatal */ });

    // Clean ?ref= out of the URL so refreshes don't re-track. Replace state
    // only if supported; ignore otherwise.
    try {
      url.searchParams.delete('ref');
      var clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash;
      window.history.replaceState({}, document.title, clean);
    } catch (e) {}
  } catch (e) { /* never throw to the page */ }
})();

// Tiny helper exposed for the checkout flow to read the stashed ref.
window.PLFAffiliate = {
  getRef: function () {
    try { return sessionStorage.getItem('plfAffiliateRef') || ''; } catch (e) { return ''; }
  },
};
