import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { decodeJsonWireText } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { SelectedRoomRecovery } from '@shared-web/browser/rooms/entry/selected-room-recovery.ts';
import type { RallarGroupPresencePolicy } from '@shared-web/browser/session/group-presence-policy.ts';
import { isApiJsonObject } from '@shared/api/api-json-value.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createManualTimers } from '../../../shared/resilience/manual-timers.ts';
import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'selected' };
const initial = createGroupSnapshotFixture({ ...room, sessionIds: ['owner', 'watcher'] });
const snapshot: GroupSnapshot = {
    ...initial,
    onlineMemberCount: 1,
    members: initial.members.map((member) => member.principalId === 'watcher' ? { ...member, role: 'spectator' } : member),
    activeSessions: initial.activeSessions.filter((row) => row.principalId !== 'watcher')
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function fixture(groupPresence?: RallarGroupPresencePolicy) {
    configureApiClient({ apiBaseUrl: '' });
    let ctx = createDefaultApiMiddlewareTestDouble({
        session: { clientId: 'watcher', sessionId: 'watcher' },
        middleware: { heartbeat: { groupPresence } }
    });
    let selected: GroupRef | undefined = room;
    let session = ctx.session;
    const adopted: GroupSnapshot[] = [];
    const timers = createManualTimers(0);
    const owner = new SelectedRoomRecovery({
        selected: () => selected,
        timers,
        newPresenceGenerationId: () => crypto.randomUUID(),
        requireSession: () => session,
        connect: async () => ctx,
        readPublicationKey: async () => null,
        acceptSnapshots: async (input) => {
            input.assertCurrent?.();
            expect(input.currentRoom).toBeUndefined();
            adopted.push(...input.groups);
        }
    });
    return {
        owner,
        adopted,
        timers,
        select(ref: GroupRef | undefined) {
            selected = ref;
        },
        logout() {
            session = { ...session, sessionId: 'replacement' };
        },
        replaceSession() {
            ctx = createDefaultApiMiddlewareTestDouble({
                session: { clientId: 'watcher', sessionId: 'replacement' },
                middleware: { heartbeat: { groupPresence } }
            });
            session = ctx.session;
        }
    };
}

function atPresenceRevision(body: GroupSnapshot, presenceRevision: number): GroupSnapshot {
    return {
        ...body,
        causalRevision: { ...body.causalRevision, presenceRevision },
        group: { ...body.group, presenceVersion: presenceRevision }
    };
}

function pointRead(body: GroupSnapshot): Response {
    return Response.json(body, {
        headers: {
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(body.causalRevision.groupRevision),
            'rallar-presence-revision': String(body.causalRevision.presenceRevision)
        }
    });
}

it('restores only the selected spectator presence before a concurrent departure reads its generation', async () => {
    const test = fixture();
    const issued = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<void>();
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        paths.push(String(url));
        if (init?.method === 'GET') {
            return pointRead(snapshot);
        }
        const { generationId, connectionGenerationId } = decodePresenceRequest(init?.body);
        expect(connectionGenerationId).toBe('ws-generation-watcher');
        issued.resolve();
        await receipt.promise;
        return Response.json({
            ...snapshot,
            onlineMemberCount: 2,
            activeSessions: [...snapshot.activeSessions, { ...initial.activeSessions[1], generationId, connectionGenerationId }]
        });
    });
    test.owner.onSocket('close');
    test.owner.onSocket('open');
    test.owner.onSocket('connected');
    await issued.promise;
    const leaving = test.owner.changeRoom(async () => {
        expect(test.adopted.at(-1)?.members.find((member) => member.principalId === 'watcher')?.role).toBe('spectator');
        test.select(undefined);
    });
    receipt.resolve();
    await leaving;
    expect(paths).toEqual([
        '/api/state/apps/app/workspaces/workspace/groups/selected',
        expect.stringMatching(/^\/api\/state\/apps\/app\/workspaces\/workspace\/groups\/selected\/sessions\/watcher\/requests\/[^/]+$/)
    ]);
});

