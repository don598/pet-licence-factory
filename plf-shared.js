'use strict';
// ═══════════════════════════════════════════════════════════
// Pet Licence Factory — Shared Engine
// Common logic used by both desktop (game.html) and mobile (mobile.html)
// ═══════════════════════════════════════════════════════════

// ── DOM helper ──
const $ = id => document.getElementById(id);
function setBg(el, url) { el.style.backgroundImage = `url('${url}')`; }
function clamp(min, v, max) { return Math.max(min, Math.min(max, v)); }

// ═══════════════════════════════════════════════════════════
// ORDER SUBMISSION (server-side via Netlify Function)
// ═══════════════════════════════════════════════════════════
async function submitOrderToSupabase(orderData) {
  const resp = await fetch('/.netlify/functions/submit-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      petFirstName: orderData.petFirstName || '',
      petLastName:  orderData.petLastName  || '',
      dlNumber:     orderData.dlNumber     || '',
      dob:          orderData.dob          || '',
      expDate:      orderData.expDate      || '',
      issDate:      orderData.issDate      || '',
      addrLine1:    orderData.addrLine1    || '',
      addrLine2:    orderData.addrLine2    || '',
      sex:          orderData.sex          || '',
      height:       orderData.height       || '',
      weight:       orderData.weight       || '',
      eyeColor:     orderData.eyeColor     || '',
      photo:        orderData.photo        || null,
      packQty:      orderData.packQty      || 1,
      chipSize:     orderData.chipSize     || 'mini',
      wantsDecal:   orderData.wantsDecal   || false,
      total:        orderData.total        || 0,
    }),
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.error || 'Order submission failed');
  return result.orderId;
}

// ═══════════════════════════════════════════════════════════
// PRICES
// ═══════════════════════════════════════════════════════════
const PRICES = { pack1: 13.95, pack2: 19.99, decal: 4.99, disc: 0.15, stamp: 0.95, standard: 3.99, priority: 7.99 };

// ═══════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════
let petData = {};
let photoDataURL = null;
let chipSize = 'mini';
let packQty = 1;
let wantsDecal = false;
let shippingOption = 'stamp';
let discountEarned = false;
let addrMode = 'fake';

// ═══════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════
let _AC = null;
function ac() { if (!_AC) try { _AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} return _AC; }
function beep(f, d = 0.08, type = 'square', vol = 0.13, delay = 0) {
  const ctx = ac(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  o.type = type; o.frequency.value = f;
  const t = ctx.currentTime + delay;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + d);
  o.start(t); o.stop(t + d);
}
function jingle(notes) { notes.forEach(({ f, d = 0.1, t = 0 }) => setTimeout(() => beep(f, d), t)); }
function sfxType()  { beep(680, .018, 'square', .05); }
function sfxClick() { beep(440, .05); setTimeout(() => beep(660, .07), 50); }
function sfxDone()  { jingle([{ f: 523, t: 0 }, { f: 659, t: 95 }, { f: 784, t: 190 }, { f: 1047, t: 285 }]); }
function sfxErr()   { beep(180, .18, 'sawtooth', .3); }

// ═══════════════════════════════════════════════════════════
// NAV SYSTEM
// ═══════════════════════════════════════════════════════════
let _nextFn = null, _backFn = null;

function setNav(nextFn, backFn, nextTxt = 'NEXT ▶', backTxt = '◀ BACK') {
  _nextFn = nextFn; _backFn = backFn;
  const nb = $('nav-next'), bb = $('nav-back');
  nb.textContent = nextTxt;
  bb.textContent = backTxt;
  nb.classList.toggle('hidden', !nextFn);
  bb.classList.toggle('hidden', !backFn);
  // Platform hook for repositioning nav (desktop only)
  if (typeof onNavUpdated === 'function') onNavUpdated();
}
function navNext() { sfxClick(); if (_nextFn) _nextFn(); }
function navBack() { sfxClick(); if (_backFn) _backFn(); }

// ═══════════════════════════════════════════════════════════
// DIALOGUE RUNNER
// ═══════════════════════════════════════════════════════════
function runDialogue(stn, lines, onDone, backFn = null) {
  let idx = 0;
  function advance() {
    if (idx >= lines.length) { onDone(); return; }
    setNav(null, backFn);
    const text = typeof lines[idx] === 'function' ? lines[idx]() : lines[idx];
    idx++;
    typewrite(stn, text, () => {
      if (idx >= lines.length) onDone();
      else setNav(() => advance(), backFn, 'NEXT ▶');
    });
  }
  advance();
}

// ═══════════════════════════════════════════════════════════
// SPRITE ANIMATION
// ═══════════════════════════════════════════════════════════
const SPRITE_FRAMES = 6, SPRITE_FPS = 7;
let spriteFrame = 0, birdFrame = 0, birdTick = 0, spriteInterval = null;
const ANIMATED_SPRITES = ['s1-sprite', 's3-sprite', 's4-sprite', 's5-sprite'];

function tickSprite() {
  ANIMATED_SPRITES.forEach(id => {
    const el = $(id); if (!el) return;
    const w = Math.round(el.offsetWidth);
    el.style.backgroundSize     = `${w * SPRITE_FRAMES}px auto`;
    el.style.backgroundPosition = `${-spriteFrame * w}px 0`;
  });
  const bird = $('s2-sprite');
  if (bird) {
    const w = Math.round(bird.offsetWidth);
    bird.style.backgroundSize     = `${w * SPRITE_FRAMES}px auto`;
    bird.style.backgroundPosition = `${-birdFrame * w}px 0`;
    birdTick++;
    if (birdTick % 2 === 0) birdFrame = (birdFrame + 1) % SPRITE_FRAMES;
  }
  spriteFrame = (spriteFrame + 1) % SPRITE_FRAMES;
}
window.addEventListener('resize', tickSprite);

function ensureSpriteLoop() {
  if (!spriteInterval) {
    tickSprite();
    spriteInterval = setInterval(tickSprite, 1000 / SPRITE_FPS);
  }
}

// ═══════════════════════════════════════════════════════════
// STATION DIALOGUE LINES
// ═══════════════════════════════════════════════════════════
const S1_LINES = [
  "Want a licence, huh? I'm gonna need your pet's info. Fill out that form and make it snappy. I have a nap scheduled in exactly 10 minutes.",
];
const S1_POST_FORM = [
  "About time. Now get yourself over to the photographer. And tell them not to take all day — some of us have things to do.",
];

