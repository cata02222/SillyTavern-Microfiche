import { PAGE, planArchive, locate, layoutBlocks, normalize, wrap, paginate, MAX_UNKNOWN_SHARE } from './lib/layout.js';

import { renderPage } from './lib/render.js';

import { savingsTotals, savingsDetail, exactTokens } from './lib/savings.js';

import { KEEP_MARKER, textExemption } from './lib/exempt.js';

import { promptManager } from '../../../openai.js';

import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE = 'microfiche';

const FOLDER = new URL('.', import.meta.url).pathname.split('/scripts/extensions/')[1]?.replace(/\/$/, '') ?? 'third-party/microfiche';

const DEFAULTS = Object.freeze({
    enabled: true,
    offModels: [],
    experimentalModels: {},
    keepTokens: 4e3,
    showSavings: false,
    showNotifications: false,
    detail: 'medium',
    asImages: {
        chat: true,
        preset: false,
        card: false,
        persona: false,
        lorebook: false
    },
    packSetup: true
});

const PAGE_COST = Object.freeze({
    low: 280,
    pdf: 560,
    png: 1120
});

const MAX_IMAGE_BYTES = 18e6;

const GEMINI_MODEL = /gemini/i;

const NOT_A_CHAT_MODEL = /gemma|embed|tts|imagen|image|veo|live|audio|robotics|computer-use|aqa/i;

const TESTED_MODEL = /argon/i;

const MODEL_SELECTS = {
    makersuite: '#model_google_select',
    vertexai: '#model_vertexai_select',
    openrouter: '#model_openrouter_select',
    custom: '#model_custom_select'
};

const CHARS_PER_TOKEN = 3.5;

const CHUNK_TOKENS = 2e3;

const NOTE = '[Earlier messages, as pages of text, oldest first. Each message starts with [Name]; ' + '¶ is a paragraph break; [emoji: name] represents an emoji. The chat continues after the images.]';

const SETUP_SYSTEM = 'Some instructions, character details and world info are written in images at their positions in this conversation. ' + 'Apply them alongside the text instructions, exactly as if their text were written here.';

const SETUP_NOTE = '[Instructions, characters and world info, as images of text. [emoji: name] represents an emoji. A ? stands for another character the font cannot draw.]';

const SETUP_NOTE_PACKED = SETUP_NOTE.replace(' A ?', ' ¶ is a line break. A ?');

const GEMINI_SOURCES = [ 'makersuite', 'vertexai' ];

const SOURCE_NAMES = {
    makersuite: 'Google AI Studio',
    vertexai: 'Vertex AI',
    openrouter: 'OpenRouter',
    custom: 'Custom'
};

const ctx = () => SillyTavern.getContext();

const ignoreSymbol = () => ctx().symbols?.ignore ?? Symbol.for('ignore');

const waiting = new Map;

let lastSent = null;

let lastResult = null;

let replyStats = null;

let lastSetup = null;

const notified = new Set;

function notify(level, key, message) {
    if (level === 'info' && !settings().showNotifications) return;
    const id = `${ctx().getCurrentChatId?.() ?? ''}:${key}`;
    if (notified.has(id)) return;
    notified.add(id);
    toastr[level](message, 'Microfiche');
}

const pageTokenCache = new Map;

function pageTokens(page) {
    const text = page.lines.join('\n');
    const key = `${currentModel()}\n${text}`;
    if (!pageTokenCache.has(key)) {
        const fallback = Math.round(page.chars / CHARS_PER_TOKEN);
        const count = Promise.resolve().then(() => ctx().getTokenCountAsync(text)).then(n => Number.isFinite(n) && n > 0 ? n : fallback, () => fallback);
        pageTokenCache.set(key, count);
        if (pageTokenCache.size > 500) pageTokenCache.delete(pageTokenCache.keys().next().value);
    }
    return pageTokenCache.get(key);
}

async function countedStats(plan, format) {
    const stats = statsOf(plan, format);
    stats.textTokens = plan.sourceText !== undefined ? await pageTokens({
        lines: [ plan.sourceText ],
        chars: plan.archivedChars
    }) : (await Promise.all(plan.pages.map(pageTokens))).reduce((a, b) => a + b, 0);
    return stats;
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};
    const s = all[MODULE];
    delete s.modelMatch;
    if (!Array.isArray(s.offModels)) s.offModels = [];
    if (!s.experimentalModels || typeof s.experimentalModels !== 'object' || Array.isArray(s.experimentalModels)) s.experimentalModels = {};
    delete s.pageTokens;
    delete s.reach;
    delete s.maxPages;
    if (s.setupImages === true) s.asImages = {
        preset: true,
        card: true,
        persona: true,
        lorebook: true
    };
    delete s.setupImages;
    s.asImages = {
        ...DEFAULTS.asImages,
        ...s.asImages ?? {}
    };
    for (const [key, value] of Object.entries(DEFAULTS)) s[key] ??= value;
    return s;
}

const oai = () => ctx().chatCompletionSettings ?? {};

const SETUP_KINDS = [ 'preset', 'card', 'persona', 'lorebook' ];

const setupOn = () => SETUP_KINDS.some(kind => settings().asImages[kind]);

function pageFormat() {
    if (!isGemini(currentModel())) return 'png';
    const detail = settings().detail;
    if (detail === 'high') return 'png';
    if (detail === 'low' && !GEMINI_SOURCES.includes(oai().chat_completion_source)) return 'low';
    return 'pdf';
}

const currentModel = () => String(ctx().getChatCompletionModel?.() ?? '');

const isGemini = model => GEMINI_MODEL.test(model) && !NOT_A_CHAT_MODEL.test(model);

const experimentalKey = () => JSON.stringify([ oai().chat_completion_source ?? '', currentModel() ]);

