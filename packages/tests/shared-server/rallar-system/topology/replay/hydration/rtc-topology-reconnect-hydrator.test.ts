import type { RtcTopologyReconnectHydration } from '@shared-server/rallar-system/topology/replay/hydration/rtc-topology-reconnect-hydration.ts';
import { RtcTopologyReconnectHydrator } from '@shared-server/rallar-system/topology/replay/hydration/rtc-topology-reconnect-hydrator.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestGroup } from '../../../../../create-test-group.ts';

describe('RtcTopologyReconnectHydrator', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('hydrates only an active durable member and session', async () => {
        const harness = createHarness();
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        expect(harness.sentMessages(connection)).toEqual([
            expect.objectContaining({
                id: expect.objectContaining({
                    msgId: JSON.stringify(['rtc-topology-hydration', 'session-1', 'generation-1', 3, 4, 5])
                }),
                targets: { mode: 'unicast', toPeerId: 'session-1' }
            })
        ]);
        expect(harness.outcomes).toEqual(['sent']);
    });

    it.each([
        ['revoked member', { memberStatus: 'removed' as const }],
        ['wrong principal', { sessionPrincipalId: 'principal-2' }],
        ['expired session', { sessionExpiresAtEpochMs: 999 }],
        ['disconnected session', { sessionStatus: 'disconnected' as const }]
    ])('skips an unauthorized durable identity: %s', async (_label, overrides) => {
        const harness = createHarness(overrides);
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        expect(harness.sentMessages(connection)).toEqual([]);
        expect(harness.outcomes).toEqual(['unauthorized']);
    });

    it('reloads current topology after authorization instead of sending the scan row', async () => {
        const stale = createTopology({ version: 4 });
        const current = createTopology({ version: 5 });
        const harness = createHarness({ scanTopology: stale, currentTopology: current });
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        const message = harness.sentMessages(connection)[0] as { payload: { resource: string; }; };
        expect(JSON.parse(message.payload.resource)).toEqual(current);
    });

    it('hydrates the accepted layout whenever the accepted slot exists (4c)', async () => {
        const planned = createTopology({ version: 6 });
        const accepted = createTopology({ version: 5 });
        const harness = createHarness({
            scanTopology: planned,
            currentTopology: planned,
            acceptedTopologies: {
                listSnapshotEntriesPage: async () => [],
                findSnapshot: async () => accepted
            }
        });
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        const message = harness.sentMessages(connection)[0] as { payload: { resource: string; }; };
        expect(JSON.parse(message.payload.resource)).toEqual(accepted);
        expect(harness.outcomes).toEqual(['sent']);
    });

    it('hydrates the removal tombstone even when a stale accepted row survives (teardown wins)', async () => {
        const tombstone = { ...createTopology({ version: 8 }), state: 'removed' as const };
        const staleAccepted = createTopology({ version: 7 });
        const harness = createHarness({
            scanTopology: tombstone,
            currentTopology: tombstone,
            acceptedTopologies: {
                listSnapshotEntriesPage: async () => [],
                findSnapshot: async () => staleAccepted
            }
        });
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        const message = harness.sentMessages(connection)[0] as { payload: { resource: string; }; };
        expect(JSON.parse(message.payload.resource)).toEqual(tombstone);
    });

    it('serves a member named only in the held planned candidate their candidate assignment (4c)', async () => {
        const planned = createTopology({ version: 9, activeSessionIds: ['session-1', 'session-2'] });
        const accepted = createTopology({ version: 8, activeSessionIds: ['session-2'] });
        const harness = createHarness({
            scanTopology: planned,
            currentTopology: planned,
            acceptedTopologies: {
                listSnapshotEntriesPage: async () => [],
                findSnapshot: async () => accepted
            }
        });
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        const message = harness.sentMessages(connection)[0] as { payload: { resource: string; }; };
        expect(JSON.parse(message.payload.resource)).toEqual(planned);
        expect(harness.outcomes).toEqual(['sent']);
    });

    it('finds a member only the accepted layout still names through the second scan (4c)', async () => {
        const planned = createTopology({ version: 7, activeSessionIds: ['session-9'] });
        const accepted = createTopology({ version: 6 });
        const harness = createHarness({
            scanTopology: planned,
            currentTopology: planned,
            acceptedTopologies: {
                listSnapshotEntriesPage: async () => [toSnapshotPageEntry(accepted)],
                findSnapshot: async () => accepted
            }
        });
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        const message = harness.sentMessages(connection)[0] as { payload: { resource: string; }; };
        expect(JSON.parse(message.payload.resource)).toEqual(accepted);
        expect(harness.outcomes).toEqual(['sent']);
    });

    it('never writes to a replacement generation that appears during authorization', async () => {
        let releaseAuthorization: (() => void) | undefined;
        const authorizationBlocked = new Promise<void>((resolve) => {
            releaseAuthorization = resolve;
        });
        const harness = createHarness({
            beforeAuthorizationReturns: async () => await authorizationBlocked
        });
        const captured = harness.addConnection('session-1', 'generation-1');
        const hydration = harness.hydrator.hydrateOpenConnections(new AbortController().signal);
        await vi.waitFor(() => expect(harness.groupReadCount).toBe(1));

        const replacement = harness.addConnection('session-1', 'generation-2');
        releaseAuthorization?.();
        await hydration;

        expect(harness.sentMessages(captured)).toEqual([]);
        expect(harness.sentMessages(replacement)).toEqual([]);
        expect(harness.outcomes).toEqual(['stale-generation']);
    });

    it('stops an in-flight reconnect hydration without sending or rejecting cancellation', async () => {
        const scheduler = new ManualScheduler();
        let releaseAuthorization: (() => void) | undefined;
        const authorizationBlocked = new Promise<void>((resolve) => {
            releaseAuthorization = resolve;
        });
        const harness = createHarness({
            scheduler,
            beforeAuthorizationReturns: async () => await authorizationBlocked
        });
        harness.hydrator.start();
        const connection = harness.addConnection('session-1', 'generation-1');
        harness.open(connection);
        await scheduler.runNext(25);
        await vi.waitFor(() => expect(harness.groupReadCount).toBe(1));

        const stopped = harness.hydrator.stop();
        releaseAuthorization?.();

        await expect(stopped).resolves.toBeUndefined();
        expect(harness.currentTopologyReadCount).toBe(0);
        expect(harness.sentMessages(connection)).toEqual([]);
    });

    it('propagates an external abort during authorization without sending', async () => {
        let releaseAuthorization: (() => void) | undefined;
        const authorizationBlocked = new Promise<void>((resolve) => {
            releaseAuthorization = resolve;
        });
        const harness = createHarness({
            beforeAuthorizationReturns: async () => await authorizationBlocked
        });
        const connection = harness.addConnection('session-1', 'generation-1');
        const controller = new AbortController();
        const hydration = harness.hydrator.hydrateOpenConnections(controller.signal);
        await vi.waitFor(() => expect(harness.groupReadCount).toBe(1));

        const abortReason = new Error('gap hydration cancelled');
        controller.abort(abortReason);
        releaseAuthorization?.();

        await expect(hydration).rejects.toBe(abortReason);
        expect(harness.currentTopologyReadCount).toBe(0);
        expect(harness.sentMessages(connection)).toEqual([]);
    });

    it('retries when durable group authority moves around the topology read', async () => {
        const harness = createHarness({ groupRevisionsByRead: [3, 4] });
        const connection = harness.addConnection('session-1', 'generation-1');

        await expect(
            harness.hydrator.hydrateOpenConnections(new AbortController().signal)
        ).rejects.toThrow('requires retry');

        expect(harness.sentMessages(connection)).toEqual([]);
        expect(harness.outcomes).toEqual(['retry']);
    });

    it('records retry when the bounded topology page scan fails', async () => {
        const harness = createHarness({ topologyPageFailures: 1 });
        harness.addConnection('session-1', 'generation-1');

        await expect(
            harness.hydrator.hydrateOpenConnections(new AbortController().signal)
        ).rejects.toThrow('requires retry');

        expect(harness.outcomes).toEqual(['retry']);
    });

    it('propagates an external abort that coincides with a topology page failure', async () => {
        let releaseTopologyPage: (() => void) | undefined;
        const topologyPageBlocked = new Promise<void>((resolve) => {
            releaseTopologyPage = resolve;
        });
        const harness = createHarness({
            topologyPageFailures: 1,
            beforeTopologyPageReturns: async () => await topologyPageBlocked
        });
        harness.addConnection('session-1', 'generation-1');
        const controller = new AbortController();
        const hydration = harness.hydrator.hydrateOpenConnections(controller.signal);
        await vi.waitFor(() => expect(harness.pageLimits).toEqual([100]));

        const abortReason = new Error('gap page scan cancelled');
        controller.abort(abortReason);
        releaseTopologyPage?.();

        await expect(hydration).rejects.toBe(abortReason);
        expect(harness.outcomes).toEqual([]);
    });

    it('scans topology in fixed pages of 100 and yields between pages', async () => {
        const topologies = Array.from({ length: 101 }, (_, index) =>
            createTopology({
                groupId: `group-${String(index).padStart(3, '0')}`,
                activeSessionIds: index === 100 ? ['session-1'] : ['other-session']
            }));
        const harness = createHarness({ topologies });
        const connection = harness.addConnection('session-1', 'generation-1');

        await harness.hydrator.hydrateOpenConnections(new AbortController().signal);

        expect(harness.pageLimits).toEqual([100, 100]);
        expect(harness.yieldCount).toBe(1);
        expect(harness.sentMessages(connection)).toHaveLength(1);
    });

    it('batches connections opened within 25 ms into one topology scan', async () => {
        const scheduler = new ManualScheduler();
        const harness = createHarness({ scheduler });
        harness.hydrator.start();
        const first = harness.addConnection('session-1', 'generation-1');
        const second = harness.addConnection('session-2', 'generation-2');

        harness.open(first);
        harness.open(second);
        expect(scheduler.delays).toEqual([25]);
        await scheduler.runNext(25);
        await harness.hydrator.whenIdle();

        expect(harness.pageLimits).toEqual([100]);
    });

    it('schedules reconnects that arrive while a hydration batch is in flight', async () => {
        const scheduler = new ManualScheduler();
        let releaseFirstAuthorization: (() => void) | undefined;
        const firstAuthorizationBlocked = new Promise<void>((resolve) => {
            releaseFirstAuthorization = resolve;
        });
        let shouldBlockAuthorization = true;
        const harness = createHarness({
            scheduler,
            beforeAuthorizationReturns: async () => {
                if (!shouldBlockAuthorization) {
                    return;
                }
                shouldBlockAuthorization = false;
                await firstAuthorizationBlocked;
            }
        });
        harness.hydrator.start();
        const first = harness.addConnection('session-1', 'generation-1');
        harness.open(first);
        await scheduler.runNext(25);
        await vi.waitFor(() => expect(harness.groupReadCount).toBe(1));

        const second = harness.addConnection('session-2', 'generation-2');
        harness.open(second);
        releaseFirstAuthorization?.();
        await harness.hydrator.whenIdle();
        await scheduler.runNext(25);
        await harness.hydrator.whenIdle();

        expect(harness.pageLimits).toEqual([100, 100]);
    });

    it('cancels a bounded retry when the captured generation closes', async () => {
        const scheduler = new ManualScheduler();
        const harness = createHarness({ scheduler, currentTopologyFailures: 1 });
        harness.hydrator.start();
        const connection = harness.addConnection('session-1', 'generation-1');
        harness.open(connection);
        await scheduler.runNext(25);
        await harness.hydrator.whenIdle();
        expect(harness.outcomes).toEqual(['retry']);
        expect(scheduler.delays).toEqual([25, 100]);

        harness.close(connection);
        await scheduler.runNext(100);

        expect(harness.currentTopologyReadCount).toBe(1);
    });
});

