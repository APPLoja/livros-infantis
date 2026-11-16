# Livros Infantis

Estante de livros infantis com **ilustrações geradas pelo OpenRouter** e **narração gerada pela ElevenLabs (modelo `eleven_v4`)**, com destaque de cada palavra enquanto ela é lida.

- **Estante** (`/`): prateleiras coloridas, "Continuar lendo", livros trancados 🔒 e rascunhos.
- **Leitor** (`/ler?id=…`): texto em cima e ilustração embaixo (com movimento lento de câmera, efeito "Ken Burns", diferente em cada página), barra verde com fechar, voltar, `n/N`, avançar e som. Também tem tamanho de letra, mostrar ou esconder o texto, modo noite, virar página sozinho **trilha sonora** e **sons de fundo** de cada página (com botões para ligar e desligar; o volume abaixa sozinho enquanto a narração fala e o som troca com fade entre as páginas). Se o livro não tiver trilha, usa `public/musica.mp3`, se existir. Dá para deslizar o dedo e tocar numa palavra para ouvir a partir dela.
- **App instalável e offline**: dá para instalar como app (botão **📲 Instalar** na estante; no iPhone, Compartilhar → Adicionar à Tela de Início). Cada livro pode ser **baixado** (botão ⬇ no leitor ou painel ⬇️ na estante, com "Baixar todos") e funciona sem internet: texto, imagens, narração, trilha e sons. Livros baixados mostram um ✓ e são atualizados sozinhos quando mudam no servidor. Implementação: `public/sw.js` (service worker), `public/offline.js` e `public/manifest.webmanifest`.
- **Editor** (`/admin`):
  - escreve a história com IA (OpenRouter) a partir de um tema ou cria o livro em branco;
  - edita o texto, a narração (com tags do v4, ex. `[sussurrando]`) e a cena de cada página;
  - gera a capa, a imagem e o áudio de cada página, ou tudo de uma vez com **⚡ Gerar tudo que falta**;
  - também aceita imagens prontas: botão **📤 Enviar**, arrastar e soltar na miniatura, ou **colar** (clique na página ou na capa e aperte Ctrl+V; no celular, use o botão **📋 Colar**);
  - trilha sonora do livro e som de fundo de cada página, gerados pela ElevenLabs (música e efeitos sonoros), sugeridos pela IA a partir do texto (**✨ Sugerir trilha e sons**) ou enviados em MP3. Páginas com o mesmo texto de som compartilham o mesmo arquivo, então o som continua sem corte;
  - escolhe a voz entre as vozes da sua conta ElevenLabs;
  - organiza as prateleiras (nome, cor, ordem, tema "natal").

A capa serve de **referência visual** para as ilustrações das páginas, para manter os personagens iguais. Por isso, gere a capa primeiro (o "gerar tudo" já faz nessa ordem).

## Rodar

Requer Node 20 ou mais novo. A única dependência é o `sharp`, que comprime as imagens para WebP.

```bash
npm install
cp .env.example .env   # preencha ADMIN_TOKEN, OPENROUTER_API_KEY e ELEVENLABS_API_KEY
npm start              # http://127.0.0.1:8095
```

| Variável | Padrão | Para quê |
|---|---|---|
| `ADMIN_TOKEN` | — | senha do `/admin` (obrigatória para editar) |
| `OPENROUTER_API_KEY` | — | imagens e texto |
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-2.5-flash-image` | qualquer modelo do OpenRouter com saída de imagem |
| `OPENROUTER_TEXT_MODEL` | `google/gemini-2.5-flash` | escreve as histórias |
| `ELEVENLABS_API_KEY` | — | narração |
| `ELEVENLABS_MODEL` | `eleven_v4` | modelo de voz |
| `ELEVENLABS_DEFAULT_VOICE` | — | voz padrão dos livros novos |
| `DATA_DIR` | `./data` | onde ficam os livros |

## Dados

Cada livro fica em `data/books/<id>/`: o `book.json` (texto, prompts e tempos das palavras) e as imagens e MP3s gerados. A ordem e as cores das prateleiras ficam em `data/shelves.json`. Para fazer backup, basta copiar a pasta `data/`.

## API (resumo)

Todas as rotas de escrita exigem o header `x-admin-token`.

| Método | Rota | |
|---|---|---|
| GET | `/api/library` | prateleiras com os livros publicados (`?all=1` mostra também os rascunhos) |
| GET/PUT/DELETE | `/api/books/:id` | ler, salvar ou excluir um livro |
| POST | `/api/books` | criar um livro |
| POST | `/api/story` | `{theme, pages, age, shelf, voiceId}` → livro escrito pela IA |
| POST | `/api/books/:id/cover` | gerar a capa |
| POST | `/api/books/:id/pages/:pageId/image` | gerar a ilustração de uma página |
| PUT | `/api/books/:id/cover/upload` · `/api/books/:id/pages/:pageId/upload` | enviar uma imagem pronta (corpo = arquivo, `Content-Type: image/*`, até 25 MB) |
| POST | `/api/books/:id/pages/:pageId/audio` | gerar a narração de uma página (com timestamps) |
| POST | `/api/books/:id/sounds/suggest` | `{overwrite}` → IA preenche a trilha e os sons de fundo |
| POST/DELETE | `/api/books/:id/music` | gerar (ElevenLabs Music, 60 s) ou remover a trilha |
| POST/DELETE | `/api/books/:id/pages/:pageId/ambience` | gerar (efeito sonoro em loop, 20 s) ou remover o som de fundo |
| PUT | `/api/books/:id/music/upload` · `/api/books/:id/pages/:pageId/ambience/upload` | enviar um áudio pronto (`Content-Type: audio/*`) |
| POST | `/api/books/:id/generate-all` | `{force, images, audio, cover, sounds}` → fila em segundo plano; acompanhe em `GET /api/books/:id/job` |
| GET | `/api/voices` | vozes da conta ElevenLabs |
| GET/PUT | `/api/shelves` | prateleiras |