function experimentalConfig() {
    return settings().experimentalModels[experimentalKey()];
}

function pageCost(format = pageFormat()) {
    if (isGemini(currentModel())) return PAGE_COST[format];
    const value = Number(experimentalConfig()?.pageTokens);
    return Number.isFinite(value) && value >= 1 ? Math.min(1e5, Math.round(value)) : 1500;
}

function modelMatches() {
    if (ctx().mainApi !== 'openai') return false;
    const model = currentModel();
    if (!model) return false;
    return isGemini(model) ? !settings().offModels.includes(model) : experimentalConfig()?.enabled === true;
}

function connectionModels() {
    const select = MODEL_SELECTS[oai().chat_completion_source];
    const ids = select ? $(`${select} option`).map((_, o) => String(o.value)).get() : [];
    const current = currentModel();
    if (current) ids.push(current);
    return [ ...new Set(ids) ].filter(isGemini).sort();
}

function stopAt(m) {
    if (m.extra?.tool_invocations?.length) return 'a tool call';
    if (oai().media_inlining !== false && (m.extra?.media?.length || m.extra?.image)) return 'an attached image or file';
    return null;
}

function makePlan(messages, contextSize) {
    const s = settings();
    return planArchive({
        messages: messages,
        keepTokens: Number(s.keepTokens) || 0,
        coverTokens: contextSize,
        maxPages: Infinity,
        pageCost: pageCost(),
        chunkTokens: CHUNK_TOKENS,
        charsPerToken: CHARS_PER_TOKEN,
        stopAt: stopAt
    });
}

function statsOf(plan, format = pageFormat()) {
    return {
        pages: plan.pages.length,
        format: format,
        messages: plan.removeCount,
        textTokens: Math.round(plan.archivedChars / CHARS_PER_TOKEN),
        imageTokens: plan.pages.length * pageCost(format),
        experimental: !isGemini(currentModel()),
        stoppedAt: plan.stoppedAt,
        stopReason: plan.stopReason ?? null
    };
}

const k = n => n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

function promptIds() {
    return ctx().chat.map((m, i) => m.is_system ? -1 : i).filter(i => i >= 0);
}

function currentPlan() {
    const c = ctx();
    const o = oai();
    const contextSize = (Number(o.openai_max_context) || 64e3) - (Number(o.openai_max_tokens) || 0);
    const ids = promptIds();
    const messages = ids.map(i => c.chat[i]);
    if (messages.length && !messages[messages.length - 1].is_user) messages.push({
        mes: '',
        is_user: true,
        name: c.name1,
        extra: {}
    });
    return {
        plan: makePlan(messages, contextSize),
        ids: ids,
        sent: false
    };
}

function activePlan() {
    const c = ctx();
    if (lastSent && lastSent.chatId === c.getCurrentChatId() && lastSent.chatLength <= c.chat.length) return lastSent;
    return currentPlan();
}

function messagePlan(mesId) {
    const active = activePlan();
    const spotsFor = view => {
        const index = view.ids.indexOf(mesId);
        return index < 0 ? [] : locate(view.plan, index);
    };
    let spots = spotsFor(active);
    if (spots.length || !active.sent) return {
        active: active,
        spots: spots
    };
    const next = currentPlan();
    spots = spotsFor(next);
    return {
        active: next,
        spots: spots
    };
}

function messagePreview(mesId) {
    const view = messagePlan(mesId);
    if (view.spots.length) return view;
    const c = ctx();
    const ids = promptIds();
    const index = ids.indexOf(mesId);
    if (index < 0) return view;
    const messageLines = ids.map(id => {
        const m = c.chat[id];
        const head = normalize(m.name || (m.is_user ? 'User' : 'Character')).text;
        return wrap(`[${head}] ${normalize(m.mes).text}`, PAGE.cols);
    });
    const plan = {
        pages: paginate(messageLines, PAGE.rows)
    };
    return {
        active: {
            plan: plan,
            ids: ids,
            sent: false,
            previewOnly: true
        },
        spots: locate(plan, index)
    };
}

function chatIdsFor(chat, positions) {
    const c = ctx();
    const ids = promptIds();
    if (chat.length > ids.length + 1) return null;
    const out = positions.map(i => ids[i]);
    const same = positions.every((i, n) => {
        const real = c.chat[out[n]];
        return real && real.send_date === chat[i].send_date && real.name === chat[i].name && real.is_user === chat[i].is_user;
    });
    return same ? out : null;
}

