/* ==========================================================================
   MGPT — V2
   Talks to any OpenAI-compatible /chat/completions endpoint, local or hosted.
   V2 adds provider profiles, a rich OpenRouter model browser, chat search,
   and parallel multi-model compare.
   ========================================================================== */

const KEYS = {
    settings: 'mertgpt_settings',   // { activeId }
    profiles: 'mertgpt_profiles',   // [{ id, name, endpoint, apiKey, model }]
    chats:    'mertgpt_chats',
    inst:     'mertgpt_instructions',
    nav:      'mertgpt_nav_collapsed',
};

const modelsKey = (id) => `mertgpt_models_${id}`;

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-flash';

// Saved legacy names that no longer resolve on the official DeepSeek endpoint.
const LEGACY_DEEPSEEK = [
    'deepseek-chat', 'deepseek-reasoner',
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
];

// Friendly profile names for hosts people actually type.
const HOST_NAMES = [
    ['api.deepseek.com', 'DeepSeek'],
    ['api.openai.com', 'OpenAI'],
    ['openrouter.ai', 'OpenRouter'],
    ['api.mistral.ai', 'Mistral'],
    ['api.groq.com', 'Groq'],
    ['api.x.ai', 'xAI'],
    ['generativelanguage.googleapis.com', 'Google'],
];

const COMPARE_MAX = 3;   // columns that fit side by side without becoming unreadable

const state = {
    profiles: [],        // [{ id, name, endpoint, apiKey, model }]
    activeId: null,      // profile that answers the next single message
    instructions: [],    // [{ id, name, body, on }]
    chats: [],           // [{ id, title, messages, updatedAt }]
    currentId: null,
    pending: [],         // staged attachments
    aborts: [],          // AbortControllers while streaming (1 or more)
    compare: false,      // composer toggle
    compareCols: [],     // [{ profileId, model }] columns for the next compare turn
    searchQuery: '',     // sidebar chat filter
};

const $ = (id) => document.getElementById(id);

const el = {
    app: document.querySelector('.app'),
    navHide: $('navHide'), navShow: $('navShow'),
    sidebar: $('sidebar'), scrim: $('scrim'), menuBtn: $('menuBtn'),
    newChatBtn: $('newChatBtn'), newChatBtnMobile: $('newChatBtnMobile'),
    chatList: $('chatList'), historyEmpty: $('historyEmpty'),
    chatSearch: $('chatSearch'),
    settingsBtn: $('settingsBtn'),
    modelButton: $('modelButton'), activeModel: $('activeModel'),

    welcome: $('welcome'), starters: $('starters'),
    thread: $('thread'), messages: $('messages'),

    composer: $('composer'), composerWrap: $('composerWrap'),
    input: $('input'), sendBtn: $('sendBtn'),
    attachBtn: $('attachBtn'), fileInput: $('fileInput'), chips: $('chips'),
    compareBtn: $('compareBtn'), compareBar: $('compareBar'),
    compareCols: $('compareCols'), compareAdd: $('compareAdd'),
    rail: $('rail'), railText: $('railText'),

    modal: $('settingsModal'), closeModal: $('closeModal'),
    cancelBtn: $('cancelBtn'), saveBtn: $('saveBtn'),
    apiKeyInput: $('apiKey'), toggleApiKey: $('toggleApiKey'),
    endpointInput: $('apiEndpoint'), presets: $('presets'),
    profileList: $('profileList'), addProfile: $('addProfile'),
    profileName: $('profileName'),
    modelInput: $('modelSelect'), modelList: $('modelList'),
    refreshModels: $('refreshModels'), modelHint: $('modelHint'),
    modelBrowser: $('modelBrowser'), modelSearch: $('modelSearch'),
    freeOnly: $('freeOnly'), modelRows: $('modelRows'), browserHint: $('browserHint'),
    keyInfo: $('keyInfo'),

    tabBtnConn: $('tabBtnConn'), tabBtnInst: $('tabBtnInst'),
    tabConn: $('tab-conn'), tabInst: $('tab-inst'),
    instList: $('instList'), instEmpty: $('instEmpty'),
    addInstFile: $('addInstFile'), addInstWrite: $('addInstWrite'),
    instFileInput: $('instFileInput'), instEditor: $('instEditor'),
    instName: $('instName'), instBody: $('instBody'),
    instSave: $('instSave'), instCancel: $('instCancel'),

    toasts: $('toasts'),
};

const ICON = {
    copy:  '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M21 2v6h-6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L21 8"/><path d="M3 22v-6h6"/><path d="M21 15a9 9 0 0 1-14.85 3.36L3 16"/></svg>',
    edit:  '<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
    x:     '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    go:   '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

/* ==========================================================================
   Profiles
   ========================================================================== */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function profileById(id) {
    return state.profiles.find((p) => p.id === id) || null;
}

function activeProfile() {
    return profileById(state.activeId);
}

function profileNameFromEndpoint(endpoint) {
    try {
        const host = new URL(endpoint).hostname;
        const known = HOST_NAMES.find(([h]) => host === h || host.endsWith(`.${h}`));
        if (known) return known[1];
        const local = { '11434': 'Ollama', '1234': 'LM Studio', '8080': 'llama.cpp', '8000': 'vLLM' };
        return local[new URL(endpoint).port] || host;
    } catch {
        return 'Custom';
    }
}

// Snapshots stored inside messages so history renders correctly even after a
// profile is edited or deleted. Never includes the key. `modelOverride` lets
// compare columns pin a model other than the profile's default; '' means
// "use the profile's own model".
function snapshot(p, modelOverride) {
    const model = modelOverride?.trim() ? modelOverride : p.model;
    return {
        id: p.id, name: p.name, endpoint: p.endpoint,
        model: model.trim() || 'local-model',
    };
}

/* ==========================================================================
   Storage
   ========================================================================== */

function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function loadAll() {
    const s = load(KEYS.settings, {});
    state.profiles = load(KEYS.profiles, []);

    // One-time migration: the V1 settings triple becomes the first profile.
    if (!state.profiles.length) {
        let { endpoint = '', apiKey = '', model = '' } = s;
        if (!endpoint) { endpoint = DEFAULT_ENDPOINT; model = DEFAULT_MODEL; }
        try {
            if (new URL(normalizeEndpoint(endpoint)).hostname === 'api.deepseek.com'
                && LEGACY_DEEPSEEK.includes(model)) {
                model = DEFAULT_MODEL;
            }
        } catch { /* Keep invalid saved endpoints editable in Settings. */ }
        state.profiles = [{
            id: uid(),
            name: s.name || profileNameFromEndpoint(endpoint),
            endpoint, apiKey, model,
        }];
    }

    state.activeId = profileById(s.activeId) ? s.activeId : state.profiles[0].id;
    state.instructions = load(KEYS.inst, []);
    state.chats = load(KEYS.chats, []);
}

function saveSettings() {
    localStorage.setItem(KEYS.settings, JSON.stringify({ activeId: state.activeId }));
}

function saveProfiles() {
    localStorage.setItem(KEYS.profiles, JSON.stringify(state.profiles));
}

function saveInstructions() {
    localStorage.setItem(KEYS.inst, JSON.stringify(state.instructions));
}

// ponytail: on quota overflow we drop the oldest chats. Swap to IndexedDB if
// people start keeping long image-heavy histories.
function saveChats() {
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            localStorage.setItem(KEYS.chats, JSON.stringify(state.chats));
            return;
        } catch (err) {
            if (err.name !== 'QuotaExceededError' || state.chats.length <= 1) {
                console.error('Could not save chats:', err);
                return;
            }
            const dropped = state.chats.pop();
            if (dropped && dropped.id === state.currentId) state.chats.unshift(dropped);
            toast('Storage full — removed the oldest conversation.', 'bad');
        }
    }
}

/* ==========================================================================
   Markdown — escape first, then format. XSS is structurally impossible.
   ========================================================================== */

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeUrl(url) {
    return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : '';
}

