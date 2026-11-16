// Geração de capa, ilustrações e narração + fila de "gerar tudo".
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const openrouter = require('./openrouter');
const eleven = require('./elevenlabs');
const cfg = require('./env');

const sharp = require('sharp');

// Comprime para WebP (as imagens chegam como PNG de ~1,7 MB). A versão em
// alta fica guardada como referência para as próximas gerações.
async function toWebp(buffer, maxWidth) {
  return sharp(buffer).resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
}
const NO_TEXT = 'IMPORTANT: absolutely no text, title, letters, words or signatures anywhere in the image.';

function imagePrompt(book, scene, kind) {
  return [
    kind === 'cover'
      ? 'Children\'s book cover artwork WITHOUT any title or lettering. Portrait composition, main characters in the lower-middle, leave the top third as simple sky/background (the title is added later by the app).'
      : 'Children\'s book page illustration, landscape composition.',
    `Scene (draw exactly this moment of the story): ${scene}`,
    book.characters ? `Characters (keep them exactly like this): ${book.characters}` : '',
    `Art style: ${book.style}`,
    NO_TEXT,
  ].filter(Boolean).join('\n');
}

function coverReference(book) {
  if (!book.cover?.image) return [];
  const file = path.join(store.bookDir(book.id), book.cover.image);
  if (!fs.existsSync(file)) return [];
  const ext = path.extname(file).slice(1);
  return [{ buffer: fs.readFileSync(file), mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }];
}

const REF_NOTE = `The attached image is a CHARACTER REFERENCE ONLY: keep the characters' design, colors and proportions identical to it.
Do NOT copy its composition, pose, framing, background, lighting or decorative elements. Create a completely new scene and camera angle as described above. Only include objects, creatures, lights and time of day that the scene description mentions.`;

async function generateCover(id, { prompt } = {}) {
  const book = store.getBook(id);
  if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });
  const scene = prompt || book.cover.prompt || `the main characters of "${book.title}" in a joyful scene`;
  const img = await openrouter.generateImage({ prompt: imagePrompt(book, scene, 'cover'), aspectRatio: '3:4' });
  const name = `capa-${Date.now()}.webp`;
  store.writeMedia(id, name, await toWebp(img.buffer, 900));
  return store.mutate(id, (b) => {
    store.removeMedia(id, b.cover.image);
    b.cover.image = name;
    b.cover.prompt = scene;
  });
}

async function generatePageImage(id, pageId, { prompt, useCover = true } = {}) {
  const book = store.getBook(id);
  const page = book?.pages.find((p) => p.id === pageId);
  if (!page) throw Object.assign(new Error('Página não encontrada'), { status: 404 });
  const scene = prompt || page.imagePrompt || page.text;
  const refs = useCover ? coverReference(book) : [];
  const full = imagePrompt(book, scene, 'page') + (refs.length ? `\n${REF_NOTE}` : '');
  const img = await openrouter.generateImage({ prompt: full, aspectRatio: '4:3', references: refs });
  const name = `pag-${pageId}-${Date.now()}.webp`;
  store.writeMedia(id, name, await toWebp(img.buffer, 1400));
  return store.mutate(id, (b) => {
    const p = b.pages.find((x) => x.id === pageId);
    if (!p) { store.removeMedia(id, name); return; }
    store.removeMedia(id, p.image);
    p.image = name;
    if (prompt) p.imagePrompt = prompt;
  });
}

const audioKey = (book, page) => crypto.createHash('sha1')
  .update(`${book.voiceId}|${cfg.ELEVENLABS_MODEL}|${page.narration || page.text}`).digest('hex').slice(0, 12);

async function generatePageAudio(id, pageId) {
  const book = store.getBook(id);
  const page = book?.pages.find((p) => p.id === pageId);
  if (!page) throw Object.assign(new Error('Página não encontrada'), { status: 404 });
  const text = (page.narration || page.text).trim();
  if (!text) throw Object.assign(new Error('Página sem texto'), { status: 400 });
  const r = await eleven.synthesize({ text, voiceId: book.voiceId });
  const name = `audio-${pageId}-${Date.now()}.mp3`;
  store.writeMedia(id, name, r.buffer);
  return store.mutate(id, (b) => {
    const p = b.pages.find((x) => x.id === pageId);
    if (!p) { store.removeMedia(id, name); return; }
    store.removeMedia(id, p.audio);
    p.audio = name;
    p.words = r.words;
    p.audioKey = audioKey(b, p);
  });
}

