/* Steady — rhythm-keeping practice. All app logic. */
(() => {
'use strict';
const VERSION = '20261010-3';
const PROXY_URL = 'https://steady-bpm.ryo-private-mail.workers.dev/';
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- keep phones on the newest version ---------- */
// GitHub Pages caches pages for a while; a phone could keep showing an old build. Ask for the
// current version without cache and reload once onto a fresh URL when it differs.
(async () => {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const v = (await r.json()).version;
    if (v && v !== VERSION && sessionStorage.getItem('steady.reloadedFor') !== v) {
      sessionStorage.setItem('steady.reloadedFor', v);
      location.replace(location.pathname + '?v=' + v);
    }
  } catch (e) {}
})();

/* ---------- state ---------- */
const S = Object.assign({ bpm: Math.round(store.get('steady.bpm', 100)), per: 4, dur: 30, mute: 0, vol: 0, snd: 'click', mode: 'metro', song: null }, store.get('steady.s', {}));
S.bpm = Math.max(40, Math.min(240, Math.round(S.bpm)));
const save = () => store.set('steady.s', S);
let calibMs = store.get('steady.calib2', null);
let ctx = null, run = null, wake = null, lastResult = null;

/* ---------- audio ---------- */
function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') ctx.resume();
  return ctx;
}
function click(t, accent, kind, vol) {
  if (vol == null) vol = 1;
  if (vol <= 0) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  let f, dur;
  if (kind === 'wood') { o.type = 'triangle'; f = accent ? 1250 : 900; dur = 0.05; }
  else if (kind === 'beep') { o.type = 'square'; f = accent ? 1760 : 1320; dur = 0.04; }
  else { o.type = 'sine'; f = accent ? 2000 : 1400; dur = 0.03; }
  o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime((kind === 'beep' ? 0.25 : 0.8) * vol, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.01);
}
const outLat = () => ctx.outputLatency || ctx.baseLatency || 0;
const calS = () => (calibMs || 0) / 1000;
// Context time of the sound that is audible at performance time perfTs (output delay included)
function audibleTime(perfTs) {
  if (perfTs == null) perfTs = performance.now();
  if (ctx.getOutputTimestamp) {
    const o = ctx.getOutputTimestamp();
    if (o && o.performanceTime > 0 && o.contextTime > 0) return o.contextTime + (perfTs - o.performanceTime) / 1000;
  }
  return ctx.currentTime - outLat() - (performance.now() - perfTs) / 1000;
}

/* ---------- UI: tempo, mode, settings ---------- */
const bigNum = $('bigNum'), cap = $('cap'), center = $('center');
function setBpm(v, quiet) {
  const nv = Math.max(40, Math.min(240, Math.round(v)));
  if (nv !== S.bpm && !quiet && navigator.vibrate) { try { navigator.vibrate(3); } catch (e) {} }
  S.bpm = nv; save();
  if (!run) idleCenter();
}
function idleCenter() {
  bigNum.className = 'big';
  bigNum.textContent = S.bpm;
  cap.textContent = 'BPM';
}
function setMode(m) {
  if (run) stopRun();
  S.mode = m; save();
  $('modes').dataset.mode = m;
  $('modeMetro').setAttribute('aria-selected', String(m === 'metro'));
  $('modeSong').setAttribute('aria-selected', String(m === 'song'));
  $('songCard').hidden = m !== 'song';
  $('gMute').hidden = m === 'song';
  $('gVol').hidden = m !== 'song';
  renderSongCard(); renderChips(); idleCenter(); idlePad();
}
$('modeMetro').onclick = () => setMode('metro');
$('modeSong').onclick = () => setMode('song');

function renderSongCard() {
  const c = $('songCard'), s = S.song;
  c.classList.toggle('empty', !s);
  const art = $('songArt');
  if (s && s.art) {
    const img = el('img', 'art'); img.src = s.art; img.alt = ''; img.id = 'songArt'; art.replaceWith(img);
  } else if (art.tagName === 'IMG') { const sp = el('span', 'art', '♪'); sp.id = 'songArt'; art.replaceWith(sp); }
  $('songTitle').textContent = s ? s.title : '曲を選ぶ';
  $('songArtist').textContent = s ? s.artist + ' ・ ' + s.bpm + ' BPM' : '曲名で探してBPMを決めます';
  c.querySelector('.go').textContent = s ? '変える' : '探す';
}
$('songCard').onclick = () => openSheet('finder');

const MUTE_LABEL = { 0: 'ずっと', 1: '1小節おきに消す', 2: '2小節おきに消す', 4: '4小節おきに消す' };
const VOL_LABEL = { 0: '鳴らさない', 0.25: '小さく', 1: '普通' };
function renderChips() {
  $('cMeter').textContent = S.per === 6 ? '6/8' : S.per + '/4';
  $('cDur').textContent = S.dur >= 120 ? '2分' : S.dur + '秒';
  $('cClickK').textContent = S.mode === 'song' ? '曲に重ねるクリック' : 'クリック';
  $('cClick').textContent = S.mode === 'song' ? VOL_LABEL[S.vol] : MUTE_LABEL[S.mute];
  document.querySelectorAll('.seg[data-set]').forEach((seg) => {
    const k = seg.dataset.set;
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(String(S[k]) === b.dataset.v)));
  });
  const ok = calibMs != null;
  $('calibChip').classList.toggle('ok', ok);
  $('calibText').innerHTML = ok ? '補正 <b>' + (calibMs >= 0 ? '+' : '−') + Math.abs(calibMs).toFixed(0) + 'ms</b>' : '補正前';
  $('calibVal').textContent = ok ? (calibMs >= 0 ? '+' : '−') + Math.abs(calibMs).toFixed(0) + ' ms' : 'まだ';
}
document.querySelectorAll('.seg[data-set]').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const k = seg.dataset.set, v = b.dataset.v;
    S[k] = k === 'snd' ? v : Number(v); save(); renderChips();
    if (k === 'per') sizeOrbit();
  });
});
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));
$('calibChip').onclick = () => openSheet('intro');
$('recalib').onclick = () => { closeSheets(); startCalib(false); };