function inline(s) {
    const spans = [];
    // Inline code is pulled first so ** and _ inside it stay literal.
    s = s.replace(/`([^`\n]+)`/g, (_, code) => {
        spans.push(`<code>${code}</code>`);
        return `\u0001${spans.length - 1}\u0001`;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, url) => {
        const href = safeUrl(url);
        return href
            ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
            : whole;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0001(\d+)\u0001/g, (_, i) => spans[+i]);
}

function renderMarkdown(src) {
    const fences = [];

    // 1. Lift fenced code out before anything touches it.
    let text = String(src).replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (_, lang, code) => {
        fences.push({ lang: lang || 'code', code: code.replace(/\n$/, '') });
        return `\u0000${fences.length - 1}\u0000`;
    });

    // 2. Escape. Everything after this point operates on inert text.
    text = escapeHtml(text);

    // 3. Block structure.
    const lines = text.split('\n');
    const out = [];
    let i = 0;

    const takeWhile = (test) => {
        const got = [];
        while (i < lines.length && test(lines[i])) got.push(lines[i++]);
        return got;
    };

    while (i < lines.length) {
        const line = lines[i];

        if (/^\u0000\d+\u0000$/.test(line.trim())) { out.push(line.trim()); i++; continue; }
        if (!line.trim()) { i++; continue; }

        let m;
        if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
            out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue;
        }
        if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && /^[\s\-*_]+$/.test(line)) {
            out.push('<hr>'); i++; continue;
        }
        if (/^&gt;\s?/.test(line)) {
            const quoted = takeWhile((l) => /^&gt;\s?/.test(l)).map((l) => l.replace(/^&gt;\s?/, ''));
            out.push(`<blockquote>${inline(quoted.join(' '))}</blockquote>`); continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
            const items = takeWhile((l) => /^\s*[-*+]\s+/.test(l))
                .map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ''))}</li>`);
            out.push(`<ul>${items.join('')}</ul>`); continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
            const items = takeWhile((l) => /^\s*\d+[.)]\s+/.test(l))
                .map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
            out.push(`<ol>${items.join('')}</ol>`); continue;
        }

        const para = takeWhile((l) =>
            l.trim() &&
            !/^\u0000\d+\u0000$/.test(l.trim()) &&
            !/^(#{1,3}\s|&gt;|\s*[-*+]\s|\s*\d+[.)]\s)/.test(l));
        if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
        else i++;
    }

    // 4. Put code blocks back, contents escaped.
    return out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => {
        const { lang, code } = fences[+n];
        return `<div class="code-block">
            <div class="code-head">
              <span class="code-lang">${escapeHtml(lang)}</span>
              <button class="act js-copy-code" type="button">${ICON.copy}Copy</button>
            </div>
            <pre><code>${escapeHtml(code)}</code></pre>
          </div>`;
    });
}

/* ==========================================================================
   Endpoint helpers
   ========================================================================== */

function isLocalEndpoint(url) {
    try {
        const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
        return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    } catch {
        return false;
    }
}

function isOpenRouter(url) {
    try {
        const host = new URL(url).hostname;
        return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
    } catch {
        return false;
    }
}

function apiBase(endpoint) {
    return endpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

// Accepts what people actually type. "localhost:8080" has no scheme, so
// new URL() throws on it and every downstream check treats it as remote —
// which is what made local servers demand an API key. A bare origin also has
// to grow the OpenAI-compatible path, or the POST lands on the web root.
function normalizeEndpoint(raw) {
    let url = String(raw).trim();
    if (!url) return '';

    if (!/^https?:\/\//i.test(url)) {
        const bare = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.)/i.test(url);
        url = (bare ? 'http://' : 'https://') + url;
    }

    try {
        const u = new URL(url);
        if (u.pathname === '/' || u.pathname === '') {
            u.pathname = '/v1/chat/completions';
        } else if (/\/v\d+\/?$/.test(u.pathname)) {
            u.pathname = `${u.pathname.replace(/\/+$/, '')}/chat/completions`;
        }
        return u.toString();
    } catch {
        return url;   // let the request fail loudly rather than rewrite blindly
    }
}

function authHeaders(key, endpoint) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    else if (!isLocalEndpoint(endpoint)) headers.Authorization = 'Bearer ';
    return headers;
}

/* ==========================================================================
   Model catalog — OpenRouter ships metadata the others don't
   ========================================================================== */

// OpenRouter prices come as USD-per-token strings; "-1" means unknown.
const priceField = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

function parseCatalog(json) {
    const seen = new Map();
    for (const m of (json?.data || json?.models || [])) {
        if (!m || typeof m.id !== 'string' || !m.id.trim()) continue;
        // First entry wins — a later duplicate without metadata must not
        // clobber the real one.
        if (seen.has(m.id)) continue;
        const pin = priceField(m.pricing?.prompt);
        const pout = priceField(m.pricing?.completion);
        seen.set(m.id, {
            id: m.id,
            name: m.name || m.id,
            ctx: Number(m.context_length) || 0,
            pin, pout,
            free: pin === 0 && pout === 0,
        });
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function filterCatalog(catalog, query, freeOnly) {
    const q = String(query || '').trim().toLowerCase();
    return catalog.filter((m) =>
        (!freeOnly || m.free)
        && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)));
}

