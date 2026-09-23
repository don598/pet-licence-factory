// ── Goofy Licenses — Product Line Registry (CLIENT) ─────────────────────────
// SINGLE SOURCE OF TRUTH for the product lines ("licenses") the house brand
// sells. The goofylicenses.com homepage tiles, the coming-soon pages, and the
// Command Station line switcher all read window.GOOFY_LINES.
//
// Server mirror: functions/_shared/lines.js (ids, names, status). Keep the two
// in sync when adding a line. An order's line lives in pet_orders.brand
// ('plc' | 'goat' | …); legacy 'goofy' rows mean 'goat'.
//
// Adding a line: add an entry here + in the server mirror, build its builder
// page, flip status 'soon' → 'live'. The homepage, dashboard and waitlists
// pick it up from here.
//
// Plain classic script (no modules) so it works from file:// and any page.
(function (root) {
  var LINES = [
    {
      id: 'plc',
      name: "Pet Driver's License",
      short: 'Pet',
      audience: 'For your pet',
      maker: 'Pet License Factory',
      status: 'live',
      priceFrom: '$8.95',
      blurb: "Your pet's very own driver's license. Photo, name, stats and a signature paw, printed as a credit card skin, a real license card, or both.",
      cta: "Make your pet's license",
      url: '/pet',
      altUrl: 'https://petlicensefactory.com',
      image: '/images/preview-licences/max-woofington.webp',
      color: { ink: '#3B2FA8', tint: '#ECE9FB', dot: '#5B4FD6', panel: '#1E1B4B' }
    },
    {
      id: 'goat',
      name: 'G.O.A.T. License',
      short: 'GOAT',
      audience: 'For a friend (or yourself)',
      maker: 'Council of G.O.A.T. Affairs',
      status: 'live',
      priceFrom: '$4.95',
      priceNote: 'Standard $4.95 · Custom with photo $8.95',
      blurb: 'Nominate a legend. The Council certifies them and mails a Greatest Of All Time license, with an official certificate.',
      cta: 'Nominate a legend',
      url: '/goat',
      image: '/goofy-home/goat-card-custom.jpg',
      certificateUrl: '/goofy/certificate',
      color: { ink: '#7A4F05', tint: '#F5EAD0', dot: '#A86E0A', panel: '#EDE4D0' }
    },
    {
      id: 'forklift',
      name: 'Forklift Certified',
      short: 'Forklift',
      audience: 'For the coworker',
      status: 'soon',
      blurb: 'For the friend who has never driven a forklift. Or has, spectacularly.',
      url: '/forklift',
      color: { ink: '#9A4A00', tint: '#FCE6D2', dot: '#D9731A' }
    },
    {
      id: 'clown',
      name: 'Clown License',
      short: 'Clown',
      audience: 'For the class clown',
      status: 'soon',
      blurb: 'Fully licensed to honk. Valid at parties, offices and family reunions.',
      url: '/clown',
      color: { ink: '#A3174F', tint: '#FADDE8', dot: '#D6336C' }
    }
  ];

  var byId = {};
  LINES.forEach(function (l) { byId[l.id] = l; });

  root.GOOFY_LINES = {
    list: LINES,
    get: function (id) { return byId[id] || null; },
    live: function () { return LINES.filter(function (l) { return l.status === 'live'; }); },
    soon: function () { return LINES.filter(function (l) { return l.status === 'soon'; }); },
    // Which line an order row belongs to. Prefers the API's `line`, then the
    // stored brand ('goofy' is the legacy spelling of 'goat'), then the
    // order-id prefix. Anything unknown is a pet order.
    lineOf: function (order) {
      if (!order) return 'plc';
      if (order.line && byId[order.line]) return order.line;
      var b = String(order.brand || '').trim().toLowerCase();
      if (b === 'goofy' || b === 'goat') return 'goat';
      if (byId[b]) return b;
      if (/^GOOFY-/i.test(String(order.order_id || ''))) return 'goat';
      return 'plc';
    }
  };
})(typeof window !== 'undefined' ? window : this);
