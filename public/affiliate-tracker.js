// ── Pet License Factory — Affiliate + Promo URL Tracker ────────────────────
// Reads ?ref=<code> and ?promo=<code> from the URL on page load.
//   • ref:   sent to /api/affiliate-track-click (server sets the first-party
//            attribution cookie) and cloned into sessionStorage.
//   • promo: a gift/freebie code — cloned into sessionStorage so it survives
//            redirects (the mobile gate, "skip the game") and the off-site
//            Stripe trip, then read back by the builder at checkout.
// Both are then stripped from the URL so refreshes don't re-track and the
// address bar stays tidy. Idempotent — safe to include on every page.
// ---------------------------------------------------------------------------

(function () {
  try {
    var url   = new URL(window.location.href);
    var ref   = (url.searchParams.get('ref')   || '').trim();
    var promo = (url.searchParams.get('promo') || '').trim();
    if (!ref && !promo) return;

    // Stash the gift/freebie promo code for the checkout call. Survives the
    // off-site Stripe trip and any same-tab redirect between landing → builder.
    if (promo) {
      try { sessionStorage.setItem('plfPromoCode', promo); } catch (e) {}
    }

    if (ref) {
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
    }

    // Clean ?ref= / ?promo= out of the URL (the values live in sessionStorage
    // now). Replace state only if supported; ignore otherwise.
    try {
      url.searchParams.delete('ref');
      url.searchParams.delete('promo');
      var clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash;
      window.history.replaceState({}, document.title, clean);
    } catch (e) {}
  } catch (e) { /* never throw to the page */ }
})();

// Tiny helpers exposed for the checkout flow to read the stashed values.
window.PLFAffiliate = {
  getRef: function () {
    try { return sessionStorage.getItem('plfAffiliateRef') || ''; } catch (e) { return ''; }
  },
};
window.PLFPromo = {
  getCode: function () {
    try { return sessionStorage.getItem('plfPromoCode') || ''; } catch (e) { return ''; }
  },
};