// drag the number up/down to change BPM; wheel on desktop
(() => {
  let y0 = null, b0 = 0, id = null;
  center.addEventListener('pointerdown', (e) => { if (run || e.target.closest('button')) return; y0 = e.clientY; b0 = S.bpm; id = e.pointerId; center.setPointerCapture(id); });
  center.addEventListener('pointermove', (e) => { if (y0 == null || e.pointerId !== id) return; setBpm(b0 + (y0 - e.clientY) / 5); });
  const end = () => { y0 = null; };
  center.addEventListener('pointerup', end); center.addEventListener('pointercancel', end);
  center.addEventListener('wheel', (e) => { if (run) return; e.preventDefault(); setBpm(S.bpm + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
})();
// ± with press-and-hold repeat
[['minus', -1], ['plus', 1]].forEach(([id, d]) => {
  const b = $(id); let t1 = null, t2 = null;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); setBpm(S.bpm + d); t1 = setTimeout(() => { t2 = setInterval(() => setBpm(S.bpm + d, true), 70); }, 380); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
});

/* ---------- sheets & toast ---------- */
function openSheet(id) {
  closeSheets(true);
  $(id).classList.add('on'); $('scrim').classList.add('on');
  const f = $(id).querySelector('input,button.start');
  if (id === 'finder' && f && !matchMedia('(pointer:coarse)').matches) setTimeout(() => $('qTitle').focus(), 300);
}
function closeSheets(silent) {
  document.querySelectorAll('.sheet.on').forEach((s) => s.classList.remove('on'));
  $('scrim').classList.remove('on');
  if (!silent && pv) pv.stop();
}
$('scrim').onclick = () => closeSheets();
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeSheets()));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
// swipe a sheet down to close
document.querySelectorAll('.sheet').forEach((sh) => {
  let y0 = null;
  sh.querySelector('header').addEventListener('pointerdown', (e) => { y0 = e.clientY; });
  sh.addEventListener('pointerup', (e) => { if (y0 != null && e.clientY - y0 > 70) closeSheets(); y0 = null; });
});
let toastT = null;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

/* ---------- the orbit ---------- */
const cv = $('orbit'), g = cv.getContext('2d');
let osize = 0, dpr = 1;
function sizeOrbit() {
  dpr = Math.min(3, window.devicePixelRatio || 1);
  osize = cv.clientWidth;
  cv.width = osize * dpr; cv.height = osize * dpr;
}
const tone = (dev) => { const a = Math.abs(dev); return a <= 25 ? css('--brass') : dev < 0 ? css('--early') : css('--late'); };
// marks: [{beat (position in bar, may be fractional), bar}], drawn on a ring that tightens bar by bar
function drawRing(c, size, per, marks, opts) {
  const cx = size / 2, R = size / 2 - (opts.pad || 14);
  const line = css('--line'), paper = css('--paper'), brass = css('--brass');
  c.lineCap = 'round';
  c.strokeStyle = line; c.lineWidth = opts.thin ? 1.5 : 2;
  c.beginPath(); c.arc(cx, cx, R, 0, Math.PI * 2); c.stroke();
  // subdivisions (four per beat), like the scale on a metronome dial
  if (!opts.thin) {
    c.strokeStyle = line; c.lineWidth = 1;
    for (let k = 0; k < per * 4; k++) {
      if (k % 4 === 0) continue;
      const a = -Math.PI / 2 + (k * Math.PI * 2) / (per * 4);
      c.beginPath(); c.moveTo(cx + Math.cos(a) * (R + 3), cx + Math.sin(a) * (R + 3)); c.lineTo(cx + Math.cos(a) * (R - (k % 2 ? 1 : 3)), cx + Math.sin(a) * (R - (k % 2 ? 1 : 3))); c.stroke();
    }
  }
  for (let k = 0; k < per; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / per, glow = opts.flash ? opts.flash[k] || 0 : 0;
    const len = (k === 0 ? 14 : 8) * (opts.thin ? 0.6 : 1) + glow * 6;
    c.strokeStyle = glow > 0.02 ? brass : k === 0 ? paper : line;
    c.globalAlpha = glow > 0.02 ? 0.35 + glow * 0.65 : k === 0 ? 0.8 : 1;
    c.lineWidth = (k === 0 ? 3 : 2) * (opts.thin ? 0.7 : 1);
    c.beginPath(); c.moveTo(cx + Math.cos(a) * (R + 4), cx + Math.sin(a) * (R + 4));
    c.lineTo(cx + Math.cos(a) * (R + 4 - len), cx + Math.sin(a) * (R + 4 - len)); c.stroke();
  }
  c.globalAlpha = 1;
  if (marks && marks.length) {
    const bars = Math.max(1, opts.bars || 1), inner = R * 0.42, gap = (R - 18 - inner) / Math.max(1, bars - 1);
    marks.forEach((m) => {
      const a = -Math.PI / 2 + (m.beat * Math.PI * 2) / per, r = R - 14 - Math.min(m.bar, bars - 1) * gap;
      c.fillStyle = tone(m.dev);
      c.globalAlpha = m.fresh != null ? 0.55 + 0.45 * m.fresh : 0.9;
      c.beginPath(); c.arc(cx + Math.cos(a) * r, cx + Math.sin(a) * r, (opts.dot || 3.2) * (1 + (m.fresh || 0) * 0.8), 0, Math.PI * 2); c.fill();
    });
    c.globalAlpha = 1;
  }
}
const flash = [];
function frameOrbit(now) {
  if (!osize) sizeOrbit();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, osize, osize);
  const per = run ? run.per : S.per;
  for (let k = 0; k < per; k++) flash[k] = (flash[k] || 0) * 0.9;
  const cx = osize / 2, R = osize / 2 - 14, brass = css('--brass');
  let phase = null;
  if (run && !run.aligning && run.beats.length) {
    const t = run.song ? audibleTime() + calS() : audibleTime();
    const pos = (t - run.beats[0]) / run.bd;               // beats since first beat
    if (pos >= -run.per) {
      const bi = Math.floor(pos);
      if (bi !== run.lastBeat && bi >= 0 && bi < run.beats.length) { run.lastBeat = bi; flash[run.beatNo(bi)] = run.audible(bi) ? 1 : 0.45; }
      phase = ((run.beatNo(0) + pos) / per) % 1;
    }
  } else if (!run) {
    phase = reduceMotion ? 0 : ((now / 1000) * S.bpm / 60 / per) % 1;
    const bi = Math.floor(phase * per);
    if (!reduceMotion && bi !== frameOrbit.lastIdle) { frameOrbit.lastIdle = bi; flash[bi] = 0.6; }
  }
  if (run && run.marks) run.marks.forEach((m) => { if (m.fresh > 0) m.fresh = Math.max(0, m.fresh - 0.04); });
  drawRing(g, osize, per, run ? run.marks : null, { flash, bars: run ? run.bars : 1 });
  if (phase != null) {
    const a = -Math.PI / 2 + ((phase + 1) % 1) * Math.PI * 2;
    // trailing arc
    const trail = run ? 0.9 : 0.6;
    for (let i = 0; i < 24; i++) {
      const aa = a - (i / 24) * (Math.PI * 2 / per) * trail;
      g.globalAlpha = (1 - i / 24) * (run ? 0.5 : 0.28);
      g.strokeStyle = brass; g.lineWidth = 4;
      g.beginPath(); g.arc(cx, cx, R, aa - 0.06, aa); g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = brass;
    g.beginPath(); g.arc(cx + Math.cos(a) * R, cx + Math.sin(a) * R, run ? 8 : 6.5, 0, Math.PI * 2); g.fill();
  }
  requestAnimationFrame(frameOrbit);
}
addEventListener('resize', () => { sizeOrbit(); if (lastResult) { drawTimeline(lastResult); drawFinger(lastResult); } });

