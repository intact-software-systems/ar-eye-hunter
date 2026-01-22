import type {
    CreateGameRequest,
    CreateGameResponse,
    JoinGameRequest,
    JoinGameResponse,
    MakeMoveRequest,
    MakeMoveResponse,
    GetGameResponse,
    GameId,
} from '@shared/mod.ts';

/**
 * Explicit "no value" used in the SPA.
 * We avoid null/undefined in our own app state.
 */
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
        headers: {
            'content-type': 'application/json',
        },
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

export function createGamesApi(baseUrl: ApiBaseUrl) {
    return {
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

        async getGame(gameId: GameId): Promise<GetGameResponse> {
            return await apiJson<NAString, GetGameResponse>(
                baseUrl,
                `/api/games/${gameId}`,
                'GET',
                NAString.NA
            );
        },

        async makeMove(gameId: GameId, req: MakeMoveRequest): Promise<MakeMoveResponse> {
            return await apiJson<MakeMoveRequest, MakeMoveResponse>(
                baseUrl,
                `/api/games/${gameId}/move`,
                'POST',
                req
            );
        },
    };
}
