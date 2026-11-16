// Instalar como app + baixar livros para ler sem internet.
(() => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  const CHAVE = 'baixados';
  const lerMapa = () => { try { return JSON.parse(localStorage.getItem(CHAVE) || '{}'); } catch { return {}; } };
  const salvarMapa = (m) => localStorage.setItem(CHAVE, JSON.stringify(m));

  // todas as mídias citadas no livro (capa, ilustrações, narração, trilha, sons de fundo...)
  function midias(book) {
    const out = new Set();
    (function walk(v) {
      if (typeof v === 'string') { if (v.startsWith('/media/')) out.add(v); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    })(book);
    return [...out];
  }
  const assinatura = (book) => midias(book).sort().join('|') + '|' + book.pages.map((p) => p.text).join('|');

  async function baixar(id, aoProgredir = () => {}) {
    if (!('caches' in window)) throw new Error('Este navegador não permite baixar livros');
    navigator.storage?.persist?.().catch(() => {});
    const r = await fetch(`/api/books/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('Não consegui baixar o livro');
    const book = await r.clone().json();
    const urls = midias(book);
    const nome = `livro-${id}`;
    await caches.delete(nome);
    const cache = await caches.open(nome);
    let feitos = 0, bytes = 0;
    aoProgredir(0, urls.length);
    const fila = [...urls];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (fila.length) {
        const u = fila.shift();
        const res = await fetch(u);
        if (!res.ok) throw new Error(`Falha ao baixar ${u}`);
        const blob = await res.blob();
        bytes += blob.size;
        await cache.put(u, new Response(blob, { headers: { 'Content-Type': res.headers.get('Content-Type') || '' } }));
        aoProgredir(++feitos, urls.length);
      }
    })).catch(async (e) => { await caches.delete(nome); throw e; });
    if (!book.music?.url) { // trilha geral do site, se existir
      const m = await fetch('/musica.mp3').catch(() => null);
      if (m?.ok) await cache.put('/musica.mp3', m);
    }
    await cache.put(`/api/books/${id}`, r);
    fetch('/api/library').catch(() => {}); // o service worker guarda a estante para abrir offline
    const m = lerMapa();
    m[id] = { at: Date.now(), bytes, sig: assinatura(book), title: book.title };
    salvarMapa(m);
    return m[id];
  }

  async function remover(id) {
    await caches.delete(`livro-${id}`);
    const m = lerMapa(); delete m[id]; salvarMapa(m);
  }

  // se o livro mudou no servidor, baixa de novo em segundo plano
  function atualizarSeMudou(book) {
    const info = lerMapa()[book.id];
    if (info && navigator.onLine && info.sig !== assinatura(book)) baixar(book.id).catch(() => {});
  }

  const tamanho = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

  // ---- Instalar ----
  let pedido = null;
  const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const ouvintes = new Set();
  const avisar = () => ouvintes.forEach((f) => f());
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); pedido = e; avisar(); });
  addEventListener('appinstalled', () => { pedido = null; avisar(); });

  const podeInstalar = () => !instalado() && (!!pedido || ehIOS);
  async function instalar() {
    if (pedido) { pedido.prompt(); await pedido.userChoice.catch(() => {}); pedido = null; avisar(); return; }
    if (ehIOS) {
      const d = document.createElement('div');
      d.className = 'dica-ios';
      d.innerHTML = `<div><b>Instalar no iPhone/iPad</b>
        <p>1. Toque em <span class="ico">⬆︎</span> <b>Compartilhar</b> na barra do Safari.</p>
        <p>2. Escolha <b>Adicionar à Tela de Início</b>.</p>
        <button>Entendi</button></div>`;
      d.addEventListener('click', () => d.remove());
      document.body.append(d);
    }
  }

  window.Offline = { baixar, remover, atualizarSeMudou, baixados: lerMapa, midias, tamanho, podeInstalar, instalar, aoMudarInstalacao: (f) => ouvintes.add(f) };
})();
