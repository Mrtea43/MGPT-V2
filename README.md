# MGPT

A single-page chat client for any OpenAI-compatible API — hosted or running on your own machine. No build step, no dependencies, no server. Open `index.html` and go.

## Features

- **Provider profiles** — keep several endpoint/key/model combos (DeepSeek, OpenRouter, local servers) and switch between them without re-entering anything
- **Rich OpenRouter model browser** — searchable catalog with pricing and context length, plus a free-models filter
- **Parallel compare** — send one prompt to 2–3 columns at once (any mix of profiles and models) and read the replies side by side
- **Chat search** — press `/` and find any conversation by title or message content
- **Streaming responses** with a working stop button
- **Markdown rendering** — headings, lists, quotes, links, and fenced code blocks with copy buttons
- **Conversation history** saved in the browser, with rename-on-first-message and delete
- **Message actions** — copy any message, retry an answer, edit and resend a question
- **File attachments** — drop or pick text/code files and images
- **Instruction files** — Markdown files that define how MGPT behaves, toggled per file
- **Local model support** — point it at Ollama or LM Studio and skip the API key entirely

## Getting started

Open `index.html` in a browser. Click **Settings** to manage your profiles. A profile keeps its own endpoint, key, and model; saving it makes it the one that answers your messages. Presets fill the form in one click:

| Provider | Endpoint | Key needed |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | yes |
| OpenAI | `https://api.openai.com/v1/chat/completions` | yes |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | yes |
| Ollama | `http://localhost:11434/v1/chat/completions` | no |
| LM Studio | `http://localhost:1234/v1/chat/completions` | no |
| llama.cpp / llamafile | `http://localhost:8080/v1/chat/completions` | no |
| vLLM | `http://localhost:8000/v1/chat/completions` | no |

Any endpoint that speaks the OpenAI chat-completions format will work — those are just shortcuts.

You don't have to type the full path. A bare host is completed when you save, and
the field updates so you can see what it resolved to:

| you type | you get |
|---|---|
| `localhost:8080` | `http://localhost:8080/v1/chat/completions` |
| `http://localhost:8080/` | `http://localhost:8080/v1/chat/completions` |
| `api.openai.com` | `https://api.openai.com/v1/chat/completions` |

Hosts that look local (`localhost`, `127.*`, `192.168.*`, `10.*`, `::1`) get
`http://`; everything else gets `https://`.

Upgrading from V1? Your saved endpoint, key, and model become your first
profile automatically — nothing to redo.

### Picking a model

Click the model selector in the header (it shows `profile · model`) to open Settings on the profile form. MGPT loads the current model list whenever you open Settings or pick a preset; the refresh button loads it again. All presets use their endpoint's live list, including the models installed on local servers. Display names appear where the provider supplies them, while requests always use the exact model ID. If listing fails, you can still enter an ID yourself.

**On OpenRouter**, Settings shows the model browser instead of a plain dropdown: a search box, a **Free only** toggle, and rows with the display name, exact ID, context length, and price per million tokens (prompt / output). The catalog is cached per profile, so the picker opens instantly even offline, and the refresh button pulls the live list. Type a raw model ID anytime — the browser is a helper, not a gate.

