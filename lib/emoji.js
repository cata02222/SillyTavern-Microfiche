import { EMOJI_NAMES } from './emoji-names.js';

const root = new Map;

for (const [emoji, name] of EMOJI_NAMES) {
    let node = root;
    for (const ch of emoji) {
        if (!node.has(ch)) node.set(ch, new Map);
        node = node.get(ch);
    }
    node.name = name;
}

export function describeEmoji(text) {
    const chars = Array.from(text);
    let out = '';
    for (let i = 0; i < chars.length; ) {
        let node = root;
        let name;
        let end = i;
        for (let j = i; j < chars.length && node.has(chars[j]); j++) {
            node = node.get(chars[j]);
            if (node.name) {
                name = node.name;
                end = j + 1;
            }
        }
        if (name) {
            out += `[emoji: ${name}]`;
            i = end;
        } else {
            out += chars[i++];
        }
    }
    return out;
}
