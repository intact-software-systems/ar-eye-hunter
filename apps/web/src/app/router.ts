export enum Route {
    Landing = 'landing',
    Single = 'single',
    Multi = 'multi'
}

function normalizeHashToPath(hash: string): string {
    // Examples:
    // "#/multi?gameId=123" -> "/multi"
    // "#/single"           -> "/single"
    // "#/" or ""           -> "/"
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const pathWithQuery = raw.length > 0 ? raw : '/';
    const qIndex = pathWithQuery.indexOf('?');
    const path = qIndex >= 0 ? pathWithQuery.slice(0, qIndex) : pathWithQuery;
    return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
}

export function getRouteFromHash(hash: string): Route {
    const path = normalizeHashToPath(hash);

    switch (path) {
        case '/single':
            return Route.Single;
        case '/multi':
            return Route.Multi;
        case '/':
        default:
            return Route.Landing;
    }
}

export function navigate(route: Route): void {
    switch (route) {
        case Route.Single:
            location.hash = '#/single';
            return;
        case Route.Multi:
            location.hash = '#/multi';
            return;
        case Route.Landing:
        default:
            location.hash = '#/';
            return;
    }
}
