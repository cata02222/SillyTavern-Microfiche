import { GLYPHS, GLYPH_W, GLYPH_H } from './font.js';

import { describeEmoji } from './emoji.js';

export const PAGE = Object.freeze({
    width: 1568,
    height: 728,
    margin: 4,
    cols: Math.floor((1568 - 2 * 4) / GLYPH_W),
    rows: Math.floor((728 - 2 * 4) / GLYPH_H)
});

export const PARA = '¶';

export const MAX_UNKNOWN_SHARE = .05;

const REPLACE = {
    '‘': '\'',
    '’': '\'',
    '‚': '\'',
    '‛': '\'',
    '′': '\'',
    '“': '"',
    '”': '"',
    '„': '"',
    '‟': '"',
    '″': '"',
    '–': '-',
    '—': '--',
    '―': '--',
    '−': '-',
    '…': '...',
    '•': '*',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    '​': '',
    '‌': '',
    '‍': '',
    '\ufeff': '',
    '\t': ' '
};

const REPLACE_RE = new RegExp(`[${Object.keys(REPLACE).join('')}]`, 'g');

export function normalize(text) {
    let out = describeEmoji(String(text ?? '')).replace(/\r/g, '').replace(REPLACE_RE, ch => REPLACE[ch]);
    out = out.split('\n').map(p => p.trim()).filter(Boolean).join(` ${PARA} `);
    out = out.replace(/ {2,}/g, ' ').trim();
    let unknown = 0;
    let result = '';
    for (const ch of out) {
        const code = ch.codePointAt(0);
        if (GLYPHS[code] === undefined) {
            unknown++;
            result += '?';
        } else {
            result += ch;
        }
    }
    return {
        text: result,
        unknown: unknown
    };
}

export function wrap(text, cols) {
    const lines = [];
    let line = '';
    for (let word of text.split(' ')) {
        while (word.length > cols) {
            if (line) {
                lines.push(line);
                line = '';
            }
            lines.push(word.slice(0, cols));
            word = word.slice(cols);
        }
        if (!word) continue;
        if (!line) {
            line = word;
        } else if (line.length + 1 + word.length <= cols) {
            line += ' ' + word;
        } else {
            lines.push(line);
            line = word;
        }
    }
    if (line) lines.push(line);
    return lines;
}

export function paginate(messageLines, rows) {
    const pages = [];
    let page = null;
    const close = () => {
        if (page && page.lines.length) pages.push(page);
        page = null;
    };
    messageLines.forEach((lines, index) => {
        if (page && page.lines.length + lines.length > rows) close();
        for (const line of lines) {
            if (!page) page = {
                lines: [],
                owners: [],
                first: index,
                last: index,
                splitsAtEnd: false
            };
            if (page.lines.length === rows) {
                page.splitsAtEnd = true;
                close();
                page = {
                    lines: [],
                    owners: [],
                    first: index,
                    last: index,
                    splitsAtEnd: false
                };
            }
            page.lines.push(line);
            page.owners.push(index);
            page.last = index;
        }
    });
    close();
    return pages;
}