/* ---------- pad ---------- */
const pad = $('pad');
function idlePad() {
  $('padLbl').textContent = 'ここを叩く';
  $('padSub').textContent = S.mode === 'song' ? '曲を流してからスタート。最初の8回で拍の位置を合わせます' : 'スタートしたら、クリックに合わせてタップ';
  $('meter').innerHTML = '';
}
function ripple(e, host) {
  if (reduceMotion) return;
  const r = host.getBoundingClientRect(), s = el('span', 'ripple');
  s.style.left = ((e && e.clientX ? e.clientX : r.left + r.width / 2) - r.left) + 'px';
  s.style.top = ((e && e.clientY ? e.clientY : r.top + r.height / 2) - r.top) + 'px';
  host.appendChild(s); setTimeout(() => s.remove(), 600);
}
pad.addEventListener('pointerdown', (e) => { e.preventDefault(); ripple(e, pad); tap(e); });
$('stage').addEventListener('pointerdown', (e) => { if (run && !e.target.closest('button')) { e.preventDefault(); tap(e); } });
document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat && !document.querySelector('.sheet.on') && !e.target.closest('input')) {
    if (e.target === $('go')) return;
    e.preventDefault(); ripple(null, pad); tap(e);
  }
});

/* ---------- session engine ---------- */
const ALIGN = 8;
function start(opts) {
  ensureCtx();
  const bd = 60 / opts.bpm;
  if (opts.song) {
    run = Object.assign({}, opts, { bd, countIn: 0, beats: [], next: 0, taps: new Map(), extra: 0, aligning: true, align: [], kBase: 0, marks: [], bars: 1,
      audible: () => opts.vol > 0, beatNo: (i) => (run.kBase + i) % opts.per, playAt: (i) => run.beats[i] - calS() });
    showCenter(ALIGN + '', '曲の拍に合わせて ' + ALIGN + ' 回叩いて、位置を合わせます', 'small');
    $('padLbl').textContent = '曲に合わせて叩く'; $('padSub').textContent = 'あと ' + ALIGN + ' 回';
  } else {
    const countIn = opts.per, scored = Math.ceil(opts.dur / bd), t0 = ctx.currentTime + 0.35, beats = [];
    for (let i = 0; i < countIn + scored; i++) beats.push(t0 + i * bd);
    const audible = (i) => { if (i < countIn || !opts.mute) return true; const bar = Math.floor((i - countIn) / opts.per); return bar % (2 * opts.mute) < opts.mute; };
    run = Object.assign({}, opts, { bd, countIn, beats, audible, next: 0, taps: new Map(), extra: 0, marks: [], bars: Math.ceil(scored / opts.per),
      beatNo: (i) => i % opts.per, playAt: (i) => run.beats[i] });
    run.timer = setInterval(schedule, 20); schedule();
    $('padLbl').textContent = opts.calib ? 'クリックに合わせて叩く' : '拍に合わせて叩く';
    $('padSub').textContent = opts.calib ? '20回叩くと、この端末の遅れがわかります' : 'カウントのあと測定が始まります';
  }
  run.lastBeat = -1;
  $('stage').classList.add('running'); center.classList.add('running');
  $('go').textContent = 'やめる'; $('go').classList.add('stop');
  $('meter').innerHTML = '';
  requestAnimationFrame(tick);
  try { navigator.wakeLock && navigator.wakeLock.request('screen').then((w) => (wake = w)).catch(() => {}); } catch (e) {}
}
function schedule() {
  if (!run || run.aligning) return;
  while (run.next < run.beats.length && run.playAt(run.next) < ctx.currentTime + 0.12) {
    const i = run.next, t = run.playAt(i);
    if (t > ctx.currentTime && run.audible(i)) click(t, run.beatNo(i) === 0, run.snd, run.song ? run.vol : 1);
    run.next++;
  }
}
function showCenter(big, capText, cls) {
  bigNum.className = 'big' + (cls ? ' ' + cls : '');
  bigNum.textContent = big; cap.textContent = capText;
}
function tick() {
  if (!run) return;
  if (run.aligning) { requestAnimationFrame(tick); return; }
  const b = run.beats, now = run.song ? audibleTime() + calS() : audibleTime();
  const i = Math.floor((now - b[0]) / run.bd);
  if (!run.song && i < run.countIn) {
    if (run.shown !== i) { run.shown = i; showCenter(String(Math.max(1, run.countIn - Math.max(0, i))), run.calib ? '補正：クリックに合わせて叩く' : 'カウント', ''); }
  } else if (run.song && i < 0) {
    if (run.shown !== 'wait') { run.shown = 'wait'; showCenter('…', 'まもなく測定開始', 'small'); }
  } else if (!run.started) {
    run.started = true;
    if (!run.lastDev) showCenter('●', run.calib ? 'クリックに合わせて叩く' : '測定中', 'small');
    $('padSub').textContent = run.calib ? '20回叩くと、この端末の遅れがわかります' : '測定中';
  }
  if (!run.calib && (run.song ? i >= 0 : i >= run.countIn)) {
    const left = Math.max(0, Math.ceil(b[b.length - 1] - now));
    const muted = !run.song && run.mute && !run.audible(Math.min(Math.max(i, 0), b.length - 1));
    $('padSub').textContent = (muted ? 'クリックなし ・ 自分でキープ ・ ' : '') + 'のこり ' + left + '秒';
  }
  if (now > b[b.length - 1] + run.bd * 0.6) { finish(); return; }
  requestAnimationFrame(tick);
}
function stopRun() {
  if (!run) return;
  clearInterval(run.timer); run = null;
  $('stage').classList.remove('running'); center.classList.remove('running');
  $('go').textContent = 'スタート'; $('go').classList.remove('stop');
  idleCenter(); idlePad();
  try { wake && wake.release(); } catch (e) {} wake = null;
}

// fit the beat grid to the alignment taps (phase by circular mean; spread as a sanity check)
function alignGrid() {
  const a = run.align, bd = run.bd, ref = a[0];
  let sx = 0, sy = 0;
  a.forEach((t) => { const x = (t - ref) / bd, f = x - Math.round(x); sx += Math.cos(2 * Math.PI * f); sy += Math.sin(2 * Math.PI * f); });
  const mf = Math.atan2(sy, sx) / (2 * Math.PI), anchor = ref + mf * bd;
  const res = a.map((t) => { const x = (t - anchor) / bd; return (x - Math.round(x)) * bd * 1000; });
  const sd = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length);
  if (sd > Math.max(60, bd * 1000 * 0.15)) return { ok: false };
  const ks = a.map((t) => Math.round((t - anchor) / bd)), km = ks.reduce((s, v) => s + v, 0) / ks.length, tm = a.reduce((s, v) => s + v, 0) / a.length;
  let num = 0, den = 0; ks.forEach((k, i) => { num += (k - km) * (a[i] - tm); den += (k - km) ** 2; });
  const est = den ? 60 / (num / den) : run.bpm;
  const k0 = ks[ks.length - 1] + 1;
  run.kBase = (((k0 - ks[0]) % run.per) + run.per) % run.per; // first alignment tap = beat 1
  run.beats = []; const n = Math.ceil(run.dur / bd);
  for (let j = 0; j < n; j++) run.beats.push(anchor + (k0 + j) * bd);
  run.bars = Math.ceil((n + run.kBase) / run.per);
  return { ok: true, est };
}