globalThis.microfiche_intercept = async function(chat, contextSize, abort, type) {
    if (type === 'quiet') return;
    try {
        for (const entry of waiting.values()) entry.stale = true;
        const s = settings();
        if (!s.enabled || !s.asImages.chat || !modelMatches() || !Array.isArray(chat)) {
            lastResult = null;
            return;
        }
        const ignore = ignoreSymbol();
        const live = [];
        chat.forEach((m, i) => {
            if (m && typeof m.mes === 'string' && !m.extra?.[ignore]) live.push(i);
        });
        const plan = makePlan(live.map(i => chat[i]), contextSize);
        if (!plan.pages.length) {
            lastResult = {
                ok: false,
                reason: 'chat too short yet, sent as normal text'
            };
            return;
        }
        const format = pageFormat();
        let urls = await Promise.all(plan.pages.map(p => renderPage(p.lines, format === 'pdf' ? 'pdf' : 'png')));
        let bytes = 0;
        let first = urls.length;
        while (first > 0 && bytes + urls[first - 1].length <= MAX_IMAGE_BYTES) bytes += urls[--first].length;
        first = Math.min(first, urls.length - 1);
        if (first > 0) {
            urls = urls.slice(first);
            plan.pages = plan.pages.slice(first);
            plan.archivedChars = plan.pages.reduce((sum, p) => sum + p.chars, 0);
            const owners = [ ...new Set(plan.pages.flatMap(p => p.owners)) ].sort((a, b) => a - b);
            plan.sourceText = owners.map(i => {
                const m = chat[live[i]];
                return `${m.name || (m.is_user ? 'User' : 'Character')}: ${m.mes ?? ''}`;
            }).join('\n\n');
        }
        const archived = live.slice(0, plan.removeCount);
        const ids = chatIdsFor(chat, live);
        const c = ctx();
        const marker = `⟦MICROFICHE_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}⟧`;
        for (const i of archived) chat[i] = {
            ...chat[i],
            extra: {
                ...chat[i].extra ?? {},
                [ignore]: true
            }
        };
        const at = archived[archived.length - 1] + 1;
        chat.splice(at, 0, {
            name: c.name1,
            is_user: true,
            is_system: false,
            send_date: chat[at - 1]?.send_date ?? '',
            mes: marker,
            extra: {}
        });
        waiting.set(marker, {
            urls: urls,
            text: plan.pages.map(p => p.lines.join('\n')).join('\n'),
            format: format,
            stats: countedStats(plan, format).catch(() => statsOf(plan, format)),
            sent: ids ? {
                plan: plan,
                ids: ids,
                sent: true,
                chatId: c.getCurrentChatId(),
                chatLength: c.chat.length
            } : null
        });
        while (waiting.size > 8) waiting.delete(waiting.keys().next().value);
    } catch (error) {
        console.error('[Microfiche] Skipped for this request, sending plain text.', error);
        notify('error', 'intercept', 'Couldn\'t make the images, so this message went as normal text. Details in the browser console.');
    }
};

const textOf = m => typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(p => typeof p?.text === 'string' ? p.text : '').join('\n') : '';

function roleView(chat) {
    const o = oai();
    const gemini = GEMINI_SOURCES.includes(o.chat_completion_source);
    let lead = 0;
    if (gemini && o.use_sysprompt) while (lead < chat.length - 1 && chat[lead]?.role === 'system') lead++;
    return i => {
        const role = chat[i]?.role;
        if (i < lead) return 'instruction';
        if (gemini && (role === 'system' || role === 'tool')) return 'user';
        return role;
    };
}

function isolate(chat, index) {
    const role = roleView(chat);
    if (role(index) !== 'user') return;
    const mergeable = i => role(i) === 'user' && !chat[i]?.tool_calls && !chat[i]?.tool_call_id;
    let from = index;
    let to = index;
    while (from > 0 && mergeable(from - 1)) from--;
    while (to < chat.length - 1 && mergeable(to + 1)) to++;
    if (from === to) return;
    const c = ctx();
    const parts = [];
    const pushText = text => {
        if (!text) return;
        const last = parts[parts.length - 1];
        if (last?.type === 'text') last.text += '\n\n' + text; else parts.push({
            type: 'text',
            text: text
        });
    };
    for (let i = from; i <= to; i++) {
        const m = chat[i];
        const prefix = m.name === 'example_user' ? c.name1 : m.name === 'example_assistant' ? c.name2 : m.name;
        const named = text => prefix && !text.startsWith(`${prefix}: `) ? `${prefix}: ${text}` : text;
        if (i === index || Array.isArray(m.content)) {
            for (const part of Array.isArray(m.content) ? m.content : []) {
                if (part?.type === 'text') {
                    if (i === index) parts.push({
                        ...part
                    }); else pushText(named(part.text));
                } else {
                    parts.push(part);
                }
            }
        } else {
            pushText(named(String(m.content ?? '')));
        }
    }
    chat.splice(from, to - from + 1, {
        role: 'user',
        content: parts
    });
}

function swapArchive(data) {
    for (const [marker, entry] of waiting) {
        const index = data.chat.findIndex(m => textOf(m).includes(marker));
        if (index === -1) continue;
        waiting.delete(marker);
        const message = data.chat[index];
        try {
            message.role = 'user';
            delete message.name;
            message.content = [ {
                type: 'text',
                text: NOTE
            }, ...entry.urls.map(url => ({
                type: 'image_url',
                image_url: entry.format === 'low' ? {
                    url: url,
                    detail: 'low'
                } : {
                    url: url
                }
            })) ];
            isolate(data.chat, index);
            if (entry.sent) lastSent = entry.sent;
            lastResult = {
                ok: true,
                pages: entry.urls.length,
                format: entry.format,
                route: routeName(),
                model: currentModel()
            };
            return entry.stats;
        } catch (error) {
            console.error('[Microfiche] Could not place the pages, sending their text instead.', error);
            data.chat[index] = {
                role: 'user',
                content: entry.text
            };
            lastResult = {
                ok: false,
                reason: 'sent as normal text after an error'
            };
            notify('error', 'swap', 'Couldn\'t attach the images, so their text went instead. Details in the browser console.');
        }
        return null;
    }
    return null;
}

const setupPageCache = new Map;

function setupPage(lines, format) {
    const key = `${format}\n${lines.join('\n')}`;
    if (!setupPageCache.has(key)) {
        setupPageCache.set(key, renderPage(lines, format === 'pdf' ? 'pdf' : 'png'));
        if (setupPageCache.size > 64) setupPageCache.delete(setupPageCache.keys().next().value);
    }
    return setupPageCache.get(key);
}

const KIND_OF = {
    charDescription: 'card',
    charPersonality: 'card',
    scenario: 'card',
    dialogueExamples: 'card',
    personaDescription: 'persona',
    worldInfoBefore: 'lorebook',
    worldInfoAfter: 'lorebook'
};

const KIND_NAMES = {
    preset: 'preset',
    card: 'character card',
    persona: 'persona',
    lorebook: 'lorebook'
};

