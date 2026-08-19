import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import {
    type GroupStateDeltaEnvelope,
    validateGroupStateDeltaEnvelope,
} from '@shared/api/group-state-delta.ts';
import type {
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
} from '@shared/api/state-types.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
} from '@shared/al-contracts/al-contract.ts';
import { decideGroupSnapshotCausalRevision } from '@shared/repository/group-state-snapshot-revision.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import * as dataCaches from '@shared-web/browser/data-caches.ts';
import {
    type BrowserStateReadDiagnosticEvent,
    setBrowserStateReadDiagnosticsSink,
} from '@shared-web/browser/state-read/diagnostics.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { createTestGroup } from '../create-test-group.ts';

vi.mock('@shared/repository/group-state-snapshot-revision.ts', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@shared/repository/group-state-snapshot-revision.ts')
    >();
    return {
        ...actual,
        decideGroupSnapshotCausalRevision: vi.fn(actual.decideGroupSnapshotCausalRevision),
    };
});

describe('browser group-state delta application', () => {
    const diagnostics: BrowserStateReadDiagnosticEvent[] = [];

    beforeEach(() => {
        configureTestCacheRepositories();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        vi.stubGlobal('localStorage', { getItem: () => null });
        diagnostics.length = 0;
        setBrowserStateReadDiagnosticsSink((event) => diagnostics.push(event));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setBrowserStateReadDiagnosticsSink(undefined);
    });

    it('applies a delta at the cached predecessor and materializes the server-canonical snapshot', async () => {
        const runtime = createStateCacheRuntime();
        const predecessor = createDeltaGroupSnapshot({
            groupId: 'room-delta-apply',
            memberPrincipalIds: ['m-alpha', 'm-charlie'],
            activePrincipalIds: ['m-alpha', 'm-charlie'],
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
        });
        const resulting = createDeltaGroupSnapshot({
            groupId: 'room-delta-apply',
            memberPrincipalIds: ['m-alpha', 'm-bravo', 'm-charlie'],
            activePrincipalIds: ['m-alpha', 'm-charlie'],
            causalRevision: { groupRevision: 2, presenceRevision: 1 },
        });
        const joinedMember = resulting.members.find(
            (member) => member.principalId === 'm-bravo',
        );
        const envelope = createDeltaEnvelope({
            resulting,
            predecessorCausalRevision: predecessor.causalRevision,
            members: joinedMember ? [joinedMember] : [],
        });
        await runtime.hydrate([predecessor]);
        runtime.manager.acceptGroupUpdate.mockClear();
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(envelope);

        // The joined member lands mid-roster: canonical storage-key order, not
        // append order, and the whole snapshot equals the server assembly.
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group),
        ).toEqual(resulting);
        expect(runtime.manager.acceptGroupUpdate).toHaveBeenCalledWith(resulting);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deltaApplyResults()).toEqual(['applied']);

        // Dual-emit oracle compatibility: the trailing equal-tuple snapshot row
        // must decide as a duplicate against the materialized snapshot.
        await expect(runtime.receiveSnapshotMessage(resulting)).resolves.toBeUndefined();
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group),
        ).toEqual(resulting);
    });

    it('resolves equal-resulting and summary no-op envelopes as typed no-ops before the apply rule', async () => {
        const runtime = createStateCacheRuntime();
        const cached = createDeltaGroupSnapshot({
            groupId: 'room-delta-noop',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 1 },
        });
        const duplicate = createDeltaEnvelope({
            resulting: cached,
            predecessorCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        });
        const summaryNoOp = createDeltaEnvelope({
            resulting: cached,
            predecessorCausalRevision: cached.causalRevision,
        });
        await runtime.hydrate([cached]);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(duplicate);
        await runtime.receiveDeltaMessage(summaryNoOp);

        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(cached.group),
        ).toEqual(cached);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deltaApplyResults()).toEqual(['no-op', 'no-op']);
    });

    it('pulls at the resulting floor when the cached snapshot is dominated but not the predecessor', async () => {
        const runtime = createStateCacheRuntime();
        const stale = createDeltaGroupSnapshot({
            groupId: 'room-delta-gap',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
        });
        const resulting = createDeltaGroupSnapshot({
            groupId: 'room-delta-gap',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 3 },
        });
        const envelope = createDeltaEnvelope({
            resulting,
            predecessorCausalRevision: { groupRevision: 2, presenceRevision: 2 },
        });
        await runtime.hydrate([stale]);
        const fetchMock = vi.fn<typeof fetch>(
            async () => groupSnapshotResponse(resulting),
        );
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(envelope);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            '/groups/room-delta-gap?minGroupRevision=2&minPresenceRevision=3',
        );
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group),
        ).toEqual(resulting);
        expect(deltaApplyResults()).toEqual(['gap-pull']);
    });

    it('resolves an out-of-order envelope after a newer snapshot as a no-op', async () => {
        const runtime = createStateCacheRuntime();
        const newer = createDeltaGroupSnapshot({
            groupId: 'room-delta-order',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 3 },
        });
        const older = createDeltaGroupSnapshot({
            groupId: 'room-delta-order',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 2 },
        });
        const outOfOrder = createDeltaEnvelope({
            resulting: older,
            predecessorCausalRevision: { groupRevision: 2, presenceRevision: 1 },
        });
        await runtime.hydrate([newer]);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(outOfOrder);

        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(newer.group),
        ).toEqual(newer);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(deltaApplyResults()).toEqual(['no-op']);
    });

    it('pulls at the floor when an active session record is missing from the delta and the cache', async () => {
        const runtime = createStateCacheRuntime();
        const cached = createDeltaGroupSnapshot({
            groupId: 'room-delta-session',
            memberPrincipalIds: ['m-alpha', 'm-bravo'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
        });
        const resulting = createDeltaGroupSnapshot({
            groupId: 'room-delta-session',
            memberPrincipalIds: ['m-alpha', 'm-bravo'],
            activePrincipalIds: ['m-alpha', 'm-bravo'],
            causalRevision: { groupRevision: 1, presenceRevision: 2 },
        });
        // Service-driven transition: complete identity set, no session slice.
        const envelope = createDeltaEnvelope({
            resulting,
            predecessorCausalRevision: cached.causalRevision,
            eventType: 'session-connected',
            sessions: [],
        });
        await runtime.hydrate([cached]);
        const fetchMock = vi.fn<typeof fetch>(
            async () => groupSnapshotResponse(resulting),
        );
        vi.stubGlobal('fetch', fetchMock);

        await runtime.receiveDeltaMessage(envelope);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            '/groups/room-delta-session?minGroupRevision=1&minPresenceRevision=2',
        );
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group),
        ).toEqual(resulting);
        expect(deltaApplyResults()).toEqual(['gap-pull']);
    });

    it('counts a revision conflict from the divergence oracle and self-heals with the floored pull', async () => {
        const runtime = createStateCacheRuntime();
        const cached = createDeltaGroupSnapshot({
            groupId: 'room-delta-oracle',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
        });
        const resulting = createDeltaGroupSnapshot({
            groupId: 'room-delta-oracle',
            memberPrincipalIds: ['m-alpha'],
            activePrincipalIds: ['m-alpha'],
            causalRevision: { groupRevision: 2, presenceRevision: 1 },
        });
        const envelope = createDeltaEnvelope({
            resulting,
            predecessorCausalRevision: cached.causalRevision,
            eventType: 'group-updated',
        });
        await runtime.hydrate([cached]);
        const fetchMock = vi.fn<typeof fetch>(
            async () => groupSnapshotResponse(resulting),
        );
        vi.stubGlobal('fetch', fetchMock);
        vi.mocked(decideGroupSnapshotCausalRevision).mockImplementationOnce(() => {
            throw new StateSnapshotRevisionConflictError('Group', resulting.stateRevision);
        });

        await expect(runtime.receiveDeltaMessage(envelope)).resolves.toBeUndefined();

        expect(deltaApplyResults()).toEqual(['revision-conflict']);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            '/groups/room-delta-oracle?minGroupRevision=2&minPresenceRevision=1',
        );
        expect(
            groupStateSnapshotsRepository.findGroupStateSnapshotByRef(resulting.group),
        ).toEqual(resulting);
    });

    function deltaApplyResults(): readonly string[] {
        return diagnostics
            .filter((event) => event.operation === 'delta-apply')
            .map((event) => event.result);
    }
});

