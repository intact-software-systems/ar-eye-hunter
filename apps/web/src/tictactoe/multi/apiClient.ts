import type {
    CreateGameRequest,
    CreateGameResponse,
    JoinGameRequest,
    JoinGameResponse,
    GameId,
} from '@shared/mod.ts';

export enum NAString {
    NA = 'NA',
}

export type ApiBaseUrl = string;

async function readTextSafe(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return '';
    }
}

async function apiJson<TReq, TRes>(
    baseUrl: ApiBaseUrl,
    path: string,
    method: 'GET' | 'POST',
    body: TReq | NAString
): Promise<TRes> {
    const url = `${baseUrl}${path}`;

    const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json' },
    };

    if (method === 'POST') {
        if (body === NAString.NA) {
            throw new Error(`POST ${path} requires a body`);
        }
        init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
        const txt = await readTextSafe(res);
        throw new Error(`API ${method} ${path} failed: ${res.status} ${txt}`);
    }

    return (await res.json()) as TRes;
}

function httpBaseUrl(): string {
    // If set (prod), use it. Otherwise empty string -> same origin in dev with Vite proxy.
    const env = (import.meta as any).env;
    const raw = (env?.VITE_API_BASE_URL as string) || '';
    return raw.length > 0 ? raw : '';
}

function wsBaseUrl(): string {
    const base = httpBaseUrl();

    // If user configured an absolute base URL, convert http(s) -> ws(s)
    if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}`;
    if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}`;

    // Otherwise (dev): same origin
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
}

export function createGamesApi() {
    const baseUrl = httpBaseUrl();
    const wsUrl = `${wsBaseUrl()}/api/ws`;

    return {
        wsUrl,

        async createGame(req: CreateGameRequest): Promise<CreateGameResponse> {
            return await apiJson<CreateGameRequest, CreateGameResponse>(
                baseUrl,
                '/api/games',
                'POST',
                req
            );
        },

        async joinGame(gameId: GameId, req: JoinGameRequest): Promise<JoinGameResponse> {
            return await apiJson<JoinGameRequest, JoinGameResponse>(
                baseUrl,
                `/api/games/${gameId}/join`,
                'POST',
                req
            );
        },
    };
}