function formatContext(n) {
    if (!n || n < 1000) return '';
    if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(2))}M ctx`;
    return `${Math.round(n / 1000)}K ctx`;
}

function formatUsdPerM(n) {
    const v = n * 1e6;
    return `$${parseFloat(v >= 100 ? v.toFixed(0) : v.toFixed(2))}`;
}

function formatPrice(m) {
    if (m.free) return 'Free';
    if (m.pin != null && m.pout != null) return `${formatUsdPerM(m.pin)} / ${formatUsdPerM(m.pout)}`;
    if (m.pin != null) return `${formatUsdPerM(m.pin)} in`;
    if (m.pout != null) return `${formatUsdPerM(m.pout)} out`;
    return '';
}

/* ==========================================================================
   Rail + toasts
   ========================================================================== */

function rail(text, tone = '') {
    el.railText.textContent = text;
    el.rail.className = 'rail' + (tone ? ` is-${tone}` : '');
}

function idleRail() {
    const p = activeProfile();
    const model = p ? (p.model.trim() || (isLocalEndpoint(p.endpoint) ? 'local model' : 'no model')) : 'no profile';
    el.activeModel.textContent = p ? `${p.name} · ${model}` : 'Choose a model';
    el.modelButton.title = p
        ? `Active profile: ${p.name}\nModel: ${model}\nClick to change`
        : 'Choose a profile';
    if (!p) { rail('No profile · Open settings', 'bad'); return; }
    const local = isLocalEndpoint(p.endpoint);
    if (!p.apiKey && !local) rail('No key · Open settings', 'bad');
    else if (state.compare) rail(`Ready · compare with ${state.compareCols.length || '…'} columns`);
    else rail(`Ready · ${p.name} (${model})`);
}

function toast(message, tone = '') {
    const node = document.createElement('div');
    node.className = 'toast' + (tone ? ` is-${tone}` : '');
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => {
        node.classList.add('is-out');
        node.addEventListener('animationend', () => node.remove(), { once: true });
    }, 3200);
}

/* ==========================================================================
   Chats + search
   ========================================================================== */

function currentChat() {
    return state.chats.find((c) => c.id === state.currentId) || null;
}

function titleFrom(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > 42 ? `${clean.slice(0, 42)}…` : (clean || 'New chat');
}

// Pure filter so the search logic is testable without a DOM.
// Returns [{ chat, snippet, hits }] in the original order.
function searchChats(chats, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return chats.map((chat) => ({ chat, snippet: '', hits: 0 }));

    const out = [];
    for (const chat of chats) {
        let hits = 0;
        let snippet = '';
        if (chat.title.toLowerCase().includes(q)) hits++;
        for (const msg of chat.messages || []) {
            if ((msg.text || '').toLowerCase().includes(q)) {
                hits++;
                if (!snippet) snippet = msg.text;
            }
        }
        if (hits) out.push({ chat, snippet, hits });
    }
    return out;
}

// A short excerpt around the first match, built with textContent so the
// query can never inject markup into the sidebar.
function snippetNode(text, query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return document.createTextNode('');
    const start = Math.max(0, idx - 30);
    const end = Math.min(text.length, idx + query.length + 70);
    const frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(document.createTextNode('…'));
    frag.appendChild(document.createTextNode(text.slice(start, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + query.length);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(text.slice(idx + query.length, end)));
    if (end < text.length) frag.appendChild(document.createTextNode('…'));
    return frag;
}

function ensureChat() {
    let chat = currentChat();
    if (!chat) {
        chat = { id: uid(), title: 'New chat', messages: [], updatedAt: Date.now() };
        state.chats.unshift(chat);
        state.currentId = chat.id;
    }
    return chat;
}

function newChat() {
    stopStream();
    state.currentId = null;
    state.pending = [];
    el.input.value = '';
    autoGrow();
    renderChips();
    renderThread();
    renderSidebar();
    closeSidebar();
    el.input.focus();
}

function openChat(id) {
    stopStream();
    state.currentId = id;
    renderThread();
    renderSidebar();
    closeSidebar();
}

function deleteChat(id) {
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.currentId === id) state.currentId = null;
    saveChats();
    renderSidebar();
    renderThread();
}

function renderSidebar() {
    el.chatList.innerHTML = '';
    const results = searchChats(state.chats, state.searchQuery);
    el.historyEmpty.hidden = results.length > 0;
    if (!results.length && state.searchQuery.trim()) {
        el.historyEmpty.textContent = `No chats match “${state.searchQuery.trim()}”.`;
    } else {
        el.historyEmpty.textContent = 'Your conversations will appear here.';
    }

    for (const { chat, snippet, hits } of results) {
        const li = document.createElement('li');
        li.className = 'chat-row' + (chat.id === state.currentId ? ' is-on' : '');

        const open = document.createElement('button');
        open.className = 'chat-open';
        const label = document.createElement('span');
        label.className = 'chat-title';
        label.textContent = chat.title;
        open.appendChild(label);
        open.title = chat.title;
        open.addEventListener('click', () => openChat(chat.id));

        if (state.searchQuery.trim() && snippet) {
            const note = document.createElement('span');
            note.className = 'chat-snippet';
            note.appendChild(snippetNode(snippet, state.searchQuery.trim()));
            open.appendChild(note);
        }
        if (state.searchQuery.trim() && hits > 1) {
            const count = document.createElement('span');
            count.className = 'chat-hits';
            count.textContent = `${hits}×`;
            open.appendChild(count);
        }

        const del = document.createElement('button');
        del.className = 'chat-del';
        del.innerHTML = ICON.trash;
        del.setAttribute('aria-label', `Delete ${chat.title}`);
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteChat(chat.id);
        });

        li.append(open, del);
        el.chatList.appendChild(li);
    }
}

/* ==========================================================================
   Thread rendering
   ========================================================================== */

function renderThread() {
    const chat = currentChat();
    const has = chat && chat.messages.length > 0;

    el.welcome.hidden = has;
    el.thread.hidden = !has;
    el.messages.innerHTML = '';

    if (!has) { idleRail(); return; }
    chat.messages.forEach((msg, i) => el.messages.appendChild(messageNode(msg, i)));
    scrollToEnd();
}

function messageNode(msg, index) {
    if (msg.compare) return compareNode(msg, index);

    const wrap = document.createElement('div');
    wrap.className = `msg ${msg.role}` + (msg.error ? ' error' : '');
    wrap.dataset.msg = index;

    const role = document.createElement('p');
    role.className = 'msg-role';
    role.textContent = msg.role === 'user' ? 'You' : 'MGPT';
    wrap.appendChild(role);

    if (msg.files && msg.files.length) {
        const list = document.createElement('div');
        list.className = 'msg-files';
        for (const f of msg.files) {
            const tag = document.createElement('span');
            tag.className = 'msg-file';
            tag.textContent = f.name;
            list.appendChild(tag);
        }
        wrap.appendChild(list);
    }

    if (msg.role === 'assistant' && msg.profile) {
        const meta = document.createElement('p');
        meta.className = 'msg-meta';
        meta.textContent = `via ${msg.profile.name} · ${msg.profile.model}`;
        wrap.appendChild(meta);
    }

    const body = document.createElement('div');
    body.className = 'msg-body md';
    body.innerHTML = renderMarkdown(msg.text);
    wrap.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    actions.appendChild(action(ICON.copy, 'Copy', () => {
        navigator.clipboard.writeText(msg.text)
            .then(() => toast('Copied.', 'ok'))
            .catch(() => toast('Copy failed.', 'bad'));
    }));

    if (msg.role === 'assistant' && !msg.error) {
        actions.appendChild(action(ICON.retry, 'Retry', () => regenerate(index)));
    }
    if (msg.role === 'user') {
        actions.appendChild(action(ICON.edit, 'Edit', () => editFrom(index)));
    }

    wrap.appendChild(actions);
    return wrap;
}

function compareNode(msg, index) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant compare';
    wrap.dataset.msg = index;

    const role = document.createElement('p');
    role.className = 'msg-role';
    role.textContent = 'MGPT · compare';
    wrap.appendChild(role);

    const grid = document.createElement('div');
    grid.className = 'compare-grid';

    msg.compare.forEach((col, colIndex) => {
        grid.appendChild(compareColumnNode(msg, index, col, colIndex));
    });

    wrap.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.appendChild(action(ICON.retry, 'Retry all', () => regenerate(index)));
    wrap.appendChild(actions);

    return wrap;
}

function compareColumnNode(msg, index, col, colIndex) {
    const card = document.createElement('div');
    card.className = 'cmp-col' + (col.error ? ' error' : '') + (col.done ? '' : ' is-live');
    card.dataset.col = colIndex;

    const head = document.createElement('div');
    head.className = 'cmp-head';
    const name = document.createElement('span');
    name.className = 'cmp-name';
    name.textContent = col.profile.name;
    const model = document.createElement('span');
    model.className = 'cmp-model';
    model.textContent = col.profile.model;
    head.append(name, model);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'cmp-body md' + (col.done ? '' : ' is-live');
    body.innerHTML = renderMarkdown(col.text);
    card.appendChild(body);

    if (!col.done) return card;   // still streaming (or never finished) — no actions yet

    const acts = document.createElement('div');
    acts.className = 'cmp-actions';

    acts.appendChild(action(ICON.copy, 'Copy', () => {
        navigator.clipboard.writeText(col.text)
            .then(() => toast('Copied.', 'ok'))
            .catch(() => toast('Copy failed.', 'bad'));
    }));
    acts.appendChild(action(ICON.retry, 'Retry', () => retryColumn(index, colIndex)));
    if (!col.error && profileById(col.profile.id)) {
        acts.appendChild(action(ICON.go, 'Continue here', () => continueWith(col.profile.id)));
    }

    card.appendChild(acts);
    return card;
}

function continueWith(profileId) {
    const p = profileById(profileId);
    if (!p) { toast('That profile is gone.', 'bad'); return; }
    state.activeId = p.id;
    saveSettings();
    if (state.compare) toggleCompare(false);
    idleRail();
    toast(`Continuing with ${p.name}.`, 'ok');
}

function action(icon, label, onClick) {
    const button = document.createElement('button');
    button.className = 'act';
    button.type = 'button';
    button.innerHTML = `${icon}${label}`;
    button.addEventListener('click', onClick);
    return button;
}

function scrollToEnd() {
    el.thread.scrollTop = el.thread.scrollHeight;
}

/* ==========================================================================
   Attachments
   ========================================================================== */

const TEXT_CAP = 180_000; // chars; keeps one file from eating the whole context

function readFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));

        if (file.type.startsWith('image/')) {
            reader.onload = () => resolve({ kind: 'image', name: file.name, dataUrl: reader.result });
            reader.readAsDataURL(file);
            return;
        }
        if (/\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(file.name)) {
            reject(new Error(`${file.name} is a binary document. Export it to text or paste the contents.`));
            return;
        }
        reader.onload = () => {
            let text = String(reader.result);
            if (text.length > TEXT_CAP) {
                text = `${text.slice(0, TEXT_CAP)}\n\n[truncated at ${TEXT_CAP.toLocaleString()} characters]`;
            }
            resolve({ kind: 'text', name: file.name, text });
        };
        reader.readAsText(file);
    });
}

async function addFiles(fileList) {
    for (const file of fileList) {
        try {
            state.pending.push(await readFile(file));
        } catch (err) {
            toast(err.message, 'bad');
        }
    }
    renderChips();
}

function renderChips() {
    el.chips.innerHTML = '';
    el.chips.hidden = state.pending.length === 0;

    state.pending.forEach((file, i) => {
        const li = document.createElement('li');
        li.className = 'chip';

        const name = document.createElement('span');
        name.textContent = file.name;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.innerHTML = ICON.x;
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.addEventListener('click', () => {
            state.pending.splice(i, 1);
            renderChips();
        });

        li.append(name, remove);
        el.chips.appendChild(li);
    });
}

/* ==========================================================================
   Request building
   ========================================================================== */

function systemPrompt() {
    const parts = state.instructions
        .filter((f) => f.on && f.body.trim())
        .map((f) => `# ${f.name}\n${f.body.trim()}`);
    return parts.length
        ? parts.join('\n\n')
        : 'You are MGPT, a helpful AI assistant. Be clear, concise and accurate.';
}

function toApiMessage(msg) {
    const files = msg.files || [];
    const texts = files.filter((f) => f.kind === 'text');
    const images = files.filter((f) => f.kind === 'image' && f.dataUrl);

    let text = msg.text;
    for (const f of texts) {
        text += `\n\n--- ${f.name} ---\n${f.text}`;
    }

    if (!images.length) return { role: msg.role, content: text };

    return {
        role: msg.role,
        content: [
            { type: 'text', text },
            ...images.map((f) => ({ type: 'image_url', image_url: { url: f.dataUrl } })),
        ],
    };
}

function buildPayload(messages, profile = activeProfile()) {
    return {
        // Local servers serve whatever is loaded; they just need the field present.
        model: (profile?.model || '').trim() || 'local-model',
        stream: true,
        temperature: 0.7,
        messages: [
            { role: 'system', content: systemPrompt() },
            ...messages.map(toApiMessage),
        ],
    };
}

/* ==========================================================================
   Streaming
   ========================================================================== */

// OpenRouter (and friends) fail mid-stream with an SSE event instead of an
// HTTP status: the chunk carries the error object and finish_reason 'error'.
// Free models hit this constantly — they're capped at 20 req/min, 50/day on
// accounts that haven't purchased credits.
function streamErrorText(e, status) {
    const meta = e?.metadata || {};
    const bits = [e?.message || `Request failed${status ? ` with status ${status}` : ''}`];
    if (meta.provider_code) bits.push(`(provider error ${meta.provider_code})`);
    if (meta.remedy_hint) bits.push(meta.remedy_hint);
    return bits.join(' · ');
}

// Known free-model failure modes on OpenRouter get a concrete next step,
// because the raw API message assumes you know their tier system.
function freeTierHint(status, meta = {}) {
    if (status === 429 || meta.error_type === 'rate_limit_exceeded') {
        return 'Free models are capped at 20 requests/minute and 50 per day until you have bought $10 of credits — the picker shows how many free requests are left today.';
    }
    if (status === 402) {
        return 'Free models still need a non-negative balance. Check your credits at openrouter.ai/settings/credits.';
    }
    if (status === 404) {
        return 'This free pool may be exhausted — try another free model, or the paid variant of the same one.';
    }
    return '';
}

