// Carrega o .env da raiz do projeto (sem dependências externas).
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = (k, d = '') => (process.env[k] ?? d).trim();

module.exports = {
  PORT: Number(env('PORT', '8095')),
  HOST: env('HOST', '127.0.0.1'),
  ADMIN_TOKEN: env('ADMIN_TOKEN'),
  DATA_DIR: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),
  OPENROUTER_API_KEY: env('OPENROUTER_API_KEY'),
  OPENROUTER_IMAGE_MODEL: env('OPENROUTER_IMAGE_MODEL', 'google/gemini-2.5-flash-image'),
  OPENROUTER_TEXT_MODEL: env('OPENROUTER_TEXT_MODEL', 'google/gemini-2.5-flash'),
  ELEVENLABS_API_KEY: env('ELEVENLABS_API_KEY'),
  ELEVENLABS_MODEL: env('ELEVENLABS_MODEL', 'eleven_v4'),
  ELEVENLABS_DEFAULT_VOICE: env('ELEVENLABS_DEFAULT_VOICE'),
  PUBLIC_URL: env('PUBLIC_URL'),
};