it.each(['revoked', 'logout', 'same-room-reselected'] as const)('refuses presence after %s during the point read', async (reason) => {
    const test = fixture();
    const issued = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        issued.resolve();
        return await response.promise;
    });
    test.owner.onSocket('close');
    test.owner.onSocket('open');
    await issued.promise;
    if (reason === 'logout') {
        test.logout();
    }
    if (reason === 'same-room-reselected') {
        test.select({ ...room });
    }
    response.resolve(pointRead(reason === 'revoked' ? createGroupSnapshotFixture({ ...room, sessionIds: ['owner'] }) : snapshot));
    await test.owner.changeRoom(async () => {});
    expect(methods).toEqual(['GET']);
    expect(test.adopted).toEqual([]);
});

it('never recovers a membership inferred from elsewhere or a room selected after the outage', async () => {
    const test = fixture();
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
        paths.push(String(url));
        return pointRead(snapshot);
    });
    test.select(undefined);
    test.owner.onSocket('close');
    test.select(room);
    test.owner.onSocket('open');
    await test.owner.changeRoom(async () => {});
    expect(paths).toEqual([]);
});

it('restores an authorized selected room after silent expiry without a socket-close event', async () => {
    const test = fixture();
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET') {
            return pointRead(snapshot);
        }
        const { generationId, connectionGenerationId } = decodePresenceRequest(init?.body);
        return Response.json({
            ...snapshot,
            onlineMemberCount: 2,
            activeSessions: [...snapshot.activeSessions, { ...initial.activeSessions[1], generationId, connectionGenerationId }]
        });
    });
    test.owner.onSocket('connected');
    test.owner.observePresence(snapshot);
    await test.owner.changeRoom(async () => {});
    expect(methods).toEqual(['GET', 'PUT']);
    expect(test.adopted.at(-1)?.activeSessions.some((row) => row.principalId === 'watcher')).toBe(true);
});

it.each(['delayed receipt', 'lost receipt', 'expired rejection'] as const)('resolves an expired %s before issuing fresh presence', async (failure) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const test = fixture({ leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 });
    const issued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: { url: string; body: string; }[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') {
            return pointRead(snapshot);
        }
        const request = decodePresenceRequest(init?.body);
        requests.push({ url: String(url), body: String(init?.body) });
        if (requests.length === 1) {
            issued.resolve();
            await release.promise;
            if (failure === 'lost receipt') {
                throw new TypeError('Committed receipt was lost.');
            }
            if (failure === 'expired rejection') {
                return new Response('Presence expiry has elapsed.', { status: 400 });
            }
        }
        return Response.json({
            ...snapshot,
            onlineMemberCount: 2,
            activeSessions: [...snapshot.activeSessions, { ...initial.activeSessions[1], ...request }]
        });
    });
    test.owner.onSocket('connected');
    test.owner.observePresence(snapshot);
    await issued.promise;
    await test.timers.advance(9_000);
    release.resolve();
    await test.owner.changeRoom(async () => {});
    expect(test.adopted).toEqual([]);
    if (failure === 'lost receipt') {
        expect(requests[1]).toEqual(requests[0]);
    }
    await test.timers.advance(1_000);
    await test.owner.changeRoom(async () => {});
    expect(requests.at(-1)?.url).not.toBe(requests[0].url);
    const restored = test.adopted.at(-1)?.activeSessions.find((row) => row.principalId === 'watcher');
    expect(restored?.expiresAtEpochMs).toBe(18_000);
});

