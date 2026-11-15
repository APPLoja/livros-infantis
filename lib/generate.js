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

function startGenerateAll(id, { images = true, audio = true, cover = true, force = false } = {}) {
  const cur = jobs.get(id);
  if (cur?.status === 'running') return cur;
  const book = store.getBook(id);
  if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });

  const tasks = [];
  if (cover && (force || !book.cover.image)) tasks.push({ kind: 'cover' });
  for (const p of book.pages) {
    if (images && (force || !p.image)) tasks.push({ kind: 'image', page: p.id });
    if (audio && (p.narration || p.text).trim() && (force || !p.audio || p.audioKey !== audioKey(book, p))) {
      tasks.push({ kind: 'audio', page: p.id });
    }
  }
  const job = { status: 'running', total: tasks.length, done: 0, errors: [], startedAt: new Date().toISOString() };
  jobs.set(id, job);

  (async () => {
    // A capa vem primeiro: ela é a referência visual das páginas.
    const coverTask = tasks.find((t) => t.kind === 'cover');
    const run = async (t) => {
      try {
        if (t.kind === 'cover') await generateCover(id);
        else if (t.kind === 'image') await generatePageImage(id, t.page);
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
      pool(rest.filter((t) => t.kind === 'audio'), 2, run),
    ]);
    job.status = job.errors.length ? 'done_with_errors' : 'done';
    job.finishedAt = new Date().toISOString();
  })();
  return job;
}

module.exports = { generateCover, generatePageImage, generatePageAudio, startGenerateAll, jobStatus, audioKey };
