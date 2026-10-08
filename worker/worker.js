// Steady BPM search proxy (Cloudflare Worker)
// Keeps the GetSongBPM API key secret (set it as the secret variable GETSONGBPM_KEY)
// and only answers requests from the Steady site.
const ALLOWED_ORIGINS = ['https://ryogurt.github.io'];

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const h = cors(origin);
    if (request.method === 'OPTIONS') return new Response(null, { headers: h });
    if (request.method !== 'GET') return json({ error: 'method' }, 405, h);
    if (!env.GETSONGBPM_KEY) return json({ error: 'APIキーが未設定です' }, 500, h);

    const url = new URL(request.url);
    const title = (url.searchParams.get('title') || '').trim().slice(0, 100);
    const artist = (url.searchParams.get('artist') || '').trim().slice(0, 100);
    if (!title) return json({ error: 'title required' }, 400, h);

    // Search by song title (artist credits in the database often differ, e.g. "Mark Ronson" for
    // "Uptown Funk"), then put results whose artist matches what the user typed first.
    const norm = (v) => String(v || '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}]/gu, '');
    const want = norm(artist);

    async function search(type, lookup) {
      const api = new URL('https://api.getsong.co/search/');
      api.searchParams.set('api_key', env.GETSONGBPM_KEY);
      api.searchParams.set('type', type);
      api.searchParams.set('lookup', lookup);
      api.searchParams.set('limit', '30');
      const r = await fetch(api.toString(), {
        headers: { 'User-Agent': 'SteadyRhythmApp/1.0 (+https://ryogurt.github.io/steady/)', 'Accept': 'application/json' },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      const d = await r.json();
      return Array.isArray(d.search) ? d.search : [];
    }

    try {
      let list = await search('song', title);
      if (!list.length && artist) list = await search('both', `song:${title} artist:${artist}`);
      const seen = new Set();
      const songs = list
        .filter((s) => s && s.tempo)
        .map((s) => {
          const a = (s.artist && s.artist.name) || '';
          const na = norm(a);
          return {
            title: s.song_title || s.title || '',
            artist: a,
            tempo: Number(s.tempo),
            time_sig: s.time_sig || '',
            uri: s.song_uri || s.uri || '',
            match: !!want && !!na && (na.includes(want) || want.includes(na)),
          };
        })
        .filter((s) => {
          const k = s.artist + '|' + s.title + '|' + s.tempo;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((x, y) => Number(y.match) - Number(x.match))
        .slice(0, 10);
      return json({ songs }, 200, { ...h, 'Cache-Control': 'public, max-age=3600' });
    } catch (e) {
      return json({ error: 'upstream' }, 502, h);
    }
  },
};
