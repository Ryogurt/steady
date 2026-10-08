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

    const type = artist ? 'both' : 'song';
    const lookup = artist ? `song:${title} artist:${artist}` : title;
    const api = new URL('https://api.getsong.co/search/');
    api.searchParams.set('api_key', env.GETSONGBPM_KEY);
    api.searchParams.set('type', type);
    api.searchParams.set('lookup', lookup);
    api.searchParams.set('limit', '10');

    try {
      const r = await fetch(api.toString(), {
        headers: { 'User-Agent': 'SteadyRhythmApp/1.0 (+https://ryogurt.github.io/steady/)', 'Accept': 'application/json' },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      const raw = await r.text();
      if (url.searchParams.get('debug') === '1') {
        return json({ status: r.status, body: raw.slice(0, 1500) }, 200, h);
      }
      const d = JSON.parse(raw);
      const list = Array.isArray(d.search) ? d.search : [];
      const songs = list
        .filter((s) => s && s.tempo)
        .map((s) => ({
          title: s.song_title || s.title || '',
          artist: (s.artist && s.artist.name) || '',
          tempo: Number(s.tempo),
          time_sig: s.time_sig || '',
          uri: s.song_uri || s.uri || '',
        }));
      return json({ songs }, 200, { ...h, 'Cache-Control': 'public, max-age=3600' });
    } catch (e) {
      return json({ error: 'upstream' }, 502, h);
    }
  },
};
