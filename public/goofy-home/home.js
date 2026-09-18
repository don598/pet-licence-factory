// Goofy Licenses house pages: homepage tiles, coming-soon pages and the
// notify-me / suggestion forms. Everything line-specific comes from
// /lines.js (window.GOOFY_LINES), so a new line shows up here by itself.
(function(){
  'use strict';
  var L = window.GOOFY_LINES;
  if (!L) return;
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  var ARROW = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  var ICONS = {
    forklift: '<svg width="40" height="40" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 46V28h18l6 8v10z"/><path d="M10 28V14h13l4 14"/><path d="M38 10v38"/><path d="M38 46h20"/><path d="M30 36h8"/><circle cx="13" cy="49" r="5"/><circle cx="26" cy="49" r="5"/></svg>',
    clown: '<svg width="40" height="40" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="32" cy="40" r="17"/><circle cx="32" cy="42" r="5" fill="currentColor"/><path d="M24 49c4 4 12 4 16 0"/><path d="M21 26l11-19 11 19"/><circle cx="32" cy="6" r="3"/><circle cx="25" cy="36" r="1.5" fill="currentColor"/><circle cx="39" cy="36" r="1.5" fill="currentColor"/></svg>',
    suggest: '<svg width="36" height="36" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="16" width="48" height="32" rx="5"/><path d="M32 24v16M24 32h16"/></svg>'
  };
  var STARS = '<span class="star" style="left:9%;top:16%;width:6px;height:6px"></span><span class="star" style="left:86%;top:23%;width:4px;height:4px"></span><span class="star" style="left:18%;top:77%;width:4px;height:4px"></span><span class="star" style="left:92%;top:80%;width:6px;height:6px"></span>';

  function liveTile(l){
    var c = l.color || {};
    var alt = l.altUrl ? '<div class="fine">Also at <a href="' + esc(l.altUrl) + '">' + esc(l.altUrl.replace(/^https?:\/\//, '')) + '</a></div>'
      : (l.priceNote ? '<div class="fine">' + esc(l.priceNote) + '</div>' : '');
    return '<article class="tile" data-line="' + esc(l.id) + '">' +
      '<div class="stub"><b>' + esc(l.audience) + '</b><span>' + esc(l.maker || '') + '</span></div>' +
      '<div class="shot ' + esc(l.id) + '" style="background:' + esc(c.panel || '#EDE4D0') + '">' + (l.id === 'plc' ? STARS : '') +
        '<img src="' + esc(l.image) + '" alt="A sample ' + esc(l.name) + '" loading="lazy" width="390" height="246"/></div>' +
      '<div class="tile-body">' +
        '<div class="tile-meta"><span class="chip" style="background:' + esc(c.tint) + ';color:' + esc(c.ink) + '">Open now</span>' +
          (l.priceFrom ? '<span class="price">From ' + esc(l.priceFrom) + '</span>' : '') + '</div>' +
        '<h3>' + esc(l.name) + '</h3><p>' + esc(l.blurb) + '</p>' +
        '<a class="btn btn-solid go" href="' + esc(l.url) + '" data-track="home_tile_' + esc(l.id) + '">' + esc(l.cta || 'Start') + ARROW + '</a>' +
        alt +
      '</div></article>';
  }
  function notifyForm(line, isSuggest){
    var id = 'nf-' + line;
    return '<form class="notify" data-line="' + esc(line) + '" novalidate>' +
      '<label for="' + id + '">' + (isSuggest ? 'Your idea' : "Tell me when it's ready") + '</label>' +
      '<div class="row">' +
        (isSuggest
          ? '<input id="' + id + '" name="idea" type="text" maxlength="120" placeholder="Certified Grill Master" required/>'
          : '<input id="' + id + '" name="email" type="email" autocomplete="email" placeholder="you@email.com" required/>') +
        '<button type="submit">' + (isSuggest ? 'Submit' : 'Notify me') + '</button>' +
      '</div>' +
      '<div class="hp" aria-hidden="true"><label for="' + id + '-w">Website</label><input id="' + id + '-w" name="website" type="text" tabindex="-1" autocomplete="off"/></div>' +
      '<div class="msg" role="status" aria-live="polite"></div>' +
    '</form>';
  }
  function soonTile(l){
    var c = l.color || {};
    return '<article class="tile" data-line="' + esc(l.id) + '">' +
      '<div class="stub"><b>' + esc(l.audience) + '</b><span class="soon">Coming soon</span></div>' +
      '<div class="tile-body">' +
        '<div class="soon-title"><div class="soon-icon" style="background:' + esc(c.tint) + ';color:' + esc(c.ink) + '">' + (ICONS[l.id] || ICONS.suggest) + '</div>' +
          '<h3><a href="' + esc(l.url) + '" style="text-decoration:none">' + esc(l.name) + '</a></h3></div>' +
        '<p>' + esc(l.blurb) + '</p>' + notifyForm(l.id, false) +
      '</div></article>';
  }
  function suggestTile(){
    return '<article class="tile suggest">' +
      '<div class="stub"><b>Your idea here</b><span>Suggestion box</span></div>' +
      '<div class="tile-body">' +
        '<div class="soon-title"><div class="soon-icon">' + ICONS.suggest + '</div><h3>Suggest a license</h3></div>' +
        '<p>Know someone who needs official recognition? Tell the Bureau what to license next.</p>' + notifyForm('suggest', true) +
      '</div></article>';
  }

  function renderHome(){
  $('gridLive').innerHTML = L.live().map(liveTile).join('');
  $('gridSoon').innerHTML = L.soon().map(soonTile).join('') + suggestTile();
  }

  // Coming-soon page (/forklift, /clown → soon.html). The line comes from
  // the path, or ?line= when opened directly.
  function renderSoon(){
    var id = (location.pathname.replace(/^\/+|\/+$/g, '').split('/').pop() || '').toLowerCase();
    var l = L.get(id);
    if (!l || l.status !== 'soon') {
      try { id = (new URLSearchParams(location.search).get('line') || '').toLowerCase(); } catch (e) {}
      l = L.get(id);
    }
    if (!l || l.status !== 'soon') { location.replace('/'); return; }
    var c = l.color || {};
    document.title = l.name + ': coming soon from Goofy Licenses';
    var d = document.querySelector('meta[name=description]');
    if (d) d.setAttribute('content', l.name + ' is coming soon from Goofy Licenses. ' + l.blurb);
    $('soonPage').innerHTML =
      '<div class="soon-hero">' +
        '<div class="soon-icon big" style="background:' + esc(c.tint) + ';color:' + esc(c.ink) + '">' + (ICONS[l.id] || ICONS.suggest) + '</div>' +
        '<div class="eyebrow">Coming soon · ' + esc(l.audience) + '</div>' +
        '<h1>' + esc(l.name) + '</h1>' +
        '<p>' + esc(l.blurb) + '</p>' +
        '<div class="soon-form">' + notifyForm(l.id, false) + '</div>' +
      '</div>';
    $('gridLive').innerHTML = L.live().map(liveTile).join('');
  }

  // Hero cards: under the cursor a card tilts toward it in 3D (plus a soft
  // glare), springing from its resting pose with zero starting velocity, so
  // there is no visible "switch on" moment and it never leaves its spot or
  // straightens. Clicking goes to that line's page (plain links). Hover is
  // tested against the resting shape, not the tilted one, so the edges don't
  // flicker as the card moves under the pointer.
  function heroTilt(){
    var fan = $('fan');
    if (!fan || !window.matchMedia) return;
    if (!matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    var MAX_X = 9, MAX_Y = 11, K = 110, C = 2 * Math.sqrt(K);   // critically damped
    var cards = Array.prototype.map.call(fan.querySelectorAll('.card'), function(el){
      return { el: el, base: parseFloat(getComputedStyle(el).getPropertyValue('--base')) || 0,
        s: { rx: [0, 0, 0], ry: [0, 0, 0], g: [0, 0, 0], gx: [50, 0, 50], gy: [50, 0, 50] } };   // [value, velocity, target]
    });
    var raf = 0, last = 0;
    function local(card, px, py){
      var f = fan.getBoundingClientRect(), el = card.el;
      var w = el.offsetWidth, h = el.offsetHeight;
      var dx = px - (f.left + el.offsetLeft + w / 2), dy = py - (f.top + el.offsetTop + h / 2);
      var a = -card.base * Math.PI / 180, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      return { inside: Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2, nx: dx / (w / 2), ny: dy / (h / 2), u: lx / w + 0.5, v: ly / h + 0.5 };
    }
    function aim(p){
      var hit = null;
      if (p) for (var i = cards.length - 1; i >= 0; i--) { var q = local(cards[i], p.x, p.y); if (q.inside) { hit = { card: cards[i], q: q }; break; } }
      cards.forEach(function(c){
        var s = c.s, on = hit && hit.card === c;
        s.rx[2] = on ? -Math.max(-1, Math.min(1, hit.q.ny)) * MAX_X : 0;
        s.ry[2] = on ? Math.max(-1, Math.min(1, hit.q.nx)) * MAX_Y : 0;
        s.g[2] = on ? 1 : 0;
        if (on) {
          if (s.g[0] < 0.02) { s.gx[0] = hit.q.u * 100; s.gy[0] = hit.q.v * 100; }   // glare invisible: place it, don't slide it in
          s.gx[2] = hit.q.u * 100; s.gy[2] = hit.q.v * 100;
        }
      });
      if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
    }
    function step(v, dt){ v[1] += ((v[2] - v[0]) * K - v[1] * C) * dt; v[0] += v[1] * dt; }
    function tick(t){
      var dt = last ? Math.min((t - last) / 1000, 1 / 30) : 1 / 60, busy = false;
      last = t;
      cards.forEach(function(c){
        var s = c.s, st = c.el.style;
        ['rx', 'ry', 'g', 'gx', 'gy'].forEach(function(k){
          step(s[k], dt);
          if (Math.abs(s[k][2] - s[k][0]) > 0.01 || Math.abs(s[k][1]) > 0.01) busy = true;
        });
        var rest = !busy && s.g[2] === 0;
        st.setProperty('--rx', (rest ? 0 : s.rx[0]).toFixed(3) + 'deg');
        st.setProperty('--ry', (rest ? 0 : s.ry[0]).toFixed(3) + 'deg');
        st.setProperty('--sx', (-s.ry[0] / MAX_Y * 10).toFixed(2) + 'px');
        st.setProperty('--sy', (s.rx[0] / MAX_X * 10).toFixed(2) + 'px');
        st.setProperty('--g', Math.max(0, Math.min(1, s.g[0])).toFixed(3));
        st.setProperty('--gx', s.gx[0].toFixed(1) + '%');
        st.setProperty('--gy', s.gy[0].toFixed(1) + '%');
      });
      raf = busy ? requestAnimationFrame(tick) : 0;
    }
    fan.addEventListener('pointermove', function(e){ if (e.pointerType === 'mouse' || e.pointerType === 'pen') aim({ x: e.clientX, y: e.clientY }); });
    fan.addEventListener('pointerleave', function(){ aim(null); });
    window.addEventListener('blur', function(){ aim(null); });
  }

  if ($('soonPage')) renderSoon(); else if ($('gridLive')) { renderHome(); heroTilt(); }
  if ($('footLines')) $('footLines').innerHTML += L.list.map(function(l){
    return l.status === 'live'
      ? '<a href="' + esc(l.url) + '">' + esc(l.name) + '</a>'
      : '<a href="' + esc(l.url) + '" class="dim">' + esc(l.name) + ' (soon)</a>';
  }).join('');
  try { $('yr').textContent = new Date().getFullYear(); } catch (e) {}

  // Notify-me / suggestion forms → /api/waitlist.
  document.addEventListener('submit', function(e){
    var f = e.target;
    if (!f.classList || !f.classList.contains('notify')) return;
    e.preventDefault();
    var line = f.getAttribute('data-line');
    var msg = f.querySelector('.msg'), btn = f.querySelector('button');
    var email = f.querySelector('input[name=email]'), idea = f.querySelector('input[name=idea]');
    var val = (email || idea).value.trim();
    if (!val || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val))) {
      msg.className = 'msg err';
      msg.textContent = email ? 'Please enter a valid email.' : 'Tell us your idea first.';
      (email || idea).focus();
      return;
    }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Sending…';
    fetch('/api/waitlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: line, email: email ? val : '', idea: idea ? val : '', source: 'home', website: f.querySelector('input[name=website]').value })
    }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) throw new Error((res.j && res.j.error) || 'Could not save that. Please try again.');
        msg.className = 'msg ok';
        msg.textContent = idea ? 'Filed with the Bureau. Thank you!' : "You're on the list. We'll email you when it opens.";
        (email || idea).value = '';
        try { window.PLFTrack && window.PLFTrack.event && window.PLFTrack.event('other', 'waitlist_signup_' + line); } catch (err) {}
      })
      .catch(function(err){ msg.className = 'msg err'; msg.textContent = (err && err.name === 'Error' && err.message) || 'Could not save that. Please try again.'; })
      .then(function(){ btn.disabled = false; });
  });
})();
