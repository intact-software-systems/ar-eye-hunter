import { tictactoeWebRtcWebSocketHandler } from './services/tictactoe-webrtc-req-handler.ts';
import { route, type Route } from 'jsr:@std/http/unstable-route';

import {
    CreateGameRequest,
    CreateGameResponse,
    GetGameResponse,
    JoinGameRequest,
    JoinGameResponse,
    MakeMoveRequest,
    MakeMoveResponse,
} from "@shared/mod.ts";

import { createGame, getGame, joinGame, makeMove } from "./services/tictactoe-game.ts";

const routes: Route[] = [
    {
        method: "POST",
        pattern: new URLPattern({pathname: '/signalling'}),
        handler: (req, _info) =>
            tictactoeWebRtcWebSocketHandler(req)
    },
    {
        method: "POST",
        pattern: new URLPattern({ pathname: "/api/games" }),
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
        pattern: new URLPattern({ pathname: "/api/games/:id/join" }),
        handler: async (req, _info, match) => {
            const gameId = match?.pathname.groups.id ?? "";
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
        pattern: new URLPattern({ pathname: "/api/games/:id" }),
        handler: (req, _info, match) => {
            const gameId = match?.pathname.groups.id ?? "";
            if (!gameId) return badRequest("Missing game id");

            const game = getGame(gameId);
            const res: GetGameResponse = { gameId: game.id, state: game.state };
            return json(res);
        },
    },

    {
        method: "POST",
        pattern: new URLPattern({ pathname: "/api/games/:id/move" }),
        handler: async (req, _info, match) => {
            const gameId = match?.pathname.groups.id ?? "";
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
];

Deno.serve(route(routes, () => new Response("Not Found", { status: 404 })));



function json<T>(data: T, status = 200): Response {
    return Response.json(data, {
        status,
        headers: {
            "content-type": "application/json",
            // tighten later; for now keep it simple
            "access-control-allow-origin": "*",
        },
    });
}

function badRequest(message: string): Response {
    return json({ message }, 400);
}

async function readJson<T>(req: Request): Promise<T> {
    // If you want strict validation later, add a schema validator.
    return (await req.json()) as T;
}