// ═══════════════════════════════════════════════════════════
// FORM UTILITIES
// ═══════════════════════════════════════════════════════════
function fmtDob(el) {
  let v = el.value.replace(/\D/g, '');
  if (v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
  if (v.length >= 6) v = v.slice(0, 5) + '/' + v.slice(5, 7);
  el.value = v;
}

function validateAndBuildPetData() {
  const first = $('fFirst').value.trim(), last = $('fLast').value.trim();
  const dob = $('fDob').value.trim(), sex = $('fSex').value;
  const species = $('fSpecies').value, eyes = $('fEyes').value;
  const weight = $('fWeight').value.trim(), height = $('fHeight').value.trim();
  const missing = !first || !last || !dob || !sex || !species || !eyes || !weight || !height;
  const badDob = !/^\d{2}\/\d{2}\/\d{2}$/.test(dob);
  if (missing || badDob) {
    return { error: badDob && !missing ? '⚠ DATE FORMAT: MM/DD/YY' : '⚠ PLEASE COMPLETE ALL FIELDS' };
  }
  if (addrMode === 'real') {
    const a1 = $('fAddr1').value.trim(), a2 = $('fAddr2').value.trim();
    if (!a1 || !a2) return { error: '⚠ PLEASE COMPLETE ALL FIELDS' };
  }
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const iss  = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${String(now.getFullYear()).slice(2)}`;
  const exp  = new Date(now); exp.setFullYear(now.getFullYear() + 4);
  const expS = `${pad(exp.getMonth() + 1)}/${pad(exp.getDate())}/${String(exp.getFullYear()).slice(2)}`;
  const classMap = { DOG: 'D', CAT: 'C', RABBIT: 'R', HAMSTER: 'H', BIRD: 'B', OTHER: 'X' };
  return {
    data: {
      petFirstName: first.toUpperCase(), petLastName: last.toUpperCase(),
      dlNumber: String(Math.floor(1000000000 + Math.random() * 8999999999)),
      dob, issDate: iss, expDate: expS, sex, species, eyeColor: eyes, weight,
      height: height.toUpperCase(), licenceClass: classMap[species] || 'D',
      restrictions: 'H', addrMode,
      addrLine1: addrMode === 'real' ? $('fAddr1').value.trim() : '456 Woofington Drive',
      addrLine2: addrMode === 'real' ? $('fAddr2').value.trim() : 'Tailwag, TX 76543',
    }
  };
}

// ═══════════════════════════════════════════════════════════
// LICENCE COMPOSITOR
// ═══════════════════════════════════════════════════════════
const licCanvas = $('licence-canvas');
const licCtx    = licCanvas.getContext('2d');
let licTemplate = null, _licDPR = 1;
const TW = 1322, TH = 830;

// Field coordinates calibrated from Blank Card cropped.jpeg (1322×830)
const F = {
  dlNumber:  { x: 439, y: 197, w: 257, h: 61 },
  expDate:   { x: 719, y: 200, w: 243, h: 41 },
  issDate:   { x: 719, y: 241, w: 243, h: 41 },
  dob:       { x: 472, y: 263, w: 189, h: 60 },
  firstName: { x: 374, y: 333, w: 345, h: 80 },
  lastName:  { x: 374, y: 413, w: 345, h: 79 },
  addrLine1: { x: 374, y: 531, w: 325, h: 41 },
  addrLine2: { x: 374, y: 572, w: 325, h: 41 },
  signature: { x: 1027, y: 591, w: 176, h: 64 },
  height:    { x: 747, y: 625, w: 109, h: 48 },
  sex:       { x: 435, y: 626, w: 65, h: 48 },
  weight:    { x: 496, y: 683, w: 53, h: 47 },
  eyes:      { x: 718, y: 683, w: 76, h: 47 },
  licClass:  { x: 476, y: 737, w: 62, h: 48 },
  restrict:  { x: 856, y: 737, w: 71, h: 48 },
  photoMain: { x: 971, y: 222, w: 285, h: 433 }
};

function sc(v, h) { return v * (h ? licCanvas.width / TW : licCanvas.height / TH); }
function sf(k) { const f = F[k]; return { x: sc(f.x, 1), y: sc(f.y, 0), w: sc(f.w, 1), h: sc(f.h, 0) }; }

function resizeLicCanvas() {
  const wrap = $('licence-preview-wrap') || $('m-lic-wrap');
  if (!wrap) return;
  const cw = wrap.offsetWidth || 260;
  _licDPR = Math.min(window.devicePixelRatio || 1, 3);
  const ch = Math.round(cw * (TH / TW));
  licCanvas.width  = Math.round(cw * _licDPR);
  licCanvas.height = Math.round(ch * _licDPR);
  licCanvas.style.width  = cw + 'px';
  licCanvas.style.height = ch + 'px';
  licCtx.imageSmoothingEnabled = true;
  licCtx.imageSmoothingQuality = 'high';
  if (licTemplate) refreshLicPreview(); else drawLicPlaceholder();
}

function drawLicPlaceholder() {
  const cw = licCanvas.width, ch = licCanvas.height;
  licCtx.fillStyle = '#100800'; licCtx.fillRect(0, 0, cw, ch);
  licCtx.fillStyle = '#3a2210';
  licCtx.font = `bold ${Math.floor(cw * .065)}px 'Press Start 2P',monospace`;
  licCtx.textAlign = 'center'; licCtx.textBaseline = 'middle';
  licCtx.fillText('LICENCE', cw / 2, ch / 2 - 9);
  licCtx.fillText('PREVIEW', cw / 2, ch / 2 + 11);
}

function refreshLicPreview() {
  if (!licTemplate) return;
  const cw = licCanvas.width, ch = licCanvas.height;
  licCtx.drawImage(licTemplate, 0, 0, cw, ch);
  const addr = petData.addrMode === 'woofington' || !petData.addrLine1
    ? { l1: '456 Woofington Drive', l2: 'Tailwag, TX 76543' }
    : { l1: petData.addrLine1 || '', l2: petData.addrLine2 || '' };
  const tfs = [
    { k: 'dlNumber',  v: petData.dlNumber || '',          c: '#1a0a00' },
    { k: 'expDate',   v: `EXP ${petData.expDate || ''}`,  c: '#1a0a00' },
    { k: 'issDate',   v: `ISS ${petData.issDate || ''}`,  c: '#1a0a00' },
    { k: 'dob',       v: petData.dob || '',                c: '#c0200a' },
    { k: 'firstName', v: petData.petFirstName || '',       c: '#1a0a00' },
    { k: 'lastName',  v: petData.petLastName || '',        c: '#1a0a00' },
    { k: 'addrLine1', v: addr.l1,                         c: '#1a0a00' },
    { k: 'addrLine2', v: addr.l2,                         c: '#1a0a00' },
    { k: 'height',    v: petData.height || '',             c: '#1a0a00' },
    { k: 'sex',       v: petData.sex || '',                c: '#1a0a00' },
    { k: 'weight',    v: petData.weight || '',             c: '#1a0a00' },
    { k: 'eyes',      v: petData.eyeColor || '',           c: '#1a0a00' },
    { k: 'licClass',  v: petData.licenceClass || '',       c: '#1a0a00' },
    { k: 'restrict',  v: petData.restrictions || 'NONE',   c: '#1a0a00' }
  ];
  licCtx.textBaseline = 'middle';
  const pxFloor = 4 * _licDPR, pxCap = 9 * _licDPR;
  tfs.forEach(({ k, v, c }) => {
    const f = sf(k);
    let px = Math.max(pxFloor, Math.min(f.h * .45, f.w * .12, pxCap));
    licCtx.fillStyle = c; licCtx.textAlign = 'left';
    licCtx.font = `${px}px 'Press Start 2P',monospace`;
    while (licCtx.measureText(v).width > f.w - 6 && px > pxFloor) {
      px -= 0.3;
      licCtx.font = `${px}px 'Press Start 2P',monospace`;
    }
    licCtx.fillText(v, f.x + 3, f.y + f.h / 2, f.w - 6);
  });
  // Signature (cursive)
  const sig = sf('signature');
  const fullName = `${petData.petFirstName || ''} ${petData.petLastName || ''}`;
  licCtx.fillStyle = '#1a0a00'; licCtx.textAlign = 'center';
  let sPx = Math.min(sig.h * .65, 13 * _licDPR);
  licCtx.font = `${sPx}px 'Sacramento',cursive`;
  while (licCtx.measureText(fullName).width > sig.w - 4 && sPx > 5 * _licDPR) {
    sPx -= 0.5;
    licCtx.font = `${sPx}px 'Sacramento',cursive`;
  }
  licCtx.fillText(fullName, sig.x + sig.w / 2, sig.y + sig.h / 2);
  // Photo
  if (cropImg) {
    const mp = sf('photoMain');
    licCtx.save();
    licCtx.beginPath(); licCtx.rect(mp.x, mp.y, mp.w, mp.h); licCtx.clip();
    licCtx.save();
    licCtx.translate(mp.x + cropOffX * (mp.w / cropCanvas.width), mp.y + cropOffY * (mp.h / cropCanvas.height));
    licCtx.scale(cropScale * (mp.w / cropCanvas.width), cropScale * (mp.h / cropCanvas.height));
    licCtx.drawImage(cropImg, 0, 0);
    licCtx.restore();
    licCtx.restore();
  }
}

function loadLicenceTemplate() {
  if (licTemplate) { refreshLicPreview(); return; }
  const img = new Image();
  img.onload = () => { licTemplate = img; resizeLicCanvas(); refreshLicPreview(); };
  img.onerror = () => drawLicPlaceholder();
  img.src = A.template;
}

// ═══════════════════════════════════════════════════════════
// CROP CANVAS (shared core — platform adds touch/mouse wiring)
// ═══════════════════════════════════════════════════════════
const cropCanvas = $('crop-canvas');
const cropCtx    = cropCanvas.getContext('2d');
let cropImg = null, cropScale = 1, cropOffX = 0, cropOffY = 0;
let cropDrag = false, cropLast = { x: 0, y: 0 };

function drawCrop() {
  const cw = cropCanvas.width, ch = cropCanvas.height;
  cropCtx.fillStyle = '#100800'; cropCtx.fillRect(0, 0, cw, ch);
  if (!cropImg) {
    cropCtx.fillStyle = '#3a2210'; cropCtx.textAlign = 'center'; cropCtx.textBaseline = 'middle';
    cropCtx.font = `bold ${Math.floor(cw * .09)}px 'Press Start 2P',monospace`;
    cropCtx.fillText('UPLOAD', cw / 2, ch / 2 - 10);
    cropCtx.fillText('PHOTO', cw / 2, ch / 2 + 12);
    return;
  }
  cropCtx.save();
  cropCtx.translate(cropOffX, cropOffY);
  cropCtx.scale(cropScale, cropScale);
  cropCtx.drawImage(cropImg, 0, 0);
  cropCtx.restore();
  // Guide ellipse
  cropCtx.strokeStyle = 'rgba(200,146,42,.55)'; cropCtx.lineWidth = 1.5; cropCtx.setLineDash([4, 4]);
  cropCtx.beginPath(); cropCtx.ellipse(cw / 2, ch / 2, cw * .38, ch * .46, 0, 0, Math.PI * 2);
  cropCtx.stroke(); cropCtx.setLineDash([]);
}

function handlePhotoFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      cropImg = img;
      const cw = cropCanvas.width;
      const r = Math.max(cw / img.width, cw / img.height);
      cropScale = r;
      cropOffX = (cw - img.width * r) / 2;
      cropOffY = (cw - img.height * r) / 2;
      drawCrop(); refreshLicPreview();
      $('approve-btn').disabled = false;
      beep(660, .08);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════════════
// ORDER CALCULATIONS
// ═══════════════════════════════════════════════════════════
function calcOrder() {
  const base = packQty === 2 ? PRICES.pack2 : PRICES.pack1;
  const dec  = wantsDecal ? PRICES.decal : 0;
  const disc = discountEarned ? (base + dec) * PRICES.disc : 0;
  const ship = PRICES[shippingOption] || PRICES.stamp;
  return { base, dec, disc, ship, total: parseFloat((base + dec - disc + ship).toFixed(2)) };
}

function buildOrderSummaryHTML(cssPrefix) {
  // cssPrefix: '' for desktop classes, 'm-' for mobile classes
  const p = cssPrefix || '';
  const { base, dec, disc, ship, total } = calcOrder();
  let h = `<div class="${p}order-line"><span>${packQty}-Pack Licence Sticker${packQty > 1 ? 's' : ''}</span><span>$${base.toFixed(2)}</span></div>`;
  if (wantsDecal) h += `<div class="${p}order-line"><span>8×8" Vinyl Car Decal</span><span>+$${PRICES.decal.toFixed(2)}</span></div>`;
  if (discountEarned) {
    const discColor = p ? 'color:#00ff41' : 'color:#4caf50';
    h += `<div class="${p}order-line" style="${discColor}"><span>Discount (15%)</span><span>-$${disc.toFixed(2)}</span></div>`;
  }
  const shipNames = { stamp: p ? 'Stamp Mail (USPS)' : 'Stamp Shipping', standard: 'Standard Shipping', priority: 'Priority Shipping' };
  h += `<div class="${p}order-line"><span>${shipNames[shippingOption] || 'Shipping'}</span><span>+$${ship.toFixed(2)}</span></div>`;
  h += `<div class="${p}order-line ${p}total"><span>TOTAL</span><span>$${total.toFixed(2)}</span></div>`;
  return h;
}

async function processCheckout() {
  const { base, dec, disc, ship, total } = calcOrder();
  const orderData = {
    ...petData, photo: photoDataURL, chipSize, packQty,
    wantsDecal, basePrice: base, decalAmt: dec, shippingOption, shippingAmt: ship,
    discountEarned, total
  };
  let orderId = null;
  try {
    orderId = await submitOrderToSupabase(orderData);
    orderData.orderId = orderId;
  } catch (err) {
    console.error('Supabase order save failed:', err);
  }
  window.PLF_ORDER = { ...orderData, orderId };
  window.parent.postMessage({ type: 'PLF_CHECKOUT', data: { ...orderData, orderId } }, '*');
  return orderData;
}

// ═══════════════════════════════════════════════════════════
// MINI-GAME ENGINE (shared state & stage management)
// ═══════════════════════════════════════════════════════════
const MG  = $('mg-overlay');
const MGC = $('mg-canvas');
const MGX = MGC.getContext('2d');
let mgStage = 0, mgTimer = null, mgFrame = 0;

function stopMGTimer() { if (mgTimer) { clearInterval(mgTimer); mgTimer = null; } }
function mgMsg(txt, col) { const el = $('mg-msg'); el.style.color = col || _mgTheme.msgColor; el.textContent = txt; }

function updatePips() {
  ['pip1', 'pip2', 'pip3'].forEach((id, i) => {
    const el = $(id); el.className = 'mg-pip';
    if (i + 1 < mgStage) el.classList.add('done');
    else if (i + 1 === mgStage) el.classList.add('active');
  });
}

function setMGStage(n) {
  mgStage = n; mgFrame = 0; updatePips(); stopMGTimer();
  $('mg-org-btn').style.display = 'none';
  $('mg-msg').textContent = '';
  if (n === 1) startStage1();
  else if (n === 2) startStage2();
  else if (n === 3) startStage3();
}

function advanceStage() {
  stopMGTimer();
  if (mgStage >= 3) { onMGComplete(); return; }
  setTimeout(() => setMGStage(mgStage + 1), 1000);
}

// ── Mini-game theme (set by platform before starting) ──
let _mgTheme = {
  // Colors for mini-game rendering — defaults are desktop (gold/brown)
  bg: '#0d0800', floor: '#1a0e04', floorAlt: '#3a2208',
  belt1: '#221406', belt2: '#2e1a08', beltStroke: '#4a2c10',
  msgColor: '#f0c050', winColor: '#4caf50',
  dustCore: '#c8b8a8', dustMid: '#907060', dustEdge: 'rgba(70,50,30,0)',
  dustFuzz: 'rgba(160,130,100,.55)',
  clawRope: '#c0c0b0', clawStroke: '#b0b0a0',
  hingeInner: '#f0e8d0', hingeMid: '#e8e0c0', hingeOuter: '#a8a080',
  grabFlash: '#f0c050', clearParticle: '#90d0a0',
  cheeseBody: '#f0c050', cheeseDark: '#c8922a',
  nearGlow: 'rgba(255,200,0,.3)', nearBody: '#d0b080',
  mouseBody: '#b0a098',
  catchParticle1: 'rgba(200,100,150,', catchParticle2: 'rgba(176,160,144,',
  vacMachGrad1: '#4a3a6a', vacMachGrad2: '#2a1a4a', vacMachStroke: '#c8922a',
  vacHose: '#8a6a2a', vacHoseStripe: '#c8a040',
  vacNozzleGlow: 'rgba(200,200,80,.55)', vacNozzleFill: '#c8a040',
  vacGrid: '#160820', vacFloor: '#08060a',
  vacSuckAura: '#f0c050', vacProgress: '#4caf50', vacProgressBg: '#2a1a08',
  vacLabel: '#f0c050',
  dustDebrisCore: '#c8b8a8', dustDebrisMid: '#907060',
  counterColor: '#c8922a',
};

function setMGTheme(theme) { Object.assign(_mgTheme, theme); }

// ── Stage 1: Mouse Chase ──
let mice = [], cheeses = [], s1mice = 0, s1particles = [], s1CheeseDropped = 0, s1FloorOffset = 0;

function startStage1() {
  $('mg-title-txt').textContent = '🐭 STAGE 1: MOUSE CHASE';
  mgMsg('Drop cheese to catch 3 mice! Click anywhere on the canvas.');
  mice = []; cheeses = []; s1particles = []; s1mice = 0; s1CheeseDropped = 0; mgFrame = 0; s1FloorOffset = 0;
  const cw = MGC.width, ch = MGC.height;
  for (let i = 0; i < 5; i++) mice.push({
    x: 20 + Math.random() * (cw - 40), y: 20 + Math.random() * (ch - 40),
    vx: (Math.random() - .5) * 3, vy: (Math.random() - .5) * 3,
    alive: true, ph: Math.random() * Math.PI * 2, dirChangeCtr: 0, nearCheese: false
  });

  function handleTap(cx, cy) {
    cheeses.push({ x: cx, y: cy, life: 220 }); s1CheeseDropped++;
    for (let i = 0; i < 8; i++) s1particles.push({
      x: cx, y: cy, vx: (Math.random() - .5) * 2, vy: (Math.random() - 1) * 2,
      life: 60, c: 'rgba(240,192,80,'
    });
    beep(440, .05);
  }

  MGC.onclick = e => {
    const r = MGC.getBoundingClientRect();
    handleTap((e.clientX - r.left) * (MGC.width / r.width), (e.clientY - r.top) * (MGC.height / r.height));
  };
  // Platform touch handlers added by each version if needed
  if (typeof setupMGTouchStage1 === 'function') setupMGTouchStage1(handleTap);

  mgTimer = setInterval(tickStage1, 1000 / 30);
}

function tickStage1() {
  mgFrame++;
  const T = _mgTheme;
  const cw = MGC.width, ch = MGC.height;
  MGX.fillStyle = T.bg; MGX.fillRect(0, 0, cw, ch);

  // Floor
  s1FloorOffset = (s1FloorOffset + 1.5) % 24;
  MGX.fillStyle = T.floor;
  for (let x = s1FloorOffset - 24; x < cw; x += 24) MGX.fillRect(x, ch - 18, 12, 18);
  MGX.strokeStyle = T.floorAlt; MGX.lineWidth = 2; MGX.strokeRect(0, ch - 20, cw, 20);

  // Particles
  s1particles = s1particles.filter(p => p.life > 0);
  s1particles.forEach(p => {
    p.life--; p.x += p.vx; p.y += p.vy;
    const alpha = Math.min(1, p.life / 30);
    MGX.globalAlpha = alpha;
    MGX.fillStyle = p.c + alpha + ')';
    MGX.beginPath(); MGX.arc(p.x, p.y, 2, 0, Math.PI * 2); MGX.fill();
    MGX.globalAlpha = 1;
  });

  // Cheese counter
  MGX.fillStyle = T.counterColor;
  MGX.font = 'bold ' + clamp(8, MGC.width * 0.04, 12) + 'px monospace';
  MGX.textAlign = 'right';
  MGX.fillText('Cheese: ' + s1CheeseDropped, cw - 10, 20);

  // Cheese
  cheeses = cheeses.filter(c => c.life > 0);
  cheeses.forEach(c => {
    c.life--;
    MGX.globalAlpha = Math.min(1, c.life / 30);
    MGX.fillStyle = T.cheeseBody;
    MGX.beginPath(); MGX.moveTo(c.x, c.y - 9); MGX.lineTo(c.x + 11, c.y + 7); MGX.lineTo(c.x - 11, c.y + 7); MGX.closePath(); MGX.fill();
    MGX.fillStyle = T.cheeseDark;
    MGX.beginPath(); MGX.arc(c.x - 2, c.y + 1, 2, 0, Math.PI * 2); MGX.fill();
    MGX.beginPath(); MGX.arc(c.x + 4, c.y + 3, 1.5, 0, Math.PI * 2); MGX.fill();
    MGX.globalAlpha = 1;
  });

  // Mice
  mice.forEach(m => {
    if (!m.alive) return;
    m.ph += .18; m.dirChangeCtr--;
    if (m.dirChangeCtr <= 0 && Math.random() < .02) {
      m.dirChangeCtr = 60;
      const a = Math.random() * Math.PI * 2;
      m.vx = Math.cos(a) * 2; m.vy = Math.sin(a) * 2;
    }
    m.nearCheese = false;
    if (cheeses.length > 0) {
      let near = null, nd = 80;
      cheeses.forEach(c => { const d = Math.hypot(c.x - m.x, c.y - m.y); if (d < nd) { nd = d; near = c; } });
      if (near) { m.nearCheese = true; const a = Math.atan2(near.y - m.y, near.x - m.x); m.vx += Math.cos(a) * .4; m.vy += Math.sin(a) * .4; }
    } else { m.vx += (Math.random() - .5) * .4; m.vy += (Math.random() - .5) * .4; }
    const spd = Math.hypot(m.vx, m.vy);
    if (spd > 3.5) { m.vx = m.vx / spd * 3.5; m.vy = m.vy / spd * 3.5; }
    m.x = Math.max(8, Math.min(cw - 8, m.x + m.vx));
    m.y = Math.max(8, Math.min(ch - 8, m.y + m.vy));
    if (m.x <= 8 || m.x >= cw - 8) m.vx *= -1;
    if (m.y <= 8 || m.y >= ch - 8) m.vy *= -1;

    // Check cheese collision
    cheeses.forEach(c => {
      if (Math.hypot(c.x - m.x, c.y - m.y) < 18) {
        m.alive = false; s1mice++;
        for (let i = 0; i < 16; i++) s1particles.push({ x: m.x, y: m.y, vx: (Math.random() - .5) * 5, vy: (Math.random() - .5) * 5, life: 80, c: T.catchParticle1 });
        for (let i = 0; i < 8; i++) s1particles.push({ x: m.x + (Math.random() - .5) * 8, y: m.y + (Math.random() - .5) * 8, vx: (Math.random() - .5) * 3, vy: (Math.random() - .5) * 3, life: 60, c: T.catchParticle2 });
        beep(880, .1); setTimeout(() => beep(1100, .08), 100);
        mgMsg(`Mice caught: ${s1mice} / 3`);
        if (s1mice >= 3) {
          stopMGTimer(); MGC.onclick = null;
          if (typeof cleanupMGTouch === 'function') cleanupMGTouch();
          mgMsg('🎉 NICE WORK!! Moving to Stage 2!', T.winColor);
          jingle([{ f: 660, t: 0 }, { f: 880, t: 120 }, { f: 1100, t: 240 }]);
          setTimeout(() => advanceStage(), 1400);
        }
      }
    });
    if (!m.alive) return;
    const dir = m.vx >= 0 ? 1 : -1;

    // Near-cheese glow
    if (m.nearCheese) {
      MGX.fillStyle = T.nearGlow;
      MGX.beginPath(); MGX.arc(m.x, m.y, 10, 0, Math.PI * 2); MGX.fill();
    }

    // Draw mouse body
    MGX.fillStyle = m.nearCheese ? T.nearBody : T.mouseBody;
    MGX.fillRect(m.x - 7, m.y - 3, 14, 6); MGX.fillRect(m.x + dir * 4, m.y - 4, 7 * dir, 8);
    MGX.fillStyle = '#e0c0c0'; MGX.fillRect(m.x + dir * 7, m.y - 6, 2 * dir, 4);
    MGX.fillStyle = '#ff4040'; MGX.fillRect(m.x + dir * 9, m.y - 2, 2, 2);
    // Ears
    MGX.fillStyle = T.mouseBody;
    MGX.beginPath(); MGX.arc(m.x + dir * (-3), m.y - 6, 2.5, 0, Math.PI * 2); MGX.fill();
    MGX.fillStyle = '#ff6060';
    MGX.beginPath(); MGX.arc(m.x + dir * (-3), m.y - 6, 1.2, 0, Math.PI * 2); MGX.fill();
    // Whiskers
    MGX.strokeStyle = '#888'; MGX.lineWidth = 1;
    for (let w = -1; w <= 1; w += 2) {
      MGX.beginPath(); MGX.moveTo(m.x + dir * 2, m.y + w); MGX.lineTo(m.x + dir * 11, m.y + w); MGX.stroke();
    }
    MGX.beginPath(); MGX.moveTo(m.x - dir * 7, m.y + 1);
    MGX.quadraticCurveTo(m.x - dir * 12, m.y - 4, m.x - dir * 14, m.y + 6); MGX.stroke();
  });
}

// ── Stage 2: Dust Buster ──
let dustBalls = [], clawState = null, dustQueue = [], dustCleared = 0, s2particles = [];

function startStage2() {
  $('mg-title-txt').textContent = '🧹 STAGE 2: DUST BUSTER';
  mgMsg('Tap all 4 dust balls to clean them up!');
  dustBalls = []; dustQueue = []; s2particles = []; dustCleared = 0; clawState = null;
  const cw = MGC.width, ch = MGC.height;
  for (let i = 0; i < 4; i++) dustBalls.push({
    x: 60 + Math.random() * (cw - 120), y: 40 + Math.random() * (ch - 80),
    r: clamp(14, 0.025 * cw, 22), ph: Math.random() * Math.PI * 2, speed: 0.8 + Math.random() * .8,
    alive: true, idx: i, targeted: false, grabbed: false, frozenX: undefined, isFrozen: false,
    eyeL: { x: -3, y: -1 }, eyeR: { x: 3, y: -1 }, scaredLevel: 0, dizzyAngle: 0
  });

  function handleTap(cx, cy) {
    let best = null, bd = 40;
    dustBalls.forEach(b => {
      if (!b.alive || b.grabbed) return;
      const d = Math.hypot(cx - b.x, cy - b.y);
      if (d < Math.max(b.r + 10, bd)) { bd = d; best = b; }
    });
    if (best) {
      dustQueue.push(best.idx); best.targeted = true; beep(550, .06);
      if (!clawState || clawState.state === 'idle') processDustQueue();
    }
  }

  MGC.onclick = e => {
    const r = MGC.getBoundingClientRect();
    handleTap((e.clientX - r.left) * (MGC.width / r.width), (e.clientY - r.top) * (MGC.height / r.height));
  };
  if (typeof setupMGTouchStage2 === 'function') setupMGTouchStage2(handleTap);

  mgTimer = setInterval(tickStage2, 1000 / 30);
}

function processDustQueue() {
  if (dustQueue.length === 0) { clawState = null; return; }
  const idx = dustQueue.shift();
  const ball = dustBalls[idx];
  if (!ball || !ball.alive) { processDustQueue(); return; }
  const t = mgFrame * 0.05;
  const visualX = ball.x + Math.sin(t * ball.speed + ball.ph) * 9;
  ball.frozenX = visualX;
  clawState = { x: visualX, y: 0, targetY: ball.y - ball.r, ball, state: 'descending', grabTimer: 0 };
}

function tickStage2() {
  mgFrame++;
  const T = _mgTheme;
  const cw = MGC.width, ch = MGC.height, t = mgFrame * 0.05;
  // Background belt
  MGX.fillStyle = T.belt1; MGX.fillRect(0, 0, cw, ch);
  const beltOffset = (mgFrame * 2) % 40;
  MGX.fillStyle = T.belt2;
  for (let y = 0; y < ch; y += 20) MGX.fillRect(0, y, cw, 10);
  MGX.fillStyle = T.beltStroke || T.belt2;
  for (let x = beltOffset - 40; x < cw + 40; x += 40) MGX.fillRect(x, 0, 18, ch);
  MGX.strokeStyle = T.beltStroke; MGX.lineWidth = 1;
  for (let y = 10; y < ch; y += 20) { MGX.beginPath(); MGX.moveTo(0, y); MGX.lineTo(cw, y); MGX.stroke(); }

  // Particles
  s2particles = s2particles.filter(p => p.life > 0);
  s2particles.forEach(p => {
    p.life--; p.x += p.vx * 0.95; p.y += p.vy;
    const alpha = Math.min(1, p.life / 40);
    MGX.globalAlpha = alpha; MGX.fillStyle = p.c;
    MGX.beginPath(); MGX.arc(p.x, p.y, 2, 0, Math.PI * 2); MGX.fill(); MGX.globalAlpha = 1;
  });

  // Dust balls
  dustBalls.forEach(b => {
    if (!b.alive) return;
    const isGrabbed = b.grabbed && clawState && clawState.ball === b;
    const isFrozen = b.targeted && !b.grabbed && b.frozenX !== undefined;
    const wx = isGrabbed ? clawState.x : isFrozen ? b.frozenX : b.x + Math.sin(t * b.speed + b.ph) * 9;
    const wy = isGrabbed ? clawState.y + b.r : b.y;

    if (!isGrabbed && Math.random() < 0.3) {
      s2particles.push({ x: wx + (Math.random() - .5) * 4, y: wy + (Math.random() - .5) * 4, vx: (Math.random() - .5) * .8, vy: (Math.random() - .5) * .8, life: 40, c: T.dustFuzz });
    }

    if (clawState && clawState.state !== 'idle') {
      const dx = clawState.x - wx, dy = clawState.y - wy, d = Math.hypot(dx, dy);
      b.scaredLevel = Math.min(1, b.scaredLevel + 0.1);
      if (d < 60 && d > 0) {
        const a = Math.atan2(dy, dx);
        b.eyeL = { x: -3 + Math.cos(a) * 2, y: -1 + Math.sin(a) * 2 };
        b.eyeR = { x: 3 + Math.cos(a) * 2, y: -1 + Math.sin(a) * 2 };
      }
    } else { b.scaredLevel = Math.max(0, b.scaredLevel - 0.05); }
    if (isGrabbed) b.dizzyAngle += 0.4;

    // Gradient body
    const g = MGX.createRadialGradient(wx, wy, 0, wx, wy, b.r);
    g.addColorStop(0, T.dustCore); g.addColorStop(.65, T.dustMid); g.addColorStop(1, T.dustEdge);
    MGX.fillStyle = g; MGX.beginPath(); MGX.arc(wx, wy, b.r, 0, Math.PI * 2); MGX.fill();
    // Fuzz spikes
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, fuzz = b.r + 3 + Math.sin(t * 3 + i) * 2;
      MGX.strokeStyle = T.dustFuzz; MGX.lineWidth = 1;
      MGX.beginPath(); MGX.moveTo(wx + Math.cos(a) * b.r * .7, wy + Math.sin(a) * b.r * .7);
      MGX.lineTo(wx + Math.cos(a) * fuzz, wy + Math.sin(a) * fuzz); MGX.stroke();
    }
    // Eyes
    if (isGrabbed) {
      MGX.fillStyle = '#fff'; MGX.beginPath(); MGX.arc(wx - b.r * .2, wy - b.r * .2, 2, 0, Math.PI * 2); MGX.fill();
      MGX.beginPath(); MGX.arc(wx + b.r * .2, wy - b.r * .2, 2, 0, Math.PI * 2); MGX.fill();
      MGX.strokeStyle = '#000'; MGX.lineWidth = 1;
      MGX.beginPath(); MGX.arc(wx - b.r * .2, wy - b.r * .2, 3, b.dizzyAngle, b.dizzyAngle + Math.PI); MGX.stroke();
      MGX.beginPath(); MGX.arc(wx + b.r * .2, wy - b.r * .2, 3, b.dizzyAngle + Math.PI, b.dizzyAngle + Math.PI * 2); MGX.stroke();
    } else if (b.scaredLevel > 0.2) {
      const eyeSize = 2 + b.scaredLevel * 1.5;
      MGX.fillStyle = '#fff';
      MGX.beginPath(); MGX.ellipse(wx + b.eyeL.x - b.r * .3, wy + b.eyeL.y - b.r * .3, eyeSize + .5, eyeSize + 1, 0, 0, Math.PI * 2); MGX.fill();
      MGX.beginPath(); MGX.ellipse(wx + b.eyeR.x + b.r * .3, wy + b.eyeR.y - b.r * .3, eyeSize + .5, eyeSize + 1, 0, 0, Math.PI * 2); MGX.fill();
      MGX.fillStyle = '#000';
      MGX.beginPath(); MGX.arc(wx + b.eyeL.x - b.r * .3 + 1, wy + b.eyeL.y - b.r * .3 + .5, .8, 0, Math.PI * 2); MGX.fill();
      MGX.beginPath(); MGX.arc(wx + b.eyeR.x + b.r * .3 + 1, wy + b.eyeR.y - b.r * .3 + .5, .8, 0, Math.PI * 2); MGX.fill();
    } else {
      MGX.fillStyle = '#fff';
      MGX.beginPath(); MGX.arc(wx + b.eyeL.x - b.r * .3, wy + b.eyeL.y - b.r * .3, 2, 0, Math.PI * 2); MGX.fill();
      MGX.beginPath(); MGX.arc(wx + b.eyeR.x + b.r * .3, wy + b.eyeR.y - b.r * .3, 2, 0, Math.PI * 2); MGX.fill();
      MGX.fillStyle = '#000';
      MGX.beginPath(); MGX.arc(wx + b.eyeL.x - b.r * .3 + 1, wy + b.eyeL.y - b.r * .3 + .5, 1, 0, Math.PI * 2); MGX.fill();
      MGX.beginPath(); MGX.arc(wx + b.eyeR.x + b.r * .3 + 1, wy + b.eyeR.y - b.r * .3 + .5, 1, 0, Math.PI * 2); MGX.fill();
    }
    // Mouth
    if (isGrabbed) {
      MGX.fillStyle = '#333'; MGX.beginPath(); MGX.arc(wx, wy + b.r * .35, 1.5, 0, Math.PI * 2); MGX.fill();
    } else if (b.scaredLevel > 0.2) {
      MGX.fillStyle = '#333'; MGX.beginPath(); MGX.arc(wx, wy + b.r * .35, 1.8, 0, Math.PI * 2); MGX.fill();
    } else {
      const mouthWave = Math.sin(t * 2 + b.ph) * 2;
      MGX.strokeStyle = '#333'; MGX.lineWidth = 1; MGX.beginPath();
      MGX.moveTo(wx - 2, wy + b.r * .35);
      MGX.quadraticCurveTo(wx, wy + b.r * .35 + mouthWave, wx + 2, wy + b.r * .35);
      MGX.stroke();
    }
    // Highlight
    MGX.fillStyle = 'rgba(255,255,255,.18)';
    MGX.beginPath(); MGX.ellipse(wx - b.r * .25, wy - b.r * .3, b.r * .35, b.r * .22, -.4, 0, Math.PI * 2); MGX.fill();
  });

  // Claw
  if (clawState && clawState.state !== 'idle') {
    const cl = clawState, spd = MGC.height * 0.018;
    if (cl.state === 'descending') {
      cl.y = Math.min(cl.y + spd, cl.targetY);
      if (cl.y >= cl.targetY) { cl.state = 'closing'; cl.grabTimer = 12; beep(330, .12, 'square'); }
    } else if (cl.state === 'closing') {
      cl.grabTimer--;
      if (cl.grabTimer <= 0) { cl.state = 'ascending'; cl.ball.grabbed = true; beep(550, .08); }
    } else if (cl.state === 'ascending') {
      cl.y = Math.max(cl.y - spd * 1.3, -20);
      if (cl.y < -15) {
        cl.ball.alive = false; dustCleared++;
        for (let i = 0; i < 12; i++) s2particles.push({ x: cl.x, y: cl.y + 30, vx: (Math.random() - .5) * 3, vy: (Math.random() - 1) * 2, life: 80, c: T.clearParticle });
        mgMsg(`Dust balls cleared: ${dustCleared} / 4`);
        if (dustCleared >= 4) {
          stopMGTimer(); MGC.onclick = null;
          if (typeof cleanupMGTouch === 'function') cleanupMGTouch();
          mgMsg('🧹 SPOTLESS!! On to Stage 3!', T.winColor);
          jingle([{ f: 660, t: 0 }, { f: 880, t: 120 }, { f: 1100, t: 240 }]);
          setTimeout(() => advanceStage(), 1400);
        } else processDustQueue();
      }
    }
    // Rope
    MGX.strokeStyle = T.clawRope; MGX.lineWidth = 5;
    MGX.beginPath(); MGX.moveTo(cl.x, 0); MGX.lineTo(cl.x, cl.y - 8); MGX.stroke();
    for (let ry = 0; ry < cl.y - 8; ry += 6) {
      MGX.strokeStyle = T.clawStroke; MGX.lineWidth = 2;
      MGX.beginPath(); MGX.moveTo(cl.x - 2, ry); MGX.lineTo(cl.x + 2, ry); MGX.stroke();
    }
    // Claw arms
    const open = cl.state === 'descending' ? 1 : cl.state === 'closing' ? (cl.grabTimer / 12) : 0;
    MGX.strokeStyle = T.clawStroke; MGX.lineWidth = 2;
    [-1, 1].forEach(side => {
      MGX.beginPath(); MGX.moveTo(cl.x, cl.y - 8);
      MGX.lineTo(cl.x + side * 12 * open, cl.y + 4);
      MGX.lineTo(cl.x + side * 14 * open, cl.y + 14); MGX.stroke();
    });
    // Hinge
    const hg = MGX.createRadialGradient(cl.x - 1, cl.y - 10, 1, cl.x, cl.y - 8, 6);
    hg.addColorStop(0, T.hingeInner); hg.addColorStop(.5, T.hingeMid); hg.addColorStop(1, T.hingeOuter);
    MGX.fillStyle = hg; MGX.beginPath(); MGX.arc(cl.x, cl.y - 8, 5, 0, Math.PI * 2); MGX.fill();
    // Grab flash
    if (cl.state === 'closing') {
      MGX.globalAlpha = cl.grabTimer / 12 * .6;
      MGX.fillStyle = T.grabFlash;
      MGX.beginPath(); MGX.arc(cl.x, cl.y, 20, 0, Math.PI * 2); MGX.fill();
      MGX.globalAlpha = 1;
    }
  }
}