function tap(e) {
  pad.classList.add('hit'); setTimeout(() => pad.classList.remove('hit'), 70);
  if (!run) return;
  const ts = e && e.timeStamp > 0 ? e.timeStamp : performance.now();
  const ta = audibleTime(ts); // what was being heard at the moment of the tap
  let idx, dev;
  if (run.song) {
    if (run.aligning) {
      const a = run.align;
      if (a.length && ta - a[a.length - 1] > run.bd * 2.5) a.length = 0;
      a.push(ta);
      showCenter(String(ALIGN - a.length), 'あと ' + (ALIGN - a.length) + ' 回', 'small');
      $('padSub').textContent = 'あと ' + (ALIGN - a.length) + ' 回';
      if (a.length >= ALIGN) {
        const r = alignGrid();
        if (!r.ok) { a.length = 0; showCenter(String(ALIGN), '拍とそろいませんでした。BPMを確かめて、もう一度 ' + ALIGN + ' 回', 'small'); return; }
        run.aligning = false; run.estBpm = r.est;
        const off = Math.abs(r.est - run.bpm) / run.bpm > 0.04;
        showCenter('●', off ? '合わせました（叩いた速さは約' + Math.round(r.est) + ' BPM。設定を確かめて）' : '合わせました。そのままキープ', 'small');
        run.timer = setInterval(schedule, 20); schedule();
      }
      return;
    }
    if (!run.beats.length) return;
    idx = Math.round((ta - run.beats[0]) / run.bd);
    if (idx < 0 || idx >= run.beats.length) return;
    dev = (ta - run.beats[idx]) * 1000;
  } else {
    idx = Math.round((ta - run.beats[0]) / run.bd);
    if (idx < run.countIn || idx >= run.beats.length) return;
    dev = (ta - run.beats[idx]) * 1000;
    if (!run.calib && calibMs != null) dev -= calibMs;
  }
  const prev = run.taps.get(idx);
  if (prev == null || Math.abs(dev) < Math.abs(prev)) { if (prev != null) run.extra++; run.taps.set(idx, dev); } else run.extra++;
  if (run.calib) { showCenter(String(run.taps.size), '回 ・ クリックに合わせて叩く', ''); return; }
  const scoredIdx = idx - run.countIn;
  const pos = run.song ? run.kBase + idx : scoredIdx;
  run.marks = run.marks.filter((m) => m.i !== idx);
  run.marks.push({ i: idx, beat: (pos % run.per) + dev / 1000 / run.bd, bar: Math.floor(pos / run.per), dev, fresh: 1 });
  run.lastDev = dev;
  showTap(dev);
}
function showTap(dev) {
  const a = Math.abs(dev);
  bigNum.className = 'big ' + (a <= 25 ? 'just' : dev < 0 ? 'early' : 'late');
  bigNum.textContent = (dev >= 0 ? '+' : '−') + a.toFixed(0);
  cap.textContent = 'ms ・ ' + (a <= 25 ? 'ぴったり' : dev < 0 ? '走り' : 'もたり');
  const t = el('i'); t.style.left = (50 + Math.max(-100, Math.min(100, dev)) / 2) + '%'; t.style.background = tone(dev);
  $('meter').appendChild(t); requestAnimationFrame(() => requestAnimationFrame(() => (t.style.opacity = '0')));
  setTimeout(() => t.remove(), 1500);
}

function startCalib(thenStart) {
  if (run) stopRun();
  start({ bpm: 90, per: 4, dur: (20 * 60) / 90, mute: 0, snd: S.snd, calib: true, thenStart });
  showCenter('4', '補正：クリックに合わせて20回叩く', '');
}
$('introGo').onclick = () => { closeSheets(); ensureCtx(); startCalib(true); };
$('go').onclick = () => {
  if (run) { stopRun(); return; }
  if (calibMs == null && S.mode !== 'song') { openSheet('intro'); return; }
  closeSheets();
  start({ bpm: S.bpm, per: S.per, dur: S.dur, mute: S.mode === 'song' ? 0 : S.mute, snd: S.snd, song: S.mode === 'song', vol: S.vol });
};

function finish() {
  const r = run; stopRun();
  if (r.calib) {
    // skip the first bar (people settle in), use the median, refuse very uneven tapping
    const v = [...r.taps.entries()].filter(([i]) => i >= r.countIn + 4).map(([, d]) => d).sort((a, b) => a - b);
    if (v.length < 8) { showCenter('—', '叩いた回数が足りませんでした。もう一度どうぞ', 'small'); return; }
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    if (q(0.75) - q(0.25) > 70) { showCenter('—', 'ばらつきが大きいので、もう一度補正してください', 'small'); return; }
    calibMs = q(0.5); store.set('steady.calib2', calibMs); renderChips();
    toast('補正しました（' + (calibMs >= 0 ? '+' : '−') + Math.abs(calibMs).toFixed(0) + 'ms）');
    if (r.thenStart) setTimeout(() => $('go').click(), 900);
    return;
  }
  const pts = [];
  for (let i = r.countIn; i < r.beats.length; i++) {
    const d = r.taps.get(i);
    pts.push({ t: r.beats[i] - r.beats[r.countIn], dev: d == null ? null : d, muted: !r.song && !r.audible(i) });
  }
  const res = analyze(pts, { bpm: r.bpm, dur: r.dur, mute: r.mute, per: r.per, song: !!r.song, songTitle: r.song && S.song ? S.song.title : '', marks: r.marks.map((m) => ({ beat: m.beat, bar: m.bar, dev: m.dev })), bars: r.bars });
  render(res, false);
  const h = store.get('steady.hist', []);
  h.unshift({ at: Date.now(), bpm: r.bpm, dur: r.dur, mute: r.mute, song: !!r.song, title: res.meta.songTitle, score: res.score, mean: res.mean, sd: res.sd });
  store.set('steady.hist', h.slice(0, 20)); renderHist();
  setTimeout(() => $('results').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }), 250);
}