function promptKinds() {
    const kinds = new Map;
    const walk = (item, top) => {
        if (Array.isArray(item?.collection)) {
            for (const child of item.collection) walk(child, top ?? child?.identifier);
        } else if (typeof item?.content === 'string' && !kinds.has(item.content)) {
            kinds.set(item.content, KIND_OF[top] ?? 'preset');
        }
    };
    walk(promptManager?.messages, null);
    return kinds;
}

function setupEnd(chat) {
    const prefix = [];
    let history = false;
    const walk = item => {
        if (history) return;
        if (item?.identifier === 'chatHistory' || item?.identifier === 'newMainChat' || /^chatHistory-/.test(item?.identifier ?? '')) {
            history = true;
        } else if (Array.isArray(item?.collection)) {
            for (const child of item.collection) walk(child);
        } else if (item?.content || item?.tool_calls) {
            prefix.push(item);
        }
    };
    walk(promptManager?.messages);
    if (history && prefix.length < chat.length && prefix.every((m, i) => m.role === chat[i]?.role && m.name === chat[i]?.name && JSON.stringify(m.content) === JSON.stringify(chat[i]?.content))) return prefix.length;
    let end = 0;
    while (end < chat.length - 1 && chat[end]?.role === 'system' && typeof chat[end].content === 'string') end++;
    return end;
}

function setupBlocks(chat) {
    const selected = new Map;
    const kinds = promptKinds();
    for (let i = 0, end = setupEnd(chat); i < end; i++) selected.set(i, kinds.get(chat[i].content) ?? 'preset');
    let history = false;
    let tail = [];
    const historyIds = new Set([ 'chatHistory', 'newMainChat', 'newChat', 'groupNudge', 'emptyUserMessageReplacement', 'continueNudge' ]);
    const walk = (item, top) => {
        if (historyIds.has(item?.identifier) || /^chatHistory-|^toolCall-/.test(item?.identifier ?? '')) {
            history = true;
            tail = [];
            return;
        }
        if (Array.isArray(item?.collection)) {
            for (const child of item.collection) walk(child, top ?? child?.identifier);
        } else if (history && (item?.content || item?.tool_calls)) {
            tail.push({
                message: item,
                kind: KIND_OF[top ?? item.identifier] ?? 'preset'
            });
        }
    };
    walk(promptManager?.messages, null);
    const start = chat.length - tail.length;
    if (history && start >= 0 && tail.every(({message: m}, i) => m.role === chat[start + i]?.role && m.name === chat[start + i]?.name && JSON.stringify(m.content) === JSON.stringify(chat[start + i]?.content))) {
        tail.forEach(({kind: kind}, i) => selected.set(start + i, kind));
    }
    return selected;
}

async function buildSetup(chat) {
    const selected = setupBlocks(chat);
    if (!selected.size) return {
        ok: false,
        reason: 'no identifiable setup or post-history blocks'
    };
    const end = chat.length;
    const c = ctx();
    const ticked = settings().asImages;
    const format = pageFormat();
    const out = [];
    const sent = {
        pages: [],
        textTokens: 0,
        imageTokens: 0,
        kinds: new Set
    };
    let imageBytes = chat.reduce((sum, m) => sum + (Array.isArray(m.content) ? m.content.reduce((n, p) => n + (p?.image_url?.url?.length ?? 0), 0) : 0), 0);
    let skipped = null;
    let run = [];
    const flush = async () => {
        if (!run.length) return;
        const group = run;
        run = [];
        const blocks = group.map(({m: m}) => {
            const name = m.name === 'example_user' ? c.name1 : m.name === 'example_assistant' ? c.name2 : m.name;
            return name ? `${name}: ${m.content}` : m.content;
        });
        const {pages: pages, chars: chars, unknown: unknown} = layoutBlocks(blocks, {
            packed: settings().packSetup
        });
        const textTokens = await pageTokens({
            lines: blocks,
            chars: chars
        });
        const imageTokens = pages.length * pageCost(format);
        const note = settings().packSetup ? SETUP_NOTE_PACKED : SETUP_NOTE;
        const overhead = sent.pages.length ? [ note ] : [ SETUP_SYSTEM, note ];
        const overheadTokens = await pageTokens({
            lines: overhead,
            chars: overhead.join('\n').length
        });
        if (!pages.length || unknown / Math.max(1, chars) > MAX_UNKNOWN_SHARE || imageTokens + overheadTokens >= textTokens * .8) {
            skipped = unknown / Math.max(1, chars) > MAX_UNKNOWN_SHARE ? 'too much of it is in letters the font lacks' : 'too short to save anything';
            out.push(...group.map(({m: m}) => m));
            return;
        }
        const urls = await Promise.all(pages.map(lines => setupPage(lines, format)));
        const bytes = urls.reduce((sum, url) => sum + url.length, 0);
        if (imageBytes + bytes > MAX_IMAGE_BYTES) {
            skipped = 'the image size limit would be exceeded';
            out.push(...group.map(({m: m}) => m));
            return;
        }
        imageBytes += bytes;
        out.push({
            role: 'user',
            content: [ {
                type: 'text',
                text: note
            }, ...urls.map(url => ({
                type: 'image_url',
                image_url: format === 'low' ? {
                    url: url,
                    detail: 'low'
                } : {
                    url: url
                }
            })) ],
            mfSetup: true
        });
        sent.pages.push(...pages);
        sent.textTokens += textTokens;
        sent.imageTokens += imageTokens;
        for (const g of group) sent.kinds.add(g.kind);
    };
    for (let i = 0; i < end; i++) {
        if (!selected.has(i) || ![ 'system', 'user' ].includes(chat[i].role) || typeof chat[i].content !== 'string' || chat[i].tool_calls || chat[i].tool_call_id || chat[i].signature || chat[i].reasoning) {
            await flush();
            out.push(chat[i]);
            continue;
        }
        const kind = selected.get(i);
        const {exempt: exempt, text: text} = textExemption(chat[i].content);
        const message = exempt ? {
            ...chat[i],
            content: text
        } : chat[i];
        if (exempt && ticked[kind]) skipped ??= 'marked to stay as text';
        if (ticked[kind] && !exempt) {
            run.push({
                m: message,
                kind: kind
            });
        } else {
            await flush();
            out.push(message);
        }
    }
    await flush();
    if (!sent.pages.length) {
        chat.splice(0, end, ...out);
        return {
            ok: false,
            reason: skipped ?? 'none of the ticked parts are in this prompt'
        };
    }
    chat.splice(0, end, {
        role: 'system',
        content: SETUP_SYSTEM
    }, ...out);
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i]?.mfSetup) continue;
        delete chat[i].mfSetup;
        isolate(chat, i);
    }
    const order = Object.keys(KIND_NAMES).filter(kind => sent.kinds.has(kind));
    return {
        ok: true,
        pages: sent.pages.length,
        lines: sent.pages,
        format: format,
        textTokens: sent.textTokens,
        imageTokens: sent.imageTokens,
        kinds: order,
        experimental: !isGemini(currentModel())
    };
}

