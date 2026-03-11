import { getHashPath } from './utils/utils.ts';

export enum Route {
    TicTacToe = 'tictactoe',
    WhackAWorm = 'whackaworm',
    WhackSingle = 'whack-single',
    Chat = 'chat',
    Rooms = 'rooms',
    Login = 'login',
    Landing = 'landing',
    Single = 'single',
    Multi = 'multi',
    P2P = 'p2p',
}

const pathByRoute = {
    [Route.TicTacToe]: '/tictactoe',
    [Route.WhackAWorm]: '/whackaworm',
    [Route.WhackSingle]: '/whackaworm/single',
    [Route.Chat]: '/chat',
    [Route.Rooms]: '/rooms',
    [Route.Login]: '/login',
    [Route.Landing]: '/',
    [Route.Single]: '/single',
    [Route.Multi]: '/multi',
    [Route.P2P]: '/p2p',
} as const satisfies Record<Route, string>;

const routeByPath = new Map<string, Route>(
    Object.entries(pathByRoute).map(([route, path]) => [path, route as Route]),
);

export function getPathForRoute(route: Route): string {
    return pathByRoute[route];
}

export function getRouteFromHash(hash: string): Route {
    return routeByPath.get(getHashPath(hash)) ?? Route.Landing;
}

export function navigate(route: Route): void {
    location.hash = `#${getPathForRoute(route)}`;
}