function parseSSE(chunk, onDelta) {
    let done = false;
    for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { done = true; continue; }

        let json;
        try {
            json = JSON.parse(payload);
        } catch {
            /* keep-alive comments and partial frames are expected */
            continue;
        }

        const choice = json.choices?.[0];
        if (json.error || choice?.finish_reason === 'error') {
            const extra = freeTierHint(0, json.error?.metadata || {});
            throw new Error(streamErrorText(json.error, 0) + (extra ? ` ${extra}` : ''));
        }
        if (choice?.delta?.content) onDelta(choice.delta.content);
    }
    return done;
}

function setBusy(busy) {
    el.sendBtn.classList.toggle('is-busy', busy);
    el.sendBtn.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
}

function stopStream() {
    for (const ac of state.aborts) ac.abort();
    state.aborts = [];
}

// The raw streaming loop, shared by single replies and compare columns.
async function streamCompletion({ endpoint, key, payload, signal }, onDelta) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders(key, endpoint),
        body: JSON.stringify(payload),
        signal,
    });

    if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const e = detail.error || {};
        const text = streamErrorText(e, res.status);
        const extra = isOpenRouter(endpoint) ? freeTierHint(res.status, e.metadata || {}) : '';
        throw new Error(text + (extra ? ` ${extra}` : ''));
    }
    if (!res.body) throw new Error('This endpoint returned no response body.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
            if (parseSSE(frame, onDelta)) finished = true;
        }
    }
}

const pinned = () =>
    el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 120;

async function runCompletion(chat) {
    const profile = activeProfile();
    if (!profile) { toast('Add a profile in Settings first.', 'bad'); return; }

    const reply = { role: 'assistant', text: '', profile: snapshot(profile) };
    chat.messages.push(reply);

    const node = messageNode(reply, chat.messages.length - 1);
    const body = node.querySelector('.msg-body');
    el.messages.appendChild(node);
    scrollToEnd();

    const ac = new AbortController();
    state.aborts = [ac];
    setBusy(true);
    rail('Streaming', 'live');

    try {
        await streamCompletion({
            endpoint: profile.endpoint,
            key: profile.apiKey,
            payload: buildPayload(chat.messages.slice(0, -1), profile),
            signal: ac.signal,
        }, (delta) => {
            reply.text += delta;
            body.innerHTML = renderMarkdown(reply.text);
            body.classList.add('is-live');
            if (pinned()) scrollToEnd();
            rail(`Streaming · ${reply.text.length} chars`, 'live');
        });

        if (!reply.text) throw new Error('The model returned an empty response.');
        rail(`Ready · ${profile.name}`);
    } catch (err) {
        if (err.name === 'AbortError') {
            rail('Stopped');
            if (!reply.text) reply.text = '_Stopped._';
        } else {
            reply.error = true;
            // Keep whatever streamed before the failure — don't erase evidence.
            reply.text = reply.text ? `${reply.text}\n\n---\n\n**${err.message}**` : err.message;
            rail('Error', 'bad');
        }
    } finally {
        body.classList.remove('is-live');
        state.aborts = [];
        setBusy(false);
        chat.updatedAt = Date.now();
        saveChats();
        renderThread();
    }
}

/* ==========================================================================
   Sending
   ========================================================================== */

// A profile is answerable when it has a key (hosted) or is local.
function profileProblem(p) {
    const local = isLocalEndpoint(p.endpoint);
    if (!p.apiKey && !local) return 'needs an API key';
    if (!p.model.trim() && !local) return 'needs a model';
    return null;
}

function openSettingsOn(profileId, why) {
    toast(why, 'bad');
    openSettings(profileId);
}

async function send() {
    if (state.aborts.length) { stopStream(); return; }

    const text = el.input.value.trim();
    if (!text && state.pending.length === 0) return;

    const cols = state.compare
        ? state.compareCols
            .map((c) => ({ profile: profileById(c.profileId), model: c.model }))
            .filter((c) => c.profile)
        : [{ profile: activeProfile(), model: '' }];

    if (state.compare && cols.length < 2) {
        toast('Compare needs at least two columns — add another below the composer.', 'bad');
        return;
    }

    for (const c of cols) {
        const problem = profileProblem(c.profile);
        if (problem) {
            openSettingsOn(c.profile.id, `${c.profile.name} ${problem}.`);
            return;
        }
        // A column can override the model — but hosted endpoints always need
        // some model to name in the request.
        if (state.compare && !c.model.trim() && profileProblem({ ...c.profile, model: '' })) {
            openSettingsOn(c.profile.id, `${c.profile.name} needs a model for its column.`);
            return;
        }
    }

    const chat = ensureChat();
    chat.messages.push({ role: 'user', text, files: state.pending });

    if (chat.messages.length === 1) chat.title = titleFrom(text || state.pending[0]?.name || '');

    state.pending = [];
    el.input.value = '';
    autoGrow();
    renderChips();
    renderThread();
    renderSidebar();

    if (state.compare && cols.length >= 2) await runCompare(chat, cols);
    else await runCompletion(chat);
    renderSidebar();
}

async function regenerate(index) {
    const chat = currentChat();
    if (!chat || state.aborts.length) return;

    const msg = chat.messages[index];
    const compareCols = msg?.compare ? msg.compare.map((c) => ({ profileId: c.profile.id, model: c.profile.model })) : null;

    chat.messages.splice(index);
    renderThread();

    if (compareCols) {
        const cols = compareCols
            .map((c) => ({ profile: profileById(c.profileId), model: c.model }))
            .filter((c) => c.profile);
        if (cols.length < 2) { toast('Not enough profiles left to compare.', 'bad'); return; }
        for (const c of cols) {
            const problem = profileProblem(c.profile);
            if (problem) { openSettingsOn(c.profile.id, `${c.profile.name} ${problem}.`); return; }
        }
        await runCompare(chat, cols);
    } else {
        await runCompletion(chat);
    }
}

async function retryColumn(msgIndex, colIndex) {
    const chat = currentChat();
    if (!chat || state.aborts.length) return;

    const msg = chat.messages[msgIndex];
    const col = msg?.compare?.[colIndex];
    if (!col) return;

    const profile = profileById(col.profile.id);
    if (!profile) { toast('That profile is gone — edit it in Settings.', 'bad'); return; }
    const problem = profileProblem(profile);
    if (problem) { openSettingsOn(profile.id, `${profile.name} ${problem}.`); return; }

    // Retry the model the column was answered by, not whatever the profile
    // points at now.
    const model = col.profile.model;
    col.text = '';
    col.error = false;
    col.done = false;
    col.profile = snapshot(profile, model);
    renderThread();

    const card = el.messages.querySelector(`[data-msg="${msgIndex}"] [data-col="${colIndex}"]`);
    const body = card?.querySelector('.cmp-body');
    if (!body) return;

    const ac = new AbortController();
    state.aborts = [ac];
    setBusy(true);
    rail(`Streaming · ${col.profile.name}`, 'live');

    try {
        await streamCompletion({
            endpoint: profile.endpoint,
            key: profile.apiKey,
            payload: buildPayload(chat.messages.slice(0, msgIndex), { ...profile, model }),
            signal: ac.signal,
        }, (delta) => {
            col.text += delta;
            body.innerHTML = renderMarkdown(col.text);
            body.classList.add('is-live');
            if (pinned()) scrollToEnd();
            rail(`Streaming · ${col.text.length} chars`, 'live');
        });

        if (!col.text) throw new Error('The model returned an empty response.');
        rail(`Ready · ${profile.name}`);
    } catch (err) {
        if (err.name === 'AbortError') {
            rail('Stopped');
            if (!col.text) col.text = '_Stopped._';
        } else {
            col.error = true;
            col.text = col.text ? `${col.text}\n\n---\n\n**${err.message}**` : err.message;
            rail('Error', 'bad');
        }
    } finally {
        state.aborts = [];
        setBusy(false);
        chat.updatedAt = Date.now();
        saveChats();
        renderThread();
    }
}

function editFrom(index) {
    const chat = currentChat();
    if (!chat || state.aborts.length) return;

    const msg = chat.messages[index];
    el.input.value = msg.text;
    state.pending = msg.files || [];
    chat.messages.splice(index);

    saveChats();
    renderChips();
    renderThread();
    autoGrow();
    el.input.focus();
}

function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

/* ==========================================================================
   Compare
   ========================================================================== */

function toggleCompare(force) {
    const next = force !== undefined ? force : !state.compare;
    if (next === state.compare) return;
    state.compare = next;
    // Seed the picker once, when compare turns on — never during renders,
    // or removing the last column would bounce straight back.
    if (next && !state.compareCols.length && activeProfile()) {
        state.compareCols = [{ profileId: state.activeId, model: '' }, secondSeed()];
    }
    el.compareBtn.setAttribute('aria-pressed', String(next));
    el.compareBtn.classList.toggle('is-on', next);
    renderCompareCols();
    idleRail();
}

// Column 2 defaults to the same profile with a different model — comparing two
// models of one provider is the most common want, and it needs no second
// profile. If an OpenRouter catalog is cached, prefill its first free model so
// the pair is ready to send.
function secondSeed() {
    const p = activeProfile();
    if (p && isOpenRouter(p.endpoint)) {
        const cached = load(modelsKey(p.id), []);
        const free = Array.isArray(cached) && cached.find((m) => m.free);
        if (free) return { profileId: p.id, model: free.id };
    }
    return { profileId: state.activeId, model: '' };
}

