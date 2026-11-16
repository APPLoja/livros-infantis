// Armazenamento em arquivos: data/books/<id>/book.json + imagens + áudios.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('./env');

const BOOKS = path.join(cfg.DATA_DIR, 'books');
const SHELVES = path.join(cfg.DATA_DIR, 'shelves.json');
fs.mkdirSync(BOOKS, { recursive: true });

const SHELF_COLORS = ['#5fb544', '#e5486a', '#3d8fd6', '#f2a531', '#8e5bd1', '#24a69a'];

function slugify(s) {
  return String(s || 'livro')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 50) || 'livro';
}

const bookDir = (id) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw Object.assign(new Error('id inválido'), { status: 400 });
  return path.join(BOOKS, id);
};

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function getBook(id) {
  const f = path.join(bookDir(id), 'book.json');
  if (!fs.existsSync(f)) return null;
  const book = JSON.parse(fs.readFileSync(f, 'utf8'));
  book.music ||= { file: null, prompt: '' }; // livros antigos não tinham trilha
  book.pages = book.pages.map(newPage);
  return book;
}

function listBooks() {
  return fs.readdirSync(BOOKS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => { try { return getBook(d.name); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt));
}

function newPage(p = {}) {
  return {
    id: p.id || crypto.randomBytes(4).toString('hex'),
    text: p.text || '',
    narration: p.narration || '',
    imagePrompt: p.imagePrompt || '',
    image: p.image || null,
    audio: p.audio || null,
    words: p.words || [],
    audioKey: p.audioKey || null,
    ambiencePrompt: p.ambiencePrompt || '', // som de fundo da página (em inglês)
    ambience: p.ambience || null,
  };
}

function createBook(data = {}) {
  let id = slugify(data.title);
  let n = 2;
  while (fs.existsSync(bookDir(id))) id = `${slugify(data.title)}-${n++}`;
  const now = new Date().toISOString();
  const book = {
    id,
    title: data.title || 'Novo livro',
    shelf: data.shelf || 'Contos Clássicos',
    style: data.style || 'whimsical children\'s book watercolor illustration, soft warm light, rich colors, cute expressive characters',
    characters: data.characters || '',
    voiceId: data.voiceId || cfg.ELEVENLABS_DEFAULT_VOICE || '',
    locked: !!data.locked,
    published: !!data.published,
    order: data.order ?? Date.now(),
    cover: { image: null, prompt: data.coverPrompt || '' },
    music: { file: null, prompt: data.musicPrompt || '' },
    pages: (data.pages || []).map(newPage),
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(bookDir(id), { recursive: true });
  writeJson(path.join(bookDir(id), 'book.json'), book);
  return book;
}

const EDITABLE = ['title', 'shelf', 'style', 'characters', 'voiceId', 'locked', 'published', 'order'];

function saveBook(book) {
  book.updatedAt = new Date().toISOString();
  writeJson(path.join(bookDir(book.id), 'book.json'), book);
  return book;
}

/** Aplica metadados e páginas vindos do editor, preservando mídias já geradas. */
function applyUpdate(book, data) {
  for (const k of EDITABLE) if (k in data) book[k] = data[k];
  if (data.cover && 'prompt' in data.cover) book.cover.prompt = data.cover.prompt;
  if (data.music && 'prompt' in data.music) book.music.prompt = String(data.music.prompt || '');
  if (Array.isArray(data.pages)) {
    const old = new Map(book.pages.map((p) => [p.id, p]));
    book.pages = data.pages.map((p) => {
      const prev = old.get(p.id);
      return newPage({
        ...(prev || {}),
        id: p.id,
        text: p.text ?? prev?.text,
        narration: p.narration ?? prev?.narration,
        imagePrompt: p.imagePrompt ?? prev?.imagePrompt,
        ambiencePrompt: p.ambiencePrompt ?? prev?.ambiencePrompt,
      });
    });
    const keep = new Set(book.pages.map((p) => p.id));
    for (const [pid, p] of old) {
      if (!keep.has(pid)) { removeMedia(book.id, p.image); removeMedia(book.id, p.audio); removeIfUnused(book, p.ambience); }
    }
  }
  return book;
}

/** Atualiza o livro de forma atômica dentro de uma função (evita perder escritas concorrentes). */
const locks = new Map();
async function mutate(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const p = new Promise((r) => { release = r; });
  locks.set(id, prev.then(() => p));
  await prev;
  try {
    const book = getBook(id);
    if (!book) throw Object.assign(new Error('Livro não encontrado'), { status: 404 });
    const r = await fn(book);
    saveBook(book);
    return r ?? book;
  } finally {
    release();
    if (locks.get(id) === p) locks.delete(id);
  }
}

function deleteBook(id) {
  fs.rmSync(bookDir(id), { recursive: true, force: true });
}

function writeMedia(id, name, buffer) {
  fs.writeFileSync(path.join(bookDir(id), name), buffer);
  return name;
}

/** Sons de fundo podem ser compartilhados entre páginas: só apaga se ninguém mais usa. */
function removeIfUnused(book, name) {
  if (!name) return;
  const usado = book.cover?.image === name || book.music?.file === name
    || book.pages.some((p) => p.image === name || p.audio === name || p.ambience === name);
  if (!usado) removeMedia(book.id, name);
}

function removeMedia(id, name) {
  if (!name || name.includes('/') || name.includes('..')) return;
  fs.rmSync(path.join(bookDir(id), name), { force: true });
}

function readMedia(id, name) {
  return fs.readFileSync(path.join(bookDir(id), name));
}

function getShelves() {
  let saved = [];
  if (fs.existsSync(SHELVES)) { try { saved = JSON.parse(fs.readFileSync(SHELVES, 'utf8')); } catch { /* ignora */ } }
  const names = new Set(saved.map((s) => s.name));
  for (const b of listBooks()) if (!names.has(b.shelf)) { names.add(b.shelf); saved.push({ name: b.shelf }); }
  return saved.map((s, i) => ({ name: s.name, color: s.color || SHELF_COLORS[i % SHELF_COLORS.length], theme: s.theme || '' }));
}

function saveShelves(list) {
  writeJson(SHELVES, list.map((s) => ({ name: String(s.name), color: s.color || '', theme: s.theme || '' })));
  return getShelves();
}

module.exports = {
  BOOKS, getBook, listBooks, createBook, applyUpdate, saveBook, mutate, deleteBook,
  writeMedia, removeMedia, removeIfUnused, readMedia, getShelves, saveShelves, newPage, bookDir,
};
