// Geração de imagens (e do texto das histórias) pelo OpenRouter.
const cfg = require('./env');

const API = 'https://openrouter.ai/api/v1/chat/completions';

async function call(body) {
  if (!cfg.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY não configurada no .env');
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Livros Infantis',
      ...(cfg.PUBLIC_URL ? { 'HTTP-Referer': cfg.PUBLIC_URL } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { throw new Error(`OpenRouter respondeu ${res.status}: ${txt.slice(0, 300)}`); }
  if (!res.ok || data.error) {
    const msg = data.error?.message || txt.slice(0, 300);
    throw new Error(`OpenRouter (${res.status}): ${msg}`);
  }
  return data;
}

/**
 * Gera uma ilustração. `references` são imagens (Buffer + mime) usadas para manter
 * os personagens consistentes entre as páginas (ex.: a capa do livro).
 * Devolve { buffer, mime }.
 */
async function generateImage({ prompt, aspectRatio = '4:3', references = [], model }) {
  const content = [{ type: 'text', text: prompt }];
  for (const r of references) {
    content.push({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.buffer.toString('base64')}` } });
  }
  const data = await call({
    model: model || cfg.OPENROUTER_IMAGE_MODEL,
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: aspectRatio },
    messages: [{ role: 'user', content }],
  });
  const msg = data.choices?.[0]?.message || {};
  const url = msg.images?.[0]?.image_url?.url || msg.images?.[0]?.url;
  if (!url) throw new Error(`O modelo não devolveu imagem. Resposta: ${String(msg.content || '').slice(0, 200)}`);
  const m = url.match(/^data:([^;]+);base64,(.+)$/s);
  if (m) return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error(`Falha ao baixar a imagem gerada (${img.status})`);
  return { mime: img.headers.get('content-type') || 'image/png', buffer: Buffer.from(await img.arrayBuffer()) };
}

/** Escreve uma história curta em páginas, já com prompts de ilustração. */
async function generateStory({ theme, pages = 12, age = '3 a 7 anos', model }) {
  const system = `Você é autor de livros infantis em português do Brasil. Escreva para crianças de ${age}.
Responda SOMENTE com JSON no formato:
{"title": "...", "characters": "descrição visual fixa dos personagens (roupas, cores, traços), em inglês, para manter consistência nas ilustrações",
 "style": "estilo de ilustração em inglês",
 "coverPrompt": "cena da capa em inglês: os personagens principais num momento marcante e alegre da história, sem texto",
 "musicPrompt": "trilha sonora instrumental em inglês (gênero, instrumentos, andamento, clima), suave para ficar por baixo da narração",
 "pages": [{"text": "texto curto da página (1 a 3 frases, no máximo ~25 palavras)", "imagePrompt": "descrição da cena em inglês, sem texto escrito na imagem",
   "ambiencePrompt": "som ambiente de fundo em inglês, sem fala e sem música (ex.: 'soft crickets and gentle night breeze'); repita exatamente o mesmo texto em páginas do mesmo lugar"}]}
Use exatamente ${pages} páginas. Cada imagePrompt deve mostrar exatamente a ação daquela página (lugar, hora do dia, o que o personagem faz), com enquadramentos variados entre as páginas (plano geral, close, de cima, etc.). Frases simples, ritmo gostoso de ler em voz alta, final com uma pequena lição positiva.`;
  const data = await call({
    model: model || cfg.OPENROUTER_TEXT_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Tema da história: ${theme}` },
    ],
  });
  const raw = data.choices?.[0]?.message?.content || '';
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('O modelo não devolveu JSON válido');
  const story = JSON.parse(json[0]);
  if (!Array.isArray(story.pages) || !story.pages.length) throw new Error('História sem páginas');
  return story;
}

const SONS_SISTEMA = `You are a sound designer for narrated children's picture books. Reply ONLY with JSON:
{"musicPrompt": "...", "pages": [{"id": "...", "ambiencePrompt": "..."}]}
- musicPrompt: one instrumental soundtrack for the whole book, in English: genre, instruments, tempo, mood. It plays quietly under the narration, so keep it gentle, simple and loopable. No vocals.
- ambiencePrompt (one per page, same ids): the background sound of that scene, in English, as a continuous loopable ambience (e.g. "gentle ocean waves on a calm beach, distant seagulls"). No speech, no music, no sudden loud noises. Pages in the same place must reuse EXACTLY the same text so the sound continues between pages. Use "" only if silence fits better.`;

/** Sugere a trilha do livro e os sons de fundo de cada página a partir do texto. */
async function suggestSounds(book, { model } = {}) {
  const resumo = {
    title: book.title,
    pages: book.pages.map((p) => ({ id: p.id, text: p.text, scene: p.imagePrompt })),
  };
  const data = await call({
    model: model || cfg.OPENROUTER_TEXT_MODEL,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SONS_SISTEMA }, { role: 'user', content: JSON.stringify(resumo) }],
  });
  const raw = data.choices?.[0]?.message?.content || '';
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('O modelo não devolveu JSON válido');
  const out = JSON.parse(json[0]);
  return { musicPrompt: String(out.musicPrompt || ''), pages: Array.isArray(out.pages) ? out.pages : [] };
}

module.exports = { generateImage, generateStory, suggestSounds };