// ── Stage 3: Factory Vacuum ──
let vacDebris = [], vacNozzle = { x: 0, y: 0 }, vacHose = { segments: [] }, vacCleared = 0, vacDone = false, s3particles = [], vacTracking = false;
const VAC_TOTAL = 10;

function startStage3() {
  $('mg-title-txt').textContent = '🌀 STAGE 3: VACUUM DUTY';
  $('mg-org-btn').style.display = 'none';
  vacDebris = []; s3particles = []; vacCleared = 0; vacDone = false; vacTracking = false;
  const cw = MGC.width, ch = MGC.height;
  const machX = cw - 40, machY = 30;
  vacNozzle = { x: machX, y: machY + 60 };
  vacHose.segments = [];
  for (let i = 0; i < 12; i++) vacHose.segments.push({ x: machX, y: machY + 60 + i * 5 });
  const types = ['scrap', 'dust', 'paper', 'coin'];
  for (let i = 0; i < VAC_TOTAL; i++) vacDebris.push({
    x: 30 + Math.random() * (cw - 200), y: 30 + Math.random() * (ch - 60),
    type: types[i % types.length], ph: Math.random() * Math.PI * 2,
    spin: 0, spinV: (Math.random() - .5) * .08,
    vx: 0, vy: 0, alive: true, sucking: false,
    w: 18 + Math.random() * 14, h: 14 + Math.random() * 10,
    col: '#' + Math.floor(Math.random() * 0x333333 + 0xaaaaaa).toString(16),
  });
  mgMsg('Move your mouse to vacuum up all the factory scraps!');

  MGC.onmousemove = e => {
    const r = MGC.getBoundingClientRect();
    vacNozzle.x = (e.clientX - r.left) * (MGC.width / r.width);
    vacNozzle.y = (e.clientY - r.top) * (MGC.height / r.height);
    vacTracking = true;
  };
  if (typeof setupMGTouchStage3 === 'function') setupMGTouchStage3();

  mgTimer = setInterval(tickStage3, 1000 / 30);
}