function createStateCacheRuntime() {
    const manager = {
        notifyClientPresenceChanged: vi.fn(async () => undefined),
        notifyOverlayTopologyChanged: vi.fn(async () => undefined),
        acceptGroupUpdate: vi.fn(async () => undefined),
        ensureAllGroupsConnected: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        has: vi.fn(() => false),
    };
    const clientData: ClientInfo = {
        clientId: 'm-alpha',
        sessionId: 'session-m-alpha',
        isOnline: true,
    };
    let onInboxMessage: ((message: unknown) => Promise<void>) | undefined;
    const webSocketQueueBox = {
        onAllInboxMessagesDo: vi.fn((callback: {
            onMessage: (message: unknown) => Promise<void>;
        }) => {
            onInboxMessage = callback.onMessage;
            return webSocketQueueBox;
        }),
    };
    dataCaches.initialise(webSocketQueueBox, manager as never, clientData);

    return {
        manager,
        hydrate: async (snapshots: readonly GroupSnapshot[]) => {
            await dataCaches.hydrateStateCaches(
                manager as never,
                clientData,
                [],
                snapshots,
            );
        },
        receiveDeltaMessage: async (envelope: GroupStateDeltaEnvelope) => {
            await onInboxMessage?.(
                newALBroadcastMessage(
                    'server-1',
                    newALEventRoute(
                        AppTopics.groupStateEvent,
                        envelope.event.groupId,
                        envelope.event.eventId,
                    ),
                    'all',
                    AppTopics.groupStateEvent,
                    envelope,
                ),
            );
        },
        receiveSnapshotMessage: async (snapshot: GroupSnapshot) => {
            await onInboxMessage?.(
                newALBroadcastMessage(
                    'server-1',
                    newALEventRoute(
                        AppTopics.groupStateSnapshot,
                        snapshot.group.groupId,
                        snapshot.group.groupId,
                    ),
                    'all',
                    AppTopics.groupStateSnapshot,
                    snapshot,
                ),
            );
        },
    };
}

