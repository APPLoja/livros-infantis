// Narração pela ElevenLabs (modelo v4), com tempos de cada palavra para destacar no leitor.
const cfg = require('./env');

const API = 'https://api.elevenlabs.io/v1';

function headers() {
  if (!cfg.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY não configurada no .env');
  return { 'xi-api-key': cfg.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' };
}

/**
 * Converte o alinhamento por caractere em palavras com início/fim.
 * Tags de áudio do v4 entre colchetes ([risos], [sussurrando]...) são ignoradas.
 */
function wordsFromAlignment(al) {
  const chars = al?.characters || [];
  const st = al?.character_start_times_seconds || [];
  const en = al?.character_end_times_seconds || [];
  const words = [];
  let cur = null;
  let inTag = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '[') { inTag = true; continue; }
    if (inTag) { if (c === ']') inTag = false; continue; }
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { w: '', start: st[i], end: en[i] };
    cur.w += c;
    cur.end = en[i];
  }
  if (cur) words.push(cur);
  return words
    .filter((w) => /[\p{L}\p{N}]/u.test(w.w))
    .map((w) => ({ w: w.w, start: +w.start.toFixed(3), end: +w.end.toFixed(3) }));
}

/** Gera o MP3 de um trecho. Devolve { buffer, words, duration }. */
async function synthesize({ text, voiceId, model }) {
  const voice = voiceId || cfg.ELEVENLABS_DEFAULT_VOICE;
  if (!voice) throw new Error('Escolha uma voz (ou defina ELEVENLABS_DEFAULT_VOICE no .env)');
  const modelId = model || cfg.ELEVENLABS_MODEL;
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: headers(),
    // v4: sem voice_settings (o modelo controla a expressão pelas tags de áudio)
    body: JSON.stringify({ text, model_id: modelId }),
    signal: AbortSignal.timeout(180_000),
  });
  const txt = await res.text();
  if (res.status === 401) throw new Error('Chave da ElevenLabs inválida ou sem permissão');
  if (res.status === 404) throw new Error('Voz da ElevenLabs não encontrada');
  if (!res.ok) throw new Error(`ElevenLabs (${res.status}): ${txt.slice(0, 300)}`);
  const data = JSON.parse(txt);
  const al = data.alignment || data.normalized_alignment;
  const words = wordsFromAlignment(al);
  const ends = al?.character_end_times_seconds || [];
  return { buffer: Buffer.from(data.audio_base64, 'base64'), words, duration: ends.length ? ends[ends.length - 1] : null };
}

/** Lista as vozes da conta (inclui as da biblioteca que foram adicionadas). */
async function listVoices() {
  const res = await fetch(`${API}/voices`, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ElevenLabs (${res.status}) ao listar vozes`);
  const data = await res.json();
  return (data.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels || {},
    preview: v.preview_url,
  }));
}

module.exports = { synthesize, listVoices, wordsFromAlignment };
