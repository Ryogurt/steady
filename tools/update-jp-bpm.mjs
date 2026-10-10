// Collect BPMs of Japanese songs into data/bpm-jp.json
//
// Sources (Apple Music, Japanese store):
//   1. the "most played" chart (top 100)
//   2. keyword searches (common words in Japanese lyrics/titles, genres, scenes) — these surface
//      lesser-known songs, up to 200 tracks per search
//   3. every artist met along the way: their songs (up to 50 each), so the list keeps widening
// Each new song's 30-second preview is decoded with ffmpeg and its tempo estimated with tempo.js
// (the same code as the web page), in parallel worker threads.
//
// Env: TIME_LIMIT_MIN (stop and save after this many minutes), MAX_NEW (cap on new songs),
//      COMMIT_EVERY (push progress every N new songs; 0 = never, the workflow commits at the end)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '..');
const require = createRequire(import.meta.url);
const UA = 'SteadyRhythmApp/1.2 (+https://ryogurt.github.io/steady/)';

/* ---------------- worker: download, decode, estimate ---------------- */
if (!isMainThread) {
  require(path.join(root, 'tempo.js'));
  const { estimateTempo } = globalThis.SteadyTempo;
  parentPort.on('message', async ({ id, url, tmpDir }) => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('preview ' + r.status);
      const tmp = path.join(tmpDir, `p${id}.m4a`);
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-t', '40', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
      fs.rmSync(tmp, { force: true });
      const x = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + Math.floor(raw.byteLength / 4) * 4));
      const res = estimateTempo(x, 22050);
      parentPort.postMessage({ id, res });
    } catch (e) {
      parentPort.postMessage({ id, err: String(e.message || e) });
    }
  });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}