interface DeltaGroupSnapshotInput {
    readonly groupId: string;
    // Both principal lists are given in the server's canonical order: members
    // in storage-key (encoded principal id) order, sessions in the summary's
    // identity-set order.
    readonly memberPrincipalIds: readonly string[];
    readonly activePrincipalIds: readonly string[];
    readonly causalRevision: GroupStateCausalRevision;
}

function createDeltaGroupSnapshot(input: DeltaGroupSnapshotInput): GroupSnapshot {
    const ownerPrincipalId = input.memberPrincipalIds[0];
    if (!ownerPrincipalId) {
        throw new TypeError('Delta group fixture requires an owner');
    }
    return {
        stateRevision: input.causalRevision.groupRevision +
            input.causalRevision.presenceRevision,
        causalRevision: input.causalRevision,
        group: createTestGroup({
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            groupId: input.groupId,
            displayName: input.groupId,
            snapshotVersion: input.causalRevision.groupRevision,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: input.causalRevision.presenceRevision,
            created: deltaAuditStamp(),
            updated: deltaAuditStamp(),
            activeMemberCount: input.memberPrincipalIds.length,
            ownerPrincipalId,
        }),
        members: input.memberPrincipalIds.map((principalId) =>
            createDeltaGroupMember(input.groupId, principalId, principalId === ownerPrincipalId)
        ),
        activeSessions: input.activePrincipalIds.map((principalId) =>
            createDeltaGroupSession(input.groupId, principalId)
        ),
        memberCount: input.memberPrincipalIds.length,
        onlineMemberCount: input.activePrincipalIds.length,
    };
}

interface DeltaEnvelopeInput {
    readonly resulting: GroupSnapshot;
    readonly predecessorCausalRevision: GroupStateCausalRevision;
    readonly eventType?: GroupEvent['eventType'];
    readonly members?: readonly GroupMember[];
    readonly sessions?: readonly GroupPresenceSession[];
}

function createDeltaEnvelope(input: DeltaEnvelopeInput): GroupStateDeltaEnvelope {
    const { resulting } = input;
    const activeSessionIds = resulting.activeSessions.map((session) => session.sessionId);
    const envelope: GroupStateDeltaEnvelope = {
        event: {
            applicationId: resulting.group.applicationId,
            workspaceId: resulting.group.workspaceId,
            groupId: resulting.group.groupId,
            eventId: `event-${resulting.group.groupId}-${resulting.stateRevision}`,
            eventType: input.eventType ?? 'member-joined',
            snapshotVersion: resulting.group.snapshotVersion,
            causalRevision: resulting.causalRevision,
            occurredAtEpochMs: 1,
            actor: { kind: 'service', serviceId: 'summary-worker' },
            reason: null,
            traceId: null,
            requestId: 'request-delta',
            payload: {},
        },
        predecessorCausalRevision: input.predecessorCausalRevision,
        resultingCausalRevision: resulting.causalRevision,
        members: input.members ?? [],
        removedMemberPrincipalIds: [],
        sessions: input.sessions ?? [],
        removedSessionIds: [],
        activeSessionIds,
        group: resulting.group,
        memberCount: resulting.memberCount,
        onlineMemberCount: resulting.onlineMemberCount,
        audienceSessionIds: activeSessionIds,
    };
    // Fixture self-check: hand-built envelopes must satisfy the landed wire
    // validator so the tests mirror the server's emission semantics.
    validateGroupStateDeltaEnvelope(envelope);
    return envelope;
}

function createDeltaGroupMember(
    groupId: string,
    principalId: string,
    isOwner: boolean,
): GroupMember {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId,
        principalId,
        role: isOwner ? 'owner' : 'member',
        status: 'active',
        joined: deltaAuditStamp(),
        updated: deltaAuditStamp(),
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
    };
}

function createDeltaGroupSession(
    groupId: string,
    principalId: string,
): GroupPresenceSession {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId,
        sessionId: `session-${principalId}`,
        principalId,
        generationId: `generation-${principalId}`,
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
}

function deltaAuditStamp() {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    } as const;
}

function groupSnapshotResponse(snapshot: GroupSnapshot): Response {
    return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(snapshot.causalRevision.groupRevision),
            'rallar-presence-revision': String(snapshot.causalRevision.presenceRevision),
        },
    });
}