it('aborts a stalled presence write at the configured deadline without adopting it', async () => {
    const test = fixture({ leaseMs: 1_000, renewalIntervalMs: 100, requestTimeoutMs: 50, retryMs: 50 });
    const aborted = Promise.withResolvers<void>();
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET') {
            return pointRead(snapshot);
        }
        const signal = init?.signal;
        if (!signal) {
            throw new Error('Presence recovery must supply cancellation to HTTP.');
        }
        signal.throwIfAborted();
        return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                aborted.resolve();
                reject(signal.reason);
            }, { once: true });
        });
    });
    test.owner.onSocket('connected');
    test.owner.observePresence(snapshot);
    await aborted.promise;
    test.select(undefined);
    await test.owner.changeRoom(async () => {});
    expect(methods).toEqual(['GET', 'PUT']);
    expect(test.adopted).toEqual([]);
}, 1_000);

it.each(['selection', 'session'] as const)('does not let an unresolved receipt block a new %s', async (replacement) => {
    const issued = Promise.withResolvers<void>();
    const test = fixture({ leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 });
    let unavailable = true;
    let firstRead = true;
    let current = snapshot;
    const writes: string[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') {
            if (!firstRead && unavailable) {
                return new Response('Unavailable', { status: 503 });
            }
            firstRead = false;
            return pointRead(current);
        }
        writes.push(String(url));
        if (unavailable) {
            issued.resolve();
            throw new TypeError('Receipt lost');
        }
        const request = decodePresenceRequest(init?.body);
        return Response.json({
            ...current,
            onlineMemberCount: 2,
            activeSessions: [...current.activeSessions, {
                ...initial.activeSessions[1],
                groupId: current.group.groupId,
                sessionId: replacement === 'session' ? 'replacement' : 'watcher',
                ...request
            }]
        });
    });
    test.owner.onSocket('connected');
    test.owner.observePresence(snapshot);
    await issued.promise;
    await expect(test.owner.changeRoom(async () => {})).rejects.toMatchObject({ status: 503 });
    unavailable = false;
    if (replacement === 'selection') {
        const next = { ...room, groupId: 'another' };
        current = {
            ...snapshot,
            group: { ...snapshot.group, ...next },
            members: snapshot.members.map((member) => ({ ...member, groupId: next.groupId })),
            activeSessions: snapshot.activeSessions.map((row) => ({ ...row, groupId: next.groupId }))
        };
        test.select(next);
    }
    else {
        test.replaceSession();
    }
    await test.owner.changeRoom(async () => {});
    test.owner.observePresence(current);
    await test.timers.advance(1_000);
    await test.owner.changeRoom(async () => {});
    const restored = test.adopted.at(-1);
    expect(restored?.group.groupId).toBe(current.group.groupId);
    expect(restored?.activeSessions.find((row) => row.principalId === 'watcher')?.sessionId)
        .toBe(replacement === 'session' ? 'replacement' : 'watcher');
    expect(writes).toHaveLength(2);
    expect(writes[1]).not.toBe(writes[0]);
});

it('recovers the committed generation after all PUT replies are lost before switching rooms', async () => {
    const test = fixture();
    const issued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let durable = snapshot;
    const identities = new Set<string>();
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') {
            return pointRead(durable);
        }
        identities.add(String(url));
        const { generationId, connectionGenerationId } = decodePresenceRequest(init?.body);
        durable = {
            ...snapshot,
            onlineMemberCount: 2,
            activeSessions: [...snapshot.activeSessions, { ...initial.activeSessions[1], generationId, connectionGenerationId }]
        };
        issued.resolve();
        await release.promise;
        throw new TypeError('Connection lost after commit');
    });
    test.owner.onSocket('close');
    test.owner.onSocket('open');
    await issued.promise;
    const leaving = test.owner.changeRoom(async () => {
        expect(test.adopted).toEqual([durable]);
        test.select(undefined);
    });
    release.resolve();
    await leaving;
    expect(identities.size).toBe(1);
});

it('does not hold a replacement account behind a previous account’s outstanding read', async () => {
    const test = fixture();
    const issued = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', async () => {
        issued.resolve();
        return await reply.promise;
    });
    test.owner.onSocket('close');
    test.owner.onSocket('open');
    await issued.promise;
    test.logout();
    await test.owner.changeRoom(async () => test.select(undefined));
    reply.resolve(pointRead(snapshot));
    expect(test.adopted).toEqual([]);
});