async function swapSetup(chat) {
    lastSetup = await buildSetup(chat);
    if (!lastSetup.ok) return null;
    const {pages: pages, textTokens: textTokens, imageTokens: imageTokens, kinds: kinds, experimental: experimental} = lastSetup;
    return {
        pages: pages,
        textTokens: textTokens,
        imageTokens: imageTokens,
        kinds: kinds,
        experimental: experimental
    };
}

async function previewSetup() {
    const c = ctx();
    let captured = null;
    const grab = data => {
        if (data?.dryRun && !captured && Array.isArray(data.chat)) captured = structuredClone(data.chat);
    };
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, grab);
    try {
        await c.generate('normal', {}, true);
    } finally {
        c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, grab);
    }
    return captured ? buildSetup(captured) : {
        ok: false,
        reason: 'couldn\'t build the prompt'
    };
}

async function onPromptReady(data) {
    if (data?.dryRun || !Array.isArray(data?.chat)) return;
    const archive = waiting.size ? swapArchive(data) : null;
    let setup = null;
    if (setupOn() && settings().enabled && modelMatches()) {
        try {
            setup = await swapSetup(data.chat);
        } catch (error) {
            console.error('[Microfiche] Blocks before the chat sent as text.', error);
            lastSetup = {
                ok: false,
                reason: 'an error, details in the browser console'
            };
        }
    } else {
        lastSetup = null;
    }
    if (archive || setup) {
        replyStats = Promise.resolve(archive).then(st => setup ? {
            ...st ?? {
                pages: 0,
                textTokens: 0,
                imageTokens: 0
            },
            setup: setup
        } : st);
        replyStats.then(st => notify('info', 'first', savingsDetail(st)));
    } else {
        replyStats = Promise.resolve({
            pages: 0,
            textTokens: 0,
            imageTokens: 0
        });
    }
    refreshSoon();
}

function checkMissing() {
    for (const entry of waiting.values()) {
        if (entry.stale || entry.reported) continue;
        entry.reported = true;
        lastResult = {
            ok: false,
            reason: 'the images were cut before sending, by the context limit or another extension'
        };
        console.warn('[Microfiche]', lastResult.reason);
        notify('warning', 'cut', 'The images were cut from the message by the context limit or another extension.');
    }
}

function routeName() {
    const source = oai().chat_completion_source;
    return SOURCE_NAMES[source] ?? source ?? '';
}

async function onMessageReceived(messageId) {
    checkMissing();
    if (!replyStats) return;
    const pending = replyStats;
    replyStats = null;
    const message = ctx().chat[messageId];
    if (message && !message.is_user) {
        message.extra ??= {};
        message.extra.microfiche = await pending;
    }
    refreshSoon();
}

let refreshTimer = null;

function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(e => console.error('[Microfiche] refresh failed', e)), 150);
}

const kindList = (kinds = []) => {
    const names = kinds.map(kind => KIND_NAMES[kind] ?? kind);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'setup';
};

async function status() {
    const c = ctx();
    if (settings().enabled && c.mainApi === 'openai' && modelMatches()) {
        const stats = c.chat?.findLast(m => !m.is_user && !m.is_system)?.extra?.microfiche;
        if (stats) {
            const {saved: saved} = savingsTotals(stats);
            return {
                state: saved > 0 ? 'working' : 'waiting',
                text: `Latest reply: ~${k(Math.abs(saved))} ${saved >= 0 ? 'fewer' : 'more'} input tokens.`,
                detail: savingsDetail(stats)
            };
        }
    }
    const st = await chatStatus();
    if ([ 'working', 'waiting' ].includes(st.state)) return {
        state: 'waiting',
        text: 'Ready.',
        detail: 'Next-request estimates are in Preview.'
    };
    return {
        ...st,
        detail: st.detail ?? st.text
    };
}