// One row per column: profile select + model input (with suggestions from the
// OpenRouter catalog when the profile has one cached) + a remove button.
function renderCompareCols() {
    el.compareBar.hidden = !state.compare;
    el.compareAdd.disabled = state.compareCols.length >= COMPARE_MAX;
    if (!state.compare) return;

    el.compareCols.innerHTML = '';
    state.compareCols.forEach((col, i) => {
        const row = document.createElement('div');
        row.className = 'compare-col';

        const select = document.createElement('select');
        select.setAttribute('aria-label', `Column ${i + 1} profile`);
        for (const p of state.profiles) {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = p.name;
            if (p.id === col.profileId) option.selected = true;
            select.appendChild(option);
        }
        if (!state.profiles.some((p) => p.id === col.profileId)) {
            const orphan = document.createElement('option');
            orphan.value = col.profileId;
            orphan.textContent = '(deleted profile)';
            orphan.selected = true;
            select.appendChild(orphan);
        }
        select.addEventListener('change', () => {
            col.profileId = select.value;
            col.model = '';
            renderCompareCols();
            idleRail();
        });

        const model = document.createElement('input');
        model.type = 'text';
        model.className = 'compare-model';
        model.placeholder = 'profile model';
        model.value = col.model;
        model.setAttribute('aria-label', `Column ${i + 1} model`);

        const profile = profileById(col.profileId);
        if (profile && isOpenRouter(profile.endpoint)) {
            const cached = load(modelsKey(profile.id), []);
            if (Array.isArray(cached) && cached.length) {
                const list = document.createElement('datalist');
                list.id = `cmp-list-${i}`;
                for (const entry of cached) {
                    const option = document.createElement('option');
                    option.value = entry.id;
                    option.label = entry.free ? 'free' : formatPrice(entry);
                    list.appendChild(option);
                }
                model.setAttribute('list', list.id);
                row.appendChild(list);
            }
        }
        model.addEventListener('input', () => { col.model = model.value; });
        model.addEventListener('change', idleRail);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'col-remove';
        remove.textContent = '\u00D7';
        remove.setAttribute('aria-label', `Remove column ${i + 1}`);
        remove.addEventListener('click', () => {
            state.compareCols.splice(i, 1);
            renderCompareCols();
            idleRail();
        });

        row.append(select, model, remove);
        el.compareCols.appendChild(row);
    });
}

function addCompareColumn() {
    if (state.compareCols.length >= COMPARE_MAX) {
        toast(`At most ${COMPARE_MAX} columns at once.`, 'bad');
        return;
    }
    // A new column starts as the active profile with its own model field —
    // one profile comparing two models needs no second profile.
    const active = activeProfile();
    state.compareCols.push({ profileId: active ? active.id : state.activeId, model: '' });
    renderCompareCols();
    idleRail();
    const last = el.compareCols.lastElementChild?.querySelector('.compare-model');
    if (last) last.focus();
}

// Streams every column at once. Each column has its own AbortController so
// stopStream() can kill them all, and its own error handling so one bad
// column can't take the others' answers with it.
async function runCompare(chat, cols) {
    const bundle = {
        role: 'assistant',
        compare: cols.map((c) => ({
            profile: snapshot(c.profile, c.model), text: '', done: false, error: false,
        })),
    };
    chat.messages.push(bundle);

    // Build the live grid from the same card builder the static render uses,
    // keeping direct references instead of re-querying the DOM.
    const msgIndex = chat.messages.length - 1;
    const node = document.createElement('div');
    node.className = 'msg assistant compare';
    node.dataset.msg = msgIndex;

    const role = document.createElement('p');
    role.className = 'msg-role';
    role.textContent = 'MGPT · compare';

    const grid = document.createElement('div');
    grid.className = 'compare-grid';
    const bodies = bundle.compare.map((col, i) => {
        const card = compareColumnNode(bundle, msgIndex, col, i);
        grid.appendChild(card);
        return card.querySelector('.cmp-body');
    });
    node.append(role, grid);
    el.messages.appendChild(node);
    scrollToEnd();

    state.aborts = cols.map(() => new AbortController());
    setBusy(true);
    rail(`Streaming · 0 of ${cols.length} done`, 'live');

    let doneCount = 0;
    await Promise.all(bundle.compare.map(async (col, i) => {
        const profile = cols[i].profile;
        // An empty override means the profile's own model.
        const model = cols[i].model.trim() || profile.model;
        const ac = state.aborts[i];
        const body = bodies[i];
        const context = chat.messages.slice(0, -1);

        try {
            await streamCompletion({
                endpoint: profile.endpoint,
                key: profile.apiKey,
                payload: buildPayload(context, { ...profile, model }),
                signal: ac.signal,
            }, (delta) => {
                col.text += delta;
                body.innerHTML = renderMarkdown(col.text);
                body.classList.add('is-live');
                if (pinned()) scrollToEnd();
                rail(`Streaming · ${replyChars(bundle)} chars`, 'live');
            });

            if (!col.text) throw new Error('The model returned an empty response.');
        } catch (err) {
            if (err.name === 'AbortError') {
                if (!col.text) col.text = '_Stopped._';
            } else {
                col.error = true;
                col.text = col.text ? `${col.text}\n\n---\n\n**${err.message}**` : err.message;
                body.innerHTML = renderMarkdown(col.text);
            }
        } finally {
            col.done = true;
            doneCount++;
            rail(`Streaming · ${doneCount} of ${cols.length} done`, 'live');
        }
    }));

    state.aborts = [];
    setBusy(false);
    const anyError = bundle.compare.some((c) => c.error);
    rail(anyError ? 'Done · some columns failed' : 'Done · compare');
    chat.updatedAt = Date.now();
    saveChats();
    renderThread();
}

function replyChars(bundle) {
    return bundle.compare.reduce((n, c) => n + c.text.length, 0);
}

/* ==========================================================================
   Settings
   ========================================================================== */

let lastFocused = null;
let editingId = null;       // profile loaded into the form; null = creating
let catalog = [];           // parsed OpenRouter model list
let catalogEndpoint = '';

// Toasts fade after a few seconds, so a failure that re-opens Settings has to
// leave a reason behind on the field it's complaining about.
function resetHints() {
    for (const hint of document.querySelectorAll('.hint')) {
        // innerHTML, not textContent — some hints carry inline <code>.
        if (hint.dataset.default === undefined) hint.dataset.default = hint.innerHTML;
        else hint.innerHTML = hint.dataset.default;
        hint.classList.remove('is-bad');
    }
}

function loadProfileForm(id) {
    editingId = id;
    const p = profileById(id);
    el.profileName.value = p ? p.name : '';
    el.endpointInput.value = p ? p.endpoint : '';
    el.apiKeyInput.value = p ? p.apiKey : '';
    el.modelInput.value = p ? p.model : '';
    loadCatalog();
    renderProfiles();
    renderModelBrowser();
}

function openSettings(profileId) {
    lastFocused = document.activeElement;
    el.modal.hidden = false;
    resetHints();
    renderInstructions();
    loadProfileForm(profileId ?? state.activeId);
    el.endpointInput.focus();
    fetchModels();
    fetchKeyInfo();
}

function closeSettings() {
    modelRequest++;
    el.modal.hidden = true;
    el.instEditor.hidden = true;
    if (lastFocused) lastFocused.focus();
}

function commitSettings() {
    const typed = el.endpointInput.value.trim();
    if (!typed) { toast('An endpoint is required.', 'bad'); return; }

    const endpoint = normalizeEndpoint(typed);
    el.endpointInput.value = endpoint;   // show what it resolved to, don't rewrite silently

    const profile = {
        id: editingId || uid(),
        name: el.profileName.value.trim() || profileNameFromEndpoint(endpoint),
        endpoint,
        apiKey: el.apiKeyInput.value.trim(),
        model: el.modelInput.value.trim(),
    };

    const old = profileById(profile.id);
    if (old) {
        // A changed endpoint invalidates the cached model list.
        if (old.endpoint !== endpoint) localStorage.removeItem(modelsKey(profile.id));
        state.profiles = state.profiles.map((p) => (p.id === profile.id ? profile : p));
    } else {
        state.profiles.push(profile);
    }

    // What you just configured is what answers the next message.
    state.activeId = profile.id;
    if (isOpenRouter(endpoint) && catalogEndpoint === endpoint) {
        localStorage.setItem(modelsKey(profile.id), JSON.stringify(catalog));
    }

    saveProfiles();
    saveSettings();
    closeSettings();
    renderCompareCols();
    idleRail();
    toast(endpoint === typed ? 'Profile saved.' : `Saved as ${endpoint}`, 'ok');
}

function deleteProfile(id) {
    if (state.profiles.length <= 1) { toast('Keep at least one profile.', 'bad'); return; }
    const gone = profileById(id);
    state.profiles = state.profiles.filter((p) => p.id !== id);
    localStorage.removeItem(modelsKey(id));

    if (state.activeId === id) state.activeId = state.profiles[0].id;
    if (editingId === id) loadProfileForm(state.activeId);
    state.compareCols = state.compareCols.filter((c) => c.profileId !== id);

    saveProfiles();
    saveSettings();
    renderProfiles();
    renderCompareCols();
    idleRail();
    toast(`${gone ? gone.name : 'Profile'} deleted.`, 'ok');
}

