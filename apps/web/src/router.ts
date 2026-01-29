export enum Route {
    TicTacToe = 'tictactoe',
    WhackAWorm = 'whackaworm',
    WhackSingle = 'whack-single',
    Landing = 'landing',
    Single = 'single',
    Multi = 'multi',
    P2P = 'p2p',
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
        case '/tictactoe':
            return Route.TicTacToe;
        case '/whackaworm/single':
            return Route.WhackSingle;
        case '/whackaworm':
            return Route.WhackAWorm;
        case '/single':
            return Route.Single;
        case '/multi':
            return Route.Multi;
        case '/p2p':
            return Route.P2P;
        case '/':
        default:
            return Route.Landing;
    }
}

export function navigate(route: Route): void {
    switch (route) {
        case Route.TicTacToe:
            location.hash = '#/tictactoe';
            return;
        case Route.WhackAWorm:
            location.hash = '#/whackaworm';
            return;
        case Route.WhackSingle:
            location.hash = '#/whackaworm/single';
            return;
        case Route.Single:
            location.hash = '#/single';
            return;
        case Route.Multi:
            location.hash = '#/multi';
            return;
        case Route.P2P:
            location.hash = '#/p2p';
            return;
        case Route.Landing:
        default:
            location.hash = '#/';
            return;
    }
}