async function chatStatus() {
    const c = ctx();
    const s = settings();
    if (!s.enabled) return {
        state: 'off',
        text: 'Off.'
    };
    if (c.mainApi !== 'openai') return {
        state: 'idle',
        text: 'Not running: needs Chat Completion.'
    };
    if (!modelMatches()) {
        const model = currentModel() || 'This model';
        return isGemini(currentModel()) ? {
            state: 'idle',
            text: 'Not running: this model is unticked.',
            detail: `${model} is unticked under Advanced → Models.`
        } : {
            state: 'idle',
            text: 'Not running: this model needs opt-in.',
            detail: `Enable ${model} under Advanced → Other models (experimental). It must accept image input.`
        };
    }
    if (!c.chat?.length || c.characterId === undefined && !c.groupId) return {
        state: 'idle',
        text: 'Open a chat.'
    };
    if (!s.asImages.chat) {
        return setupOn() ? {
            state: 'waiting',
            saved: 0,
            detail: 'Chat history goes as normal text.'
        } : {
            state: 'idle',
            text: 'Nothing ticked under Send as images.'
        };
    }
    const {plan: plan, ids: ids} = currentPlan();
    if (!plan.pages.length) {
        if (plan.stoppedAt === 0) return {
            state: 'idle',
            text: 'Not running in this chat.',
            detail: `The first message has ${plan.stopReason}, so nothing goes as images.`
        };
        const tokensOf = (from, to) => ids.slice(from, to).reduce((n, i) => n + String(c.chat[i]?.mes ?? '').length, 0) / CHARS_PER_TOKEN;
        const older = Math.round(tokensOf(0, plan.tailStart));
        const newest = Math.round(tokensOf(plan.tailStart, ids.length));
        return {
            state: 'waiting',
            saved: 0,
            detail: `Older messages stay as text until an image saves tokens (about ${k(pageCost())} tokens per image). ` + `They're at ${k(older)} now. Your newest ${k(newest)} stays as text.`
        };
    }
    const st = await countedStats(plan);
    let detail = `Older messages go as ${st.pages} ${st.pages === 1 ? 'image' : 'images'}: ` + `${k(st.imageTokens)} tokens instead of ${k(st.textTokens)}.`;
    if (plan.stoppedAt !== null) detail += ` Images stop before message #${ids[plan.stoppedAt]} (${plan.stopReason}).`;
    return {
        state: 'working',
        saved: st.textTokens - st.imageTokens,
        detail: detail
    };
}

let shownModels = null;

function renderExperimentalModel() {
    const model = currentModel();
    const other = !isGemini(model);
    const enabled = experimentalConfig()?.enabled === true;
    $('#mf_experimental').show();
    $('#mf_experimental_model').text(other ? model || 'No model selected' : 'another model (select one first)');
    $('#mf_experimental_enabled').prop('checked', other && enabled).prop('disabled', !other || !model || ctx().mainApi !== 'openai');
    $('#mf_experimental_cost_row').toggle(other && enabled);
    const input = $('#mf_experimental_cost');
    if (document.activeElement !== input[0]) input.val(pageCost());
    $('#mf_detail').prop('disabled', other);
    $('#mf_quality_note').text(other ? 'Other models use PNG images. The quality settings and savings above apply to Gemini.' : 'Lower is cheaper but gets more wrong. Medium is the sweet spot. High gets more details right. On AI Studio and Vertex, Low goes as Medium.');
}

function renderModels() {
    renderExperimentalModel();
    const s = settings();
    const models = ctx().mainApi === 'openai' ? connectionModels() : [];
    const key = JSON.stringify([ models, s.offModels ]);
    if (key === shownModels) return;
    shownModels = key;
    const box = $('#mf_models').empty();
    if (!models.length) {
        box.append($('<small>').text('No Gemini models on this connection.'));
        return;
    }
    for (const model of models) {
        const input = $('<input type="checkbox">').val(model).prop('checked', !s.offModels.includes(model));
        const name = $('<span>').text(model);
        if (TESTED_MODEL.test(model)) name.append($('<small class="mf-tested">').text(' tested'));
        box.append($('<label class="checkbox_label">').append(input, name));
    }
}

async function refresh() {
    const c = ctx();
    const s = settings();
    renderModels();
    const st = await status();
    $('#mf_status').attr('data-state', st.state).attr('title', st.detail).text(st.text);
    const canPreview = s.enabled && s.asImages.chat && modelMatches();
    $('#chat .mes').each(function() {
        const id = Number(this.getAttribute('mesid'));
        this.classList.toggle('mf-on-page', canPreview && Boolean(c.chat[id]));
        const stats = c.chat[id]?.extra?.microfiche;
        const badge = $(this).find('.mf_saved');
        if (s.showSavings && (stats?.pages || stats?.setup?.pages)) {
            const {saved: saved} = savingsTotals(stats);
            badge.text(`${saved >= 0 ? '−' : '+'}${k(Math.abs(saved))}`).attr('title', `About ${exactTokens(Math.abs(saved))} ${saved >= 0 ? 'tokens saved' : 'extra tokens'} on this reply.`).show();
        } else {
            badge.hide();
        }
    });
}

async function showPage(mesId) {
    const c = ctx();
    const {active: active, spots: spots} = messagePreview(mesId);
    if (!spots.length) {
        toastr.info('No image for this message yet. Microfiche keeps recent messages as text; Advanced sets how much stays as text.', 'Microfiche');
        return;
    }
    const total = active.plan.pages.length;
    const blocks = await Promise.all(spots.map(async ({page: page, fromLine: fromLine, toLine: toLine}) => {
        const url = await renderPage(active.plan.pages[page].lines);
        const top = PAGE.margin + fromLine * 8;
        const height = (toLine - fromLine + 1) * 8;
        return `<div class="mf-caption">Image ${page + 1} of ${total}, this message highlighted</div>` + `<div class="mf-scroll"><div class="mf-sheet" style="width:${PAGE.width}px;height:${PAGE.height}px">` + `<img src="${url}" width="${PAGE.width}" height="${PAGE.height}" alt="">` + `<div class="mf-mark" style="top:${top}px;height:${height}px"></div></div></div>`;
    }));
    const source = active.previewOnly ? 'Chat layout preview only. This message currently stays as text; these preview pages are not attached to a request.' : active.sent ? 'Exactly what was attached to your last request.' : 'Preview for your next message, using the chat as it is now.';
    const popup = c.callGenericPopup(`<div class="mf-popup"><div class="mf-caption">${source}</div>${blocks.join('')}</div>`, c.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true
    });
    requestAnimationFrame(() => {
        const mark = document.querySelector('.mf-popup .mf-mark');
        const box = mark?.closest('.mf-scroll');
        if (box) box.scrollTop = Math.max(0, mark.offsetTop - 60);
    });
    await popup;
}