it('retries a transiently failed restore on the same socket instead of staying absent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const test = fixture();
    let unavailable = 3;
    const reads = Promise.withResolvers<void>();
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET') {
            if (unavailable > 0) {
                unavailable--;
                if (unavailable === 0) {
                    reads.resolve();
                }
                return new Response('unavailable', { status: 503 });
            }
            return pointRead(snapshot);
        }
        const { generationId, connectionGenerationId } = decodePresenceRequest(init?.body);
        return Response.json({
            ...snapshot,
            onlineMemberCount: 2,
            activeSessions: [...snapshot.activeSessions, { ...initial.activeSessions[1], generationId, connectionGenerationId }]
        });
    });
    test.owner.onSocket('close');
    test.owner.onSocket('open');
    await reads.promise;
    await test.owner.changeRoom(async () => {});
    expect(test.adopted).toEqual([]);
    await test.timers.advance(1_000);
    await test.owner.changeRoom(async () => {});
    expect(methods).toEqual(['GET', 'GET', 'GET', 'GET', 'PUT']);
    expect(test.adopted.at(-1)?.activeSessions.some((row) => row.principalId === 'watcher')).toBe(true);
});

it('adopts the written generation once the presence summary catches up with a reply that omits it', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: string, error: Error) => {
        warnings.push(`${message}: ${error.message}`);
    });
    const test = fixture();
    const reads: string[] = [];
    let summarised = snapshot;
    const written = atPresenceRevision(snapshot, 5);
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') {
            reads.push(String(url));
            return pointRead(summarised);
        }
        const { generationId, connectionGenerationId } = decodePresenceRequest(init?.body);
        // The presence row commits before the worker rebuilds the summary the reply is read from.
        summarised = {
            ...atPresenceRevision(snapshot, 6),
            onlineMemberCount: 2,
            activeSessions: [...snapshot.activeSessions, { ...initial.activeSessions[1], generationId, connectionGenerationId }]
        };
        return Response.json(written);
    });
    test.owner.onSocket('close');
    test.owner.onSocket('open');
    await test.owner.changeRoom(async () => {});
    expect(warnings).toEqual([]);
    expect(test.adopted).toEqual([summarised]);
    expect(reads.at(-1)).toContain('minPresenceRevision=5');
});

it('ends the attempt without polling when the reply names another room', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: string, error: Error) => {
        warnings.push(`${message}: ${error.message}`);
    });
    const test = fixture();
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'GET') {
            return pointRead(snapshot);
        }
        return Response.json({ ...snapshot, group: { ...snapshot.group, workspaceId: 'elsewhere' } });
    });
    test.owner.onSocket('close');
    test.owner.onSocket('open');
    await test.owner.changeRoom(async () => {});
    expect(warnings).toEqual([
        'Selected room presence recovery failed: Selected room did not confirm presence on the replacement socket.'
    ]);
    expect(methods).toEqual(['GET', 'PUT']);
    expect(test.adopted).toEqual([]);
});

interface DecodedPresenceRequest {
    readonly generationId: string;
    readonly connectionGenerationId: string;
    readonly expiresAtEpochMs: number;
}

function decodePresenceRequest(body: RequestInit['body']): DecodedPresenceRequest {
    const parsed = decodeJsonWireText(String(body));
    if (
        !isApiJsonObject(parsed) || typeof parsed.generationId !== 'string' ||
        typeof parsed.connectionGenerationId !== 'string' || typeof parsed.expiresAtEpochMs !== 'number'
    ) {
        throw new Error('Expected a complete presence request.');
    }
    return {
        generationId: parsed.generationId,
        connectionGenerationId: parsed.connectionGenerationId,
        expiresAtEpochMs: parsed.expiresAtEpochMs
    };
}
