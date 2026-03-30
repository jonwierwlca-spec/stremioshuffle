/**
 * 🎲 Episode Shuffler + Real-Debrid Playlist Addon for Stremio
 *
 * Flow:
 *  1. User installs via /[rdKey]/manifest.json  (RD key baked into URL)
 *  2. Catalog shows shuffle queues
 *  3. On stream request → query RD instantAvailability for known hashes
 *     → pick best cached file → unrestrict → return direct HTTP URL
 *  4. Playlist builder UI at / lets users create & manage queues
 */

'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 7000;
const RD_API = 'https://api.real-debrid.com/rest/1.0';

// ─── In-memory stores ──────────────────────────────────────────────────────────
// shuffleStore: showId → { showName, poster, episodes[], shuffled[], pointer, hashes[] }
const shuffleStore = new Map();
// hashCache: infoHash → { files: [{fileId, name, size}], rdId, links[] }
const hashCache = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isVideoFile(name) {
  return /\.(mkv|mp4|avi|mov|wmv|m4v|ts|webm)$/i.test(name);
}

function qualityLabel(name) {
  if (/2160p|4k|uhd/i.test(name)) return '4K';
  if (/1080p/i.test(name)) return '1080p';
  if (/720p/i.test(name)) return '720p';
  if (/480p/i.test(name)) return '480p';
  return 'SD';
}

function sizeLabel(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1048576).toFixed(0)} MB`;
}

// ─── Real-Debrid API wrapper ───────────────────────────────────────────────────
async function rdFetch(endpoint, { method = 'GET', body, rdKey } = {}) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${rdKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`${RD_API}${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`RD ${res.status}: ${text}`);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

async function rdUser(rdKey) {
  return rdFetch('/user', { rdKey });
}

/**
 * Check which of the given hashes are instantly available on RD.
 * Returns: { [hash]: { rd: [ { [fileId]: {filename, filesize} } ] } }
 */
async function rdInstantAvailability(hashes, rdKey) {
  if (!hashes || hashes.length === 0) return {};
  const joined = hashes.map(h => h.toLowerCase()).join('/');
  try {
    return await rdFetch(`/torrents/instantAvailability/${joined}`, { rdKey });
  } catch {
    return {};
  }
}

/**
 * Add a magnet to RD, select all files, return torrent info.
 */
async function rdAddMagnet(magnet, rdKey) {
  const added = await rdFetch('/torrents/addMagnet', {
    method: 'POST',
    body: { magnet },
    rdKey,
  });
  // Select all files
  await rdFetch(`/torrents/selectFiles/${added.id}`, {
    method: 'POST',
    body: { files: 'all' },
    rdKey,
  });
  // Poll until downloaded
  let info;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    info = await rdFetch(`/torrents/info/${added.id}`, { rdKey });
    if (info.status === 'downloaded') break;
    if (['error', 'dead', 'virus'].includes(info.status)) throw new Error(`Torrent failed: ${info.status}`);
  }
  return info;
}

/**
 * Unrestrict a single RD host link → direct HTTP URL.
 */
async function rdUnrestrict(link, rdKey) {
  return rdFetch('/unrestrict/link', {
    method: 'POST',
    body: { link },
    rdKey,
  });
}