/* ---------- scoring ---------- */
function analyze(pts, meta) {
  const hit = pts.filter((p) => p.dev != null && Math.abs(p.dev) <= 150);
  const n = pts.length, h = hit.length;
  const mean = h ? hit.reduce((s, p) => s + p.dev, 0) / h : 0;
  const sd = h > 1 ? Math.sqrt(hit.reduce((s, p) => s + (p.dev - mean) ** 2, 0) / (h - 1)) : 0;
  const half = pts.length ? pts[pts.length - 1].t / 2 : 0;
  const avg = (a) => (a.length ? a.reduce((s, p) => s + p.dev, 0) / a.length : 0);
  const drift = avg(hit.filter((p) => p.t >= half)) - avg(hit.filter((p) => p.t < half));
  const J = { perfect: 0, great: 0, good: 0, miss: 0 };
  pts.forEach((p) => { const a = p.dev == null ? 999 : Math.abs(p.dev); a <= 25 ? J.perfect++ : a <= 50 ? J.great++ : a <= 90 ? J.good++ : J.miss++; });
  const cl = (x) => Math.max(0, Math.min(100, x));
  const stab = cl(100 - (sd - 8) * 1.3), acc = cl(100 - (Math.abs(mean) - 5) * 1.2 - Math.max(0, Math.abs(drift) - 10) * 0.6), cov = n ? (h / n) * 100 : 0;
  const score = h < 4 ? 0 : Math.round(stab * 0.5 + acc * 0.3 + cov * 0.2);
  let mutedInfo = null;
  if (meta.mute) { const m = hit.filter((p) => p.muted), u = hit.filter((p) => !p.muted); if (m.length && u.length) mutedInfo = { on: avg(u), off: avg(m) }; }
  return { pts, mean, sd, drift, J, score, h, n, meta, mutedInfo };
}
const sgn = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0);
function verdictFor(s, h) {
  if (h < 4) return 'タップが少なくて採点できませんでした';
  if (s >= 90) return 'メトロノームのような安定感';
  if (s >= 80) return 'かなり安定しています';
  if (s >= 65) return 'もう少しで安定します';
  if (s >= 45) return '揺れが目立ちます';
  return 'まずはテンポを落として揃えましょう';
}
function render(R, sample) {
  lastResult = R;
  $('sampleTag').hidden = !sample;
  const sc = $('score'), target = R.score;
  const t0 = performance.now(), D = sample || reduceMotion ? 0 : 900;
  (function count(now) {
    const p = D ? Math.min(1, (now - t0) / D) : 1, e = 1 - Math.pow(1 - p, 3);
    sc.firstChild.nodeValue = Math.round(target * e);
    if (p < 1) requestAnimationFrame(count);
  })(t0);
  $('verdict').textContent = verdictFor(R.score, R.h);
  $('rmeta').textContent = (R.meta.song ? (R.meta.songTitle || '曲') + ' ・ ' : '') + R.meta.bpm + ' BPM ・ ' + (R.meta.dur >= 120 ? '2分' : R.meta.dur + '秒') + ' ・ ' + R.h + '/' + R.n + '拍' + (sample ? ' ・ 例' : '');
  const msV = (id, v, signed) => { $(id).innerHTML = ''; $(id).append(signed ? sgn(v) : '±' + v.toFixed(0)); $(id).appendChild(el('small', null, 'ms')); };
  msV('sMean', R.mean, true); msV('sSd', R.sd, false); msV('sDrift', R.drift, true);
  $('sMean').style.color = Math.abs(R.mean) <= 15 ? '' : R.mean < 0 ? css('--early') : css('--late');
  const jb = $('judgeBar'); jb.innerHTML = '';
  const J = [['perfect', 'ぴったり', css('--brass')], ['great', '良い', 'color-mix(in oklab,' + css('--paper') + ' 70%,transparent)'], ['good', '惜しい', css('--muted')], ['miss', '外れ', css('--line')]];
  const lg = $('judgeLegend'); lg.innerHTML = '';
  J.forEach(([k, label, c]) => {
    const s = el('span'); s.style.background = c; s.style.flexGrow = '0'; jb.appendChild(s);
    requestAnimationFrame(() => requestAnimationFrame(() => (s.style.flexGrow = String(R.J[k]))));
    const li = el('span'); const sw = el('i'); sw.style.background = c; li.appendChild(sw); li.append(label); li.appendChild(el('b', null, String(R.J[k]))); lg.appendChild(li);
  });
  const adv = [];
  if (R.meta.song) adv.push('曲モードは、最初の8回で合わせた位置を基準にしています。後半のズレが大きいときは、BPMが曲とずれている可能性もあります。');
  if (R.h >= 4) {
    if (R.mean < -15) adv.push('全体に走り気味です（平均 ' + Math.abs(R.mean).toFixed(0) + 'ms 早い）。拍の後ろ側を意識してみましょう。');
    else if (R.mean > 15) adv.push('全体にもたり気味です（平均 ' + R.mean.toFixed(0) + 'ms 遅い）。次の拍を先取りする意識で。');
    else adv.push('平均のタイミングはほぼぴったりです。');
    if (R.sd <= 20) adv.push('ばらつき ±' + R.sd.toFixed(0) + 'ms はかなり安定しています。テンポを上げるか、クリックを消す設定で試してみましょう。');
    else if (R.sd <= 40) adv.push('ばらつき ±' + R.sd.toFixed(0) + 'ms。拍ごとの揺れがまだあります。少し遅めのBPMで揃えるのがおすすめです。');
    else adv.push('ばらつき ±' + R.sd.toFixed(0) + 'ms は大きめです。BPMを10〜20下げて、まず揃えることを優先しましょう。');
    if (Math.abs(R.drift) > 20) adv.push(R.drift < 0 ? '後半にかけて ' + Math.abs(R.drift).toFixed(0) + 'ms 前に出ています（後半に走る）。' : '後半にかけて ' + R.drift.toFixed(0) + 'ms 遅れています（後半にもたる）。');
    if (R.mutedInfo) { const d = R.mutedInfo.off - R.mutedInfo.on; adv.push('クリックが消えた区間の平均は ' + sgn(R.mutedInfo.off) + 'ms（鳴っている区間は ' + sgn(R.mutedInfo.on) + 'ms）。' + (Math.abs(d) > 15 ? (d < 0 ? '一人になると走る傾向があります。' : '一人になるともたる傾向があります。') : 'クリックがなくてもキープできています。')); }
  } else adv.push('拍ごとにタップしてみてください。');
  const ul = $('advice'); ul.innerHTML = ''; adv.forEach((a) => ul.appendChild(el('li', null, a)));
  drawTimeline(R); drawFinger(R);
}
function drawFinger(R) {
  const c = $('finger'), size = c.clientWidth, d = Math.min(3, window.devicePixelRatio || 1);
  c.width = size * d; c.height = size * d;
  const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0);
  drawRing(x, size, R.meta.per || 4, R.meta.marks, { bars: R.meta.bars, thin: true, pad: 6, dot: 2 });
}
function drawTimeline(R) {
  const c = $('timeline'), d = Math.min(3, window.devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  c.width = w * d; c.height = h * d;
  const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0);
  const L = 34, Rr = 6, T = 10, B = 22, pw = w - L - Rr, ph = h - T - B;
  const Y = (v) => T + ph / 2 - (Math.max(-120, Math.min(120, v)) / 120) * (ph / 2);
  const tMax = Math.max(1, R.pts.length ? R.pts[R.pts.length - 1].t : 1), X = (t) => L + (t / tMax) * pw;
  x.font = '11px ' + css('--f-num'); x.textBaseline = 'middle';
  x.fillStyle = css('--panel');
  R.pts.forEach((p, i) => { if (p.muted) { const nx = R.pts[i + 1] ? X(R.pts[i + 1].t) : X(p.t) + 2; x.fillRect(X(p.t), T, nx - X(p.t), ph); } });
  x.fillStyle = 'color-mix(in oklab,' + css('--brass') + ' 14%,transparent)';
  x.fillStyle = 'rgba(233,180,76,.12)'; x.fillRect(L, Y(25), pw, Y(-25) - Y(25));
  [-100, -50, 0, 50, 100].forEach((v) => {
    x.strokeStyle = css('--line'); x.lineWidth = v === 0 ? 1.5 : 1; x.setLineDash(v === 0 ? [] : [2, 4]);
    x.beginPath(); x.moveTo(L, Y(v)); x.lineTo(L + pw, Y(v)); x.stroke(); x.setLineDash([]);
    x.fillStyle = css('--muted'); x.textAlign = 'right'; x.fillText((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v), L - 6, Y(v));
  });
  x.textAlign = 'center'; x.textBaseline = 'top';
  const step = tMax > 60 ? 20 : tMax > 30 ? 10 : 5;
  for (let s = 0; s <= tMax + 0.01; s += step) x.fillText(s + '秒', X(s), T + ph + 7);
  x.textAlign = 'left'; x.fillStyle = css('--early'); x.fillText('早い', L + 4, T + 1);
  x.textBaseline = 'bottom'; x.fillStyle = css('--late'); x.fillText('遅い', L + 4, T + ph - 1);
  // a soft running average line under the dots
  const pts = R.pts.filter((p) => p.dev != null && Math.abs(p.dev) <= 150);
  if (pts.length > 3) {
    x.strokeStyle = 'rgba(239,233,223,.35)'; x.lineWidth = 2; x.beginPath();
    pts.forEach((p, i) => { const win = pts.slice(Math.max(0, i - 3), i + 4); const m = win.reduce((s, q) => s + q.dev, 0) / win.length; i ? x.lineTo(X(p.t), Y(m)) : x.moveTo(X(p.t), Y(m)); });
    x.stroke();
  }
  R.pts.forEach((p) => {
    if (p.dev == null) { x.strokeStyle = css('--muted'); x.lineWidth = 1.2; const px = X(p.t), py = Y(0); x.beginPath(); x.moveTo(px - 3, py - 3); x.lineTo(px + 3, py + 3); x.moveTo(px + 3, py - 3); x.lineTo(px - 3, py + 3); x.stroke(); return; }
    x.fillStyle = tone(p.dev); x.beginPath(); x.arc(X(p.t), Y(p.dev), 3.2, 0, Math.PI * 2); x.fill();
  });
}
function renderHist() {
  const h = store.get('steady.hist', []), ul = $('history');
  if (!h.length) return;
  ul.innerHTML = '';
  h.slice(0, 10).forEach((x) => {
    const d = new Date(x.at), li = el('li');
    li.appendChild(el('span', 's', String(x.score)));
    li.appendChild(el('span', null, (x.song ? (x.title || '曲') + ' ・ ' : 'メトロノーム ・ ') + x.bpm + ' BPM' + (x.mute ? ' ・ 消音あり' : '')));
    li.appendChild(el('span', 'd', (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' ・ 平均 ' + sgn(x.mean) + 'ms ・ ばらつき ±' + x.sd.toFixed(0) + 'ms'));
    ul.appendChild(li);
  });
}

/* ---------- song search ---------- */
const nrm = (v) => String(v || '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
const near = (x, y) => { const p = nrm(x), q = nrm(y); if (!p || !q) return false; if (p === q) return true; return Math.min(p.length, q.length) >= 3 && (p.includes(q) || q.includes(p)); };
function jsonp(url) {
  return new Promise((res, rej) => {
    const cb = 'itcb' + Date.now() + Math.floor(Math.random() * 1e6), sc = document.createElement('script');
    const done = () => { clearTimeout(tm); try { delete window[cb]; } catch (e) { window[cb] = undefined; } sc.remove(); };
    const tm = setTimeout(() => { done(); rej(new Error('timeout')); }, 7000);
    window[cb] = (d) => { done(); res(d); };
    sc.onerror = () => { done(); rej(new Error('load')); };
    sc.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(sc);
  });
}
// Apple Music (Japanese store) from the browser; the proxy is the backup route
async function apple(kind, q, lang) {
  const direct = kind === 'search'
    ? 'https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=JP&media=music&entity=song&limit=5&lang=' + lang
    : 'https://itunes.apple.com/lookup?id=' + q + '&country=JP&lang=' + lang;
  try { return await jsonp(direct); }
  catch (e) {
    const r = await fetch(PROXY_URL + 'itunes?' + (kind === 'search' ? 'term=' + encodeURIComponent(q) : 'ids=' + q) + '&lang=' + lang);
    if (!r.ok) throw new Error('apple ' + r.status);
    return r.json();
  }
}
async function findTracks(artist, title) {
  const d = await apple('search', (artist + ' ' + title).trim(), 'ja_jp');
  const found = (d.results || []).filter((t) => t.trackId && t.previewUrl);
  const en = {};
  if (found.length) {
    try { const e = await apple('lookup', found.map((t) => t.trackId).join(','), 'en_us'); (e.results || []).forEach((t) => { if (t.trackId) en[t.trackId] = { title: t.trackName || '', artist: t.artistName || '' }; }); } catch (err) {}
  }
  return found.map((t) => ({ id: t.trackId, title: t.trackName || '', artist: t.artistName || '', titleEn: (en[t.trackId] || {}).title || '', artistEn: (en[t.trackId] || {}).artist || '',
    art: (t.artworkUrl100 || '').replace('100x100bb', '200x200bb'), preview: t.previewUrl }));
}
async function fetchPreview(t) {
  try { const r = await fetch(t.preview); if (r.ok) return await r.arrayBuffer(); } catch (e) {}
  const r = await fetch(PROXY_URL + 'preview?src=' + encodeURIComponent(t.preview));
  if (!r.ok) throw new Error(r.status);
  return r.arrayBuffer();
}
async function previewBytes(t) { if (!t._ab) t._ab = await fetchPreview(t); return t._ab.slice(0); }
async function analyzeAudio(arrayBuffer) {
  const sr = 22050, OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OC(1, sr * 40, sr);
  const buf = await new Promise((res, rej) => { const p = oc.decodeAudioData(arrayBuffer, res, rej); if (p && p.then) p.then(res, rej); });
  const n = buf.length, x = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / buf.numberOfChannels; }
  return window.SteadyTempo.estimateTempo(x, buf.sampleRate);
}
let jpData = null;
async function loadJp() {
  if (jpData) return jpData;
  try { const r = await fetch('data/bpm-jp.json', { cache: 'no-cache' }); jpData = r.ok ? await r.json() : { songs: [] }; } catch (e) { jpData = { songs: [] }; }
  return jpData;
}
function localMatches(a, t, tracks) {
  const ids = new Set(tracks.map((x) => x.id));
  return ((jpData && jpData.songs) || []).filter((s) => ids.has(s.id) || ((near(s.title, t) || near(s.titleEn, t)) && (!a || near(s.artist, a) || near(s.artistEn, a)))).slice(0, 5);
}

function chooseSong(s) {
  S.song = { title: s.title, artist: s.artist, art: s.art || '', bpm: Math.round(s.bpm) };
  setBpm(s.bpm, true);
  if (S.mode !== 'song') setMode('song'); else { renderSongCard(); idleCenter(); }
  closeSheets();
  toast('「' + s.title + '」' + Math.round(s.bpm) + ' BPMで練習します');
}

// preview playback + tap along
async function decodeFor(t) {
  if (t._decoded) return t._decoded;
  const ab = await previewBytes(t);
  t._decoded = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
  return t._decoded;
}
let pv = null;
const slopeBpm = (ts) => { const n = ts.length, xm = (n - 1) / 2, ym = ts.reduce((s, v) => s + v, 0) / n; let num = 0, den = 0; ts.forEach((v, i) => { num += (i - xm) * (v - ym); den += (i - xm) ** 2; }); return 60000 / (num / den); };
function tapAlong(host, resBox, getCand, onUse) {
  let taps = [];
  host.addEventListener('pointerdown', (e) => {
    e.preventDefault(); ripple(e, host);
    host.classList.add('hit'); setTimeout(() => host.classList.remove('hit'), 70);
    const ts = e.timeStamp > 0 ? e.timeStamp : performance.now();
    if (taps.length && ts - taps[taps.length - 1] > 2000) taps = [];
    taps.push(ts); if (taps.length > 16) taps.shift();
    resBox.innerHTML = '';
    if (taps.length < 4) { resBox.appendChild(el('p', null, taps.length + '回目（4回以上で表示）')); return; }
    const mine = Math.round(slopeBpm(taps)), cand = getCand();
    const m = el('div', 'mine num', String(mine)); m.appendChild(el('small', null, 'BPM（叩いた速さ）')); resBox.appendChild(m);
    let ok = false;
    if (cand) {
      const r = mine / cand; let msg;
      if (Math.abs(r - 1) < 0.03) { msg = '候補の ' + cand + ' BPM と一致しています'; ok = true; }
      else if (Math.abs(r - 2) < 0.08) msg = '候補 ' + cand + ' の倍で叩いています。どちらで数えても練習できます';
      else if (Math.abs(r - 0.5) < 0.03) msg = '候補 ' + cand + ' の半分で叩いています。どちらで数えても練習できます';
      else msg = '候補の ' + cand + ' BPM とずれています' + (taps.length < 8 ? '（もう少し叩くと正確になります）' : '');
      resBox.appendChild(el('p', ok ? 'okmsg' : null, msg));
    }
    const acts = el('div', 'acts'); acts.style.display = 'flex'; acts.style.gap = '8px'; acts.style.flexWrap = 'wrap';
    const b1 = el('button', 'btn gold', mine + ' BPMで練習'); b1.type = 'button'; b1.onclick = () => onUse(mine); acts.appendChild(b1);
    if (cand && !ok) { const b2 = el('button', 'btn', cand + ' BPMで練習'); b2.type = 'button'; b2.onclick = () => onUse(cand); acts.appendChild(b2); }
    resBox.appendChild(acts);
  });
}
tapAlong($('tapBpm'), $('tapBpmRes'), () => null, (bpm) => chooseSong({ title: '叩いて測った曲', artist: 'タップ', bpm }));

function trackCard(t, opts) {
  const row = el('div', 'track');
  if (t.art) { const img = el('img'); img.src = t.art; img.alt = ''; img.loading = 'lazy'; row.appendChild(img); } else row.appendChild(el('div', 'noart'));
  row.appendChild(el('div', 't', t.title));
  row.appendChild(el('div', 'a', t.artist + (t.artistEn && t.artistEn !== t.artist ? '（' + t.artistEn + '）' : '')));
  const line = el('div', 'bpmline'); row.appendChild(line);
  const acts = el('div', 'acts'); row.appendChild(acts);
  const use = el('button', 'btn gold', 'この曲で練習'); use.type = 'button'; use.disabled = true;
  use.onclick = () => chooseSong(Object.assign({}, t, { bpm: t.bpm }));
  const PLAY = '▶ 試聴して確かめる', play = el('button', 'btn', PLAY); play.type = 'button';
  const meas = el('button', 'btn ghost', 'BPMを測る'); meas.type = 'button';
  acts.append(use, play, meas);
  const showBpm = (bpm, tagText, gold) => {
    t.bpm = Math.round(bpm); line.innerHTML = '';
    const b = el('span', 'bpm num', String(t.bpm)); b.appendChild(el('small', null, 'BPM')); line.appendChild(b);
    if (tagText) line.appendChild(el('span', 'tag' + (gold ? ' gold' : ''), tagText));
    const x2 = el('button', 'tag', '×2'), h2 = el('button', 'tag', '÷2'); x2.type = h2.type = 'button';
    x2.onclick = () => { if (t.bpm * 2 <= 240) showBpm(t.bpm * 2, tagText, gold); }; h2.onclick = () => { if (t.bpm / 2 >= 40) showBpm(t.bpm / 2, tagText, gold); };
    line.append(x2, h2);
    use.disabled = false; meas.hidden = true;
  };
  const measure = async () => {
    meas.disabled = true; line.innerHTML = ''; line.appendChild(el('span', 'measuring', '試聴を解析中…'));
    try {
      const res = await analyzeAudio(await previewBytes(t));
      if (!res) throw new Error('short');
      let bpm = res.bpm, note = { high: '確度 高', medium: '確度 中', low: '確度 低' }[res.confidence];
      const db = opts.dbTempo;
      if (db) for (const m of [2, 0.5]) { const v = bpm * m; if (Math.abs(v - db) / db < 0.03 && Math.abs(bpm - db) / db >= 0.03) { bpm = v; note = 'データベースに合わせて補正'; } }
      showBpm(bpm, '試聴から測定 ・ ' + note, res.confidence === 'high');
    } catch (err) { line.innerHTML = ''; line.appendChild(el('span', 'measuring', '解析できませんでした。もう一度試すか、試聴に合わせて叩いてください')); meas.disabled = false; }
  };
  meas.onclick = measure;
  let panel = null;
  play.onclick = async () => {
    ensureCtx(); // must happen inside the tap so phones allow sound
    if (pv && pv.id === t.id) { pv.stop(); return; }
    if (pv) pv.stop();
    play.disabled = true; play.textContent = '読み込み中…';
    try {
      const buf = await decodeFor(t);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
      if (!panel) {
        panel = el('div', 'check');
        panel.appendChild(el('p', null, '試聴に合わせて、拍ごとに叩いてください。叩いた速さと候補のBPMを比べます。'));
        const tb = el('button', 'checktap', 'ここを叩く'); tb.type = 'button';
        const rb = el('div', 'checkres');
        panel.append(tb, rb); row.appendChild(panel);
        tapAlong(tb, rb, () => t.bpm, (bpm) => chooseSong(Object.assign({}, t, { bpm })));
      }
      const me = { id: t.id, stop() { try { src.stop(); } catch (e) {} } };
      src.onended = () => { if (pv === me) pv = null; play.textContent = PLAY; };
      pv = me; play.textContent = '■ 止める';
    } catch (err) { play.textContent = PLAY; toast('試聴を再生できませんでした。通信を確かめてもう一度'); }
    finally { play.disabled = false; }
  };
  if (!t.preview) { play.hidden = true; meas.hidden = true; }
  if (opts.local) showBpm(opts.local.bpm, 'Steadyのデータ', true);
  else if (opts.auto) measure();
  return row;
}
function showResults(d) {
  const box = $('searchResult'); box.innerHTML = '';
  const songs = (d.songs || []).filter((s) => s.tempo >= 30 && s.tempo <= 300), tracks = d.tracks || [], local = d.local || [];
  const localById = new Map(local.map((s) => [s.id, s]));
  const localOnly = local.filter((s) => !tracks.some((t) => t.id === s.id));
  const dbHit = songs.find((s) => s.match);
  if (!songs.length && !tracks.length && !localOnly.length) { $('searchStatus').textContent = '見つかりませんでした。表記を変えるか、下で叩いて測ってください。'; return; }
  $('searchStatus').textContent = '';
  if (tracks.length || localOnly.length) {
    const h = el('div', 'sect'); h.appendChild(el('span', null, '曲')); h.appendChild(el('span', null, '試聴できます')); box.appendChild(h);
    tracks.slice(0, 3).forEach((t, i) => box.appendChild(trackCard(t, { auto: i === 0, dbTempo: i === 0 && dbHit ? dbHit.tempo : null, local: localById.get(t.id) })));
    localOnly.forEach((s) => box.appendChild(trackCard({ id: s.id, title: s.title, artist: s.artist, art: s.art, preview: null }, { local: s })));
  }
  const matched = songs.filter((s) => s.match), list = matched.length ? matched : songs;
  if (list.length) {
    const h = el('div', 'sect'); h.appendChild(el('span', null, 'BPMデータベース')); if (!matched.length && $('qArtist').value.trim()) h.appendChild(el('span', null, '同じ曲名の別の曲')); box.appendChild(h);
    list.slice(0, matched.length ? 3 : 4).forEach((s) => {
      const r = el('div', 'dbrow'), l = el('div');
      l.appendChild(el('div', 't', s.title)); l.appendChild(el('div', 'a', s.artist + (s.time_sig ? ' ・ ' + s.time_sig + '拍子' : ''))); r.appendChild(l);
      const rr = el('div', 'r'); rr.appendChild(el('span', 'bpm num', String(s.tempo)));
      const b = el('button', 'btn', '練習'); b.type = 'button'; b.onclick = () => chooseSong({ title: s.title, artist: s.artist, bpm: s.tempo, art: dbHit && tracks[0] && s.match ? tracks[0].art : '' });
      rr.appendChild(b); r.appendChild(rr); box.appendChild(r);
    });
  }
}
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = $('qArtist').value.trim(), t = $('qTitle').value.trim();
  if (!t) { $('searchStatus').textContent = '曲名を入れてください'; $('qTitle').focus(); return; }
  store.set('steady.q', { a, t });
  document.activeElement && document.activeElement.blur();
  $('askBtn').disabled = true; $('searchStatus').textContent = '調べています…'; $('searchResult').innerHTML = '';
  try {
    const jpLoad = loadJp();
    let tracks = [];
    try { tracks = await findTracks(a, t); } catch (err) { tracks = []; }
    await jpLoad;
    // Apple Music searched artist + title together; trust a title match when the artist is spelled differently
    const top = tracks.find((x) => !a || near(x.artist, a) || near(x.artistEn, a)) || tracks.find((x) => near(x.title, t) || near(x.titleEn, t));
    const aa = top ? [top.artist, top.artistEn].filter(Boolean) : [], at = top ? [top.title, top.titleEn].filter(Boolean) : [];
    if (top) tracks = [top].concat(tracks.filter((x) => x !== top));
    let d = { songs: [] };
    try {
      const r = await fetch(PROXY_URL + '?artist=' + encodeURIComponent(a) + '&title=' + encodeURIComponent(t) + '&aa=' + encodeURIComponent(aa.join('\n')) + '&at=' + encodeURIComponent(at.join('\n')));
      d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
    } catch (err) { d = { songs: [] }; }
    d.tracks = tracks; d.local = localMatches(a, t, tracks);
    showResults(d);
  } catch (err) { $('searchStatus').textContent = 'うまく調べられませんでした。通信を確かめて、もう一度押してください。'; }
  finally { $('askBtn').disabled = false; }
});
(() => { const q = store.get('steady.q', null); if (q) { $('qArtist').value = q.a || ''; $('qTitle').value = q.t || ''; } })();

