const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');

const manifest = {
  id: 'community.shuffle.episodes',
  version: '1.0.0',
  name: '🎲 Episode Shuffler',
  description: 'Randomly shuffle & play TV show episodes. Stop watching in order.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  idPrefixes: ['shuffle:'],
  catalogs: [
    {
      type: 'series',
      id: 'shuffle_catalog',
      name: '🎲 Shuffle Queue',
      extra: [{ name: 'search', isRequired: false }],
    },
  ],
  behaviorHints: { configurable: true, configurationRequired: false },
};

const builder = new addonBuilder(manifest);
const shuffleStore = new Map();

function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

builder.defineCatalogHandler(({ type, id }) => {
  if (type !== 'series' || id !== 'shuffle_catalog') return Promise.resolve({ metas: [] });
  const metas = [];
  for (const [showId, state] of shuffleStore.entries()) {
    metas.push({
      id: 'shuffle:' + showId,
      type: 'series',
      name: '🎲 ' + (state.showName || showId),
      poster: state.poster || null,
      description: (state.shuffled.length - state.pointer) + ' episodes remaining in shuffle',
    });
  }
  return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ type, id }) => {
  if (type !== 'series' || !id.startsWith('shuffle:')) return Promise.resolve({ meta: null });
  const showId = id.replace('shuffle:', '');
  const state = shuffleStore.get(showId);
  if (!state) return Promise.resolve({ meta: null });
  const videos = state.shuffled.map((ep, idx) => ({
    id: 'shuffle:' + showId + ':' + idx,
    title: '#' + (idx + 1) + ' — ' + (ep.title || ep.id),
    season: 0,
    episode: idx + 1,
    released: new Date(Date.now() - (state.shuffled.length - idx) * 86400000).toISOString(),
    thumbnail: ep.thumbnail || null,
    overview: idx < state.pointer ? '✅ Watched' : idx === state.pointer ? '▶ Up next' : '',
  }));
  return Promise.resolve({
    meta: {
      id: 'shuffle:' + showId,
      type: 'series',
      name: '🎲 ' + (state.showName || showId),
      poster: state.poster || null,
      description: 'Episode Shuffler — ' + state.shuffled.length + ' episodes randomized.',
      videos,
    },
  });
});

builder.defineStreamHandler(({ type, id }) => {
  if (type !== 'series' || !id.startsWith('shuffle:')) return Promise.resolve({ streams: [] });
  const parts = id.split(':');
  const showId = parts[1];
  const episodeIndex = parseInt(parts[2], 10);
  const state = shuffleStore.get(showId);
  if (!state) return Promise.resolve({ streams: [] });
  const ep = isNaN(episodeIndex) ? state.shuffled[state.pointer] : state.shuffled[episodeIndex];
  if (!ep) return Promise.resolve({ streams: [] });
  if (!isNaN(episodeIndex) && episodeIndex === state.pointer) {
    state.pointer++;
    if (state.pointer >= state.shuffled.length) {
      state.shuffled = fisherYates(state.episodes);
      state.pointer = 0;
    }
  }
  return Promise.resolve({
    streams: [
      {
        title: '▶ ' + (ep.title || ep.id) + '\n🎲 Shuffled Episode ' + (episodeIndex + 1) + ' of ' + state.shuffled.length,
        externalUrl: 'stremio://detail/' + (ep.type || 'series') + '/' + (ep.seriesId || showId) + '/' + ep.id,
        behaviorHints: { notWebReady: false },
      },
    ],
  });
});

const app = express();
app.use(express.json());

const addonInterface = builder.getInterface();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));

app.get('/:resource/:type/:id.json', (req, res) => {
  const { resource, type, id } = req.params;
  addonInterface.get(resource, type, id, { ...req.query, type, id })
    .then(resp => res.json(resp))
    .catch(() => res.json({ error: 'Handler error' }));
});

app.post('/api/shuffle', (req, res) => {
  const { showId, showName, poster, background, episodes } = req.body;
  if (!showId || !Array.isArray(episodes) || episodes.length === 0)
    return res.status(400).json({ error: 'showId and episodes[] required' });
  const shuffled = fisherYates(episodes);
  shuffleStore.set(showId, { showId, showName: showName || showId, poster, background, episodes, shuffled, pointer: 0, createdAt: Date.now() });
  res.json({ ok: true, showId, total: episodes.length, shuffleId: 'shuffle:' + showId, firstEpisode: shuffled[0] });
});

app.get('/api/shuffle/:showId', (req, res) => {
  const state = shuffleStore.get(req.params.showId);
  if (!state) return res.status(404).json({ error: 'Not found' });
  res.json({ ...state, remaining: state.shuffled.length - state.pointer, current: state.shuffled[state.pointer] || null });
});

app.post('/api/shuffle/:showId/reshuffle', (req, res) => {
  const state = shuffleStore.get(req.params.showId);
  if (!state) return res.status(404).json({ error: 'Not found' });
  state.shuffled = fisherYates(state.episodes);
  state.pointer = 0;
  res.json({ ok: true, firstEpisode: state.shuffled[0] });
});

app.delete('/api/shuffle/:showId', (req, res) => {
  shuffleStore.delete(req.params.showId);
  res.json({ ok: true });
});

app.get('/api/shows', (req, res) => {
  const shows = [...shuffleStore.values()].map(s => ({
    showId: s.showId, showName: s.showName, poster: s.poster,
    total: s.shuffled.length, pointer: s.pointer,
    remaining: s.shuffled.length - s.pointer,
  }));
  res.json({ shows });
});