async function gallery(title, pages, caption) {
    const urls = await Promise.all(pages.map(lines => renderPage(lines)));
    return `<h4 class="mf-gallery-title">${title}</h4>` + urls.map((url, i) => `<div class="mf-caption">${caption(i, urls.length)}</div>` + `<div class="mf-scroll mf-preview-frame" style="--mf-used-height:${Math.min(PAGE.height, PAGE.margin * 2 + pages[i].length * 8)}"><img class="mf-thumb" src="${url}" width="${PAGE.width}" height="${PAGE.height}" alt="${title}, image ${i + 1}" title="Click to see the full page"></div>`).join('');
}

async function showStats() {
    const c = ctx();
    const s = settings();
    const escape = text => $('<div>').text(text).html();
    const st = await status();
    const parts = [];
    const details = [];
    const latest = c.chat?.findLast(m => !m.is_user && !m.is_system)?.extra?.microfiche;
    if (latest) details.push(`<p><b>Latest reply:</b> ${escape(savingsDetail(latest))}</p>`);
    const running = s.enabled && c.mainApi === 'openai' && modelMatches();
    if (running) {
        details.push(`<p><b>Connection:</b> ${escape(currentModel())} on ${escape(routeName())}, ` + (isGemini(currentModel()) ? {
            low: 'low quality images (about 280 tokens each).',
            pdf: 'medium quality images (about 560 tokens each).',
            png: 'high quality images (about 1,120 tokens each).'
        }[pageFormat()] : `experimental PNG images, using your estimate of ${exactTokens(pageCost())} tokens each. Recall and billing are untested.`) + '</p>');
    }
    let images = 0;
    const nextStats = {
        textTokens: 0,
        imageTokens: 0,
        experimental: !isGemini(currentModel())
    };
    if (running && c.chat?.length && setupOn()) {
        const ticked = SETUP_KINDS.filter(kind => s.asImages[kind]);
        const setup = await previewSetup().catch(error => ({
            ok: false,
            reason: String(error?.message ?? error)
        }));
        if (setup.ok) {
            images += setup.pages;
            nextStats.setup = setup;
            details.push(`<p>${escape(kindList(setup.kinds))}: ${exactTokens(setup.textTokens)} text tokens → ${exactTokens(setup.imageTokens)} image tokens.</p>`);
            parts.push(await gallery(`Setup · ${setup.pages} ${setup.pages === 1 ? 'image' : 'images'}`, setup.lines, (i, n) => `Image ${i + 1} of ${n} · click to see the full page`));
        } else {
            parts.push('<h4 class="mf-gallery-title">Setup stays as text</h4>');
            details.push(`<p>${escape(kindList(ticked))}: ${escape(setup.reason)}.</p>`);
        }
    }
    if (running && c.chat?.length && s.asImages.chat) {
        const {plan: plan, ids: ids} = currentPlan();
        if (plan.pages.length) {
            const st2 = await countedStats(plan);
            images += plan.pages.length;
            nextStats.textTokens = st2.textTokens;
            nextStats.imageTokens = st2.imageTokens;
            details.push(`<p>Chat: ${exactTokens(st2.textTokens)} text tokens → ${exactTokens(st2.imageTokens)} image tokens.</p>`);
            parts.push(await gallery(`Chat · ${st2.pages} ${st2.pages === 1 ? 'image' : 'images'}`, plan.pages.map(p => p.lines), (i, n) => `Image ${i + 1} of ${n}: messages #${ids[plan.pages[i].first]} to #${ids[plan.pages[i].last]}`));
        } else {
            parts.push('<h4 class="mf-gallery-title">Chat stays as text for now</h4>');
        }
    }
    if (images) {
        const saved = savingsTotals(nextStats).saved;
        parts.unshift(`<p class="mf-preview-summary">Next message: about <b>${k(Math.abs(saved))} ${saved >= 0 ? 'fewer' : 'more'} input tokens</b>.</p>`);
        details.push(`<p><b>Next message:</b> ${escape(savingsDetail(nextStats))}</p>`);
        details.push('<p>Blank space is hidden in these thumbnails. Click an image to see the full page. An exempt prompt keeps the image groups on either side separate, preserving prompt order.</p>');
    }
    if (details.length) parts.push(`<details class="mf-preview-details"><summary>Details</summary>${details.join('')}</details>`);
    if (!images) parts.push(`<p>${escape(running && c.chat?.length ? 'Nothing goes as images with your next message.' : st.text)}</p>`);
    await c.callGenericPopup(`<h3>Microfiche preview</h3><div class="justifyLeft mf-popup">${parts.join('')}</div>`, c.POPUP_TYPE.TEXT, '', images ? {
        wide: true,
        large: true,
        allowVerticalScrolling: true
    } : {});
}

