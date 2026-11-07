export function savingsTotals(stats = {}) {
    const number = value => Number.isFinite(value) ? value : 0;
    const textTokens = number(stats.textTokens) + number(stats.setup?.textTokens);
    const imageTokens = number(stats.imageTokens) + number(stats.setup?.imageTokens);
    return {
        textTokens: textTokens,
        imageTokens: imageTokens,
        saved: textTokens - imageTokens
    };
}

export const exactTokens = n => Math.round(n).toLocaleString('en-US');

export function savingsDetail(stats) {
    const {textTokens: textTokens, imageTokens: imageTokens, saved: saved} = savingsTotals(stats);
    return `Estimated input reduction: ${exactTokens(saved)} tokens (${exactTokens(textTokens)} as text → ${exactTokens(imageTokens)} as images). Excludes request overhead and cache discounts.` + (stats?.experimental || stats?.setup?.experimental ? ' Experimental model: image tokens use your configured estimate, not measured billing.' : '');
}
