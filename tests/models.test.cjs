const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A mock DOM node loose enough for the app's building blocks: classList
// no-ops, children get collected, querySelector returns a usable fake.
function node() {
    const n = {
        value: '', checked: false, textContent: '', innerHTML: '', children: [],
        hidden: true, dataset: {}, style: {}, title: '', className: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild(child) { this.children.push(child); },
        append(...kids) { this.children.push(...kids); },
        replaceChildren(...children) { this.children = children; },
        setAttribute() {}, addEventListener() {}, focus() {}, select() {},
        querySelector: () => node(),
        querySelectorAll: () => [],
    };
    return n;
}

function app(saved = {}) {
    const nodes = new Map();
    const writes = new Map();
    const context = vm.createContext({
        URL, AbortController, TextEncoder, TextDecoder, console,
        setTimeout: (fn) => 0, clearTimeout: () => {},
        window: {},
        document: {
            getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
            querySelector: node, createElement: node,
            createTextNode: () => node(), createDocumentFragment: node,
            querySelectorAll: () => [], addEventListener() {},
        },
        localStorage: {
            getItem(key) { return saved[key] ?? null; },
            setItem(key, value) { writes.set(key, value); },
            removeItem(key) { writes.delete(key); },
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8'), context);
    return { context, nodes, writes, run: (code) => vm.runInContext(code, context) };
}

// An SSE response whose body yields the given frames one chunk at a time.
function sseResponse(frames) {
    const chunks = frames.map((f) => new TextEncoder().encode(f));
    let i = 0;
    return {
        ok: true,
        json: async () => ({}),
        body: {
            getReader: () => ({
                read: async () => (i < chunks.length
                    ? { done: false, value: chunks[i++] }
                    : { done: true, value: undefined }),
            }),
        },
    };
}

const CHAT = '/v1/chat/completions';

function settingsOf(obj) {
    return { mertgpt_settings: JSON.stringify(obj) };
}

/* =====================================================================
   Profiles + migration
   ===================================================================== */

test('legacy settings migrate into one profile, with the DeepSeek model upgrade', () => {
    for (const [endpoint, model, expected] of [
        ['https://api.deepseek.com/v1/chat/completions', 'deepseek-chat', 'deepseek-flash'],
        ['https://api.deepseek.com/v1/chat/completions', 'deepseek-reasoner', 'deepseek-flash'],
        ['http://localhost:1234/v1/chat/completions', 'deepseek-chat', 'deepseek-chat'],
        ['https://custom.example/v1/chat/completions', 'deepseek-chat', 'deepseek-chat'],
        ['https://api.deepseek.com.example/v1/chat/completions', 'deepseek-chat', 'deepseek-chat'],
        ['http://[', 'deepseek-chat', 'deepseek-chat'],
        ['https://api.deepseek.com/v1/chat/completions', 'custom-model', 'custom-model'],
    ]) {
        const a = app(settingsOf({ endpoint, model }));
        a.run('loadAll()');
        assert.equal(a.run('state.profiles.length'), 1, 'one profile from legacy settings');
        assert.equal(a.run('buildPayload([]).model'), expected);
    }
});

test('nothing saved creates the default DeepSeek profile, active and ready', () => {
    const a = app();
    a.run('loadAll()');
    assert.equal(a.run('state.profiles.length'), 1);
    assert.equal(a.run('state.profiles[0].endpoint'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(a.run('state.profiles[0].name'), 'DeepSeek');
    assert.equal(a.run('profileById(state.activeId).id'), a.run('state.profiles[0].id'));
});

test('saved profiles load as-is and the active id is repaired when stale', () => {
    const a = app({
        mertgpt_settings: JSON.stringify({ activeId: 'p2' }),
        mertgpt_profiles: JSON.stringify([
            { id: 'p1', name: 'Local', endpoint: `http://localhost:8080${CHAT}`, apiKey: '', model: 'whatever' },
            { id: 'p2', name: 'OpenRouter', endpoint: `https://openrouter.ai${CHAT}`, apiKey: 'k', model: 'a/b' },
        ]),
    });
    a.run('loadAll()');
    assert.equal(a.run('activeProfile().name'), 'OpenRouter');
    a.run('state.activeId = "gone"');
    assert.equal(a.run('activeProfile()'), null, 'stale id deactivates safely');

    // buildPayload falls back to the active profile; an explicit profile wins.
    const a2 = app({});
    a2.run('loadAll()');
    const explicit = { name: 'X', endpoint: `https://x.example${CHAT}`, apiKey: '', model: 'explicit-model' };
    assert.equal(a2.run(`buildPayload([], ${JSON.stringify(explicit)}).model`), 'explicit-model');
});

test('profileNameFromEndpoint maps known hosts to friendly names', () => {
    const a = app();
    assert.equal(a.run('profileNameFromEndpoint("https://openrouter.ai/api/v1/chat/completions")'), 'OpenRouter');
    assert.equal(a.run('profileNameFromEndpoint("http://localhost:11434/v1/chat/completions")'), 'Ollama');
    assert.equal(a.run('profileNameFromEndpoint("http://localhost:1234/v1/chat/completions")'), 'LM Studio');
    assert.equal(a.run('profileNameFromEndpoint("https://api.mistral.ai/v1/chat/completions")'), 'Mistral');
    assert.equal(a.run('profileNameFromEndpoint("https://my-host.example/v1/chat/completions")'), 'my-host.example');
    assert.equal(a.run('profileNameFromEndpoint("not a url")'), 'Custom');
});

/* =====================================================================
   OpenRouter model catalog
   ===================================================================== */

const OPENROUTER_JSON = { data: [
    { id: 'vendor/freebie', name: 'Freebie Chat', context_length: 64000,
      pricing: { prompt: '0', completion: '0' } },
    { id: 'vendor/premium', name: 'Premium Chat', context_length: 256000,
      pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: 'vendor/unknown', name: 'Unknown Price', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'vendor/plain', name: 'Plain Chat' },
    { id: 'vendor/premium', name: 'Premium Chat' },
] };

test('live model picker shows provider display names but submits exact IDs', async () => {
    const a = app();
    a.nodes.get('apiEndpoint').value = 'https://openrouter.ai/api/v1/chat/completions';
    a.context.fetch = async () => ({ ok: true, json: async () => ({ data: [
        { id: 'provider/zeta', name: 'Zeta Chat' },
        { id: 'provider/alpha', name: 'Alpha Chat' },
        { id: 'provider/alpha', name: 'Alpha Chat' },
        { id: '', name: '' },
    ] }) });
    await a.run('fetchModels()');
    const options = a.nodes.get('modelList').children;
    assert.deepEqual(options.map((o) => [o.value, o.label]), [
        ['provider/alpha', 'Alpha Chat'], ['provider/zeta', 'Zeta Chat'],
    ]);
    assert.equal(a.nodes.get('modelSelect').value, 'provider/alpha');
});

test('OpenRouter catalog is parsed, cached per profile, and filterable', async () => {
    const a = app(settingsOf({}));
    a.run('loadAll()');
    a.run(`state.profiles[0].endpoint = "https://openrouter.ai${CHAT}"`);
    a.run('editingId = state.profiles[0].id');
    // fetchModels reads the form, so the field is what matters here.
    a.nodes.get('apiEndpoint').value = `https://openrouter.ai${CHAT}`;
    a.nodes.get('apiKey').value = 'or-key';
    a.context.fetch = async () => ({ ok: true, json: async () => OPENROUTER_JSON });

    await a.run('fetchModels()');

    const catalog = a.run('catalog');
    assert.equal(catalog.length, 4, 'duplicates and blanks dropped, first entry wins');
    assert.equal(a.run('catalog.find(m => m.id === "vendor/freebie").free'), true);
    assert.equal(a.run('catalog.find(m => m.id === "vendor/premium").free'), false);
    assert.equal(a.run('catalog.find(m => m.id === "vendor/unknown").pin'), null, '-1 is unknown, not free');
    assert.equal(a.run('catalog.find(m => m.id === "vendor/plain").free'), false, 'missing pricing is not free');
    // vm arrays carry a different prototype than host arrays — copy them across
    // the boundary before deep-comparing.
    const vmList = (code) => Array.from(a.run(code));
    assert.deepEqual(vmList('filterCatalog(catalog, "freebie", false).map(m => m.id)'), ['vendor/freebie']);
    assert.deepEqual(vmList('filterCatalog(catalog, "", true).map(m => m.id)'), ['vendor/freebie']);
    assert.equal(a.run('filterCatalog(catalog, "zzz", false).length'), 0);
    assert.equal(a.run('formatContext(64000)'), '64K ctx');
    assert.equal(a.run('formatContext(256000)'), '256K ctx');
    assert.equal(a.run('formatPrice(catalog.find(m => m.id === "vendor/premium"))'), '$2.5 / $10');
    assert.equal(a.run('formatPrice(catalog.find(m => m.id === "vendor/freebie"))'), 'Free');
    assert.equal(a.run('formatPrice(catalog.find(m => m.id === "vendor/plain"))'), '');
    assert.equal(a.run('isOpenRouter("https://openrouter.ai/api/v1/chat/completions")'), true);
    assert.equal(a.run('isOpenRouter("https://evil-openrouter.ai/api/v1/chat/completions")'), false);

    // Saving the profile caches the catalog under the profile's own key.
    a.nodes.get('profileName').value = 'OpenRouter';
    a.nodes.get('modelSelect').value = 'vendor/freebie';
    a.run('commitSettings()');
    const savedProfiles = JSON.parse(a.writes.get('mertgpt_profiles'));
    assert.equal(savedProfiles.length, 1);
    assert.equal(savedProfiles[0].name, 'OpenRouter');
    assert.equal(savedProfiles[0].model, 'vendor/freebie');
    const cache = JSON.parse(a.writes.get(`mertgpt_models_${savedProfiles[0].id}`));
    assert.equal(cache.length, 4);
    assert.equal(cache.find((m) => m.id === 'vendor/freebie').free, true);
});

test('a late model response cannot replace the next provider list', async () => {
    const a = app();
    a.nodes.get('apiEndpoint').value = 'https://old.example/v1/chat/completions';
    let release;
    a.context.fetch = () => new Promise((resolve) => { release = resolve; });
    const pending = a.run('fetchModels()');
    a.nodes.get('apiEndpoint').value = 'http://localhost:1234/v1/chat/completions';
    release({ ok: true, json: async () => ({ data: [{ id: 'wrong-provider' }] }) });
    await pending;
    assert.equal(a.nodes.get('modelList').children.length, 0);
    assert.equal(a.nodes.get('modelSelect').value, '');
});

/* =====================================================================
   Chat search
   ===================================================================== */

test('searchChats matches titles and bodies, case-insensitively', () => {
    const a = app();
    a.run(`state.chats = [
        { id: '1', title: 'K8s deployment woes', messages: [{ text: 'my pod keeps crashing' }] },
        { id: '2', title: 'Dinner plans', messages: [{ text: 'what about K8s sushi' }, { text: 'more K8s talk' }] },
        { id: '3', title: 'Empty', messages: [] },
    ]`);

    const ids = (q) => Array.from(a.run(`searchChats(state.chats, ${JSON.stringify(q)}).map(r => r.chat.id)`));
    assert.deepEqual(ids('k8s'), ['1', '2'], 'title and body both hit');
    assert.deepEqual(ids('CRASHING'), ['1'], 'case does not matter');
    assert.deepEqual(ids('dinner'), ['2'], 'title-only match');
    assert.deepEqual(ids('  '), ['1', '2', '3'], 'blank query lists everything');
    assert.deepEqual(ids('zzz'), [], 'no match is empty');
    assert.equal(
        a.run('searchChats(state.chats, "crashing")[0].snippet'),
        'my pod keeps crashing',
        'snippet comes from the hit message',
    );
    assert.equal(a.run('searchChats(state.chats, "k8s")[1].hits'), 2, 'two matching messages count as two hits');
});

/* =====================================================================
   Compare fan-out
   ===================================================================== */

test('compare turn streams one reply per profile with per-profile auth', async () => {
    const a = app(settingsOf({}));
    a.run('loadAll()');
    a.run(`state.profiles = [
        { id: 'pa', name: 'Alpha', endpoint: 'https://alpha.example${CHAT}', apiKey: 'key-a', model: 'model-a' },
        { id: 'pb', name: 'Beta',  endpoint: 'http://localhost:1234${CHAT}', apiKey: '',         model: '' },
    ]`);
    a.run('state.activeId = "pa"');
    a.run(`state.chats = [{ id: 'c1', title: 'T', updatedAt: 0, messages: [
        { role: 'user', text: 'hello' },
    ] }]`);
    a.run('state.currentId = "c1"');

    const calls = [];
    a.context.fetch = async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        const which = url.includes('alpha.example') ? 'A' : 'B';
        return sseResponse([
            `data: {"choices":[{"delta":{"content":"${which}-1"}}]}\n\n`,
            `data: {"choices":[{"delta":{"content":"-${which}2"}}]}\n\n`,
            'data: [DONE]\n\n',
        ]);
    };

    await a.run('runCompare(state.chats[0], state.profiles.slice(0, 2).map((p) => ({ profile: p, model: "" })))');

    assert.equal(calls.length, 2, 'one request per profile');
    assert.equal(calls[0].url, `https://alpha.example${CHAT}`);
    assert.equal(calls[0].headers.Authorization, 'Bearer key-a');
    assert.equal(calls[0].body.model, 'model-a');
    assert.equal(calls[1].url, `http://localhost:1234${CHAT}`);
    assert.equal(calls[1].headers.Authorization, undefined, 'local endpoints send no auth');
    assert.equal(calls[1].body.model, 'local-model', 'blank local model falls back');
    assert.deepEqual(calls.map((c) => c.body.messages.map((m) => m.role)),
        [['system', 'user'], ['system', 'user']], 'context is the same for every column');

    const bundle = a.run('state.chats[0].messages[1]');
    assert.equal(bundle.role, 'assistant');
    assert.equal(bundle.compare.length, 2);
    assert.equal(bundle.compare[0].text, 'A-1-A2');
    assert.equal(bundle.compare[1].text, 'B-1-B2');
    assert.equal(bundle.compare.every((c) => c.done), true);
    assert.equal(bundle.compare[0].profile.name, 'Alpha');
    assert.equal('apiKey' in bundle.compare[0].profile, false, 'the key is never snapshotted into history');
    assert.equal(a.run('state.aborts.length'), 0, 'streaming state is reset');
});

test('one failing column cannot take the others down', async () => {
    const a = app(settingsOf({}));
    a.run('loadAll()');
    a.run(`state.profiles = [
        { id: 'pgood', name: 'Good', endpoint: 'https://good.example${CHAT}', apiKey: 'k', model: 'm' },
        { id: 'pbad',  name: 'Bad',  endpoint: 'https://bad.example${CHAT}',  apiKey: 'k', model: 'm' },
    ]`);
    a.run(`state.chats = [{ id: 'c2', title: 'T', updatedAt: 0, messages: [] }]`);
    a.run('state.currentId = "c2"');

    a.context.fetch = async (url) => (url.includes('bad.example')
        ? { ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) }
        : sseResponse(['data: {"choices":[{"delta":{"content":"fine"}}]}\n\n', 'data: [DONE]\n\n']));

    await a.run('runCompare(state.chats[0], state.profiles.map((p) => ({ profile: p, model: "" })))');

    const cols = a.run('state.chats[0].messages[0].compare');
    assert.equal(cols[0].text, 'fine');
    assert.equal(cols[0].error, false);
    assert.equal(cols[1].error, true);
    assert.match(cols[1].text, /bad key/);
});

test('one profile can compare two of its own models', async () => {
    const a = app(settingsOf({}));
    a.run('loadAll()');
    a.run(`state.profiles = [
        { id: 'or', name: 'OpenRouter', endpoint: 'https://openrouter.ai${CHAT}',
          apiKey: 'key-or', model: 'vendor/default' },
    ]`);
    a.run('state.activeId = "or"');
    a.run(`state.chats = [{ id: 'c4', title: 'T', updatedAt: 0, messages: [] }]`);
    a.run('state.currentId = "c4"');

    const calls = [];
    a.context.fetch = async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        const which = calls.length === 1 ? 'X' : 'Y';
        return sseResponse([`data: {"choices":[{"delta":{"content":"${which}"}}]}\n\n`, 'data: [DONE]\n\n']);
    };

    // One profile, two columns with per-column model overrides.
    const cols = 'state.profiles[0]';
    await a.run(`runCompare(state.chats[0], [
        { profile: ${cols}, model: 'vendor/free-a:free' },
        { profile: ${cols}, model: 'vendor/free-b:free' },
    ])`);

    assert.equal(calls.length, 2, 'one request per column, same endpoint');
    assert.deepEqual(calls.map((c) => c.body.model),
        ['vendor/free-a:free', 'vendor/free-b:free'], 'each column sends its own model');
    assert.equal(calls[0].headers.Authorization, 'Bearer key-or');
    assert.equal(calls[1].headers.Authorization, 'Bearer key-or');

    const bundle = a.run('state.chats[0].messages[0].compare');
    const snap = JSON.parse(JSON.stringify(bundle));
    assert.deepEqual(snap.map((c) => c.profile.model),
        ['vendor/free-a:free', 'vendor/free-b:free'], 'the column model is snapshotted');
    assert.deepEqual(snap.map((c) => c.text), ['X', 'Y']);
    assert.equal('apiKey' in snap[0].profile, false);
});

test('toggleCompare seeds two columns for a single profile', () => {
    const a = app(settingsOf({}));
    a.run('loadAll()');
    a.run(`state.profiles = [
        { id: 'only', name: 'Solo', endpoint: 'http://localhost:1234${CHAT}', apiKey: '', model: '' },
    ]`);
    a.run('state.activeId = "only"');

    a.run('toggleCompare(true)');
    const seeded = a.run('state.compareCols');
    assert.deepEqual(JSON.parse(JSON.stringify(seeded)), [
        { profileId: 'only', model: '' },
        { profileId: 'only', model: '' },
    ], 'second column starts on the same profile, model blank until filled');

    // The "+ Column" cap still applies.
    a.run('addCompareColumn()');
    a.run('addCompareColumn()');
    assert.equal(a.run('state.compareCols.length'), 3);
    a.run('addCompareColumn()');
    assert.equal(a.run('state.compareCols.length'), 3, 'capped at three');
});

test('snapshot-based helpers stay key-free and id-stable', () => {
    const a = app(settingsOf({}));
    a.run('loadAll()');
    a.run(`state.profiles[0] = {
        id: 'p1', name: 'OpenRouter',
        endpoint: 'https://openrouter.ai${CHAT}', apiKey: 'secret', model: '  vendor/freebie  ',
    }`);
    const snap = JSON.parse(a.run('JSON.stringify(snapshot(state.profiles[0]))'));
    assert.deepEqual(snap, {
        id: 'p1', name: 'OpenRouter',
        endpoint: `https://openrouter.ai${CHAT}`,
        model: 'vendor/freebie',
    });
});

/* =====================================================================
   Mid-stream and free-tier errors
   ===================================================================== */

test('mid-stream rate limits surface as errors, not empty replies', async () => {
    const a = app(settingsOf({}));
    a.run('loadAll()');
    a.run(`state.profiles = [
        { id: 'pf', name: 'Free', endpoint: 'https://openrouter.ai${CHAT}', apiKey: 'k',
          model: 'vendor/cheap:free' },
    ]`);
    a.run('state.activeId = "pf"');
    a.run(`state.chats = [{ id: 'c3', title: 'T', updatedAt: 0, messages: [] }]`);
    a.run('state.currentId = "c3"');

    // The 429 arrives mid-stream: SSE event, finish_reason 'error', remedy hint.
    a.context.fetch = async () => sseResponse([
        'data: {"choices":[{"delta":{"content":"partial an"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"error"}],' +
        '"error":{"code":429,"message":"Rate limit exceeded",' +
        '"metadata":{"error_type":"rate_limit_exceeded"}}}\n\n',
    ]);

    await a.run('runCompletion(state.chats[0])');

    const reply = a.run('state.chats[0].messages[0]');
    assert.equal(reply.error, true);
    assert.match(reply.text, /partial an/);
    assert.match(reply.text, /Rate limit exceeded/);
    assert.match(reply.text, /50 per day/);
    assert.equal(a.run('state.aborts.length'), 0);
});

test('error text helpers carry the API\'s own advice', () => {
    const a = app();
    assert.equal(
        a.run('streamErrorText({ message: "No endpoints found", metadata: { provider_code: 404 } }, 0)'),
        'No endpoints found · (provider error 404)',
    );
    assert.match(
        a.run('streamErrorText({ message: "over budget", metadata: { remedy_hint: "add credits" } }, 0)'),
        /over budget · add credits/,
    );
    assert.equal(a.run('streamErrorText(null, 500)'), 'Request failed with status 500');

    // Free-tier hints only fire for the states that describe them.
    assert.match(a.run('freeTierHint(429)'), /50 per day/);
    assert.match(a.run('freeTierHint(0, { error_type: "rate_limit_exceeded" })'), /20 requests.min/);
    assert.match(a.run('freeTierHint(402)'), /non-negative balance/);
    assert.match(a.run('freeTierHint(404)'), /free pool/);
    assert.equal(a.run('freeTierHint(500)'), '');
    assert.equal(a.run('freeTierHint(401)'), '');

    // parseSSE throws so the stream loop stops and the catch path renders it.
    assert.throws(
        () => a.run(`parseSSE('data: {"error":{"code":429,"message":"Rate limit exceeded"}}', () => {})`),
        /Rate limit exceeded/,
    );
});

/* =====================================================================
   Self-checks
   ===================================================================== */

test('existing markdown, endpoint and streaming self-checks pass', () => {
    assert.equal(app().run('window.__mgptSelfTest()'), true);
});