function renderProfiles() {
    el.profileList.innerHTML = '';

    for (const p of state.profiles) {
        const li = document.createElement('li');
        li.className = 'profile-row'
            + (p.id === state.activeId ? ' is-on' : '')
            + (p.id === editingId ? ' is-edit' : '');

        const open = document.createElement('button');
        open.className = 'profile-open';
        open.type = 'button';
        const name = document.createElement('span');
        name.className = 'p-name';
        name.textContent = p.name;
        const sub = document.createElement('span');
        sub.className = 'p-sub';
        sub.textContent = `${p.model.trim() || 'local'} · ${(() => {
            try { return new URL(normalizeEndpoint(p.endpoint)).hostname; } catch { return p.endpoint; }
        })()}`;
        open.append(name, sub);
        open.addEventListener('click', () => loadProfileForm(p.id));

        const del = document.createElement('button');
        del.className = 'profile-del';
        del.type = 'button';
        del.innerHTML = ICON.trash;
        del.setAttribute('aria-label', `Delete ${p.name}`);
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteProfile(p.id);
        });

        li.append(open, del);
        el.profileList.appendChild(li);
    }
}

function showTab(which) {
    const conn = which === 'conn';
    el.tabConn.hidden = !conn;
    el.tabInst.hidden = conn;
    el.tabBtnConn.classList.toggle('is-on', conn);
    el.tabBtnInst.classList.toggle('is-on', !conn);
    el.tabBtnConn.setAttribute('aria-selected', String(conn));
    el.tabBtnInst.setAttribute('aria-selected', String(!conn));
}

/* ==========================================================================
   Model listing
   ========================================================================== */

let modelRequest = 0;

function loadCatalog() {
    catalog = [];
    catalogEndpoint = '';
    const p = profileById(editingId);
    if (!p || !isOpenRouter(p.endpoint)) return;
    const cached = load(modelsKey(p.id), []);
    if (Array.isArray(cached) && cached.length) {
        catalog = cached;
        catalogEndpoint = p.endpoint;
    }
}

async function fetchModels() {
    const endpoint = normalizeEndpoint(el.endpointInput.value);
    if (!endpoint) { toast('Add an endpoint first.', 'bad'); return; }
    el.endpointInput.value = endpoint;
    const request = ++modelRequest;
    const isCurrent = () => request === modelRequest
        && normalizeEndpoint(el.endpointInput.value) === endpoint;
    el.modelList.replaceChildren();

    el.refreshModels.classList.add('is-spinning');
    el.modelHint.classList.remove('is-bad');
    el.modelHint.textContent = 'Loading models…';

    try {
        const res = await fetch(`${apiBase(endpoint)}/models`, {
            headers: authHeaders(el.apiKeyInput.value.trim(), endpoint),
        });
        if (!res.ok) throw new Error(`Endpoint returned ${res.status}`);

        const json = await res.json();
        if (!isCurrent()) return;
        const models = [...new Map((json.data || json.models || [])
            .filter((m) => m && typeof (m.id || m.name) === 'string' && (m.id || m.name).trim())
            .map((m) => [m.id || m.name, m])).values()]
            .sort((a, b) => (a.id || a.name).localeCompare(b.id || b.name));
        if (!models.length) throw new Error('No models listed');

        for (const model of models) {
            const option = document.createElement('option');
            option.value = model.id || model.name;
            option.label = model.name || option.value;
            el.modelList.appendChild(option);
        }
        if (!el.modelInput.value.trim()) el.modelInput.value = models[0].id || models[0].name;
        el.modelHint.textContent = `${models.length} live model${models.length === 1 ? '' : 's'} available. Choose one or enter a model ID.`;

        // OpenRouter ships pricing and context data the others don't — keep it.
        if (isOpenRouter(endpoint)) {
            catalog = parseCatalog(json);
            catalogEndpoint = endpoint;
            renderModelBrowser();
            fetchKeyInfo();
        }
    } catch (err) {
        if (!isCurrent()) return;
        el.modelHint.classList.add('is-bad');
        el.modelHint.textContent = `Couldn't load the list (${err.message}). Type the model name instead.`;
    } finally {
        if (request === modelRequest) el.refreshModels.classList.remove('is-spinning');
    }
}

function renderModelBrowser() {
    const open = isOpenRouter(normalizeEndpoint(el.endpointInput.value));
    el.modelBrowser.hidden = !open;
    if (!open) return;

    const fresh = catalogEndpoint === normalizeEndpoint(el.endpointInput.value);
    const rows = filterCatalog(fresh ? catalog : [], el.modelSearch.value, el.freeOnly.checked);

    el.modelRows.innerHTML = '';
    for (const m of rows) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'model-row' + (m.free ? ' is-free' : '');
        button.dataset.model = m.id;

        const main = document.createElement('span');
        main.className = 'm-name';
        main.textContent = m.name;
        const id = document.createElement('span');
        id.className = 'm-id';
        id.textContent = m.id;
        const tags = document.createElement('span');
        tags.className = 'm-tags';
        const ctx = formatContext(m.ctx);
        const price = formatPrice(m);
        if (ctx) {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = ctx;
            tags.appendChild(tag);
        }
        if (price) {
            const tag = document.createElement('span');
            tag.className = 'tag' + (m.free ? ' is-free' : '');
            tag.textContent = price;
            tags.appendChild(tag);
        }

        button.append(main, id, tags);
        button.addEventListener('click', () => {
            el.modelInput.value = m.id;
            el.modelHint.textContent = `${m.name} — sends exact ID ${m.id}.`;
            el.modelInput.focus();
        });
        li.appendChild(button);
        el.modelRows.appendChild(li);
    }

    el.browserHint.textContent = fresh
        ? (rows.length === catalog.length
            ? `${catalog.length} models from the live OpenRouter catalog.`
            : `${rows.length} of ${catalog.length} models match.`)
        : 'Press the refresh button to load the OpenRouter catalog.';
}

// GET /api/v1/key reports the free-model quota for this key — the number that
// decides whether free models answer at all today.
let keyInfo = null;
let keyInfoRequest = 0;

async function fetchKeyInfo() {
    keyInfo = null;
    const endpoint = normalizeEndpoint(el.endpointInput.value);
    const request = ++keyInfoRequest;
    const isCurrent = () => request === keyInfoRequest
        && normalizeEndpoint(el.endpointInput.value) === endpoint;
    const key = el.apiKeyInput.value.trim();

    if (isOpenRouter(endpoint) && key) {
        try {
            const res = await fetch(`${apiBase(endpoint)}/key`, {
                headers: authHeaders(key, endpoint),
            });
            if (res.ok) {
                const json = await res.json();
                if (isCurrent()) keyInfo = json.data || null;
            }
        } catch { /* quota display is optional; never block the picker on it */ }
    }
    if (isCurrent()) renderKeyInfo();
}

function renderKeyInfo() {
    const open = isOpenRouter(normalizeEndpoint(el.endpointInput.value));
    el.keyInfo.hidden = !open;
    if (!open) return;

    if (!el.apiKeyInput.value.trim()) {
        el.keyInfo.textContent = 'Free models don\'t strictly need a key, but one is required to send.';
        return;
    }
    const fm = keyInfo?.free_model_daily_requests;
    if (!fm) {
        el.keyInfo.textContent = keyInfo === null
            ? 'Free-model quota appears here when your key is checked.'
            : 'Your key doesn\'t report a free-model quota.';
        return;
    }
    const tier = keyInfo.is_free_tier === false ? 'paid tier' : 'free tier';
    el.keyInfo.textContent = fm.remaining > 0
        ? `Free models: ${fm.remaining} of ${fm.limit} requests left today (${tier}).`
        : `Free models: 0 of ${fm.limit} requests left today — the daily cap is reached (${tier}). Try a paid model or wait for tomorrow (UTC reset).`;
}

/* ==========================================================================
   Instruction files
   ========================================================================== */

function renderInstructions() {
    el.instList.innerHTML = '';
    el.instEmpty.hidden = state.instructions.length > 0;

    for (const file of state.instructions) {
        const li = document.createElement('li');
        li.className = 'inst-row' + (file.on ? '' : ' is-off');

        const meta = document.createElement('div');
        meta.className = 'inst-meta';
        meta.innerHTML =
            `<p class="inst-name"></p><p class="inst-size">${file.body.length.toLocaleString()} characters</p>`;
        meta.querySelector('.inst-name').textContent = file.name;
        meta.style.cursor = 'pointer';
        meta.addEventListener('click', () => editInstruction(file));

        const toggle = document.createElement('label');
        toggle.className = 'switch';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = file.on;
        box.setAttribute('aria-label', `Enable ${file.name}`);
        box.addEventListener('change', () => {
            file.on = box.checked;
            saveInstructions();
            renderInstructions();
        });
        toggle.append(box, document.createElement('span'));

        const del = document.createElement('button');
        del.className = 'inst-del';
        del.type = 'button';
        del.innerHTML = ICON.trash;
        del.setAttribute('aria-label', `Delete ${file.name}`);
        del.addEventListener('click', () => {
            state.instructions = state.instructions.filter((f) => f.id !== file.id);
            saveInstructions();
            renderInstructions();
        });

        li.append(meta, toggle, del);
        el.instList.appendChild(li);
    }
}