function tickStage3() {
  mgFrame++;
  const T = _mgTheme;
  const cw = MGC.width, ch = MGC.height, t = mgFrame * .04;
  // Background
  MGX.fillStyle = T.vacFloor; MGX.fillRect(0, 0, cw, ch);
  MGX.strokeStyle = T.vacGrid; MGX.lineWidth = 1;
  for (let gx = 0; gx < cw; gx += 32) { MGX.beginPath(); MGX.moveTo(gx, 0); MGX.lineTo(gx, ch); MGX.stroke(); }
  for (let gy = 0; gy < ch; gy += 32) { MGX.beginPath(); MGX.moveTo(0, gy); MGX.lineTo(cw, gy); MGX.stroke(); }

  // Particles
  s3particles = s3particles.filter(p => p.life > 0);
  s3particles.forEach(p => {
    p.life--; p.x += p.vx; p.y += p.vy; p.vy += 0.12;
    const a = Math.min(1, p.life / 40);
    MGX.globalAlpha = a; MGX.fillStyle = p.c;
    MGX.beginPath(); MGX.arc(p.x, p.y, p.r || 2, 0, Math.PI * 2); MGX.fill(); MGX.globalAlpha = 1;
  });

  // Vacuum machine
  const machX = cw - 70, machY = 8;
  const mg2 = MGX.createLinearGradient(machX, machY, machX + 60, machY + 70);
  mg2.addColorStop(0, T.vacMachGrad1); mg2.addColorStop(1, T.vacMachGrad2);
  MGX.fillStyle = mg2; MGX.fillRect(machX, machY, 60, 70);
  MGX.strokeStyle = T.vacMachStroke; MGX.lineWidth = 2; MGX.strokeRect(machX, machY, 60, 70);
  MGX.fillStyle = mgFrame % 20 < 10 ? '#00ff88' : '#004422';
  MGX.beginPath(); MGX.arc(machX + 10, machY + 12, 5, 0, Math.PI * 2); MGX.fill();
  MGX.fillStyle = T.vacMachStroke;
  MGX.beginPath(); MGX.arc(machX + 30, machY + 58, 9, 0, Math.PI * 2); MGX.fill();
  MGX.fillStyle = T.vacMachGrad2;
  MGX.beginPath(); MGX.arc(machX + 30, machY + 58, 6, 0, Math.PI * 2); MGX.fill();
  MGX.fillStyle = T.vacLabel;
  MGX.font = `${Math.floor(cw * .013)}px 'Press Start 2P',monospace`;
  MGX.textAlign = 'center';
  MGX.fillText('VAC', machX + 30, machY + 32);
  MGX.fillText('3000', machX + 30, machY + 47);

  // Hose
  const hoseAnchorX = machX + 30, hoseAnchorY = machY + 58;
  const segs = vacHose.segments;
  segs[0].x = hoseAnchorX; segs[0].y = hoseAnchorY;
  segs[segs.length - 1].x += (vacNozzle.x - segs[segs.length - 1].x) * .18;
  segs[segs.length - 1].y += (vacNozzle.y - segs[segs.length - 1].y) * .18;
  for (let i = segs.length - 2; i > 0; i--) {
    segs[i].x += (segs[i + 1].x - segs[i].x) * .22;
    segs[i].y += (segs[i + 1].y - segs[i].y) * .22;
  }
  MGX.strokeStyle = T.vacHose; MGX.lineWidth = Math.max(5, cw * .012);
  MGX.lineCap = 'round'; MGX.lineJoin = 'round';
  MGX.beginPath(); MGX.moveTo(segs[0].x, segs[0].y);
  for (let i = 1; i < segs.length; i++) MGX.lineTo(segs[i].x, segs[i].y);
  MGX.stroke();
  MGX.strokeStyle = T.vacHoseStripe; MGX.lineWidth = Math.max(2, cw * .004); MGX.setLineDash([8, 8]);
  MGX.beginPath(); MGX.moveTo(segs[0].x, segs[0].y);
  for (let i = 1; i < segs.length; i++) MGX.lineTo(segs[i].x, segs[i].y);
  MGX.stroke(); MGX.setLineDash([]);

  // Nozzle
  const tip = segs[segs.length - 1];
  const g2 = MGX.createRadialGradient(tip.x, tip.y, 2, tip.x, tip.y, 14);
  g2.addColorStop(0, T.vacNozzleGlow); g2.addColorStop(1, T.vacNozzleGlow.replace(/[\d.]+\)$/, '0)'));
  MGX.fillStyle = g2; MGX.beginPath(); MGX.arc(tip.x, tip.y, 14, 0, Math.PI * 2); MGX.fill();
  MGX.fillStyle = T.vacNozzleFill; MGX.beginPath(); MGX.arc(tip.x, tip.y, 7, 0, Math.PI * 2); MGX.fill();
  MGX.fillStyle = T.vacFloor; MGX.beginPath(); MGX.arc(tip.x, tip.y, 4, 0, Math.PI * 2); MGX.fill();

  // Debris
  vacDebris.forEach(d => {
    if (!d.alive) return;
    const dx = tip.x - d.x, dy = tip.y - d.y, dist = Math.hypot(dx, dy);
    const SUCK_R = cw * .12, PULL_R = cw * .22;
    if (dist < SUCK_R) {
      const pull = 0.25 * (1 - dist / SUCK_R) + 0.12;
      d.vx += dx / dist * pull * 3; d.vy += dy / dist * pull * 3; d.sucking = true;
    } else if (dist < PULL_R) {
      const pull = 0.04 * (1 - dist / PULL_R);
      d.vx += dx / dist * pull * 2; d.vy += dy / dist * pull * 2; d.sucking = false;
    } else {
      d.sucking = false; d.vx += (Math.random() - .5) * .04; d.vy += (Math.random() - .5) * .04;
    }
    d.vx *= 0.88; d.vy *= 0.88; d.x += d.vx; d.y += d.vy;
    d.spin += d.spinV * (d.sucking ? 3 : 1);

    if (dist < 10) {
      d.alive = false; vacCleared++;
      for (let i = 0; i < 10; i++) s3particles.push({ x: tip.x, y: tip.y, vx: (Math.random() - .5) * 3, vy: (Math.random() - 0.1) * -3, life: 50, c: T.vacLabel, r: 2 });
      beep(800 + vacCleared * 30, .06, 'square', .2);
      const remaining = VAC_TOTAL - vacCleared;
      if (remaining > 0) mgMsg(`${remaining} piece${remaining !== 1 ? 's' : ''} left!`);
      if (!vacDone && vacCleared >= VAC_TOTAL) {
        vacDone = true; stopMGTimer(); MGC.onmousemove = null;
        if (typeof cleanupMGVacTouch === 'function') cleanupMGVacTouch();
        mgMsg('🌀 SPOTLESS!! Factory is CLEAN!', T.winColor);
        jingle([{ f: 660, t: 0 }, { f: 880, t: 120 }, { f: 1100, t: 240 }]);
        setTimeout(() => advanceStage(), 1400);
      }
      return;
    }

    // Draw debris
    MGX.save(); MGX.translate(d.x, d.y); MGX.rotate(d.spin);
    if (d.sucking) {
      const shrink = Math.max(0.3, dist / SUCK_R);
      MGX.scale(shrink, shrink);
    }
    if (d.type === 'scrap') {
      MGX.fillStyle = '#d4c8a0'; MGX.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
      MGX.fillStyle = '#3a6aaa'; MGX.fillRect(-d.w / 2, -d.h / 2, d.w, d.h * .3);
      MGX.strokeStyle = 'rgba(0,0,0,.2)'; MGX.lineWidth = 1; MGX.strokeRect(-d.w / 2, -d.h / 2, d.w, d.h);
    } else if (d.type === 'dust') {
      const rg = MGX.createRadialGradient(0, 0, 0, 0, 0, d.w / 2);
      rg.addColorStop(0, T.dustDebrisCore || T.dustCore);
      rg.addColorStop(.7, T.dustDebrisMid || T.dustMid);
      rg.addColorStop(1, T.dustEdge);
      MGX.fillStyle = rg; MGX.beginPath(); MGX.arc(0, 0, d.w / 2, 0, Math.PI * 2); MGX.fill();
      MGX.fillStyle = '#333'; MGX.beginPath(); MGX.arc(-3, -2, 1.5, 0, Math.PI * 2); MGX.fill();
      MGX.beginPath(); MGX.arc(3, -2, 1.5, 0, Math.PI * 2); MGX.fill();
    } else if (d.type === 'paper') {
      MGX.fillStyle = '#e8e0c8'; MGX.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
      MGX.fillStyle = 'rgba(100,80,60,.4)';
      for (let l = 0; l < 3; l++) MGX.fillRect(-d.w * .4, -d.h * .25 + l * d.h * .22, d.w * .7 + Math.sin(l) * d.w * .1, 1.5);
    } else {
      MGX.fillStyle = '#d4a843'; MGX.beginPath(); MGX.arc(0, 0, d.w / 2, 0, Math.PI * 2); MGX.fill();
      MGX.fillStyle = '#f0c050'; MGX.beginPath(); MGX.arc(-1, -1, d.w / 2 * .6, 0, Math.PI * 2); MGX.fill();
      MGX.fillStyle = '#b08020'; MGX.beginPath(); MGX.arc(0, 0, d.w / 2 * .35, 0, Math.PI * 2); MGX.fill();
    }
    MGX.restore();

    if (d.sucking) {
      const wobR = d.w * .7 + Math.sin(t * 8 + d.ph) * 3;
      MGX.globalAlpha = 0.25; MGX.strokeStyle = T.vacSuckAura; MGX.lineWidth = 1;
      MGX.beginPath(); MGX.arc(d.x, d.y, wobR, 0, Math.PI * 2); MGX.stroke(); MGX.globalAlpha = 1;
    }
  });

  // Progress bar
  const prog = vacCleared / VAC_TOTAL;
  MGX.fillStyle = T.vacProgressBg; MGX.fillRect(10, 6, cw * .35, 8);
  MGX.fillStyle = T.vacProgress; MGX.fillRect(10, 6, cw * .35 * prog, 8);
  MGX.strokeStyle = T.vacMachStroke; MGX.lineWidth = 1; MGX.strokeRect(10, 6, cw * .35, 8);
  MGX.fillStyle = T.vacLabel;
  MGX.font = `${Math.floor(cw * .013)}px 'Press Start 2P',monospace`;
  MGX.textAlign = 'left';
  MGX.fillText(`CLEANED: ${vacCleared}/${VAC_TOTAL}`, 10, 24);
}
