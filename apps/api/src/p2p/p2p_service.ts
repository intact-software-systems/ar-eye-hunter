import { getKv } from './kv.ts';
import {
    P2pRole,
    P2pSessionStatus,
    P2pSignalType,
    type ClientId,
    type P2pSessionId,
    type P2pToken,
    type P2pSignalPayload,
    type P2pSignalRecord,
} from '@shared/mod.ts';

type SessionMeta = {
    sessionId: P2pSessionId;
    status: P2pSessionStatus;
    createdAtEpochMs: number;
    expiresAtEpochMs: number;

    initiator: { clientId: ClientId; token: P2pToken };
    responder: { clientId: ClientId; token: P2pToken } | { clientId: ''; token: '' };
};

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LIST_LIMIT_DEFAULT = 50;

function metaKey(sessionId: P2pSessionId): Deno.KvKey {
    return ['p2p', 'session', sessionId, 'meta'];
}

function authKey(sessionId: P2pSessionId, token: P2pToken): Deno.KvKey {
    return ['p2p', 'session', sessionId, 'auth', token];
}

// We store signals under the sender role so the receiver can list "the other side's" signals easily.
function signalPrefix(sessionId: P2pSessionId, fromRole: P2pRole): Deno.KvKey {
    return ['p2p', 'session', sessionId, 'signals', fromRole];
}

function signalKey(sessionId: P2pSessionId, fromRole: P2pRole, createdAtEpochMs: number, id: string): Deno.KvKey {
    return [...signalPrefix(sessionId, fromRole), createdAtEpochMs, id];
}

function nowMs(): number {
    return Date.now();
}

function newId(): string {
    return crypto.randomUUID();
}

function newToken(): P2pToken {
    return crypto.randomUUID();
}

function otherRole(role: P2pRole): P2pRole {
    return role === P2pRole.Initiator ? P2pRole.Responder : P2pRole.Initiator;
}

export async function createSession(clientId: ClientId): Promise<SessionMeta> {
    const kv = await getKv();

    const sessionId = newId();
    const token = newToken();
    const createdAt = nowMs();
    const expiresAt = createdAt + SESSION_TTL_MS;

    const meta: SessionMeta = {
        sessionId,
        status: P2pSessionStatus.WaitingForPeer,
        createdAtEpochMs: createdAt,
        expiresAtEpochMs: expiresAt,
        initiator: { clientId, token },
        responder: { clientId: '', token: '' },
    };

    await kv.set(metaKey(sessionId), meta, { expireIn: SESSION_TTL_MS });
    await kv.set(authKey(sessionId, token), P2pRole.Initiator, { expireIn: SESSION_TTL_MS });

    return meta;
}

export async function joinSession(sessionId: P2pSessionId, clientId: ClientId): Promise<SessionMeta> {
    const kv = await getKv();

    const metaEntry = await kv.get<SessionMeta>(metaKey(sessionId));
    const metaValue = metaEntry.value;
    const vs = metaEntry.versionstamp;

    if (!metaValue || !vs) throw new Error('Session not found.');
    if (metaValue.status === P2pSessionStatus.Closed) throw new Error('Session is closed.');

    // Already joined?
    if (metaValue.responder.clientId !== '') throw new Error('Session already has a responder.');

    const token = newToken();
    const updated: SessionMeta = {
        ...metaValue,
        responder: { clientId, token },
        status: P2pSessionStatus.Active,
    };

    const ttlRemaining = Math.max(0, updated.expiresAtEpochMs - nowMs());

    const commit = await kv.atomic()
        .check({ key: metaKey(sessionId), versionstamp: vs })
        .set(metaKey(sessionId), updated, { expireIn: ttlRemaining })
        .set(authKey(sessionId, token), P2pRole.Responder, { expireIn: ttlRemaining })
        .commit();

    if (!commit.ok) throw new Error('Join failed due to a race. Try again.');

    return updated;
}

export async function requireRole(sessionId: P2pSessionId, token: P2pToken): Promise<P2pRole> {
    const kv = await getKv();
    const entry = await kv.get<P2pRole>(authKey(sessionId, token));
    if (!entry.value) throw new Error('Unauthorized.');
    return entry.value;
}

export async function postSignal(
    sessionId: P2pSessionId,
    token: P2pToken,
    type: P2pSignalType,
    payload: P2pSignalPayload,
): Promise<void> {
    const kv = await getKv();

    const role = await requireRole(sessionId, token);

    const metaEntry = await kv.get<SessionMeta>(metaKey(sessionId));
    if (!metaEntry.value) throw new Error('Session not found.');
    if (metaEntry.value.status === P2pSessionStatus.Closed) throw new Error('Session is closed.');

    const createdAt = nowMs();
    const id = newId();

    const record: P2pSignalRecord = {
        fromRole: role,
        type,
        payload,
        createdAtEpochMs: createdAt,
    };

    const ttlRemaining = Math.max(0, metaEntry.value.expiresAtEpochMs - createdAt);

    await kv.set(signalKey(sessionId, role, createdAt, id), record, { expireIn: ttlRemaining });
}

export async function listSignalsFromPeer(
    sessionId: P2pSessionId,
    token: P2pToken,
    cursor: string,
    limit: number,
): Promise<{ signals: P2pSignalRecord[]; nextCursor: string }> {
    const kv = await getKv();

    const role = await requireRole(sessionId, token);
    const peer = otherRole(role);

    const safeLimit = Math.max(1, Math.min(limit, LIST_LIMIT_DEFAULT));

    const iter = kv.list<P2pSignalRecord>(
        { prefix: signalPrefix(sessionId, peer) },
        { cursor: cursor.length > 0 ? cursor : undefined, limit: safeLimit },
    );

    const out: P2pSignalRecord[] = [];
    for await (const entry of iter) {
        out.push(entry.value);
    }

    // Deno.KvListIterator exposes a cursor you can use for pagination.  [oai_citation:4‡Deno](https://docs.deno.com/api/deno/~/Deno.Kv)
    const next = iter.cursor ?? '';

    return { signals: out, nextCursor: next };
}
