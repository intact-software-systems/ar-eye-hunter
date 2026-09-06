import type { LocalWsMessage } from '@shared-test/black-box-runner/execution/local-websocket-frame.ts';
import { closeWs, openWs, type LocalWsContext } from '@shared-test/black-box-runner/execution/local-websocket-session.ts';
import { waitForWsMessage, waitForWsMessageAbsence } from '@shared-test/black-box-runner/ws/ws-wait-expectations.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { computeStateSnapshotPages } from '@shared/api/state-snapshot-page.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createClientSnapshot, createGroupSnapshot } from '../shared-web/state-cache/browser-state-cache-lifecycle-fixtures.ts';
import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';

const NativeWebSocket = globalThis.WebSocket;
const scope = { applicationId: 'app', workspaceId: 'workspace' };
const groupRef = { ...scope, groupId: 'group' };
const interaction = {
    request: { url: 'ws://localhost/api/ws/session-1?ticket=test&applicationId=app&workspaceId=workspace', connection: 'session', snapshotScope: scope }
};
const config = { interactionName: 'open', interaction: { request: {} } };
let context: LocalWsContext;

async function openSession(snapshotScope = scope): Promise<TestWebSocket> {
    const url = new URL(interaction.request.url);
    url.searchParams.set('applicationId', snapshotScope.applicationId);
    url.searchParams.set('workspaceId', snapshotScope.workspaceId);
    const opening = openWs({ request: { ...interaction.request, url: url.href, snapshotScope } }, config, context);
    const socket = TestWebSocket.instances.at(-1)!;
    socket.open();
    await opening;
    return socket;
}

interface LocalTopologyPublicationInput {
    readonly resource?: string;
    readonly messageId?: string;
    readonly targets?: ALMessage['targets'];
}

function topologyPages(input: LocalTopologyPublicationInput = {}): readonly ALMessage[] {
    const nowMs = Date.now();
    const activeSessionIds = Array.from({ length: 1500 }, (_, index) => `session-${index + 1}`).sort();
    const snapshot: RallarOverlayTopologySnapshot = {
        groupRef,
        overlayId: toScopedOverlayId(groupRef),
        sourceGroupStateCausalRevision: { groupRevision: 3, presenceRevision: 4 },
        version: 5,
        state: 'active',
        name: 'Local session',
        topology: 'tree',
        degreeLimit: 2,
        createdByClientId: 'client',
        createdAtEpochMs: nowMs,
        updatedAtEpochMs: nowMs,
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(activeSessionIds.map((id, index) => [
            id,
            activeSessionIds.slice(Math.max(0, index - 1), index).concat(activeSessionIds.slice(index + 1, index + 2))
        ]))
    };
    return computeStateSnapshotPages({
        scope: { ...scope, kind: 'group', resourceId: groupRef.groupId },
        revision: '[3,4,5]',
        resource: input.resource ?? JSON.stringify(snapshot),
        envelope: {
            id: { v: 2, msgId: input.messageId ?? 'publication', ts: nowMs, senderId: 'api-node-17' },
            route: { topicId: 'overlay.topology', contextId: groupRef.groupId, resourceId: 'topology' },
            targets: input.targets ?? { mode: 'unicast', toPeerId: 'session-1' },
            constraints: { expiresAtMs: nowMs + 60_000 },
            delivery: { reliability: 'best-effort', ack: 'none' },
            audit: { createdBy: 'api-node-17', createdTs: nowMs }
        }
    }).fold((issue) => {
        throw new Error(issue.message);
    }, (pages) => pages);
}

function readCompletedSnapshots(): LocalWsMessage['data'][] {
    return context.wsMessages.session?.flatMap((message) => {
        const data = message.data;
        return data !== null && typeof data === 'object' && 'completedSnapshot' in data ? [data] : [];
    }) ?? [];
}

