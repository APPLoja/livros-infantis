// Service worker: app instalável e leitura sem internet.
// - "casca" (páginas, estilo, ícones, fontes): rede primeiro, cópia em cache para usar offline;
// - livros baixados ficam no cache "livro-<id>" (JSON do livro + capa + imagens + áudios),
//   criado pela própria página (offline.js);
// - mídias são imutáveis: cache primeiro, com suporte a Range para o áudio.
const CASCA = 'casca-v1';
const IMAGENS = 'imagens-v1'; // capas/ilustrações vistas na estante (não inclui áudio)
const PRECACHE = ['/', '/ler', '/styles.css', '/offline.js', '/manifest.webmanifest',
  '/icons/icone-192.png', '/icons/icone-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CASCA).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const manter = new Set([CASCA, IMAGENS]);
    for (const k of await caches.keys()) if (!manter.has(k) && !k.startsWith('livro-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

const comTempo = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function redePrimeiro(req, chave, { ignoreSearch = false, ms = 5000 } = {}) {
  try {
    const res = await comTempo(fetch(req), ms);
    if (res.ok) {
      const c = await caches.open(CASCA);
      await c.put(chave || req, res.clone());
    }
    return res;
  } catch (err) {
    const hit = await caches.match(chave || req, { ignoreSearch });
    if (hit) return hit;
    throw err;
  }
}

// responde a um pedido com Range a partir de uma resposta completa em cache
async function fatiar(req, res) {
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!range) return res;
  const blob = await res.blob();
  const ini = range[1] ? Number(range[1]) : 0;
  const fim = range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
  if (ini > fim || ini >= blob.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  return new Response(blob.slice(ini, fim + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${ini}-${fim}/${blob.size}`,
      'Content-Length': String(fim - ini + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function midia(req) {
  const url = new URL(req.url);
  const hit = await caches.match(url.pathname);
  if (hit) return fatiar(req, hit);
  const res = await fetch(req);
  // guarda capas e ilustrações para a estante funcionar offline (áudio só quando o livro é baixado)
  if (res.status === 200 && /\.(webp|png|jpe?g)$/i.test(url.pathname)) {
    const c = await caches.open(IMAGENS);
    c.put(url.pathname, res.clone());
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') caches.open(CASCA).then((c) => c.put(req, res.clone()));
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/admin')) return;

  if (url.pathname.startsWith('/media/')) return e.respondWith(midia(req));
  if (url.pathname === '/api/library') return e.respondWith(redePrimeiro(req, '/api/library'));
  if (/^\/api\/books\/[^/]+$/.test(url.pathname)) {
    // o livro baixado responde quando não há internet
    return e.respondWith(comTempo(fetch(req), 6000).catch(async (err) => {
      const hit = await caches.match(url.pathname);
      if (hit) return hit;
      throw err;
    }));
  }
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/musica.mp3') return e.respondWith(caches.match('/musica.mp3').then((h) => (h ? fatiar(req, h) : fetch(req))));

  if (req.mode === 'navigate') {
    const chave = url.pathname === '/' || url.pathname === '/index.html' ? '/' : url.pathname.replace(/\.html$/, '');
    return e.respondWith(redePrimeiro(req, chave, { ignoreSearch: true }));
  }
  e.respondWith(redePrimeiro(req, url.pathname));
});