export function planArchive({messages: messages, keepTokens: keepTokens, coverTokens: coverTokens, maxPages: maxPages, pageCost: pageCost, chunkTokens: chunkTokens = 0, charsPerToken: charsPerToken = 3.5, stopAt: stopAt = () => null}) {
    const est = s => String(s ?? '').length / charsPerToken;
    let tailStart = messages.length;
    let tailTokens = 0;
    while (tailStart > 0) {
        const cost = est(messages[tailStart - 1].mes);
        if (tailStart < messages.length && tailTokens + cost > keepTokens) break;
        tailTokens += cost;
        tailStart--;
    }
    const messageLines = [];
    const chars = [];
    let stoppedAt = null;
    let stopReason = null;
    for (let i = 0; i < tailStart; i++) {
        const m = messages[i];
        const {text: text, unknown: unknown} = normalize(m.mes);
        const reason = stopAt(m) ?? (text.length && unknown / text.length > MAX_UNKNOWN_SHARE ? 'characters the font doesn\'t have' : null);
        if (reason) {
            stoppedAt = i;
            stopReason = reason;
            break;
        }
        const head = `[${normalize(m.name || (m.is_user ? 'User' : 'Character')).text}]`;
        messageLines.push(wrap(text ? `${head} ${text}` : head, PAGE.cols));
        chars.push(String(m.mes ?? '').length);
    }
    let pages = paginate(messageLines, PAGE.rows);
    const firstPageFill = pages.length > 1 ? 1 : (pages[0]?.lines.length ?? 0) / PAGE.rows;
    pages.pop();
    while (pages.length && pages[pages.length - 1].splitsAtEnd) pages.pop();
    const chunks = [];
    if (chunkTokens > 0) {
        let start = pages.length ? pages[pages.length - 1].last + 1 : 0;
        let size = 0;
        for (let i = start; i < messageLines.length; i++) {
            size += chars[i] / charsPerToken;
            if (size < chunkTokens) continue;
            const chunk = chunkPage(messageLines, chars, start, i);
            if (!chunk) break;
            chunks.push(chunk);
            start = i + 1;
            size = 0;
        }
    }
    if (chunkTokens > 0 && Number.isFinite(pageCost) && pageCost > 0) {
        const start = chunks.length ? chunks[chunks.length - 1].last + 1 : pages.length ? pages[pages.length - 1].last + 1 : 0;
        if (start < messageLines.length) {
            const pending = chunkPage(messageLines, chars, start, messageLines.length - 1);
            if (pending && pending.chars / charsPerToken > pageCost) {
                chunks.push({
                    ...pending,
                    growing: true
                });
            }
        }
    }
    const budget = Math.max(0, coverTokens - tailTokens);
    const chosen = [];
    let covered = chunks.reduce((n, c) => n + (pageCost ?? c.chars / charsPerToken), 0);
    for (let p = pages.length - 1; p >= 0 && chosen.length + chunks.length < maxPages; p--) {
        let pageChars = 0;
        for (let i = pages[p].first; i <= pages[p].last; i++) {
            if (i !== pages[p].first || p === 0 || pages[p - 1].last !== i) pageChars += chars[i];
        }
        const pageTokens = pageCost ?? pageChars / charsPerToken;
        if ((chosen.length || chunks.length) && covered + pageTokens > budget) break;
        covered += pageTokens;
        chosen.unshift({
            lines: pages[p].lines,
            owners: pages[p].owners,
            first: pages[p].first,
            last: pages[p].last,
            chars: pageChars
        });
    }
    chosen.push(...chunks);
    const removeCount = chosen.length ? chosen[chosen.length - 1].last + 1 : 0;
    const archivedChars = chosen.reduce((sum, p) => sum + p.chars, 0);
    const sourceIds = [ ...new Set(chosen.flatMap(page => page.owners)) ].sort((a, b) => a - b);
    const sourceText = sourceIds.map(i => `${messages[i].name || (messages[i].is_user ? 'User' : 'Character')}: ${messages[i].mes ?? ''}`).join('\n\n');
    return {
        pages: chosen,
        removeCount: removeCount,
        tailStart: tailStart,
        stoppedAt: stoppedAt,
        stopReason: stopReason,
        archivedChars: archivedChars,
        firstPageFill: firstPageFill,
        sourceText: sourceText
    };
}

function chunkPage(messageLines, chars, first, last) {
    const lines = [];
    const owners = [];
    let sum = 0;
    for (let i = first; i <= last; i++) {
        for (const line of messageLines[i]) {
            lines.push(line);
            owners.push(i);
        }
        sum += chars[i];
    }
    return lines.length <= PAGE.rows ? {
        lines: lines,
        owners: owners,
        first: first,
        last: last,
        chars: sum
    } : null;
}

export function locate(plan, index) {
    const found = [];
    plan.pages.forEach((page, p) => {
        const from = page.owners.indexOf(index);
        if (from !== -1) found.push({
            page: p,
            fromLine: from,
            toLine: page.owners.lastIndexOf(index)
        });
    });
    return found;
}

export function layoutBlocks(blocks, {packed: packed = true, cols: cols = PAGE.cols, rows: rows = PAGE.rows} = {}) {
    let chars = 0;
    let unknown = 0;
    let lines = [];
    if (packed) {
        const texts = [];
        for (const block of blocks) {
            const n = normalize(block);
            chars += String(block ?? '').length;
            unknown += n.unknown;
            if (n.text) texts.push(n.text);
        }
        lines = texts.length ? wrap(texts.join(` ${PARA} `), cols) : [];
    } else {
        for (const block of blocks) {
            for (const raw of String(block ?? '').split('\n')) {
                const n = normalize(raw);
                chars += raw.length;
                unknown += n.unknown;
                if (n.text) lines.push(...wrap(n.text, cols)); else if (lines.length && lines[lines.length - 1] !== '') lines.push('');
            }
            if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        }
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
    }
    const pages = [];
    for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows));
    return {
        pages: pages,
        chars: chars,
        unknown: unknown
    };
}
