export function findHtmlEl<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) {
        throw new Error(`Missing element: ${selector}`);
    }

    return el as T;
}

export function findEl<T extends Element>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) {
        throw new Error(`Missing element: ${selector}`);
    }

    return el as T;
}

export function readNextFromHash(): string {
    // hash: "#/login?next=%2Fp2p"
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const qIndex = raw.indexOf('?');
    if (qIndex < 0) return '/';
    const query = raw.slice(qIndex + 1);
    const params = new URLSearchParams(query);
    const next = params.get('next');
    return next && next.length > 0 ? next : '/';
}
