import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { SelectedRoomRecovery } from '@shared-web/browser/rooms/entry/selected-room-recovery.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, expect, it, vi } from 'vitest';
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

function fixture() {
    configureApiClient({ apiBaseUrl: '' });
    const ctx = createDefaultApiMiddlewareTestDouble({ session: { clientId: 'watcher', sessionId: 'watcher' } });
    let selected: GroupRef | undefined = room;
    let session = ctx.session;
    const adopted: GroupSnapshot[] = [];
    const timers = createManualTimers(0);
    const owner = new SelectedRoomRecovery({
        selected: () => selected,
        timers,
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
        const { generationId, connectionGenerationId } = JSON.parse(String(init?.body));
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
        const { generationId, connectionGenerationId } = JSON.parse(String(init?.body));
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
        const { generationId, connectionGenerationId } = JSON.parse(String(init?.body));
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
    const warnings: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args));
    const test = fixture();
    const reads: string[] = [];
    let summarised = snapshot;
    const written = atPresenceRevision(snapshot, 5);
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') {
            reads.push(String(url));
            return pointRead(summarised);
        }
        const { generationId, connectionGenerationId } = JSON.parse(String(init?.body));
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
    const warnings: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args));
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
    expect(warnings).toEqual([[
        'Selected room presence recovery failed',
        expect.objectContaining({ message: 'Selected room did not confirm presence on the replacement socket.' })
    ]]);
    expect(methods).toEqual(['GET', 'PUT']);
    expect(test.adopted).toEqual([]);
});