beforeEach(() => {
    TestWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', TestWebSocket);
    context = { wsConnections: {}, wsMessages: {}, wsCloseEvents: {} };
});
afterEach(async () => {
    await closeWs(interaction, config, context);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it.each([
    { outcome: 'refused', expectedStatus: 'SUCCESS' },
    { outcome: 'opened', expectedStatus: 'FAILURE' },
    { outcome: 'errored', expectedStatus: 'FAILURE' },
    { outcome: 'timedOut', expectedStatus: 'FAILURE' }
])('reports an expected upgrade rejection after $outcome without retaining a connection', async ({ outcome, expectedStatus }) => {
    const opening = openWs(
        {
            request: { ...interaction.request, timeoutMs: 5 },
            response: { rejected: true, close: { code: 1008, reason: 'unauthorized' } }
        },
        config,
        context
    );
    const socket = TestWebSocket.instances.at(-1)!;
    if (outcome === 'refused') {
        socket.disconnect(1008, 'unauthorized');
    }
    else if (outcome === 'opened') {
        socket.open();
    }
    else if (outcome === 'errored') {
        socket.dispatchEvent(new Event('error'));
    }
    expect(await opening).toMatchObject({ status: expectedStatus });
    expect(context.wsConnections.session).toBeUndefined();
    expect(context.wsSnapshotAssemblies?.session).toBeUndefined();
});

it('rejects a malformed open expectation before creating a WebSocket', async () => {
    expect(await openWs({ ...interaction, response: { close: { code: '1008' } } }, config, context))
        .toMatchObject({ status: 'FAILURE' });
    expect(TestWebSocket.instances).toHaveLength(0);
});

it('keeps raw pages separate and exposes only the complete validated 1500-session snapshot', async () => {
    const socket = await openSession();
    const pages = topologyPages();
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages.slice(1).toReversed()) {
        socket.receive(JSON.stringify(page));
    }
    expect(readCompletedSnapshots()).toEqual([]);
    expect(context.wsMessages.session?.[0].wireFrame).toBe(JSON.stringify(pages.at(-1)));
    socket.receive(JSON.stringify(pages[0]));
    expect(readCompletedSnapshots()).toEqual([{
        completedSnapshot: expect.objectContaining({
            originalMessageId: 'publication',
            topicId: 'overlay.topology',
            scope: { ...scope, kind: 'group', resourceId: groupRef.groupId },
            snapshot: expect.objectContaining({ activeSessionIds: expect.any(Array) })
        })
    }]);
    for (const page of pages) {
        socket.receive(JSON.stringify(page));
    }
    expect(readCompletedSnapshots()).toHaveLength(1);
});

it('rejects cross-scope pages and domain-invalid complete snapshots', async () => {
    const socket = await openSession({ ...scope, workspaceId: 'another-workspace' });
    for (const page of topologyPages()) {
        socket.receive(JSON.stringify(page));
    }
    expect(readCompletedSnapshots()).toEqual([]);
    expect(context.wsMessages.session?.at(-1)?.rejection).toBeDefined();
    const replacement = await openSession();
    for (const page of topologyPages({ resource: '{}' })) {
        replacement.receive(JSON.stringify(page));
    }
    expect(readCompletedSnapshots()).toEqual([]);
    expect(context.wsMessages.session?.at(-1)?.rejection?.code).toBe('malformed');
});

it.each([{ applicationId: 1 }, { ...scope, workspaceId: '{workspaceId}' }, null, ['app', 'workspace']])(
    'validates recipe scope before opening a connection: %j',
    async (snapshotScope) => {
        const result = await openWs({ request: { ...interaction.request, snapshotScope } }, config, context);
        expect(result).toMatchObject({ status: 'FAILURE' });
        expect(TestWebSocket.instances).toHaveLength(0);
    }
);

it('rejects oversized ALM text before parsing and binary input without converting it', async () => {
    const socket = await openSession();
    const parse = vi.spyOn(JSON, 'parse');
    socket.receive('x'.repeat(128 * 1024 + 1));
    expect(parse).not.toHaveBeenCalled();
    const blob = new Blob(['x'.repeat(128 * 1024 + 1)]);
    const convert = vi.spyOn(blob, 'text');
    socket.dispatchEvent(new MessageEvent('message', { data: blob }));
    expect(convert).not.toHaveBeenCalled();
    expect(context.wsMessages.session?.at(-1)?.rejection?.code).toBe('oversized');
    expect(readCompletedSnapshots()).toEqual([]);
});

it('does not apply the ALM envelope cap to generic WebSocket traffic', async () => {
    const opening = openWs({ request: { url: interaction.request.url, connection: 'session' } }, config, context);
    const socket = TestWebSocket.instances.at(-1)!;
    socket.open();
    await opening;
    const value = { text: 'x'.repeat(150_000) };
    socket.receive(JSON.stringify(value));
    expect(context.wsMessages.session?.map((message) => message.data)).toEqual([value]);
});

it('disposes fragments on replacement and ignores late frames from the old connection', async () => {
    const first = await openSession();
    const pages = topologyPages();
    first.receive(JSON.stringify(pages[0]));
    const second = await openSession();
    for (const page of pages.slice(1)) {
        second.receive(JSON.stringify(page));
    }
    first.receive(JSON.stringify(pages[0]));
    expect(readCompletedSnapshots()).toEqual([]);
    second.receive(JSON.stringify(pages[0]));
    expect(readCompletedSnapshots()).toHaveLength(1);
    await closeWs(interaction, config, context);
    expect(context.wsSnapshotAssemblies?.session).toBeUndefined();
});

it('waits for completed authority rather than matching a partial page', async () => {
    const socket = await openSession();
    const pages = topologyPages();
    socket.receive(JSON.stringify(pages[0]));
    const waitInteraction = {
        request: interaction.request,
        response: { connection: 'session', withinMs: 30, message: { completedSnapshot: { typeId: 'overlay.topology' } } }
    };
    expect(await waitForWsMessage({ interaction: waitInteraction, config, context })).toMatchObject({ status: 'FAILURE' });
    for (const page of pages.slice(1)) {
        socket.receive(JSON.stringify(page));
    }
    expect(await waitForWsMessage({ interaction: waitInteraction, config, context })).toMatchObject({ status: 'SUCCESS' });
});

it.each(['close', 'error', 'replace'])('retires completed matches on connection %s', async (ending) => {
    const socket = await openSession();
    for (const page of topologyPages()) {
        socket.receive(JSON.stringify(page));
    }
    expect(readCompletedSnapshots()).toHaveLength(1);
    if (ending === 'close') {
        socket.disconnect(1000, 'done');
    }
    else if (ending === 'error') {
        socket.dispatchEvent(new Event('error'));
    }
    else {
        await openSession();
    }
    expect(readCompletedSnapshots()).toEqual([]);
    expect(context.wsMessages.session?.some((message) => message.wireFrame !== undefined)).toBe(true);
    if (ending !== 'replace') {
        await openSession();
    }
    expect(readCompletedSnapshots()).toEqual([]);
});

it.each(['client-state.snapshot', 'group-state.snapshot', 'group-directory.snapshot'])(
    'projects validated %s domain data with its page revision',
    async (topicId) => {
        const socket = await openSession();
        const client = createClientSnapshot({ ...scope, principalId: 'alice', sessionId: 'session-1', snapshotVersion: 3 });
        const group = createGroupSnapshot({ ...groupRef, sessionIds: ['session-1'], snapshotVersion: 3 });
        const isClient = topicId === 'client-state.snapshot';
        const snapshot = isClient ? { ...client, activeSessions: [], activeSessionCount: 0, isOnline: false } : group;
        const nowMs = Date.now();
        const pages = computeStateSnapshotPages({
            scope: { ...scope, kind: isClient ? 'principal' : 'group', resourceId: isClient ? 'alice' : groupRef.groupId },
            revision: isClient ? 'revision=3' : 'group=3;presence=3',
            resource: JSON.stringify(snapshot),
            envelope: {
                id: { v: 2, msgId: topicId, senderId: 'api-node', ts: nowMs },
                route: { topicId, contextId: isClient ? 'alice' : groupRef.groupId, resourceId: 'snapshot' },
                targets: { mode: 'unicast', toPeerId: 'session-1' },
                constraints: { expiresAtMs: nowMs + 60_000 },
                delivery: { reliability: 'best-effort', ack: 'none' },
                audit: { createdBy: 'api-node', createdTs: nowMs }
            }
        }).fold((issue) => {
            throw new Error(issue.message);
        }, (value) => value);
        for (const page of pages) {
            socket.receive(JSON.stringify(page));
        }
        expect(context.wsMessages.session?.at(-1)?.rejection).toBeUndefined();
        expect(readCompletedSnapshots()).toEqual([{ completedSnapshot: expect.objectContaining({ topicId, snapshot }) }]);
        if (isClient) {
            const leakedSnapshotExpectation = {
                request: interaction.request,
                response: { connection: 'session', withinMs: 1, absent: { completedSnapshot: { scope: { kind: 'principal', resourceId: 'alice' } } } }
            };
            expect(await waitForWsMessageAbsence({ interaction: leakedSnapshotExpectation, config, context })).toMatchObject({ status: 'FAILURE' });
        }
    }
);

it('bounds retained observations while keeping recent wire evidence', async () => {
    const socket = await openSession();
    for (let index = 0; index < 400; index++) {
        socket.receive('{');
    }
    expect(context.wsMessages.session?.length).toBeLessThanOrEqual(256);
    expect(context.wsMessages.session?.at(-1)?.rejection?.code).toBe('malformed');
});

it('rejects observation scope that differs from the connection URL before opening', async () => {
    const url = 'ws://localhost/api/ws/session-1?ticket=test&applicationId=app&workspaceId=another';
    expect(await openWs({ request: { ...interaction.request, url } }, config, context)).toMatchObject({ status: 'FAILURE' });
    expect(TestWebSocket.instances).toHaveLength(0);
});

it('assembles real loopback WebSocket pages under the scope sent to the server', async () => {
    vi.stubGlobal('WebSocket', NativeWebSocket);
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const connectionUrls: string[] = [];
    const pages = topologyPages();
    server.on('connection', (socket, request) => {
        connectionUrls.push(request.url ?? '');
        for (const page of pages.toReversed()) {
            socket.send(JSON.stringify(page));
        }
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected TCP WebSocket listener');
        }
        const url = `ws://127.0.0.1:${address.port}/api/ws/session-1?applicationId=app&workspaceId=workspace`;
        expect(await openWs({ request: { ...interaction.request, url } }, config, context)).toMatchObject({ status: 'SUCCESS' });
        const waitInteraction = {
            request: interaction.request,
            response: { connection: 'session', withinMs: 1000, message: { completedSnapshot: { originalMessageId: 'publication' } } }
        };
        expect(await waitForWsMessage({ interaction: waitInteraction, config, context })).toMatchObject({ status: 'SUCCESS' });
        expect(connectionUrls).toEqual(['/api/ws/session-1?applicationId=app&workspaceId=workspace']);
        expect(context.wsMessages.session?.filter((message) => message.wireFrame !== undefined)).toHaveLength(pages.length);
    }
    finally {
        await closeWs(interaction, config, context);
        for (const socket of server.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

it('fails an active absence wait when later traffic evicts an offending completed snapshot', async () => {
    const socket = await openSession();
    const waiting = waitForWsMessageAbsence({
        interaction: {
            request: interaction.request,
            response: { connection: 'session', withinMs: 10, absent: { completedSnapshot: { typeId: 'overlay.topology' } } }
        },
        config,
        context
    });
    for (const page of topologyPages()) {
        socket.receive(JSON.stringify(page));
    }
    expect(readCompletedSnapshots()).toHaveLength(1);
    const nowMs = Date.now();
    for (let index = 0; index < 400; index++) {
        socket.receive(JSON.stringify({
            id: { v: 2, msgId: `event-${index}`, senderId: 'api-node', ts: nowMs },
            route: { topicId: 'ordinary.event', contextId: 'group', resourceId: 'event' },
            payload: { typeId: 'ordinary.event', resource: '{}' }
        }));
    }
    expect(context.wsMessages.session?.length).toBeLessThanOrEqual(256);
    expect(context.wsMessages.session?.every((message) => message.rejection === undefined)).toBe(true);
    expect(context.wsObservationLoss?.session).toBeGreaterThan(1);
    expect(await waiting).toMatchObject({ status: 'FAILURE' });
});

it('detects an incomplete foreign principal page without exposing partial snapshot authority', async () => {
    const socket = await openSession();
    const client = createClientSnapshot({ ...scope, principalId: 'foreign-principal', sessionId: 'foreign-session', snapshotVersion: 3 });
    const snapshot = {
        ...client,
        principal: { ...client.principal, metadata: { padding: 'x'.repeat(80_000) } },
        activeSessions: [],
        activeSessionCount: 0,
        isOnline: false
    };
    const nowMs = Date.now();
    const pages = computeStateSnapshotPages({
        scope: { ...scope, kind: 'principal', resourceId: 'foreign-principal' },
        revision: 'revision=3',
        resource: JSON.stringify(snapshot),
        envelope: {
            id: { v: 2, msgId: 'foreign-snapshot', senderId: 'api-node', ts: nowMs },
            route: { topicId: 'client-state.snapshot', contextId: 'foreign-principal', resourceId: 'snapshot' },
            targets: { mode: 'unicast', toPeerId: 'session-1' },
            constraints: { expiresAtMs: nowMs + 60_000 },
            delivery: { reliability: 'best-effort', ack: 'none' },
            audit: { createdBy: 'api-node', createdTs: nowMs }
        }
    }).fold((issue) => {
        throw new Error(issue.message);
    }, (value) => value);
    expect(pages.length).toBeGreaterThan(1);
    const waiting = waitForWsMessageAbsence({
        interaction: {
            request: interaction.request,
            response: {
                connection: 'session',
                withinMs: 10,
                absent: { observedSnapshotPage: { scope: { kind: 'principal', resourceId: 'foreign-principal' } } }
            }
        },
        config,
        context
    });
    socket.receive(JSON.stringify(pages[0]));
    expect(readCompletedSnapshots()).toEqual([]);
    expect(context.wsMessages.session?.at(-1)?.data).toMatchObject({
        observedSnapshotPage: { scope: { ...scope, kind: 'principal', resourceId: 'foreign-principal' }, topicId: 'client-state.snapshot' }
    });
    expect(await waiting).toMatchObject({ status: 'FAILURE', result: 'WebSocket message expected to be absent was received' });
});

it('observes generation-specific unicast hydration even after the same revision was broadcast', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const socket = await openSession();
    const publication = topologyPages({ targets: { mode: 'broadcast', scope: 'room', groupRef } });
    const hydration = topologyPages({ messageId: JSON.stringify(['rtc-topology-hydration', groupRef, 'session-1', 'generation-2', 3, 4, 5]) });
    for (const page of publication) {
        socket.receive(JSON.stringify(page));
    }
    for (const page of hydration) {
        socket.receive(JSON.stringify(page));
    }
    expect(readCompletedSnapshots()).toHaveLength(2);
    expect(
        await waitForWsMessage({
            interaction: {
                request: interaction.request,
                response: {
                    connection: 'session',
                    withinMs: 30,
                    message: {
                        completedSnapshot: {
                            scope: { ...scope, kind: 'group', resourceId: groupRef.groupId },
                            targets: { mode: 'unicast', toPeerId: 'session-1' }
                        }
                    }
                }
            },
            config,
            context
        })
    ).toMatchObject({ status: 'SUCCESS' });
});