let editingInstId = null;

function editInstruction(file) {
    editingInstId = file ? file.id : null;
    el.instName.value = file ? file.name : '';
    el.instBody.value = file ? file.body : '';
    el.instEditor.hidden = false;
    el.instName.focus();
}

function saveInstruction() {
    const name = el.instName.value.trim() || 'instructions.md';
    const body = el.instBody.value;
    if (!body.trim()) { toast('The file is empty.', 'bad'); return; }

    const existing = state.instructions.find((f) => f.id === editingInstId);
    if (existing) {
        existing.name = name;
        existing.body = body;
    } else {
        state.instructions.push({ id: uid(), name, body, on: true });
    }

    saveInstructions();
    el.instEditor.hidden = true;
    editingInstId = null;
    renderInstructions();
    toast('Instruction file saved.', 'ok');
}

async function addInstructionFiles(fileList) {
    for (const file of fileList) {
        try {
            const read = await readFile(file);
            if (read.kind !== 'text') { toast(`${file.name} is not a text file.`, 'bad'); continue; }
            state.instructions.push({ id: uid(), name: file.name, body: read.text, on: true });
        } catch (err) {
            toast(err.message, 'bad');
        }
    }
    saveInstructions();
    renderInstructions();
}

/* ==========================================================================
   Sidebar (mobile)
   ========================================================================== */

// Desktop: the sidebar collapses to nothing and the choice sticks.
// Mobile keeps the slide-over instead — CSS neutralises .is-collapsed there.
function setNavCollapsed(on) {
    el.app.classList.toggle('is-collapsed', on);
    el.navHide.setAttribute('aria-expanded', String(!on));
    el.navShow.setAttribute('aria-expanded', String(!on));
    localStorage.setItem(KEYS.nav, on ? '1' : '0');
}

function openSidebar() {
    el.sidebar.classList.add('is-open');
    el.scrim.hidden = false;
    el.menuBtn.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
    el.sidebar.classList.remove('is-open');
    el.scrim.hidden = true;
    el.menuBtn.setAttribute('aria-expanded', 'false');
}

/* ==========================================================================
   Wiring
   ========================================================================== */

function wire() {
    el.newChatBtn.addEventListener('click', newChat);
    el.newChatBtnMobile.addEventListener('click', newChat);
    el.menuBtn.addEventListener('click', openSidebar);
    el.scrim.addEventListener('click', closeSidebar);
    el.navHide.addEventListener('click', () => setNavCollapsed(true));
    el.navShow.addEventListener('click', () => setNavCollapsed(false));

    // Chat search
    el.chatSearch.addEventListener('input', () => {
        state.searchQuery = el.chatSearch.value;
        renderSidebar();
    });

    el.settingsBtn.addEventListener('click', () => { closeSidebar(); openSettings(); });
    el.modelButton.addEventListener('click', () => {
        openSettings();
        showTab('conn');
        el.modelInput.focus();
    });
    el.closeModal.addEventListener('click', closeSettings);
    el.cancelBtn.addEventListener('click', closeSettings);
    el.saveBtn.addEventListener('click', commitSettings);
    // Backdrop click closes — but only when the press also started on the
    // backdrop. Otherwise drag-selecting text out of a field (mouse released
    // on the frame around the sheet) fires a click with the backdrop as
    // target and slams the dialog shut mid-edit.
    let backdropPress = false;
    el.modal.addEventListener('mousedown', (e) => { backdropPress = e.target === el.modal; });
    el.modal.addEventListener('click', (e) => {
        if (e.target === el.modal && backdropPress) closeSettings();
    });

    el.tabBtnConn.addEventListener('click', () => showTab('conn'));
    el.tabBtnInst.addEventListener('click', () => showTab('inst'));

    el.toggleApiKey.addEventListener('click', () => {
        const shown = el.apiKeyInput.type === 'text';
        el.apiKeyInput.type = shown ? 'password' : 'text';
        el.toggleApiKey.setAttribute('aria-label', shown ? 'Show API key' : 'Hide API key');
    });
    // 'change' (blur), not 'input' — the key gets checked, not every keystroke.
    el.apiKeyInput.addEventListener('change', fetchKeyInfo);

    el.addProfile.addEventListener('click', () => {
        editingId = null;
        el.profileName.value = '';
        el.endpointInput.value = '';
        el.apiKeyInput.value = '';
        el.modelInput.value = '';
        modelRequest++;
        el.modelList.replaceChildren();
        el.refreshModels.classList.remove('is-spinning');
        catalog = [];
        catalogEndpoint = '';
        keyInfo = null;
        renderProfiles();
        renderModelBrowser();
        renderKeyInfo();
        el.modelHint.textContent = 'Pick a preset or type an endpoint, then save.';
        el.endpointInput.focus();
    });

    el.refreshModels.addEventListener('click', fetchModels);
    el.endpointInput.addEventListener('input', () => {
        modelRequest++;
        el.modelList.replaceChildren();
        el.refreshModels.classList.remove('is-spinning');
        renderModelBrowser();
        el.modelHint.textContent = 'Refresh to load models from this endpoint, or enter a model ID.';
    });

    el.modelSearch.addEventListener('input', renderModelBrowser);
    el.freeOnly.addEventListener('change', renderModelBrowser);

    el.presets.addEventListener('click', (e) => {
        const button = e.target.closest('.preset');
        if (!button) return;
        el.endpointInput.value = button.dataset.endpoint;
        // Clear the old model — a name from the previous provider would survive
        // the switch and shadow whatever the new endpoint actually offers.
        el.modelInput.value = button.dataset.model || '';
        if (!el.profileName.value.trim()) el.profileName.value = button.textContent.trim();
        renderModelBrowser();
        fetchModels();
    });

    el.compareBtn.addEventListener('click', () => toggleCompare());
    el.compareAdd.addEventListener('click', addCompareColumn);

    el.addInstFile.addEventListener('click', () => el.instFileInput.click());
    el.addInstWrite.addEventListener('click', () => editInstruction(null));
    el.instFileInput.addEventListener('change', async (e) => {
        await addInstructionFiles(e.target.files);
        e.target.value = '';
    });
    el.instSave.addEventListener('click', saveInstruction);
    el.instCancel.addEventListener('click', () => { el.instEditor.hidden = true; editingInstId = null; });

    el.sendBtn.addEventListener('click', send);
    el.attachBtn.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', async (e) => {
        await addFiles(e.target.files);
        e.target.value = '';
    });

    el.input.addEventListener('input', autoGrow);
    el.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    el.starters.addEventListener('click', (e) => {
        const button = e.target.closest('.starter');
        if (!button) return;
        el.input.value = button.dataset.prompt;
        autoGrow();
        el.input.focus();
    });

    // Drag and drop onto the composer
    ['dragover', 'drop'].forEach((type) => {
        el.composer.addEventListener(type, (e) => {
            e.preventDefault();
            if (type === 'drop') addFiles(e.dataTransfer.files);
        });
    });

    // Copy buttons inside rendered code blocks
    el.messages.addEventListener('click', (e) => {
        const button = e.target.closest('.js-copy-code');
        if (!button) return;
        const code = button.closest('.code-block').querySelector('code').textContent;
        navigator.clipboard.writeText(code)
            .then(() => toast('Code copied.', 'ok'))
            .catch(() => toast('Copy failed.', 'bad'));
    });

    document.addEventListener('keydown', (e) => {
        const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')
            || document.activeElement?.isContentEditable;

        // "/" or Ctrl/Cmd+K jumps to chat search — the fast path to old answers.
        if (el.modal.hidden && !typing
            && (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) {
            e.preventDefault();
            if (el.app.classList.contains('is-collapsed')) setNavCollapsed(false);
            el.chatSearch.focus();
            el.chatSearch.select();
            return;
        }

        if (e.key !== 'Escape') return;

        // Esc acts on the focused field first: a search box clears, and the
        // dialog never closes out from under a field that still holds content.
        // (The keydown bubbles up after a native search-clear, so without this
        // a reflexive Esc while searching slammed Settings shut mid-edit.)
        const field = document.activeElement;
        const isField = /^(input|textarea|select)$/i.test(field?.tagName || '');
        if (field?.type === 'search' && field.value) {
            field.value = '';
            if (field === el.chatSearch) { state.searchQuery = ''; renderSidebar(); }
            else renderModelBrowser();
            return;
        }
        if (!el.modal.hidden && isField && field.value) return;

        if (!el.modal.hidden) closeSettings();
        else if (el.sidebar.classList.contains('is-open')) closeSidebar();
        else if (state.aborts.length) stopStream();
    });

    // Keep focus inside the settings sheet.
    el.modal.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const focusable = [...el.modal.querySelectorAll(
            'button, input, textarea, [href], [tabindex]:not([tabindex="-1"])')]
            .filter((node) => node.offsetParent !== null);
        if (!focusable.length) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
}

// The composer is overlaid on the thread so text frosts as it scrolls under
// the glass. That means the thread needs bottom padding equal to whatever the
// composer currently measures — it grows with the textarea and attachments.
function trackComposerHeight() {
    if (typeof ResizeObserver !== 'function') return;
    new ResizeObserver(([entry]) => {
        document.documentElement.style.setProperty('--composer-h', `${entry.contentRect.height}px`);
    }).observe(el.composerWrap);
}