// ---- Trilha sonora e sons de fundo ----
async function suggestSounds(id, { overwrite = false } = {}) {
  const book = store.getBook(id);
  if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });
  const s = await openrouter.suggestSounds(book);
  return store.mutate(id, (b) => {
    if (overwrite || !b.music.prompt) b.music.prompt = s.musicPrompt;
    for (const sp of s.pages) {
      const p = b.pages.find((x) => x.id === sp.id);
      if (p && (overwrite || !p.ambiencePrompt)) p.ambiencePrompt = String(sp.ambiencePrompt || '');
    }
  });
}

async function generateMusic(id, { prompt } = {}) {
  const book = store.getBook(id);
  if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });
  const p = (prompt || book.music.prompt || '').trim();
  if (!p) throw Object.assign(new Error('Descreva a trilha sonora (ou use "Sugerir sons")'), { status: 400 });
  const buf = await eleven.music({ prompt: p, lengthMs: 60_000 });
  const name = `trilha-${Date.now()}.mp3`;
  store.writeMedia(id, name, buf);
  return store.mutate(id, (b) => {
    const old = b.music.file;
    b.music = { file: name, prompt: p };
    store.removeIfUnused(b, old);
  });
}

/** Gera o som de fundo de uma página; páginas com o mesmo texto de som (e sem som) reaproveitam o arquivo. */
async function generatePageAmbience(id, pageId, { prompt } = {}) {
  const book = store.getBook(id);
  const page = book?.pages.find((p) => p.id === pageId);
  if (!page) throw Object.assign(new Error('Página não encontrada'), { status: 404 });
  const p = (prompt ?? page.ambiencePrompt ?? '').trim();
  if (!p) throw Object.assign(new Error('Descreva o som de fundo da página'), { status: 400 });
  const buf = await eleven.soundEffect({ prompt: p, duration: 20, loop: true });
  const name = `som-${pageId}-${Date.now()}.mp3`;
  store.writeMedia(id, name, buf);
  return store.mutate(id, (b) => {
    const pg = b.pages.find((x) => x.id === pageId);
    if (!pg) { store.removeMedia(id, name); return; }
    const antigos = [];
    const anterior = pg.ambience;
    for (const x of b.pages) {
      const mesmo = x.ambiencePrompt.trim() === p && (!x.ambience || x.ambience === anterior);
      if (x.id === pageId || mesmo) {
        antigos.push(x.ambience); x.ambience = name; x.ambiencePrompt = p;
      }
    }
    for (const o of antigos) store.removeIfUnused(b, o);
  });
}

const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm' };

/** Salva uma trilha ou som de fundo enviado pelo editor. target: 'music' ou o id da página. */
async function uploadSound(id, target, buffer, mime) {
  const ext = AUDIO_EXT[String(mime).split(';')[0].trim()];
  if (!ext) throw Object.assign(new Error('Envie um áudio MP3, M4A, OGG ou WAV'), { status: 415 });
  const book = store.getBook(id);
  if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });
  if (target !== 'music' && !book.pages.some((p) => p.id === target)) throw Object.assign(new Error('Página não encontrada'), { status: 404 });
  const name = `${target === 'music' ? 'trilha' : `som-${target}`}-${Date.now()}.${ext}`;
  store.writeMedia(id, name, buffer);
  return store.mutate(id, (b) => {
    let old;
    if (target === 'music') { old = b.music.file; b.music.file = name; }
    else {
      const p = b.pages.find((x) => x.id === target);
      if (!p) { store.removeMedia(id, name); throw Object.assign(new Error('Página não encontrada'), { status: 404 }); }
      old = p.ambience; p.ambience = name;
    }
    store.removeIfUnused(b, old);
  });
}

/** Remove a trilha ou o som de fundo de uma página. */
async function clearSound(id, target) {
  return store.mutate(id, (b) => {
    let old;
    if (target === 'music') { old = b.music.file; b.music.file = null; }
    else {
      const p = b.pages.find((x) => x.id === target);
      if (!p) throw Object.assign(new Error('Página não encontrada'), { status: 404 });
      old = p.ambience; p.ambience = null;
    }
    store.removeIfUnused(b, old);
  });
}

// ---- Fila "gerar tudo" (em memória, um livro por vez por livro) ----
const jobs = new Map(); // bookId -> { status, total, done, errors[], current }

