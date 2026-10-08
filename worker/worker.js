// Steady BPM search proxy (Cloudflare Worker)
//  GET /?artist=&title=   -> { songs: [GetSongBPM results], tracks: [Apple Music (iTunes) matches] }
//  GET /preview?id=<trackId> -> the 30-second iTunes preview audio (for in-browser tempo analysis)
// Keeps the GetSongBPM API key secret (secret variable GETSONGBPM_KEY) and answers the Steady site.
const ALLOWED_ORIGINS = ['https://ryogurt.github.io'];
const UA = 'SteadyRhythmApp/1.1 (+https://ryogurt.github.io/steady/)';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
const norm = (v) => String(v || '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
const same = (a, b) => !!a && !!b && (a.includes(b) || b.includes(a));

async function getJson(u, ttl) {
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error('http ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

// ---- Apple Music (iTunes Search API, Japanese store) ----
async function itunesSearch(term) {
  const u = new URL('https://itunes.apple.com/search');
  u.searchParams.set('term', term);
  u.searchParams.set('country', 'JP');
  u.searchParams.set('media', 'music');
  u.searchParams.set('entity', 'song');
  u.searchParams.set('limit', '5');
  u.searchParams.set('lang', 'ja_jp');
  const d = await getJson(u.toString(), 86400);
  return (d.results || []).filter((t) => t.trackId && t.previewUrl);
}
// The same tracks with English / romanized names (e.g. 米津玄師 -> Kenshi Yonezu)
async function itunesEnglishNames(ids) {
  if (!ids.length) return {};
  const u = new URL('https://itunes.apple.com/lookup');
  u.searchParams.set('id', ids.join(','));
  u.searchParams.set('country', 'JP');
  u.searchParams.set('lang', 'en_us');
  const d = await getJson(u.toString(), 86400);
  const out = {};
  (d.results || []).forEach((t) => { if (t.trackId) out[t.trackId] = { title: t.trackName || '', artist: t.artistName || '' }; });
  return out;
}

// ---- GetSongBPM ----
async function bpmSearch(env, type, lookup) {
  const u = new URL('https://api.getsong.co/search/');
  u.searchParams.set('api_key', env.GETSONGBPM_KEY);
  u.searchParams.set('type', type);
  u.searchParams.set('lookup', lookup);
  u.searchParams.set('limit', '30');
  const d = await getJson(u.toString(), 86400);
  return Array.isArray(d.search) ? d.search : [];
}

async function handleSearch(url, env, h) {
  const title = (url.searchParams.get('title') || '').trim().slice(0, 100);
  const artist = (url.searchParams.get('artist') || '').trim().slice(0, 100);
  if (!title) return json({ error: 'title required' }, 400, h);

  // 1) Identify the track on Apple Music to learn the other spellings of its names.
  let tracks = [];
  try {
    const found = await itunesSearch((artist + ' ' + title).trim());
    const en = await itunesEnglishNames(found.map((t) => t.trackId)).catch(() => ({}));
    tracks = found.map((t) => ({
      id: t.trackId,
      title: t.trackName || '',
      artist: t.artistName || '',
      titleEn: (en[t.trackId] && en[t.trackId].title) || '',
      artistEn: (en[t.trackId] && en[t.trackId].artist) || '',
      art: t.artworkUrl100 || '',
      seconds: t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
    }));
  } catch (e) {
    tracks = [];
    if (url.searchParams.get('debug') === '1') return json({ itunesError: String(e && e.message || e) }, 200, h);
  }

  // Names that count as "the same artist" / titles worth asking GetSongBPM about
  const top = tracks[0];
  const artistNames = new Set([norm(artist)]);
  const titles = [title];
  if (top && (!artist || same(norm(top.artist), norm(artist)) || same(norm(top.artistEn), norm(artist)) || !artist)) {
    artistNames.add(norm(top.artist));
    artistNames.add(norm(top.artistEn));
    [top.title, top.titleEn].forEach((t) => { if (t && !titles.some((x) => norm(x) === norm(t))) titles.push(t); });
  }
  artistNames.delete('');
  const isMatch = (name) => { const n = norm(name); return [...artistNames].some((a) => same(n, a)); };

  // 2) Ask GetSongBPM with each spelling of the title (max 2), plus title+artist if still no match.
  let list = [];
  try {
    for (const t of titles.slice(0, 2)) list = list.concat(await bpmSearch(env, 'song', t));
    if (artist && !list.some((s) => isMatch(s && s.artist && s.artist.name))) {
      list = (await bpmSearch(env, 'both', `song:${title} artist:${artist}`)).concat(list);
    }
  } catch (e) {
    /* keep whatever we have */
  }

  const seen = new Set();
  const songs = list
    .filter((s) => s && s.tempo)
    .map((s) => {
      const a = (s.artist && s.artist.name) || '';
      return {
        title: s.song_title || s.title || '',
        artist: a,
        tempo: Number(s.tempo),
        time_sig: s.time_sig || '',
        uri: s.song_uri || s.uri || '',
        match: artistNames.size > 0 && isMatch(a),
      };
    })
    .filter((s) => {
      const k = norm(s.artist) + '|' + norm(s.title) + '|' + s.tempo;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => Number(y.match) - Number(x.match))
    .slice(0, 10);

  return json({ songs, tracks: tracks.slice(0, 3) }, 200, { ...h, 'Cache-Control': 'public, max-age=3600' });
}

async function handlePreview(url, h) {
  const id = (url.searchParams.get('id') || '').replace(/\D/g, '').slice(0, 20);
  if (!id) return json({ error: 'id required' }, 400, h);
  const d = await getJson(`https://itunes.apple.com/lookup?id=${id}&country=JP`, 86400);
  const t = (d.results || [])[0];
  const src = t && t.previewUrl;
  if (!src) return json({ error: 'no preview' }, 404, h);
  const host = new URL(src).hostname;
  if (!/(\.|^)(apple\.com|mzstatic\.com)$/.test(host)) return json({ error: 'bad host' }, 400, h);
  const r = await fetch(src, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) return json({ error: 'preview ' + r.status }, 502, h);
  return new Response(r.body, {
    status: 200,
    headers: { ...h, 'Content-Type': r.headers.get('Content-Type') || 'audio/mp4', 'Cache-Control': 'public, max-age=86400' },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const h = cors(origin);
    if (request.method === 'OPTIONS') return new Response(null, { headers: h });
    if (request.method !== 'GET') return json({ error: 'method' }, 405, h);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/preview') return await handlePreview(url, h);
      if (!env.GETSONGBPM_KEY) return json({ error: 'APIキーが未設定です' }, 500, h);
      return await handleSearch(url, env, h);
    } catch (e) {
      return json({ error: 'upstream' }, 502, h);
    }
  },
};