/* ---------- no zoom, no text selection ---------- */
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTouchEnd < 350 && !e.target.closest('input,select,textarea,button')) e.preventDefault(); lastTouchEnd = n; }, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0', ';'].includes(e.key)) e.preventDefault(); });
document.addEventListener('selectstart', (e) => { if (!e.target.closest || !e.target.closest('input,textarea')) e.preventDefault(); });

/* ---------- boot ---------- */
setMode(S.mode); renderHist(); sizeOrbit(); requestAnimationFrame(frameOrbit);
// example result so the page never opens empty (replaced by the first real run)
(() => {
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bd = 60 / 100, pts = [], marks = [];
  for (let i = 0; i < 50; i++) {
    const t = i * bd, muted = Math.floor(i / 4) % 4 >= 2;
    let dev = -8 - t * 0.9 + (rnd() + rnd() + rnd() - 1.5) * 34 - (muted ? 10 : 0);
    if (rnd() < 0.04) dev = null;
    pts.push({ t, dev, muted });
    if (dev != null) marks.push({ beat: (i % 4) + dev / 1000 / bd, bar: Math.floor(i / 4), dev });
  }
  render(analyze(pts, { bpm: 100, dur: 30, mute: 2, per: 4, marks, bars: 13 }), true);
})();
})();
