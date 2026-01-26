import type {WsClientMessage, WsServerMessage} from "@shared/mod.ts";
import {WsClientMsgType, WsServerMsgType, Player} from "@shared/mod.ts";

type GameId = string;

type Hub = Map<GameId, Set<WebSocket>>;

const hub: Hub = new Map();

function addSocket(gameId: GameId, ws: WebSocket): void {
    const set = hub.get(gameId);
    if (set) {
        set.add(ws);
        return;
    }
    hub.set(gameId, new Set([ws]));
}

function removeSocket(gameId: GameId, ws: WebSocket): void {
    const set = hub.get(gameId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) hub.delete(gameId);
}

function send(ws: WebSocket, msg: WsServerMessage): void {
    ws.send(JSON.stringify(msg));
}

function broadcast(gameId: GameId, msg: WsServerMessage): void {
    const set = hub.get(gameId);
    if (!set) return;
    const payload = JSON.stringify(msg);
    for (const ws of set) {
        ws.send(payload);
    }
}

function safeParse(text: string): WsClientMessage | null {
    try {
        return JSON.parse(text) as WsClientMessage;
    } catch {
        return null;
    }
}

// You already have these service functions:
import {getGame, makeMove} from "../services/tictactoe-game.ts";

export function handleWebSocket(ws: WebSocket): void {
    let subscribedGameId: GameId | "" = "";

    ws.addEventListener("message", (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : "";
        const msg = safeParse(raw);

        if (!msg) {
            send(ws, {type: WsServerMsgType.Error, gameId: subscribedGameId || "", message: "Invalid JSON"});
            return;
        }

        switch (msg.type) {
            case WsClientMsgType.Hello: {
                const gameId = msg.gameId;
                subscribedGameId = gameId;

                addSocket(gameId, ws);

                try {
                    const game = getGame(gameId);

                    // If you track ownership in service, you can compute assigned player:
                    // here we keep it simple and send Player.NA if unknown.
                    // (Better: return assignedPlayer from join/create and store it client-side.)
                    const welcome: WsServerMessage = {
                        type: WsServerMsgType.Welcome,
                        gameId,
                        assignedPlayer: Player.NA,
                        state: game.state,
                    };
                    send(ws, welcome);
                } catch (e) {
                    send(ws, {type: WsServerMsgType.Error, gameId, message: (e as Error).message});
                }
                return;
            }

            case WsClientMsgType.MakeMove: {
                const gameId = msg.gameId;

                // Ensure subscription (optional strictness)
                if (subscribedGameId !== gameId) {
                    send(ws, {type: WsServerMsgType.Error, gameId, message: "Not subscribed to this gameId"});
                    return;
                }

                try {
                    const result = makeMove(gameId, msg.clientId, msg.moveIndex);

                    const update: WsServerMessage = {
                        type: WsServerMsgType.StateUpdate,
                        gameId,
                        move: result.move,
                        state: result.state,
                    };

                    broadcast(gameId, update);
                } catch (e) {
                    send(ws, {type: WsServerMsgType.Error, gameId, message: (e as Error).message});
                }
                return;
            }
        }
    });

    ws.addEventListener("close", () => {
        if (subscribedGameId) {
            removeSocket(subscribedGameId, ws);
        }
    });

    ws.addEventListener("error", () => {
        if (subscribedGameId) {
            removeSocket(subscribedGameId, ws);
        }
    });
}
