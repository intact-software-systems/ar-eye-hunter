import {
    P2pRole,
    P2pSignalType,
    WsChannel,
    P2pWsClientMsgType,
    P2pWsServerMsgType,
    type P2pWsClientMessage,
    type P2pWsServerMessage,
    type P2pSessionId,
} from "@shared/mod.ts";

import { requireRole } from "./p2p_service.ts";
import { getKv } from "./kv.ts";

type RoleSockets = { initiator?: WebSocket; responder?: WebSocket };
const hub = new Map<P2pSessionId, RoleSockets>();

function send(ws: WebSocket, msg: P2pWsServerMessage): void {
    ws.send(JSON.stringify(msg));
}

function other(role: P2pRole): P2pRole {
    return role === P2pRole.Initiator ? P2pRole.Responder : P2pRole.Initiator;
}

/** Optional buffering if peer not connected */
function bufferKey(sessionId: string, toRole: P2pRole, ts: number, id: string): Deno.KvKey {
    return ["p2p", "session", sessionId, "wsbuffer", toRole, ts, id];
}

export async function handleP2pWs(ws: WebSocket): Promise<void> {
    let sessionId: string = "";
    let myRole: P2pRole | null = null;

    ws.addEventListener("message", async (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : "";
        let msg: P2pWsClientMessage;
        try {
            msg = JSON.parse(raw) as P2pWsClientMessage;
        } catch {
            return;
        }

        if (msg.channel !== WsChannel.P2pSignal) return;

        if (msg.type === P2pWsClientMsgType.Hello) {
            sessionId = msg.sessionId;

            try {
                myRole = await requireRole(sessionId, msg.token);

                const slot = hub.get(sessionId) ?? {};
                if (myRole === P2pRole.Initiator) slot.initiator = ws;
                if (myRole === P2pRole.Responder) slot.responder = ws;
                hub.set(sessionId, slot);

                send(ws, {
                    channel: WsChannel.P2pSignal,
                    type: P2pWsServerMsgType.Welcome,
                    sessionId,
                    role: myRole,
                });

                // Drain any buffered messages waiting for me
                const kv = await getKv();
                const prefix: Deno.KvKey = ["p2p", "session", sessionId, "wsbuffer", myRole];
                for await (const entry of kv.list<P2pWsServerMessage>({ prefix })) {
                    send(ws, entry.value);
                    await kv.delete(entry.key);
                }
            } catch (e) {
                send(ws, {
                    channel: WsChannel.P2pSignal,
                    type: P2pWsServerMsgType.Error,
                    sessionId,
                    message: (e as Error).message,
                });
            }

            return;
        }

        if (msg.type === P2pWsClientMsgType.Signal) {
            if (!sessionId) return;

            try {
                const role = await requireRole(msg.sessionId, msg.token);

                // Basic validation
                if (!Object.values(P2pSignalType).includes(msg.signalType)) {
                    send(ws, {
                        channel: WsChannel.P2pSignal,
                        type: P2pWsServerMsgType.Error,
                        sessionId: msg.sessionId,
                        message: "Invalid signal type",
                    });
                    return;
                }

                const out: P2pWsServerMessage = {
                    channel: WsChannel.P2pSignal,
                    type: P2pWsServerMsgType.Signal,
                    sessionId: msg.sessionId,
                    fromRole: role,
                    signalType: msg.signalType,
                    payload: msg.payload,
                };

                const sockets = hub.get(msg.sessionId) ?? {};
                const peerRole = other(role);
                const peerWs = peerRole === P2pRole.Initiator ? sockets.initiator : sockets.responder;

                if (peerWs && peerWs.readyState === WebSocket.OPEN) {
                    send(peerWs, out);
                } else {
                    // Buffer for later delivery (TTL should match session TTL; we’ll keep it short here)
                    const kv = await getKv();
                    const ts = Date.now();
                    const id = crypto.randomUUID();
                    await kv.set(bufferKey(msg.sessionId, peerRole, ts, id), out, { expireIn: 10 * 60 * 1000 });
                }
            } catch (e) {
                send(ws, {
                    channel: WsChannel.P2pSignal,
                    type: P2pWsServerMsgType.Error,
                    sessionId: msg.sessionId,
                    message: (e as Error).message,
                });
            }
            return;
        }
    });

    const cleanup = () => {
        if (!sessionId || !myRole) return;
        const slot = hub.get(sessionId);
        if (!slot) return;

        if (myRole === P2pRole.Initiator && slot.initiator === ws) delete slot.initiator;
        if (myRole === P2pRole.Responder && slot.responder === ws) delete slot.responder;

        if (!slot.initiator && !slot.responder) hub.delete(sessionId);
        else hub.set(sessionId, slot);
    };

    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
}