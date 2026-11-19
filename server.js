// Livros Infantis — servidor HTTP sem dependências externas (Node >= 20).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('./lib/env');
const store = require('./lib/store');
const gen = require('./lib/generate');
const openrouter = require('./lib/openrouter');
const eleven = require('./lib/elevenlabs');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new HttpError(413, 'Corpo muito grande');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
}

async function readImage(req) {
  if (!/^image\//.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Envie um arquivo de imagem');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 25_000_000) throw new HttpError(413, 'Imagem muito grande (máximo 25 MB)');
    chunks.push(c);
  }
  if (!size) throw new HttpError(400, 'Imagem vazia');
  return Buffer.concat(chunks);
}

function isAdmin(req) {
  if (!cfg.ADMIN_TOKEN) return false;
  const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const want = Buffer.from(cfg.ADMIN_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function requireAdmin(req) {
  if (!cfg.ADMIN_TOKEN) throw new HttpError(503, 'Defina ADMIN_TOKEN no .env para usar o editor');
  if (!isAdmin(req)) throw new HttpError(401, 'Token de administrador inválido');
}

async function readAudio(req) {
  const type = req.headers['content-type'] || '';
  if (!/^audio\//.test(type)) throw new HttpError(415, 'Envie um arquivo de áudio');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 25_000_000) throw new HttpError(413, 'Áudio muito grande (máximo 25 MB)');
    chunks.push(c);
  }
  if (!size) throw new HttpError(400, 'Áudio vazio');
  return { buffer: Buffer.concat(chunks), type };
}

const mediaUrl = (id, name) => (name ? `/media/${id}/${encodeURIComponent(name)}` : null);

function publicBook(b) {
  return {
    ...b,
    cover: { ...b.cover, url: mediaUrl(b.id, b.cover.image) },
    music: { ...b.music, url: mediaUrl(b.id, b.music.file) },
    pages: b.pages.map((p) => ({
      ...p, imageUrl: mediaUrl(b.id, p.image), audioUrl: mediaUrl(b.id, p.audio), ambienceUrl: mediaUrl(b.id, p.ambience),
    })),
  };
}

function library(all) {
  const books = store.listBooks().filter((b) => all || b.published);
  return store.getShelves()
    .map((s) => ({
      ...s,
      books: books.filter((b) => b.shelf === s.name).map((b) => ({
        id: b.id, title: b.title, locked: b.locked, published: b.published,
        cover: mediaUrl(b.id, b.cover.image), pages: b.pages.length,
      })),
    }))
    .filter((s) => all || s.books.length);
}

function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Não encontrado');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---- Rotas ----
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/config', (req) => ({
  admin: isAdmin(req),
  openrouter: !!cfg.OPENROUTER_API_KEY,
  elevenlabs: !!cfg.ELEVENLABS_API_KEY,
  imageModel: cfg.OPENROUTER_IMAGE_MODEL,
  textModel: cfg.OPENROUTER_TEXT_MODEL,
  ttsModel: cfg.ELEVENLABS_MODEL,
  defaultVoice: cfg.ELEVENLABS_DEFAULT_VOICE,
}));

route('GET', '/api/library', (req, q) => {
  const all = q.get('all') === '1';
  if (all) requireAdmin(req);
  return { shelves: library(all) };
});

route('GET', '/api/books/:id', (req, q, { id }) => {
  const b = store.getBook(id);
  if (!b || (!b.published && !isAdmin(req))) throw new HttpError(404, 'Livro não encontrado');
  return publicBook(b);
});

route('POST', '/api/books', async (req) => {
  requireAdmin(req);
  return publicBook(store.createBook(await readJson(req)));
});

route('PUT', '/api/books/:id', async (req, q, { id }) => {
  requireAdmin(req);
  const data = await readJson(req);
  return publicBook(await store.mutate(id, (book) => { store.applyUpdate(book, data); }));
});

route('DELETE', '/api/books/:id', (req, q, { id }) => {
  requireAdmin(req);
  store.deleteBook(id);
  return { ok: true };
});

route('POST', '/api/books/:id/cover', async (req, q, { id }) => {
  requireAdmin(req);
  return publicBook(await gen.generateCover(id, await readJson(req)));
});

route('PUT', '/api/books/:id/cover/upload', async (req, q, { id }) => {
  requireAdmin(req);
  return publicBook(await gen.uploadImage(id, 'cover', await readImage(req)));
});

route('PUT', '/api/books/:id/pages/:pageId/upload', async (req, q, { id, pageId }) => {
  requireAdmin(req);
  return publicBook(await gen.uploadImage(id, pageId, await readImage(req)));
});

route('POST', '/api/books/:id/pages/:pageId/image', async (req, q, { id, pageId }) => {
  requireAdmin(req);
  return publicBook(await gen.generatePageImage(id, pageId, await readJson(req)));
});

route('POST', '/api/books/:id/pages/:pageId/audio', async (req, q, { id, pageId }) => {
  requireAdmin(req);
  return publicBook(await gen.generatePageAudio(id, pageId));
});

