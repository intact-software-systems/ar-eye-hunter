import type {Route} from 'jsr:@std/http/unstable-route';
import {
    P2pCursor,
    P2pRole,
    P2pSessionStatus,
    P2pSignalType,
    type CreateP2pSessionRequest,
    type CreateP2pSessionResponse,
    type JoinP2pSessionRequest,
    type JoinP2pSessionResponse,
    type PostP2pSignalRequest,
    type PostP2pSignalResponse,
    type GetP2pSignalsResponse,
} from '@shared/mod.ts';

import {createSession, joinSession, postSignal, listSignalsFromPeer} from './p2p_service.ts';

function json<T>(data: T, status = 200): Response {
    return Response.json(data, {status, headers: {'content-type': 'application/json'}});
}

async function readJson<T>(req: Request): Promise<T> {
    return (await req.json()) as T;
}

function badRequest(msg: string): Response {
    return json({error: msg}, 400);
}

function unauthorized(msg: string): Response {
    return json({error: msg}, 403);
}

function serverError(msg: string): Response {
    return json({error: msg}, 500);
}

function parseLimit(url: URL): number {
    const raw = url.searchParams.get('limit');
    if (!raw) return 50;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 50;
}

const POST_P2P_SESSIONS = new URLPattern({pathname: '/api/p2p/sessions'});
const POST_P2P_SESSIONS_JOIN = new URLPattern({pathname: '/api/p2p/sessions/:sessionId/join'});
const POST_P2P_SESSION_ID_SIGNAL = new URLPattern({pathname: '/api/p2p/sessions/:sessionId/signals'});
const GET_P2P_SESSION_ID_SIGNAL = new URLPattern({pathname: '/api/p2p/sessions/:sessionId/signals'});

export function p2pRoutes(): Route[] {
    return [
        {
            method: 'POST',
            pattern: POST_P2P_SESSIONS,
            handler: async (req) => {
                try {
                    const body = await readJson<CreateP2pSessionRequest>(req);
                    if (!body.clientId || body.clientId.length === 0) return badRequest('clientId is required');

                    const meta = await createSession(body.clientId);

                    const res: CreateP2pSessionResponse = {
                        sessionId: meta.sessionId,
                        role: P2pRole.Initiator,
                        token: meta.initiator.token,
                        status: meta.status,
                        expiresAtEpochMs: meta.expiresAtEpochMs,
                    };

                    return json(res);
                } catch (e) {
                    return serverError((e as Error).message);
                }
            },
        },

        {
            method: 'POST',
            pattern: POST_P2P_SESSIONS_JOIN,
            handler: async (req) => {
                try {
                    const sessionId = POST_P2P_SESSIONS_JOIN.exec(req.url)?.pathname?.groups.sessionId;
                    if (!sessionId || sessionId.length === 0) return badRequest('sessionId is required');

                    const body = await readJson<JoinP2pSessionRequest>(req);
                    if (!body.clientId || body.clientId.length === 0) return badRequest('clientId is required');

                    const meta = await joinSession(sessionId, body.clientId);

                    const res: JoinP2pSessionResponse = {
                        sessionId: meta.sessionId,
                        role: P2pRole.Responder,
                        token: (meta.responder as { clientId: string; token: string }).token,
                        status: meta.status,
                        expiresAtEpochMs: meta.expiresAtEpochMs,
                    };

                    return json(res);
                } catch (e) {
                    const msg = (e as Error).message;
                    if (msg.includes('not found')) return json({error: msg}, 404);
                    if (msg.includes('already')) return json({error: msg}, 409);
                    return serverError(msg);
                }
            },
        },

        {
            method: 'POST',
            pattern: POST_P2P_SESSION_ID_SIGNAL,
            handler: async (req) => {
                try {
                    const sessionId = POST_P2P_SESSION_ID_SIGNAL.exec(req.url)?.pathname?.groups?.sessionId;
                    if (!sessionId || sessionId.length === 0) return badRequest('sessionId is required');

                    const body = await readJson<PostP2pSignalRequest>(req);
                    if (!body.token || body.token.length === 0) return badRequest('token is required');

                    if (!Object.values(P2pSignalType).includes(body.type)) {
                        return badRequest('Invalid signal type');
                    }

                    await postSignal(sessionId, body.token, body.type, body.payload);

                    const res: PostP2pSignalResponse = {ok: true};
                    return json(res);
                } catch (e) {
                    const msg = (e as Error).message;
                    if (msg.includes('Unauthorized')) return unauthorized(msg);
                    return serverError(msg);
                }
            },
        },

        {
            method: 'GET',
            pattern: GET_P2P_SESSION_ID_SIGNAL,
            handler: async (req) => {
                try {
                    const sessionId = GET_P2P_SESSION_ID_SIGNAL.exec(req.url)?.pathname?.groups?.sessionId;
                    if (!sessionId || sessionId.length === 0) return badRequest('sessionId is required');

                    const url = new URL(req.url);
                    const token = url.searchParams.get('token');
                    const tokenValue = token ? token : '';
                    if (tokenValue.length === 0) return badRequest('token is required');

                    const cursor = url.searchParams.get('cursor');
                    const cursorValue = cursor ? cursor : P2pCursor.NA;

                    const limit = parseLimit(url);

                    const {signals, nextCursor} = await listSignalsFromPeer(sessionId, tokenValue, cursorValue, limit);

                    const res: GetP2pSignalsResponse = {
                        signals,
                        nextCursor,
                    };

                    return json(res);
                } catch (e) {
                    const msg = (e as Error).message;
                    if (msg.includes('Unauthorized')) return unauthorized(msg);
                    return serverError(msg);
                }
            },
        },
    ];
}