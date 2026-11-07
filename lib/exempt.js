export const KEEP_MARKER = '\x3c!-- microfiche:keep --\x3e';

const MARKER = /<!--[\t ]*microfiche:keep[\t ]*-->/gi;

export function textExemption(content) {
    let exempt = false;
    const lines = content.replace(/^([\t ]*)<!--[\t ]*microfiche:keep[\t ]*-->[\t ]*(?:\r?\n|$)/gim, () => {
        exempt = true;
        return '';
    });
    const text = lines.replace(MARKER, () => {
        exempt = true;
        return '';
    });
    return {
        exempt: exempt,
        text: text
    };
}