interface HarnessOverrides {
    readonly memberStatus?: 'active' | 'removed';
    readonly sessionStatus?: 'active' | 'disconnected';
    readonly sessionPrincipalId?: string;
    readonly sessionExpiresAtEpochMs?: number;
    readonly scanTopology?: RallarOverlayTopologySnapshot;
    readonly currentTopology?: RallarOverlayTopologySnapshot;
    readonly topologies?: readonly RallarOverlayTopologySnapshot[];
    readonly acceptedTopologies?: RtcTopologyReconnectHydration.TopologyReader;
    readonly beforeAuthorizationReturns?: () => Promise<void>;
    readonly scheduler?: ManualScheduler;
    readonly currentTopologyFailures?: number;
    readonly topologyPageFailures?: number;
    readonly beforeTopologyPageReturns?: () => Promise<void>;
    readonly groupRevisionsByRead?: readonly number[];
}

function createHarness(overrides: HarnessOverrides = {}) {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new JsonWebSocketServer();
    const scanTopology = overrides.scanTopology ?? createTopology();
    const topologies = overrides.topologies ?? [scanTopology];
    const currentTopology = overrides.currentTopology ?? scanTopology;
    const outcomes: string[] = [];
    const pageLimits: number[] = [];
    const webSockets = new Map<ConnectionContext, FakeWebSocket>();
    let yieldCount = 0;
    let groupReadCount = 0;
    let currentTopologyReadCount = 0;
    let currentTopologyFailures = overrides.currentTopologyFailures ?? 0;
    let topologyPageFailures = overrides.topologyPageFailures ?? 0;
    const hydrator = new RtcTopologyReconnectHydrator({
        socket,
        batchWindowMs: 25,
        acceptedTopologies: overrides.acceptedTopologies ?? {
            listSnapshotEntriesPage: async () => [],
            findSnapshot: async () => undefined
        },
        topologies: {
            listSnapshotEntriesPage: async ({ afterKey, limit }) => {
                pageLimits.push(limit);
                await overrides.beforeTopologyPageReturns?.();
                if (topologyPageFailures > 0) {
                    topologyPageFailures -= 1;
                    throw new Error('transient topology page failure');
                }
                const remaining = topologies.filter(
                    (snapshot) => snapshot.groupRef.groupId > (afterKey ?? '')
                );
                return remaining.slice(0, limit).map((snapshot) => ({
                    entry: {
                        key: snapshot.groupRef.groupId,
                        value: JSON.stringify(snapshot),
                        expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                        updatedTimestamp: '2026-08-10T00:00:00.000Z',
                        revision: 1
                    },
                    value: snapshot
                }));
            },
            findSnapshot: async (ref) => {
                currentTopologyReadCount += 1;
                if (currentTopologyFailures > 0) {
                    currentTopologyFailures -= 1;
                    throw new Error('transient topology read failure');
                }
                return {
                    ...currentTopology,
                    groupRef: ref,
                    overlayId: `overlay-${ref.groupId}`
                };
            }
        },
        groups: {
            readSnapshot: async (ref) => {
                groupReadCount += 1;
                await overrides.beforeAuthorizationReturns?.();
                return createGroupSnapshot(
                    ref.groupId,
                    overrides,
                    overrides.groupRevisionsByRead?.[groupReadCount - 1]
                );
            }
        },
        readIdentity: () => ({ principalId: 'principal-1' }),
        nowEpochMs: () => 1_000,
        diagnostics: (event) => {
            if (event.kind === 'hydration') {
                outcomes.push(event.outcome);
            }
        },
        scheduler: overrides.scheduler ?? {
            schedule: () => () => undefined,
            yield: async () => {
                yieldCount += 1;
            }
        }
    });
    return {
        socket,
        hydrator,
        outcomes,
        pageLimits,
        get yieldCount() {
            return yieldCount;
        },
        get groupReadCount() {
            return groupReadCount;
        },
        get currentTopologyReadCount() {
            return currentTopologyReadCount;
        },
        addConnection(sessionId: string, generationId: string) {
            const webSocket = new FakeWebSocket();
            const context = new ConnectionContext(sessionId, webSocket, generationId, 1_000);
            webSockets.set(context, webSocket);
            socket.addConnection(context);
            return context;
        },
        open(context: ConnectionContext): void {
            requireHarnessWebSocket(webSockets, context).dispatchEvent(new Event('open'));
        },
        close(context: ConnectionContext): void {
            const webSocket = requireHarnessWebSocket(webSockets, context);
            webSocket.readyState = 3;
            webSocket.dispatchEvent(new Event('close'));
        },
        sentMessages(context: ConnectionContext): readonly ALMessage[] {
            return requireHarnessWebSocket(webSockets, context).sent.map((text) => {
                const message = JSON.parse(text);
                return decodePersistedALMessageValue(message);
            });
        }
    };
}

