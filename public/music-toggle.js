'use strict';

// ═══════════════════════════════════════════
// MUSIC TOGGLE — Play/Pause circle with
// see-through visualizer bars inside
// Multi-track, multi-loop playback engine
// ═══════════════════════════════════════════

(function () {
  // ── Inject CSS ──
  const style = document.createElement('style');
  style.textContent = `
    .music-toggle {
      position: fixed;
      bottom: clamp(12px, 2vh, 24px);
      right: clamp(12px, 2vw, 24px);
      z-index: 90;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 2px solid rgba(0, 255, 65, 0.35);
      background: rgba(6, 8, 8, 0.6);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.3s, box-shadow 0.3s, opacity 0.4s;
      opacity: 0;
      pointer-events: none;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }
    .music-toggle.visible {
      opacity: 1;
      pointer-events: auto;
    }
    .music-toggle:hover {
      border-color: rgba(0, 255, 65, 0.7);
      box-shadow: 0 0 12px rgba(0, 255, 65, 0.25);
    }
    .music-toggle:active {
      transform: scale(0.92);
    }
    .music-viz {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      width: 24px;
      height: 24px;
      position: relative;
      pointer-events: none;
    }
    .music-viz-bar {
      width: 3px;
      border-radius: 1.5px;
      background: rgba(0, 255, 65, 0.6);
      transition: height 0.12s ease;
    }
    .music-toggle.paused .music-viz { display: none; }
    .music-toggle.paused .music-play-icon { display: block; }
    .music-toggle:not(.paused) .music-play-icon { display: none; }
    .music-play-icon {
      width: 0;
      height: 0;
      border-style: solid;
      border-width: 8px 0 8px 14px;
      border-color: transparent transparent transparent rgba(0, 255, 65, 0.6);
      margin-left: 3px;
      pointer-events: none;
    }
    @media (max-width: 768px) {
      .music-toggle {
        width: 48px;
        height: 48px;
      }
    }
  `;
  document.head.appendChild(style);

  // ── Inject HTML ──
  const btn = document.createElement('div');
  btn.className = 'music-toggle paused';
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'Toggle background music');
  btn.innerHTML = `
    <div class="music-play-icon"></div>
    <div class="music-viz">
      <div class="music-viz-bar" style="height:6px"></div>
      <div class="music-viz-bar" style="height:12px"></div>
      <div class="music-viz-bar" style="height:8px"></div>
      <div class="music-viz-bar" style="height:14px"></div>
      <div class="music-viz-bar" style="height:6px"></div>
    </div>
  `;
  document.body.appendChild(btn);

  const bars = btn.querySelectorAll('.music-viz-bar');

  // ═══════════════════════════════════════════
  // SONG DATA (exported from PLF Music Studio)
  // BPM: 80 | Steps/loop: 32 | Loops: 4
  // ═══════════════════════════════════════════
  const SONG = {
    bpm: 80,
    steps: 32,
    loops: [
      {
        name: 'A',
        tracks: [
          {
            wave: 'sine', volume: 0.6, decay: 1.09,
            steps: [[261.63],[329.63],[392],[493.88],[523.25],[493.88],[392],[329.63],[349.23],[415.3],[523.25],[587.33],[622.25],[587.33],[523.25],[415.3],[392],[523.25],[659.26],[523.25],[622.25],[587.33],[523.25],[392],[349.23],[783.99],[698.46],[523.25],[587.33],null,[392],null]
          },
          {
            wave: 'triangle', volume: 0.4, decay: 1.79,
            steps: [[130.81],null,null,null,null,null,null,null,[174.61],null,null,null,null,null,null,null,[164.81],null,null,null,[207.65],null,null,null,[174.61],null,null,null,[196],null,null,null]
          }
        ]
      },
      {
        name: 'D',
        tracks: [
          {
            wave: 'sine', volume: 0.6, decay: 1.09,
            steps: [[261.63],[329.63],[392],[493.88],[523.25],[493.88],[392],[329.63],[349.23],[415.3],[523.25],[587.33],[622.25],[587.33],[523.25],[415.3],[392],[523.25],[659.26],[523.25],[622.25],[587.33],[523.25],[392],[349.23],[783.99],[698.46],[523.25],[587.33],null,[392],null]
          },
          {
            wave: 'triangle', volume: 0.4, decay: 1.79,
            steps: [[130.81],null,null,null,null,null,null,null,[174.61],null,null,null,null,null,null,null,[164.81],null,null,null,[207.65],null,null,null,[174.61],null,null,null,[196],null,null,null]
          }
        ]
      },
      {
        name: 'B',
        tracks: [
          {
            wave: 'sine', volume: 0.6, decay: 1.09,
            steps: [[698.46],[523.25],null,[783.99],null,null,[698.46],null,[659.26],null,[783.99],null,[523.25],null,[659.26],null,[587.33],null,[698.46],null,[698.46],null,[587.33],null,[659.26],[698.46],null,[783.99],null,[698.46],[659.26],null]
          },
          {
            wave: 'triangle', volume: 0.4, decay: 1.79,
            steps: [[174.61],[261.63],[392],[440],null,[392],[349.23],null,[164.81],[246.94],[329.63],null,[220],[329.63],[523.25],null,[146.83],[220],[349.23],null,[196],[246.94],[349.23],null,[130.81],[196],[293.66],[329.63],null,[261.63],null,[130.81]]
          }
        ]
      },
      {
        name: 'E',
        tracks: [
          {
            wave: 'sine', volume: 0.6, decay: 1.09,
            steps: [[698.46],[523.25],null,[783.99],null,null,[698.46],null,[659.26],null,[783.99],null,[880],null,[659.26],null,[587.33],[739.99],null,[659.26],null,[622.25],[587.33],null,[783.99],null,[698.46],null,[659.26,493.88],null,[587.33,349.23],null]
          },
          {
            wave: 'triangle', volume: 0.4, decay: 1.79,
            steps: [[174.61],[261.63],[392],[440],null,[392],[349.23],null,[164.81],[246.94],[329.63],null,[220],[329.63],[523.25],null,[146.83],[220],[369.99],null,null,[261.63],[293.66],null,[196],[293.66],null,[349.23],null,[196],[146.83],null]
          }
        ]
      }
    ]
  };

  // ── Audio Engine ──
  const VOLUME = 0.07; // soft background level
  let audioCtx = null;
  let masterGain = null;
  let playing = false;
  let animFrame = null;
  let sequencerTimer = null;
  let stepIdx = 0;
  let loopIdx = 0;

  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = VOLUME;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => {
        // If music was supposed to be playing but context was suspended,
        // kick-start the sequencer now that it's running
        if (playing && !sequencerTimer) scheduleStep();
      });
    }
  }

  function playNote(freq, wave, volume, decay) {
    if (!audioCtx || !masterGain || !freq) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    osc.connect(g);
    g.connect(masterGain);
    const now = audioCtx.currentTime;
    g.gain.setValueAtTime(volume, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + decay);
    osc.start(now);
    osc.stop(now + decay + 0.02);
  }

  // ── Sequencer ──
  function scheduleStep() {
    if (!playing) return;

    const loop = SONG.loops[loopIdx];
    for (const track of loop.tracks) {
      const step = track.steps[stepIdx];
      if (step) {
        for (const freq of step) {
          playNote(freq, track.wave, track.volume, track.decay);
        }
      }
    }

    stepIdx++;
    if (stepIdx >= SONG.steps) {
      stepIdx = 0;
      loopIdx = (loopIdx + 1) % SONG.loops.length;
    }

    const stepMs = (60000 / SONG.bpm) / 2; // 8th notes
    sequencerTimer = setTimeout(scheduleStep, stepMs);
  }

  // ── Start / Stop ──
  function startMusic() {
    ensureAudioCtx();
    if (playing) return;
    playing = true;
    stepIdx = 0;
    loopIdx = 0;

    // Fade master in
    masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(VOLUME, audioCtx.currentTime + 1.5);

    scheduleStep();
    btn.classList.remove('paused');
    animateViz();
  }

  function stopMusic() {
    if (!playing) return;
    playing = false;

    // Fade out
    if (masterGain && audioCtx) {
      masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.5);
      setTimeout(() => {
        if (masterGain) masterGain.gain.value = VOLUME;
      }, 600);
    }

    if (sequencerTimer) { clearTimeout(sequencerTimer); sequencerTimer = null; }
    btn.classList.add('paused');
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    bars.forEach(b => b.style.height = '6px');
  }

  // ── Visualizer Animation ──
  function animateViz() {
    if (!playing) return;
    const t = performance.now() / 1000;
    bars.forEach((bar, i) => {
      const phase = i * 0.8;
      const h = 4 + Math.abs(Math.sin(t * 3.5 + phase)) * 14;
      bar.style.height = h + 'px';
    });
    animFrame = requestAnimationFrame(animateViz);
  }

  // ── Toggle ──
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (playing) {
      stopMusic();
      localStorage.setItem('plf-music', 'off');
    } else {
      startMusic();
      localStorage.setItem('plf-music', 'on');
    }
  });

  // ── Auto-play system ──
  // Strategy: try to start immediately. If browser blocks (suspended),
  // wait for first user gesture then resume. Works across page navigations.
  const _autoEvents = ['click', 'touchstart', 'pointerdown', 'keydown'];
  let _autoStarted = false;

  function _autoPlay(e) {
    if (_autoStarted) return;
    if (e && e.target && (e.target === btn || btn.contains(e.target))) return;
    _autoStarted = true;
    if (!playing) startMusic();
    else if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    localStorage.setItem('plf-music', 'on');
    _autoEvents.forEach(ev => document.removeEventListener(ev, _autoPlay, true));
  }

  function _cleanupAutoListeners() {
    _autoEvents.forEach(ev => document.removeEventListener(ev, _autoPlay, true));
  }

  if (localStorage.getItem('plf-music') !== 'off') {
    // Register gesture listeners immediately
    _autoEvents.forEach(ev => document.addEventListener(ev, _autoPlay, { capture: true }));

    // Also try to start right away (works if browser allows it)
    window.addEventListener('load', () => {
      setTimeout(() => {
        if (!_autoStarted && localStorage.getItem('plf-music') !== 'off') {
          startMusic();
          // If context is running, great — mark as started
          if (audioCtx && audioCtx.state === 'running') {
            _autoStarted = true;
            _cleanupAutoListeners();
            localStorage.setItem('plf-music', 'on');
          }
          // If still suspended, the gesture handlers will resume it on first interaction
        }
      }, 500);
    });
  }

  window.addEventListener('load', () => {
    setTimeout(() => btn.classList.add('visible'), 1200);
  });

  // ── Public API ──
  window.PLFMusic = {
    play: startMusic,
    pause: stopMusic,
    isPlaying() { return playing; },
    setVolume(v) { if (masterGain) masterGain.gain.value = v; },
  };
})();