function jobStatus(id) {
  return jobs.get(id) || { status: 'idle' };
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

function soundTasks(book, force) {
  const tasks = [];
  if (book.music.prompt && (force || !book.music.file)) tasks.push({ kind: 'music' });
  const vistos = new Set();
  for (const p of book.pages) {
    const pr = p.ambiencePrompt.trim();
    if (!pr || vistos.has(pr)) continue; // páginas com o mesmo som compartilham o arquivo
    vistos.add(pr);
    if (force || book.pages.some((x) => x.ambiencePrompt.trim() === pr && !x.ambience)) tasks.push({ kind: 'ambience', page: p.id });
  }
  return tasks;
}

function startGenerateAll(id, { images = true, audio = true, cover = true, sounds = true, force = false } = {}) {
  const cur = jobs.get(id);
  if (cur?.status === 'running') return cur;
  let book = store.getBook(id);
  if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });
  const semSugestao = sounds && !book.music.prompt && book.pages.every((p) => !p.ambiencePrompt.trim());

  const tasks = [];
  if (cover && (force || !book.cover.image)) tasks.push({ kind: 'cover' });
  for (const p of book.pages) {
    if (images && (force || !p.image)) tasks.push({ kind: 'image', page: p.id });
    if (audio && (p.narration || p.text).trim() && (force || !p.audio || p.audioKey !== audioKey(book, p))) {
      tasks.push({ kind: 'audio', page: p.id });
    }
  }
  if (sounds && !semSugestao) tasks.push(...soundTasks(book, force));
  const job = { status: 'running', total: tasks.length + (semSugestao ? 1 : 0), done: 0, errors: [], startedAt: new Date().toISOString() };
  jobs.set(id, job);

  (async () => {
    // sem nenhuma descrição de som: a IA sugere a trilha e os sons de cada página antes
    if (semSugestao) {
      try {
        book = await suggestSounds(id);
        const extra = soundTasks(book, force);
        tasks.push(...extra);
        job.total += extra.length;
      } catch (e) { job.errors.push({ kind: 'sounds', error: e.message }); }
      job.done++;
    }
    // A capa vem primeiro: ela é a referência visual das páginas.
    const coverTask = tasks.find((t) => t.kind === 'cover');
    const run = async (t) => {
      try {
        if (t.kind === 'cover') await generateCover(id);
        else if (t.kind === 'image') await generatePageImage(id, t.page);
        else if (t.kind === 'music') await generateMusic(id);
        else if (t.kind === 'ambience') await generatePageAmbience(id, t.page);
        else await generatePageAudio(id, t.page);
      } catch (e) {
        job.errors.push({ ...t, error: e.message });
      } finally {
        job.done++;
      }
    };
    if (coverTask) await run(coverTask);
    const rest = tasks.filter((t) => t.kind !== 'cover');
    await Promise.all([
      pool(rest.filter((t) => t.kind === 'image'), 3, run),
      pool(rest.filter((t) => t.kind !== 'image'), 2, run),
    ]);
    job.status = job.errors.length ? 'done_with_errors' : 'done';
    job.finishedAt = new Date().toISOString();
  })();
  return job;
}

/** Salva uma imagem enviada pelo editor (capa ou página), já convertida para WebP. */
async function uploadImage(id, target, buffer) {
  const book = store.getBook(id);
  if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });
  if (target !== 'cover' && !book.pages.some((p) => p.id === target)) {
    throw Object.assign(new Error('Página não encontrada'), { status: 404 });
  }
  let webp;
  try {
    webp = await sharp(buffer, { failOn: 'error' }).rotate()
      .resize({ width: target === 'cover' ? 900 : 1400, withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer();
  } catch {
    throw Object.assign(new Error('Arquivo de imagem inválido (use JPG, PNG, WebP ou GIF)'), { status: 400 });
  }
  const name = target === 'cover' ? `capa-${Date.now()}.webp` : `pag-${target}-${Date.now()}.webp`;
  store.writeMedia(id, name, webp);
  return store.mutate(id, (b) => {
    if (target === 'cover') { store.removeMedia(id, b.cover.image); b.cover.image = name; return; }
    const p = b.pages.find((x) => x.id === target);
    if (!p) { store.removeMedia(id, name); throw Object.assign(new Error('Página não encontrada'), { status: 404 }); }
    store.removeMedia(id, p.image);
    p.image = name;
  });
}

module.exports = { suggestSounds, generateMusic, generatePageAmbience, uploadSound, clearSound, uploadImage, generateCover, generatePageImage, generatePageAudio, startGenerateAll, jobStatus, audioKey };