DeepSeek defaults to `deepseek-flash`, following the [current model documentation](https://api-docs.deepseek.com/quick_start/pricing/). Saved legacy names (`deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp`) are upgraded on the official DeepSeek endpoint. Custom endpoints and local model names are preserved.

### Comparing models

Click the **compare** toggle (the columns icon) next to the attach button. The picker shows up to three **columns**, each with its own profile dropdown and model field — so you can compare two models of one provider (for example, two free OpenRouter models) without a second profile, or mix different providers entirely. Model suggestions come from the cached OpenRouter catalog when the column's profile has one. Send, and each column streams its own reply; every column has its own retry and copy, and a **Continue here** action that promotes that profile to your active one for the rest of the conversation. One failing column doesn't take the others down. Compare applies turn by turn — turn it off to go back to single replies.

### Finding old chats

Press `/` (or `Ctrl/Cmd+K`) and type. The history list filters by title and message content, showing a snippet around the first match and how many messages matched.

### Running against a local model

Start your server, click the matching preset (or just type `localhost:8080`),
then refresh the model list. **Leave the API key blank** — local endpoints are
detected by hostname and never get an `Authorization` header.

The model field is also optional for local endpoints. llama.cpp and llamafile
serve whatever model is loaded and ignore the name, so MGPT sends `local-model`
if you leave it empty. Ollama and vLLM do route by name — use the refresh button
to load the list.

**If the request is blocked**, it's CORS, not the key. A page opened with
`file://` sends `Origin: null`, which some servers reject. Two fixes:

```bash
# serve the folder over http instead of opening the file directly
python -m http.server 5500      # then visit http://localhost:5500

# or allow the origin at the server
OLLAMA_ORIGINS='*' ollama serve
llama-server --host 127.0.0.1 --port 8080   # CORS is open by default
```

The browser console (F12) tells you which it is — a CORS failure shows as a
blocked cross-origin request, not an HTTP error code.

## Instruction files

**Settings → Instructions** holds Markdown files that shape MGPT's behaviour. Upload a `.md` file or write one in the app. Every enabled file is concatenated into the system prompt on each request, so you can keep separate files for tone, output format, and domain knowledge and switch them on and off independently.

Example `tone.md`:

```markdown
Answer in at most three sentences unless I ask for detail.
Show code before explaining it.
Never apologise.
```

Click a file's name to edit it. Toggle it off to keep it without using it.

## Attachments

Text and code files are read in the browser and appended to your message. Images are sent as image parts, which works on any vision-capable model behind an OpenAI-compatible endpoint.

Binary documents (PDF, DOCX, XLSX) can't be read client-side — export to text or paste the contents. Files over 180,000 characters are truncated so a single attachment can't consume the whole context window.

## Keyboard

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift` + `Enter` | New line |
| `/` or `Ctrl`/`Cmd` + `K` | Focus chat search |
| `Esc` | Clear the active search box; close settings or the history panel only when no field holds unsaved text; stop generating |

## Files

```
MGPT/
├── index.html    structure
├── styles.css    design system and layout
├── script.js     profiles, streaming, compare, search, storage
└── README.md
```

## Privacy

MGPT saves your API keys for all profiles, conversations, settings, cached model lists, and instruction files in this browser's `localStorage`. It has no chat backend, analytics, or tracking cookies. Messages, conversation context, included attachments, enabled instructions, and authentication go directly to your configured AI endpoints, whose own privacy and retention policies apply. Comparing sends the same message to each profile you picked — see [the privacy page](privacy.html) for the complete explanation. The Privacy link in the sidebar opens it in a separate tab, so an active conversation can continue.

Clearing site data erases everything, including your chat history.

## Notes

- Responses are escaped before any Markdown formatting is applied, so model output cannot inject markup into the page.
- Chat history is capped by browser storage (roughly 5 MB). When it fills up, the oldest conversations are dropped and you'll see a notice.
- **Free models on OpenRouter are rate-limited by OpenRouter itself**: 20 requests/minute and 50 per day until you've purchased $10 of credits (then 1000/day). The model browser shows how many free requests your key has left today, and failed requests carry OpenRouter's own advice in the error.
- Compare is capped at 3 columns — beyond that the columns stop being readable side by side.
- Run `__mgptSelfTest()` in the browser console to verify the Markdown renderer, stream parser, catalog formatting, and chat search.
- Run `node --test` to check profile migration, the OpenRouter catalog, compare fan-out, search, provider-switch races, and the renderer and stream self-checks. No packages are required.

## Customising

The interface uses matte dark surfaces, Manrope body typography, and a restrained
periwinkle accent. The monogram and custom geometric wordmark are SVG files in
`assets/`, so the branding stays sharp without loading a font. Change the tokens
in `:root` at the top of `styles.css`:

```css
--void:        #101113;                    /* page */
--glass:       rgba(255,255,255,.025);      /* resting panel */
--glass-2:     rgba(255,255,255,.055);      /* hover / raised */
--edge:        rgba(255,255,255,.09);       /* hairline border */
--edge-bright: rgba(255,255,255,.32);       /* focus / active */
```

The header keeps the active profile and model visible on desktop and mobile. The sidebar
collapses on desktop and becomes a drawer on smaller screens. Reduced motion,
reduced transparency, keyboard focus, and opaque fallbacks remain supported.
