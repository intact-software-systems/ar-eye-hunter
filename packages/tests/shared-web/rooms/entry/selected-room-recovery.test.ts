import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { SelectedRoomRecovery } from '@shared-web/browser/rooms/entry/selected-room-recovery.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, expect, it, vi } from 'vitest';
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
    const owner = new SelectedRoomRecovery({
        selected: () => selected,
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
        select(ref: GroupRef | undefined) {
            selected = ref;
        },
        logout() {
            session = { ...session, sessionId: 'replacement' };
        }
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
