export enum Route {
    Landing = 'landing',
    Single = 'single',
    Multi = 'multi'
}

export function getRouteFromHash(hash: string): Route {
    const h = hash.startsWith('#') ? hash.slice(1) : hash;
    switch (h) {
        case '/single':
            return Route.Single;
        case '/multi':
            return Route.Multi;
        case '/':
        case '':
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
