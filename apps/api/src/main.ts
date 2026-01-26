import {tictactoeWebRtcWebSocketHandler} from './services/tictactoe-webrtc-req-handler.ts';
import {route, type Route} from 'jsr:@std/http/unstable-route';

import {
    CreateGameRequest,
    CreateGameResponse,
    GetGameResponse,
    JoinGameRequest,
    JoinGameResponse,
    MakeMoveRequest,
    MakeMoveResponse,
} from "@shared/mod.ts";

import {createGame, getGame, joinGame, makeMove} from "./services/tictactoe-game.ts";
import {handleWebSocket} from "./ws/ws_hub.ts";

const ALLOWED_ORIGINS = new Set<string>([
    'http://localhost:5173',
    // add your Cloudflare Pages origin here later, e.g.
    'https://ar-eye-hunter.pages.dev',
]);

function corsHeaders(req: Request): Headers {
    const headers = new Headers();

    const origin = req.headers.get('origin') ?? '';
    if (ALLOWED_ORIGINS.has(origin)) {
        headers.set('access-control-allow-origin', origin);
        headers.set('vary', 'origin');
    }

    headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    headers.set('access-control-allow-headers', 'content-type');
    // headers.set('access-control-allow-headers', 'content-type, authorization');
    headers.set('access-control-max-age', '86400');

    return headers;
}

function withCors(req: Request, res: Response): Response {
    const h = new Headers(res.headers);
    const cors = corsHeaders(req);
    cors.forEach((v, k) => h.set(k, v));
    return new Response(res.body, {status: res.status, headers: h});
}

const SIGNALLING_URL = new URLPattern({pathname: '/signalling'});
const CREATE_GAME_URL = new URLPattern({pathname: "/api/games"});
const JOIN_GAME_URL = new URLPattern({pathname: "/api/games/:id/join"});
const GET_GAME_URL = new URLPattern({pathname: "/api/games/:id"});
const MOVE_IN_GAME_URL = new URLPattern({pathname: "/api/games/:id/move"});

const WEB_SOCKET_CREATE = new URLPattern({pathname: "/api/ws"});
const routes: Route[] = [
    {
        method: "POST",
        pattern: SIGNALLING_URL,
        handler: (req, _info) =>
            tictactoeWebRtcWebSocketHandler(req)
    },
    {
        method: "POST",
        pattern: CREATE_GAME_URL,
        handler: async (req) => {
            const body = await readJson<CreateGameRequest>(req);
            if (!body.clientId) return badRequest("Missing clientId");

            const game = createGame(body.clientId);
            const res: CreateGameResponse = {
                gameId: game.id,
                assignedPlayer: game.players.X,
                state: game.state,
            };
            return json(res);
        },
    },

    {
        method: "POST",
        pattern: JOIN_GAME_URL,
        handler: async (req) => {
            const gameId = JOIN_GAME_URL.exec(req.url)?.pathname?.groups?.id ?? "";

            if (!gameId) return badRequest("Missing game id");

            const body = await readJson<JoinGameRequest>(req);
            if (!body.clientId) return badRequest("Missing clientId");

            const game = joinGame(gameId, body.clientId);

            const res: JoinGameResponse = {
                gameId: game.id,
                assignedPlayer: game.players.O,
                state: game.state,
            };

            return json(res);
        },
    },

    {
        method: "GET",
        pattern: GET_GAME_URL,
        handler: (req) => {
            const gameId = GET_GAME_URL.exec(req.url)?.pathname?.groups?.id ?? "";
            if (!gameId) return badRequest("Missing game id");

            const game = getGame(gameId);
            const res: GetGameResponse = {gameId: game.id, state: game.state};
            return json(res);
        },
    },

    {
        method: "POST",
        pattern: MOVE_IN_GAME_URL,
        handler: async (req) => {
            const gameId = MOVE_IN_GAME_URL.exec(req.url)?.pathname?.groups?.id ?? "";
            if (!gameId) return badRequest("Missing game id");

            const body = await readJson<MakeMoveRequest>(req);
            if (!body.clientId) return badRequest("Missing clientId");

            const result = makeMove(gameId, body.clientId, body.moveIndex);

            const res: MakeMoveResponse = {
                gameId,
                moveIndex: body.moveIndex,
                move: result.move,
                state: result.state,
            };

            return json(res);
        },
    },
    {
        method: "GET",
        pattern: WEB_SOCKET_CREATE,
        handler: (req) => {
            if (req.headers.get("upgrade") !== "websocket") {
                return new Response("Expected websocket", {status: 426});
            }

            const {socket, response} = Deno.upgradeWebSocket(req);
            handleWebSocket(socket);
            return response; // must be this exact response  [oai_citation:3‡GitHub](https://github.com/denoland/deno/issues/22333?utm_source=chatgpt.com)
        },
    }
];

let handler = route(routes, () => new Response("Not Found", {status: 404}));

Deno.serve(async (req) => {
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, {status: 204, headers: corsHeaders(req)});
    }

    const res = await handler(req);

    return withCors(req, res);
});

function json<T>(data: T, status = 200): Response {
    return Response.json(data, {
        status,
        headers: {
            "content-type": "application/json"
        },
    });
}

function badRequest(message: string): Response {
    return json({message}, 400);
}

async function readJson<T>(req: Request): Promise<T> {
    // If you want strict validation later, add a schema validator.
    return (await req.json()) as T;
}