function init() {
    loadAll();
    wire();
    trackComposerHeight();
    setNavCollapsed(localStorage.getItem(KEYS.nav) === '1');
    renderSidebar();
    renderThread();
    renderChips();
    autoGrow();
    renderCompareCols();
    idleRail();
}

document.addEventListener('DOMContentLoaded', init);

/* ==========================================================================
   Self-check — run __mgptSelfTest() in the console.
   Covers the things that silently break: markdown escaping, SSE parsing,
   endpoint normalization, and the V2 helpers.
   ========================================================================== */

window.__mgptSelfTest = function () {
    const ok = (cond, label) => { if (!cond) throw new Error(`FAIL: ${label}`); };

    // Model output can never inject markup.
    const evil = renderMarkdown('<img src=x onerror=alert(1)>');
    ok(!evil.includes('<img'), 'raw HTML is escaped');
    ok(evil.includes('&lt;img'), 'raw HTML survives as text');

    // Markdown inside a fence stays literal, and the fence is escaped too.
    const fenced = renderMarkdown('```js\nconst a = "<b>" && 1 < 2;\n```');
    ok(fenced.includes('code-block'), 'fence becomes a code block');
    ok(fenced.includes('&lt;b&gt;'), 'fence contents are escaped');
    ok(!fenced.includes('<strong>'), 'no inline markdown inside a fence');

    // Inline formatting still works on ordinary prose.
    const prose = renderMarkdown('**bold** and `code` and [link](https://a.co)');
    ok(prose.includes('<strong>bold</strong>'), 'bold renders');
    ok(prose.includes('<code>code</code>'), 'inline code renders');
    ok(prose.includes('href="https://a.co"'), 'safe link renders');

    // javascript: URLs are refused.
    ok(!renderMarkdown('[x](javascript:alert(1))').includes('href'), 'unsafe scheme rejected');

    // SSE frames accumulate; [DONE] terminates.
    let acc = '';
    parseSSE('data: {"choices":[{"delta":{"content":"He"}}]}', (d) => { acc += d; });
    parseSSE('data: {"choices":[{"delta":{"content":"llo"}}]}', (d) => { acc += d; });
    ok(acc === 'Hello', 'deltas accumulate');
    ok(parseSSE('data: [DONE]', () => {}) === true, '[DONE] ends the stream');
    ok(parseSSE('data: {broken', () => {}) === false, 'partial frames do not throw');

    // Local endpoints skip the auth requirement.
    ok(isLocalEndpoint('http://localhost:11434/v1/chat/completions'), 'localhost detected');
    ok(!isLocalEndpoint('https://api.openai.com/v1/chat/completions'), 'remote not local');
    ok(apiBase('https://a.co/v1/chat/completions') === 'https://a.co/v1', 'models URL derived');

    // OpenRouter detection drives the rich model browser.
    ok(isOpenRouter('https://openrouter.ai/api/v1/chat/completions'), 'openrouter detected');
    ok(!isOpenRouter('https://openrouter.example.com/v1/chat/completions'), 'lookalike rejected');

    // Endpoint normalization — the logic that broke local models.
    const CHAT = '/v1/chat/completions';
    const norm = [
        ['localhost:8080',                     `http://localhost:8080${CHAT}`],
        ['http://localhost:8080/',             `http://localhost:8080${CHAT}`],
        ['http://localhost:8080',              `http://localhost:8080${CHAT}`],
        ['http://localhost:8080/v1',           `http://localhost:8080${CHAT}`],
        ['http://localhost:8080/v1/',          `http://localhost:8080${CHAT}`],
        ['127.0.0.1:1234',                     `http://127.0.0.1:1234${CHAT}`],
        ['api.openai.com',                     `https://api.openai.com${CHAT}`],
        [`http://localhost:8080${CHAT}`,       `http://localhost:8080${CHAT}`],
        [`https://api.deepseek.com${CHAT}`,    `https://api.deepseek.com${CHAT}`],
    ];
    for (const [input, want] of norm) {
        const got = normalizeEndpoint(input);
        ok(got === want, `normalize ${input} -> ${want} (got ${got})`);
    }

    // The bug itself: a scheme-less local host must not read as remote.
    ok(isLocalEndpoint(normalizeEndpoint('localhost:8080')), 'bare localhost is local');
    ok(!isLocalEndpoint(normalizeEndpoint('api.openai.com')), 'bare remote host is remote');
    ok(apiBase(normalizeEndpoint('localhost:8080')) === 'http://localhost:8080/v1',
        'models URL for a bare local host');

    // Catalog formatting.
    ok(formatContext(128000) === '128K ctx', 'context in K');
    ok(formatContext(1000000) === '1M ctx', 'context in M');
    ok(formatContext(0) === '', 'no context shows nothing');
    ok(formatUsdPerM(0.00000025) === '$0.25', 'price per million');
    ok(formatUsdPerM(0.0000015) === '$1.5', 'fractional price');
    ok(formatUsdPerM(0.00007) === '$70', 'large price rounds');

    // Catalog parsing: free means both prices are exactly zero; -1 is unknown.
    const cat = parseCatalog({ data: [
        { id: 'a/free', name: 'Free One', context_length: 32000,
          pricing: { prompt: '0', completion: '0' } },
        { id: 'b/paid', name: 'Paid One', context_length: 2000000,
          pricing: { prompt: '0.0000003', completion: '0.0000012' } },
        { id: 'c/weird', name: 'Weird One', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'd/bare', name: 'Bare One' },
        { id: 'a/free', name: 'Free One dup' },
        { id: '', name: '' },
    ] });
    ok(cat.length === 4, 'empty ids and duplicates dropped');
    ok(cat.find((m) => m.id === 'a/free').free === true, 'zero-zero is free');
    ok(cat.find((m) => m.id === 'b/paid').free === false, 'priced model is not free');
    ok(cat.find((m) => m.id === 'c/weird').pin === null, '-1 pricing is unknown');
    ok(cat.find((m) => m.id === 'd/bare').free === false, 'missing pricing is not free');
    ok(cat[0].id === 'a/free', 'catalog sorted by id');
    ok(formatPrice(cat.find((m) => m.id === 'a/free')) === 'Free', 'free label');
    ok(formatPrice(cat.find((m) => m.id === 'b/paid')) === '$0.3 / $1.2', 'price label');
    ok(formatPrice(cat.find((m) => m.id === 'd/bare')) === '', 'no pricing shows nothing');

    // Catalog filtering.
    ok(filterCatalog(cat, 'free', false).map((m) => m.id).join() === 'a/free', 'query matches id and name');
    ok(filterCatalog(cat, 'one', false).length === 4, 'query matches display name');
    ok(filterCatalog(cat, '', true).map((m) => m.id).join() === 'a/free', 'free-only toggle');

    // Chat search — pure, so it runs against fake data.
    const fakeChats = [
        { title: 'K8s deployment woes', messages: [{ text: 'my pod keeps crashing' }] },
        { title: 'Dinner plans', messages: [{ text: 'what about K8s sushi' }, { text: 'nope' }] },
        { title: 'Empty', messages: [] },
    ];
    ok(searchChats(fakeChats, 'k8s').length === 2, 'search hits title and body');
    ok(searchChats(fakeChats, 'K8S').length === 2, 'search is case-insensitive');
    ok(searchChats(fakeChats, '  ').length === 3, 'blank query returns everything');
    ok(searchChats(fakeChats, 'zzz').length === 0, 'no match is empty');
    ok(searchChats(fakeChats, 'crashing')[0].snippet === 'my pod keeps crashing', 'snippet comes from the hit message');

    // Compare snapshots: a column override pins the model, '' falls back to
    // the profile's own — and the key is never snapshotted.
    const cmpProfile = { id: 'p1', name: 'OR', endpoint: 'https://x.co/v1', apiKey: 'sekrit', model: ' base ' };
    ok(snapshot(cmpProfile).model === 'base', 'snapshot trims the profile model');
    ok(snapshot(cmpProfile, 'vendor/a:free').model === 'vendor/a:free', 'override pins the model');
    ok(snapshot(cmpProfile, '  ').model === 'base', 'blank override falls back');
    ok(!('apiKey' in snapshot(cmpProfile, 'vendor/a:free')), 'no key in snapshots');

    // Mid-stream failures are errors, not silent empty streams — the failure
    // mode free models hit through OpenRouter's rate limits.
    let threw = false;
    try {
        parseSSE('data: {"choices":[{"delta":{"content":""},"finish_reason":"error"}],' +
            '"error":{"code":429,"message":"Rate limit exceeded",' +
            '"metadata":{"error_type":"rate_limit_exceeded"}}}', () => {});
    } catch { threw = true; }
    ok(threw, 'mid-stream error events throw');
    ok(streamErrorText({ message: 'm', metadata: { remedy_hint: 'r' } }, 401) === 'm · r',
        'error text carries the remedy hint');
    ok(freeTierHint(429).includes('50 per day'), '429 explains the free-tier cap');
    ok(freeTierHint(404).includes('free pool'), '404 points at the free pool');
    ok(freeTierHint(401) === '', 'ordinary errors get no free-tier advice');

    console.log('%c✓ all checks passed', 'color:#FFB454');
    return true;
};