app.get(['/', '/configure'], (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🎲 Episode Shuffler</title>
<style>
  body { font-family: sans-serif; background: #0a0a0f; color: #e2e8f0; max-width: 700px; margin: 60px auto; padding: 0 24px; }
  h1 { font-size: 2rem; margin-bottom: 8px; }
  .url { background: #1e1e2e; padding: 12px 16px; border-radius: 8px; font-family: monospace; font-size: .9rem; color: #f59e0b; word-break: break-all; margin: 16px 0; }
  .btn { background: #7c3aed; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 1rem; margin-right: 8px; text-decoration: none; display: inline-block; }
  label { display: block; margin-top: 20px; margin-bottom: 6px; font-size: .8rem; color: #94a3b8; text-transform: uppercase; }
  input, textarea { width: 100%; background: #1e1e2e; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; color: #e2e8f0; font-family: monospace; font-size: .85rem; box-sizing: border-box; }
  textarea { min-height: 100px; resize: vertical; }
  .card { background: #111118; border: 1px solid #1e1e2e; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .qi { background: #1e1e2e; border-radius: 8px; padding: 12px 16px; margin-top: 10px; display: flex; justify-content: space-between; align-items: center; }
  .btn-sm { background: transparent; border: 1px solid #334155; color: #94a3b8; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: .8rem; margin-left: 6px; }
  .btn-red { color: #ef4444; border-color: rgba(239,68,68,.3); }
</style>
</head>
<body>
<h1>🎲 Episode Shuffler</h1>
<p style="color:#94a3b8">Stremio addon — randomizes TV show episode order.</p>

<div class="card">
  <strong>Install in Stremio</strong>
  <div class="url" id="murl"></div>
  <button class="btn" onclick="copyUrl()">📋 Copy URL</button>
  <a class="btn" id="slink" href="#">▶ Open in Stremio</a>
</div>

<div class="card">
  <strong>Add a Show to Shuffle Queue</strong>
  <label>Show ID (IMDB tt-code)</label>
  <input id="sid" placeholder="tt0903747">
  <label>Show Name</label>
  <input id="sname" placeholder="Breaking Bad">
  <label>Episodes JSON</label>
  <textarea id="seps" placeholder='[{"id":"tt0903747:1:1","title":"Pilot","seriesId":"tt0903747"}]'></textarea>
  <div style="margin-top:12px">
    <button class="btn" onclick="addShow()">🎲 Shuffle & Add</button>
    <button class="btn" style="background:#334155" onclick="prefill()">Try Example</button>
  </div>
  <div id="qlist"></div>
</div>

<script>
  const B = location.origin;
  document.getElementById('murl').textContent = B + '/manifest.json';
  document.getElementById('slink').href = 'stremio://addon-install/' + B + '/manifest.json';
  function copyUrl() { navigator.clipboard.writeText(B + '/manifest.json').then(() => alert('Copied!')); }
  async function addShow() {
    const showId = document.getElementById('sid').value.trim();
    const showName = document.getElementById('sname').value.trim();
    let episodes;
    try { episodes = JSON.parse(document.getElementById('seps').value); } catch { return alert('Invalid JSON'); }
    const r = await fetch(B+'/api/shuffle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({showId,showName,episodes})});
    const d = await r.json();
    if (d.ok) { alert('Added! ' + d.total + ' episodes shuffled.'); track(showId); loadQ(); }
  }
  function track(id) { const s=JSON.parse(localStorage.getItem('ss')||'[]'); if(!s.includes(id)){s.push(id);localStorage.setItem('ss',JSON.stringify(s));} }
  async function loadQ() {
    const ids = JSON.parse(localStorage.getItem('ss')||'[]');
    const el = document.getElementById('qlist'); el.innerHTML='';
    for (const id of ids) {
      const r = await fetch(B+'/api/shuffle/'+id).catch(()=>null);
      if(!r||!r.ok) continue;
      const d = await r.json();
      const div = document.createElement('div'); div.className='qi';
      div.innerHTML='<span>🎬 '+d.showName+' — '+d.remaining+'/'+d.total+' left</span><span><button class="btn-sm" onclick="reshuffle(\''+id+'\')">🔀</button><button class="btn-sm btn-red" onclick="del(\''+id+'\')">✕</button></span>';
      el.appendChild(div);
    }
  }
  async function reshuffle(id) { await fetch(B+'/api/shuffle/'+id+'/reshuffle',{method:'POST'}); loadQ(); }
  async function del(id) { await fetch(B+'/api/shuffle/'+id,{method:'DELETE'}); const s=JSON.parse(localStorage.getItem('ss')||'[]'); localStorage.setItem('ss',JSON.stringify(s.filter(x=>x!==id))); loadQ(); }
  function prefill() {
    document.getElementById('sid').value='tt0108778';
    document.getElementById('sname').value='Friends';
    document.getElementById('seps').value=JSON.stringify([
      {id:'tt0108778:1:1',title:'The One Where Monica Gets a Roommate',seriesId:'tt0108778'},
      {id:'tt0108778:1:2',title:"The One with the Sonogram at the End",seriesId:'tt0108778'},
      {id:'tt0108778:1:3',title:"The One with the Thumb",seriesId:'tt0108778'},
    ],null,2);
  }
  loadQ();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log('🎲 Episode Shuffler running on port ' + PORT);
});