/* ---------------- main ---------------- */
async function main() {
  const DATA = path.join(root, 'data', 'bpm-jp.json');
  const T_END = Date.now() + Number(process.env.TIME_LIMIT_MIN || 25) * 60000;
  const MAX_NEW = Number(process.env.MAX_NEW || 100000);
  const COMMIT_EVERY = Number(process.env.COMMIT_EVERY || 0);
  const WORKERS = Math.max(2, Math.min(8, os.cpus().length * 2));
  const tmpDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'bpm-'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timeLeft = () => T_END - Date.now();

  // ---- data (v2: compact rows) ----
  const FIELDS = ['id', 'title', 'artist', 'titleEn', 'artistEn', 'bpm', 'conf', 'artistId', 'added'];
  const songs = new Map();
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    if (d.v === 2) d.rows.forEach((r) => songs.set(r[0], Object.fromEntries(FIELDS.map((f, i) => [f, r[i]]))));
    else (d.songs || []).forEach((s) => songs.set(s.id, { id: s.id, title: s.title, artist: s.artist, titleEn: s.titleEn || '', artistEn: s.artistEn || '', bpm: s.bpm, conf: s.confidence === 'high' ? 2 : s.confidence === 'medium' ? 1 : 0, artistId: s.artistId || 0, added: s.added || '' }));
  } catch {}
  const startCount = songs.size;
  const save = () => {
    const rows = [...songs.values()].sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title, 'ja')).map((s) => FIELDS.map((f) => s[f] ?? ''));
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    fs.writeFileSync(DATA, JSON.stringify({ v: 2, updated: new Date().toISOString(), count: rows.length, fields: FIELDS, rows }) + '\n');
  };
  const commit = (msg) => {
    try {
      execFileSync('git', ['add', 'data/bpm-jp.json'], { cwd: root });
      execFileSync('git', ['commit', '-q', '-m', msg], { cwd: root });
      execFileSync('git', ['pull', '-q', '--rebase', '-X', 'theirs', 'origin', 'main'], { cwd: root });
      execFileSync('git', ['push', '-q'], { cwd: root });
      console.log('pushed:', msg);
    } catch (e) { console.warn('commit failed', e.message); }
  };

  // ---- Apple Music, politely (about 20 requests a minute) ----
  let lastCall = 0;
  async function apple(url) {
    for (let i = 0; i < 4; i++) {
      const wait = lastCall + 3200 - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (r.ok) return r.json();
        if (r.status === 403 || r.status === 429 || r.status >= 500) { console.warn('apple', r.status, 'backing off'); await sleep(20000 * (i + 1)); continue; }
        return { results: [] };
      } catch (e) { await sleep(5000); }
    }
    return { results: [] };
  }
  const JP = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
  const JP_GENRES = new Set(['J-Pop', 'アニメ', '歌謡曲', '演歌', 'ボーカロイド', 'J-Rock', 'Anime', 'Kayokyoku', 'Enka', 'Vocaloid', 'ジャパニーズ・ポップ']);
  const isJapanese = (t) => JP.test(t.trackName || '') || JP.test(t.artistName || '') || JP_GENRES.has(t.primaryGenreName);

  const queue = []; // tracks waiting for analysis
  const seenIds = new Set(songs.keys());
  const artistsSeen = new Map(); // artistId -> times expanded
  function enqueue(results) {
    let n = 0;
    for (const t of results || []) {
      if (t.wrapperType !== 'track' || t.kind !== 'song' || !t.previewUrl || seenIds.has(t.trackId) || !isJapanese(t)) continue;
      seenIds.add(t.trackId);
      queue.push({ id: t.trackId, title: t.trackName || '', artist: t.artistName || '', artistId: t.artistId || 0, preview: t.previewUrl });
      if (t.artistId && !artistsSeen.has(t.artistId)) artistsSeen.set(t.artistId, 0);
      n++;
    }
    return n;
  }
  songs.forEach((s) => { if (s.artistId && !artistsSeen.has(s.artistId)) artistsSeen.set(s.artistId, 0); });

  // keyword pool: frequent words of Japanese song titles, genres and scenes, rotated by day
  const WORDS = ('夜 恋 空 君 夏 雨 桜 青春 さよなら 未来 星 花 風 光 夢 心 涙 愛 海 月 春 秋 冬 雪 朝 夕焼け 街 東京 大阪 旅 帰り道 約束 奇跡 永遠 記憶 世界 僕 私 あなた 二人 ひとり 好き 嘘 本当 魔法 天使 少女 少年 ' +
    '線香花火 花火 祭り 放課後 卒業 教室 制服 ラブレター 片想い 失恋 告白 秘密 運命 ヒーロー 革命 ロック バンド ギター ドラム ダンス ワルツ マーチ ブルース ジャズ ファンク シティポップ ' +
    'アニメ ボカロ 初音ミク 歌ってみた アイドル 演歌 歌謡曲 フォーク インディーズ 弾き語り ライブ アコースティック ピアノ 子守唄 童謡 ゲーム 映画 ドラマ 主題歌 エンディング オープニング ' +
    'ありがとう ごめんね おやすみ ただいま いってきます 大丈夫 がんばれ ハレルヤ キラキラ ドキドキ ふわふわ ぐるぐる わくわく パレード サーカス ジェットコースター 宇宙 銀河 惑星 流星 ' +
    '虹 雷 嵐 波 森 砂漠 月光 太陽 灯 影 鏡 扉 鍵 手紙 写真 電話 メロディー リズム ビート ノイズ サイレン 時計 カレンダー 日曜日 月曜日 金曜日 Friday 深夜 真夜中 午前0時 ' +
    '猫 犬 鳥 金魚 ひまわり あじさい 紫陽花 梅 椿 向日葵 cherry 青 赤 白 黒 金色 透明 ネオン スローモーション ラストシーン プロローグ エピローグ アンコール').split(/\s+/).filter(Boolean);
  const day = Math.floor(Date.now() / 86400000);
  const wordOrder = WORDS.map((w, i) => [w, (i * 7919 + day * 104729) % 1000003]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  let wordIx = 0;

  async function refill() {
    // 1) chart once
    if (!refill.chartDone) {
      refill.chartDone = true;
      try {
        const c = await (await fetch('https://rss.applemarketingtools.com/api/v2/jp/music/most-played/100/songs.json')).json();
        const ids = (c.feed && c.feed.results ? c.feed.results : []).map((r) => r.id).filter((id) => !seenIds.has(Number(id)));
        for (let i = 0; i < ids.length; i += 150) enqueue((await apple(`https://itunes.apple.com/lookup?id=${ids.slice(i, i + 150).join(',')}&country=JP&lang=ja_jp`)).results);
      } catch (e) { console.warn('chart', e.message); }
      return;
    }
    // 2) alternate: an artist's songs, then a keyword search
    refill.turn = (refill.turn || 0) + 1;
    const fresh = [...artistsSeen.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    if (refill.turn % 2 === 0 && fresh.length) {
      const ids = fresh.slice(0, 1);
      ids.forEach((id) => artistsSeen.set(id, 1));
      const n = enqueue((await apple(`https://itunes.apple.com/lookup?id=${ids[0]}&entity=song&limit=50&country=JP&lang=ja_jp`)).results);
      if (n) console.log(`artist ${ids[0]}: +${n}`);
    } else if (wordIx < wordOrder.length) {
      const w = wordOrder[wordIx++];
      const n = enqueue((await apple(`https://itunes.apple.com/search?term=${encodeURIComponent(w)}&country=JP&media=music&entity=song&limit=200&lang=ja_jp`)).results);
      console.log(`search "${w}": +${n}`);
    } else if (fresh.length) {
      const id = fresh[0]; artistsSeen.set(id, 1);
      enqueue((await apple(`https://itunes.apple.com/lookup?id=${id}&entity=song&limit=50&country=JP&lang=ja_jp`)).results);
    } else refill.empty = true;
  }

  // ---- worker pool ----
  const workers = Array.from({ length: WORKERS }, () => new Worker(here));
  const pending = new Map();
  workers.forEach((w) => w.on('message', (m) => { const p = pending.get(m.id); pending.delete(m.id); p && p(m); }));
  const analyse = (w, t) => new Promise((res) => { pending.set(t.id, res); w.postMessage({ id: t.id, url: t.preview, tmpDir }); });

  // English / romanized names, in batches
  const needEn = [];
  async function fillEnglish(force) {
    while (needEn.length >= 150 || (force && needEn.length)) {
      const batch = needEn.splice(0, 150);
      const d = await apple(`https://itunes.apple.com/lookup?id=${batch.join(',')}&country=JP&lang=en_us`);
      for (const t of d.results || []) {
        const s = songs.get(t.trackId); if (!s) continue;
        if (t.trackName && t.trackName !== s.title) s.titleEn = t.trackName;
        if (t.artistName && t.artistName !== s.artist) s.artistEn = t.artistName;
      }
    }
  }

  let added = 0, lastCommit = 0, failed = 0;
  const today = new Date().toISOString().slice(0, 10);
  // feeder keeps the queue topped up while workers analyse
  let feeding = false;
  const feeder = (async () => {
    while (timeLeft() > 60000 && added < MAX_NEW && !refill.empty) {
      if (queue.length < WORKERS * 30) { feeding = true; await refill(); feeding = false; }
      else await sleep(1000);
    }
  })();
  await Promise.all(workers.map(async (w) => {
    while (timeLeft() > 45000 && added < MAX_NEW) {
      const t = queue.shift();
      if (!t) { if (refill.empty && !feeding) break; await sleep(500); continue; }
      const m = await analyse(w, t);
      if (m.err || !m.res) { failed++; continue; }
      songs.set(t.id, { id: t.id, title: t.title, artist: t.artist, titleEn: '', artistEn: '', bpm: Math.round(m.res.bpm), conf: m.res.confidence === 'high' ? 2 : m.res.confidence === 'medium' ? 1 : 0, artistId: t.artistId, added: today });
      needEn.push(t.id);
      added++;
      if (added % 50 === 0) console.log(`analysed ${added} (queue ${queue.length}, artists ${artistsSeen.size}, failed ${failed}, ${Math.round(timeLeft() / 60000)} min left)`);
      if (COMMIT_EVERY && added - lastCommit >= COMMIT_EVERY) {
        lastCommit = added;
        await fillEnglish(false);
        save(); commit(`Add Japanese song BPMs (${songs.size} songs)`);
      }
    }
  }));
  await feeder.catch(() => {});
  workers.forEach((w) => w.terminate());
  try { await fillEnglish(true); } catch {}
  save();
  console.log(`done: +${added} (failed ${failed}), total ${songs.size} (was ${startCount})`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