function requireHarnessWebSocket(
    webSockets: ReadonlyMap<ConnectionContext, FakeWebSocket>,
    context: ConnectionContext
): FakeWebSocket {
    const webSocket = webSockets.get(context);
    if (!webSocket) {
        throw new Error(`Missing test WebSocket for ${context.id}`);
    }
    return webSocket;
}

function toSnapshotPageEntry(
    snapshot: RallarOverlayTopologySnapshot
): { entry: { key: string; value: string; expireAtTimestamp: number; updatedTimestamp: string; revision: number; }; value: RallarOverlayTopologySnapshot; } {
    return {
        entry: {
            key: snapshot.groupRef.groupId,
            value: JSON.stringify(snapshot),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: '2026-08-10T00:00:00.000Z',
            revision: 1
        },
        value: snapshot
    };
}

function createTopology(
    input: Readonly<{
        groupId?: string;
        version?: number;
        activeSessionIds?: readonly string[];
    }> = {}
): RallarOverlayTopologySnapshot {
    const groupId = input.groupId ?? 'group-1';
    const activeSessionIds = input.activeSessionIds ?? ['session-1'];
    return {
        sourceGroupStateCausalRevision: { groupRevision: 3, presenceRevision: 4 },
        state: 'active',
        overlayId: `overlay-${groupId}`,
        groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId },
        name: 'Topology',
        topology: 'mesh',
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(activeSessionIds.map((sessionId) => [sessionId, []])),
        degreeLimit: 4,
        version: input.version ?? 5,
        createdByClientId: 'principal-1',
        createdAtEpochMs: 100,
        updatedAtEpochMs: 200
    };
}