// ─── Manifest factory (key baked into config) ─────────────────────────────────
function buildManifest(rdKey) {
  return {
    id: 'community.shuffle.realdebrid',
    version: '2.0.0',
    name: '🎲 Shuffle + Real-Debrid',
    description: 'Shuffled episode playlists powered by Real-Debrid cached streams.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    idPrefixes: ['shuffle:'],
    catalogs: [
      {
        type: 'series',
        id: 'shuffle_series',
        name: '🎲 Shuffle Queue',
        extra: [{ name: 'search', isRequired: false }],
      },
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
    // Pass RD key through config so the addon URL carries it
    config: rdKey ? [{ key: 'rdKey', type: 'text', title: 'Real-Debrid API Key', default: rdKey }] : [],
  };
}

// ─── Stremio handler logic (shared) ───────────────────────────────────────────
async function handleCatalog({ type, id }) {
  if (id !== 'shuffle_series') return { metas: [] };
  const metas = [];
  for (const [showId, s] of shuffleStore.entries()) {
    metas.push({
      id: `shuffle:${showId}`,
      type: 'series',
      name: `🎲 ${s.showName || showId}`,
      poster: s.poster || null,
      description: `${s.shuffled.length - s.pointer} episodes left in shuffle`,
    });
  }
  return { metas };
}

async function handleMeta({ type, id }) {
  if (!id.startsWith('shuffle:')) return { meta: null };
  const showId = id.replace('shuffle:', '');
  const s = shuffleStore.get(showId);
  if (!s) return { meta: null };

  const videos = s.shuffled.map((ep, idx) => ({
    id: `shuffle:${showId}:${idx}`,
    title: `#${idx + 1} — ${ep.title || ep.id}`,
    season: 0,
    episode: idx + 1,
    released: new Date(Date.now() - (s.shuffled.length - idx) * 86400000).toISOString(),
    thumbnail: ep.thumbnail || null,
    overview: idx < s.pointer ? '✅ Watched' : idx === s.pointer ? '▶ Up next' : '',
  }));

  return {
    meta: {
      id: `shuffle:${showId}`,
      type: 'series',
      name: `🎲 ${s.showName || showId}`,
      poster: s.poster || null,
      description: `Shuffled • ${s.shuffled.length} eps • at #${s.pointer + 1}`,
      videos,
    },
  };
}

async function handleStream({ type, id, rdKey }) {
  if (!id.startsWith('shuffle:')) return { streams: [] };

  const parts = id.split(':');
  const showId = parts[1];
  const epIndex = parseInt(parts[2], 10);

  const s = shuffleStore.get(showId);
  if (!s) return { streams: [] };

  const ep = isNaN(epIndex) ? s.shuffled[s.pointer] : s.shuffled[epIndex];
  if (!ep) return { streams: [] };

  // Advance pointer
  if (!isNaN(epIndex) && epIndex === s.pointer) {
    s.pointer++;
    if (s.pointer >= s.shuffled.length) {
      s.shuffled = fisherYates(s.episodes);
      s.pointer = 0;
    }
  }

  const streams = [];

  // ── Try Real-Debrid if we have a key and hashes ────────────────────────────
  if (rdKey && ep.infoHash) {
    try {
      const avail = await rdInstantAvailability([ep.infoHash], rdKey);
      const hashKey = ep.infoHash.toLowerCase();
      const rdData = avail[hashKey];

      if (rdData && rdData.rd && rdData.rd.length > 0) {
        // Cached! Pick the variant with the most video files
        const best = rdData.rd.reduce((a, b) =>
          Object.keys(b).length > Object.keys(a).length ? b : a
        );

        // Find video files
        const videoFiles = Object.entries(best).filter(([, f]) => isVideoFile(f.filename));
        if (videoFiles.length > 0) {
          // Add magnet to RD to get unrestrict links
          const magnet = ep.magnet || `magnet:?xt=urn:btih:${ep.infoHash}`;

          // Check if already cached
          let torrentInfo = null;
          if (hashCache.has(ep.infoHash)) {
            torrentInfo = hashCache.get(ep.infoHash);
          } else {
            torrentInfo = await rdAddMagnet(magnet, rdKey).catch(() => null);
            if (torrentInfo) hashCache.set(ep.infoHash, torrentInfo);
          }

          if (torrentInfo && torrentInfo.links && torrentInfo.links.length > 0) {
            for (const link of torrentInfo.links.slice(0, 3)) {
              const unrestricted = await rdUnrestrict(link, rdKey).catch(() => null);
              if (unrestricted && unrestricted.download) {
                const fname = unrestricted.filename || '';
                streams.push({
                  url: unrestricted.download,
                  title: `🟢 RD ${qualityLabel(fname)}\n${ep.title || ''} • ${sizeLabel(unrestricted.filesize)}`,
                  name: `RD ${qualityLabel(fname)}`,
                  behaviorHints: { notWebReady: false, bingeGroup: `shuffle-${showId}` },
                });
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('RD stream error:', e.message);
    }
  }

  // ── Fallback: pass-through to original episode ────────────────────────────
  streams.push({
    title: `▶ ${ep.title || ep.id}\n🎲 Shuffled #${(isNaN(epIndex) ? s.pointer : epIndex) + 1}`,
    externalUrl: `stremio://detail/${ep.type || 'series'}/${ep.seriesId || showId}/${ep.id}`,
    behaviorHints: { notWebReady: false, bingeGroup: `shuffle-${showId}` },
  });

  return { streams };
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ── Stremio addon routes (with optional RD key in path) ──────────────────────

// /manifest.json  or  /:rdKey/manifest.json
app.get(['/:rdKey/manifest.json', '/manifest.json'], (req, res) => {
  const rdKey = req.params.rdKey && req.params.rdKey !== 'manifest.json'
    ? req.params.rdKey : null;
  res.json(buildManifest(rdKey));
});

app.get(['/:rdKey/catalog/:type/:id.json', '/catalog/:type/:id.json'], async (req, res) => {
  const result = await handleCatalog(req.params).catch(() => ({ metas: [] }));
  res.json(result);
});

app.get(['/:rdKey/meta/:type/:id.json', '/meta/:type/:id.json'], async (req, res) => {
  const result = await handleMeta(req.params).catch(() => ({ meta: null }));
  res.json(result);
});

app.get(['/:rdKey/stream/:type/:id.json', '/stream/:type/:id.json'], async (req, res) => {
  const rdKey = req.params.rdKey || null;
  const result = await handleStream({ ...req.params, rdKey }).catch(e => {
    console.error(e);
    return { streams: [] };
  });
  res.json(result);
});

// ── Shuffle REST API ──────────────────────────────────────────────────────────

// POST /api/shuffle — add a show
app.post('/api/shuffle', (req, res) => {
  const { showId, showName, poster, background, episodes } = req.body;
  if (!showId || !Array.isArray(episodes) || !episodes.length)
    return res.status(400).json({ error: 'showId + episodes[] required' });

  const shuffled = fisherYates(episodes);
  shuffleStore.set(showId, {
    showId, showName: showName || showId, poster, background,
    episodes, shuffled, pointer: 0, createdAt: Date.now(),
  });
  res.json({ ok: true, total: episodes.length, shuffleId: `shuffle:${showId}`, first: shuffled[0] });
});

// GET /api/shuffle/:showId
app.get('/api/shuffle/:showId', (req, res) => {
  const s = shuffleStore.get(req.params.showId);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ ...s, remaining: s.shuffled.length - s.pointer, current: s.shuffled[s.pointer] || null });
});

// GET /api/shows
app.get('/api/shows', (req, res) => {
  const shows = [...shuffleStore.values()].map(s => ({
    showId: s.showId, showName: s.showName, poster: s.poster,
    total: s.shuffled.length, pointer: s.pointer,
    remaining: s.shuffled.length - s.pointer,
  }));
  res.json({ shows });
});

// POST /api/shuffle/:showId/reshuffle
app.post('/api/shuffle/:showId/reshuffle', (req, res) => {
  const s = shuffleStore.get(req.params.showId);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.shuffled = fisherYates(s.episodes);
  s.pointer = 0;
  res.json({ ok: true, first: s.shuffled[0] });
});

// DELETE /api/shuffle/:showId
app.delete('/api/shuffle/:showId', (req, res) => {
  shuffleStore.delete(req.params.showId);
  res.json({ ok: true });
});

// POST /api/rd/verify —