route('POST', '/api/books/:id/sounds/suggest', async (req, q, { id }) => {
  requireAdmin(req);
  const { overwrite } = await readJson(req);
  return publicBook(await gen.suggestSounds(id, { overwrite: !!overwrite }));
});

route('POST', '/api/books/:id/music', async (req, q, { id }) => {
  requireAdmin(req);
  return publicBook(await gen.generateMusic(id, await readJson(req)));
});

route('PUT', '/api/books/:id/music/upload', async (req, q, { id }) => {
  requireAdmin(req);
  const a = await readAudio(req);
  return publicBook(await gen.uploadSound(id, 'music', a.buffer, a.type));
});

route('DELETE', '/api/books/:id/music', async (req, q, { id }) => {
  requireAdmin(req);
  return publicBook(await gen.clearSound(id, 'music'));
});

route('POST', '/api/books/:id/pages/:pageId/ambience', async (req, q, { id, pageId }) => {
  requireAdmin(req);
  return publicBook(await gen.generatePageAmbience(id, pageId, await readJson(req)));
});

route('PUT', '/api/books/:id/pages/:pageId/ambience/upload', async (req, q, { id, pageId }) => {
  requireAdmin(req);
  const a = await readAudio(req);
  return publicBook(await gen.uploadSound(id, pageId, a.buffer, a.type));
});

route('DELETE', '/api/books/:id/pages/:pageId/ambience', async (req, q, { id, pageId }) => {
  requireAdmin(req);
  return publicBook(await gen.clearSound(id, pageId));
});

route('POST', '/api/books/:id/generate-all', async (req, q, { id }) => {
  requireAdmin(req);
  return gen.startGenerateAll(id, await readJson(req));
});

route('GET', '/api/books/:id/job', (req, q, { id }) => {
  requireAdmin(req);
  return gen.jobStatus(id);
});

route('POST', '/api/story', async (req) => {
  requireAdmin(req);
  const { theme, pages, age, shelf, voiceId } = await readJson(req);
  if (!theme) throw new HttpError(400, 'Informe o tema da história');
  const story = await openrouter.generateStory({ theme, pages: Math.min(Math.max(Number(pages) || 12, 4), 30), age });
  const book = store.createBook({
    title: story.title, characters: story.characters, style: story.style || undefined,
    shelf, voiceId, coverPrompt: story.coverPrompt, musicPrompt: story.musicPrompt,
    pages: story.pages.map((p) => ({ text: p.text, imagePrompt: p.imagePrompt, ambiencePrompt: p.ambiencePrompt })),
  });
  return publicBook(book);
});

route('GET', '/api/voices', async (req) => {
  requireAdmin(req);
  const salvas = store.getVoices().map((v) => ({ ...v, labels: {}, saved: true }));
  let conta = [];
  try { conta = await eleven.listVoices(); } catch { /* chave sem permissão voices_read: usa só as salvas */ }
  const ids = new Set(salvas.map((v) => v.id));
  return { voices: [...salvas, ...conta.filter((v) => !ids.has(v.id))] };
});

route('PUT', '/api/voices', async (req) => {
  requireAdmin(req);
  const { voices } = await readJson(req);
  if (!Array.isArray(voices)) throw new HttpError(400, 'Envie {voices: [{id, name}]}');
  return { voices: store.saveVoices(voices) };
});

route('GET', '/api/shelves', () => ({ shelves: store.getShelves() }));
route('PUT', '/api/shelves', async (req) => {
  requireAdmin(req);
  const { shelves } = await readJson(req);
  if (!Array.isArray(shelves)) throw new HttpError(400, 'shelves deve ser uma lista');
  return { shelves: store.saveShelves(shelves) };
});

// ---- Servidor ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const out = await r.handler(req, url.searchParams, params);
        return send(res, 200, out, { 'Cache-Control': 'no-store' });
      }
      throw new HttpError(404, 'Rota não encontrada');
    }
    if (p.startsWith('/media/')) {
      const [, , id, name] = p.split('/');
      if (!id || !name || name.includes('..') || name === 'book.json') throw new HttpError(404, 'Não encontrado');
      if (!store.getBook(id)) throw new HttpError(404, 'Não encontrado');
      return serveFile(req, res, path.join(store.bookDir(id), name), 'public, max-age=31536000, immutable');
    }
    const clean = p === '/' ? '/index.html' : p;
    const file = path.join(PUBLIC, path.normalize(clean).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) throw new HttpError(404, 'Não encontrado');
    const withExt = fs.existsSync(file) ? file : `${file}.html`;
    return serveFile(req, res, withExt, 'no-cache');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[${req.method} ${p}]`, e);
    return send(res, status, { error: e.message });
  }
});

server.requestTimeout = 600_000;
server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`Livros Infantis em http://${cfg.HOST}:${cfg.PORT}`);
  console.log(`OpenRouter: ${cfg.OPENROUTER_API_KEY ? 'ok' : 'sem chave'} (${cfg.OPENROUTER_IMAGE_MODEL}) | ElevenLabs: ${cfg.ELEVENLABS_API_KEY ? 'ok' : 'sem chave'} (${cfg.ELEVENLABS_MODEL})`);
});