function bindSettings() {
    const s = settings();
    const save = () => {
        ctx().saveSettingsDebounced();
        refreshSoon();
    };
    $('#mf_copy_keep').on('click', async () => {
        try {
            await navigator.clipboard.writeText(KEEP_MARKER);
            toastr.success('Paste it anywhere in the prompt you want to keep as text.', 'Marker copied');
        } catch {
            await ctx().callGenericPopup(`<p>Copy this into your prompt:</p><pre>${$('<div>').text(KEEP_MARKER).html()}</pre>`, ctx().POPUP_TYPE.TEXT);
        }
    });
    $('#mf_enabled').prop('checked', s.enabled).on('change', function() {
        s.enabled = this.checked;
        save();
    });
    $('#mf_experimental_enabled').on('change', function() {
        if (!currentModel() || isGemini(currentModel())) return;
        s.experimentalModels[experimentalKey()] = {
            enabled: this.checked,
            pageTokens: pageCost()
        };
        lastSetup = null;
        save();
    });
    $('#mf_experimental_cost').on('change', function() {
        if (!currentModel() || isGemini(currentModel())) return;
        const value = Number(this.value);
        const pageTokens = Number.isFinite(value) ? Math.max(1, Math.min(1e5, Math.round(value))) : 1500;
        s.experimentalModels[experimentalKey()] = {
            enabled: experimentalConfig()?.enabled === true,
            pageTokens: pageTokens
        };
        lastSetup = null;
        save();
    });
    $('#mf_models').on('change', 'input', function() {
        const model = String(this.value);
        s.offModels = s.offModels.filter(m => m !== model);
        if (!this.checked) s.offModels.push(model);
        save();
    });
    $('#mf_keep').val(s.keepTokens).on('input', function() {
        s.keepTokens = Math.max(0, Number(this.value) || 0);
        save();
    });
    $('#mf_detail').val(s.detail).on('change', function() {
        s.detail = [ 'low', 'high' ].includes(this.value) ? this.value : 'medium';
        save();
    });
    $('#mf_notifications').prop('checked', s.showNotifications).on('change', function() {
        s.showNotifications = this.checked;
        save();
    });
    $('#mf_savings').prop('checked', s.showSavings).on('change', function() {
        s.showSavings = this.checked;
        save();
    });
    $('#mf_pack').prop('checked', s.packSetup).on('change', function() {
        s.packSetup = this.checked;
        lastSetup = null;
        save();
    });
    for (const kind of Object.keys(DEFAULTS.asImages)) {
        $(`#mf_img_${kind}`).prop('checked', s.asImages[kind]).on('change', function() {
            s.asImages[kind] = this.checked;
            lastSetup = null;
            save();
        });
    }
    $('#microfiche_settings .inline-drawer-toggle').on('click', () => renderModels());
    $('#mf_stats').on('click', () => showStats().catch(e => console.error('[Microfiche] stats failed', e)));
}

function registerCommand() {
    ctx().SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'microfiche',
        helpString: 'Shows what Microfiche does in this chat. <code>/microfiche on</code> or <code>/microfiche off</code> switches it.',
        unnamedArgumentList: [ SlashCommandArgument.fromProps({
            description: 'on, off, or nothing to show the status',
            typeList: [ ARGUMENT_TYPE.STRING ],
            enumList: [ 'on', 'off' ],
            isRequired: false
        }) ],
        callback: async (_args, value) => {
            const arg = String(value ?? '').trim().toLowerCase();
            if (arg === 'on' || arg === 'off') {
                settings().enabled = arg === 'on';
                $('#mf_enabled').prop('checked', settings().enabled);
                ctx().saveSettingsDebounced();
                refreshSoon();
                return String(settings().enabled);
            }
            await showStats();
            return '';
        }
    }));
}

const MESSAGE_BUTTON = '<div title="Preview this message as an image" class="mes_button mf_show_page fa-solid fa-file-image"></div>';

const SAVED_BADGE = '<div class="mf_saved" style="display:none"></div>';

const PAGE_ICON = '<div class="mf_page_icon fa-solid fa-file-image" title="Preview this message as an image."></div>';

jQuery(async () => {
    settings();
    $('#extensions_settings2').append(await ctx().renderExtensionTemplateAsync(FOLDER, 'settings'));
    bindSettings();
    registerCommand();
    $('#message_template .mes_buttons .extraMesButtons').prepend(MESSAGE_BUTTON);
    $('#message_template .tokenCounterDisplay').after(SAVED_BADGE);
    $('#message_template .mesIDDisplay').after(PAGE_ICON);
    $('#chat .mes').each(function() {
        if (!$(this).find('.mf_show_page').length) $(this).find('.extraMesButtons').prepend(MESSAGE_BUTTON);
        if (!$(this).find('.mf_saved').length) $(this).find('.tokenCounterDisplay').first().after(SAVED_BADGE);
        if (!$(this).find('.mf_page_icon').length) $(this).find('.mesIDDisplay').first().after(PAGE_ICON);
    });
    $(document).on('click', '.mf-popup .mf-thumb', function() {
        this.classList.toggle('mf-zoom');
        this.closest('.mf-preview-frame')?.classList.toggle('mf-expanded');
    });
    $(document).on('click', '.mf_show_page, .mf_page_icon', function() {
        const id = Number($(this).closest('.mes').attr('mesid'));
        showPage(id).catch(e => console.error('[Microfiche] page view failed', e));
    });
    const c = ctx();
    const t = c.eventTypes;
    c.eventSource.makeLast(t.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    c.eventSource.on(t.MESSAGE_RECEIVED, onMessageReceived);
    c.eventSource.on(t.CHAT_CHANGED, () => {
        lastSent = null;
        lastResult = null;
        refreshSoon();
    });
    for (const e of [ t.MESSAGE_DELETED, t.MESSAGE_EDITED ]) c.eventSource.on(e, () => {
        lastSent = null;
        refreshSoon();
    });
    for (const e of [ t.MESSAGE_SENT, t.MESSAGE_SWIPED, t.MORE_MESSAGES_LOADED, t.CHARACTER_MESSAGE_RENDERED, t.USER_MESSAGE_RENDERED, t.GENERATION_ENDED, t.SETTINGS_UPDATED, t.CHATCOMPLETION_MODEL_CHANGED, t.CHATCOMPLETION_SOURCE_CHANGED, t.MAIN_API_CHANGED ]) {
        if (e) c.eventSource.on(e, refreshSoon);
    }
    refreshSoon();
});
