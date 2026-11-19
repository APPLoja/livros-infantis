// Normaliza o volume da narração: cada voz da ElevenLabs sai com um volume diferente
// (algumas ~8 dB mais baixas). Mede a loudness (EBU R128) e aplica ganho + limitador.
// Não muda a duração do áudio, então os tempos das palavras continuam valendo.
const { spawn } = require('node:child_process');

let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch { /* sem ffmpeg: mantém o áudio como veio */ }

const ALVO_LUFS = -19; // volume das narrações da voz padrão

function rodar(args, entrada) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out: Buffer.concat(out), err }) : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(entrada);
  });
}

async function medirLufs(buffer) {
  const { err } = await rodar(['-hide_banner', '-i', 'pipe:0', '-af', 'ebur128', '-f', 'null', '-'], buffer);
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(err.slice(err.lastIndexOf('Summary')));
  return m ? Number(m[1]) : null;
}

/** Devolve o MP3 com o volume ajustado ao alvo (ou o original, se não precisar ou não der). */
async function normalizarVoz(buffer, alvo = ALVO_LUFS) {
  if (!FFMPEG) return buffer;
  try {
    const lufs = await medirLufs(buffer);
    if (lufs == null || !Number.isFinite(lufs)) return buffer;
    const ganho = Math.max(-10, Math.min(15, alvo - lufs));
    if (Math.abs(ganho) < 1.5) return buffer;
    const { out } = await rodar(['-hide_banner', '-i', 'pipe:0',
      '-af', `volume=${ganho.toFixed(1)}dB,alimiter=limit=0.94:attack=5:release=50:level=false`,
      '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], buffer);
    return out.length > 1000 ? out : buffer;
  } catch (e) {
    console.warn('normalizarVoz:', e.message);
    return buffer;
  }
}

module.exports = { normalizarVoz, medirLufs, ALVO_LUFS };