function createGroupSnapshot(
    groupId: string,
    overrides: HarnessOverrides,
    groupRevision = 3
): GroupSnapshot {
    const sessionStatus = overrides.sessionStatus ?? 'active';
    const audit = {
        atEpochMs: 1,
        actor: { kind: 'principal' as const, principalId: 'principal-1' },
        reason: null,
        traceId: null,
        requestId: null
    };
    return {
        causalRevision: { groupRevision, presenceRevision: 4 },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            displayName: 'Group',
            activeMemberCount: 1,
            ownerPrincipalId: 'principal-1',
            snapshotVersion: 3,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 4,
            created: audit,
            updated: audit
        }),
        members: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId,
                principalId: 'principal-1',
                role: 'owner',
                status: overrides.memberStatus ?? 'active',
                joined: audit,
                updated: audit,
                invitedByPrincipalId: null,
                invitationExpiresAtEpochMs: null,
                left: null,
                removed: overrides.memberStatus === 'removed' ? audit : null,
                banned: null
            } as GroupSnapshot['members'][number]
        ],
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId,
                sessionId: 'session-1',
                principalId: overrides.sessionPrincipalId ?? 'principal-1',
                generationId: 'presence-generation',
                generationVersion: 1,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: overrides.sessionExpiresAtEpochMs ?? 2_000,
                status: sessionStatus,
                disconnectedAtEpochMs: sessionStatus === 'active' ? null : 900,
                disconnectReason: sessionStatus === 'active' ? null : 'closed'
            } as GroupSnapshot['activeSessions'][number]
        ],
        memberCount: 1,
        onlineMemberCount: sessionStatus === 'active' ? 1 : 0
    };
}

