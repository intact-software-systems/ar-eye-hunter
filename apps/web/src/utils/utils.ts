export function mustEl<T extends Element>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) {
        throw new Error(`Missing element: ${selector}`);
    }

    return el as T;
}

export function findHtmlEl<T extends HTMLElement>(root: ParentNode, selector: string): T {
    return mustEl(root, selector);
}

export function findEl<T extends Element>(root: ParentNode, selector: string): T {
    return mustEl(root, selector);
}

export function getHashPath(hash: string = location.hash): string {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const pathWithQuery = raw.length > 0 ? raw : '/';
    const qIndex = pathWithQuery.indexOf('?');
    const path = qIndex >= 0 ? pathWithQuery.slice(0, qIndex) : pathWithQuery;
    return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
}

export function readHashParam(
    name: string,
    fallback = '',
    hash: string = location.hash,
): string {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const qIndex = raw.indexOf('?');
    if (qIndex < 0) {
        return fallback;
    }

    const query = raw.slice(qIndex + 1);
    const params = new URLSearchParams(query);
    const value = params.get(name);
    return value && value.length > 0 ? value : fallback;
}

export function getOrCreateLocalId<T extends string = string>(key: string): T {
    const existing = localStorage.getItem(key);
    if (existing && existing.length > 0) {
        return existing as T;
    }

    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created as T;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
        if (
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function'
        ) {
            await navigator.clipboard.writeText(text);
            return true;
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const isCopied = document.execCommand('copy');
        document.body.removeChild(textarea);
        return isCopied;
    } catch {
        return false;
    }
}

export function readNextFromHash(): string {
    return readHashParam('next', '/');
}
