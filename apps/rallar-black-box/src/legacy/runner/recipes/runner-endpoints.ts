function runnerProbeUrl(baseUrl: string, path: string): string {
    try {
        return new URL(path, baseUrl).toString();
    }
    catch (_error) {
        return path;
    }
}

export function runnerApiProbeUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    const normalizedBase = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    try {
        const url = new URL(normalizedBase);
        const apiBasePath = url.pathname.replace(/\/+$/, '');
        return new URL(
            apiBasePath.endsWith('/api') ? 'config' : 'api/config',
            url
        ).toString();
    }
    catch (_error) {
        return '/api/config';
    }
}

export function runnerApiEndpointUrl(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
}

export function runnerControlWsUrlFromHttpBaseUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol === 'http:') {
            url.protocol = 'ws:';
        }
        else if (url.protocol === 'https:') {
            url.protocol = 'wss:';
        }
        url.pathname = '/control';
        url.search = '';
        url.hash = '';
        return url.toString();
    }
    catch (_error) {
        return 'ws://localhost:5180/control';
    }
}

export function runnerBrowserOrigin(): string {
    return globalThis.location?.origin ?? 'http://localhost:5176';
}
