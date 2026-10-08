// Steady tempo estimator — shared by the web page and the daily data job (tools/update-jp-bpm.mjs).
// Spectral flux onset envelope + comb-filtered autocorrelation with a tempo prior centred on 120 BPM.
(function (g) {
function fftMag(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
function estimateTempo(x, sr) {
  const N = 1024, hop = 128, half = N / 2;
  const frames = Math.floor((x.length - N) / hop);
  if (frames < 200) return null;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float32Array(half), cur = new Float32Array(half);
  const flux = new Float32Array(frames);
  const maxBin = Math.min(half, Math.floor(8000 / (sr / N)));
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fftMag(re, im);
    let s = 0;
    for (let k = 1; k < maxBin; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0 && f > 0) s += d;
    }
    flux[f] = s;
    const t = prev; prev = cur; cur = t;
  }
  // remove slow trend, keep the rises
  const fr = sr / hop, w = Math.round(fr * 0.4);
  const env = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += flux[f]; if (f >= w) acc -= flux[f - w];
    const avg = acc / Math.min(f + 1, w);
    env[f] = Math.max(0, flux[f] - avg);
  }
  // autocorrelation up to 4 beats at the slowest tempo
  const minBpm = 50, maxBpm = 220;
  const maxLag = Math.min(frames - 1, Math.ceil(fr * 60 / minBpm * 8) + 2);
  const ac = new Float64Array(maxLag + 1);
  for (let L = 0; L <= maxLag; L++) {
    let s = 0;
    for (let f = L; f < frames; f++) s += env[f] * env[f - L];
    ac[L] = s / (frames - L);
  }
  const a0 = ac[0] || 1;
  for (let L = 0; L <= maxLag; L++) ac[L] /= a0;
  const at = (l) => { if (l >= maxLag) return 0; const i = Math.floor(l), t = l - i; return ac[i] * (1 - t) + ac[i + 1] * t; };
  const comb = (bpm, K) => { const lag = fr * 60 / bpm; let s = 0; for (let k = 1; k <= K; k++) s += at(lag * k); return s / K; };
  // coarse scan with a tempo prior centred on 120 BPM
  let best = 0, bestScore = -1;
  const scores = [];
  for (let b = minBpm; b <= maxBpm; b += 0.1) {
    const sc = comb(b, 4);
    scores.push(sc);
    const p = Math.exp(-0.5 * Math.pow(Math.log2(b / 120) / 0.9, 2));
    if (sc * p > bestScore) { bestScore = sc * p; best = b; }
  }
  // fine tune with more multiples (sharper peak)
  let fine = best, fineScore = -1;
  for (let b = best - 1.5; b <= best + 1.5; b += 0.01) {
    const sc = comb(b, 8);
    if (sc > fineScore) { fineScore = sc; fine = b; }
  }
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length) || 1;
  const z = (comb(best, 4) - mean) / sd;
  const rounded = Math.abs(fine - Math.round(fine)) < 0.25 ? Math.round(fine) : Math.round(fine * 10) / 10;
  return { bpm: rounded, raw: fine, confidence: z > 3 ? 'high' : z > 2 ? 'medium' : 'low' };
}
  g.SteadyTempo = { estimateTempo };
})(typeof window !== 'undefined' ? window : globalThis);
