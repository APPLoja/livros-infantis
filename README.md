# Livros Infantis

Estante de livros infantis com **ilustrações geradas pelo OpenRouter** e **narração gerada pela ElevenLabs (modelo `eleven_v4`)**, com destaque de cada palavra enquanto ela é lida.

- **Estante** (`/`): prateleiras coloridas, "Continuar lendo", livros trancados 🔒 e rascunhos.
- **Leitor** (`/ler?id=…`): texto em cima e ilustração embaixo, barra verde com fechar, voltar, `n/N`, avançar e som. Também tem tamanho de letra, mostrar ou esconder o texto, modo noite, virar página sozinho e música de fundo opcional (`public/musica.mp3`). Dá para deslizar o dedo e tocar numa palavra para ouvir a partir dela.
- **Editor** (`/admin`):
  - escreve a história com IA (OpenRouter) a partir de um tema ou cria o livro em branco;
  - edita o texto, a narração (com tags do v4, ex. `[sussurrando]`) e a cena de cada página;
  - gera a capa, a imagem e o áudio de cada página, ou tudo de uma vez com **⚡ Gerar tudo que falta**;
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
| POST | `/api/books/:id/pages/:pageId/audio` | gerar a narração de uma página (com timestamps) |
| POST | `/api/books/:id/generate-all` | `{force}` → fila em segundo plano; acompanhe em `GET /api/books/:id/job` |
| GET | `/api/voices` | vozes da conta ElevenLabs |
| GET/PUT | `/api/shelves` | prateleiras |
