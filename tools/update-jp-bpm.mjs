// Daily job: add BPMs of Japanese songs to data/bpm-jp.json
//
// 1. Take the Apple Music Japan "most played" chart (top 100 songs).
// 2. Add a few more songs by the chart's artists so the list keeps growing beyond the chart.
// 3. For every song not in the data yet, download its 30-second preview, decode it with ffmpeg
//    and estimate the tempo with the same code the web page uses (tempo.js).
// Run by .github/workflows/daily-jp-bpm.yml. Needs Node 18+ and ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
createRequire(import.meta.url)(path.join(root, 'tempo.js'));
const { estimateTempo } = globalThis.SteadyTempo;

const DATA = path.join(root, 'data', 'bpm-jp.json');
const MAX_NEW = Number(process.env.MAX_NEW || 60);        // songs analysed per run
const ARTIST_LOOKUPS = Number(process.env.ARTIST_LOOKUPS || 15);
const UA = 'SteadyRhythmApp/1.1 (+https://ryogurt.github.io/steady/)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * (i + 1)); continue; }
    throw new Error(`${r.status} ${url}`);
  }
  throw new Error(`gave up ${url}`);
}

function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return { updated: null, songs: [] }; }
}

async function chartIds() {
  const d = await getJson('https://rss.applemarketingtools.com/api/v2/jp/music/most-played/100/songs.json');
  return (d.feed && d.feed.results ? d.feed.results : []).map((r) => ({ id: Number(r.id), artistId: Number(r.artistId) }));
}

// iTunes lookup accepts many ids at once; ask in both Japanese and English to get both spellings
async function lookupTracks(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).join(',');
    const ja = await getJson(`https://itunes.apple.com/lookup?id=${chunk}&country=JP&lang=ja_jp`);
    await sleep(3000);
    const en = await getJson(`https://itunes.apple.com/lookup?id=${chunk}&country=JP&lang=en_us`);
    await sleep(3000);
    const enById = new Map((en.results || []).map((t) => [t.trackId, t]));
    for (const t of ja.results || []) {
      if (t.wrapperType !== 'track' || !t.previewUrl) continue;
      const e = enById.get(t.trackId) || {};
      out.set(t.trackId, {
        id: t.trackId,
        title: t.trackName || '',
        artist: t.artistName || '',
        titleEn: e.trackName && e.trackName !== t.trackName ? e.trackName : '',
        artistEn: e.artistName && e.artistName !== t.artistName ? e.artistName : '',
        artistId: t.artistId || null,
        preview: t.previewUrl,
        art: t.artworkUrl100 || '',
      });
    }
  }
  return out;
}

// Top songs of an artist (to grow the list beyond this week's chart)
async function artistTopSongIds(artistId) {
  const d = await getJson(`https://itunes.apple.com/lookup?id=${artistId}&entity=song&limit=10&country=JP`);
  return (d.results || []).filter((t) => t.wrapperType === 'track').map((t) => t.trackId);
}

async function analysePreview(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('preview ' + r.status);
  const tmp = path.join(process.env.RUNNER_TEMP || '/tmp', 'preview.m4a');
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-t', '40', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  return estimateTempo(x, 22050);
}

async function main() {
  const data = load();
  const have = new Set(data.songs.map((s) => s.id));

  const chart = await chartIds();
  console.log('chart songs:', chart.length);
  let ids = chart.map((c) => c.id).filter((id) => !have.has(id));

  // grow beyond the chart: top songs of artists, rotating through the chart day by day
  const artists = [...new Set(chart.map((c) => c.artistId).filter(Boolean))];
  const day = Math.floor(Date.now() / 86400000);
  for (let k = 0; k < Math.min(ARTIST_LOOKUPS, artists.length); k++) {
    const a = artists[(day * ARTIST_LOOKUPS + k) % artists.length];
    try { ids.push(...(await artistTopSongIds(a)).filter((id) => !have.has(id))); } catch (e) { console.warn('artist', a, e.message); }
    await sleep(3000);
  }
  ids = [...new Set(ids)].slice(0, MAX_NEW);
  console.log('new candidates:', ids.length);
  if (!ids.length) return finish(data, 0);

  const tracks = await lookupTracks(ids);
  let added = 0;
  for (const id of ids) {
    const t = tracks.get(id);
    if (!t) continue;
    try {
      const res = await analysePreview(t.preview);
      if (!res) continue;
      data.songs.push({
        id: t.id, title: t.title, artist: t.artist,
        ...(t.titleEn ? { titleEn: t.titleEn } : {}), ...(t.artistEn ? { artistEn: t.artistEn } : {}),
        bpm: Math.round(res.bpm), confidence: res.confidence, art: t.art,
        added: new Date().toISOString().slice(0, 10),
      });
      added++;
      console.log(`${res.bpm}\t${res.confidence}\t${t.artist} / ${t.title}`);
    } catch (e) {
      console.warn('skip', t.artist, t.title, e.message);
    }
    await sleep(500);
  }
  finish(data, added);
}

function finish(data, added) {
  data.songs.sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title, 'ja'));
  data.updated = new Date().toISOString();
  data.count = data.songs.length;
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(data, null, 1) + '\n');
  console.log(`added ${added}, total ${data.songs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