class FakeWebSocket extends EventTarget implements WebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = FakeWebSocket.CONNECTING;
    readonly OPEN = FakeWebSocket.OPEN;
    readonly CLOSING = FakeWebSocket.CLOSING;
    readonly CLOSED = FakeWebSocket.CLOSED;
    binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly url = 'ws://rtc-topology.test';
    onclose: ((this: WebSocket, event: CloseEvent) => void) | null = null;
    onerror: ((this: WebSocket, event: Event) => void) | null = null;
    onmessage: ((this: WebSocket, event: MessageEvent) => void) | null = null;
    onopen: ((this: WebSocket, event: Event) => void) | null = null;
    readyState: WebSocket['readyState'] = FakeWebSocket.OPEN;
    readonly sent: string[] = [];

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data !== 'string') {
            throw new TypeError('Fake RTC topology WebSocket accepts text only');
        }
        this.sent.push(data);
    }

    close(_code?: number, _reason?: string): void {
        this.readyState = FakeWebSocket.CLOSED;
    }
}

class ManualScheduler {
    readonly delays: number[] = [];
    readonly #tasks: Array<{
        delayMs: number;
        task: () => void;
        cancelled: boolean;
    }> = [];

    schedule(delayMs: number, task: () => void): () => void {
        const scheduled = { delayMs, task, cancelled: false };
        this.delays.push(delayMs);
        this.#tasks.push(scheduled);
        return () => {
            scheduled.cancelled = true;
        };
    }

    async yield(): Promise<void> {}

    async runNext(delayMs: number): Promise<void> {
        const scheduled = this.#tasks.find((candidate) => candidate.delayMs === delayMs);
        if (!scheduled) {
            throw new Error(`No scheduled task for ${delayMs} ms`);
        }
        this.#tasks.splice(this.#tasks.indexOf(scheduled), 1);
        if (!scheduled.cancelled) {
            scheduled.task();
        }
        await Promise.resolve();
    }
}
